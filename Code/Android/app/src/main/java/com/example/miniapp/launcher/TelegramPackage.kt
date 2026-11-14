package com.example.miniapp.launcher

import android.content.Context
import com.example.miniapp.installer.InstallException
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.MiniAppRepository
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.runtime.ApiException
import com.example.miniapp.runtime.TelegramSessionLease
import org.json.JSONObject
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal object TelegramPackage {
    private const val assetsRoot = "telegram-package"
    private val moduleFiles = listOf("THIRD-PARTY.txt", "index.js")

    fun readAppCredentials(context: Context): JSONObject? = runCatching {
        val text = context.assets.open("$assetsRoot/api-credentials.local.json").bufferedReader().use {
            val buffer = CharArray(4097)
            var length = 0
            while (length < buffer.size) {
                val read = it.read(buffer, length, buffer.size - length)
                if (read < 0) break
                length += read
            }
            if (length > 4096) return@runCatching null
            String(buffer, 0, length).removePrefix("\uFEFF")
        }
        val config = JSONObject(text)
        JSONObject().put("api_id", config.opt("api_id")).put("api_hash", config.opt("api_hash"))
    }.getOrNull()

    fun trustedManifest(context: Context): MiniAppManifest =
        context.assets.open("$assetsRoot/client/manifest.json").bufferedReader().use {
            MiniAppManifest.parse(JSONObject(it.readText()))
        }.also { check(it.id == TelegramSessionLease.CLIENT_APP_ID) }

    fun openTrustedClientFile(context: Context, name: String) =
        context.assets.open("$assetsRoot/client/$name")

    fun openTrustedModule(context: Context, id: String) =
        if (id == "telegram") context.assets.open("$assetsRoot/module/index.js") else null

    fun hasClient(context: Context) =
        MiniAppRepository(context).get(TelegramSessionLease.CLIENT_APP_ID) != null

    fun install(context: Context, progress: (Int) -> Unit) = synchronized(SharedMiniAppStore.installLock) {
        requireFileAccess()
        val clientFiles = context.assets.list("$assetsRoot/client").orEmpty()
        if ("manifest.json" !in clientFiles || "index.html" !in clientFiles)
            throw ApiException("telegram_package_missing", "Telegram is missing from this MiniApps build")
        val steps = clientFiles.size + moduleFiles.size + 1
        var completed = 0
        val archive = File.createTempFile("telegram-client-", ".zip", context.cacheDir)
        try {
            ZipOutputStream(archive.outputStream()).use { zip ->
                clientFiles.forEach { name ->
                    zip.putNextEntry(ZipEntry(name))
                    context.assets.open("$assetsRoot/client/$name").use { it.copyTo(zip) }
                    zip.closeEntry()
                    progress(++completed * 100 / steps)
                }
            }
            val result = MiniAppInstaller(context).install(archive, trustedProvider = true)
            if (!result.installed) return@synchronized false
            installModule(context) { progress(++completed * 100 / steps) }
            progress(100)
            true
        } catch (error: InstallException) {
            throw ApiException(error.code, error.message ?: "Could not install Unofficial Telegram")
        } finally {
            archive.delete()
        }
    }

    fun installModule(context: Context, onFileInstalled: () -> Unit = {}) = synchronized(SharedMiniAppStore.installLock) {
        requireFileAccess()
        val root = SharedMiniAppStore.ensureRoot().canonicalFile
        val module = File(root, "Modules/telegram")
        if (module.canonicalFile != module)
            throw ApiException("telegram_install_failed", "Invalid Telegram module directory")
        module.mkdirs()
        for (name in moduleFiles) {
            val destination = File(module, name)
            val staged = File.createTempFile("telegram-", ".tmp", module)
            try {
                context.assets.open("$assetsRoot/module/$name").use { input ->
                    staged.outputStream().use { input.copyTo(it) }
                }
                if (!staged.renameTo(destination))
                    throw ApiException("telegram_install_failed", "Could not install the Telegram module")
                onFileInstalled()
            } finally {
                staged.delete()
            }
        }
    }

    private fun requireFileAccess() {
        if (!SharedMiniAppStore.hasFileAccess())
            throw ApiException("file_access_required", "Grant MiniApps access to the MiniApps folder first")
    }
}
