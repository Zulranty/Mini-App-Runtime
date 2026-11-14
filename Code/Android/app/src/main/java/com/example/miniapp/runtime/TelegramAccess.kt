package com.example.miniapp.runtime

import android.app.Activity
import android.app.AlertDialog
import android.util.Base64
import com.example.miniapp.services.SecureStorageService
import com.example.miniapp.services.StorageException
import org.json.JSONObject
import java.security.MessageDigest

internal class TelegramAccess(
    private val activity: Activity,
    private val consent: SecureStorageService,
    private val grantKey: String,
    private val callerName: String
) {
    companion object {
        const val PERMISSION = "telegram.session"
        const val LOGIN_REASON = "telegramSignIn"
        const val CONSUMER_GRANT_KEY = "runtime.telegram-access.v1"
        private const val SESSION = "telegram.session.v1"
    }

    private val telegram = SecureStorageService(activity, TelegramSessionLease.CLIENT_APP_ID)
    var approvedFingerprint: String? = null
        private set
    private var confirming = false

    fun hasSaved() = telegram.get(SESSION) is JSONObject

    fun hasApproval(): Boolean {
        val record = telegram.get(SESSION) as? JSONObject ?: return false
        return approvedFingerprint == fingerprint(record)
    }

    fun use(interactive: Boolean, complete: (Any?, ApiException?) -> Unit) {
        if (confirming) throw ApiException("operation_in_progress", "Telegram consent is already open")
        val record = telegram.get(SESSION) as? JSONObject
        if (record == null) {
            complete(JSONObject.NULL, null)
            return
        }
        val hash = fingerprint(record)
        val grant = consent.get(grantKey) as? JSONObject
        if (grant != null && grant.optString("fingerprint") == hash) {
            approvedFingerprint = hash
            complete(record, null)
            return
        }
        if (!interactive) {
            complete(JSONObject.NULL, null)
            return
        }

        fun decline() = complete(null, ApiException("operation_cancelled", "Telegram access was declined"))
        val dialog = AlertDialog.Builder(activity)
            .setTitle("MiniApps · Доступ к аккаунту Telegram")
            .setMessage("Разрешить приложению «$callerName» использовать сохранённый сеанс Unofficial Telegram? Приложение сможет действовать от имени вашего аккаунта.")
            .setPositiveButton("Разрешить") { _, _ ->
                try {
                    val current = telegram.get(SESSION) as? JSONObject
                    if (current == null || fingerprint(current) != hash) {
                        complete(null, ApiException("telegram_session_changed", "The saved Telegram session changed"))
                    } else {
                        consent.set(grantKey, JSONObject().put("fingerprint", hash))
                        approvedFingerprint = hash
                        complete(current, null)
                    }
                } catch (error: StorageException) {
                    complete(null, ApiException(error.code, error.message))
                }
            }
            .setNegativeButton("Отмена") { _, _ -> decline() }
            .setOnCancelListener { decline() }
            .create()
        dialog.setOnDismissListener { confirming = false }
        dialog.show()
        confirming = true
    }

    private fun fingerprint(record: JSONObject): String =
        Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(record.toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
}
