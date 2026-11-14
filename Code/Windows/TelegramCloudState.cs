using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MiniAppRuntime.Windows;

internal sealed class TelegramCloudState(SecureStorageStore storage)
{
    internal const string AppId = "com.miniapps.telegram-cloud";
    internal const string GrantKey = "runtime.telegram-cloud.v1";
    private const int ThumbnailLimit = 192 * 1024;
    private static readonly object ThumbnailLock = new();
    private static readonly string ThumbnailRoot = Path.Combine(MiniStore.PrivateRoot, AppId, "thumbnails");
    private static bool legacyThumbnailsRemoved;

    public JsonNode? SavedChannel(string? fingerprint) =>
        ApprovedGrant(fingerprint)?["channelId"]?.DeepClone();

    private JsonObject? ApprovedGrant(string? fingerprint)
    {
        if (fingerprint is null) return null;
        var grant = storage.Get(GrantKey) as JsonObject;
        return grant?["fingerprint"]?.GetValue<string>() == fingerprint ? grant : null;
    }

    public JsonNode? RememberChannel(string id, string? fingerprint)
    {
        if (!Regex.IsMatch(id, @"^-?[0-9]{1,25}$")) throw new ApiError("invalid_params", "Invalid Telegram channel ID");
        if (ApprovedGrant(fingerprint) is not { } grant)
            throw new ApiError("telegram_session_changed", "The saved Telegram session changed");
        if (grant["channelId"]?.GetValue<string>() == id) return null;
        grant["channelId"] = id;
        return storage.Set(GrantKey, grant);
    }

    public JsonNode? Thumbnail(JsonObject parameters, bool write, string? fingerprint)
    {
        var key = parameters["key"]?.GetValue<string>();
        if (fingerprint is null || key is null || !Regex.IsMatch(key, @"\A[-A-Za-z0-9_:]{1,160}\z")) return null;
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(fingerprint + ":" + key)));
        var path = Path.Combine(ThumbnailRoot, hash + ".thumb2");
        lock (ThumbnailLock)
        {
            try
            {
                if (!legacyThumbnailsRemoved)
                {
                    if (Directory.Exists(ThumbnailRoot))
                        foreach (var legacy in Directory.EnumerateFiles(ThumbnailRoot, "*.thumb")) File.Delete(legacy);
                    legacyThumbnailsRemoved = true;
                }
                if (!write)
                {
                    var entry = new FileInfo(path);
                    if (!entry.Exists || entry.Length > ThumbnailLimit) return null;
                    File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
                    return JsonValue.Create(File.ReadAllText(path));
                }
                var data = parameters["data"]?.GetValue<string>();
                if (data is null || data.Length > ThumbnailLimit || data.Any(c => c > 127)) return null;
                Directory.CreateDirectory(ThumbnailRoot);
                File.WriteAllText(path, data);
                foreach (var entry in new DirectoryInfo(ThumbnailRoot).EnumerateFiles("*.thumb2")
                    .OrderByDescending(item => item.LastWriteTimeUtc).Skip(256))
                    entry.Delete();
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return null;
        }
    }
}
