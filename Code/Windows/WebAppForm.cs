using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.Drawing.Drawing2D;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MiniAppRuntime.Windows;

internal sealed class WebAppView : UserControl
{
    private readonly MiniManifest manifest;
    private readonly string directory;
    private readonly WebView2 web = new() { Dock = DockStyle.Fill };
    private readonly NativeTopBar topBar = new() { Dock = DockStyle.Top, Visible = false };
    private readonly PermissionStore permissions;
    private readonly SecureStorageStore secureStorage;
    private readonly Dictionary<string, string> files = [];
    private readonly Dictionary<string, string> directories = [];
    private readonly Dictionary<string, RuntimeTimer> timers = [];
    private readonly object timersLock = new();
    private readonly object storageLock = new();
    private readonly Action onExit;
    private readonly WindowsFileSaveService fileSave = new(new WinFormsFileSaveDialog());
    private WindowsShareService? share;
    private bool backInProgress;
    private long lastUserGestureAt;
    private string? lastNetworkState;

    public WebAppView(MiniManifest manifest, string directory, Action onExit)
    {
        this.manifest = manifest; this.directory = directory; this.onExit = onExit;
        permissions = new PermissionStore(manifest.Id, manifest.Name);
        secureStorage = new SecureStorageStore(manifest.Id);
        Controls.Add(web); Controls.Add(topBar);
        topBar.Apply(TopBarConfiguration.Default(manifest.Name));
        topBar.BackRequested += RequestBack;
        web.PreviewKeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) { RequestBack(); e.IsInputKey = true; } };
        web.MouseDown += (_, _) => lastUserGestureAt = Environment.TickCount64;
        web.KeyDown += (_, _) => lastUserGestureAt = Environment.TickCount64;
        lastNetworkState = NetworkStatus().ToJsonString();
        System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged += NetworkChanged;
        topBar.ActionRequested += NotifyTopBarAction;
        Disposed += (_, _) => { System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged -= NetworkChanged; ClearTimers(); share?.Dispose(); };
        Load += (_, _) => SetWindowTitle(manifest.Name);
        Load += async (_, _) => await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            if (manifest.MinRuntimeVersion is not null && SemanticVersion.Compare("1.4.0", manifest.MinRuntimeVersion) < 0)
            {
                MessageBox.Show(FindForm(), $"Runtime 1.4.0 is older than required {manifest.MinRuntimeVersion}.", "Mini App Runtime", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                onExit(); return;
            }
            await web.EnsureCoreWebView2Async(await MiniStore.GetWebViewEnvironmentAsync());
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            // Each WebView sees only its own mini-app directory, matching Android's miniapp://<id>/ isolation.
            web.CoreWebView2.SetVirtualHostNameToFolderMapping("miniapp.local", directory, CoreWebView2HostResourceAccessKind.DenyCors);
            web.CoreWebView2.SetVirtualHostNameToFolderMapping("interface.local", MiniStore.ActiveLauncherInterfaceRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            var runtime = await File.ReadAllTextAsync(Path.Combine(MiniStore.ResourceRoot, "runtime.js"));
            await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(runtime);
            await web.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.addEventListener('DOMContentLoaded',()=>{const css=document.createElement('link');css.rel='stylesheet';css.href='https://interface.local/appbar.css';document.head.append(css);const script=document.createElement('script');script.src='https://interface.local/appbar.js';document.head.append(script);});");
            web.CoreWebView2.WebMessageReceived += (_, e) => HandleMessage(e.TryGetWebMessageAsString());
            web.CoreWebView2.NavigationStarting += (_, e) =>
            {
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && uri.Host != "miniapp.local") { e.Cancel = true; System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.ToString()) { UseShellExecute = true }); }
            };
            web.CoreWebView2.Navigate($"https://miniapp.local/{manifest.Entry}");
        }
        catch (Exception error) { MessageBox.Show(FindForm(), "Не удалось запустить WebView2. Установите Microsoft Edge WebView2 Runtime.\n\n" + error.Message, "Mini App Runtime", MessageBoxButtons.OK, MessageBoxIcon.Error); onExit(); }
    }

    private void HandleMessage(string raw)
    {
        JsonObject? request;
        try { request = JsonNode.Parse(raw)?.AsObject(); } catch { return; }
        var id = request?["id"]?.GetValue<string>() ?? "";
        try
        {
            var method = request?["method"]?.GetValue<string>() ?? throw new ApiError("invalid_request", "method is required");
            var parameters = request?["params"]?.AsObject() ?? new JsonObject();
            if (method.StartsWith("notifications.") || method is "haptics.impact" or "haptics.selection" or "haptics.notification") throw new ApiError("feature_unavailable", "Feature is unavailable on this platform");
            if (method == "permissions.request" || method is "files.pick" or "files.pickMultiple" or "files.pickDirectory" or "clipboard.readText" or "system.openUrl" or "system.openFile" or "system.openSettings") RequireUserGesture();
            if (method == "permissions.request") { Respond(id, true, RequestPermission(parameters), null, null); return; }
            var permission = PermissionFor(method);
            if (permission is not null) RequirePermission(permission);
            if (method == "network.request") { _ = NetworkRequestAsync(id, parameters); return; }
            JsonNode? result = method switch
            {
                "app.getInfo" => new JsonObject { ["id"] = manifest.Id, ["name"] = manifest.Name, ["version"] = manifest.Version, ["sdkVersion"] = manifest.SdkVersion },
                "app.getAppInfo" => MiniStore.AppInfo(manifest, directory),
                "app.getRuntimeVersion" => "1.4.0",
                "app.getLaunchParams" => new JsonObject { ["reason"] = "normal" },
                "runtime.getCapabilities" => Capabilities(),
                "runtime.supports" => Supported(parameters),
                "navigation.setBackEnabled" => SetBackEnabled(parameters),
                "navigation.getState" => new JsonObject { ["backEnabled"] = backEnabled },
                "permissions.query" => PermissionState(parameters),
                "permissions.openSettings" => OpenPermissionSettings(),
                "secureStorage.get" => secureStorage.Get(Key(parameters)),
                "secureStorage.set" => secureStorage.Set(Key(parameters), parameters["value"]),
                "secureStorage.remove" => secureStorage.Remove(Key(parameters)),
                "secureStorage.keys" => secureStorage.Keys(),
                "secureStorage.clear" => secureStorage.Clear(),
                "app.setWindowTitle" => SetWindowTitle(parameters),
                "app.close" => CloseApp(),
                "ui.setTopBar" => SetTopBar(parameters),
                "storage.get" => Storage(parameters, StorageOperation.Get),
                "storage.getMany" => StorageGetMany(parameters),
                "storage.set" => Storage(parameters, StorageOperation.Set),
                "storage.setMany" => StorageSetMany(parameters),
                "storage.remove" => Storage(parameters, StorageOperation.Remove),
                "storage.clear" => Storage(parameters, StorageOperation.Clear),
                "storage.keys" => Storage(parameters, StorageOperation.Keys),
                "storage.getSchemaVersion" => StorageSchema(parameters),
                "storage.setSchemaVersion" => StorageSetSchema(parameters),
                "storage.getUsage" => StorageUsage(parameters),
                "storage.transaction" => StorageTransaction(parameters),
                "device.getInfo" => new JsonObject { ["platform"] = "windows", ["windowsVersion"] = Environment.OSVersion.VersionString, ["appVersion"] = "1.0.0", ["locale"] = System.Globalization.CultureInfo.CurrentUICulture.Name, ["screenWidth"] = Screen.FromControl(this).Bounds.Width, ["screenHeight"] = Screen.FromControl(this).Bounds.Height, ["isDarkTheme"] = false },
                "clipboard.write" => WriteClipboard(parameters),
                "clipboard.readText" => ReadClipboard(),
                "clipboard.getAvailableFormats" => ClipboardFormats(),
                "files.pick" => PickFile(),
                "files.pickMultiple" => PickFiles(),
                "files.getInfo" => FileInfo(parameters),
                "files.readText" => ReadFile(parameters, false),
                "files.readBase64" => ReadFile(parameters, true),
                "files.readChunk" => ReadChunk(parameters, false),
                "files.readTextChunk" => ReadChunk(parameters, true),
                "files.release" => ReleaseFile(parameters),
                "files.releaseMany" => ReleaseFiles(parameters),
                "files.pickDirectory" => PickDirectory(),
                "files.listDirectory" => ListDirectory(parameters),
                "files.openInDirectory" => DirectoryFile(parameters, false),
                "files.createInDirectory" => DirectoryFile(parameters, true),
                "files.writeChunk" => WriteChunk(parameters),
                "files.flush" => null,
                "files.persistDirectory" => PersistDirectory(parameters),
                "files.restoreDirectory" => RestoreDirectory(parameters),
                "files.forgetDirectory" => ForgetDirectory(parameters),
                "files.saveText" => fileSave.Save(OwnerWindow(), FileShareRequestValidator.SaveText(parameters)),
                "files.saveBase64" => fileSave.Save(OwnerWindow(), FileShareRequestValidator.SaveBase64(parameters)),
                "share.text" => ShareText(parameters),
                "share.file" => ShareFile(parameters, id),
                "timer.create" => CreateTimer(parameters),
                "timer.pause" => PauseTimer(parameters),
                "timer.resume" => ResumeTimer(parameters),
                "timer.cancel" => CancelTimer(parameters),
                "timer.get" => GetTimer(parameters),
                "timer.list" => ListTimers(),
                "ui.alert" => NativeAlert(parameters),
                "ui.confirm" => NativeConfirm(parameters),
                "ui.prompt" => NativePrompt(parameters),
                "ui.toast" => NativeToast(parameters),
                "system.canOpenUrl" => CanOpenUrl(parameters),
                "system.openUrl" => OpenUrl(parameters),
                "system.openFile" => OpenFile(parameters),
                "system.openSettings" => OpenSettings(parameters),
                "network.getStatus" => NetworkStatus(),
                _ => throw new ApiError("method_not_found", "Unknown method")
            };
            Respond(id, true, result, null, null);
        }
        catch (ApiError error) { Respond(id, false, null, error.Code, error.Message); }
        catch (Exception) { Respond(id, false, null, "internal_error", "Operation failed"); }
    }

    private JsonNode? CloseApp() { BeginInvoke(onExit); return null; }
    private void RequireUserGesture()
    {
        if (Environment.TickCount64 - lastUserGestureAt > 1_000) throw new ApiError("user_gesture_required", "A recent user gesture is required");
    }
    private JsonObject NetworkStatus() => new() { ["online"] = System.Net.NetworkInformation.NetworkInterface.GetIsNetworkAvailable(), ["type"] = "unknown", ["metered"] = false };
    private void NetworkChanged(object? sender, EventArgs args)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(() => { var state = NetworkStatus(); var serialized = state.ToJsonString(); if (serialized == lastNetworkState) return; lastNetworkState = serialized; Emit("network.statusChanged", state); }); }
        catch (InvalidOperationException) { }
    }
    private bool backEnabled = true;
    private JsonNode Capabilities() => new JsonObject
    {
        ["runtimeVersion"] = "1.4.0", ["sdkVersion"] = 2, ["platform"] = "windows",
        ["methods"] = new JsonArray("app.getInfo", "app.getAppInfo", "app.getLaunchParams", "storage.get", "storage.set", "storage.getMany", "storage.setMany", "storage.transaction", "navigation.setBackEnabled", "navigation.getState", "runtime.getCapabilities", "runtime.supports", "permissions.query", "permissions.request", "permissions.openSettings", "secureStorage.get", "secureStorage.set", "secureStorage.remove", "secureStorage.keys", "secureStorage.clear", "network.getStatus", "network.request", "clipboard.readText", "clipboard.getAvailableFormats", "files.pickMultiple", "files.getInfo", "files.readChunk", "files.readTextChunk", "files.releaseMany", "files.pickDirectory", "files.listDirectory", "files.openInDirectory", "files.createInDirectory", "files.writeChunk", "files.flush", "files.persistDirectory", "files.restoreDirectory", "files.forgetDirectory", "ui.alert", "ui.confirm", "ui.prompt", "ui.toast", "system.canOpenUrl", "system.openUrl", "system.openFile", "system.openSettings"),
        ["features"] = new JsonObject { ["navigation.backRequested"] = true, ["storage.transactions"] = true, ["backup.restore"] = false, ["secureStorage"] = true, ["network.request"] = true, ["network.statusChanged"] = true, ["notifications.schedule"] = false, ["files.readChunk"] = true, ["files.pickMultiple"] = true, ["files.directory"] = true, ["clipboard.readText"] = true, ["ui.nativeDialogs"] = true, ["haptics"] = false, ["system.openUrl"] = true },
        ["limits"] = new JsonObject { ["storageBytes"] = 5 * 1024 * 1024, ["fileWriteBytes"] = 10 * 1024 * 1024, ["shareFileBytes"] = 10 * 1024 * 1024, ["networkRequestBytes"] = NetworkRequestValidator.MaxRequestBytes, ["networkResponseBytes"] = NetworkRequestValidator.MaxResponseBytes, ["networkRedirects"] = 5 }
    };
    private JsonNode Supported(JsonObject parameters)
    {
        var name = parameters["name"]?.GetValue<string>() ?? "";
        return Capabilities()["methods"]!.AsArray().Any(item => item?.GetValue<string>() == name) || Capabilities()["features"]?[name]?.GetValue<bool>() == true;
    }
    private async Task NetworkRequestAsync(string id, JsonObject parameters)
    {
        try { var result = await NetworkRequestValidator.RequestAsync(manifest.Network, parameters); if (!IsDisposed) BeginInvoke(() => Respond(id, true, result, null, null)); }
        catch (ApiError error) { if (!IsDisposed) BeginInvoke(() => Respond(id, false, null, error.Code, error.Message)); }
        catch { if (!IsDisposed) BeginInvoke(() => Respond(id, false, null, "network_request_failed", "Request failed")); }
    }
    private JsonNode SetBackEnabled(JsonObject parameters) { backEnabled = parameters["enabled"]?.GetValue<bool>() != false; return new JsonObject { ["backEnabled"] = backEnabled }; }
    private async void RequestBack()
    {
        if (backInProgress || IsDisposed) return;
        backInProgress = true;
        if (!backEnabled) { BeginInvoke(onExit); backInProgress = false; return; }
        try
        {
            var backTask = web.CoreWebView2!.ExecuteScriptAsync("window.__miniRuntimeBackRequested&&window.__miniRuntimeBackRequested()");
            var completed = await Task.WhenAny(backTask, Task.Delay(350));
            if (completed != backTask) { BeginInvoke(onExit); return; }
            var handled = await backTask;
            if (!string.Equals(handled, "true", StringComparison.OrdinalIgnoreCase)) BeginInvoke(onExit);
        }
        catch { BeginInvoke(onExit); }
        finally { backInProgress = false; }
    }
    private IWin32Window OwnerWindow() => FindForm() is Form form ? form : this;
    private JsonNode PermissionState(JsonObject parameters)
    {
        var permission = parameters["permission"]?.GetValue<string>() ?? "";
        return !manifest.Permissions.Contains(permission) ? "not_declared" : permissions.State(permission);
    }
    private JsonNode RequestPermission(JsonObject parameters)
    {
        var permission = parameters["permission"]?.GetValue<string>() ?? "";
        if (!manifest.Permissions.Contains(permission)) throw new ApiError("permission_not_declared", "Permission is not declared");
        if (permissions.State(permission) == "granted") return "granted";
        var allowed = MessageBox.Show(OwnerWindow(), $"{manifest.Name} requests: {permission}", "Mini App permission", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes;
        permissions.Set(permission, allowed ? "granted" : "denied");
        Emit("permissions.changed", new JsonObject { ["permission"] = permission, ["state"] = allowed ? "granted" : "denied" });
        return allowed ? "granted" : "denied";
    }
    private JsonNode? OpenPermissionSettings()
    {
        var labels = manifest.Permissions.Order().ToArray();
        if (labels.Length == 0) return null;
        var selected = MessageBox.Show(OwnerWindow(), "Permission settings are managed in the launcher. Reset all decisions?", manifest.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
        if (selected == DialogResult.Yes) permissions.Reset();
        return null;
    }
    private void Emit(string name, JsonNode payload) => web.CoreWebView2?.ExecuteScriptAsync($"window.__miniRuntimeEvent&&window.__miniRuntimeEvent({JsonSerializer.Serialize(name)},{payload.ToJsonString()});");
    private WindowsShareService Share() => share ??= new WindowsShareService(OwnerWindow(), manifest.Id);
    private JsonNode? ShareText(JsonObject parameters) { Share().Show(FileShareRequestValidator.ShareText(parameters)); return null; }
    private JsonNode? ShareFile(JsonObject parameters, string id) { Share().Show(FileShareRequestValidator.ShareFile(parameters), id); return null; }
    private JsonNode? SetWindowTitle(JsonObject parameters)
    {
        var title = parameters["title"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrEmpty(title)) throw new ApiError("invalid_params", "title is required");
        title = title[..Math.Min(title.Length, 255)];
        BeginInvoke(() =>
        {
            var form = FindForm();
            if (form is not null) form.Text = title;
        });
        return null;
    }
    private void SetWindowTitle(string title)
    {
        var form = FindForm();
        if (form is not null) form.Text = title;
    }
    private JsonNode? SetTopBar(JsonObject parameters)
    {
        var configuration = TopBarConfiguration.From(parameters);
        BeginInvoke(() => topBar.Apply(configuration));
        return null;
    }
    private void NotifyTopBarAction(string actionId)
    {
        var script = $"window.__miniRuntimeEvent&&window.__miniRuntimeEvent('ui.topBarAction',{JsonSerializer.Serialize(actionId)});";
        web.CoreWebView2?.ExecuteScriptAsync(script);
    }
    private JsonNode? WriteClipboard(JsonObject p) { Clipboard.SetText(p["text"]?.GetValue<string>() ?? ""); return null; }
    private JsonNode? PickFile()
    {
        using var dialog = new OpenFileDialog { Title = "Выберите файл" };
        if (dialog.ShowDialog(this) != DialogResult.OK) throw new ApiError("file_not_found", "No file selected");
        var info = new FileInfo(dialog.FileName); var id = "runtime-file-" + Guid.NewGuid().ToString("N"); files[id] = dialog.FileName;
        return new JsonObject { ["id"] = id, ["name"] = info.Name, ["mimeType"] = "application/octet-stream", ["size"] = info.Length };
    }
    private JsonNode PickFiles()
    {
        using var dialog = new OpenFileDialog { Title = "Select files", Multiselect = true };
        if (dialog.ShowDialog(this) != DialogResult.OK || dialog.FileNames.Length == 0) throw new ApiError("operation_cancelled", "File selection was cancelled");
        var result = new JsonArray();
        foreach (var path in dialog.FileNames)
        {
            var info = new FileInfo(path); var id = "runtime-file-" + Guid.NewGuid().ToString("N"); files[id] = path;
            result.Add(new JsonObject { ["id"] = id, ["name"] = info.Name, ["mimeType"] = "application/octet-stream", ["size"] = info.Length });
        }
        return result;
    }
    private JsonNode FileInfo(JsonObject p)
    {
        var path = FileFor(p); var info = new FileInfo(path);
        return new JsonObject { ["id"] = Key(p), ["name"] = info.Name, ["mimeType"] = "application/octet-stream", ["size"] = info.Length };
    }
    private JsonNode? ReadFile(JsonObject p, bool base64)
    {
        var path = FileFor(p); var info = new FileInfo(path); if (info.Length > 10 * 1024 * 1024) throw new ApiError("file_too_large", "File is too large");
        return base64 ? Convert.ToBase64String(File.ReadAllBytes(path)) : File.ReadAllText(path, Encoding.UTF8);
    }
    private JsonNode ReadChunk(JsonObject p, bool text)
    {
        var offset = p["offset"]?.GetValue<long>() ?? -1; var length = p["length"]?.GetValue<int>() ?? -1;
        if (offset < 0 || length is < 1 or > 1024 * 1024) throw new ApiError("invalid_params", "Invalid chunk range");
        var path = FileFor(p); var info = new FileInfo(path); if (offset > info.Length) throw new ApiError("invalid_params", "Offset is outside the file");
        using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read); input.Position = offset; var buffer = new byte[length]; var total = 0; while (total < length) { var read = input.Read(buffer, total, length - total); if (read == 0) break; total += read; }
        var bytes = total == buffer.Length ? buffer : buffer[..total];
        return new JsonObject { ["offset"] = offset, ["length"] = total, ["eof"] = offset + total >= info.Length, ["data"] = text ? Encoding.UTF8.GetString(bytes) : Convert.ToBase64String(bytes) };
    }
    private JsonNode? ReleaseFile(JsonObject p) { files.Remove(Key(p)); return null; }
    private JsonNode? ReleaseFiles(JsonObject p) { foreach (var item in p["ids"]?.AsArray() ?? []) if (item?.GetValue<string>() is { Length: > 0 } id) files.Remove(id); return null; }
    private JsonNode PickDirectory()
    {
        using var dialog = new FolderBrowserDialog { Description = "Select directory", UseDescriptionForTitle = true };
        if (dialog.ShowDialog(OwnerWindow()) != DialogResult.OK) throw new ApiError("operation_cancelled", "Directory selection was cancelled");
        var id = "runtime-directory-" + Guid.NewGuid().ToString("N"); directories[id] = Path.GetFullPath(dialog.SelectedPath);
        return new JsonObject { ["id"] = id, ["name"] = new DirectoryInfo(dialog.SelectedPath).Name };
    }
    private JsonNode ListDirectory(JsonObject p)
    {
        var root = DirectoryFor(p); var limit = Math.Clamp(p["limit"]?.GetValue<int>() ?? 100, 1, 200); var entries = new JsonArray();
        foreach (var path in Directory.EnumerateFileSystemEntries(root).Take(limit)) { var directory = Directory.Exists(path); var name = Path.GetFileName(path); var node = new JsonObject { ["name"] = name, ["directory"] = directory, ["mimeType"] = directory ? "inode/directory" : "application/octet-stream", ["size"] = directory ? 0 : new FileInfo(path).Length }; if (directory) { var id="runtime-directory-"+Guid.NewGuid().ToString("N");directories[id]=path;node["id"]=id; } else { var id="runtime-file-"+Guid.NewGuid().ToString("N");files[id]=path;node["id"]=id; } entries.Add(node); }
        return new JsonObject { ["entries"] = entries, ["nextCursor"] = null };
    }
    private JsonNode DirectoryFile(JsonObject p, bool create)
    {
        var root = DirectoryFor(p); var relative = Relative(p["path"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "path is required")); var path = Path.GetFullPath(Path.Combine(root, relative)); if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ApiError("invalid_params", "Invalid relative path");
        if (create) { Directory.CreateDirectory(Path.GetDirectoryName(path)!); if (File.Exists(path) && p["overwrite"]?.GetValue<bool>() != true) throw new ApiError("file_exists", "File already exists"); using var _ = File.Create(path); } else if (!File.Exists(path)) throw new ApiError("file_not_found", "File not found");
        var id = "runtime-file-" + Guid.NewGuid().ToString("N"); files[id] = path; return FileInfo(new JsonObject { ["id"] = id });
    }
    private JsonNode? WriteChunk(JsonObject p)
    {
        var data = p["data"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "data is required"); byte[] bytes; try { bytes = Convert.FromBase64String(data); } catch { throw new ApiError("invalid_params", "Invalid base64"); } if (bytes.Length > 1024 * 1024) throw new ApiError("file_too_large", "Chunk is too large"); using var stream = new FileStream(FileFor(p), FileMode.Append, FileAccess.Write, FileShare.None); stream.Write(bytes); stream.Flush(true); return null;
    }
    private JsonNode? PersistDirectory(JsonObject p) { var name=Relative(p["name"]?.GetValue<string>() ?? throw new ApiError("invalid_params","name is required")); var saved=DirectoryStore();saved[name]=DirectoryFor(p);SaveDirectoryStore(saved);return null; }
    private JsonNode? RestoreDirectory(JsonObject p) { var name=Relative(p["name"]?.GetValue<string>() ?? throw new ApiError("invalid_params","name is required"));var path=DirectoryStore()[name]?.GetValue<string>();if(path is null||!Directory.Exists(path))return null;var id="runtime-directory-"+Guid.NewGuid().ToString("N");directories[id]=path;return new JsonObject{{"id",id},{"name",name}}; }
    private JsonNode? ForgetDirectory(JsonObject p) { var name=Relative(p["name"]?.GetValue<string>() ?? throw new ApiError("invalid_params","name is required"));var saved=DirectoryStore();saved.Remove(name);SaveDirectoryStore(saved);return null; }
    private string DirectoryFor(JsonObject p) => directories.TryGetValue(Key(p), out var path) ? path : throw new ApiError("directory_not_found", "Directory handle not found");
    private static string Relative(string value) { if (string.IsNullOrWhiteSpace(value) || Path.IsPathRooted(value) || value.IndexOfAny(['/', '\\', '\0']) >= 0 || value is "." or ".." || value.Split('/').Any(x => x is "." or ".." or "")) throw new ApiError("invalid_params", "Invalid relative path"); return value; }
    private string DirectoryStorePath => Path.Combine(MiniStore.DataRoot, "directories", Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(manifest.Id))) + ".json");
    private JsonObject DirectoryStore() { try { return File.Exists(DirectoryStorePath) ? JsonNode.Parse(File.ReadAllText(DirectoryStorePath))?.AsObject() ?? new JsonObject() : new JsonObject(); } catch { return new JsonObject(); } }
    private void SaveDirectoryStore(JsonObject data) { Directory.CreateDirectory(Path.GetDirectoryName(DirectoryStorePath)!); File.WriteAllText(DirectoryStorePath, data.ToJsonString()); }
    private JsonNode CreateTimer(JsonObject parameters)
    {
        var interval = parameters["intervalMs"]?.GetValue<int>() ?? throw new ApiError("invalid_params", "intervalMs is required");
        if (interval is < 10 or > 86_400_000) throw new ApiError("invalid_params", "intervalMs must be between 10 and 86400000");
        var timer = new RuntimeTimer("timer-" + Guid.NewGuid().ToString("N"), interval, parameters["repeat"]?.GetValue<bool>() != false);
        timer.Timer = new System.Threading.Timer(_ => FireTimer(timer.Id), null, interval, timer.Repeat ? interval : Timeout.Infinite);
        lock (timersLock) timers[timer.Id] = timer;
        return TimerInfo(timer);
    }
    private JsonNode? PauseTimer(JsonObject parameters)
    {
        var timer = TimerFor(parameters); if (!timer.Running) return TimerInfo(timer);
        timer.Running = false; timer.Timer!.Change(Timeout.Infinite, Timeout.Infinite); return TimerInfo(timer);
    }
    private JsonNode? ResumeTimer(JsonObject parameters)
    {
        var timer = TimerFor(parameters); if (timer.Running) return TimerInfo(timer);
        timer.Running = true; timer.Timer!.Change(timer.Interval, timer.Repeat ? timer.Interval : Timeout.Infinite); return TimerInfo(timer);
    }
    private JsonNode? CancelTimer(JsonObject parameters)
    {
        RuntimeTimer timer; lock (timersLock) { timer = TimerFor(parameters); timers.Remove(timer.Id); }
        timer.Timer?.Dispose(); return null;
    }
    private JsonNode? GetTimer(JsonObject parameters) => TimerInfo(TimerFor(parameters));
    private JsonNode? ListTimers() { lock (timersLock) return new JsonArray(timers.Values.Select(TimerInfo).ToArray()); }
    private RuntimeTimer TimerFor(JsonObject parameters)
    {
        var id = parameters["id"]?.GetValue<string>();
        lock (timersLock) return !string.IsNullOrWhiteSpace(id) && timers.TryGetValue(id, out var timer) ? timer : throw new ApiError("timer_not_found", "Timer not found");
    }
    private static JsonObject TimerInfo(RuntimeTimer timer) => new() { ["id"] = timer.Id, ["intervalMs"] = timer.Interval, ["repeat"] = timer.Repeat, ["state"] = timer.Running ? "running" : "paused" };
    private void FireTimer(string id)
    {
        RuntimeTimer? timer; lock (timersLock)
        {
            if (!timers.TryGetValue(id, out timer) || !timer.Running) return;
            if (!timer.Repeat) { timers.Remove(id); timer.Running = false; }
        }
        try { if (!IsDisposed && IsHandleCreated) BeginInvoke(() => DispatchTimerEvent(id)); } catch (InvalidOperationException) { }
        if (!timer.Repeat) timer.Timer?.Dispose();
    }
    private void DispatchTimerEvent(string id) => web.CoreWebView2?.ExecuteScriptAsync($"window.dispatchEvent(new CustomEvent('mini.runtimeTimer',{{detail:{{id:{JsonSerializer.Serialize(id)}}}}}));");
    private void ClearTimers()
    {
        RuntimeTimer[] active; lock (timersLock) { active = timers.Values.ToArray(); timers.Clear(); }
        foreach (var timer in active) timer.Timer?.Dispose();
    }
    private string FileFor(JsonObject p) => files.TryGetValue(Key(p), out var path) ? path : throw new ApiError("file_not_found", "File handle not found");
    private static string Key(JsonObject p) => p["key"]?.GetValue<string>() ?? p["id"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "key is required");

    private enum StorageOperation { Get, Set, Remove, Clear, Keys }
    private JsonNode? Storage(JsonObject p, StorageOperation operation)
    {
        lock (storageLock)
        {
            var path = StoragePath(p); var data = ReadStorage(path); var key = operation is StorageOperation.Clear or StorageOperation.Keys ? "" : Key(p);
            switch (operation)
            {
                case StorageOperation.Get: return data[key]?.DeepClone();
                case StorageOperation.Set: data[key] = p["value"]?.DeepClone(); Save(path, data); return null;
                case StorageOperation.Remove: data.Remove(key); Save(path, data); return null;
                case StorageOperation.Clear: Save(path, new JsonObject()); return null;
                case StorageOperation.Keys: return new JsonArray(data.Where(x => x.Key != "__mini_schema_version").Select(x => (JsonNode?)x.Key).ToArray());
                default: return null;
            }
        }
    }
    private string StoragePath(JsonObject p) => p["public"]?.GetValue<bool>() == true || p["scope"]?.GetValue<string>() == "public" ? Path.Combine(directory, "storage.json") : Path.Combine(MiniStore.PrivateRoot, manifest.Id + ".json");
    private static JsonObject ReadStorage(string path)
    {
        if (!File.Exists(path)) return new JsonObject();
        try { return JsonNode.Parse(File.ReadAllText(path))?.AsObject() ?? new JsonObject(); }
        catch { var backup = path + ".bak"; try { var data = JsonNode.Parse(File.ReadAllText(backup))?.AsObject() ?? throw new InvalidDataException(); Save(path, data, false); return data; } catch { throw new ApiError("storage_corrupted", "Storage data is corrupted"); } }
    }
    private static void Save(string path, JsonObject data, bool backup = true) { var raw = data.ToJsonString(new JsonSerializerOptions { WriteIndented = true }); if (Encoding.UTF8.GetByteCount(raw) > 5 * 1024 * 1024) throw new ApiError("storage_limit_exceeded", "Storage limit exceeded"); Directory.CreateDirectory(Path.GetDirectoryName(path)!); var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp"; try { File.WriteAllText(temp, raw, Encoding.UTF8); using (var stream = new FileStream(temp, FileMode.Open, FileAccess.Read, FileShare.Read)) stream.Flush(true); if (backup && File.Exists(path)) File.Copy(path, path + ".bak", true); File.Move(temp, path, true); } finally { if (File.Exists(temp)) File.Delete(temp); } }
    private JsonNode StorageGetMany(JsonObject p) { lock (storageLock) { var data=ReadStorage(StoragePath(p)); var output=new JsonObject(); foreach(var key in p["keys"]?.AsArray() ?? []) if(key?.GetValue<string>() is { Length: > 0 } name && data[name] is { } value) output[name]=value.DeepClone(); return output; } }
    private JsonNode? StorageSetMany(JsonObject p) { lock(storageLock) { var path=StoragePath(p); var data=ReadStorage(path); foreach(var item in p["values"]?.AsObject() ?? []) data[item.Key]=item.Value?.DeepClone(); Save(path,data); return null; } }
    private JsonNode StorageSchema(JsonObject p) { lock(storageLock) return ReadStorage(StoragePath(p))["__mini_schema_version"]?.GetValue<int>() ?? 0; }
    private JsonNode? StorageSetSchema(JsonObject p) { var version=p["value"]?.GetValue<int>() ?? -1; if(version<0) throw new ApiError("invalid_params","schema version must be non-negative"); lock(storageLock){var path=StoragePath(p);var data=ReadStorage(path);data["__mini_schema_version"]=version;Save(path,data);return null;} }
    private JsonNode StorageUsage(JsonObject p) { lock(storageLock){var path=StoragePath(p);return new JsonObject { ["usedBytes"] = File.Exists(path) ? new FileInfo(path).Length : 0, ["limitBytes"] = 5 * 1024 * 1024 };} }
    private JsonNode? StorageTransaction(JsonObject p) { var scope=p["scope"]?.GetValue<string>() ?? "private"; if(scope is not ("private" or "public"))throw new ApiError("invalid_params","scope must be private or public"); lock(storageLock){var path=StoragePath(new JsonObject{{"scope",scope}});var data=ReadStorage(path);try{foreach(var raw in p["operations"]?.AsArray() ?? throw new ApiError("invalid_params","operations is required")){var op=raw?.AsObject()??throw new ApiError("invalid_params","operation must be object");switch(op["type"]?.GetValue<string>()){case "set": data[Key(op)]=op["value"]?.DeepClone();break;case "remove":data.Remove(Key(op));break;case "clear":data=new JsonObject();break;case "setSchemaVersion":var value=op["value"]?.GetValue<int>()??-1;if(value<0)throw new ApiError("invalid_params","schema version must be non-negative");data["__mini_schema_version"]=value;break;default:throw new ApiError("invalid_params","Unknown storage operation");}}Save(path,data);return null;}catch(ApiError){throw;}catch(Exception){throw new ApiError("storage_transaction_failed","Transaction was not applied");}} }
    private void RequirePermission(string permission)
    {
        if (!manifest.Permissions.Contains(permission)) throw new ApiError("permission_not_declared", $"Permission {permission} is not declared");
        if (permissions.IsGranted(permission)) return;
        if (MessageBox.Show(this, $"{manifest.Name} запрашивает доступ: {permission}", "Разрешение mini-app", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) throw new ApiError("permission_denied", $"Permission {permission} is required");
        permissions.Grant(permission);
    }
    private JsonNode? ReadClipboard() => Clipboard.ContainsText() ? Clipboard.GetText() : null;
    private JsonNode ClipboardFormats() => new JsonArray(Clipboard.ContainsText() ? "text" : null);
    private JsonNode? NativeAlert(JsonObject p) { MessageBox.Show(OwnerWindow(), p["message"]?.GetValue<string>() ?? "", p["title"]?.GetValue<string>() ?? manifest.Name, MessageBoxButtons.OK, MessageBoxIcon.Information); return null; }
    private JsonNode NativeConfirm(JsonObject p) => MessageBox.Show(OwnerWindow(), p["message"]?.GetValue<string>() ?? "", p["title"]?.GetValue<string>() ?? manifest.Name, MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
    private JsonNode? NativePrompt(JsonObject p) { using var dialog=new Form { Text=p["title"]?.GetValue<string>() ?? manifest.Name, Width=360, Height=160, StartPosition=FormStartPosition.CenterParent }; var input=new TextBox { Dock=DockStyle.Top, Text=p["defaultValue"]?.GetValue<string>() ?? "" }; dialog.Controls.Add(input); var ok=new Button { Text=p["confirmText"]?.GetValue<string>() ?? "OK", DialogResult=DialogResult.OK, Dock=DockStyle.Bottom }; dialog.Controls.Add(ok); return dialog.ShowDialog(OwnerWindow())==DialogResult.OK ? input.Text : null; }
    private JsonNode? NativeToast(JsonObject p) { var title=p["title"]?.GetValue<string>() ?? manifest.Name; var text=p["message"]?.GetValue<string>() ?? ""; var icon=new NotifyIcon { Visible=true, Icon=SystemIcons.Information, BalloonTipTitle=title, BalloonTipText=text }; icon.ShowBalloonTip(p["duration"]?.GetValue<string>()=="long"?5000:2500); var timer=new System.Threading.Timer(_=>icon.Dispose(),null,6000,Timeout.Infinite); return null; }
    private JsonNode CanOpenUrl(JsonObject p) { var raw=p["url"]?.GetValue<string>() ?? ""; return new JsonObject { ["supported"] = Uri.TryCreate(raw,UriKind.Absolute,out var u) && u.Scheme is "https" or "http" or "mailto" or "tel" }; }
    private JsonNode? OpenUrl(JsonObject p) { var raw=p["url"]?.GetValue<string>() ?? ""; if(!Uri.TryCreate(raw,UriKind.Absolute,out var u)||u.Scheme is not ("https" or "http" or "mailto" or "tel"))throw new ApiError("system_url_not_allowed","URL scheme is not allowed"); try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.ToString()){UseShellExecute=true});return null;}catch{throw new ApiError("system_no_handler","No application can open URL");} }
    private JsonNode? OpenFile(JsonObject p) { var id=p["fileId"]?.GetValue<string>() ?? throw new ApiError("invalid_params","fileId is required"); var path=FileFor(new JsonObject{{"id",id}}); try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(path){UseShellExecute=true});return null;}catch{throw new ApiError("system_no_handler","No application can open file");} }
    private JsonNode? OpenSettings(JsonObject p) { try{System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("ms-settings:"){UseShellExecute=true});return null;}catch{throw new ApiError("feature_unavailable","Settings are unavailable");} }
    private static string? PermissionFor(string method) => method.StartsWith("storage.") ? "storage" : method.StartsWith("secureStorage.") ? "secureStorage" : method == "clipboard.write" ? "clipboard.write" : method.StartsWith("clipboard.read") ? "clipboard.read" : method.StartsWith("network.") ? "network" : method.StartsWith("system.") ? "system.open" : method is "files.saveText" or "files.saveBase64" ? "files.save" : method is "files.pickDirectory" or "files.listDirectory" or "files.openInDirectory" or "files.createInDirectory" or "files.writeChunk" or "files.flush" or "files.persistDirectory" or "files.restoreDirectory" or "files.forgetDirectory" ? "files.directory" : method.StartsWith("files.") ? "files.pick" : method.StartsWith("share.") ? "share" : null;
    private void Respond(string id, bool success, JsonNode? result, string? code, string? message)
    {
        var reply = new JsonObject { ["id"] = id, ["success"] = success };
        if (success) reply["result"] = result; else reply["error"] = new JsonObject { ["code"] = code, ["message"] = message };
        var json = reply.ToJsonString(); web.CoreWebView2?.ExecuteScriptAsync($"window.__miniRuntimeResolve({JsonSerializer.Serialize(json)});");
    }
    private sealed class RuntimeTimer(string id, int interval, bool repeat)
    {
        public string Id { get; } = id;
        public int Interval { get; } = interval;
        public bool Repeat { get; } = repeat;
        public bool Running { get; set; } = true;
        public System.Threading.Timer? Timer { get; set; }
    }
}

