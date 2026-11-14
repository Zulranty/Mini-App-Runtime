using System.Text.RegularExpressions;

namespace MiniAppRuntime.Windows;

internal static class ModuleScripts
{
    internal const string Origin = "https://modules.miniapp.local";
    private const int MaxScriptBytes = 16 * 1024 * 1024;
    private static readonly Regex EntryPath = new(@"\A/([a-z][a-z0-9-]{0,47})/index\.js\z", RegexOptions.CultureInvariant);

    internal static Stream? Open(string appRoot, string url)
    {
        if (!url.StartsWith(Origin, StringComparison.Ordinal))
            return null;
        var match = EntryPath.Match(url[Origin.Length..]);
        if (!match.Success)
            return null;

        var modules = Path.Combine(appRoot, MiniStore.ModulesFolder);
        var module = Path.Combine(modules, match.Groups[1].Value);
        var script = Path.Combine(module, "index.js");
        try
        {
            if (IsLink(modules) || IsLink(module) || IsLink(script))
                return null;
            using var file = File.OpenRead(script);
            var size = file.Length;
            if (size > MaxScriptBytes)
                return null;
            // WebView2 may retain the response stream after loading. Release the
            // file here so replacing the module does not require closing the app.
            var bytes = new byte[(int)size];
            file.ReadExactly(bytes);
            return new MemoryStream(bytes, writable: false);
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    internal static Stream? OpenTrustedTelegram(string url, string path) =>
        url == Origin + "/telegram/index.js" && File.Exists(path)
            ? new MemoryStream(File.ReadAllBytes(path), writable: false)
            : null;

    private static bool IsLink(string path) => (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
}
