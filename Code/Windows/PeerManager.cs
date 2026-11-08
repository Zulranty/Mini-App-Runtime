using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MiniAppRuntime.Windows;

/// <summary>
/// Process-wide DNS-SD advertiser/browser and local TCP endpoint.  Network
/// endpoints intentionally never leave this type: callers receive peer ids only.
/// </summary>
internal sealed class PeerManager : IDisposable
{
    public static PeerManager Instance { get; } = new();
    private const string ServiceName = "_miniapps-peer._tcp.local";
    private const int MdnsPort = 5353;
    private const int ProbePort = 41234;
    private const int PeerTtlSeconds = 15;
    private const int MaxFrameBytes = 64 * 1024;
    private const int MaxChannelLength = 80;
    private readonly object gate = new();
    private readonly Dictionary<string, Peer> peers = [];
    private readonly Dictionary<string, TcpClient> connections = [];
    private readonly Dictionary<string, Channel> channels = [];
    private readonly Dictionary<string, List<Action<string, JsonNode>>> listeners = [];
    private TcpListener? listener;
    private UdpClient? mdns;
    private UdpClient? probe;
    private CancellationTokenSource? cancellation;
    private string? deviceId;
    private string? deviceName;
    private int listenerPort;
    private static readonly byte[] ProbeRequest = "MAPD1?"u8.ToArray();
    private static readonly byte[] ProbeResponse = "MAPD1!"u8.ToArray();

    private sealed class Peer(string id, string name, string platform, string runtimeVersion, IPEndPoint endpoint)
    {
        public string Id { get; } = id;
        public string Name { get; set; } = name;
        public string Platform { get; set; } = platform;
        public string RuntimeVersion { get; set; } = runtimeVersion;
        public IPEndPoint Endpoint { get; set; } = endpoint;
        public DateTimeOffset LastSeen { get; set; } = DateTimeOffset.UtcNow;
    }

    private sealed record Channel(string PeerId, string AppId, string Name);

    public void Subscribe(string appId, Action<string, JsonNode> callback)
    {
        lock (gate)
        {
            if (!listeners.TryGetValue(appId, out var callbacks)) listeners[appId] = callbacks = [];
            if (!callbacks.Contains(callback)) callbacks.Add(callback);
        }
    }

    public void Unsubscribe(string appId, Action<string, JsonNode> callback)
    {
        lock (gate)
        {
            if (listeners.TryGetValue(appId, out var callbacks))
            {
                callbacks.Remove(callback);
                if (callbacks.Count == 0) { listeners.Remove(appId); RemoveChannelsForApp(appId); }
            }
        }
    }

    public void Start()
    {
        lock (gate)
        {
            if (listener is not null) { _ = ProbeScanAsync(); return; }
            deviceId ??= LoadDeviceId();
            deviceName ??= Environment.MachineName.Length > 80 ? Environment.MachineName[..80] : Environment.MachineName;
            listener = new TcpListener(IPAddress.Any, 0);
            listener.Start();
            listenerPort = ((IPEndPoint)listener.LocalEndpoint).Port;
            cancellation = new CancellationTokenSource();
            mdns = CreateMdnsClient();
            probe = CreateProbeClient();
            _ = AcceptLoopAsync(listener, cancellation.Token);
            _ = MdnsReceiveLoopAsync(mdns, cancellation.Token);
            _ = ProbeReceiveLoopAsync(probe, cancellation.Token);
            _ = MdnsAnnounceLoopAsync(cancellation.Token);
            _ = ProbeScanAsync();
        }
    }

    public JsonArray List()
    {
        lock (gate)
        {
            ExpirePeers();
            return new JsonArray(peers.Values.OrderBy(peer => peer.Name, StringComparer.OrdinalIgnoreCase).Select(peer => (JsonNode)new JsonObject
            {
                ["id"] = peer.Id, ["name"] = peer.Name, ["platform"] = peer.Platform,
                ["runtimeVersion"] = peer.RuntimeVersion, ["status"] = "available",
                ["connectionStatus"] = connections.ContainsKey(peer.Id) ? "connected" : "disconnected",
                ["lastSeenAt"] = peer.LastSeen.ToString("O")
            }).ToArray());
        }
    }

