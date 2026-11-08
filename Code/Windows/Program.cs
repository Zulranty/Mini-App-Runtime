using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using System.Reflection;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MiniAppRuntime.Windows;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        MiniStore.InitializeDataLayout();
        NativeLibrary.SetDllImportResolver(typeof(CoreWebView2Environment).Assembly, ResolveWebView2Loader);
        ApplicationConfiguration.Initialize();
        Application.Run(new LauncherForm());
    }

    private static IntPtr ResolveWebView2Loader(string libraryName, Assembly assembly, DllImportSearchPath? searchPath) =>
        libraryName is "WebView2Loader.dll" or "WebView2Loader"
            ? NativeLibrary.Load(Path.Combine(MiniStore.WebViewRoot, "WebView2Loader.dll"))
            : IntPtr.Zero;
}

internal sealed record NetworkPolicy(IReadOnlySet<string> Allow, bool AllowSubdomains, bool AllowHttp, bool AllowLocalNetwork, IReadOnlySet<string>? DiscoveryServices = null);
internal sealed record MiniManifest(string Id, string Name, string Version, int SdkVersion, string Entry, HashSet<string> Permissions, string? MinRuntimeVersion, NetworkPolicy? Network)
{
    public static MiniManifest Parse(string json)
    {
        var node = JsonNode.Parse(json)?.AsObject() ?? throw new InvalidDataException("Invalid manifest.json");
        var id = node["id"]?.GetValue<string>() ?? throw new InvalidDataException("Manifest id is required");
        var name = node["name"]?.GetValue<string>() ?? id;
        var version = node["version"]?.GetValue<string>() ?? "0.0.0";
        if (!SemanticVersion.IsValid(version)) throw new ApiError("source_file_invalid", "version must be SemVer");
        var entry = node["entry"]?.GetValue<string>() ?? "index.html";
        if (!SafeRelativePath(entry)) throw new InvalidDataException("Unsafe entry path");
        var permissions = node["permissions"]?.AsArray().Select(x => x?.GetValue<string>() ?? "").Where(x => x.Length > 0).ToHashSet() ?? [];
        var allowedPermissions = new HashSet<string> { "storage", "clipboard.write", "clipboard.read", "files.pick", "files.save", "files.directory", "share", "secureStorage", "network", "notifications", "system.open", "haptics", "local.peers" };
        if (!permissions.IsSubsetOf(allowedPermissions)) throw new InvalidDataException("Unknown permission");
        var sdkVersion = node["sdkVersion"]?.GetValue<int>() ?? 1;
        if (sdkVersion is < 1 or > 2) throw new ApiError("unsupported_sdk_version", "Unsupported SDK version");
        var minRuntimeVersion = node["minRuntimeVersion"]?.GetValue<string>();
        if (minRuntimeVersion is not null && !SemanticVersion.IsValid(minRuntimeVersion)) throw new ApiError("source_file_invalid", "minRuntimeVersion must be SemVer");
        NetworkPolicy? network = null;
        if (node["network"] is JsonObject config)
        {
            var allow = config["allow"]?.AsArray().Select(item => item?.GetValue<string>() ?? "").ToHashSet() ?? [];
            var services = config["discoveryServices"]?.AsArray().Select(item => item?.GetValue<string>() ?? "").ToHashSet() ?? [];
            var allowHttp = config["allowHttp"]?.GetValue<bool>() == true;
            var allowLocal = config["allowLocalNetwork"]?.GetValue<bool>() == true;
            if (!permissions.Contains("network") || (allow.Count == 0 && services.Count == 0) || allow.Any(item => !NetworkRequestValidator.ValidOrigin(item)) ||
                services.Count > 8 || services.Any(item => !LocalDeviceService.ValidService(item)) || (services.Count > 0 && (!allowHttp || !allowLocal)))
                throw new ApiError("source_file_invalid", "Invalid network configuration");
            network = new NetworkPolicy(allow, config["allowSubdomains"]?.GetValue<bool>() == true, allowHttp, allowLocal, services);
        }
        return new(id, name, version, sdkVersion, entry, permissions, minRuntimeVersion, network);
    }

    public static bool SafeRelativePath(string path) => !string.IsNullOrWhiteSpace(path) && !Path.IsPathRooted(path) && !path.Split('/', '\\').Any(x => x is "." or ".." or "");

    public static string HtmlEntryForName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var baseName = string.Concat(name.Trim().Select(ch => invalid.Contains(ch) || char.IsControl(ch) ? '_' : ch)).TrimEnd('.', ' ');
        return (string.IsNullOrWhiteSpace(baseName) ? "app" : baseName) + ".html";
    }
}

