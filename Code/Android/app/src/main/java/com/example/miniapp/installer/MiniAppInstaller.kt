package com.example.miniapp.installer

import android.content.Context
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.services.AppInfoService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class InstallOutcome(val manifest: MiniAppManifest, val installed: Boolean, val addedPermissions:Set<String> = emptySet(), val removedPermissions:Set<String> = emptySet())

/** The only installer used by scanning and picker imports. It never trusts a file name as app identity. */
class MiniAppInstaller(private val context: Context) {
    fun install(source: File, manualManifest: MiniAppManifest? = null): InstallOutcome = synchronized(SharedMiniAppStore.installLock) {
        if (!source.isFile) throw InstallException("source_file_not_found", "Source file was not found")
        val ext = source.extension.lowercase()
        if (ext !in setOf("zip", "html", "htm")) throw InstallException("source_file_invalid", "Only ZIP and HTML files are supported")
        val staging = File(context.cacheDir, "miniapp-stage-${System.nanoTime()}").apply { mkdirs() }
        try {
            val manifest = if (ext == "zip") stageZip(source, staging) else stageHtml(source, staging, manualManifest)
            val existingDir = SharedMiniAppStore.findDirById(manifest.id)
            val existing = existingDir?.let { SharedMiniAppStore.readManifest(it) }
            // Re-importing the same version can deliver a corrected package without
            // a version bump. Older versions remain rejected.
            if (existing != null && SemVer.compare(manifest.version, existing.version) < 0)
                return@synchronized InstallOutcome(existing, false)
            val target = existingDir ?: File(SharedMiniAppStore.ensureRoot(), SharedMiniAppStore.folderForId(manifest.id))
            replaceAtomically(staging, target, source, ext)
            AppInfoService.recordInstall(context, manifest.id)
            val added = manifest.permissions - (existing?.permissions ?: emptySet())
            val removed = (existing?.permissions ?: emptySet()) - manifest.permissions
            // Added declarations intentionally have no persisted decision (prompt).
            context.getSharedPreferences("permissions.${manifest.id}", Context.MODE_PRIVATE).edit().apply {
                removed.forEach(::remove)
            }.apply()
            InstallOutcome(manifest, true, added, removed)
        } finally { if (staging.exists()) staging.deleteRecursively() }
    }

    fun installToDirectory(zip: File, @Suppress("UNUSED_PARAMETER") target: File): MiniAppManifest = install(zip).manifest
    fun installHtmlToDirectory(html: File, @Suppress("UNUSED_PARAMETER") target: File): MiniAppManifest = install(html).manifest
    fun installHtmlWithManifestToDirectory(html: File, @Suppress("UNUSED_PARAMETER") target: File, manifest: MiniAppManifest): MiniAppManifest = install(html, manifest).manifest

    private fun stageZip(source: File, staging: File): MiniAppManifest {
        if (source.length() > RuntimeLimits.MAX_ARCHIVE_SIZE_MB * 1024L * 1024L) throw InstallException("source_file_invalid", "Archive too large")
        ZipExtractor.extract(source, staging)
        val manifestFile = File(staging, "manifest.json")
        if (!manifestFile.isFile) throw InstallException("source_file_invalid", "manifest.json is missing")
        return MiniAppManifest.parse(JSONObject(manifestFile.readText())).also { ManifestValidator.validate(it, staging) }
    }
    private fun stageHtml(source: File, staging: File, manual: MiniAppManifest?): MiniAppManifest {
        val sourceManifest = manual ?: runCatching { HtmlManifestReader.read(source) }
            .getOrElse { throw InstallException("source_file_invalid", "HTML manifest is required") }
        val manifest = sourceManifest.copy(entry = HtmlManifestReader.entryForName(sourceManifest.name))
        source.copyTo(File(staging, manifest.entry), overwrite = true)
        writeManifest(File(staging, "manifest.json"), manifest)
        ManifestValidator.validate(manifest, staging)
        return manifest
    }
    private fun replaceAtomically(next: File, target: File, source: File, ext: String) {
        val root = SharedMiniAppStore.ensureRoot(); val backup = File(root, ".${target.name}.old"); val ready = File(root, ".${target.name}.new")
        val rollback = File(root, ".runtime/rollback/${readManifest(next).id}"); val rollbackApp = File(rollback,"app")
        backup.deleteRecursively(); ready.deleteRecursively()
        try {
            if (!next.renameTo(ready)) { next.copyRecursively(ready, true); next.deleteRecursively() }
            if (target.exists() && !target.renameTo(backup)) throw InstallException("install_failed", "Could not back up the current app")
            if (!ready.renameTo(target)) throw InstallException("install_failed", "Could not finalize installation")
            File(backup, "storage.json").takeIf { it.isFile }?.copyTo(File(target, "storage.json"), overwrite = true)
            // Retain exactly one complete previous version. Do not put it into the active scan tree.
            rollback.deleteRecursively(); rollback.mkdirs()
            if (backup.exists() && !backup.renameTo(rollbackApp)) throw InstallException("install_failed", "Could not prepare rollback copy")
            // A rollback snapshot exists only after an update. On a first install
            // rollbackApp is absent, so attempting to read its manifest would make
            // the otherwise successful import fail.
            if (rollbackApp.isDirectory) {
                File(rollback,"rollback.json").writeText(JSONObject().put("format","miniapps-rollback").put("formatVersion",1).put("appId",readManifest(target).id).put("currentVersion",readManifest(target).version).put("previousVersion",readManifest(rollbackApp).version).put("createdAt",java.time.Instant.now().toString()).toString())
            } else {
                rollback.deleteRecursively()
            }
            if (source.parentFile?.canonicalFile == root.canonicalFile) source.delete()
        } catch (error: Exception) {
            if (target.exists() && backup.exists()) target.deleteRecursively()
            if (backup.exists() && !target.exists()) backup.renameTo(target)
            if (!target.exists() && rollbackApp.exists()) rollbackApp.renameTo(target)
            throw error
        } finally { ready.deleteRecursively() }
    }
    private fun readManifest(dir: File) = MiniAppManifest.parse(JSONObject(File(dir, "manifest.json").readText()))
    private fun writeManifest(file: File, m: MiniAppManifest) {
        file.writeText(JSONObject().put("id", m.id).put("name", m.name).put("version", m.version).put("sdkVersion", m.sdkVersion).put("entry", m.entry).apply {
            m.description?.let { put("description", it) }; m.author?.let { put("author", it) }; m.icon?.let { put("icon", it) }; m.minRuntimeVersion?.let { put("minRuntimeVersion", it) }; m.network?.let { n -> put("network", JSONObject().put("allow",JSONArray(n.allow.toList())).put("allowSubdomains",n.allowSubdomains).put("allowHttp",n.allowHttp).put("allowLocalNetwork",n.allowLocalNetwork).put("discoveryServices",JSONArray(n.discoveryServices.sorted()))) }; put("permissions", JSONArray(m.permissions.toList()))
        }.toString(2))
    }
}
