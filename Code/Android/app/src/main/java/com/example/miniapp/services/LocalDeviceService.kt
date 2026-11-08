package com.example.miniapp.services

import com.example.miniapp.model.NetworkConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.net.*
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** App-owned capabilities for local devices implementing the generic discovery protocol. */
class LocalDeviceService : Closeable {
    companion object {
        const val DISCOVERY_PORT = 42101
        fun validService(value: String) = Regex("^[a-z][a-z0-9-]{0,47}$").matches(value)
        private fun number(address: InetAddress): Long = address.address.fold(0L) { n, b -> (n shl 8) or (b.toLong() and 255) }
        private fun address(n: Long) = InetAddress.getByAddress(byteArrayOf((n shr 24).toByte(), (n shr 16).toByte(), (n shr 8).toByte(), n.toByte()))
        private fun privateAddress(address: InetAddress): Boolean {
            if (address !is Inet4Address) return false
            val b = address.address.map { it.toInt() and 255 }
            return b[0] == 10 || (b[0] == 172 && b[1] in 16..31) || (b[0] == 192 && b[1] == 168)
        }
    }
    private data class Subnet(val address: InetAddress, val mask: Long)
    private data class Device(val id: String, val key: String, val service: String, val name: String, val address: InetAddress, val port: Int, val seen: Long)
    private val devices = mutableMapOf<String, Device>()
    private val resources = ConcurrentHashMap.newKeySet<Closeable>()
    private val closed = AtomicBoolean(false)
    private val discovering = AtomicBoolean(false)
    // Runtime calls submit here, so untrusted callers cannot create unlimited worker threads.
    private val workers = java.util.concurrent.ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS,
        java.util.concurrent.ArrayBlockingQueue(8))

    fun execute(task: () -> Unit) {
        if (closed.get()) throw ApiFailure("network_unavailable", "Device service is closed")
        try { workers.execute(task) }
        catch (_: java.util.concurrent.RejectedExecutionException) { throw ApiFailure("device_busy", "Too many device requests") }
    }
    private fun requirePolicy(config: NetworkConfig?, service: String) {
        if (config == null || !config.allowHttp || !config.allowLocalNetwork || service !in config.discoveryServices)
            throw ApiFailure("network_url_not_allowed", "Local device service is not allowed by the manifest")
    }
    private fun subnets(): List<Subnet> = Collections.list(NetworkInterface.getNetworkInterfaces())
        .filter { it.isUp && !it.isLoopback && !it.isVirtual }
        .flatMap { it.interfaceAddresses }.filter { privateAddress(it.address) && it.networkPrefixLength.toInt() in 1..30 }
        .map { Subnet(it.address, (0xffffffffL shl (32 - it.networkPrefixLength.toInt())) and 0xffffffffL) }.take(8)
    private fun track(resource: Closeable) {
        resources.add(resource)
        if (closed.get()) { resources.remove(resource); resource.close(); throw ApiFailure("network_unavailable", "Device service is closed") }
    }
    private fun prune() { val now = System.nanoTime(); devices.entries.removeAll { now - it.value.seen > 60_000_000_000L } }

    fun discover(config: NetworkConfig?, params: JSONObject): JSONArray {
        val service = params.optString("service")
        if (!validService(service)) throw ApiFailure("invalid_params", "Invalid service")
        requirePolicy(config, service)
        val timeout = params.optInt("timeoutMs", 2500)
        if (timeout !in 1000..5000) throw ApiFailure("invalid_params", "Discovery timeout must be 1000..5000 ms")
        if (!discovering.compareAndSet(false, true)) throw ApiFailure("discovery_busy", "Discovery is already running")
        val probes = Executors.newFixedThreadPool(8)
        try {
            val subnets = subnets()
            if (subnets.isEmpty()) throw ApiFailure("network_unavailable", "No private IPv4 LAN is available")
            val nonce = UUID.randomUUID().toString().replace("-", "")
            val payload = "MINIAPP_DEVICE/1? $nonce $service".toByteArray(Charsets.US_ASCII)
            val deadline = System.nanoTime() + timeout * 1_000_000L
            val found = mutableMapOf<String, Device>()
            val tasks = subnets.map { subnet -> probes.submit { probe(subnet, payload, nonce, service, deadline, found) } }
            for (task in tasks) task.get()
            synchronized(devices) {
                prune()
                return JSONArray(found.values.sortedBy { it.name }.map {
                    JSONObject().put("id", it.id).put("deviceId", it.key).put("name", it.name).put("service", it.service)
                })
            }
        } finally { probes.shutdownNow(); discovering.set(false) }
    }

    private fun probe(subnet: Subnet, bytes: ByteArray, nonce: String, service: String, deadline: Long, found: MutableMap<String, Device>) {
        val socket = DatagramSocket(InetSocketAddress(subnet.address, 0))
        track(socket)
        try {
            socket.broadcast = true; socket.soTimeout = 50
            val local = number(subnet.address); val network = local and subnet.mask
            val broadcast = network or (subnet.mask xor 0xffffffffL)
            socket.send(DatagramPacket(bytes, bytes.size, address(broadcast), DISCOVERY_PORT))
            var next = network + 1
            val fallback = broadcast - network <= 255
            var lastSent = 0L
            while (!closed.get() && System.nanoTime() < deadline) {
                // Pace fallback probes without blocking reception for an entire subnet sweep.
                if (fallback && next < broadcast && System.nanoTime() - lastSent >= 2_000_000L) {
                    if (next != local) socket.send(DatagramPacket(bytes, bytes.size, address(next), DISCOVERY_PORT))
                    next++; lastSent = System.nanoTime()
                    socket.soTimeout = 2
                } else socket.soTimeout = if (fallback && next < broadcast) 2 else 50
                val packet = DatagramPacket(ByteArray(257), 257)
                try { socket.receive(packet) } catch (_: SocketTimeoutException) { continue }
                if (packet.port != DISCOVERY_PORT || packet.length > 256 || !privateAddress(packet.address) || (number(packet.address) and subnet.mask) != network) continue
                val fields = String(packet.data, 0, packet.length, Charsets.US_ASCII).split(' ')
                if (fields.size != 6 || fields[0] != "MINIAPP_DEVICE/1!" || fields[1] != nonce || fields[2] != service ||
                    !Regex("^[a-f0-9]{32}$").matches(fields[3]) || !Regex("^[A-Za-z0-9_-]{1,48}$").matches(fields[5])) continue
                val port = fields[4].toIntOrNull()?.takeIf { it in 1..65535 } ?: continue
                synchronized(devices) {
                    prune()
                    val identity = "$service/${fields[3]}/${packet.address.hostAddress}"
                    if (found.size < 64 || identity in found) {
                        val existing = devices.values.firstOrNull { it.service == service && it.key == fields[3] && it.address == packet.address }
                        if (devices.size < 64 || existing != null) {
                            val device = Device(existing?.id ?: UUID.randomUUID().toString().replace("-", ""), fields[3], service, fields[5], packet.address, port, System.nanoTime())
                            devices[device.id] = device; found[identity] = device
                        }
                    }
                }
            }
        } catch (_: SocketException) { /* Other interfaces may still find a device. */ }
        finally { resources.remove(socket); socket.close() }
    }

    fun request(config: NetworkConfig?, params: JSONObject): JSONObject {
        val device = synchronized(devices) { prune(); devices[params.optString("id")] }
            ?: throw ApiFailure("device_not_found", "Discover the device again")
        requirePolicy(config, device.service)
        val path = params.optString("path"); val method = params.optString("method", "GET")
        val token = params.optString("token"); val body = params.optString("body").toByteArray(Charsets.UTF_8)
        val timeout = params.optInt("timeoutMs", 4000)
        if (!Regex("^/api/[a-zA-Z0-9_/-]{1,80}$").matches(path) || "//" in path || method !in setOf("GET", "POST") ||
            (token.isNotEmpty() && !Regex("^[a-f0-9]{32}$").matches(token)) || body.size > 4096 || (method == "GET" && body.isNotEmpty()) || timeout !in 1..10000)
            throw ApiFailure("invalid_params", "Invalid device request")
        val deadline = System.nanoTime() + timeout * 1_000_000L
        val socket = Socket(); track(socket)
        try {
            socket.connect(InetSocketAddress(device.address, device.port), timeout)
            // Direct, bounded HTTP to a discovered numeric endpoint. Does not relax WebView cleartext policy.
            val auth = if (token.isEmpty()) "" else "X-Device-Token: $token\r\n"
            val header = "$method $path HTTP/1.1\r\nHost: ${device.address.hostAddress}:${device.port}\r\nConnection: close\r\n${auth}Content-Type: application/x-www-form-urlencoded; charset=utf-8\r\nContent-Length: ${body.size}\r\n\r\n"
            socket.getOutputStream().apply { write(header.toByteArray(Charsets.US_ASCII)); write(body); flush() }
            val input = socket.getInputStream()
            fun readByte(): Int {
                val left = ((deadline - System.nanoTime()) / 1_000_000).toInt()
                if (left <= 0) throw SocketTimeoutException()
                socket.soTimeout = left
                return input.read()
            }
            var headerBytes = 0
            fun line(): String {
                val output = java.io.ByteArrayOutputStream()
                while (true) {
                    val byte = readByte()
                    if (byte < 0) throw ApiFailure("network_response_invalid", "Incomplete device response")
                    if (++headerBytes > 8192) throw ApiFailure("network_response_too_large", "Device headers are too large")
                    if (byte == 10) return output.toString("US-ASCII").removeSuffix("\r")
                    output.write(byte)
                }
            }
            val status = Regex("^HTTP/1\\.[01] ([0-9]{3})(?: .*)?$").matchEntire(line())?.groupValues?.get(1)?.toInt()
                ?: throw ApiFailure("network_response_invalid", "Invalid device status")
            if (status in 300..399) throw ApiFailure("network_redirect_blocked", "Device redirects are not allowed")
            var length: Int? = null
            while (true) {
                val value = line(); if (value.isEmpty()) break
                val parts = value.split(':', limit = 2)
                if (parts.size != 2) throw ApiFailure("network_response_invalid", "Invalid device header")
                if (parts[0].equals("Transfer-Encoding", true)) throw ApiFailure("network_response_invalid", "Device must use Content-Length")
                if (parts[0].equals("Content-Length", true)) {
                    if (length != null) throw ApiFailure("network_response_invalid", "Repeated content length")
                    length = parts[1].trim().toIntOrNull() ?: throw ApiFailure("network_response_invalid", "Invalid content length")
                }
            }
            val size = length ?: throw ApiFailure("network_response_invalid", "Device must use Content-Length")
            if (size !in 0..65536) throw ApiFailure("network_response_too_large", "Device response is too large")
            val response = ByteArray(size)
            var offset = 0
            while (offset < size) {
                val left = ((deadline - System.nanoTime()) / 1_000_000).toInt()
                if (left <= 0) throw SocketTimeoutException()
                socket.soTimeout = left
                val count = input.read(response, offset, size - offset)
                if (count < 0) throw ApiFailure("network_response_invalid", "Incomplete device body")
                offset += count
            }
            return JSONObject().put("status", status).put("ok", status in 200..299)
                .put("body", JSONObject().put("encoding", "text").put("data", response.toString(Charsets.UTF_8)))
        } catch (_: SocketTimeoutException) { throw ApiFailure("network_timeout", "Device request timed out") }
        catch (_: java.io.IOException) { throw ApiFailure("network_request_failed", "Device request failed") }
        finally { resources.remove(socket); socket.close() }
    }

    override fun close() {
        closed.set(true); workers.shutdownNow(); resources.forEach { runCatching { it.close() } }; resources.clear()
        synchronized(devices) { devices.clear() }
    }
}