internal static class SemanticVersion
{
    private static readonly Regex Pattern = new("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
    public static bool IsValid(string value) => Pattern.IsMatch(value);
    public static int Compare(string left, string right)
    {
        var a = left.Split('+')[0].Split('-', 2); var b = right.Split('+')[0].Split('-', 2);
        var av = a[0].Split('.').Select(int.Parse).ToArray(); var bv = b[0].Split('.').Select(int.Parse).ToArray();
        for (var i = 0; i < 3; i++) { var c = av[i].CompareTo(bv[i]); if (c != 0) return c; }
        if (a.Length == b.Length) return 0; return a.Length == 1 ? 1 : -1;
    }
}

internal static class MiniStore
{
    // All application state stays inside the selected application directory.
    // This keeps the installed and portable layouts identical and makes the
    // whole working set portable as one folder.
    public static readonly string ResourceRoot = Path.Combine(AppContext.BaseDirectory, "Data");
    public static readonly string DataRoot = Path.Combine(ResourceRoot, "User");
    public static readonly string ConfigRoot = Path.Combine(AppContext.BaseDirectory, "Config");
    public static readonly string WebViewRoot = Path.Combine(ResourceRoot, "WebView2");
    public static readonly string Root = Path.Combine(AppContext.BaseDirectory, "MiniApps");
    public static readonly string RuntimeStateRoot = Path.Combine(Root, ".runtime");
    public static readonly string InterfaceRoot = Path.Combine(AppContext.BaseDirectory, "Interface");
    private static readonly string InterfaceSelectionPath = Path.Combine(ConfigRoot, "launcher-interface.txt");
    public static string ActiveLauncherInterfaceRoot => Path.Combine(InterfaceRoot, ActiveInterfaceId());
    public static readonly string PrivateRoot = Path.Combine(DataRoot, "private");
    private static readonly string WebViewDataRoot = Path.Combine(WebViewRoot, "UserData");
    private static readonly Lazy<Task<CoreWebView2Environment>> WebViewEnvironment = new(() =>
    {
        Directory.CreateDirectory(WebViewDataRoot);
        return CoreWebView2Environment.CreateAsync(null, WebViewDataRoot);
    });
    private static readonly Regex EmbeddedManifest = new("<script\\s+type=[\"']application/miniapp\\+json[\"'][^>]*>(.*?)</script>", RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly object InstallLock = new();
    internal sealed record InstallResult(MiniManifest Manifest, bool Installed, string Directory);
    internal sealed record SyncResult(int Updated, IReadOnlyList<string> Errors)
    {
        public JsonObject ToJson() => new()
        {
            ["updated"] = Updated,
            ["errors"] = new JsonArray(Errors.Select(error => (JsonNode)error).ToArray()),
            ["message"] = Errors.Count > 0
                ? $"Не удалось обработать пакеты: {string.Join("; ", Errors)}"
                : Updated > 0 ? $"Приложений обновлено: {Updated}" : "Новых обновлений не найдено"
        };
    }

    public static SyncResult Sync()
    {
        lock (InstallLock)
        {
            var updated = 0; var errors = new List<string>();
            Directory.CreateDirectory(Root);
            foreach (var source in Directory.EnumerateFiles(Root).Where(x => Path.GetExtension(x).Equals(".zip", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(x).Equals(".html", StringComparison.OrdinalIgnoreCase) || Path.GetExtension(x).Equals(".htm", StringComparison.OrdinalIgnoreCase)))
            {
                try { if (InstallLocked(source, null, true, allowSameVersion: true).Installed) updated++; }
                catch (Exception error) { errors.Add($"{Path.GetFileName(source)}: {error.Message}"); }
            }
            return new SyncResult(updated, errors);
        }
    }

    public static InstallResult Import(string source) { lock (InstallLock) return InstallLocked(source, null, false, allowSameVersion: true); }
    public static InstallResult Import(string source, MiniManifest manifest) { lock (InstallLock) return InstallLocked(source, manifest, false, allowSameVersion: true); }
    public static bool HasEmbeddedManifest(string source) => EmbeddedManifest.IsMatch(File.ReadAllText(source));

    public static Task<CoreWebView2Environment> GetWebViewEnvironmentAsync() => WebViewEnvironment.Value;

    public static void InitializeDataLayout()
    {
        Directory.CreateDirectory(ConfigRoot);
        Directory.CreateDirectory(Path.Combine(ConfigRoot, "Permissions"));
    }

    public static void EnsureInterface()
    {
        Directory.CreateDirectory(InterfaceRoot);
        ScanInterfaces();
    }

    public static JsonArray Interfaces()
    {
        EnsureInterface(); var active=ActiveInterfaceId();
        return new JsonArray(Directory.EnumerateDirectories(InterfaceRoot)
            .Where(dir => File.Exists(Path.Combine(dir, "index.html")))
            .OrderBy(Path.GetFileName, StringComparer.CurrentCultureIgnoreCase)
            .Select(dir => (JsonNode)new JsonObject { ["id"] = Path.GetFileName(dir), ["name"] = Path.GetFileName(dir), ["active"] = Path.GetFileName(dir).Equals(active, StringComparison.OrdinalIgnoreCase) }).ToArray());
    }
    public static void SelectInterface(string id)
    {
        if (!Regex.IsMatch(id, "^[A-Za-z0-9._-]+$") || !File.Exists(Path.Combine(InterfaceRoot, id, "index.html"))) throw new ApiError("source_file_invalid", "Interface was not found");
        Directory.CreateDirectory(Path.GetDirectoryName(InterfaceSelectionPath)!); File.WriteAllText(InterfaceSelectionPath, id);
    }
    public static JsonObject GetInterfaceSettings()
    {
        var path = Path.Combine(ActiveLauncherInterfaceRoot, "settings.json");
        if (!File.Exists(path)) return new JsonObject();
        try { return JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
        catch { return new JsonObject(); }
    }
    public static void SetInterfaceSettings(JsonNode? settings)
    {
        if (settings is not JsonObject value) throw new ApiError("invalid_params", "settings must be a JSON object");
        var json = value.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        if (System.Text.Encoding.UTF8.GetByteCount(json) > 64 * 1024) throw new ApiError("invalid_params", "Interface settings exceed 64 KiB");
        var target = Path.Combine(ActiveLauncherInterfaceRoot, "settings.json");
        var temporary = Path.Combine(Path.GetDirectoryName(target)!, $".settings-{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            { var bytes = System.Text.Encoding.UTF8.GetBytes(json); stream.Write(bytes); stream.Flush(true); }
            if (File.Exists(target)) File.Replace(temporary, target, null);
            else File.Move(temporary, target);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    public static void InstallInterface(string source)
    {
        Directory.CreateDirectory(InterfaceRoot);
        if (!File.Exists(source)) throw new ApiError("source_file_not_found", "Source file was not found");
        var ext = Path.GetExtension(source).ToLowerInvariant();
        if (ext is not (".zip" or ".html" or ".htm")) throw new ApiError("source_file_invalid", "Only ZIP and HTML files are supported");
        var id = FolderName(Path.GetFileNameWithoutExtension(source));
        var staging = Path.Combine(InterfaceRoot, "." + id + "-" + Guid.NewGuid().ToString("N"));
        var backup = Path.Combine(InterfaceRoot, "." + id + "-old-" + Guid.NewGuid().ToString("N"));
        var target = Path.Combine(InterfaceRoot, id);
        try
        {
            Directory.CreateDirectory(staging);
            if (ext == ".zip") ExtractInterfaceZip(source, staging);
            else File.Copy(source, Path.Combine(staging, "index.html"));
            if (!File.Exists(Path.Combine(staging, "index.html"))) throw new ApiError("source_file_invalid", "Interface index.html is missing");
            if (Directory.Exists(target)) Directory.Move(target, backup);
            try { Directory.Move(staging, target); }
            catch
            {
                if (Directory.Exists(backup) && !Directory.Exists(target)) Directory.Move(backup, target);
                throw;
            }
            if (Directory.Exists(backup)) { try { Directory.Delete(backup, true); } catch (IOException) { } }
        }
        finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
    }
    private static string ActiveInterfaceId()
    {
        try
        {
            var selected = File.Exists(InterfaceSelectionPath) ? File.ReadAllText(InterfaceSelectionPath).Trim() : null;
            if (selected is not null && Regex.IsMatch(selected, "^[A-Za-z0-9._-]+$") && File.Exists(Path.Combine(InterfaceRoot, selected, "index.html"))) return selected;
            var fallback = Directory.Exists(InterfaceRoot)
                ? Directory.EnumerateDirectories(InterfaceRoot).Where(dir => File.Exists(Path.Combine(dir, "index.html"))).Select(Path.GetFileName).OrderBy(id => id, StringComparer.CurrentCultureIgnoreCase).FirstOrDefault()
                : null;
            fallback ??= "default";
            if (!string.Equals(selected, fallback, StringComparison.Ordinal)) { Directory.CreateDirectory(Path.GetDirectoryName(InterfaceSelectionPath)!); File.WriteAllText(InterfaceSelectionPath, fallback); }
            return fallback;
        }
        catch { return "default"; }
    }
    private static void ScanInterfaces() { foreach(var source in Directory.EnumerateFiles(InterfaceRoot).Where(x=>Path.GetExtension(x).Equals(".zip",StringComparison.OrdinalIgnoreCase)||Path.GetExtension(x).Equals(".html",StringComparison.OrdinalIgnoreCase)||Path.GetExtension(x).Equals(".htm",StringComparison.OrdinalIgnoreCase))) { try { InstallInterface(source); File.Delete(source); } catch { } } }
    private static void ExtractInterfaceZip(string source, string target)
    {
        if (new FileInfo(source).Length > 20 * 1024 * 1024) throw new ApiError("source_file_invalid", "Archive is too large");
        using var archive = ZipFile.OpenRead(source);
        if (archive.Entries.Count > 1000) throw new ApiError("source_file_invalid", "Too many files");
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            if (!MiniManifest.SafeRelativePath(entry.FullName)) throw new ApiError("source_file_invalid", "Unsafe ZIP path");
            var path = Path.GetFullPath(Path.Combine(target, entry.FullName));
            if (!path.StartsWith(Path.GetFullPath(target) + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new ApiError("source_file_invalid", "Zip Slip blocked");
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            ExtractLimited(entry, path, ref total);
        }
    }

    private static void ExtractLimited(ZipArchiveEntry entry, string path, ref long total)
    {
        const long maxBytes = 50L * 1024 * 1024;
        if (entry.Length > maxBytes - total) throw new ApiError("source_file_invalid", "Unpacked archive too large");
        using var input = entry.Open();
        using var output = File.Create(path);
        var buffer = new byte[8192];
        int count;
        while ((count = input.Read(buffer)) != 0)
        {
            if (count > maxBytes - total) throw new ApiError("source_file_invalid", "Unpacked archive too large");
            output.Write(buffer, 0, count);
            total += count;
        }
    }

    public static IReadOnlyList<(MiniManifest Manifest, string Directory)> Apps() =>
        Directory.EnumerateDirectories(Root)
            // Staging and rollback directories can temporarily contain a manifest.
            // They are never installed mini-apps and must not become an update
            // target while InstallLocked is preparing a package.
            .Where(d => !Path.GetFileName(d).StartsWith(".", StringComparison.Ordinal))
            .Select(d => TryRead(Path.Combine(d, "manifest.json")) is { } m ? ((MiniManifest Manifest, string Directory)?)(m, d!) : null)
            .Where(x => x.HasValue).Select(x => x!.Value).OrderBy(x => x.Manifest.Name, StringComparer.CurrentCultureIgnoreCase).ToArray();

    private static InstallResult InstallLocked(string source, MiniManifest? manual, bool deleteRootSource, bool allowSameVersion)
    {
        if (!File.Exists(source)) throw new ApiError("source_file_not_found", "Source file was not found");
        var extension = Path.GetExtension(source).ToLowerInvariant();
        if (extension is not (".zip" or ".html" or ".htm")) throw new ApiError("source_file_invalid", "Only ZIP and HTML files are supported");
        var temp = Path.Combine(Root, ".install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            MiniManifest incoming;
            if (extension == ".zip")
            {
                if (new FileInfo(source).Length > 20 * 1024 * 1024) throw new ApiError("source_file_invalid", "Archive too large");
                using var archive = ZipFile.OpenRead(source); long total = 0; var count = 0;
                foreach (var entry in archive.Entries)
                {
                    if (++count > 1000) throw new ApiError("source_file_invalid", "Too many files");
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    if (!MiniManifest.SafeRelativePath(entry.FullName)) throw new ApiError("source_file_invalid", "Unsafe ZIP path");
                    var file = Path.GetFullPath(Path.Combine(temp, entry.FullName));
                    if (!file.StartsWith(Path.GetFullPath(temp) + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new ApiError("source_file_invalid", "Zip Slip blocked");
                    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
                    ExtractLimited(entry, file, ref total);
                }
                incoming = TryRead(Path.Combine(temp, "manifest.json")) ?? throw new ApiError("source_file_invalid", "manifest.json is missing");
            }
            else
            {
                JsonObject node;
                if (manual is null)
                {
                    var html = File.ReadAllText(source); var match = EmbeddedManifest.Match(html);
                    if (!match.Success) throw new ApiError("source_file_invalid", "HTML manifest is required");
                    node = JsonNode.Parse(match.Groups[1].Value)?.AsObject() ?? throw new ApiError("source_file_invalid", "Invalid embedded manifest");
                }
                else node = new JsonObject { ["id"] = manual.Id, ["name"] = manual.Name, ["version"] = manual.Version, ["sdkVersion"] = manual.SdkVersion, ["permissions"] = new JsonArray(manual.Permissions.Order().Select(permission => (JsonNode)permission).ToArray()) };
                var entry = MiniManifest.HtmlEntryForName(node["name"]?.GetValue<string>() ?? "");
                node["entry"] = entry;
                incoming = MiniManifest.Parse(node.ToJsonString()); File.Copy(source, Path.Combine(temp, entry)); File.WriteAllText(Path.Combine(temp, "manifest.json"), node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            }
            if (!File.Exists(Path.Combine(temp, incoming.Entry))) throw new InvalidDataException("Entry file is missing");
            var found = Apps().FirstOrDefault(x => x.Manifest.Id == incoming.Id); var target = found.Directory ?? Path.Combine(Root, FolderName(incoming.Id)); var existing = found.Manifest;
            // Manual imports can deliberately reinstall a corrected package with
            // the same version. Files found in the root are handled the same way.
            var versionComparison = existing is null ? 1 : CompareVersions(incoming.Version, existing.Version);
            if (existing is not null && (versionComparison < 0 || (versionComparison == 0 && !allowSameVersion))) return new(existing, false, target);
            var ready = Path.Combine(RuntimeStateRoot, "staging", $"{Path.GetFileName(target)}-{Guid.NewGuid():N}"); var backup = Path.Combine(RuntimeStateRoot, "staging", $"{Path.GetFileName(target)}-old-{Guid.NewGuid():N}");
            Directory.CreateDirectory(Path.GetDirectoryName(ready)!); if (Directory.Exists(ready)) Directory.Delete(ready, true); if (Directory.Exists(backup)) Directory.Delete(backup, true);
            Directory.Move(temp, ready);
            try
            {
                if (Directory.Exists(target)) Directory.Move(target, backup); Directory.Move(ready, target);
                var oldStorage = Path.Combine(backup, "storage.json"); if (File.Exists(oldStorage)) File.Copy(oldStorage, Path.Combine(target, "storage.json"), true);
                var rollback=Path.Combine(RuntimeStateRoot,"rollback",incoming.Id); var rollbackApp=Path.Combine(rollback,"app");
                if (Directory.Exists(rollback)) Directory.Delete(rollback,true); Directory.CreateDirectory(rollback);
                if (Directory.Exists(backup)) Directory.Move(backup, rollbackApp);
                if (Directory.Exists(rollbackApp)) File.WriteAllText(Path.Combine(rollback,"rollback.json"),new JsonObject { ["format"]="miniapps-rollback",["formatVersion"]=1,["appId"]=incoming.Id,["currentVersion"]=incoming.Version,["previousVersion"]=TryRead(Path.Combine(rollbackApp,"manifest.json"))?.Version,["createdAt"]=DateTimeOffset.UtcNow.ToString("O") }.ToJsonString());
                if (deleteRootSource && Path.GetDirectoryName(source)?.TrimEnd(Path.DirectorySeparatorChar).Equals(Root, StringComparison.OrdinalIgnoreCase) == true) File.Delete(source);
                var installedManifest = TryRead(Path.Combine(target, "manifest.json"));
                if (installedManifest is null || installedManifest.Id != incoming.Id)
                    throw new ApiError("install_failed", "The installed application directory could not be verified");
                RecordAppInstall(incoming.Id);
                return new(incoming, true, target);
            }
            catch
            {
                if (Directory.Exists(target) && Directory.Exists(backup)) Directory.Delete(target, true);
                if (!Directory.Exists(target) && Directory.Exists(backup)) Directory.Move(backup, target);
                throw;
            }
        }
        finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); }
    }

    private static MiniManifest? TryRead(string path) { try { return File.Exists(path) ? MiniManifest.Parse(File.ReadAllText(path)) : null; } catch { return null; } }
    private static string FolderName(string name) => Regex.Replace(name, "[^A-Za-z0-9._-]", "_").Trim('_') is { Length: > 0 } x ? x : "mini_app";
    private static int CompareVersions(string a, string b)
    {
        var aa = a.Split('.', '-', '_'); var bb = b.Split('.', '-', '_');
        for (var i = 0; i < Math.Max(aa.Length, bb.Length); i++)
        {
            var x = i < aa.Length ? aa[i] : ""; var y = i < bb.Length ? bb[i] : "";
            var result = long.TryParse(x, out var xn) && long.TryParse(y, out var yn) ? xn.CompareTo(yn) : string.Compare(x, y, StringComparison.OrdinalIgnoreCase);
            if (result != 0) return result;
        }
        return 0;
    }

    public static (MiniManifest Manifest, string Directory) Find(string id) => Apps().FirstOrDefault(x => x.Manifest.Id == id).Manifest is { } manifest ? (manifest, Apps().First(x => x.Manifest.Id == id).Directory) : throw new ApiError("source_file_not_found", "Application was not found");
    public static JsonObject AppInfo(MiniManifest manifest, string directory)
    {
        var result = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "manifest.json")))?.AsObject() ?? new JsonObject();
        var metadata = AppInfoMetadata(manifest.Id); var fallback = new DateTimeOffset(Directory.GetLastWriteTimeUtc(directory)).ToString("O");
        var installedAt = metadata["installedAt"]?.GetValue<string>() ?? fallback; var updatedAt = metadata["updatedAt"]?.GetValue<string>() ?? installedAt;
        var publicData = FileSize(Path.Combine(directory, "storage.json")) + FileSize(Path.Combine(directory, "storage.json.bak")); var privateData = FileSize(Path.Combine(PrivateRoot, manifest.Id + ".json")); var secureData = SecureStorageStore.SizeFor(manifest.Id);
        result["installedAt"] = installedAt; result["updatedAt"] = updatedAt; result["appSizeBytes"] = DirectorySize(directory, file => Path.GetFileName(file) is not ("storage.json" or "storage.json.bak")); result["dataSizeBytes"] = publicData + privateData + secureData; result["publicDataSizeBytes"] = publicData; result["privateDataSizeBytes"] = privateData; result["secureDataSizeBytes"] = secureData;
        return result;
    }
    private static string AppInfoPath(string id) => Path.Combine(RuntimeStateRoot, "app-info", FolderName(id) + ".json");
    private static JsonObject AppInfoMetadata(string id) { try { return JsonNode.Parse(File.ReadAllText(AppInfoPath(id)))?.AsObject() ?? new JsonObject(); } catch { return new JsonObject(); } }
    private static void RecordAppInstall(string id) { var path=AppInfoPath(id); Directory.CreateDirectory(Path.GetDirectoryName(path)!); var data=AppInfoMetadata(id); var now=DateTimeOffset.UtcNow.ToString("O"); data["installedAt"] ??= now; data["updatedAt"]=now; File.WriteAllText(path,data.ToJsonString()); }
    private static long FileSize(string path) => File.Exists(path) ? new FileInfo(path).Length : 0L;
    private static long DirectorySize(string path, Func<string, bool>? include = null) => Directory.Exists(path) ? Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Where(file => include?.Invoke(file) != false).Sum(FileSize) : 0L;
    public static JsonObject RollbackInfo(string id)
    {
        var metadata=Path.Combine(RuntimeStateRoot,"rollback",id,"rollback.json");
        if (!File.Exists(metadata)) return new JsonObject { ["available"] = false };
        try { var result=JsonNode.Parse(File.ReadAllText(metadata))?.AsObject() ?? throw new InvalidDataException(); result["available"]=true; return result; } catch { return new JsonObject { ["available"] = false }; }
    }
    public static void DeleteRollback(string id) { var path=Path.Combine(RuntimeStateRoot,"rollback",id); if(Directory.Exists(path))Directory.Delete(path,true); }
    public static void Rollback(string id)
    {
        lock(InstallLock)
        {
            var current=Find(id); var slot=Path.Combine(RuntimeStateRoot,"rollback",id); var previous=Path.Combine(slot,"app");
            var previousManifest=TryRead(Path.Combine(previous,"manifest.json"));
            if(previousManifest is null) throw new ApiError("rollback_not_available","Rollback is not available");
            if(previousManifest.Id!=id) throw new ApiError("rollback_failed","Rollback metadata is invalid");
            var staging=Path.Combine(RuntimeStateRoot,"staging",$"rollback-{Guid.NewGuid():N}"); Directory.CreateDirectory(Path.GetDirectoryName(staging)!);
            try { Directory.Move(current.Directory,staging); Directory.Move(previous,current.Directory); Directory.Move(staging,previous); File.WriteAllText(Path.Combine(slot,"rollback.json"),new JsonObject { ["format"]="miniapps-rollback",["formatVersion"]=1,["appId"]=id,["currentVersion"]=previousManifest.Version,["previousVersion"]=current.Manifest.Version,["createdAt"]=DateTimeOffset.UtcNow.ToString("O") }.ToJsonString()); }
            catch(Exception e) { if(!Directory.Exists(current.Directory)&&Directory.Exists(staging))Directory.Move(staging,current.Directory); throw new ApiError("rollback_failed",e.Message); }
        }
    }
    public static void Delete(string id)
    {
        lock (InstallLock) { var app = Find(id); var failures = new List<string>(); try { Directory.Delete(app.Directory, true); } catch { failures.Add("application"); } try { DeleteRollback(id); File.Delete(AppInfoPath(id)); } catch { failures.Add("runtime state"); } try { File.Delete(Path.Combine(PrivateRoot, id + ".json")); PermissionStore.Delete(id, app.Manifest.Name); SecureStorageStore.Delete(id); } catch { failures.Add("private data"); } if (failures.Count > 0) throw new ApiError("app_delete_failed", "Could not delete: " + string.Join(", ", failures)); }
    }
}

internal static class WindowSizeStore
{
    private static readonly string Path = System.IO.Path.Combine(MiniStore.ConfigRoot, "window-sizes.json");

    public static Size Load(string key, Size fallback)
    {
        try
        {
            var sizes = JsonSerializer.Deserialize<Dictionary<string, WindowSize>>(File.ReadAllText(Path));
            return sizes is not null && sizes.TryGetValue(key, out var size) && size.IsValid
                ? new Size(size.Width, size.Height)
                : fallback;
        }
        catch (IOException) { return fallback; }
        catch (JsonException) { return fallback; }
    }

    public static void Save(string key, Size size)
    {
        if (size.Width < 300 || size.Height < 200) return;
        try
        {
            Dictionary<string, WindowSize> sizes;
            try { sizes = JsonSerializer.Deserialize<Dictionary<string, WindowSize>>(File.ReadAllText(Path)) ?? []; }
            catch (IOException) { sizes = []; }
            catch (JsonException) { sizes = []; }
            sizes[key] = new WindowSize(size.Width, size.Height);
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            File.WriteAllText(Path, JsonSerializer.Serialize(sizes));
        }
        catch (IOException) { }
    }

    private sealed record WindowSize(int Width, int Height)
    {
        public bool IsValid => Width is >= 300 and <= 10000 && Height is >= 200 and <= 10000;
    }
}

internal sealed class LauncherForm : Form
{
    private readonly Microsoft.Web.WebView2.WinForms.WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon trayIcon = new() { Icon = SystemIcons.Application, Text = "Mini App Runtime", Visible = false };
    private readonly HashSet<MiniAppWindow> additionalWindows = [];
    private readonly Panel content = new() { Dock = DockStyle.Fill };
    private readonly Panel navigation = new() { Dock = DockStyle.Top, Height = 60, Padding = new Padding(12, 10, 12, 10), BackColor = Color.FromArgb(18, 20, 28), Visible = false };
    private readonly Button back = new() { Text = "← Назад", AutoSize = true, Location = new Point(12, 12), Visible = false };
    private WebAppView? activeApp;
    private bool operation;
    private bool exiting;
    public LauncherForm()
    {
        Text = "Mini App Runtime"; Width = 900; Height = 680; StartPosition = FormStartPosition.CenterScreen;
        Size = WindowSizeStore.Load("launcher", Size);
        back.Text = "← Назад"; back.Visible = true; back.AutoSize = false; back.Width = 132; back.Dock = DockStyle.Left; back.FlatStyle = FlatStyle.Flat; back.FlatAppearance.BorderSize = 0;
        back.BackColor = Color.FromArgb(54, 91, 255); back.ForeColor = Color.White; back.Font = new Font("Segoe UI", 10, FontStyle.Regular); back.Cursor = Cursors.Hand;
        navigation.Controls.Add(back); content.Controls.Add(web); Controls.Add(content); Controls.Add(navigation);
        back.Click += (_, _) => ShowLauncher(); Shown += async (_, _) => await InitializeAsync();
        FormClosing += OnFormClosing;
        trayIcon.DoubleClick += (_, _) => RestoreFromTray();
        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Открыть", null, (_, _) => RestoreFromTray());
        trayMenu.Items.Add("Выход", null, (_, _) => { exiting = true; Close(); });
        trayIcon.ContextMenuStrip = trayMenu;
    }
    private async Task InitializeAsync()
    {
        try
        {
            MiniStore.EnsureInterface(); await web.EnsureCoreWebView2Async(await MiniStore.GetWebViewEnvironmentAsync());
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.SetVirtualHostNameToFolderMapping("launcher.local", MiniStore.ActiveLauncherInterfaceRoot, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.DenyCors);
            await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(await File.ReadAllTextAsync(Path.Combine(MiniStore.ResourceRoot, "launcher-runtime.js")));
            web.CoreWebView2.WebMessageReceived += (_, e) =>
            {
                if (Uri.TryCreate(e.Source, UriKind.Absolute, out var source) &&
                    source.Scheme == Uri.UriSchemeHttps && source.IsDefaultPort &&
                    string.IsNullOrEmpty(source.UserInfo) &&
                    string.Equals(source.Host, "launcher.local", StringComparison.OrdinalIgnoreCase))
                    HandleRequest(e.TryGetWebMessageAsString());
            };
            // Launcher sharing is clipboard-based, so it works on every supported Windows version.
            web.CoreWebView2.Navigate("https://launcher.local/index.html");
        }
        catch (Exception error) { MessageBox.Show(this, "Не удалось открыть интерфейс.\n\n" + error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }
    private void HandleRequest(string raw)
    {
        try
        {
            var request = JsonNode.Parse(raw)?.AsObject() ?? throw new InvalidDataException(); var id = request["id"]?.GetValue<string>() ?? ""; var method = request["method"]?.GetValue<string>() ?? "";
            switch (method)
            {
                case "apps.list": MiniStore.Sync(); Reply(id, true, new JsonArray(MiniStore.Apps().Select(x => (JsonNode)new JsonObject { ["id"] = x.Manifest.Id, ["name"] = x.Manifest.Name, ["version"] = x.Manifest.Version }).ToArray()), null, null); break;
                case "apps.getAppInfo": { MiniStore.Sync(); var appInfo = FindApp(request); Reply(id, true, MiniStore.AppInfo(appInfo.Manifest, appInfo.Directory), null, null); break; }
                case "apps.open": var app = FindApp(request); ShowApp(app.Manifest, app.Directory); Reply(id, true, null, null, null); break;
                case "apps.openNewWindow": var newWindowApp = FindApp(request); OpenAdditionalWindow(newWindowApp.Manifest, newWindowApp.Directory); Reply(id, true, null, null, null); break;
                case "apps.refresh": RunOperation(id, () => MiniStore.Sync().ToJson()); break;
                case "apps.importApp": ImportApp(id); break;
                case "apps.delete": RunOperation(id, () => { MiniStore.Delete(request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "id is required")); return null; }); break;
                case "apps.share": RunOperationWithResult(id, () => ShareToClipboard(request, false)); break;
                case "apps.shareData": RunOperationWithResult(id, () => ShareToClipboard(request, true)); break;
                case "apps.rollbackInfo": Reply(id,true,MiniStore.RollbackInfo(request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params","id is required")),null,null); break;
                case "apps.rollback": RunOperation(id,()=> { MiniStore.Rollback(request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params","id is required")); return null; }); break;
                case "apps.deleteRollback": RunOperation(id,()=> { MiniStore.DeleteRollback(request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params","id is required")); return null; }); break;
                case "apps.permissions.get": { var appPermissions=FindApp(request); var store=new PermissionStore(appPermissions.Manifest.Id, appPermissions.Manifest.Name); Reply(id,true,new JsonObject { ["id"]=appPermissions.Manifest.Id,["permissions"]=new JsonArray(appPermissions.Manifest.Permissions.Order().Select(permission=>(JsonNode)new JsonObject { ["permission"]=permission,["state"]=store.StateFor(permission) }).ToArray()) },null,null); break; }
                case "apps.permissions.set": RunOperation(id,()=> { var appPermissions=FindApp(request); var permission=request["params"]?["permission"]?.GetValue<string>() ?? throw new ApiError("invalid_params","permission is required"); var state=request["params"]?["state"]?.GetValue<string>() ?? throw new ApiError("invalid_params","state is required"); if(!appPermissions.Manifest.Permissions.Contains(permission))throw new ApiError("permission_not_declared","Permission is not declared"); new PermissionStore(appPermissions.Manifest.Id, appPermissions.Manifest.Name).Set(permission,state); return null; }); break;
                case "apps.permissions.reset": RunOperation(id,()=> { var appPermissions=FindApp(request); new PermissionStore(appPermissions.Manifest.Id, appPermissions.Manifest.Name).Reset(); return null; }); break;
                case "apps.settings": Reply(id, true, new JsonObject { ["version"] = "1.0.0", ["platform"] = "Windows", ["appsPath"] = MiniStore.Root }, null, null); break;
                case "interfaces.list": Reply(id, true, MiniStore.Interfaces(), null, null); break;
                case "interfaces.select": { MiniStore.SelectInterface(request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "id is required")); web.CoreWebView2.SetVirtualHostNameToFolderMapping("launcher.local", MiniStore.ActiveLauncherInterfaceRoot, Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind.DenyCors); Reply(id, true, null, null, null); break; }
                case "interfaces.import": ImportInterface(id); break;
                case "interfaces.settings.get": Reply(id, true, MiniStore.GetInterfaceSettings(), null, null); break;
                case "interfaces.settings.set": MiniStore.SetInterfaceSettings(request["params"]?["settings"]); Reply(id, true, null, null, null); break;
                default: Reply(id, false, null, "method_not_found", "Unknown method"); break;
            }
        }
        catch (ApiError error) { Reply("", false, null, error.Code, error.Message); }
        catch (Exception error) { Reply("", false, null, "invalid_request", error.Message); }
    }
    private void ImportApp(string id)
    {
        if (operation) { Reply(id, false, null, "operation_in_progress", "Another operation is running"); return; }
        using var dialog = new OpenFileDialog { Filter = "Mini-app package|*.zip;*.html;*.htm|ZIP archive|*.zip|HTML file|*.html;*.htm" };
        if (dialog.ShowDialog(this) != DialogResult.OK) { Reply(id, false, null, "source_file_not_found", "No file selected"); return; }
        try
        {
            var extension = Path.GetExtension(dialog.FileName);
            var manual = extension.Equals(".html", StringComparison.OrdinalIgnoreCase) || extension.Equals(".htm", StringComparison.OrdinalIgnoreCase)
                ? (!MiniStore.HasEmbeddedManifest(dialog.FileName) ? PromptHtmlManifest(dialog.FileName) : null)
                : null;
            if ((extension.Equals(".html", StringComparison.OrdinalIgnoreCase) || extension.Equals(".htm", StringComparison.OrdinalIgnoreCase)) && !MiniStore.HasEmbeddedManifest(dialog.FileName) && manual is null)
            {
                Reply(id, false, null, "source_file_invalid", "Manifest was not provided"); return;
            }
            RunOperation(id, () => manual is null ? MiniStore.Import(dialog.FileName) : MiniStore.Import(dialog.FileName, manual));
        }
        catch (ApiError error) { Reply(id, false, null, error.Code, error.Message); }
        catch (Exception error) { Reply(id, false, null, "source_file_invalid", error.Message); }
    }
    private MiniManifest? PromptHtmlManifest(string source)
    {
        using var form = new Form { Text = "Неизвестный HTML", StartPosition = FormStartPosition.CenterParent, FormBorderStyle = FormBorderStyle.FixedDialog, MinimizeBox = false, MaximizeBox = false, ClientSize = new Size(420, 235) };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(14), ColumnCount = 2, RowCount = 5 };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95)); layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var id = new TextBox { Text = "local." + Regex.Replace(Path.GetFileNameWithoutExtension(source).ToLowerInvariant(), "[^a-z0-9._-]", "_") };
        var name = new TextBox { Text = Path.GetFileNameWithoutExtension(source) };
        var version = new TextBox { Text = "1.0.0" };
        var permissions = new TextBox();
        void Add(string label, Control input, int row) { layout.Controls.Add(new Label { Text = label, Anchor = AnchorStyles.Left, AutoSize = true }, 0, row); input.Dock = DockStyle.Fill; layout.Controls.Add(input, 1, row); }
        Add("App ID", id, 0); Add("Название", name, 1); Add("Версия", version, 2); Add("Разрешения", permissions, 3);
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft };
        var ok = new Button { Text = "Установить", DialogResult = DialogResult.OK, AutoSize = true }; buttons.Controls.Add(ok); buttons.Controls.Add(new Button { Text = "Отмена", DialogResult = DialogResult.Cancel, AutoSize = true }); layout.Controls.Add(buttons, 0, 4); layout.SetColumnSpan(buttons, 2);
        form.Controls.Add(layout); form.AcceptButton = ok;
        if (form.ShowDialog(this) != DialogResult.OK) return null;
        var declared = permissions.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet();
        return new MiniManifest(id.Text.Trim(), name.Text.Trim(), version.Text.Trim(), 1, "index.html", declared, null, null);
    }
    private void ImportInterface(string id) { if (operation) { Reply(id, false, null, "operation_in_progress", "Another operation is running"); return; } using var dialog = new OpenFileDialog { Filter = "Interface|*.zip;*.html;*.htm|ZIP archive|*.zip|HTML file|*.html;*.htm" }; if (dialog.ShowDialog(this) != DialogResult.OK) { Reply(id, false, null, "source_file_not_found", "No file selected"); return; } RunOperation(id, () => { MiniStore.InstallInterface(dialog.FileName); return null; }); }
    private void RunOperation(string id, Func<object?> action)
    {
        if (operation) { Reply(id, false, null, "operation_in_progress", "Another operation is running"); return; }
        operation = true;
        try
        {
            var value = action();
            var result = value switch
            {
                MiniStore.InstallResult install => new JsonObject
                {
                    ["installed"] = install.Installed,
                    ["appId"] = install.Manifest.Id,
                    ["appPath"] = install.Directory
                },
                JsonNode node => node,
                _ => null
            };
            Reply(id, true, result, null, null);
        }
        catch (ApiError error) { Reply(id, false, null, error.Code, error.Message); }
        catch (Exception error) { Reply(id, false, null, "app_delete_failed", error.Message); }
        finally { operation = false; }
    }
    private void RunOperationWithResult(string id, Func<JsonObject> action)
    {
        if (operation) { Reply(id, false, null, "operation_in_progress", "Another operation is running"); return; }
        operation = true;
        try { Reply(id, true, action(), null, null); }
        catch (ApiError error) { Reply(id, false, null, error.Code, error.Message); }
        catch (Exception error) { Reply(id, false, null, "app_share_failed", error.Message); }
        finally { operation = false; }
    }
    private JsonObject ShareToClipboard(JsonObject request, bool data)
    {
        var id = request["params"]?["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "id is required");
        var app = MiniStore.Find(id);
        var source = data ? Path.Combine(app.Directory, "storage.json") : CreateSharePackage(app);
        if (!File.Exists(source)) throw new ApiError(data ? "app_data_not_found" : "source_file_not_found", data ? "No public data file exists" : "Application package could not be created");
        var name = data ? $"{app.Manifest.Name}-storage.json" : Path.GetFileName(source);
        var root = Path.Combine(Path.GetTempPath(), "MiniAppRuntime", "clipboard-share"); Directory.CreateDirectory(root);
        var copy = Path.Combine(root, name); File.Copy(source, copy, true);
        var files = new System.Collections.Specialized.StringCollection(); files.Add(copy); System.Windows.Forms.Clipboard.SetFileDropList(files);
        return new JsonObject { ["message"] = "Скопировано в буфер обмена" };
    }
    private static string CreateSharePackage((MiniManifest Manifest, string Directory) app)
    {
        var files = Directory.EnumerateFiles(app.Directory, "*", SearchOption.AllDirectories)
            .Where(file => Path.GetFileName(file) is not ("storage.json" or "storage.json.bak"))
            .ToArray();
        var entry = Path.GetFullPath(Path.Combine(app.Directory, app.Manifest.Entry));
        var singleHtml = files.Length == 2 && files.Any(file => Path.GetFullPath(file).Equals(entry, StringComparison.OrdinalIgnoreCase)) &&
            File.ReadAllText(entry).Contains("application/miniapp+json", StringComparison.OrdinalIgnoreCase);
        var root = Path.Combine(Path.GetTempPath(), "MiniAppRuntime", "clipboard-share", "packages"); Directory.CreateDirectory(root);
        var safeName = string.Concat(app.Manifest.Name.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) ? '_' : ch));
        if (singleHtml)
        {
            var output = Path.Combine(root, $"{safeName}-{app.Manifest.Version}.html"); File.Copy(entry, output, true); return output;
        }
        var archive = Path.Combine(root, $"{safeName}-{app.Manifest.Version}.zip");
        if (File.Exists(archive)) File.Delete(archive);
        using var zip = ZipFile.Open(archive, ZipArchiveMode.Create);
        foreach (var file in files) zip.CreateEntryFromFile(file, Path.GetRelativePath(app.Directory, file), CompressionLevel.Optimal);
        return archive;
    }
    private void Reply(string id, bool success, JsonNode? result, string? code, string? error) { var response = new JsonObject { ["id"] = id, ["success"] = success }; if (success) response["result"] = result; else response["error"] = new JsonObject { ["code"] = code, ["message"] = error }; web.CoreWebView2?.ExecuteScriptAsync($"window.__launcherResolve({JsonSerializer.Serialize(response.ToJsonString())});"); }
    private static (MiniManifest Manifest, string Directory) FindApp(JsonObject request) { var app = MiniStore.Apps().FirstOrDefault(x => x.Manifest.Id == request["params"]?["id"]?.GetValue<string>()); return app.Manifest is null ? throw new InvalidDataException("App not found") : app; }
    private void OpenAdditionalWindow(MiniManifest manifest, string directory)
    {
        var window = new MiniAppWindow(manifest, directory);
        additionalWindows.Add(window);
        window.FormClosed += (_, _) => additionalWindows.Remove(window);
        window.Show();
    }
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        WindowSizeStore.Save("launcher", WindowState == FormWindowState.Normal ? Size : RestoreBounds.Size);
        if (exiting || additionalWindows.Count == 0) { trayIcon.Visible = false; return; }
        e.Cancel = true;
        Hide();
        ShowInTaskbar = false;
        trayIcon.Visible = true;
        trayIcon.ShowBalloonTip(1000, Text, "Приложение продолжает работать в области уведомлений.", ToolTipIcon.Info);
    }
    private void RestoreFromTray()
    {
        ShowInTaskbar = true;
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
        trayIcon.Visible = false;
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing) { trayIcon.Dispose(); }
        base.Dispose(disposing);
    }
    private void ShowApp(MiniManifest manifest, string directory) { activeApp?.Dispose(); activeApp = new WebAppView(manifest, directory, ShowLauncher) { Dock = DockStyle.Fill }; web.Hide(); content.Controls.Add(activeApp); activeApp.BringToFront(); }
    private void ShowLauncher() { if (activeApp is not null) { content.Controls.Remove(activeApp); activeApp.Dispose(); activeApp = null; } Text = "Mini App Runtime"; navigation.Hide(); web.Show(); web.CoreWebView2?.Reload(); }
}

internal sealed class MiniAppWindow : Form
{
    public MiniAppWindow(MiniManifest manifest, string directory)
    {
        Text = manifest.Name; Width = 1100; Height = 760; StartPosition = FormStartPosition.CenterParent;
        Size = WindowSizeStore.Load("app:" + manifest.Id, Size);
        Controls.Add(new WebAppView(manifest, directory, Close) { Dock = DockStyle.Fill });
        FormClosing += (_, _) => WindowSizeStore.Save("app:" + manifest.Id, WindowState == FormWindowState.Normal ? Size : RestoreBounds.Size);
    }
}