internal sealed class PermissionStore
{
    private readonly string path;
    private readonly Dictionary<string, string> states;

    public PermissionStore(string appId, string appName)
    {
        path = Path.Combine(MiniStore.ConfigRoot, "Permissions", FileName(appName));
        states = Read();
    }

    public bool IsGranted(string permission) => State(permission) == "granted";
    public string State(string permission) => states.TryGetValue(permission, out var value) ? value : "prompt";

    public void Grant(string permission)
    {
        Set(permission, "granted");
    }
    public void Set(string permission, string state)
    {
        if (state is not ("granted" or "denied" or "prompt")) throw new ApiError("invalid_params", "Invalid permission state");
        if (state == "prompt") states.Remove(permission); else states[permission] = state;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(states));
    }
    public void Reset() { states.Clear(); if (File.Exists(path)) File.Delete(path); }
    public string StateFor(string permission) => State(permission);

    public static void Delete(string appId, string appName)
    {
        var file = Path.Combine(MiniStore.ConfigRoot, "Permissions", FileName(appName));
        if (File.Exists(file)) File.Delete(file);
    }

    private static string FileName(string appName)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var name = string.Concat(appName.Trim().Select(ch => invalid.Contains(ch) || char.IsControl(ch) ? '_' : ch)).TrimEnd('.', ' ');
        return (string.IsNullOrWhiteSpace(name) ? "MiniApp" : name) + ".json";
    }


    private Dictionary<string, string> Read()
    {
        try
        {
            if (!File.Exists(path)) return [];
            // Legacy files stored only granted permissions as a JSON array.
            var node=JsonNode.Parse(File.ReadAllText(path));
            if(node is JsonArray legacy) return legacy.Where(x=>x?.GetValue<string>() is not null).ToDictionary(x=>x!.GetValue<string>(), _=>"granted");
            return node?.Deserialize<Dictionary<string,string>>() ?? [];
        }
        catch { return []; }
    }
}

