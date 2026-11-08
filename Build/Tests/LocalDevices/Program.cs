using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;

// Exercises the compiled production service against a real UDP/HTTP device simulator.
if (args.Length != 1) throw new ArgumentException("Pass the freshly built MiniApps.dll");
var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
var type = assembly.GetType("MiniAppRuntime.Windows.LocalDeviceService", true)!;
var policyType = assembly.GetType("MiniAppRuntime.Windows.NetworkPolicy", true)!;
var manifestType = assembly.GetType("MiniAppRuntime.Windows.MiniManifest", true)!;
var api = Activator.CreateInstance(type, nonPublic: true)!;
var flags = BindingFlags.Instance | BindingFlags.NonPublic;
var policy = Activator.CreateInstance(policyType, new object[] { new HashSet<string>(), false, true, true, new HashSet<string> { "test-device" } })!;
var ip = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
    .OrderByDescending(n => n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211)
    .SelectMany(n => n.GetIPProperties().UnicastAddresses).Where(a => a.PrefixLength is >= 1 and <= 30).Select(a => a.Address)
    .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && (a.GetAddressBytes()[0] == 10 || a.GetAddressBytes()[0] == 192 && a.GetAddressBytes()[1] == 168 || a.GetAddressBytes()[0] == 172 && a.GetAddressBytes()[1] is >= 16 and <= 31))
    ?? throw new Exception("SETUP FAIL: test requires an active private IPv4 interface");
