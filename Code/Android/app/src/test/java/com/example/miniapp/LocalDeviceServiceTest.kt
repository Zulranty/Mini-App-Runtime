package com.example.miniapp

import com.example.miniapp.installer.ManifestValidator
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.model.NetworkConfig
import com.example.miniapp.services.ApiFailure
import com.example.miniapp.services.LocalDeviceService
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.*
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.io.path.createTempDirectory

class LocalDeviceServiceTest {
    private val policy = NetworkConfig(emptySet(), allowHttp = true, allowLocalNetwork = true, discoveryServices = setOf("test-device"))

    @Test fun discoveryManifestRoundTripsAndRequiresLocalOptIn() {
        val root = createTempDirectory().toFile()
        try {
            root.resolve("index.html").writeText("")
            val app = MiniAppManifest.parse(JSONObject("""{"id":"test.local","name":"Test","version":"1.0.0","sdkVersion":2,"entry":"index.html","permissions":["network"],"network":{"allow":[],"allowHttp":true,"allowLocalNetwork":true,"discoveryServices":["test-device"]}}"""))
            assertEquals(setOf("test-device"), app.network!!.discoveryServices)
            ManifestValidator.validate(app, root)
            assertThrows(Exception::class.java) { ManifestValidator.validate(app.copy(network = policy.copy(allowLocalNetwork = false)), root) }
            assertThrows(Exception::class.java) { ManifestValidator.validate(app.copy(network = policy.copy(discoveryServices = setOf("bad service"))), root) }
            assertThrows(Exception::class.java) { ManifestValidator.validate(app.copy(permissions = emptySet()), root) }
        } finally { root.deleteRecursively() }
    }

    @Test fun invalidServiceAndPolicyAreRejectedBeforeNetworkAccess() {
        LocalDeviceService().use { service ->
            assertEquals("network_url_not_allowed", assertThrows(ApiFailure::class.java) { service.discover(null, JSONObject().put("service", "test-device")) }.code)
            assertEquals("network_url_not_allowed", assertThrows(ApiFailure::class.java) { service.discover(policy, JSONObject().put("service", "another-device")) }.code)
            assertEquals("invalid_params", assertThrows(ApiFailure::class.java) { service.discover(policy, JSONObject().put("service", "bad service")) }.code)
            assertEquals("device_not_found", assertThrows(ApiFailure::class.java) { service.request(policy, JSONObject().put("id", "unknown").put("path", "/api/state")) }.code)
        }
    }

    @Test fun realUdpAndHttpUseOpaqueCapabilitiesAndRejectRedirects() {
        val ip = Collections.list(NetworkInterface.getNetworkInterfaces()).filter { it.isUp && !it.isLoopback && !it.isVirtual }
            .flatMap { it.interfaceAddresses }.filter { it.networkPrefixLength.toInt() in 1..30 }.map { it.address }.firstOrNull { it is Inet4Address && it.isSiteLocalAddress }
            ?: error("SETUP FAIL: active private IPv4 LAN required")
        val udp = DatagramSocket(LocalDeviceService.DISCOVERY_PORT)
        val http = ServerSocket(0, 8, ip)
        val workers = Executors.newFixedThreadPool(2)
        val commands = AtomicInteger()
        val key = "a".repeat(32); val token = "b".repeat(32)
        val udpTask = workers.submit {
            try {
                while (!udp.isClosed) {
                    val packet = DatagramPacket(ByteArray(256), 256); udp.receive(packet)
                    if (packet.address != ip) continue
                    val fields = String(packet.data, 0, packet.length, Charsets.US_ASCII).split(' ')
                    if (fields.size != 3 || fields[0] != "MINIAPP_DEVICE/1?" || fields[2] != "test-device") continue
                    for (response in listOf(
                        "MINIAPP_DEVICE/1! ${"0".repeat(32)} test-device $key ${http.localPort} WrongNonce",
                        "MINIAPP_DEVICE/1! ${fields[1]} wrong-service $key ${http.localPort} WrongService",
                        "MINIAPP_DEVICE/1! ${fields[1]} test-device $key 0 WrongPort",
                        "MINIAPP_DEVICE/1! ${fields[1]} test-device $key ${http.localPort} Test-Light")) {
                        val bytes = response.toByteArray(Charsets.US_ASCII)
                        udp.send(DatagramPacket(bytes, bytes.size, packet.address, packet.port))
                    }
                }
            } catch (e: SocketException) { if (!udp.isClosed) throw e }
        }
        val httpTask = workers.submit {
            try {
                while (!http.isClosed) http.accept().use { socket ->
                    socket.soTimeout = 5000
                    val reader = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                    val first = reader.readLine(); val headers = mutableMapOf<String, String>()
                    while (true) { val line = reader.readLine(); if (line.isEmpty()) break; val p = line.split(':', limit = 2); headers[p[0].lowercase()] = p[1].trim() }
                    assertFalse(headers.containsKey("cookie"))
                    val authorized = headers["x-device-token"] == token
                    val size = headers["content-length"]?.toInt() ?: 0
                    val body = CharArray(size); var read = 0
                    while (read < size) { val n = reader.read(body, read, size - read); check(n > 0); read += n }
                    if (authorized && String(body) == "on=1&brightness=0") commands.incrementAndGet()
                    val status = if (first.contains("/api/redirect ")) "302 Found" else if (authorized) "200 OK" else "401 Unauthorized"
                    val json = if (authorized) "{\"on\":true,\"brightness\":0}" else "{\"error\":\"unauthorized\"}"
                    socket.getOutputStream().write("HTTP/1.1 $status\r\nContent-Length: ${json.length}\r\nLocation: http://example.com/\r\nConnection: close\r\n\r\n$json".toByteArray(Charsets.US_ASCII))
                }
            } catch (e: SocketException) { if (!http.isClosed) throw e }
        }
        try {
            LocalDeviceService().use { service ->
                val found = service.discover(policy, JSONObject().put("service", "test-device").put("timeoutMs", 1500))
                assertEquals(1, found.length()); val device = found.getJSONObject(0)
                assertEquals("Test-Light", device.getString("name")); assertFalse(device.has("address")); assertFalse(device.has("port"))
                val id = device.getString("id")
                val second = service.discover(policy, JSONObject().put("service", "test-device").put("timeoutMs", 1000))
                assertEquals(id, second.getJSONObject(0).getString("id"))
                val denied = service.request(policy, JSONObject().put("id", id).put("path", "/api/state"))
                assertEquals(401, denied.getInt("status"))
                val state = service.request(policy, JSONObject().put("id", id).put("path", "/api/state").put("method", "POST").put("token", token).put("body", "on=1&brightness=0"))
                assertTrue(state.getBoolean("ok")); assertEquals(1, commands.get()); assertFalse(state.has("url"))
                assertEquals(0, JSONObject(state.getJSONObject("body").getString("data")).getInt("brightness"))
                assertEquals("network_redirect_blocked", assertThrows(ApiFailure::class.java) { service.request(policy, JSONObject().put("id", id).put("path", "/api/redirect").put("token", token)) }.code)
                assertEquals("invalid_params", assertThrows(ApiFailure::class.java) { service.request(policy, JSONObject().put("id", id).put("path", "http://example.com/")) }.code)
            }
        } finally {
            udp.close(); http.close(); workers.shutdownNow(); workers.awaitTermination(5, TimeUnit.SECONDS)
            udpTask.get(); httpTask.get()
        }
    }
}