/** DPAPI-protected JSON values; the encrypted blob is isolated by stable manifest ID. */
internal sealed class SecureStorageStore
{
    private readonly string path;
    public SecureStorageStore(string appId)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(appId)));
        path = Path.Combine(MiniStore.DataRoot, "secure", hash + ".bin");
    }
    public JsonNode? Get(string key) { var values=Read(); return values[key]?.DeepClone(); }
    public JsonNode? Set(string key, JsonNode? value) { var values=Read(); values[key]=value?.DeepClone(); Write(values); return null; }
    public JsonNode? Remove(string key) { var values=Read(); values.Remove(key); Write(values); return null; }
    public JsonNode Keys() => new JsonArray(Read().Select(pair => (JsonNode)pair.Key).ToArray());
    public JsonNode? Clear() { if (File.Exists(path)) File.Delete(path); return null; }
    public static void Delete(string appId) { var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(appId))); var file=Path.Combine(MiniStore.DataRoot,"secure",hash+".bin"); if(File.Exists(file))File.Delete(file); }
    public static long SizeFor(string appId) { var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(appId))); var file=Path.Combine(MiniStore.DataRoot,"secure",hash+".bin"); return File.Exists(file) ? new FileInfo(file).Length : 0L; }
    private JsonObject Read()
    {
        if (!File.Exists(path)) return [];
        try { var encrypted=File.ReadAllBytes(path); var plain=ProtectedData.Unprotect(encrypted, Encoding.UTF8.GetBytes("MiniAppRuntime/v1"), DataProtectionScope.CurrentUser); return JsonNode.Parse(Encoding.UTF8.GetString(plain))?.AsObject() ?? throw new InvalidDataException(); }
        catch (Exception) { throw new ApiError("secure_storage_failed", "Secure storage data is unavailable"); }
    }
    private void Write(JsonObject values)
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(path)!); var protectedBytes=ProtectedData.Protect(Encoding.UTF8.GetBytes(values.ToJsonString()), Encoding.UTF8.GetBytes("MiniAppRuntime/v1"), DataProtectionScope.CurrentUser); var tmp=path+"."+Guid.NewGuid().ToString("N")+".tmp"; File.WriteAllBytes(tmp,protectedBytes); File.Move(tmp,path,true); }
        catch (Exception) { throw new ApiError("secure_storage_unavailable", "Secure storage is unavailable"); }
    }
}

