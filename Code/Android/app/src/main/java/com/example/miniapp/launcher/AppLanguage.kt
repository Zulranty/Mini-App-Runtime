package com.example.miniapp.launcher

import android.content.Context
import com.example.miniapp.runtime.ApiException
import java.util.Locale

internal object AppLanguage {
    private val tag = Regex("[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,6}")
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

    fun normalize(value: String?): String? = value?.takeIf { it.length <= 64 }?.lowercase(Locale.ROOT)?.takeIf(tag::matches)

    fun match(preference: String, available: Set<String>, fallback: String): String {
        var candidate = preference
        while (true) {
            if (candidate in available) return candidate
            if ('-' !in candidate) return fallback
            candidate = candidate.substringBeforeLast('-')
        }
    }
}
