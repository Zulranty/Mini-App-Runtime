package com.example.miniapp.runtime

import android.os.Environment
import android.system.ErrnoException
import android.system.Os
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.SharedMiniAppStore
import org.json.JSONObject
import org.json.JSONException
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

internal object RuntimeLog {
    private const val MAX_FILE_BYTES = 1024 * 1024
    private const val MAX_ENTRY_BYTES = 8192
    private const val TELEGRAM_TAIL_ENTRIES = 80
    private val identifier = Regex("[A-Za-z][A-Za-z0-9_.-]{0,63}")
    private val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }
    private val logDirectory get() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "MiniApps/Logs")

    @Synchronized
    fun readTelegram(): JSONObject {
        if (!SharedMiniAppStore.hasFileAccess())
            throw ApiException("file_access_required", "Grant MiniApps access to shared files first")
        val directory = logDirectory
        val file = File(directory, "miniapps.jsonl")
        val lines = ArrayDeque<String>()
        try {
            for (source in listOf(File(directory, "miniapps.previous.jsonl"), file)) {
                if (source.canonicalFile != source.absoluteFile) throw IOException("Invalid log path")
                if (!source.isFile || source.length() > MAX_FILE_BYTES) continue
                source.forEachLine { line ->
                    if (line.toByteArray(Charsets.UTF_8).size >= MAX_ENTRY_BYTES) return@forEachLine
                    val record = try { JSONObject(line) } catch (_: JSONException) { return@forEachLine }
                    if (record.optString("appId") != TelegramSessionLease.CLIENT_APP_ID ||
                        !record.optString("event").startsWith("telegram.")) return@forEachLine
                    if (lines.size == TELEGRAM_TAIL_ENTRIES) lines.removeFirst()
                    lines.addLast(line)
                }
            }
        } catch (_: IOException) {
            throw ApiException("log_read_failed", "Could not read the Telegram login log")
        } catch (_: SecurityException) {
            throw ApiException("log_read_failed", "Could not read the Telegram login log")
        }
        return JSONObject().put("path", file.absolutePath).put("text", lines.joinToString("\n"))
    }

    @Synchronized
    fun write(manifest: MiniAppManifest, parameters: JSONObject): JSONObject {
        val event = parameters.opt("event") as? String
        if (event == null || !identifier.matches(event))
            throw ApiException("invalid_params", "Invalid log event name")
        val supplied = parameters.opt("fields")
        if (supplied != null && supplied != JSONObject.NULL && supplied !is JSONObject)
            throw ApiException("invalid_params", "Log fields must be an object")
        val fields = supplied as? JSONObject ?: JSONObject()
        if (fields.length() > 16 || fields.keys().asSequence().any { !identifier.matches(it) || !isFieldValue(fields.opt(it)) })
            throw ApiException("invalid_params", "Invalid log fields")

        val record = JSONObject().put("timestamp", timestamp.format(Date()))
            .put("platform", "android")
            .put("appId", manifest.id)
            .put("appVersion", manifest.version)
            .put("event", event)
            .put("fields", fields)
        val bytes = (record.toString() + "\n").toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_ENTRY_BYTES)
            throw ApiException("invalid_params", "Log entry exceeds 8 KiB")
        if (!SharedMiniAppStore.hasFileAccess())
            throw ApiException("file_access_required", "Grant MiniApps access to shared files first")

        val directory = logDirectory
        val file = File(directory, "miniapps.jsonl")
        val previous = File(directory, "miniapps.previous.jsonl")
        try {
            if (file.canonicalFile != file.absoluteFile || previous.canonicalFile != previous.absoluteFile)
                throw IOException("Invalid log path")
            if (!directory.isDirectory && !directory.mkdirs() && !directory.isDirectory)
                throw IOException("Could not create log directory")
            if (file.isFile && file.length() + bytes.size > MAX_FILE_BYTES)
                Os.rename(file.absolutePath, previous.absolutePath)
            file.appendBytes(bytes)
        } catch (_: IOException) {
            throw ApiException("log_write_failed", "Could not write the MiniApps log")
        } catch (_: ErrnoException) {
            throw ApiException("log_write_failed", "Could not rotate the MiniApps log")
        } catch (_: SecurityException) {
            throw ApiException("log_write_failed", "Could not access the MiniApps log")
        }
        return JSONObject().put("path", file.absolutePath)
    }

    private fun isFieldValue(value: Any?): Boolean = when (value) {
        null, JSONObject.NULL, is Boolean -> true
        is String -> value.length <= 256
        is Number -> value.toDouble().isFinite()
        else -> false
    }
}