internal sealed record TopBarAction(string Id, string Label, bool Accent);

internal sealed record TopBarButtonStyle(int Radius, int HorizontalPadding, Color Background, Color HoverBackground, Color Foreground, Color Border, int BorderOpacity, float FontSize);

internal sealed record TopBarConfiguration(bool Visible, int Height, int HorizontalPadding, int VerticalPadding, float TitleFontSize, string Title, Color Background, Color Foreground, Color Accent, bool ShowBack, string BackText, TopBarButtonStyle BackButton, IReadOnlyList<TopBarAction> Actions)
{
    public static TopBarConfiguration Default(string title) => new(true, 64, 12, 10, 11, title, Color.FromArgb(23, 27, 40), Color.FromArgb(246, 247, 251), Color.FromArgb(82, 113, 255), true, "← Назад", DefaultButton(Color.FromArgb(82, 113, 255)), []);

    public static TopBarConfiguration From(JsonObject source)
    {
        var actions = source["actions"]?.AsArray()
            .Take(4)
            .Select(item => item?.AsObject())
            .Where(item => item is not null)
            .Select(item => new TopBarAction(Text(item!["id"], ""), Text(item["label"], ""), item["accent"]?.GetValue<bool>() == true))
            .Where(item => !string.IsNullOrWhiteSpace(item.Id) && !string.IsNullOrWhiteSpace(item.Label))
            .ToArray() ?? [];
        return new(
            source["visible"]?.GetValue<bool>() != false,
            Math.Clamp(source["height"]?.GetValue<int>() ?? 64, 40, 120),
            Math.Clamp(source["paddingX"]?.GetValue<int>() ?? 12, 0, 48),
            Math.Clamp(source["paddingY"]?.GetValue<int>() ?? 10, 0, 32),
            Math.Clamp(source["titleFontSize"]?.GetValue<float>() ?? 11, 8, 24),
            Text(source["title"], "Mini App", 120),
            ColorValue(source["background"], Color.FromArgb(18, 20, 28)),
            ColorValue(source["foreground"], Color.FromArgb(246, 247, 251)),
            ColorValue(source["accent"], Color.FromArgb(54, 91, 255)),
            source["showBack"]?.GetValue<bool>() != false,
            Text(source["backText"], "← Назад", 40),
            ButtonStyle(source["backButton"]?.AsObject(), ColorValue(source["accent"], Color.FromArgb(54, 91, 255))),
            actions);
    }

