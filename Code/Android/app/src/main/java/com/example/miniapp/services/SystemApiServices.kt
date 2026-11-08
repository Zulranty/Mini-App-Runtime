package com.example.miniapp.services

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Base64
import android.util.Log
import com.example.miniapp.model.NetworkConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

/** Controlled, cookie-free HTTP transport. It never exposes redirect targets that failed policy checks. */
object NetworkApi {
    const val MAX_REQUEST = 10 * 1024 * 1024
    const val MAX_RESPONSE = 20 * 1024 * 1024

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

        var url = parseAndAllow(params.optString("url"), config)
        val method = params.optString("method", "GET").uppercase()
        if (method !in setOf("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")) {
            throw ApiFailure("invalid_params", "Unsupported method")
        }

        val timeout = params.optInt("timeoutMs", 30_000).also {
            if (it !in 1..120_000) throw ApiFailure("invalid_params", "timeoutMs is invalid")
        }

        var redirected = false
        var forwardRequestHeaders = true

        repeat(6) { attempt ->
            val connection = openConnection(url)
            try {
                connection.instanceFollowRedirects = false
                connection.requestMethod = method
                connection.connectTimeout = timeout
                connection.readTimeout = timeout
                connection.setRequestProperty("Accept-Encoding", "identity")

                params.optJSONObject("headers")?.takeIf { forwardRequestHeaders }?.let { headers ->
                    for (name in headers.keys()) {
                        val lower = name.lowercase()
                        if (lower in setOf(
                                "host",
                                "connection",
                                "content-length",
                                "transfer-encoding",
                                "cookie",
                                "set-cookie",
                                "proxy-authorization"
                            )
                        ) {
                            throw ApiFailure("invalid_params", "Forbidden request header")
                        }
                        val value = headers.optString(name)
                        connection.setRequestProperty(name, value)
                    }
                }

                params.optJSONObject("body")?.let { body ->
                    val bytes = when (body.optString("encoding")) {
                        "text" -> body.optString("data").toByteArray()
                        "base64" -> try {
                            Base64.decode(body.optString("data"), Base64.DEFAULT)
                        } catch (_: Exception) {
                            throw ApiFailure("invalid_params", "Invalid base64 body")
                        }
                        else -> throw ApiFailure("invalid_params", "Invalid body encoding")
                    }
                    if (bytes.size > MAX_REQUEST) {
                        throw ApiFailure("network_request_too_large", "Request body is too large")
                    }
                    connection.doOutput = true
                    connection.outputStream.use { it.write(bytes) }
                }

                val status = connection.responseCode
                if (status in 301..308 && status != 304) {
                    if (attempt == 5) {
                        throw ApiFailure("network_redirect_blocked", "Too many redirects")
                    }
                    val next = connection.getHeaderField("Location")
                        ?: throw ApiFailure("network_redirect_blocked", "Redirect has no location")
                    val nextUrl = URL(url, next)
                    if (!sameOrigin(url, nextUrl)) forwardRequestHeaders = false
                    url = parseAndAllow(nextUrl.toString(), config)
                    redirected = true
                    return@repeat
                }

                val headers = JSONObject()
                connection.headerFields.forEach { (key, values) ->
                    if (key != null && values != null && headers.length() < 100) {
                        headers.put(key.lowercase(), values.joinToString(","))
                    }
                }

                val input = try {
                    connection.inputStream
                } catch (_: Exception) {
                    connection.errorStream
                }
                val bytes = input?.use(::readLimited) ?: ByteArray(0)

                return JSONObject()
                    .put("status", status)
                    .put("ok", status in 200..299)
                    .put("url", url.toString())
                    .put("redirected", redirected)
                    .put("headers", headers)
                    .put(
                        "body",
                        JSONObject()
                            .put("encoding", "text")
                            .put("data", bytes.toString(Charsets.UTF_8))
                    )
            } catch (error: ApiFailure) {
                throw error
            } catch (error: java.net.SocketTimeoutException) {
                throw networkFailure("network_timeout", "Request timed out", url, error)
            } catch (error: javax.net.ssl.SSLException) {
                throw networkFailure("network_tls_failed", "TLS failed", url, error)
            } catch (error: java.net.UnknownHostException) {
                throw networkFailure("network_dns_failed", "DNS lookup failed", url, error)
            } catch (error: java.net.NoRouteToHostException) {
                throw networkFailure("network_no_route", "No route to host", url, error)
            } catch (error: java.net.ConnectException) {
                throw networkFailure("network_connection_failed", "Connection failed", url, error)
            } catch (error: SecurityException) {
                throw networkFailure(
                    "network_permission_missing",
                    "Android denied network access; check INTERNET permission or an app firewall",
                    url,
                    error
                )
            } catch (error: java.io.IOException) {
                throw networkFailure("network_io_failed", "Network I/O failed", url, error)
            } catch (error: Exception) {
                throw networkFailure("network_request_failed", "Request failed", url, error)
            } finally {
                connection.disconnect()
            }
        }

