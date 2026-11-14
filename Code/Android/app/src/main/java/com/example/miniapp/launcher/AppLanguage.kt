package com.example.miniapp.launcher

import android.content.Context
import com.example.miniapp.runtime.ApiException
import java.util.Locale

internal object AppLanguage {
    private fun settings(context: Context) = context.getSharedPreferences("launcher-language", Context.MODE_PRIVATE)

    fun preference(context: Context): String = when (settings(context).getString("language", null)) {
        "ru" -> "ru"
        "en" -> "en"
        else -> if (Locale.getDefault().language == "ru") "ru" else "en"
    }

    fun save(context: Context, value: Any?) {
        if (value !is String || value !in setOf("en", "ru"))
            throw ApiException("invalid_params", "Unsupported launcher language")
        if (!settings(context).edit().putString("language", value).commit())
            throw ApiException("language_save_failed", "Could not save the launcher language")
    }
}