    private static TopBarButtonStyle DefaultButton(Color accent) => new(18, 14, accent, Lighten(accent, 0.16f), Color.White, Color.White, 70, 9.5f);
    private static TopBarButtonStyle ButtonStyle(JsonObject? source, Color accent)
    {
        var defaults = DefaultButton(accent);
        if (source is null) return defaults;
        var background = ColorValue(source["background"], defaults.Background);
        return new(Math.Clamp(source["radius"]?.GetValue<int>() ?? defaults.Radius, 0, 48), Math.Clamp(source["paddingX"]?.GetValue<int>() ?? defaults.HorizontalPadding, 4, 48), background, ColorValue(source["hoverBackground"], defaults.HoverBackground), ColorValue(source["foreground"], defaults.Foreground), ColorValue(source["border"], defaults.Border), Math.Clamp(source["borderOpacity"]?.GetValue<int>() ?? defaults.BorderOpacity, 0, 255), Math.Clamp(source["fontSize"]?.GetValue<float>() ?? defaults.FontSize, 7, 20));
    }

    private static string Text(JsonNode? value, string fallback, int maxLength = 80)
    {
        var text = value?.GetValue<string>()?.Trim();
        return string.IsNullOrEmpty(text) ? fallback : text[..Math.Min(text.Length, maxLength)];
    }
    private static Color ColorValue(JsonNode? value, Color fallback)
    {
        var raw = value?.GetValue<string>();
        return raw is not null && System.Text.RegularExpressions.Regex.IsMatch(raw, "^#[0-9a-fA-F]{6}$") ? ColorTranslator.FromHtml(raw) : fallback;
    }
    private static Color Lighten(Color color, float amount) => Color.FromArgb(color.A, color.R + (int)((255 - color.R) * amount), color.G + (int)((255 - color.G) * amount), color.B + (int)((255 - color.B) * amount));
}