        throw ApiFailure("network_redirect_blocked", "Redirect blocked")
    }

    private fun openConnection(url: URL): HttpURLConnection = try {
        (url.openConnection() as? HttpURLConnection)
            ?: throw ApiFailure("network_request_failed", "Unsupported URL connection")
    } catch (error: ApiFailure) {
        throw error
    } catch (error: SecurityException) {
        throw networkFailure(
            "network_permission_missing",
            "Android denied network access; check INTERNET permission or an app firewall",
            url,
            error
        )
    } catch (error: java.io.IOException) {
        throw networkFailure("network_connection_open_failed", "Could not open connection", url, error)
    } catch (error: Exception) {
        throw networkFailure("network_request_failed", "Could not open connection", url, error)
    }

    private fun networkFailure(code: String, summary: String, url: URL, cause: Throwable): ApiFailure {
        val detail = cause.message?.trim().takeUnless { it.isNullOrEmpty() }
            ?: cause.javaClass.simpleName
        Log.e("MiniRuntime.Network", "$summary for ${url.host}: $detail", cause)
        return ApiFailure(code, "$summary for ${url.host}: $detail")
    }

    private fun readLimited(input: java.io.InputStream): ByteArray {
        val output = java.io.ByteArrayOutputStream()
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

    private fun parseAndAllow(raw: String, config: NetworkConfig): URL {
        val uri = try {
            Uri.parse(raw)
        } catch (_: Exception) {
            throw ApiFailure("network_invalid_url", "Invalid URL")
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        if (scheme !in setOf("https", "http") || host.isNullOrBlank() || uri.userInfo != null) {
            throw ApiFailure("network_invalid_url", "Invalid URL")
        }
        if (scheme == "http" && !config.allowHttp) {
            throw ApiFailure("network_url_not_allowed", "HTTP is not allowed")
        }
        if (isLocal(host) && !config.allowLocalNetwork) {
            throw ApiFailure("network_url_not_allowed", "Local network is not allowed")
        }

        val port = if (uri.port == -1) null else uri.port
        val allowed = config.allow.any { entry ->
            val allowedUri = Uri.parse(entry)
            val pattern = allowedUri.host!!.lowercase()
            val schemeAllowed = allowedUri.scheme.equals(scheme, ignoreCase = true)
            val portAllowed = (allowedUri.port == -1 && port == null) || allowedUri.port == port
            schemeAllowed && portAllowed && if (pattern.startsWith("*.")) {
                host.endsWith("." + pattern.removePrefix("*."))
            } else {
                host == pattern || (config.allowSubdomains && host.endsWith(".$pattern"))
            }
        }
        if (!allowed) throw ApiFailure("network_url_not_allowed", "URL is not allowed")

        return try {
            URL(raw)
        } catch (_: Exception) {
            throw ApiFailure("network_invalid_url", "Invalid URL")
        }
    }

    private fun isLocal(host: String): Boolean = host == "localhost" || try {
        val address = InetAddress.getByName(host)
        address.isAnyLocalAddress ||
            address.isLoopbackAddress ||
            address.isLinkLocalAddress ||
            address.isSiteLocalAddress
    } catch (_: Exception) {
        false
    }

    private fun sameOrigin(left: URL, right: URL): Boolean =
        left.protocol.equals(right.protocol, true) &&
            left.host.equals(right.host, true) &&
            effectivePort(left) == effectivePort(right)

    private fun effectivePort(url: URL): Int = if (url.port == -1) url.defaultPort else url.port
}

class ApiFailure(val code: String, override val message: String) : Exception(message)