    /// <summary>Connects by opaque peer id; the discovered address stays private.</summary>
    public async Task ConnectAsync(string peerId, CancellationToken token = default)
    {
        Peer peer;
        lock (gate)
        {
            ExpirePeers();
            if (!peers.TryGetValue(peerId, out peer!)) throw new ApiError("peer_not_found", "Peer is not available");
            if (connections.ContainsKey(peerId)) return;
        }
        var client = new TcpClient(peer.Endpoint.AddressFamily);
        try
        {
            await client.ConnectAsync(peer.Endpoint.Address, peer.Endpoint.Port, token);
            await WriteHelloAsync(client.GetStream(), token);
            var remoteId = await ReadHelloAsync(client.GetStream(), token);
            if (!string.Equals(remoteId, peerId, StringComparison.Ordinal)) throw new ApiError("peer_handshake_failed", "Peer identity did not match discovery");
            lock (gate)
            {
                if (connections.TryGetValue(peerId, out var duplicate)) { client.Dispose(); return; }
                connections[peerId] = client;
            }
            RegisterConnection(peerId, client);
        }
        catch { client.Dispose(); throw; }
    }

    public void Disconnect(string peerId)
    {
        CloseConnection(peerId, "disconnected");
    }

    public JsonObject OpenChannel(string appId, string peerId, string name)
    {
        var id = PeerId(peerId); var channel = ChannelName(name);
        lock (gate)
        {
            RequireConnection(id);
            channels[ChannelKey(id, appId, channel)] = new Channel(id, appId, channel);
        }
        SendFrame(id, new JsonObject { ["type"] = "channel.open", ["appId"] = appId, ["channel"] = channel });
        var result = ChannelPayload(id, channel); Emit(appId, "peers.channelOpened", result); return result;
    }

    public JsonObject CloseChannel(string appId, string peerId, string name)
    {
        var id = PeerId(peerId); var channel = ChannelName(name);
        lock (gate)
        {
            if (!channels.Remove(ChannelKey(id, appId, channel))) throw new ApiError("peer_channel_not_found", "Channel is not open");
        }
        try { SendFrame(id, new JsonObject { ["type"] = "channel.close", ["appId"] = appId, ["channel"] = channel }); } catch (ApiError) { }
        var result = ChannelPayload(id, channel); Emit(appId, "peers.channelClosed", result); return result;
    }

    public JsonObject SendMessage(string appId, string peerId, string name, JsonNode? message)
    {
        var id = PeerId(peerId); var channel = ChannelName(name);
        lock (gate) if (!channels.ContainsKey(ChannelKey(id, appId, channel))) throw new ApiError("peer_channel_not_found", "Channel is not open");
        SendFrame(id, new JsonObject { ["type"] = "message", ["appId"] = appId, ["channel"] = channel, ["message"] = message?.DeepClone() });
        return ChannelPayload(id, channel);
    }

    public JsonArray Connections()
    {
        lock (gate)
        {
            return new JsonArray(connections.Keys.Select(id => (JsonNode)new JsonObject
            {
                ["peerId"] = id, ["status"] = "connected"
            }).ToArray());
        }
    }

    public void Stop()
    {
        lock (gate)
        {
            cancellation?.Cancel(); cancellation?.Dispose(); cancellation = null;
            listener?.Stop(); listener = null;
            mdns?.Dispose(); mdns = null;
            probe?.Dispose(); probe = null;
            foreach (var client in connections.Values) client.Dispose();
            connections.Clear(); channels.Clear(); peers.Clear(); listenerPort = 0;
        }
    }

    private static UdpClient CreateMdnsClient()
    {
        var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        client.ExclusiveAddressUse = false;
        client.Client.Bind(new IPEndPoint(IPAddress.Any, MdnsPort));
        client.JoinMulticastGroup(IPAddress.Parse("224.0.0.251"));
        return client;
    }

    private static UdpClient CreateProbeClient()
    {
        var client = new UdpClient(AddressFamily.InterNetwork);
        client.Client.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
        client.ExclusiveAddressUse = false;
        client.Client.Bind(new IPEndPoint(IPAddress.Any, ProbePort));
        return client;
    }

