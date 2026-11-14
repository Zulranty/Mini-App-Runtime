using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Web.WebView2.Core;

namespace MiniAppRuntime.Windows;

internal sealed class WebStreams(Action<string, JsonNode> emit) : IDisposable
{
    internal const string Origin = "https://media.miniapp.local";
    internal const int BlockBytes = 512 * 1024;
    private const int SaveBlockBytes = 1024 * 1024;
    private const long MaxBytes = 2_000_000_000;
    private static readonly Regex MediaMime = new(@"^(video|audio)/[a-zA-Z0-9_.+-]{1,64}$");
    private static readonly Regex RangeHeader = new(@"^bytes=([0-9]*)-([0-9]*)$", RegexOptions.IgnoreCase);
    private static readonly Regex SourceId = new(@"^stream-[0-9]{1,12}$");
    private readonly Dictionary<string, PendingRead> pending = [];
    private Source? media;
    private Source? save;
    private long waitUntil;

    public long SetWaitUntil(long until)
    {
        waitUntil = until;
        NotifyWaitUntil(media);
        NotifyWaitUntil(save);
        return until;
    }

    private void NotifyWaitUntil(Source? source)
    {
        if (source is not null)
            emit("streams.waitUntil", new JsonObject { ["source"] = source.Id, ["until"] = waitUntil });
    }

    private sealed record Source(string Id, long Size, string Mime)
    {
        public string Token { get; } = Guid.NewGuid().ToString("N");
        public CancellationTokenSource Lifetime { get; } = new();
    }

    private sealed record PendingRead(int Length, TaskCompletionSource<byte[]?> Result);

    private static Source Parse(JsonObject parameters)
    {
        var id = parameters["source"]?.GetValue<string>() ?? "";
        var size = parameters["size"]?.GetValue<long>() ?? 0;
        var mime = parameters["mimeType"]?.GetValue<string>() ?? "";
        if (!SourceId.IsMatch(id) || size is < 1 or > MaxBytes) throw new ApiError("invalid_params", "Invalid stream source");
        return new(id, size, mime);
    }

    public JsonNode Open(JsonObject parameters)
    {
        if (media is not null) throw new ApiError("operation_in_progress", "A media stream is already open");
        var source = Parse(parameters);
        if (!MediaMime.IsMatch(source.Mime)) throw new ApiError("invalid_params", "Invalid media type");
        media = source;
        return JsonValue.Create($"{Origin}/{source.Token}")!;
    }

    public JsonNode? Close(JsonObject parameters)
    {
        var id = parameters["source"]?.GetValue<string>();
        if (media is { } active && active.Id == id)
        {
            media = null;
            active.Lifetime.Cancel();
            active.Lifetime.Dispose();
        }
        if (save is { } writing && writing.Id == id) writing.Lifetime.Cancel();
        return null;
    }

    public JsonNode? Reply(JsonObject parameters)
    {
        var id = parameters["request"]?.GetValue<string>() ?? "";
        if (!pending.TryGetValue(id, out var read)) return null;
        var data = parameters["data"]?.GetValue<string>();
        byte[]? bytes = null;
        if (data is not null && data.Length == (read.Length + 2) / 3 * 4)
        {
            try { bytes = Convert.FromBase64String(data); }
            catch (FormatException) { }
        }
        read.Result.TrySetResult(bytes?.Length == read.Length ? bytes : null);
        return null;
    }

    private async Task<byte[]> ReadAsync(Source source, long offset, int length)
    {
        var cancellation = source.Lifetime.Token;
        cancellation.ThrowIfCancellationRequested();
        if (pending.Count >= 8) throw new ApiError("operation_in_progress", "Too many stream reads");
        var request = Guid.NewGuid().ToString("N");
        var result = new TaskCompletionSource<byte[]?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending.Add(request, new(length, result));
        try
        {
            emit("streams.read", new JsonObject
            {
                ["source"] = source.Id, ["request"] = request, ["offset"] = offset, ["length"] = length, ["waitUntil"] = waitUntil
            });
            var deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 45_000;
            while (true)
            {
                var remaining = Math.Max(deadline, waitUntil + 45_000) - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (remaining <= 0) throw new TimeoutException();
                try
                {
                    var bytes = await result.Task.WaitAsync(TimeSpan.FromMilliseconds(Math.Min(remaining, 86_400_000)), cancellation);
                    return bytes ?? throw new ApiError("stream_read_failed", "Could not read the requested data");
                }
                catch (TimeoutException) { } // The source may have extended its wait while the read was pending.
            }
        }
        catch (TimeoutException) { throw new ApiError("stream_read_failed", "The stream timed out"); }
        finally { pending.Remove(request); }
    }

