using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MiniAppRuntime.Windows;

// App-scoped discovery capabilities. UDP announces endpoints; it never runs commands.
internal sealed class LocalDeviceService : IDisposable
{
    internal const int DiscoveryPort = 42101;
    private const int MaxBodyBytes = 64 * 1024;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim discoveryGate = new(1, 1);
    private readonly SemaphoreSlim requestGate = new(4, 4);
    private readonly object sync = new();
    private readonly Dictionary<string, Device> devices = [];
    private sealed record Device(string Id, string Key, string Service, string Name, IPAddress Address, int Port, long Seen);
    private sealed record Subnet(IPAddress Address, IPAddress Mask);

    internal static bool ValidService(string value) => Regex.IsMatch(value, "^[a-z][a-z0-9-]{0,47}\\z");
    private static uint Number(IPAddress address) => System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(address.GetAddressBytes());
    private static IPAddress Address(uint number) => new(new byte[] { (byte)(number >> 24), (byte)(number >> 16), (byte)(number >> 8), (byte)number });
    private static bool Private(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = address.GetAddressBytes();
        return b[0] == 10 || (b[0] == 172 && b[1] is >= 16 and <= 31) || (b[0] == 192 && b[1] == 168);
    }
    private static List<Subnet> Subnets() => NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => Private(a.Address) && a.PrefixLength is >= 1 and <= 30)
        .Select(a => new Subnet(a.Address, a.IPv4Mask)).Take(8).ToList();

    private static void RequirePolicy(NetworkPolicy? policy, string service)
    {
        if (policy is null || !policy.AllowHttp || !policy.AllowLocalNetwork || policy.DiscoveryServices?.Contains(service) != true)
            throw new ApiError("network_url_not_allowed", "Local device service is not allowed by the manifest");
    }

    internal async Task<JsonArray> DiscoverAsync(NetworkPolicy? policy, JsonObject parameters)
    {
        var service = parameters["service"]?.GetValue<string>() ?? "";
        if (!ValidService(service)) throw new ApiError("invalid_params", "Invalid service");
        RequirePolicy(policy, service);
        var timeout = parameters["timeoutMs"]?.GetValue<int>() ?? 2500;
        if (timeout is < 1000 or > 5000) throw new ApiError("invalid_params", "Discovery timeout must be 1000..5000 ms");
        if (!await discoveryGate.WaitAsync(0, lifetime.Token)) throw new ApiError("discovery_busy", "Discovery is already running");
        try
        {
            var subnets = Subnets();
            if (subnets.Count == 0) throw new ApiError("network_unavailable", "No private IPv4 LAN is available");
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
            var probe = Encoding.ASCII.GetBytes($"MINIAPP_DEVICE/1? {nonce} {service}");
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            deadline.CancelAfter(timeout);
            var found = new Dictionary<string, Device>();
            // One receiver per interface: receive while sending so small UDP buffers cannot lose replies.
            await Task.WhenAll(subnets.Select(subnet => ProbeAsync(subnet, probe, nonce, service, found, deadline.Token)));
            lock (sync)
            {
                Prune();
                return new JsonArray(found.Values.OrderBy(d => d.Name).Select(d => (JsonNode)new JsonObject
                {
                    ["id"] = d.Id, ["deviceId"] = d.Key, ["name"] = d.Name, ["service"] = d.Service
                }).ToArray());
            }
        }
        finally { discoveryGate.Release(); }
    }

    private async Task ProbeAsync(Subnet subnet, byte[] probe, string nonce, string service, Dictionary<string, Device> found, CancellationToken cancellation)
    {
        using var udp = new UdpClient(new IPEndPoint(subnet.Address, 0)) { EnableBroadcast = true };
        // Closed UDP ports are normal during a subnet scan. Do not let their ICMP
        // PORT_UNREACHABLE replies terminate reception from the actual devices.
        const int sioUdpConnReset = unchecked((int)0x9800000C);
        udp.Client.IOControl(sioUdpConnReset, new byte[4], null); // Windows BOOL FALSE.
        var receiver = ReceiveAsync();
        try
        {
            var local = Number(subnet.Address); var mask = Number(subnet.Mask); var network = local & mask;
            var broadcast = network | ~mask;
            await udp.SendAsync(probe, new IPEndPoint(Address(broadcast), DiscoveryPort), cancellation);
            // Bound fallback to /24 or smaller; wider networks use directed broadcasts.
            if (broadcast - network <= 255)
                for (var host = network + 1; host < broadcast; host++)
                {
                    if (host == local) continue;
                    await udp.SendAsync(probe, new IPEndPoint(Address(host), DiscoveryPort), cancellation);
                    await Task.Delay(2, cancellation);
                }
            await Task.Delay(Timeout.Infinite, cancellation);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch (SocketException) { /* Another interface can still discover devices. */ }
        finally { udp.Close(); await receiver; }

        async Task ReceiveAsync()
        {
            try
            {
                while (!cancellation.IsCancellationRequested)
                {
                    var reply = await udp.ReceiveAsync(cancellation);
                    if (reply.RemoteEndPoint.Port != DiscoveryPort || reply.Buffer.Length > 256 || !Private(reply.RemoteEndPoint.Address)) continue;
                    if ((Number(reply.RemoteEndPoint.Address) & Number(subnet.Mask)) != (Number(subnet.Address) & Number(subnet.Mask))) continue;
                    var fields = Encoding.ASCII.GetString(reply.Buffer).Split(' ');
                    if (fields.Length != 6 || fields[0] != "MINIAPP_DEVICE/1!" || fields[1] != nonce || fields[2] != service ||
                        !Regex.IsMatch(fields[3], "^[a-f0-9]{32}\\z") || !int.TryParse(fields[4], out var port) || port is < 1 or > 65535 ||
                        !Regex.IsMatch(fields[5], "^[A-Za-z0-9_-]{1,48}\\z")) continue;
                    lock (sync)
                    {
                        Prune();
                        var identity = $"{service}/{fields[3]}/{reply.RemoteEndPoint.Address}";
                        if (found.Count >= 64 && !found.ContainsKey(identity)) continue;
                        var existing = devices.Values.FirstOrDefault(d => d.Service == service && d.Key == fields[3] && d.Address.Equals(reply.RemoteEndPoint.Address));
                        if (devices.Count >= 64 && existing is null) continue;
                        var device = new Device(existing?.Id ?? Guid.NewGuid().ToString("N"), fields[3], service, fields[5], reply.RemoteEndPoint.Address, port, Environment.TickCount64);
                        devices[device.Id] = device; found[identity] = device;
                    }
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
            catch (ObjectDisposedException) { }
            catch (SocketException) { }
        }
    }

    private void Prune()
    {
        foreach (var key in devices.Where(d => Environment.TickCount64 - d.Value.Seen > 60_000).Select(d => d.Key).ToArray()) devices.Remove(key);
    }

    internal async Task<JsonObject> RequestAsync(NetworkPolicy? policy, JsonObject parameters)
    {
        Device device;
        lock (sync)
        {
            Prune();
            if (!devices.TryGetValue(parameters["id"]?.GetValue<string>() ?? "", out device!)) throw new ApiError("device_not_found", "Discover the device again");
        }
        RequirePolicy(policy, device.Service);
        var path = parameters["path"]?.GetValue<string>() ?? "";
        var method = parameters["method"]?.GetValue<string>() ?? "GET";
        var token = parameters["token"]?.GetValue<string>() ?? "";
        var body = parameters["body"]?.GetValue<string>() ?? "";
        var timeout = parameters["timeoutMs"]?.GetValue<int>() ?? 4000;
        if (!Regex.IsMatch(path, "^/api/[a-zA-Z0-9_/-]{1,80}\\z") || path.Contains("//", StringComparison.Ordinal) || method is not ("GET" or "POST") ||
            (token != "" && !Regex.IsMatch(token, "^[a-f0-9]{32}\\z")) || Encoding.UTF8.GetByteCount(body) > 4096 || (method == "GET" && body != "") || timeout is < 1 or > 10_000)
            throw new ApiError("invalid_params", "Invalid device request");
        if (!await requestGate.WaitAsync(0, lifetime.Token)) throw new ApiError("device_busy", "Too many device requests");
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
            deadline.CancelAfter(timeout);
            using var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false };
            using var client = new HttpClient(handler);
            using var request = new HttpRequestMessage(new HttpMethod(method), $"http://{device.Address}:{device.Port}{path}");
            request.Headers.ConnectionClose = true;
            if (token != "") request.Headers.Add("X-Device-Token", token);
            if (method == "POST") request.Content = new StringContent(body, Encoding.UTF8, "application/x-www-form-urlencoded");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if ((int)response.StatusCode is >= 300 and <= 399) throw new ApiError("network_redirect_blocked", "Device redirects are not allowed");
            await using var input = await response.Content.ReadAsStreamAsync(deadline.Token);
            using var output = new MemoryStream(); var buffer = new byte[4096];
            while (true)
            {
                var count = await input.ReadAsync(buffer, deadline.Token);
                if (count == 0) break;
                if (output.Length + count > MaxBodyBytes) throw new ApiError("network_response_too_large", "Device response is too large");
                output.Write(buffer, 0, count);
            }
            return new JsonObject { ["status"] = (int)response.StatusCode, ["ok"] = response.IsSuccessStatusCode,
                ["body"] = new JsonObject { ["encoding"] = "text", ["data"] = Encoding.UTF8.GetString(output.ToArray()) } };
        }
        catch (OperationCanceledException) { throw new ApiError("network_timeout", "Device request cancelled or timed out"); }
        catch (HttpRequestException) { throw new ApiError("network_request_failed", "Device request failed"); }
        finally { requestGate.Release(); }
    }

    public void Dispose() { lifetime.Cancel(); lock (sync) devices.Clear(); }
}
