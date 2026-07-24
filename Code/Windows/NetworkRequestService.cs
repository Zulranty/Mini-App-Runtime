using System.Net;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Text;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

/** Cookie-free controlled HTTP transport shared with the bridge, with manual redirect policy checks. */
internal static class NetworkRequestValidator
{
    internal const int MaxRequestBytes = 10 * 1024 * 1024;
    internal const int MaxResponseBytes = 20 * 1024 * 1024;
    internal static bool ValidOrigin(string value) => System.Text.RegularExpressions.Regex.IsMatch(value, "^https?://(?:\\*\\.)?[A-Za-z0-9.-]+(?::[0-9]{1,5})?$") && TryRule(value, out _);

    internal static async Task<JsonObject> RequestAsync(NetworkPolicy? policy, JsonObject p)
    {
        if (policy is null) throw new ApiError("network_url_not_allowed", "Network allowlist is not configured");
        var url = ValidateUrl(Required(p, "url"), policy);
        var method = (p["method"]?.GetValue<string>() ?? "GET").ToUpperInvariant();
        if (method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE" or "HEAD" or "OPTIONS")) throw new ApiError("invalid_params", "Unsupported method");
        var timeout = p["timeoutMs"]?.GetValue<int>() ?? 30_000;
        if (timeout is < 1 or > 120_000) throw new ApiError("invalid_params", "timeoutMs is invalid");
        var headers = Headers(p); var body = Body(p);
        using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(timeout) };
        var redirected = false; string? authorization = null;
        for (var attempt = 0; attempt <= 5; attempt++)
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), url);
            foreach (var pair in headers)
            {
                if (pair.Key.Equals("authorization", StringComparison.OrdinalIgnoreCase)) authorization = pair.Value;
                request.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
            }
            if (authorization is not null && !request.Headers.Contains("Authorization")) request.Headers.TryAddWithoutValidation("Authorization", authorization);
            if (body is not null) request.Content = new ByteArrayContent(body);
            HttpResponseMessage response;
            try { response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead); }
            catch (TaskCanceledException) { throw new ApiError("network_timeout", "Request timed out"); }
            catch (HttpRequestException error) when (error.InnerException is AuthenticationException) { throw new ApiError("network_tls_failed", "TLS failed"); }
            catch (HttpRequestException) { throw new ApiError("network_request_failed", "Request failed"); }
            using (response)
            {
                if ((int)response.StatusCode is >= 301 and <= 308 && response.StatusCode != HttpStatusCode.NotModified)
                {
                    if (attempt == 5 || response.Headers.Location is null) throw new ApiError("network_redirect_blocked", "Redirect blocked");
                    var next = response.Headers.Location.IsAbsoluteUri ? response.Headers.Location : new Uri(url, response.Headers.Location);
                    if (!SameOrigin(url, next)) authorization = null;
                    url = ValidateUrl(next.ToString(), policy); redirected = true; continue;
                }
                var bytes = await ReadLimited(response.Content);
                var outputHeaders = new JsonObject();
                foreach (var header in response.Headers.Concat(response.Content.Headers).Take(100)) outputHeaders[header.Key.ToLowerInvariant()] = string.Join(",", header.Value);
                return new JsonObject { ["status"] = (int)response.StatusCode, ["ok"] = response.IsSuccessStatusCode, ["url"] = url.ToString(), ["redirected"] = redirected, ["headers"] = outputHeaders, ["body"] = new JsonObject { ["encoding"] = "text", ["data"] = Encoding.UTF8.GetString(bytes) } };
            }
        }
        throw new ApiError("network_redirect_blocked", "Redirect blocked");
    }

    private static Uri ValidateUrl(string value, NetworkPolicy policy)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || !string.IsNullOrEmpty(uri.UserInfo)) throw new ApiError("network_invalid_url", "Invalid URL");
        if (uri.Scheme == "http" && !policy.AllowHttp) throw new ApiError("network_url_not_allowed", "HTTP is not allowed");
        if (IsLocal(uri.Host) && !policy.AllowLocalNetwork) throw new ApiError("network_url_not_allowed", "Local network is not allowed");
        var allowed = policy.Allow.Any(rule => TryRule(rule, out var parsed) && RuleMatches(uri, parsed, policy.AllowSubdomains));
        if (!allowed) throw new ApiError("network_url_not_allowed", "URL is not allowed");
        return uri;
    }
    private static bool RuleMatches(Uri value, (string Scheme, string Host, int Port, bool Wildcard) rule, bool allowSubdomains)
    {
        if (!string.Equals(value.Scheme, rule.Scheme, StringComparison.OrdinalIgnoreCase) || value.Port != rule.Port) return false;
        return rule.Wildcard ? value.Host.EndsWith("." + rule.Host, StringComparison.OrdinalIgnoreCase) && !string.Equals(value.Host, rule.Host, StringComparison.OrdinalIgnoreCase) : string.Equals(value.Host, rule.Host, StringComparison.OrdinalIgnoreCase) || (allowSubdomains && value.Host.EndsWith("." + rule.Host, StringComparison.OrdinalIgnoreCase));
    }
    private static bool TryRule(string value, out (string Scheme, string Host, int Port, bool Wildcard) rule)
    {
        var wildcard = value.Contains("://*.", StringComparison.Ordinal); var normalized = wildcard ? value.Replace("://*.", "://wildcard.", StringComparison.Ordinal) : value;
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri) || uri.Port is < 1 or > 65535) { rule = default; return false; }
        rule = (uri.Scheme, wildcard ? uri.Host["wildcard.".Length..] : uri.Host, uri.Port, wildcard); return true;
    }
    private static bool IsLocal(string host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return true;
        if (!IPAddress.TryParse(host, out var address)) return false;
        var bytes = address.MapToIPv4().GetAddressBytes(); return IPAddress.IsLoopback(address) || address.IsIPv6LinkLocal || bytes[0] == 10 || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) || (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 169 && bytes[1] == 254);
    }
    private static Dictionary<string, string> Headers(JsonObject p)
    {
        var output = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); foreach (var item in p["headers"]?.AsObject() ?? []) { var name = item.Key; var value = item.Value?.GetValue<string>() ?? throw new ApiError("invalid_params", "Invalid header"); if (name.Equals("Host", StringComparison.OrdinalIgnoreCase) || name.Equals("Connection", StringComparison.OrdinalIgnoreCase) || name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) || name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) || name.Equals("Cookie", StringComparison.OrdinalIgnoreCase) || name.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase) || name.Equals("Proxy-Authorization", StringComparison.OrdinalIgnoreCase)) throw new ApiError("invalid_params", "Forbidden request header"); output[name] = value; } return output;
    }
    private static byte[]? Body(JsonObject p)
    {
        if (p["body"] is not JsonObject body) return null; var encoding = Required(body, "encoding"); byte[] bytes; try { bytes = encoding == "text" ? Encoding.UTF8.GetBytes(Required(body, "data")) : encoding == "base64" ? Convert.FromBase64String(Required(body, "data")) : throw new ApiError("invalid_params", "Invalid body encoding"); } catch (FormatException) { throw new ApiError("invalid_params", "Invalid base64 body"); } if (bytes.Length > MaxRequestBytes) throw new ApiError("network_request_too_large", "Request body is too large"); return bytes;
    }
    private static async Task<byte[]> ReadLimited(HttpContent content) { await using var input = await content.ReadAsStreamAsync(); using var output = new MemoryStream(); var buffer = new byte[8192]; while (true) { var read = await input.ReadAsync(buffer); if (read == 0) break; if (output.Length + read > MaxResponseBytes) throw new ApiError("network_response_too_large", "Response is too large"); await output.WriteAsync(buffer.AsMemory(0, read)); } return output.ToArray(); }
    private static string Required(JsonObject p, string name) => p[name]?.GetValue<string>() ?? throw new ApiError("invalid_params", $"{name} is required");
    private static bool SameOrigin(Uri a, Uri b) => a.Scheme == b.Scheme && a.Host == b.Host && a.Port == b.Port;
}
