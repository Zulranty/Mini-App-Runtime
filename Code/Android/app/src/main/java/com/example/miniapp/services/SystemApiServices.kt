package com.example.miniapp.services

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Base64
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
        val caps = (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).activeNetwork?.let { network ->
            (context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).getNetworkCapabilities(network)
        }
        val type = when { caps == null -> "none"; caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"; caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"; caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"; else -> "other" }
        return JSONObject().put("online", caps != null).put("type", type).put("metered", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == false)
    }
    fun request(config: NetworkConfig?, params: JSONObject): JSONObject {
        if (config == null) throw ApiFailure("network_url_not_allowed", "Network allowlist is not configured")
        var url = parseAndAllow(params.optString("url"), config)
        val method = params.optString("method", "GET").uppercase()
        if (method !in setOf("GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS")) throw ApiFailure("invalid_params", "Unsupported method")
        val timeout = params.optInt("timeoutMs", 30_000).also { if (it !in 1..120_000) throw ApiFailure("invalid_params", "timeoutMs is invalid") }
        var redirected = false; var auth: String? = null
        repeat(6) { attempt ->
            val c = (url.openConnection() as? HttpURLConnection) ?: throw ApiFailure("network_request_failed", "Request failed")
            try {
                c.instanceFollowRedirects = false; c.requestMethod = method; c.connectTimeout = timeout; c.readTimeout = timeout
                params.optJSONObject("headers")?.let { headers -> for (name in headers.keys()) { val lower=name.lowercase(); if(lower in setOf("host","connection","content-length","transfer-encoding","cookie","set-cookie","proxy-authorization")) throw ApiFailure("invalid_params","Forbidden request header"); val value=headers.optString(name); if(lower=="authorization") auth=value; c.setRequestProperty(name,value) } }
                if (auth != null) c.setRequestProperty("Authorization", auth)
                params.optJSONObject("body")?.let { body -> val bytes = when(body.optString("encoding")){ "text" -> body.optString("data").toByteArray(); "base64" -> try { Base64.decode(body.optString("data"),Base64.DEFAULT) } catch(_:Exception){ throw ApiFailure("invalid_params","Invalid base64 body") }; else -> throw ApiFailure("invalid_params","Invalid body encoding") }; if(bytes.size>MAX_REQUEST)throw ApiFailure("network_request_too_large","Request body is too large"); c.doOutput=true;c.outputStream.use{it.write(bytes)} }
                val status=c.responseCode
                if(status in 301..308 && status != 304) { if(attempt==5)throw ApiFailure("network_redirect_blocked","Too many redirects"); val next=c.getHeaderField("Location")?:throw ApiFailure("network_redirect_blocked","Redirect has no location"); val nextUrl=URL(url,next); if(!sameOrigin(url,nextUrl))auth=null; url=parseAndAllow(nextUrl.toString(),config); redirected=true; return@repeat }
                val headers=JSONObject(); c.headerFields.forEach { (key,value) -> if(key!=null&&value!=null&&headers.length()<100) headers.put(key.lowercase(),value.joinToString(",")) }
                val input=try{c.inputStream}catch(_:Exception){c.errorStream}; val bytes=input?.use { readLimited(it) }?:ByteArray(0)
                return JSONObject().put("status",status).put("ok",status in 200..299).put("url",url.toString()).put("redirected",redirected).put("headers",headers).put("body",JSONObject().put("encoding","text").put("data",bytes.toString(Charsets.UTF_8)))
            } catch(e:ApiFailure){throw e} catch(e:java.net.SocketTimeoutException){throw ApiFailure("network_timeout","Request timed out")} catch(_:javax.net.ssl.SSLException){throw ApiFailure("network_tls_failed","TLS failed")} catch(_:Exception){throw ApiFailure("network_request_failed","Request failed")} finally { c.disconnect() }
        }
        throw ApiFailure("network_redirect_blocked","Redirect blocked")
    }
    private fun readLimited(input:java.io.InputStream):ByteArray { val out=java.io.ByteArrayOutputStream(); val buffer=ByteArray(8192); while(true){val n=input.read(buffer);if(n<0)break;if(out.size()+n>MAX_RESPONSE)throw ApiFailure("network_response_too_large","Response is too large");out.write(buffer,0,n)};return out.toByteArray() }
    private fun parseAndAllow(raw:String, config:NetworkConfig):URL { val uri=try{Uri.parse(raw)}catch(_:Exception){throw ApiFailure("network_invalid_url","Invalid URL")}; val scheme=uri.scheme?.lowercase(); val host=uri.host?.lowercase(); if(scheme !in setOf("https","http")||host.isNullOrBlank()||uri.userInfo!=null)throw ApiFailure("network_invalid_url","Invalid URL");if(scheme=="http"&&!config.allowHttp)throw ApiFailure("network_url_not_allowed","HTTP is not allowed");if(isLocal(host)&&!config.allowLocalNetwork)throw ApiFailure("network_url_not_allowed","Local network is not allowed"); val port=if(uri.port==-1)null else uri.port; val allowed=config.allow.any { entry -> val a=Uri.parse(entry); val pattern=a.host!!.lowercase(); val portOk=(a.port==-1&&port==null)||a.port==port; portOk && if(pattern.startsWith("*.")) host.endsWith(pattern.removePrefix("*"))&&host!=pattern.removePrefix("*.") else host==pattern || (config.allowSubdomains&&host.endsWith(".$pattern")) }; if(!allowed)throw ApiFailure("network_url_not_allowed","URL is not allowed"); return try{URL(raw)}catch(_:Exception){throw ApiFailure("network_invalid_url","Invalid URL")} }
    private fun isLocal(host:String):Boolean = host=="localhost" || try { val a=InetAddress.getByName(host); a.isAnyLocalAddress||a.isLoopbackAddress||a.isLinkLocalAddress||a.isSiteLocalAddress }catch(_:Exception){false}
    private fun sameOrigin(a:URL,b:URL)=a.protocol.equals(b.protocol,true)&&a.host.equals(b.host,true)&&a.port==b.port
}
class ApiFailure(val code:String, override val message:String):Exception(message)
