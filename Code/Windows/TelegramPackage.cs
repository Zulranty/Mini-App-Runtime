using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class TelegramPackage
{
    private static readonly string Source = Path.Combine(MiniStore.ResourceRoot, "TelegramPackage");
    private static readonly string[] ModuleFiles = ["THIRD-PARTY.txt", "index.js"];

    internal static JsonObject? ReadAppCredentials()
    {
        try
        {
            var file = new FileInfo(Path.Combine(Source, "api-credentials.local.json"));
            if (!file.Exists || file.Length > 4096 || JsonNode.Parse(File.ReadAllText(file.FullName)) is not JsonObject config)
                return null;
            return new JsonObject
            {
                ["api_id"] = config["api_id"]?.DeepClone(),
                ["api_hash"] = config["api_hash"]?.DeepClone()
            };
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    internal static string TrustedClientRoot => Path.Combine(Source, "client");
    internal static string TrustedModuleFile => Path.Combine(Source, "module", "index.js");

    internal static MiniManifest TrustedManifest()
    {
        var manifest = MiniManifest.Parse(File.ReadAllText(Path.Combine(TrustedClientRoot, "manifest.json")));
        if (manifest.Id != TelegramSessionLease.ClientAppId)
            throw new ApiError("telegram_package_missing", "The bundled Telegram provider is unavailable");
        return manifest;
    }

    internal static bool HasClient() =>
        Directory.Exists(MiniStore.Root) &&
        MiniStore.Apps().Any(app => app.Manifest.Id == TelegramSessionLease.ClientAppId);

    internal static bool Install(IProgress<int> progress)
    {
        var client = Path.Combine(Source, "client");
        var sourceModule = Path.Combine(Source, "module");
        if (!File.Exists(Path.Combine(client, "manifest.json")) || !File.Exists(Path.Combine(client, "index.html")) ||
            ModuleFiles.Any(name => !File.Exists(Path.Combine(sourceModule, name))))
            throw new ApiError("telegram_package_missing", "Telegram is missing from this MiniApps build");

        var modules = Path.Combine(MiniStore.Root, MiniStore.ModulesFolder);
        var module = Path.Combine(modules, "telegram");
        foreach (var directory in new[] { modules, module })
        {
            if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                throw new ApiError("telegram_install_failed", "Invalid Telegram module directory");
            Directory.CreateDirectory(directory);
        }

        var archive = Path.Combine(Path.GetTempPath(), $"miniapps-telegram-{Guid.NewGuid():N}.zip");
        try
        {
            var clientFiles = Directory.GetFiles(client, "*", SearchOption.AllDirectories);
            var steps = clientFiles.Length + ModuleFiles.Length + 1;
            var completed = 0;
            using (var zip = ZipFile.Open(archive, ZipArchiveMode.Create))
            {
                foreach (var file in clientFiles)
                {
                    var entry = Path.GetRelativePath(client, file).Replace(Path.DirectorySeparatorChar, '/');
                    zip.CreateEntryFromFile(file, entry);
                    progress.Report(++completed * 100 / steps);
                }
            }
            var result = MiniStore.ImportBundledTelegram(archive);
            if (!result.Installed) return false;
            foreach (var name in ModuleFiles)
            {
                var temporary = Path.Combine(module, $".install-{Guid.NewGuid():N}.tmp");
                try
                {
                    File.Copy(Path.Combine(sourceModule, name), temporary);
                    File.Move(temporary, Path.Combine(module, name), overwrite: true);
                    progress.Report(++completed * 100 / steps);
                }
                finally { File.Delete(temporary); }
            }
            progress.Report(100);
            return true;
        }
        catch (IOException error)
        {
            throw new ApiError("telegram_install_failed", error.Message);
        }
        finally { File.Delete(archive); }
    }
}
