package com.example.miniapp.bridge

import android.net.Uri
import android.os.Build
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.security.MessageDigest

internal object WebOrigin {
    const val LAUNCHER_HOST = "launcher.miniapps.invalid"
    const val ASSET_HOST = "assets.miniapps.invalid"

    fun appHost(id: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
        val key = digest.joinToString("") { "%02x".format(it) }
        return "app.${key.take(32)}.${key.drop(32)}.miniapps.invalid"
    }

    fun url(host: String, path: String) = "https://$host/" + path.split('/').joinToString("/") { Uri.encode(it) }

    fun matches(uri: Uri, host: String) = uri.scheme == "https" && uri.encodedAuthority == host
    fun supported() = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    fun applySystemInsets(webView: WebView) {
        if (Build.VERSION.SDK_INT < 35) return
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            windowInsets
        }
    }

    fun listen(webView: WebView, name: String, host: String, dispatch: (String) -> Unit) {
        WebViewCompat.addWebMessageListener(webView, name, setOf("https://$host")) { _, message, source, main, _ ->
            if (main && matches(source, host)) message.data?.let(dispatch)
        }
    }
}