    public async Task<JsonNode?> SaveAsync(IWin32Window owner, JsonObject parameters, string? directory)
    {
        if (save is not null) throw new ApiError("operation_in_progress", "A save operation is already active");
        var source = Parse(parameters);
        var file = FileShareRequestValidator.SaveBase64(new JsonObject
        {
            ["suggestedName"] = parameters["suggestedName"]?.DeepClone(), ["mimeType"] = source.Mime, ["base64"] = ""
        });
        save = source;
        string? temporary = null;
        try
        {
            var destination = directory is null ? WinFormsFileSaveDialog.ChoosePath(owner, file)
                : Path.Combine(PrepareFolder(directory, parameters["folders"]?.AsArray()), SafeSegment(file.Name));
            var cancellation = source.Lifetime.Token;
            if (destination is null || cancellation.IsCancellationRequested) return null;
            var overwrite = File.Exists(destination);
            temporary = Path.Combine(Path.GetDirectoryName(destination)!, $".miniapps-{Guid.NewGuid():N}.part");
            await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                for (long offset = 0; offset < source.Size;)
                {
                    var bytes = await ReadAsync(source, offset, (int)Math.Min(SaveBlockBytes, source.Size - offset));
                    await output.WriteAsync(bytes, cancellation);
                    offset += bytes.Length;
                }
                await output.FlushAsync(cancellation);
            }
            cancellation.ThrowIfCancellationRequested();
            if (directory is null) File.Move(temporary, destination, overwrite);
            else destination = MoveWithoutReplacing(temporary, destination, cancellation);
            temporary = null;
            return new JsonObject { ["name"] = Path.GetFileName(destination), ["mimeType"] = file.MimeType, ["sizeBytes"] = source.Size };
        }
        catch (OperationCanceledException) { return null; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ApiError("file_write_failed", "Could not write file");
        }
        finally
        {
            if (temporary is not null)
            {
                try { File.Delete(temporary); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            save = null;
            source.Lifetime.Dispose();
        }
    }

    private static string PrepareFolder(string root, JsonArray? folders)
    {
        var path = root;
        if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
            throw new ApiError("file_write_failed", "The selected directory is a link");
        if (folders is null) return path;
        if (folders.Count > 64) throw new ApiError("invalid_params", "Folder path is too deep");
        foreach (var folder in folders)
        {
            path = Path.Combine(path, SafeSegment(folder?.GetValue<string>() ?? ""));
            var created = Directory.CreateDirectory(path);
            if (created.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new ApiError("file_write_failed", "The destination contains a linked directory");
        }
        return path;
    }

    private static string SafeSegment(string name)
    {
        if (name.Length is < 1 or > 255 || name.EndsWith('.') || name.EndsWith(' ') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            Regex.IsMatch(name.Split('.')[0].TrimEnd(), @"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$", RegexOptions.IgnoreCase))
            throw new ApiError("invalid_params", "Invalid destination name");
        return name;
    }

    private static string MoveWithoutReplacing(string temporary, string destination, CancellationToken cancellation)
    {
        var parent = Path.GetDirectoryName(destination)!;
        var stem = Path.GetFileNameWithoutExtension(destination);
        var extension = Path.GetExtension(destination);
        for (var index = 0; ; index++)
        {
            cancellation.ThrowIfCancellationRequested();
            var candidate = index == 0 ? destination : Path.Combine(parent, $"{stem} ({index}){extension}");
            if (Directory.Exists(candidate)) continue;
            try { File.Move(temporary, candidate); return candidate; }
            catch (IOException) when (File.Exists(candidate)) { }
        }
    }

    public async Task ServeAsync(CoreWebView2Environment environment, CoreWebView2WebResourceRequestedEventArgs args)
    {
        using var deferral = args.GetDeferral();
        void Respond(int status, string reason, string headers = "", byte[]? bytes = null) =>
            args.Response = environment.CreateWebResourceResponse(bytes is null ? Stream.Null : new MemoryStream(bytes, false),
                status, reason, "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" + headers);

        var request = args.Request;
        var source = media;
        if (source is null || request.Uri != $"{Origin}/{source.Token}")
        {
            Respond(404, "Not Found");
            return;
        }
        var headers = $"Content-Type: {source.Mime}\r\nAccept-Ranges: bytes\r\n";
        if (request.Method == "HEAD")
        {
            Respond(200, "OK", headers + $"Content-Length: {source.Size}");
            return;
        }
        if (request.Method != "GET")
        {
            Respond(405, "Method Not Allowed");
            return;
        }
        var range = request.Headers.Contains("Range") ? request.Headers.GetHeader("Range") : null;
        if (!TryRange(range, source.Size, out var start, out var length))
        {
            Respond(416, "Range Not Satisfiable", $"Content-Range: bytes */{source.Size}");
            return;
        }
        try
        {
            var bytes = await ReadAsync(source, start, length);
            headers += $"Content-Length: {length}\r\n";
            if (range is null && length == source.Size) Respond(200, "OK", headers, bytes);
            else Respond(206, "Partial Content", headers + $"Content-Range: bytes {start}-{start + length - 1}/{source.Size}", bytes);
        }
        catch (ApiError) { Respond(502, "Stream Read Failed"); }
        catch (OperationCanceledException) { Respond(404, "Not Found"); }
    }

    internal static bool TryRange(string? header, long size, out long start, out int length)
    {
        start = 0;
        length = (int)Math.Min(size, BlockBytes);
        if (header is null) return true;
        var match = RangeHeader.Match(header);
        if (!match.Success) return false;
        var first = match.Groups[1].Value;
        var last = match.Groups[2].Value;
        long end = size - 1;
        if (first.Length == 0)
        {
            if (!long.TryParse(last, NumberStyles.None, CultureInfo.InvariantCulture, out var suffix) || suffix == 0) return false;
            start = size - Math.Min(size, suffix);
        }
        else
        {
            if (!long.TryParse(first, NumberStyles.None, CultureInfo.InvariantCulture, out start) || start >= size) return false;
            if (last.Length != 0 && (!long.TryParse(last, NumberStyles.None, CultureInfo.InvariantCulture, out end) || end < start)) return false;
        }
        length = (int)Math.Min(BlockBytes, Math.Min(end, size - 1) - start + 1);
        return true;
    }

    public void Dispose()
    {
        var active = media;
        media = null;
        if (active is not null)
        {
            active.Lifetime.Cancel();
            active.Lifetime.Dispose();
        }
        save?.Lifetime.Cancel();
    }
}
