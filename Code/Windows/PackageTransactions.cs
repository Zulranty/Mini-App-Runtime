using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static partial class MiniStore
{
    private static readonly Dictionary<string, int> Views = new(StringComparer.Ordinal);
    private sealed record PackageIntent(string AppId, string TargetName, string Version, string Timestamp, string[] RetainedPermissions, string? BundledHash, string? SourceName, string? SourceHash);

    internal static void RegisterView(string id)
    {
        lock (InstallLock) Views[id] = Views.GetValueOrDefault(id) + 1;
    }

    internal static void UnregisterView(string id)
    {
        lock (InstallLock)
        {
            if (Views[id] == 1) Views.Remove(id);
            else Views[id]--;
        }
    }

    private static void EnsureAppClosed(string id)
    {
        if (Views.ContainsKey(id))
            throw new ApiError("app_in_use", "Close all windows of this mini-app before changing its package");
        RecoverPackageTransactions();
    }

    private static bool HasEntries(string directory, MiniManifest manifest) =>
        File.Exists(Path.Combine(directory, manifest.Entry)) &&
        manifest.Locales.Values.All(locale => File.Exists(Path.Combine(directory, locale.Entry)));

    private static string RollbackPath(string id)
    {
        var root = Path.Combine(RuntimeStateRoot, "rollback");
        var canonical = Path.Combine(root, "by-id", IdKey(id));
        if (Directory.Exists(canonical)) return canonical;
        var legacy = Path.Combine(root, id);
        // Existing rollback slots declare their owner in the retained manifest.
        if (TryRead(Path.Combine(legacy, "app", "manifest.json"))?.Id != id) return canonical;
        Directory.CreateDirectory(Path.GetDirectoryName(canonical)!);
        Directory.Move(legacy, canonical);
        return canonical;
    }

    private static string PrivateStorageFile(string id) => Path.Combine(PrivateRoot, "by-id", IdKey(id) + ".json");

    private static string? LegacyPrivateFile(string id)
    {
        // Windows legacy names were case-insensitive. Ambiguous files stay in their original location.
        if (id.EndsWith('.') || Apps().Count(app => app.Manifest.Id.Equals(id, StringComparison.OrdinalIgnoreCase)) != 1)
            return null;
        var stem = id.Split('.')[0];
        if (stem is "" || stem.Equals("CON", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("PRN", StringComparison.OrdinalIgnoreCase) || stem.Equals("AUX", StringComparison.OrdinalIgnoreCase) ||
            stem.Equals("NUL", StringComparison.OrdinalIgnoreCase) ||
            stem.Length == 4 && (stem.StartsWith("COM", StringComparison.OrdinalIgnoreCase) ||
                stem.StartsWith("LPT", StringComparison.OrdinalIgnoreCase)) && char.IsAsciiDigit(stem[3]))
            return null;
        return Path.Combine(PrivateRoot, id + ".json");
    }

    internal static string PrivateStoragePath(string id)
    {
        lock (InstallLock) return ResolvePrivateStoragePath(id);
    }

    private static string ResolvePrivateStoragePath(string id)
    {
        var path = PrivateStorageFile(id);
        if (File.Exists(path) && File.Exists(path + ".bak")) return path;
        var legacy = LegacyPrivateFile(id);
        if (legacy is null || !File.Exists(legacy) && !File.Exists(legacy + ".bak")) return path;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (!File.Exists(path) && File.Exists(legacy)) File.Move(legacy, path);
        if (!File.Exists(path + ".bak") && File.Exists(legacy + ".bak")) File.Move(legacy + ".bak", path + ".bak");
        return path;
    }

    private static long PrivateStorageSize(string id)
    {
        var path = PrivateStoragePath(id);
        return FileSize(path) + FileSize(path + ".bak");
    }

    private static void DeletePrivateStorage(string id, string? legacy)
    {
        var path = PrivateStorageFile(id);
        File.Delete(path);
        File.Delete(path + ".bak");
        if (legacy is null) return;
        File.Delete(legacy);
        File.Delete(legacy + ".bak");
    }

    private static void ReplaceAppCode(string ready, string target, MiniManifest next, MiniManifest? current, string errorCode, string? bundledHash = null, string? scannedSource = null)
    {
        var transaction = Path.Combine(RuntimeStateRoot, "package-transactions", Guid.NewGuid().ToString("N"));
        var candidate = Path.Combine(transaction, "new");
        var retained = Path.Combine(transaction, "retained");
        var intentFile = Path.Combine(transaction, "install.json");
        var timestamp = DateTimeOffset.UtcNow.ToString("O");
        var intent = new PackageIntent(next.Id, Path.GetFileName(target), next.Version, timestamp,
            current?.Permissions.Intersect(next.Permissions).ToArray() ?? [], bundledHash,
            scannedSource is null ? null : Path.GetFileName(scannedSource),
            scannedSource is null ? null : FileSha256(scannedSource));

        try
        {
            if (current is not null) new PermissionStore(current).EnsureMigrated();
            foreach (var name in new[] { "storage.json", "storage.json.bak" })
            {
                var previous = Path.Combine(target, name);
                var staged = Path.Combine(ready, name);
                if (File.Exists(previous)) File.Copy(previous, staged, overwrite: true);
                else File.Delete(staged);
            }

            Directory.CreateDirectory(transaction);
            Directory.Move(ready, candidate);
            if (current is not null)
            {
                Directory.CreateDirectory(retained);
                WriteDurableJson(Path.Combine(retained, "rollback.json"), new JsonObject
                {
                    ["format"] = "miniapps-rollback", ["formatVersion"] = 1, ["appId"] = next.Id,
                    ["currentVersion"] = next.Version, ["previousVersion"] = current.Version, ["createdAt"] = timestamp
                }.ToJsonString());
            }
            WriteDurableJson(intentFile, JsonSerializer.Serialize(intent));
            if (current is not null) Directory.Move(target, Path.Combine(retained, "app"));
            Directory.Move(candidate, target);
            RecoverPackageTransaction(transaction);
        }
        catch (Exception error)
        {
            try
            {
                var committed = File.Exists(intentFile) && !Directory.Exists(candidate) && Directory.Exists(target);
                RecoverPackageTransaction(transaction);
                if (committed) return;
            }
            catch (Exception recovery)
            {
                throw new ApiError(errorCode, $"Package recovery failed: {recovery.Message}");
            }
            throw new ApiError(errorCode, error.Message);
        }
    }

    private static void WriteDurableJson(string path, string json)
    {
        var temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(Encoding.UTF8.GetBytes(json));
            stream.Flush(flushToDisk: true);
        }
        File.Move(temporary, path, overwrite: true);
    }

    private static void RecoverPackageTransactions()
    {
        var folder = Path.Combine(RuntimeStateRoot, "package-transactions");
        if (!Directory.Exists(folder)) return;
        foreach (var transaction in Directory.GetDirectories(folder))
            RecoverPackageTransaction(transaction);
    }

    private static void RecoverPackageTransaction(string transaction)
    {
        if (!Directory.Exists(transaction)) return;
        var intentFile = Path.Combine(transaction, "install.json");
        if (!File.Exists(intentFile))
        {
            CleanupPackageTransaction(transaction);
            return;
        }
        var intent = JsonSerializer.Deserialize<PackageIntent>(File.ReadAllText(intentFile))
            ?? throw new InvalidDataException("Invalid package journal");
        if (!MiniManifest.SafeRelativePath(intent.TargetName) || Path.GetFileName(intent.TargetName) != intent.TargetName ||
            !MiniManifest.ValidId(intent.AppId))
            throw new InvalidDataException("Invalid package journal target");

        var target = Path.Combine(Root, intent.TargetName);
        var candidate = Path.Combine(transaction, "new");
        var retained = Path.Combine(transaction, "retained");
        var backup = Path.Combine(retained, "app");
        if (Directory.Exists(candidate))
        {
            if (!Directory.Exists(target) && Directory.Exists(backup)) Directory.Move(backup, target);
        }
        else
        {
            var active = TryRead(Path.Combine(target, "manifest.json"));
            if (active is null || active.Id != intent.AppId || active.Version != intent.Version)
                throw new InvalidDataException("The active package differs from the installation journal");
            var slot = RollbackPath(intent.AppId);
            if (Directory.Exists(retained))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(slot)!);
                if (Directory.Exists(slot)) Directory.Move(slot, Path.Combine(transaction, "retired"));
                Directory.Move(retained, slot);
            }
            new PermissionStore(active).Reconcile(intent.RetainedPermissions.ToHashSet(StringComparer.Ordinal));
            RecordAppInstall(active.Id, intent.Timestamp);
            if (intent.BundledHash is not null) WriteBundledStamp(active.Id, intent.BundledHash);
            if (intent.SourceName is { } name && MiniManifest.SafeRelativePath(name) && Path.GetFileName(name) == name)
            {
                var source = Path.Combine(Root, name);
                if (File.Exists(source) && FileSha256(source) == intent.SourceHash) File.Delete(source);
            }
        }
        File.Delete(intentFile);
        CleanupPackageTransaction(transaction);
    }

    private static void CleanupPackageTransaction(string transaction)
    {
        try { Directory.Delete(transaction, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static string FileSha256(string path)
    {
        using var source = File.OpenRead(path);
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(source));
    }

    private static string BundledStampPath(string id) => Path.Combine(RuntimeStateRoot, "bundled", IdKey(id) + ".json");

    private static bool BundledStampMatches(string id, string hash)
    {
        var path = BundledStampPath(id);
        return File.Exists(path) && File.ReadAllText(path) == hash;
    }

    private static void WriteBundledStamp(string id, string hash)
    {
        var path = BundledStampPath(id);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        WriteDurableJson(path, hash);
    }

    private static void ApplyBundledPackages()
    {
        var source = Path.Combine(ResourceRoot, "BundledMiniApps");
        Directory.CreateDirectory(Root);
        if (!Directory.Exists(source)) return;
        lock (InstallLock)
        {
            foreach (var package in Directory.GetFiles(source, "*.zip").Order(StringComparer.Ordinal))
                InstallLocked(package, null, deleteRootSource: false, allowSameVersion: true, bundled: true);
        }
    }
}