    private async Task ProbeReceiveLoopAsync(UdpClient socket, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var packet = await socket.ReceiveAsync(token);
                if (packet.Buffer.AsSpan().SequenceEqual(ProbeRequest)) { await SendProbeResponseAsync(socket, packet.RemoteEndPoint); continue; }
                if (!packet.Buffer.AsSpan().StartsWith(ProbeResponse)) continue;
                try
                {
                    var node = JsonNode.Parse(Encoding.UTF8.GetString(packet.Buffer, ProbeResponse.Length, packet.Buffer.Length - ProbeResponse.Length))?.AsObject();
                    var id = node?["id"]?.GetValue<string>(); var port = node?["port"]?.GetValue<int>() ?? 0;
                    if (!string.IsNullOrWhiteSpace(id) && port is > 0 and <= 65535)
                        UpdatePeer(new DnsAdvertisement(id, node?["name"]?.GetValue<string>() ?? "Device", node?["platform"]?.GetValue<string>() ?? "unknown", node?["version"]?.GetValue<string>() ?? "unknown", "1", port, packet.RemoteEndPoint.Address));
                }
                catch (JsonException) { }
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (SocketException) { }
    }

    private async Task SendProbeResponseAsync(UdpClient socket, IPEndPoint target)
    {
        byte[] packet;
        lock (gate)
        {
            var body = JsonSerializer.SerializeToUtf8Bytes(new { id = deviceId, name = deviceName, platform = "windows", version = "1.5.0", port = listenerPort });
            packet = new byte[ProbeResponse.Length + body.Length]; ProbeResponse.CopyTo(packet, 0); body.CopyTo(packet, ProbeResponse.Length);
        }
        await socket.SendAsync(packet, target);
    }

