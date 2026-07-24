using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;

namespace MiniAppRuntime.Windows;

internal sealed class ApiError(string code, string message) : Exception(message) { public string Code { get; } = code; }
internal sealed record SaveFileRequest(string Name, string MimeType, IReadOnlyList<string> Extensions, byte[] Bytes);
internal sealed record ShareTextRequest(string Text, string? Title);
internal sealed record ShareFileRequest(string? Title, string? Text, SaveFileRequest File);

internal static class FileShareRequestValidator
{
    internal const int MaxFileBytes = 10 * 1024 * 1024;
    private static readonly System.Text.RegularExpressions.Regex Mime = new("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+*-]+$", System.Text.RegularExpressions.RegexOptions.Compiled);
    private static readonly System.Text.RegularExpressions.Regex Extension = new("^\\.[a-z0-9]{1,16}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    public static SaveFileRequest SaveText(JsonObject p) => Save(p, "text");
    public static SaveFileRequest SaveBase64(JsonObject p) => Save(p, "base64");
    public static ShareTextRequest ShareText(JsonObject p) => new(RequiredString(p, "text"), OptionalString(p, "title", 255));
    public static ShareFileRequest ShareFile(JsonObject p)
    {
        var content = p["content"]?.AsObject() ?? throw Invalid("content is required");
        var encoding = RequiredString(content, "encoding");
        if (encoding is not ("text" or "base64")) throw Invalid("content.encoding must be text or base64");
        var copy = JsonNode.Parse(p.ToJsonString())!.AsObject();
        copy[encoding == "text" ? "text" : "base64"] = RequiredString(content, "data");
        return new(OptionalString(p, "title", 255), OptionalString(p, "text", MaxFileBytes), Save(copy, encoding));
    }
    private static SaveFileRequest Save(JsonObject p, string encoding)
    {
        var name = SafeName(RequiredString(p, "suggestedName"));
        var mime = RequiredString(p, "mimeType");
        if (mime.Length > 127 || !Mime.IsMatch(mime)) throw Invalid("mimeType is invalid");
        var extensions = p["extensions"]?.AsArray()?.Select(x => x?.GetValue<string>() ?? throw Invalid("extension is invalid")).Select(x => x.Trim().ToLowerInvariant()).ToArray() ?? [];
        if (extensions.Length > 16 || extensions.Any(x => !Extension.IsMatch(x))) throw Invalid("extension is invalid");
        var raw = RequiredString(p, encoding == "text" ? "text" : "base64");
        byte[] bytes;
        try { bytes = encoding == "text" ? new UTF8Encoding(false).GetBytes(raw) : Convert.FromBase64String(raw); }
        catch (FormatException) { throw Invalid("base64 is invalid"); }
        if (bytes.Length > MaxFileBytes) throw new ApiError("file_too_large", "File is too large");
        return new(name, mime, extensions.Distinct().ToArray(), bytes);
    }
    private static string SafeName(string value)
    {
        var name = value.Trim();
        if (name.Length is 0 or > 255 || name is "." or ".." || name.IndexOfAny(['/', '\\', '\0']) >= 0 || name.Any(char.IsControl)) throw Invalid("suggestedName is invalid");
        return name;
    }
    private static string RequiredString(JsonObject p, string name) => p[name]?.GetValue<string>() ?? throw Invalid($"{name} is required");
    private static string? OptionalString(JsonObject p, string name, int max) { if (p[name] is null) return null; var text = p[name]!.GetValue<string>(); if (text.Length > max) throw Invalid($"{name} is too long"); return text; }
    private static ApiError Invalid(string message) => new("invalid_params", message);
}

internal interface IFileSaveDialog { Stream? Open(IWin32Window owner, SaveFileRequest request); }
internal sealed class WinFormsFileSaveDialog : IFileSaveDialog
{
    public Stream? Open(IWin32Window owner, SaveFileRequest request)
    {
        using var dialog = new SaveFileDialog { FileName = request.Name, AddExtension = true, OverwritePrompt = true, CheckPathExists = true, RestoreDirectory = true, DefaultExt = request.Extensions.FirstOrDefault()?.TrimStart('.') ?? ExtensionForMime(request.MimeType), Filter = Filter(request) };
        return dialog.ShowDialog(owner) == DialogResult.OK ? dialog.OpenFile() : null;
    }
    private static string Filter(SaveFileRequest r) => r.Extensions.Count == 0 ? $"{r.MimeType}|*.*|All files|*.*" : $"{r.MimeType}|{string.Join(';', r.Extensions.Select(x => "*" + x))}|All files|*.*";
    private static string ExtensionForMime(string mime) => mime == "text/plain" ? "txt" : "";
}
internal sealed class WindowsFileSaveService(IFileSaveDialog dialog)
{
    public JsonObject? Save(IWin32Window owner, SaveFileRequest request)
    {
        try
        {
            using var stream = dialog.Open(owner, request);
            if (stream is null) return null;
            stream.Write(request.Bytes); stream.Flush();
            return new JsonObject { ["name"] = request.Name, ["mimeType"] = request.MimeType, ["sizeBytes"] = request.Bytes.Length };
        }
        catch (ApiError) { throw; }
        catch (Exception) { throw new ApiError("file_write_failed", "Could not write file"); }
    }
}

internal interface IWindowsShareHost : IDisposable { void Show(ShareTextRequest request); void Show(ShareFileRequest request, string requestId); }
internal sealed class WindowsShareService : IWindowsShareHost
{
    private readonly IWin32Window owner;
    private readonly string appId;
    private readonly DataTransferManager? manager;
    private object? pending;
    public WindowsShareService(IWin32Window owner, string appId)
    {
        this.owner = owner; this.appId = appId;
        if (DataTransferManager.IsSupported())
        {
            manager = DataTransferManagerInterop.ForWindow(owner.Handle);
            manager.DataRequested += DataRequested;
        }
        Cleanup();
    }
    public void Show(ShareTextRequest request)
    {
        System.Windows.Forms.Clipboard.SetText(request.Text);
    }
    public void Show(ShareFileRequest request, string requestId)
    {
        EnsureIdle();
        var root = Path.Combine(Path.GetTempPath(), "MiniAppRuntime", "share", SafeAppId(appId), SafeAppId(requestId));
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, request.File.Name);
        try { File.WriteAllBytes(path, request.File.Bytes); }
        catch (Exception) { throw new ApiError("file_write_failed", "Could not prepare shared file"); }
        CopyFileToClipboard(path);
    }
    public void ShowExistingFile(string source, string name, string mimeType, string? title = null)
    {
        EnsureIdle();
        if (!File.Exists(source)) throw new ApiError("source_file_not_found", "Source file was not found");
        var root = Path.Combine(Path.GetTempPath(), "MiniAppRuntime", "share", SafeAppId(appId), Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root); var path = Path.Combine(root, name);
        try { File.Copy(source, path, true); } catch { throw new ApiError("app_share_failed", "Could not prepare shared file"); }
        CopyFileToClipboard(path);
    }
    private void ShowNative() { if (manager is null) throw new ApiError("share_unavailable", "Windows Share is unavailable"); try { DataTransferManagerInterop.ShowForWindow(owner.Handle); } catch (Exception) { pending = null; throw new ApiError("share_unavailable", "Windows Share is unavailable"); } }
    private static void CopyFileToClipboard(string path)
    {
        var files = new System.Collections.Specialized.StringCollection(); files.Add(path);
        System.Windows.Forms.Clipboard.SetFileDropList(files);
    }
    private void EnsureIdle() { if (pending is not null) throw new ApiError("operation_in_progress", "A share operation is already active"); }
    private void DataRequested(DataTransferManager sender, DataRequestedEventArgs args)
    {
        var payload = pending; pending = null;
        if (payload is null) return;
        var package = args.Request.Data;
        switch (payload)
        {
            case ShareTextRequest text: package.Properties.Title = string.IsNullOrWhiteSpace(text.Title) ? "Mini app" : text.Title; package.SetText(text.Text); break;
            case ValueTuple<ShareFileRequest, string> file:
                package.Properties.Title = string.IsNullOrWhiteSpace(file.Item1.Title) ? file.Item1.File.Name : file.Item1.Title;
                if (!string.IsNullOrEmpty(file.Item1.Text)) package.SetText(file.Item1.Text);
                var storageFile = StorageFile.GetFileFromPathAsync(file.Item2).AsTask().GetAwaiter().GetResult();
                package.SetStorageItems([storageFile]); break;
        }
    }
    public void Dispose() { if (manager is not null) manager.DataRequested -= DataRequested; pending = null; }
    private static string SafeAppId(string value) => string.Concat(value.Select(c => char.IsLetterOrDigit(c) || c is '.' or '_' or '-' ? c : '_'));
    private static void Cleanup() { var root = Path.Combine(Path.GetTempPath(), "MiniAppRuntime", "share"); if (!Directory.Exists(root)) return; var cutoff = DateTime.UtcNow.AddHours(-24); foreach (var dir in Directory.EnumerateDirectories(root)) { if (Directory.GetLastWriteTimeUtc(dir) < cutoff) { try { Directory.Delete(dir, true); } catch (IOException) { } } } }
}

[ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDataTransferManagerInterop { IntPtr GetForWindow(IntPtr appWindow, ref Guid riid); void ShowShareUIForWindow(IntPtr appWindow); }
internal static class DataTransferManagerInterop
{
    private static IDataTransferManagerInterop Factory => DataTransferManager.As<IDataTransferManagerInterop>();
    public static DataTransferManager ForWindow(IntPtr hwnd) { var iid = new Guid(0xa5caee9b, 0x8708, 0x49d1, 0x8d, 0x36, 0x67, 0xd2, 0x5a, 0x8d, 0xa0, 0x0c); return WinRT.MarshalInterface<DataTransferManager>.FromAbi(Factory.GetForWindow(hwnd, ref iid)); }
    public static void ShowForWindow(IntPtr hwnd) => Factory.ShowShareUIForWindow(hwnd);
}
