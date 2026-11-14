package com.example.miniapp.runtime

import android.app.Activity
import com.example.miniapp.services.SecureStorageService
import org.json.JSONObject

internal object TelegramCloudFunctions {
    fun register(
        functions: MiniAppFunctions,
        activity: Activity,
        storage: SecureStorageService,
        access: TelegramAccess,
        complete: (String, Any?, ApiException?) -> Unit
    ) {
        val state = TelegramCloudState(activity, storage)
        functions.enableStreams = true
        functions.allowMediaAutoplay = true
        fun register(method: String, handle: (JSONObject) -> Any?) = functions.register(method, complete, handle)
        register("telegramCloud.getSavedChannel") { state.savedChannel(access.approvedFingerprint) }
        register("telegramCloud.rememberChannel") {
            state.rememberChannel(it.optString("id"), access.approvedFingerprint)
            null
        }
        register("telegramCloud.getThumbnail") {
            state.thumbnail(it, false, access.approvedFingerprint)
        }
        register("telegramCloud.cacheThumbnail") {
            state.thumbnail(it, true, access.approvedFingerprint)
        }
    }
}
