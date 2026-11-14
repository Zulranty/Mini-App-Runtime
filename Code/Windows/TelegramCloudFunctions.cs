using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class TelegramCloudFunctions
{
    public static void Register(MiniAppFunctions functions, SecureStorageStore storage, TelegramAccess access)
    {
        var state = new TelegramCloudState(storage);
        var topBar = new CloudTopBar();
        functions.EnableStreams = true;
        functions.AllowExternalDrop = true;
        functions.TopBar = topBar;
        Register(_ => state.SavedChannel(access.ApprovedFingerprint), "telegramCloud.getSavedChannel");
        Register(parameters => state.RememberChannel(parameters["id"]?.GetValue<string>() ?? "", access.ApprovedFingerprint),
            "telegramCloud.rememberChannel");
        Register(parameters => state.Thumbnail(parameters, false, access.ApprovedFingerprint),
            "telegramCloud.getThumbnail");
        Register(parameters => state.Thumbnail(parameters, true, access.ApprovedFingerprint),
            "telegramCloud.cacheThumbnail");
        Register(parameters =>
        {
            var folder = parameters["folder"]?.GetValue<string>() ?? "";
            var channelTitle = parameters["channelTitle"]?.GetValue<string>() ?? "";
            if (folder.Length > 4096 || channelTitle.Length > 256)
                throw new ApiError("invalid_params", "Invalid cloud path");
            topBar.SetCloudToolbar(new CloudToolbarState(
                parameters["connected"]?.GetValue<bool>() == true,
                parameters["hasChannel"]?.GetValue<bool>() == true, channelTitle, folder,
                parameters["view"]?.GetValue<string>() ?? "tiles", parameters["sort"]?.GetValue<string>() ?? "name",
                parameters["hasTransfers"]?.GetValue<bool>() == true));
            return null;
        }, "telegramCloud.setToolbar");
        Register(parameters =>
        {
            var kind = parameters["kind"]?.GetValue<string>();
            if (kind is not ("background" or "file" or "selection"))
                throw new ApiError("invalid_params", "Unknown cloud context menu");
            return JsonValue.Create(topBar.ShowCloudContextMenu(kind, parameters["canShare"]?.GetValue<bool>() == true,
                parameters["canDownload"]?.GetValue<bool>() == true));
        }, "telegramCloud.showContextMenu");

        void Register(Func<JsonObject, JsonNode?> handler, string method) => functions.Register(method, handler);
    }
}
