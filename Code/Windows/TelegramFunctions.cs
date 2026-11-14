using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal sealed class TelegramFunctions(
    TelegramSessionLease lease, Control view, Func<IWin32Window> ownerWindow) : IDisposable
{
    private bool signingIn;
    private IntPtr captureProtectedWindow;

    public static void Register(MiniAppFunctions functions, MiniManifest manifest, SecureStorageStore storage,
        PermissionStore permissions, Control view, Func<IWin32Window> ownerWindow, Func<Task> requireUserGesture,
        WebStreams streams, string launchReason, Action? completeLaunch)
    {
        var provider = manifest.Id == TelegramSessionLease.ClientAppId;
        if (!provider && !manifest.Permissions.Contains(TelegramAccess.Permission)) return;

        var lease = new TelegramSessionLease(MiniStore.PrivateRoot);
        var telegram = new TelegramFunctions(lease, view, ownerWindow);
        functions.Lifetime = telegram;
        var cloud = manifest.Id == TelegramCloudState.AppId;
        var access = provider ? null : new TelegramAccess(storage,
            cloud ? TelegramCloudState.GrantKey : TelegramAccess.ConsumerGrantKey,
            cloud ? "Облако файлов" : $"{manifest.Name} ({manifest.Id})");

        if (access is not null)
        {
            functions.Handlers.Add("telegram.connect", async parameters =>
            {
                await requireUserGesture();
                return await telegram.Connect(access, permissions, parameters["reauthenticate"]?.GetValue<bool>() == true);
            });
            functions.Register("telegram.restoreSaved", _ => permissions.StateFor(TelegramAccess.Permission) == "denied"
                ? null : access.Use(ownerWindow(), interactive: false));
            if (cloud) TelegramCloudFunctions.Register(functions, storage, access);
        }
        if (provider)
        {
            var sharedSignIn = launchReason == TelegramAccess.LoginReason;
            functions.BeforeLogWrite = () =>
            {
                if (TelegramSettings.Read()["writeLoginLog"]?.GetValue<bool>() != true)
                    throw new ApiError("telegram_log_disabled", "Telegram login logging is disabled");
            };
            functions.Register("telegram.getSettings", _ => TelegramSettings.Read(sharedSignIn));
            functions.Register("telegram.getAppCredentials", _ => TelegramPackage.ReadAppCredentials());
            functions.Register("telegram.setCodeCaptureProtection",
                parameters => telegram.SetCodeCaptureProtection(parameters["enabled"]?.GetValue<bool>() == true));
            if (sharedSignIn && completeLaunch is not null)
            {
                functions.Register("telegram.finishSignIn", _ =>
                {
                    if (storage.Get("telegram.session.v1") is not JsonObject)
                        throw new ApiError("telegram_session_unavailable", "Save the Telegram session before returning");
                    view.BeginInvoke(completeLaunch);
                    return null;
                });
            }
            else if (!sharedSignIn)
                functions.Register("telegram.acquireTest", parameters => JsonValue.Create(lease.Acquire(LeaseOwner(parameters), true)));
        }

        long UpdateStreamWait(long until)
        {
            if (functions.EnableStreams) streams.SetWaitUntil(until);
            return until;
        }

        functions.Register("telegram.acquire", parameters =>
        {
            if (access is not null && (permissions.StateFor(TelegramAccess.Permission) == "denied" || !access.HasApproval()))
                throw new ApiError("telegram_session_unavailable", "Connect to the shared Telegram account first");
            return JsonValue.Create(UpdateStreamWait(lease.Acquire(LeaseOwner(parameters), false)));
        });
        functions.Register("telegram.setWaitUntil", parameters => JsonValue.Create(
            UpdateStreamWait(lease.SetWaitUntil(LeaseOwner(parameters), parameters["until"]?.GetValue<long>() ?? -1))));
        functions.Register("telegram.release", parameters =>
        {
            lease.Release(LeaseOwner(parameters));
            UpdateStreamWait(0);
            return null;
        });
        if (provider || cloud) functions.Register("telegram.serviceNotices", telegram.TelegramServiceNotices);
    }

    private async ValueTask<JsonNode?> Connect(TelegramAccess access, PermissionStore permissions, bool reauthenticate)
    {
        if (signingIn) throw new ApiError("operation_in_progress", "Telegram sign-in is already open");
        signingIn = true;
        try
        {
            // Leave the WebView message callback before showing a modal window.
            await Task.Yield();
            if (view.IsDisposed) return null;
            if (permissions.StateFor(TelegramAccess.Permission) == "denied")
                throw new ApiError("permission_denied", "Enable Telegram access in the mini-app permissions");
            if (!access.HasSaved() || reauthenticate)
            {
                var provider = MiniStore.Apps().FirstOrDefault(app => app.Manifest.Id == TelegramSessionLease.ClientAppId);
                if (provider.Manifest is null)
                    throw new ApiError("telegram_package_missing", "Install Telegram from the launcher");
                using var window = new MiniAppWindow(provider.Manifest, provider.Directory, TelegramAccess.LoginReason);
                if (window.ShowDialog(ownerWindow()) != DialogResult.OK)
                    throw new ApiError("operation_cancelled", "Telegram sign-in was cancelled");
            }
            if (view.IsDisposed) return null;
            var record = access.Use(ownerWindow(), interactive: true);
            if (record is not null) permissions.Set(TelegramAccess.Permission, "granted");
            return record;
        }
        finally { signingIn = false; }
    }

    private static string LeaseOwner(JsonObject parameters) => parameters["owner"]?.GetValue<string>() ?? "";

    private JsonNode TelegramServiceNotices(JsonObject parameters)
    {
        lease.RequireOwner(LeaseOwner(parameters));
        var accountId = parameters["accountId"]?.GetValue<string>() ?? "";
        if (accountId.Length is < 1 or > 20 || accountId.Any(c => c < '0' || c > '9'))
            throw new ApiError("invalid_params", "Invalid Telegram account ID");
        var storage = new SecureStorageStore(TelegramSessionLease.ClientAppId);
        var key = (lease.TestServers ? "runtime.telegram.test.notices." : "runtime.telegram.notices.") + accountId;
        var notices = storage.Get(key) as JsonArray ?? new JsonArray();
        if (parameters["notice"] is not JsonObject notice) return notices;
        var text = notice["text"]?.GetValue<string>() ?? "";
        var type = notice["type"]?.GetValue<string>() ?? "";
        var date = notice["date"]?.GetValue<long>() ?? 0;
        if (text.Length is < 1 or > 4096 || type.Length > 128 || date < 1)
            throw new ApiError("invalid_params", "Invalid Telegram notice");
        notices.Add(new JsonObject { ["text"] = text, ["type"] = type, ["date"] = date });
        while (notices.Count > 64) notices.RemoveAt(0);
        storage.Set(key, notices);
        return notices;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);

    private JsonNode? SetCodeCaptureProtection(bool enabled)
    {
        if (!enabled)
        {
            RestoreCodeCapture();
            return null;
        }

        if (captureProtectedWindow != IntPtr.Zero) return null;
        var form = view.FindForm();
        if (form is null || !SetWindowDisplayAffinity(form.Handle, 0x11))
            throw new ApiError("telegram_capture_protection_failed", "Windows could not protect the Telegram service chat");
        captureProtectedWindow = form.Handle;
        return null;
    }

    private void RestoreCodeCapture()
    {
        if (captureProtectedWindow == IntPtr.Zero) return;
        SetWindowDisplayAffinity(captureProtectedWindow, 0);
        captureProtectedWindow = IntPtr.Zero;
    }

    public void Dispose()
    {
        try { lease.Dispose(); }
        finally { RestoreCodeCapture(); }
    }
}
