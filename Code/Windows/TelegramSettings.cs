using System.Text.Json;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class TelegramSettings
{
    private static readonly string PathOnDisk = Path.Combine(MiniStore.ConfigRoot, "telegram-settings.json");

    internal static JsonObject Read(bool sharedSignIn = false)
    {
        JsonObject? stored = null;
        try { stored = JsonNode.Parse(File.ReadAllText(PathOnDisk)) as JsonObject; }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (JsonException) { }
        return new JsonObject
        {
            ["testServer"] = !sharedSignIn && stored?["testServer"]?.GetValueKind() == JsonValueKind.True,
            ["writeLoginLog"] = stored?["writeLoginLog"]?.GetValueKind() == JsonValueKind.True
        };
    }

    internal static JsonObject Save(JsonNode? parameters)
    {
        if (parameters is not JsonObject settings || !IsBoolean(settings["testServer"]) ||
            !IsBoolean(settings["writeLoginLog"]))
            throw new ApiError("invalid_params", "Telegram settings require two boolean values");

        var saved = new JsonObject
        {
            ["testServer"] = settings["testServer"]!.DeepClone(),
            ["writeLoginLog"] = settings["writeLoginLog"]!.DeepClone()
        };
        var temporary = Path.Combine(MiniStore.ConfigRoot, $".telegram-{Guid.NewGuid():N}.tmp");
        try
        {
            Directory.CreateDirectory(MiniStore.ConfigRoot);
            File.WriteAllText(temporary, saved.ToJsonString());
            File.Move(temporary, PathOnDisk, overwrite: true);
        }
        finally { File.Delete(temporary); }
        return saved;
    }

    private static bool IsBoolean(JsonNode? value) => value?.GetValueKind() is JsonValueKind.True or JsonValueKind.False;
}