internal sealed class NativeTopBar : Panel
{
    public event Action? BackRequested;
    public event Action<string>? ActionRequested;

    public void Apply(TopBarConfiguration config)
    {
        SuspendLayout();
        Controls.Clear();
        Visible = config.Visible;
        Height = config.Height;
        BackColor = config.Background;
        Padding = new Padding(config.HorizontalPadding, config.VerticalPadding, config.HorizontalPadding, config.VerticalPadding);
        if (!config.Visible) { ResumeLayout(); return; }

        var title = new Label { Text = config.Title, Dock = DockStyle.Fill, ForeColor = config.Foreground, BackColor = Color.Transparent, Font = new Font("Segoe UI", config.TitleFontSize, FontStyle.Bold), TextAlign = ContentAlignment.MiddleLeft, AutoEllipsis = true };
        Controls.Add(title);
        foreach (var action in config.Actions.Reverse())
        {
            var actionStyle = config.BackButton with { Background = action.Accent ? config.Accent : config.Background, Foreground = config.Foreground };
            var actionButton = CreateButton(action.Label, actionStyle, config.Background, () => ActionRequested?.Invoke(action.Id));
            actionButton.Dock = DockStyle.Right;
            Controls.Add(actionButton);
        }
        if (config.ShowBack) Controls.Add(CreateButton(config.BackText, config.BackButton, config.Background, () => BackRequested?.Invoke()));
        ResumeLayout();
    }

