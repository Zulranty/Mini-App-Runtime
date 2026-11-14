using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MiniAppRuntime.Windows;

internal static class RuntimeLog
{
    private const int MaxFileBytes = 1024 * 1024;
    private const int MaxEntryBytes = 8192;
    private const int TelegramTailEntries = 80;
    private static readonly object Gate = new();
    private static readonly Regex Identifier = new(@"\A[A-Za-z][A-Za-z0-9_.-]{0,63}\z", RegexOptions.CultureInvariant);
    private static string LogDirectory => Path.Combine(MiniStore.DataRoot, "Logs");

    internal static JsonObject ReadTelegram()
    {
        var path = Path.Combine(LogDirectory, "miniapps.jsonl");
        var previous = Path.Combine(LogDirectory, "miniapps.previous.jsonl");
        var lines = new Queue<string>();
        try
        {
            lock (Gate)
            {
                RejectReparsePoint(MiniStore.DataRoot);
                RejectReparsePoint(LogDirectory);
                foreach (var file in new[] { previous, path })
                {
                    RejectReparsePoint(file);
                    var info = new FileInfo(file);
                    if (!info.Exists || info.Length > MaxFileBytes) continue;
                    foreach (var line in File.ReadLines(file))
                    {
                        if (Encoding.UTF8.GetByteCount(line) >= MaxEntryBytes) continue;
                        try
                        {
                            if (JsonNode.Parse(line) is not JsonObject record ||
                                record["appId"] is not JsonValue app || !app.TryGetValue<string>(out var appId) ||
                                appId != TelegramSessionLease.ClientAppId ||
                                record["event"] is not JsonValue eventValue || !eventValue.TryGetValue<string>(out var name) ||
                                name?.StartsWith("telegram.", StringComparison.Ordinal) != true) continue;
                            if (lines.Count == TelegramTailEntries) lines.Dequeue();
                            lines.Enqueue(line);
                        }
                        catch (JsonException) { }
                    }
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ApiError("log_read_failed", "Could not read the Telegram login log");
        }
        return new JsonObject { ["path"] = path, ["text"] = string.Join('\n', lines) };
    }

    internal static JsonObject Write(MiniManifest manifest, JsonObject parameters)
    {
        if (parameters["event"] is not JsonValue eventValue || !eventValue.TryGetValue<string>(out var eventName) ||
            eventName is null || !Identifier.IsMatch(eventName))
            throw new ApiError("invalid_params", "Invalid log event name");
        if (parameters["fields"] is not null && parameters["fields"] is not JsonObject)
            throw new ApiError("invalid_params", "Log fields must be an object");
        var fields = parameters["fields"] as JsonObject ?? new JsonObject();
        if (fields.Count > 16 || fields.Any(field => !Identifier.IsMatch(field.Key) || !IsFieldValue(field.Value)))
            throw new ApiError("invalid_params", "Invalid log fields");

        var record = new JsonObject
        {
            ["timestamp"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
            ["platform"] = "windows",
            ["appId"] = manifest.Id,
            ["appVersion"] = manifest.Version,
            ["event"] = eventName,
            ["fields"] = fields.DeepClone()
        };
        var bytes = Encoding.UTF8.GetBytes(record.ToJsonString() + "\n");
        if (bytes.Length > MaxEntryBytes)
            throw new ApiError("invalid_params", "Log entry exceeds 8 KiB");

        var directory = LogDirectory;
        var path = Path.Combine(directory, "miniapps.jsonl");
        var previous = Path.Combine(directory, "miniapps.previous.jsonl");
        try
        {
            lock (Gate)
            {
                RejectReparsePoint(MiniStore.DataRoot);
                RejectReparsePoint(directory);
                Directory.CreateDirectory(directory);
                RejectReparsePoint(path);
                RejectReparsePoint(previous);
                if (File.Exists(path) && new FileInfo(path).Length + bytes.Length > MaxFileBytes)
                    File.Move(path, previous, overwrite: true);
                using var file = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
                file.Write(bytes);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ApiError("log_write_failed", "Could not write the MiniApps log");
        }
        return new JsonObject { ["path"] = path };
    }

    private static bool IsFieldValue(JsonNode? node) => node?.GetValueKind() switch
    {
        null or JsonValueKind.Null or JsonValueKind.True or JsonValueKind.False => true,
        JsonValueKind.String => node.GetValue<string>().Length <= 256,
        JsonValueKind.Number => node is JsonValue value && value.TryGetValue<double>(out var number) && double.IsFinite(number),
        _ => false
    };

    private static void RejectReparsePoint(string path)
    {
        try
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Log path is a reparse point");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
    }
}
