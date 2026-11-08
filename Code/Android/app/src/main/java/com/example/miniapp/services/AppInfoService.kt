package com.example.miniapp.services

import android.content.Context
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.SharedMiniAppStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** Metadata and physical storage accounting exposed to the owning mini-app only. */
object AppInfoService {
    private fun prefs(context: Context, id: String) = context.getSharedPreferences("app-info.$id", Context.MODE_PRIVATE)

    fun recordInstall(context: Context, id: String) {
        val now = Instant.now().toString(); val store = prefs(context, id)
        store.edit().apply { if (!store.contains("installedAt")) putString("installedAt", now); putString("updatedAt", now) }.apply()
    }
    fun clear(context: Context, id: String) { prefs(context, id).edit().clear().apply() }

    fun get(context: Context, manifest: MiniAppManifest): JSONObject {
        val directory = SharedMiniAppStore.findDirById(manifest.id) ?: throw IllegalStateException("Application was not found")
        val store = prefs(context, manifest.id); val fallback = Instant.ofEpochMilli(directory.lastModified()).toString()
        val installedAt = store.getString("installedAt", fallback) ?: fallback; val updatedAt = store.getString("updatedAt", installedAt) ?: installedAt
        val publicData = sizeOf(File(directory, "storage.json")) + sizeOf(File(directory, "storage.json.bak"))
        val prefsDir = File(context.applicationInfo.dataDir, "shared_prefs")
        val privateData = sizeOf(File(prefsDir, "mini.${manifest.id}.xml")); val secureData = sizeOf(File(prefsDir, "secure-mini.${manifest.id}.xml"))
        val appSize = directory.walkTopDown().filter { it.isFile && it.name !in setOf("storage.json", "storage.json.bak") }.sumOf { it.length() }
        return JSONObject().put("id", manifest.id).put("name", manifest.name).put("version", manifest.version).put("sdkVersion", manifest.sdkVersion)
            .put("entry", manifest.entry).put("description", manifest.description).put("author", manifest.author).put("icon", manifest.icon).put("minRuntimeVersion", manifest.minRuntimeVersion)
            .put("permissions", JSONArray(manifest.permissions.sorted())).put("installedAt", installedAt).put("updatedAt", updatedAt)
            .put("appSizeBytes", appSize).put("dataSizeBytes", publicData + privateData + secureData).put("publicDataSizeBytes", publicData).put("privateDataSizeBytes", privateData).put("secureDataSizeBytes", secureData)
            .put("network", manifest.network?.let { JSONObject().put("allow", JSONArray(it.allow.sorted())).put("allowSubdomains", it.allowSubdomains).put("allowHttp", it.allowHttp).put("allowLocalNetwork", it.allowLocalNetwork).put("discoveryServices", JSONArray(it.discoveryServices.sorted())) })
    }
    private fun sizeOf(file: File) = if (file.isFile) file.length() else 0L
}