    /// <summary>Sends one bounded discovery datagram to .1 through .200 on each active IPv4 subnet.</summary>
    private async Task ProbeScanAsync()
    {
        UdpClient? socket; IPAddress[] local;
        lock (gate) { socket = probe; local = NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback).SelectMany(n => n.GetIPProperties().UnicastAddresses).Select(a => a.Address).Where(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)).ToArray(); }
        if (socket is null) return;
        foreach (var address in local)
        {
            var bytes = address.GetAddressBytes();
            for (var last = 1; last <= 200; last++)
            {
                if (bytes[3] == last) continue;
                var target = new IPAddress(new byte[] { bytes[0], bytes[1], bytes[2], (byte)last });
                try { await socket.SendAsync(ProbeRequest, new IPEndPoint(target, ProbePort)); } catch (SocketException) { }
            }
        }
    }

    private async Task AcceptLoopAsync(TcpListener socket, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var client = await socket.AcceptTcpClientAsync(token);
                _ = HandleIncomingAsync(client, token);
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    // A bounded HELLO preface avoids treating arbitrary LAN traffic as a peer.
    private async Task HandleIncomingAsync(TcpClient client, CancellationToken shutdown)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(shutdown);
        var registered = false;
        try
        {
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var remoteId = await ReadHelloAsync(client.GetStream(), timeout.Token);
            if (string.IsNullOrEmpty(remoteId) || remoteId == deviceId) return;
            await WriteHelloAsync(client.GetStream(), timeout.Token);
            lock (gate)
            {
                // The deterministic id ordering retains exactly one connection during a race.
                if (connections.ContainsKey(remoteId)) return;
                connections[remoteId] = client;
            }
            RegisterConnection(remoteId, client);
            registered = true;
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        finally
        {
            if (!registered) lock (gate)
            {
                foreach (var item in connections.Where(item => ReferenceEquals(item.Value, client)).ToArray()) CloseConnection(item.Key, "disconnected");
            }
            if (!registered) client.Dispose();
        }
    }

    private async Task MdnsReceiveLoopAsync(UdpClient client, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var packet = await client.ReceiveAsync(token);
                var message = DnsMessage.Parse(packet.Buffer);
                if (message.IsServiceQuery(ServiceName)) await SendAnnouncementAsync();
                foreach (var advertisement in message.GetAdvertisements(ServiceName, packet.RemoteEndPoint.Address)) UpdatePeer(advertisement);
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (SocketException) { }
    }

    private async Task MdnsAnnounceLoopAsync(CancellationToken token)
    {
        try
        {
            await SendQueryAsync();
            await SendAnnouncementAsync();
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
            while (await timer.WaitForNextTickAsync(token))
            {
                await SendQueryAsync();
                await SendAnnouncementAsync();
                lock (gate) ExpirePeers();
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task SendQueryAsync()
    {
        UdpClient? socket;
        lock (gate) socket = mdns;
        if (socket is not null) await socket.SendAsync(DnsMessage.Query(ServiceName), new IPEndPoint(IPAddress.Parse("224.0.0.251"), MdnsPort));
    }

    private async Task SendAnnouncementAsync()
    {
        UdpClient? socket;
        byte[] packet;
        lock (gate) { socket = mdns; packet = DnsMessage.Advertisement(ServiceName, deviceId!, deviceName!, listenerPort, LocalIpv4()); }
        if (socket is not null) await socket.SendAsync(packet, new IPEndPoint(IPAddress.Parse("224.0.0.251"), MdnsPort));
    }

    private void UpdatePeer(DnsAdvertisement item)
    {
        if (item.DeviceId == deviceId || item.ProtocolVersion != "1" || item.Port is < 1 or > 65535) return;
        lock (gate)
        {
            var endpoint = new IPEndPoint(item.Address, item.Port);
            if (!peers.TryGetValue(item.DeviceId, out var peer)) peers[item.DeviceId] = new Peer(item.DeviceId, item.Name, item.Platform, item.RuntimeVersion, endpoint);
            else { peer.Name = item.Name; peer.Platform = item.Platform; peer.RuntimeVersion = item.RuntimeVersion; peer.Endpoint = endpoint; peer.LastSeen = DateTimeOffset.UtcNow; }
        }
    }

    private void ExpirePeers()
    {
        var cutoff = DateTimeOffset.UtcNow.AddSeconds(-PeerTtlSeconds);
        foreach (var id in peers.Where(item => item.Value.LastSeen < cutoff).Select(item => item.Key).ToArray()) { peers.Remove(id); Disconnect(id); }
    }

    private async Task WriteHelloAsync(NetworkStream stream, CancellationToken token)
    {
        var bytes = Encoding.UTF8.GetBytes(deviceId!);
        await stream.WriteAsync(new byte[] { (byte)'M', (byte)'A', (byte)'P', (byte)'1', (byte)bytes.Length }, token);
        await stream.WriteAsync(bytes, token); await stream.FlushAsync(token);
    }

    private static async Task<string?> ReadHelloAsync(NetworkStream stream, CancellationToken token)
    {
        var header = new byte[5]; await ReadExactlyAsync(stream, header, token);
        if (header[0] != 'M' || header[1] != 'A' || header[2] != 'P' || header[3] != '1' || header[4] is 0 or > 64) return null;
        var id = new byte[header[4]]; await ReadExactlyAsync(stream, id, token);
        return Encoding.UTF8.GetString(id);
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken token)
    {
        var offset = 0;
        while (offset < buffer.Length) { var count = await stream.ReadAsync(buffer.AsMemory(offset), token); if (count == 0) throw new IOException("Peer disconnected"); offset += count; }
    }

    private void RegisterConnection(string peerId, TcpClient client)
    {
        EmitAll("peers.connectionChanged", new JsonObject { ["peerId"] = peerId, ["status"] = "connected" });
        EmitAll("peers.changed", List());
        _ = ReadFramesAsync(peerId, client, cancellation?.Token ?? CancellationToken.None);
    }

    private async Task ReadFramesAsync(string peerId, TcpClient client, CancellationToken token)
    {
        try { while (!token.IsCancellationRequested) HandleFrame(peerId, await ReadFrameAsync(client.GetStream(), token)); }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (ApiError) { }
        catch (ObjectDisposedException) { }
        finally { CloseConnection(peerId, "disconnected"); }
    }

    private void HandleFrame(string peerId, JsonObject frame)
    {
        var appId = frame["appId"]?.GetValue<string>();
        var name = frame["channel"]?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(appId) || name is null) return;
        string channel;
        try { channel = ChannelName(name); } catch (ApiError) { return; }
        lock (gate) if (!listeners.ContainsKey(appId)) return;
        switch (frame["type"]?.GetValue<string>())
        {
            case "channel.open":
                lock (gate) channels[ChannelKey(peerId, appId, channel)] = new Channel(peerId, appId, channel);
                Emit(appId, "peers.channelOpened", ChannelPayload(peerId, channel)); break;
            case "channel.close":
                lock (gate) channels.Remove(ChannelKey(peerId, appId, channel));
                Emit(appId, "peers.channelClosed", ChannelPayload(peerId, channel)); break;
            case "message":
                lock (gate) if (!channels.ContainsKey(ChannelKey(peerId, appId, channel))) return;
                var payload = ChannelPayload(peerId, channel); payload["message"] = frame["message"]?.DeepClone();
                Emit(appId, "peers.message", payload); break;
        }
    }

    private void SendFrame(string peerId, JsonObject frame)
    {
        var data = Encoding.UTF8.GetBytes(frame.ToJsonString());
        if (data.Length is < 2 or > MaxFrameBytes) throw new ApiError("peer_message_too_large", "Peer frame is too large");
        TcpClient client; lock (gate) client = RequireConnection(peerId);
        try
        {
            lock (client) { var stream = client.GetStream(); stream.WriteByte((byte)(data.Length >> 24)); stream.WriteByte((byte)(data.Length >> 16)); stream.WriteByte((byte)(data.Length >> 8)); stream.WriteByte((byte)data.Length); stream.Write(data); stream.Flush(); }
        }
        catch { CloseConnection(peerId, "disconnected"); throw new ApiError("peer_connection_failed", "Could not send to peer"); }
    }

    private static async Task<JsonObject> ReadFrameAsync(NetworkStream stream, CancellationToken token)
    {
        var header = new byte[4]; await ReadExactlyAsync(stream, header, token);
        var length = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | header[3];
        if (length is < 2 or > MaxFrameBytes) throw new ApiError("peer_protocol_error", "Invalid peer frame");
        var data = new byte[length]; await ReadExactlyAsync(stream, data, token);
        try { return JsonNode.Parse(Encoding.UTF8.GetString(data))?.AsObject() ?? throw new ApiError("peer_protocol_error", "Invalid peer frame"); }
        catch (JsonException) { throw new ApiError("peer_protocol_error", "Invalid peer frame"); }
    }

    private TcpClient RequireConnection(string peerId) => connections.TryGetValue(peerId, out var client) ? client : throw new ApiError("peer_not_connected", "Peer is not connected");
    private static string ChannelKey(string peerId, string appId, string name) => peerId + "\0" + appId + "\0" + name;
    private static string ChannelName(string value) { if (string.IsNullOrWhiteSpace(value) || value.Length > MaxChannelLength || value.Any(ch => char.IsControl(ch))) throw new ApiError("invalid_params", "Invalid channel name"); return value; }
    private static string PeerId(string value) { if (string.IsNullOrWhiteSpace(value) || value.Length > 64) throw new ApiError("invalid_params", "Invalid peer id"); return value; }
    private static JsonObject ChannelPayload(string peerId, string channel) => new() { ["peerId"] = peerId, ["channel"] = channel };
    private void Emit(string appId, string name, JsonNode payload)
    {
        Action<string, JsonNode>[] targets; lock (gate) targets = listeners.TryGetValue(appId, out var callbacks) ? callbacks.ToArray() : [];
        foreach (var target in targets) try { target(name, payload.DeepClone()); } catch { }
    }
    private void EmitAll(string name, JsonNode payload)
    {
        Action<string, JsonNode>[] targets; lock (gate) targets = listeners.Values.SelectMany(value => value).ToArray();
        foreach (var target in targets) try { target(name, payload.DeepClone()); } catch { }
    }
    private void CloseConnection(string peerId, string status)
    {
        TcpClient? client; lock (gate) { if (!connections.Remove(peerId, out client)) return; foreach (var key in channels.Where(item => item.Value.PeerId == peerId).Select(item => item.Key).ToArray()) channels.Remove(key); }
        client.Dispose(); EmitAll("peers.connectionChanged", new JsonObject { ["peerId"] = peerId, ["status"] = status }); EmitAll("peers.changed", List());
    }
    private void RemoveChannelsForApp(string appId) { foreach (var key in channels.Where(item => item.Value.AppId == appId).Select(item => item.Key).ToArray()) channels.Remove(key); }

    private static IPAddress LocalIpv4() => NetworkInterface.GetAllNetworkInterfaces().Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback).SelectMany(n => n.GetIPProperties().UnicastAddresses).Select(a => a.Address).FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork && !IPAddress.IsLoopback(a)) ?? IPAddress.Loopback;

    private static string LoadDeviceId()
    {
        var path = Path.Combine(MiniStore.DataRoot, "peer-device-id.txt");
        try { if (File.Exists(path) && !string.IsNullOrWhiteSpace(File.ReadAllText(path))) return File.ReadAllText(path).Trim(); Directory.CreateDirectory(Path.GetDirectoryName(path)!); var value = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)); File.WriteAllText(path, value); return value; }
        catch { return Convert.ToHexString(RandomNumberGenerator.GetBytes(16)); }
    }

    public void Dispose() => Stop();
}

