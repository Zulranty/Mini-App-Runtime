package com.example.miniapp.launcher

import android.content.Context
import com.example.miniapp.runtime.ApiException
import org.json.JSONObject

internal object TelegramSettings {
    private fun preferences(context: Context) = context.getSharedPreferences("telegram-settings", Context.MODE_PRIVATE)

    fun read(context: Context, sharedSignIn: Boolean = false): JSONObject {
        val settings = preferences(context)
        return JSONObject()
            .put("testServer", !sharedSignIn && settings.getBoolean("testServer", false))
            .put("writeLoginLog", settings.getBoolean("writeLoginLog", false))
    }

    fun save(context: Context, parameters: JSONObject): JSONObject {
        val testServer = parameters.opt("testServer") as? Boolean
        val writeLoginLog = parameters.opt("writeLoginLog") as? Boolean
        if (testServer == null || writeLoginLog == null)
            throw ApiException("invalid_params", "Telegram settings require two boolean values")
        if (!preferences(context).edit().putBoolean("testServer", testServer)
                .putBoolean("writeLoginLog", writeLoginLog).commit())
            throw ApiException("telegram_settings_failed", "Could not save Telegram settings")
        return read(context)
    }
}
