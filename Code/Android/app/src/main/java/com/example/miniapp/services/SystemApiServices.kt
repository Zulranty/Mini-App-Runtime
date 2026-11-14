package com.example.miniapp.services

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Base64
import android.util.Log
import com.example.miniapp.model.NetworkConfig
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException

/** Controlled, cookie-free HTTP transport. */
object NetworkApi {
    const val MAX_REQUEST = 10 * 1024 * 1024
    const val MAX_RESPONSE = 20 * 1024 * 1024
    private val methods = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
    private val forbiddenHeaders = setOf(
        "host", "connection", "content-length", "transfer-encoding", "cookie", "set-cookie", "proxy-authorization"
    )

    private val publicClient = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .dns(NetworkAddressPolicy.publicDns())
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    // A connection established with LAN permission must never serve a public-only request.
    private val localClient = publicClient.newBuilder()
        .dns(Dns.SYSTEM)
        .connectionPool(ConnectionPool())
        .build()

    fun status(context: Context): JSONObject {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = manager.activeNetwork?.let(manager::getNetworkCapabilities)
        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            else -> "other"
        }
        return JSONObject()
            .put("online", caps != null)
            .put("type", type)
            .put("metered", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false)
    }

    fun request(config: NetworkConfig?, params: JSONObject): JSONObject {
        if (config == null) {
            throw ApiFailure("network_url_not_allowed", "Network allowlist is not configured")
        }

        val rawUrl = params.optString("url")
        // The HTTP URL parser normalizes empty userinfo. Reject it before normalization.
        if (rawUrl.substringAfter("://", "").takeWhile { it !in "/?#" }.contains('@')) {
            throw ApiFailure("network_invalid_url", "Invalid URL")
        }
        var url = rawUrl.toHttpUrlOrNull() ?: throw ApiFailure("network_invalid_url", "Invalid URL")
        val method = params.optString("method", "GET").uppercase()
        if (method !in methods) throw ApiFailure("invalid_params", "Unsupported method")

        val timeout = params.optInt("timeoutMs", 30_000)
        if (timeout !in 1..120_000) throw ApiFailure("invalid_params", "timeoutMs is invalid")
        val client = (if (config.allowLocalNetwork) localClient else publicClient).newBuilder()
            .callTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
            .connectTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
            .readTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
            .writeTimeout(timeout.toLong(), TimeUnit.MILLISECONDS)
            .build()

        val headers = readHeaders(params.optJSONObject("headers"))
        val body = readBody(params.optJSONObject("body"))
        if (body != null && method in setOf("GET", "HEAD")) {
            throw ApiFailure("invalid_params", "$method cannot have a request body")
        }
        val requestBody = (body ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0) else null)
            ?.toRequestBody()

        var forwardRequestHeaders = true
        repeat(6) { attempt ->
            try {
                validateUrl(url, config)
                val request = Request.Builder().url(url).method(method, requestBody)
                    .header("Accept-Encoding", "identity")
                if (forwardRequestHeaders) headers.forEach { (name, value) -> request.header(name, value) }
                client.newCall(request.build()).execute().use { response ->
                    if (response.code in 301..308 && response.code != 304) {
                        if (attempt == 5) throw ApiFailure("network_redirect_blocked", "Too many redirects")
                        val location = response.header("Location")
                            ?: throw ApiFailure("network_redirect_blocked", "Redirect has no location")
                        val next = url.resolve(location)
                            ?: throw ApiFailure("network_invalid_url", "Invalid redirect URL")
                        if (!sameOrigin(url, next)) forwardRequestHeaders = false
                        url = next
                        return@repeat
                    }

                    val responseHeaders = JSONObject()
                    response.headers.names().take(100).forEach { name ->
                        responseHeaders.put(name.lowercase(), response.headers.values(name).joinToString(","))
                    }
                    val bytes = response.body?.byteStream()?.use(::readLimited) ?: ByteArray(0)
                    return JSONObject()
                        .put("status", response.code)
                        .put("ok", response.isSuccessful)
                        .put("url", url.toString())
                        .put("redirected", attempt > 0)
                        .put("headers", responseHeaders)
                        .put("body", JSONObject().put("encoding", "text").put("data", bytes.toString(Charsets.UTF_8)))
                }
            } catch (_: NetworkAddressPolicy.LocalAddressDenied) {
                throw ApiFailure("network_url_not_allowed", "Local network is not allowed")
            } catch (error: InterruptedIOException) {
                throw networkFailure("network_timeout", "Request timed out", url, error)
            } catch (error: SSLException) {
                throw networkFailure("network_tls_failed", "TLS failed", url, error)
            } catch (error: UnknownHostException) {
                throw networkFailure("network_dns_failed", "DNS lookup failed", url, error)
            } catch (error: NoRouteToHostException) {
                throw networkFailure("network_no_route", "No route to host", url, error)
            } catch (error: ConnectException) {
                throw networkFailure("network_connection_failed", "Connection failed", url, error)
            } catch (error: SecurityException) {
                throw networkFailure("network_permission_missing", "Android denied network access", url, error)
            } catch (error: IOException) {
                throw networkFailure("network_io_failed", "Network I/O failed", url, error)
            } catch (_: IllegalArgumentException) {
                throw ApiFailure("invalid_params", "Invalid request header or method")
            }
        }

        throw ApiFailure("network_redirect_blocked", "Redirect blocked")
    }

    private fun readHeaders(headers: JSONObject?): Map<String, String> =
        headers?.keys()?.asSequence()?.associateWith { name ->
            if (name.lowercase() in forbiddenHeaders) throw ApiFailure("invalid_params", "Forbidden request header")
            headers.optString(name)
        }.orEmpty()

    private fun readBody(body: JSONObject?): ByteArray? {
        if (body == null) return null
        val bytes = when (body.optString("encoding")) {
            "text" -> body.optString("data").toByteArray()
            "base64" -> try {
                Base64.decode(body.optString("data"), Base64.DEFAULT)
            } catch (_: IllegalArgumentException) {
                throw ApiFailure("invalid_params", "Invalid base64 body")
            }
            else -> throw ApiFailure("invalid_params", "Invalid body encoding")
        }
        if (bytes.size > MAX_REQUEST) throw ApiFailure("network_request_too_large", "Request body is too large")
        return bytes
    }

    private fun networkFailure(code: String, summary: String, url: HttpUrl, cause: Throwable): ApiFailure {
        val detail = cause.message?.trim().takeUnless { it.isNullOrEmpty() }
            ?: cause.javaClass.simpleName
        Log.e("MiniRuntime.Network", "$summary for ${url.host}: $detail", cause)
        return ApiFailure(code, "$summary for ${url.host}: $detail")
    }

    private fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAX_RESPONSE) {
                throw ApiFailure("network_response_too_large", "Response is too large")
            }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun validateUrl(url: HttpUrl, config: NetworkConfig) {
        if (url.username.isNotEmpty() || url.password.isNotEmpty()) {
            throw ApiFailure("network_invalid_url", "Invalid URL")
        }
        if (!url.isHttps && !config.allowHttp) {
            throw ApiFailure("network_url_not_allowed", "HTTP is not allowed")
        }
        if (!config.allowLocalNetwork) NetworkAddressPolicy.checkPublicHost(url.host)

        val allowed = config.allow.any { entry ->
            val wildcard = "://*." in entry
            val origin = entry.replace("://*.", "://").toHttpUrlOrNull() ?: return@any false
            url.scheme == origin.scheme && url.port == origin.port &&
                ((!wildcard && url.host == origin.host) ||
                    ((wildcard || config.allowSubdomains) && url.host.endsWith(".${origin.host}")))
        }
        if (!allowed) throw ApiFailure("network_url_not_allowed", "URL is not allowed")
    }

    private fun sameOrigin(left: HttpUrl, right: HttpUrl): Boolean =
        left.scheme == right.scheme && left.host == right.host && left.port == right.port
}

class ApiFailure(val code: String, override val message: String) : Exception(message)
