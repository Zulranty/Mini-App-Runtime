using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal static class CheckedFileWrite
{
    private const int MaxBytes = 10 * 1024 * 1024;
    private static readonly object Gate = new();

    internal static void Write(string directory, string name, JsonObject parameters)
    {
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            name.EndsWith('.') || name.EndsWith(' ') ||
            !parameters.ContainsKey("expectedSha256"))
            throw new ApiError("invalid_params", "Invalid file replacement");
        var expected = parameters["expectedSha256"]?.GetValue<string>();
        var data = parameters["base64"]?.GetValue<string>() ?? throw new ApiError("invalid_params", "File data is required");
        if (expected is not null && (expected.Length != 64 || expected.Any(ch => !char.IsAsciiHexDigit(ch))))
            throw new ApiError("invalid_params", "Invalid file replacement");
        if (data.Length > (MaxBytes + 2) / 3 * 4) throw new ApiError("file_too_large", "File is too large");

        byte[] bytes;
        try { bytes = Convert.FromBase64String(data); }
        catch (FormatException) { throw new ApiError("invalid_params", "Invalid base64"); }
        if (bytes.Length > MaxBytes) throw new ApiError("file_too_large", "File is too large");

        lock (Gate)
        {
            try { Commit(directory, name, bytes, expected); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw new ApiError("file_write_failed", $"Could not replace {name}: {error.Message}");
            }
        }
    }

    private static void Commit(string directory, string name, byte[] bytes, string? expected)
    {
        var path = Path.Combine(directory, name);
        if (IsLink(directory) || IsLink(path))
            throw new ApiError("file_write_failed", "The selected path is a link");

        var token = Guid.NewGuid().ToString("N");
        var staged = Path.Combine(directory, $".miniapps-{token}.part");
        var recovery = Path.Combine(directory, $".miniapps-{token}.conflict.bak");
        try
        {
            using (var output = new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                output.Write(bytes);
                output.Flush(flushToDisk: true);
            }
            if (expected is null)
            {
                try { File.Move(staged, path); }
                catch (IOException) when (File.Exists(path) || Directory.Exists(path)) { throw Changed(name); }
                return;
            }

            using (var original = OpenCurrent(path, name))
            {
                if (!Matches(original, expected)) throw Changed(name);
                Replace(staged, path, recovery);
            }
            // An external editor can rename over an open file. Check the bytes
            // actually displaced by Replace and preserve them on conflict.
            bool conflict;
            using (var displaced = OpenCurrent(recovery, name))
                conflict = !Matches(displaced, expected);
            if (conflict)
            {
                using var current = OpenCurrent(path, name);
                var written = Convert.ToHexString(SHA256.HashData(bytes));
                if (!Matches(current, written))
                    throw new ApiError("file_changed", $"{name} changed during replacement. Earlier contents are in {Path.GetFileName(recovery)}.");
                Replace(recovery, path, staged);
                using var replaced = OpenCurrent(staged, name);
                if (!Matches(replaced, written))
                {
                    File.Move(staged, recovery);
                    throw new ApiError("file_changed", $"{name} changed during recovery. The other version is in {Path.GetFileName(recovery)}.");
                }
                throw Changed(name);
            }
            TryDelete(recovery);
        }
        finally { TryDelete(staged); }
    }

    private static void Replace(string source, string target, string displaced)
    {
        try { File.Replace(source, target, displaced); }
        catch (IOException) when (!File.Exists(target) && File.Exists(displaced))
        {
            File.Move(displaced, target);
            throw;
        }
    }

    private static FileStream OpenCurrent(string path, string name)
    {
        try { return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete); }
        catch (FileNotFoundException) { throw Changed(name); }
    }

    private static bool Matches(FileStream file, string expected) =>
        file.Length <= MaxBytes && Convert.ToHexString(SHA256.HashData(file)).Equals(expected, StringComparison.OrdinalIgnoreCase);

    private static bool IsLink(string path)
    {
        try { return File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint); }
        catch (FileNotFoundException) { return false; }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static ApiError Changed(string name) =>
        new("file_changed", $"{name} changed outside the editor. Reload the folder before saving.");
}
