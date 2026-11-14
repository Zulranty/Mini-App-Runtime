using System.Globalization;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class AppLanguage
{
    private static readonly string SettingsPath = Path.Combine(MiniStore.ConfigRoot, "language.txt");

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

    internal static IReadOnlyDictionary<string, AppTranslation> ReadTranslations(JsonNode? value)
    {
        var result = new Dictionary<string, AppTranslation>(StringComparer.Ordinal);
        if (value is null) return result;
        if (value is not JsonObject translations) throw InvalidTranslations();
        foreach (var (language, translation) in translations)
        {
            if (language is not ("en" or "ru") || translation is not JsonObject fields ||
                fields.Any(field => field.Key is not ("name" or "description")))
                throw InvalidTranslations();
            var name = ReadText(fields, "name", 256);
            var description = ReadText(fields, "description", 1024);
            if (name is null && description is null) throw InvalidTranslations();
            result.Add(language, new AppTranslation(name, description));
        }
        return result;
    }

    private static string? ReadText(JsonObject fields, string key, int limit)
    {
        if (!fields.TryGetPropertyValue(key, out var value)) return null;
        if (value is JsonValue text && text.TryGetValue<string>(out var result) &&
            !string.IsNullOrWhiteSpace(result) && result.Length <= limit)
            return result;
        throw InvalidTranslations();
    }

    private static ApiError InvalidTranslations() => new("source_file_invalid", "Invalid app translations");
}

internal sealed record AppTranslation(string? Name, string? Description);