// Broadcast listeners must bind wildcard; reply only to probes from our chosen LAN.
using var udp = new UdpClient(new IPEndPoint(IPAddress.Any, 42101));
var http = new TcpListener(ip, 0); http.Start();
using var cancellation = new CancellationTokenSource();
var key = new string('a', 32); var token = new string('b', 32);
var probeSeen = 0; var commandSeen = 0; var authorizedSeen = 0;
var udpTask = Task.Run(async () => {
    try {
        while (true) {
            var packet = await udp.ReceiveAsync(cancellation.Token);
            if (!packet.RemoteEndPoint.Address.Equals(ip)) continue;
            var fields = Encoding.ASCII.GetString(packet.Buffer).Split(' ');
            if (fields.Length != 3 || fields[0] != "MINIAPP_DEVICE/1?" || fields[2] != "test-device") continue;
            // Let closed-port replies from other LAN hosts arrive before this device.
            if (Interlocked.Increment(ref probeSeen) == 1) await Task.Delay(500, cancellation.Token);
            var port = ((IPEndPoint)http.LocalEndpoint).Port;
            // Rejected records must not create capabilities.
            foreach (var text in new[] {
                $"MINIAPP_DEVICE/1! {new string('0',32)} test-device {key} {port} WrongNonce",
                $"MINIAPP_DEVICE/1! {fields[1]} other-service {key} {port} WrongService",
                $"MINIAPP_DEVICE/1! {fields[1]} test-device {key} 0 InvalidPort",
                $"MINIAPP_DEVICE/1! {fields[1]} test-device {key} {port} Test-Light" })
                await udp.SendAsync(Encoding.ASCII.GetBytes(text), packet.RemoteEndPoint, cancellation.Token);
        }
    } catch (OperationCanceledException) { } catch (SocketException) when (cancellation.IsCancellationRequested) { }
});
var httpTask = Task.Run(async () => {
    try {
        while (true) {
            using var client = await http.AcceptTcpClientAsync(cancellation.Token);
            await using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
            var first = await reader.ReadLineAsync(cancellation.Token) ?? "";
            var headers = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            while (await reader.ReadLineAsync(cancellation.Token) is { Length: > 0 } line) {
                var parts = line.Split(':',2); headers[parts[0]] = parts[1].Trim();
            }
            if (headers.ContainsKey("Cookie")) throw new Exception("Cookies were sent");
            var authorized = headers.GetValueOrDefault("X-Device-Token") == token;
            var redirect = first.Contains("/api/redirect ");
            var length = int.Parse(headers.GetValueOrDefault("Content-Length", "0"));
            if (length > 0) {
                var buffer = new char[length]; await reader.ReadBlockAsync(buffer, cancellation.Token);
                if (authorized && new string(buffer) == "on=1&brightness=0") Interlocked.Increment(ref commandSeen);
            }
            if (authorized) Interlocked.Increment(ref authorizedSeen);
            var body = authorized ? "{\"on\":true,\"brightness\":0}" : "{\"error\":\"unauthorized\"}";
            var status = redirect ? "302 Found" : authorized ? "200 OK" : "401 Unauthorized";
            var output = Encoding.UTF8.GetBytes($"HTTP/1.1 {status}\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\nConnection: close\r\nLocation: http://example.com/\r\n\r\n{body}");
            await stream.WriteAsync(output, cancellation.Token);
        }
    } catch (OperationCanceledException) { } catch (SocketException) when (cancellation.IsCancellationRequested) { }
});
var count = 0;
void Check(bool value, string name) { if (!value) throw new Exception("FAIL " + name); Console.WriteLine("PASS " + name); count++; }
async Task<JsonNode> Call(string method, object? config, JsonObject parameters) {
    var task = (Task)type.GetMethod(method, flags)!.Invoke(api, new object?[] { config, parameters })!;
    await task; return (JsonNode)task.GetType().GetProperty("Result")!.GetValue(task)!;
}
async Task Reject(string method, object? config, JsonObject parameters, string code) {
    try { await Call(method, config, parameters); throw new Exception("Expected " + code); }
    catch (Exception e) when (e.GetType().GetProperty("Code")?.GetValue(e)?.ToString() == code) { Check(true, code); }
}
try {
    var parse = manifestType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static)!;
    var manifest = "{\"id\":\"test.local\",\"name\":\"Test\",\"version\":\"1.0.0\",\"sdkVersion\":2,\"permissions\":[\"network\"],\"network\":{\"allow\":[],\"allowHttp\":true,\"allowLocalNetwork\":true,\"discoveryServices\":[\"test-device\"]}}";
    Check(parse.Invoke(null, new object[] { manifest }) is not null, "discovery-only manifest accepted");
    try { parse.Invoke(null, new object[] { manifest.Replace("\"allowLocalNetwork\":true", "\"allowLocalNetwork\":false") }); throw new Exception("Expected manifest rejection"); }
    catch (TargetInvocationException e) when (e.InnerException?.GetType().GetProperty("Code")?.GetValue(e.InnerException)?.ToString() == "source_file_invalid") { Check(true, "manifest local policy enforced"); }
    await Reject("DiscoverAsync", null, new() { ["service"] = "test-device" }, "network_url_not_allowed");
    await Reject("DiscoverAsync", policy, new() { ["service"] = "other-service" }, "network_url_not_allowed");
    await Reject("DiscoverAsync", policy, new() { ["service"] = "bad service" }, "invalid_params");
    await Reject("DiscoverAsync", policy, new() { ["service"] = "test-device\n" }, "invalid_params");
    var result = (await Call("DiscoverAsync", policy, new() { ["service"] = "test-device", ["timeoutMs"] = 1200 })).AsArray();
    Check(result.Count == 1 && result[0]!["name"]!.GetValue<string>() == "Test-Light" && probeSeen > 0, "real UDP discovery, invalid records rejected");
    Check(result[0]!["address"] is null && result[0]!["port"] is null, "opaque endpoint capability");
    var id = result[0]!["id"]!.GetValue<string>();
    var again = (await Call("DiscoverAsync", policy, new() { ["service"] = "test-device", ["timeoutMs"] = 1000 })).AsArray();
    Check(again[0]!["id"]!.GetValue<string>() == id, "stable capability on rediscovery");
    var denied = await Call("RequestAsync", policy, new() { ["id"] = id, ["path"] = "/api/state" });
    Check(denied["status"]!.GetValue<int>() == 401, "unauthenticated request cannot control device");
    var state = await Call("RequestAsync", policy, new() { ["id"] = id, ["path"] = "/api/state", ["method"] = "POST", ["token"] = token, ["body"] = "on=1&brightness=0" });
    Check(state["ok"]!.GetValue<bool>() && commandSeen == 1 && authorizedSeen == 1 && state["url"] is null, "real authenticated HTTP, zero brightness, endpoint hidden");
    await Reject("RequestAsync", policy, new() { ["id"] = id, ["path"] = "/api/redirect", ["token"] = token }, "network_redirect_blocked");
    await Reject("RequestAsync", policy, new() { ["id"] = id, ["path"] = "http://example.com/" }, "invalid_params");
    await Reject("RequestAsync", policy, new() { ["id"] = id, ["path"] = "/api/state\n" }, "invalid_params");
    await Reject("RequestAsync", policy, new() { ["id"] = "foreign-handle", ["path"] = "/api/state" }, "device_not_found");
    Console.WriteLine($"{count} production native checks passed");
} finally {
    ((IDisposable)api).Dispose(); cancellation.Cancel(); udp.Close(); http.Stop(); await Task.WhenAll(udpTask, httpTask);
}