internal sealed record DnsAdvertisement(string DeviceId, string Name, string Platform, string RuntimeVersion, string ProtocolVersion, int Port, IPAddress Address);

/// <summary>Small, strict DNS parser/writer for the records used by DNS-SD.</summary>
internal sealed class DnsMessage
{
    private readonly List<string> questions = [];
    private readonly List<DnsRecord> records = [];
    private sealed record DnsRecord(string Name, ushort Type, byte[] Data);
    public static byte[] Query(string service) { var bytes = new List<byte>(12); bytes[4] = 0; bytes[5] = 1; WriteName(bytes, service); WriteU16(bytes, 12); WriteU16(bytes, 1); return [.. bytes]; }
    public static byte[] Advertisement(string service, string id, string displayName, int port, IPAddress address)
    {
        var instance = $"MiniApps-{id[..Math.Min(8, id.Length)]}.{service}"; var host = $"miniapps-{id[..Math.Min(8, id.Length)]}.local";
        var result = new List<byte>(12); result[2] = 0x84; result[3] = 0; result[6] = 0; result[7] = 4;
        AddRecord(result, service, 12, NameBytes(instance)); AddRecord(result, instance, 33, SrvBytes(port, host));
        AddRecord(result, instance, 16, TxtBytes(new Dictionary<string, string> { ["protocolVersion"] = "1", ["deviceId"] = id, ["deviceName"] = displayName, ["platform"] = "windows", ["runtimeVersion"] = "1.5.0" }));
        AddRecord(result, host, 1, address.GetAddressBytes()); return [.. result];
    }
    public static DnsMessage Parse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 12) throw new InvalidDataException("Short DNS packet"); var message = new DnsMessage(); var qd = ReadU16(bytes, 4); var an = ReadU16(bytes, 6); var ns = ReadU16(bytes, 8); var ar = ReadU16(bytes, 10); var offset = 12;
        for (var i = 0; i < qd; i++) { message.questions.Add(ReadName(bytes, ref offset)); Require(bytes, offset, 4); offset += 4; }
        for (var i = 0; i < an + ns + ar; i++) { var name = ReadName(bytes, ref offset); Require(bytes, offset, 10); var type = ReadU16(bytes, offset); var length = ReadU16(bytes, offset + 8); offset += 10; Require(bytes, offset, length); message.records.Add(new DnsRecord(name, type, bytes.Slice(offset, length).ToArray())); offset += length; }
        return message;
    }
    public bool IsServiceQuery(string service) => questions.Any(q => string.Equals(q, service, StringComparison.OrdinalIgnoreCase));
    public IEnumerable<DnsAdvertisement> GetAdvertisements(string service, IPAddress sender)
    {
        var instances = records.Where(r => r.Type == 12 && Equal(r.Name, service)).Select(r => DecodeName(r.Data)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var instance in instances)
        {
            var srv = records.FirstOrDefault(r => r.Type == 33 && Equal(r.Name, instance)); var txt = records.FirstOrDefault(r => r.Type == 16 && Equal(r.Name, instance));
            if (srv is null || txt is null || srv.Data.Length < 7) continue;
            var port = (srv.Data[4] << 8) | srv.Data[5]; var values = ReadTxt(txt.Data); if (!values.TryGetValue("deviceId", out var id)) continue;
            yield return new DnsAdvertisement(id, values.GetValueOrDefault("deviceName", "Device"), values.GetValueOrDefault("platform", "unknown"), values.GetValueOrDefault("runtimeVersion", "unknown"), values.GetValueOrDefault("protocolVersion", ""), port, sender);
        }
    }
    private static void AddRecord(List<byte> target, string name, ushort type, byte[] data) { WriteName(target, name); WriteU16(target, type); WriteU16(target, 1); target.AddRange([0, 0, 0, 120]); WriteU16(target, (ushort)data.Length); target.AddRange(data); }
    private static byte[] SrvBytes(int port, string host) { var result = new List<byte>(6); result[4] = (byte)(port >> 8); result[5] = (byte)port; WriteName(result, host); return [.. result]; }
    private static byte[] TxtBytes(Dictionary<string, string> values) { var result = new List<byte>(); foreach (var value in values) { var bytes = Encoding.UTF8.GetBytes(value.Key + "=" + value.Value); if (bytes.Length > 255) continue; result.Add((byte)bytes.Length); result.AddRange(bytes); } return [.. result]; }
    private static Dictionary<string, string> ReadTxt(byte[] data) { var result = new Dictionary<string, string>(StringComparer.Ordinal); for (var i = 0; i < data.Length;) { var len = data[i++]; if (i + len > data.Length) break; var part = Encoding.UTF8.GetString(data, i, len); i += len; var equals = part.IndexOf('='); if (equals > 0) result[part[..equals]] = part[(equals + 1)..]; } return result; }
    private static byte[] NameBytes(string name) { var result = new List<byte>(); WriteName(result, name); return [.. result]; }
    private static string DecodeName(byte[] bytes) { var offset = 0; return ReadName(bytes, ref offset); }
    private static void WriteName(List<byte> target, string name) { foreach (var part in name.TrimEnd('.').Split('.')) { var bytes = Encoding.ASCII.GetBytes(part); target.Add((byte)bytes.Length); target.AddRange(bytes); } target.Add(0); }
    private static string ReadName(ReadOnlySpan<byte> bytes, ref int offset) { var labels = new List<string>(); var jumps = 0; var original = offset; var jumped = false; while (true) { Require(bytes, offset, 1); var size = bytes[offset++]; if (size == 0) break; if ((size & 0xc0) == 0xc0) { Require(bytes, offset, 1); var pointer = ((size & 0x3f) << 8) | bytes[offset++]; if (++jumps > 16 || pointer >= bytes.Length) throw new InvalidDataException("Bad DNS pointer"); if (!jumped) { original = offset; jumped = true; } offset = pointer; continue; } if ((size & 0xc0) != 0 || size > 63) throw new InvalidDataException("Bad DNS label"); Require(bytes, offset, size); labels.Add(Encoding.UTF8.GetString(bytes.Slice(offset, size))); offset += size; } if (jumped) offset = original; return string.Join('.', labels); }
    private static void Require(ReadOnlySpan<byte> data, int offset, int count) { if (offset < 0 || count < 0 || offset + count > data.Length) throw new InvalidDataException("Truncated DNS packet"); }
    private static ushort ReadU16(ReadOnlySpan<byte> data, int offset) { Require(data, offset, 2); return (ushort)((data[offset] << 8) | data[offset + 1]); }
    private static void WriteU16(List<byte> data, ushort value) { data.Add((byte)(value >> 8)); data.Add((byte)value); }
    private static bool Equal(string x, string y) => string.Equals(x.TrimEnd('.'), y.TrimEnd('.'), StringComparison.OrdinalIgnoreCase);
}
