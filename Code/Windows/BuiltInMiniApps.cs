namespace MiniAppRuntime.Windows;

internal sealed record MiniAppContent(MiniManifest Manifest, string Directory, Func<string, Stream?>? OpenModule = null);

internal static class BuiltInMiniApps
{
    public static MiniAppContent ResolveContent(MiniManifest manifest, string directory) =>
        manifest.Id == TelegramSessionLease.ClientAppId
            ? new(TelegramPackage.TrustedManifest(), TelegramPackage.TrustedClientRoot,
                url => ModuleScripts.OpenTrustedTelegram(url, TelegramPackage.TrustedModuleFile))
            : new(manifest, directory);

    public static MiniAppFunctions Configure(MiniManifest manifest, SecureStorageStore storage,
        PermissionStore permissions, Control view, Func<IWin32Window> ownerWindow, Func<Task> requireUserGesture,
        WebStreams streams, string launchReason, Action? completeLaunch)
    {
        var functions = new MiniAppFunctions();
        TelegramFunctions.Register(functions, manifest, storage, permissions, view, ownerWindow,
            requireUserGesture, streams, launchReason, completeLaunch);
        return functions;
    }
}
