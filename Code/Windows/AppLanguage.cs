using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class AppLanguage
{
    private static readonly string SettingsPath = Path.Combine(MiniStore.ConfigRoot, "language.txt");
    private static readonly Regex Tag = new(@"\A[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,6}\z", RegexOptions.CultureInvariant);
    private static readonly Dictionary<string, string> OldRussianThemes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["f2641200bfae4064aea0a2c031f126ce5adf758543612fa568d1c1174fe67edb"] = "default",
        ["7db06a1e4c6d69e0c7b7a947c1dd45d91f04b13e56359f17fc1674b6ee7d3d65"] = "default",
        ["71275520a2db3747113c11ae855de07b778a5538e3f244893d4ebf30b27118f5"] = "Metro-Interface",
        ["19b98fe9864c9c1389f094094cd3968c499323492e764916e7dcd115de7e729b"] = "Metro-Interface"
    };

    internal static string Preference()
    {
        try
        {
            if (new FileInfo(SettingsPath) is { Exists: true, Length: <= 16 })
            {
                var saved = File.ReadAllText(SettingsPath).Trim();
                if (saved is "en" or "ru") return saved;
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ru" ? "ru" : "en";
    }

    internal static void Save(string? language)
    {
        if (language is not ("en" or "ru")) throw new ApiError("invalid_params", "Unsupported launcher language");
        Directory.CreateDirectory(MiniStore.ConfigRoot);
        var temporary = Path.Combine(MiniStore.ConfigRoot, $".language-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(temporary, language);
            File.Move(temporary, SettingsPath, overwrite: true);
        }
        finally { File.Delete(temporary); }
    }

    internal static string? Normalize(string? tag)
    {
        if (tag is null || tag.Length > 64) return null;
        var normalized = tag.ToLowerInvariant();
        return Tag.IsMatch(normalized) ? normalized : null;
    }

    internal static string Match(string preference, IEnumerable<string> available, string fallback)
    {
        for (var candidate = preference; ;)
        {
            if (available.Contains(candidate, StringComparer.Ordinal)) return candidate;
            var separator = candidate.LastIndexOf('-');
            if (separator < 0) return fallback;
            candidate = candidate[..separator];
        }
    }

    internal static IReadOnlyDictionary<string, LocalizedEntry> ReadEntries(JsonNode? value, string? defaultLanguage)
    {
        var result = new Dictionary<string, LocalizedEntry>(StringComparer.Ordinal);
        if (value is null && defaultLanguage is null) return result;
        if (value is not JsonObject locales || locales.Count is < 1 or > 32 || Normalize(defaultLanguage) is not { } fallback)
            throw InvalidLocales();
        foreach (var (tag, valueNode) in locales)
        {
            if (Normalize(tag) is not { } language || valueNode is not JsonObject definition ||
                definition["entry"] is not JsonValue entryValue || !entryValue.TryGetValue<string>(out var entry) || !SafeEntry(entry))
                throw InvalidLocales();
            var name = OptionalText(definition, "name", 256);
            var description = OptionalText(definition, "description", 1024);
            if (!result.TryAdd(language, new LocalizedEntry(entry!, name, description))) throw InvalidLocales();
        }
        if (!result.ContainsKey(fallback)) throw InvalidLocales();
        return result;
    }

    internal static bool SafeEntry(string? path) => path is { Length: > 0 and <= 240 } &&
        path.EndsWith(".html", StringComparison.OrdinalIgnoreCase) &&
        path.All(c => char.IsAsciiLetterOrDigit(c) || c is '/' or '_' or '.' or '-') && MiniManifest.SafeRelativePath(path);

    private static string? OptionalText(JsonObject definition, string key, int max) => definition[key] switch
    {
        null => null,
        JsonValue value when value.TryGetValue<string>(out var text) && text is not null && text.Length <= max => text,
        _ => throw InvalidLocales()
    };

    private static ApiError InvalidLocales() => new("source_file_invalid", "Invalid localized app entries");

    internal static string? StockLauncherPage(string interfaceRoot, string preference)
    {
        var selected = Path.Combine(interfaceRoot, "index.html");
        try
        {
            if (new FileInfo(selected) is not { Exists: true, Length: > 0 and <= 128 * 1024 }) return null;
            var bytes = File.ReadAllBytes(selected);
            var assets = Path.Combine(MiniStore.ResourceRoot, "LauncherLocales");
            foreach (var theme in new[] { "default", "Metro-Interface" })
            {
                string Page(string locale) => Path.Combine(assets, locale, theme, "index.html");
                if (bytes.AsSpan().SequenceEqual(File.ReadAllBytes(Page("en"))) ||
                    bytes.AsSpan().SequenceEqual(File.ReadAllBytes(Page("ru")))) return Page(preference);
            }
            var digest = Convert.ToHexString(SHA256.HashData(bytes));
            if (OldRussianThemes.TryGetValue(digest, out var oldTheme))
                return Path.Combine(assets, preference, oldTheme, "index.html");
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return null;
    }
}

internal sealed record LocalizedEntry(string Entry, string? Name, string? Description);
