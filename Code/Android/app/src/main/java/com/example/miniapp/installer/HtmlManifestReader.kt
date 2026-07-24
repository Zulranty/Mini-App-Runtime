package com.example.miniapp.installer

import com.example.miniapp.model.MiniAppManifest
import org.json.JSONObject
import java.io.File

object HtmlManifestReader {
    private val manifestScript = Regex(
        "<script\\b(?=[^>]*type\\s*=\\s*['\"]application/miniapp\\+json['\"])[^>]*>(.*?)</script>",
        setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)
    )

    fun read(html: String): MiniAppManifest {
        val manifest = MiniAppManifest.parse(JSONObject(extractJson(html)))
        return manifest
    }

    fun read(file: File): MiniAppManifest = read(file.readText())

    fun extractJson(html: String): String =
        manifestScript.find(html)?.groupValues?.get(1)?.trim()
            ?: throw InstallException("HTML mini-app manifest is missing")

    /** Single-file packages use a readable, filesystem-safe entry derived from the app name. */
    fun entryForName(name: String): String {
        val base = name.trim()
            .replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_")
            .trimEnd('.', ' ')
            .ifBlank { "app" }
        return "$base.html"
    }
}
