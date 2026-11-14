package com.example.miniapp.runtime

import android.webkit.*
import com.example.miniapp.bridge.WebOrigin
import com.example.miniapp.installer.ManifestValidator
import com.example.miniapp.launcher.LauncherInterfaceStore
import com.example.miniapp.repository.SharedMiniAppStore
import java.io.*

/** Serves a mini-app, its common runtime, and the externally editable standard app bar. */
internal class MiniAppWebViewClient(private val appHost: String, private val root: File, private val streams: WebStreams, private val appContent: MiniAppContent) : WebViewClient() {
    private val legacyContentPolicy = Regex("""(?i)<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>""")
    private val moduleEntry = Regex("/([a-z][a-z0-9-]{0,47})/index\\.js")

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        val uri = request?.url ?: return null
        if (uri.scheme == "https" && uri.host == WebStreams.HOST) return streams.serve(request)
        if (uri.scheme == "https" && uri.host == "modules.miniapp.local") {
            val match = moduleEntry.matchEntire(uri.encodedPath.orEmpty())
            val content = if (request.method == "GET" && uri.encodedAuthority == "modules.miniapp.local" &&
                uri.encodedQuery == null && uri.encodedFragment == null && match != null) {
                val bundled = appContent.openModule
                if (bundled == null) openModule(match.groupValues[1])
                else runCatching { bundled(match.groupValues[1]) }.getOrNull()
            } else null
            return WebResourceResponse("application/javascript", "utf-8", if (content == null) 404 else 200,
                if (content == null) "Not Found" else "OK",
                mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
                content ?: ByteArrayInputStream(ByteArray(0)))
        }
        if (WebOrigin.matches(uri, WebOrigin.ASSET_HOST)) {
            if (uri.path == "/runtime.js")
                return WebResourceResponse("application/javascript", "utf-8", view!!.context.assets.open("web/runtime.js"))
            if (appContent.openFile == null) return interfaceFile(uri.path?.removePrefix("/") ?: return forbidden())
            return forbidden()
        }
        if (!WebOrigin.matches(uri, appHost)) return if (uri.host?.endsWith(".miniapps.invalid") == true) forbidden() else null
        val relative = uri.path?.removePrefix("/") ?: return forbidden()
        if (!ManifestValidator.safePath(relative)) return forbidden()
        val file = File(root, relative)
        val bundledFile = appContent.openFile
        val content = if (bundledFile != null) {
            runCatching { bundledFile(relative) }.getOrNull() ?: return forbidden()
        } else {
            if (!inside(file, root) || !file.isFile) return forbidden()
            FileInputStream(file)
        }
        return if (file.extension.equals("html", true)) {
            val sdk = "<script src=\"https://${WebOrigin.ASSET_HOST}/runtime.js\"></script>"
            val appbar = "<link rel=\"stylesheet\" href=\"https://${WebOrigin.ASSET_HOST}/appbar.css\"><script src=\"https://${WebOrigin.ASSET_HOST}/appbar.js\"></script>"
            val injection = if (bundledFile == null) sdk + appbar else sdk
            val source = content.bufferedReader().use { it.readText() }
                .replace(legacyContentPolicy) { match ->
                    match.value.replace(" miniapp:", " https://${WebOrigin.ASSET_HOST}")
                }
            val html = if (Regex("(?i)</head>").containsMatchIn(source)) source.replaceFirst(Regex("(?i)</head>"), "$injection</head>") else "$injection$source"
            // Keep embedded navigation out of mini-app HTML.
            WebResourceResponse("text/html", "utf-8", 200, "OK",
                mapOf("Content-Security-Policy" to "frame-src 'none'"),
                ByteArrayInputStream(html.toByteArray()))
        } else WebResourceResponse(mime(file.extension), "utf-8", content)
    }

    private fun openModule(id: String): InputStream? {
        return try {
            val modules = File(SharedMiniAppStore.root().canonicalFile, SharedMiniAppStore.MODULES_DIR)
            val script = File(modules, "$id/index.js")
            if (script.canonicalFile == script && script.isFile && script.length() <= 16 * 1024 * 1024) {
                FileInputStream(script)
            } else null
        } catch (_: IOException) {
            null
        } catch (_: SecurityException) {
            null
        }
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val uri = request?.url ?: return true
        return !WebOrigin.matches(uri, appHost)
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
