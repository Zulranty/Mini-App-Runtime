package com.example.miniapp.installer

import android.content.Context
import android.util.Log
import com.example.miniapp.BuildConfig
import com.example.miniapp.launcher.TelegramPackage
import com.example.miniapp.repository.SharedMiniAppStore
import java.io.File

internal object BundledMiniApps {
    private const val ASSETS = "bundled-apps"
    private const val COMPLETED = "completed-version"
    private const val TELEGRAM_MODULE = "telegram-module"
    fun needsCheck(context: Context): Boolean = state(context).getInt(COMPLETED, 0) != BuildConfig.VERSION_CODE ||
        MiniAppInstaller.hasInterruptedInstalls()

    private fun state(context: Context) = context.getSharedPreferences("bundled-mini-apps", Context.MODE_PRIVATE)

    // Called before opening the launcher. A failed package can be retried on the next launch.
    fun applyUpdates(context: Context): Boolean = synchronized(SharedMiniAppStore.installLock) {
        if (!SharedMiniAppStore.hasFileAccess()) return false
        val installer = MiniAppInstaller(context)
        var complete = installer.recoverInterruptedInstalls()
        val state = state(context)
        val version = BuildConfig.VERSION_CODE
        if (state.getInt(COMPLETED, 0) == version) return complete

        val archives = context.assets.list(ASSETS).orEmpty().filter { it.endsWith(".zip") }.sorted()
        check(archives.isNotEmpty()) { "No bundled mini-app packages" }
        fun apply(name: String, install: () -> Unit) {
            if (state.getInt(name, 0) == version) return
            try {
                install()
                check(state.edit().putInt(name, version).commit()) { "Could not save update state" }
            } catch (error: Exception) {
                Log.w("MiniApps", "Could not apply bundled package $name", error)
                complete = false
            }
        }
        apply(TELEGRAM_MODULE) { TelegramPackage.installModule(context) }
        for (archive in archives) apply(archive) {
            val source = File.createTempFile("bundled-miniapp-", ".zip", context.cacheDir)
            try {
                context.assets.open("$ASSETS/$archive").use { input -> source.outputStream().use(input::copyTo) }
                installer.install(source, trustedProvider = true, bundleKey = "$version/$archive")
            } finally {
                source.delete()
            }
        }
        if (complete && !MiniAppInstaller.hasInterruptedInstalls())
            complete = state.edit().putInt(COMPLETED, version).commit()
        else complete = false
        complete
    }
}
