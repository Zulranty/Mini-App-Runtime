package com.example.miniapp.runtime

import android.content.Context
import android.util.Base64
import com.example.miniapp.services.SecureStorageService
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

internal class TelegramCloudState(context: Context, private val storage: SecureStorageService) {
    companion object {
        const val APP_ID = "com.miniapps.telegram-cloud"
        const val GRANT_KEY = "runtime.telegram-cloud.v1"
        private val channelId = Regex("-?[0-9]{1,25}")
        private val thumbnailKey = Regex("[-A-Za-z0-9_:]{1,160}")
        private const val THUMBNAIL_LIMIT = 192 * 1024
        private val thumbnailLock = Any()
        private var legacyThumbnailsRemoved = false
    }

    private val root = File(context.cacheDir, "telegram-cloud-thumbnails")

    fun savedChannel(fingerprint: String?): String? =
        approvedGrant(fingerprint)?.optString("channelId")?.takeIf { it.isNotEmpty() }

    private fun approvedGrant(fingerprint: String?): JSONObject? {
        if (fingerprint == null) return null
        val grant = storage.get(GRANT_KEY) as? JSONObject
        return grant?.takeIf { it.optString("fingerprint") == fingerprint }
    }

    fun rememberChannel(id: String, fingerprint: String?) {
        if (!channelId.matches(id)) throw ApiException("invalid_params", "Invalid Telegram channel ID")
        val grant = approvedGrant(fingerprint)
            ?: throw ApiException("telegram_session_changed", "The saved Telegram session changed")
        if (grant.optString("channelId") != id) storage.set(GRANT_KEY, grant.put("channelId", id))
    }

    fun thumbnail(params: JSONObject, write: Boolean, fingerprint: String?): String? {
        if (fingerprint == null) return null
        val key = params.optString("key").takeIf(thumbnailKey::matches) ?: return null
        val hash = MessageDigest.getInstance("SHA-256").digest("$fingerprint:$key".toByteArray())
        val name = Base64.encodeToString(hash, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val path = File(root, "$name.thumb2")
        return synchronized(thumbnailLock) {
            runCatching {
                if (!legacyThumbnailsRemoved) {
                    root.listFiles { file -> file.extension == "thumb" }?.forEach { it.delete() }
                    legacyThumbnailsRemoved = true
                }
                if (!write) {
                    if (!path.isFile || path.length() > THUMBNAIL_LIMIT) return@runCatching null
                    path.setLastModified(System.currentTimeMillis())
                    return@runCatching path.readText()
                }
                val data = params.optString("data")
                if (data.length > THUMBNAIL_LIMIT || data.any { it.code > 127 }) return@runCatching null
                root.mkdirs()
                path.writeText(data)
                root.listFiles { file -> file.extension == "thumb2" }
                    ?.sortedByDescending { it.lastModified() }?.drop(256)?.forEach { it.delete() }
                null
            }.getOrNull()
        }
    }
}
