using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

internal sealed class TelegramAccess(SecureStorageStore consent, string grantKey, string callerName)
{
    internal const string Permission = "telegram.session";
    internal const string LoginReason = "telegramSignIn";
    internal const string ConsumerGrantKey = "runtime.telegram-access.v1";
    private const string SessionKey = "telegram.session.v1";
    private readonly SecureStorageStore telegram = new(TelegramSessionLease.ClientAppId);
    public string? ApprovedFingerprint { get; private set; }
    private bool confirming;

    public bool HasSaved() => telegram.Get(SessionKey) is JsonObject;

    public bool HasApproval() =>
        telegram.Get(SessionKey) is JsonObject record && ApprovedFingerprint == Fingerprint(record);

    public JsonObject? Use(IWin32Window owner, bool interactive)
    {
        if (confirming) throw new ApiError("operation_in_progress", "Telegram consent is already open");
        if (telegram.Get(SessionKey) is not JsonObject record) return null;

        var fingerprint = Fingerprint(record);
        var grant = consent.Get(grantKey) as JsonObject;
        if (grant?["fingerprint"]?.GetValue<string>() != fingerprint)
        {
            if (!interactive) return null;
            confirming = true;
            try
            {
                var answer = MessageBox.Show(owner,
                    $"Разрешить приложению «{callerName}» использовать сохранённый сеанс Unofficial Telegram? Приложение сможет действовать от имени вашего аккаунта.",
                    "MiniApps · Доступ к аккаунту Telegram", MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.Yes) throw new ApiError("operation_cancelled", "Telegram access was declined");
                if (telegram.Get(SessionKey) is not JsonObject current || Fingerprint(current) != fingerprint)
                    throw new ApiError("telegram_session_changed", "The saved Telegram session changed");
                grant = new JsonObject { ["fingerprint"] = fingerprint };
                consent.Set(grantKey, grant);
            }
            finally { confirming = false; }
        }

        ApprovedFingerprint = fingerprint;
        return record;
    }

    private static string Fingerprint(JsonObject record) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(record.ToJsonString())));
}