    private static Control CreateButton(string text, TopBarButtonStyle style, Color hostBackground, Action click)
    {
        var button = new TopBarButton(style, hostBackground) { Text = text, AutoSize = true, Dock = DockStyle.Left, Margin = new Padding(0, 0, 10, 0), ForeColor = style.Foreground, Font = new Font("Segoe UI", style.FontSize, FontStyle.Bold), Cursor = Cursors.Hand, Padding = new Padding(style.HorizontalPadding, 0, style.HorizontalPadding, 0) };
        button.Click += (_, _) => click();
        return button;
    }
}

internal sealed class TopBarButton : Control
{
    private bool isHovered;
    private readonly TopBarButtonStyle style;
    private readonly Color hostBackground;

    public TopBarButton(TopBarButtonStyle style, Color hostBackground)
    {
        this.style = style;
        this.hostBackground = hostBackground;
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        TabStop = true;
    }

    protected override void OnMouseEnter(EventArgs e) { isHovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { isHovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaintBackground(PaintEventArgs e) { }

    public override Size GetPreferredSize(Size proposedSize)
    {
        var textSize = TextRenderer.MeasureText(Text, Font, Size.Empty, TextFormatFlags.SingleLine);
        return new Size(textSize.Width + Padding.Horizontal, Math.Max(textSize.Height + 10, 36));
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var bounds = ClientRectangle;
        if (bounds.Width < 2 || bounds.Height < 2) return;
        using var hostFill = new SolidBrush(hostBackground);
        e.Graphics.FillRectangle(hostFill, bounds);
        var radius = Math.Min(bounds.Height / 2, style.Radius);
        using var path = RoundedPath(new Rectangle(0, 0, bounds.Width - 1, bounds.Height - 1), radius);
        using var fill = new SolidBrush(isHovered ? style.HoverBackground : style.Background);
        e.Graphics.FillPath(fill, path);
        using var border = new Pen(Color.FromArgb(style.BorderOpacity, style.Border), 1);
        e.Graphics.DrawPath(border, path);
        var textBounds = new Rectangle(Padding.Left, 0, bounds.Width - Padding.Horizontal, bounds.Height);
        TextRenderer.DrawText(e.Graphics, Text, Font, textBounds, ForeColor, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }

    private static GraphicsPath RoundedPath(Rectangle rect, int radius)
    {
        if (radius <= 0) { var square = new GraphicsPath(); square.AddRectangle(rect); return square; }
        var diameter = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

}
