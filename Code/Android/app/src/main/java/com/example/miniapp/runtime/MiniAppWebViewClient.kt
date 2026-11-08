package com.example.miniapp.runtime

import android.webkit.*
import com.example.miniapp.installer.ManifestValidator
import com.example.miniapp.launcher.LauncherInterfaceStore
import com.example.miniapp.repository.SharedMiniAppStore
import java.io.*

/** Serves a mini-app, its common runtime, and the externally editable standard app bar. */
class MiniAppWebViewClient(private val appId: String, private val root: File) : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        val uri = request?.url ?: return null
        if (uri.scheme != "miniapp") return null
        if (uri.host == "runtime" && uri.path == "/runtime.js") return WebResourceResponse("application/javascript", "utf-8", view!!.context.assets.open("web/runtime.js"))
        if (uri.host == "interface") return interfaceFile(uri.path?.removePrefix("/") ?: return forbidden())
        if (uri.host != appId) return forbidden()
        val relative = uri.path?.removePrefix("/") ?: return forbidden()
        if (!ManifestValidator.safePath(relative)) return forbidden()
        val file = File(root, relative)
        if (!inside(file, root) || !file.isFile) return forbidden()
        return if (file.extension.equals("html", true)) {
            val injection = "<script src=\"miniapp://runtime/runtime.js\"></script><link rel=\"stylesheet\" href=\"miniapp://interface/appbar.css\"><script src=\"miniapp://interface/appbar.js\"></script>"
            val source = file.readText()
            val html = if (Regex("(?i)</head>").containsMatchIn(source)) source.replaceFirst(Regex("(?i)</head>"), "$injection</head>") else "$injection$source"
            // JavascriptInterface is visible to every frame in a WebView. Prevent
            // embedded documents from reaching the privileged native bridge.
            WebResourceResponse("text/html", "utf-8", 200, "OK",
                mapOf("Content-Security-Policy" to "frame-src 'none'"),
                ByteArrayInputStream(html.toByteArray()))
        } else WebResourceResponse(mime(file.extension), "utf-8", FileInputStream(file))
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val uri = request?.url ?: return true
        return uri.scheme != "miniapp" || uri.host != appId
    }

    private fun interfaceFile(relative: String): WebResourceResponse {
        if (relative.split('/').any { it == "." || it == ".." }) return forbidden()
        val base = LauncherInterfaceStore.activeDir()
        val file = File(base, relative)
        return if (inside(file, base) && file.isFile) WebResourceResponse(mime(file.extension), "utf-8", FileInputStream(file)) else forbidden()
    }
    private fun inside(file: File, base: File) = file.canonicalPath.startsWith(base.canonicalPath + File.separator)
    private fun forbidden() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    private fun mime(extension: String) = mapOf("html" to "text/html", "css" to "text/css", "js" to "application/javascript", "json" to "application/json", "png" to "image/png", "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "webp" to "image/webp", "svg" to "image/svg+xml", "gif" to "image/gif", "woff" to "font/woff", "woff2" to "font/woff2", "ttf" to "font/ttf")[extension.lowercase()] ?: "application/octet-stream"
}
