namespace MiniAppRuntime.Windows;

internal sealed class TelegramSessionLease(string directory) : IDisposable
{
    internal const string ClientAppId = "com.miniapps.telegram";
    private FileStream? lease;
    private string? owner;
    public long WaitUntil { get; private set; }
    public bool TestServers { get; private set; }

    public long Acquire(string token, bool testServers)
    {
        if (token.Length is < 1 or > 80) throw new ApiError("invalid_params", "Invalid Telegram lease owner");
        if (lease is not null)
        {
            if (owner != token || TestServers != testServers)
                throw new ApiError("telegram_session_busy", "Close the other Telegram mini-app first");
            return WaitUntil;
        }
        FileStream? opened = null;
        try
        {
            Directory.CreateDirectory(directory);
            var fileName = testServers ? "telegram-test-session.lock" : "telegram-session.lock";
            opened = new FileStream(Path.Combine(directory, fileName),
                FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            using var reader = new BinaryReader(opened, System.Text.Encoding.UTF8, leaveOpen: true);
            WaitUntil = opened.Length == sizeof(long) ? reader.ReadInt64() : 0;
            lease = opened;
            owner = token;
            TestServers = testServers;
            return WaitUntil;
        }
        catch (IOException error) when ((error.HResult & 0xffff) is 32 or 33)
        {
            throw new ApiError("telegram_session_busy", "Close the other Telegram mini-app first");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ApiError("telegram_session_unavailable", "Could not lock the Telegram session");
        }
        finally
        {
            if (lease is null) opened?.Dispose();
        }
    }

    public void RequireOwner(string token)
    {
        if (owner != token) throw new ApiError("telegram_session_unavailable", "Telegram session is not held by this client");
    }

    public long SetWaitUntil(string token, long until)
    {
        RequireOwner(token);
        var opened = lease!;
        if (until is < 0 or > 253402300799999L) throw new ApiError("invalid_params", "Invalid Telegram wait deadline");
        if (until <= WaitUntil) return WaitUntil;
        opened.Position = 0;
        using var writer = new BinaryWriter(opened, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write(until);
        opened.SetLength(sizeof(long));
        opened.Flush(flushToDisk: true);
        return WaitUntil = until;
    }

    public void Dispose()
    {
        lease?.Dispose();
        lease = null;
        owner = null;
    }

    public void Release(string token)
    {
        RequireOwner(token);
        Dispose();
    }
}
