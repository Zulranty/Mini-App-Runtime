package com.example.miniapp.installer

import android.content.Context
import android.util.Log
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.services.AppInfoService
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.security.MessageDigest
import java.util.UUID

data class InstallOutcome(val manifest: MiniAppManifest, val installed: Boolean, val addedPermissions:Set<String> = emptySet(), val removedPermissions:Set<String> = emptySet())

/** The only installer used by scanning and picker imports. It never trusts a file name as app identity. */
class MiniAppInstaller(private val context: Context) {
    internal fun install(source: File, manualManifest: MiniAppManifest? = null, trustedProvider: Boolean = false, bundleKey: String? = null): InstallOutcome = synchronized(SharedMiniAppStore.installLock) {
        if (!source.isFile) throw InstallException("source_file_not_found", "Source file was not found")
        val ext = source.extension.lowercase()
        if (ext !in setOf("zip", "html", "htm")) throw InstallException("source_file_invalid", "Only ZIP and HTML files are supported")
        recoverInterruptedInstalls()
        if (!source.isFile) throw InstallException("source_file_not_found", "Source was already processed")
        val root = SharedMiniAppStore.ensureRoot()
        val scannedSource = source.takeIf { it.canonicalFile.parentFile == root.canonicalFile }
        val scannedHash = scannedSource?.let(::sourceHash)
        val staging = File(context.cacheDir, "miniapp-stage-${System.nanoTime()}").apply { mkdirs() }
        try {
            val manifest = if (ext == "zip") stageZip(source, staging) else stageHtml(source, staging, manualManifest)
            if (manifest.id == com.example.miniapp.runtime.TelegramSessionLease.CLIENT_APP_ID && !trustedProvider)
                throw InstallException("source_file_invalid", "Install the Telegram provider from the launcher")
            if (bundleKey != null && bundleState().getString(manifest.id, null) == bundleKey)
                return@synchronized InstallOutcome(manifest, false)
            val existingDir = SharedMiniAppStore.findDirById(manifest.id)
            val existing = existingDir?.let { SharedMiniAppStore.readManifest(it) }
            // Re-importing the same version can deliver a corrected package without
            // a version bump. Older versions remain rejected.
            if (existing != null && SemVer.compare(manifest.version, existing.version) < 0)
                return@synchronized InstallOutcome(existing, false)
            val target = existingDir ?: File(SharedMiniAppStore.ensureRoot(), SharedMiniAppStore.folderForId(manifest.id))
            if (target.name.equals(SharedMiniAppStore.MODULES_DIR, ignoreCase = true))
                throw InstallException("source_file_invalid", "Modules is reserved for shared libraries")
            replaceAtomically(staging, target, manifest, existing, scannedSource, scannedHash, bundleKey)
            val added = manifest.permissions - (existing?.permissions ?: emptySet())
            val removed = (existing?.permissions ?: emptySet()) - manifest.permissions
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
        if (sourceManifest.locales.isNotEmpty()) throw InstallException("Localized entries require a ZIP package")
        val manifest = sourceManifest.copy(entry = HtmlManifestReader.entryForName(sourceManifest.name))
        source.copyTo(File(staging, manifest.entry), overwrite = true)
        writeManifest(File(staging, "manifest.json"), manifest)
        ManifestValidator.validate(manifest, staging)
        return manifest
    }
    internal fun rollback(appId: String) = synchronized(SharedMiniAppStore.installLock) {
        recoverInterruptedInstalls()
        val target = SharedMiniAppStore.findDirById(appId)
            ?: throw InstallException("rollback_not_available", "Application was not found")
        recoverTarget(target)
        val previous = File(rollbackDirectory(SharedMiniAppStore.ensureRoot(), appId), "app")
        if (!previous.isDirectory) throw InstallException("rollback_not_available", "Rollback is not available")
        val manifest = readManifest(previous)
        if (manifest.id != appId) throw InstallException("rollback_failed", "Rollback metadata is invalid")
        ManifestValidator.validate(manifest, previous)
        replaceAtomically(previous, target, manifest, readManifest(target))
    }

    private fun replaceAtomically(
        source: File, target: File, next: MiniAppManifest, current: MiniAppManifest?,
        scannedSource: File? = null, scannedHash: String? = null, bundleKey: String? = null
    ) {
        recoverTarget(target)
        val transaction = File(installStagingRoot(), target.name)
        if (target.exists() && current == null)
            throw InstallException("install_failed", "Application folder is already in use")
        if (current != null && !target.isDirectory)
            throw InstallException("install_failed", "The active application disappeared")
        val slot = rollbackDirectory(SharedMiniAppStore.ensureRoot(), next.id)
        val ready = File(transaction, "new")
        val backup = File(transaction, "old")
        val retained = File(transaction, "retained")
        val journal = File(transaction, "install.json")
        if (!transaction.mkdirs()) throw InstallException("install_failed", "Could not create staging directory")
        try {
            if (!source.copyRecursively(ready, overwrite = true))
                throw InstallException("install_failed", "Could not stage the application")
            if (current != null) {
                for (name in publicFiles) {
                    val existing = File(target, name)
                    val staged = File(ready, name)
                    if (existing.isFile) existing.copyTo(staged, overwrite = true)
                    else if (staged.exists() && !staged.delete())
                        throw InstallException("install_failed", "Could not clear staged public data")
                }
                val rollbackRoot = checkNotNull(slot.parentFile)
                if (!retained.mkdir() || (!rollbackRoot.isDirectory && !rollbackRoot.mkdirs()))
                    throw InstallException("install_failed", "Could not prepare rollback directory")
                writeRollbackMetadata(retained, next, current)
            }
            val timestamp = Instant.now().toString()
            val permissions = current?.permissions.orEmpty() intersect next.permissions
            val intent = JSONObject().put("id", next.id).put("version", next.version)
                .put("token", UUID.randomUUID().toString()).put("timestamp", timestamp)
                .put("retain", JSONArray(permissions.sorted()))
            if (scannedSource != null) intent.put("source", scannedSource.name).put("sourceHash", scannedHash)
            if (bundleKey != null) intent.put("bundle", bundleKey)
            writeIntent(transaction, intent)
            if (current != null) move(target, backup)
            move(ready, target) // Commit. The journal stays until post-commit work is replayed.
        } catch (error: Exception) {
            try { recover(transaction) } catch (recovery: Exception) { error.addSuppressed(recovery) }
            throw error
        }

        try {
            finishInstall(transaction, target, JSONObject(journal.readText()))
        } catch (error: Exception) {
            Log.w("MiniApps", "Application installed; finalization will be retried for ${next.id}", error)
        }
    }

    private fun writeRollbackMetadata(directory: File, current: MiniAppManifest, previous: MiniAppManifest) {
        File(directory, "rollback.json").writeText(JSONObject().put("format", "miniapps-rollback")
            .put("formatVersion", 1).put("appId", current.id).put("currentVersion", current.version)
            .put("previousVersion", previous.version).put("createdAt", Instant.now().toString()).toString())
    }

    private fun writeIntent(transaction: File, intent: JSONObject) {
        val temporary = File(transaction, "intent.tmp")
        temporary.outputStream().use {
            it.write(intent.toString().toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
        move(temporary, File(transaction, "install.json"))
    }

    private fun finishInstall(transaction: File, target: File, intent: JSONObject) {
        val installed = readManifest(target)
        if (installed.id != intent.getString("id") || installed.version != intent.getString("version"))
            throw InstallException("install_failed", "The active application differs from the installation journal")
        val token = intent.getString("token")
        val prefs = context.getSharedPreferences("permissions.${installed.id}", Context.MODE_PRIVATE)
        if (prefs.getString(INSTALL_TOKEN, null) != token) {
            val retainedPermissions = intent.getJSONArray("retain").let { entries ->
                (0 until entries.length()).map(entries::getString).toSet()
            }
            val edit = prefs.edit().putString(INSTALL_TOKEN, token)
            (prefs.all.keys - retainedPermissions - INSTALL_TOKEN).forEach { edit.remove(it) }
            check(edit.commit()) { "Could not reconcile application permissions" }
        }
        AppInfoService.recordInstall(context, installed.id, intent.getString("timestamp"))

        val backup = File(transaction, "old")
        val retained = File(transaction, "retained")
        if (retained.isDirectory) {
            val slot = rollbackDirectory(SharedMiniAppStore.ensureRoot(), installed.id)
            if (backup.isDirectory) move(backup, File(retained, "app"))
            if (slot.exists()) move(slot, File(transaction, "retired"))
            move(retained, slot)
        }
        discard(File(transaction, "retired"))
        intent.optString("bundle").takeIf(String::isNotEmpty)?.let { bundle ->
            check(bundleState().edit().putString(installed.id, bundle).commit()) { "Could not persist bundled update" }
        }
        val sourceName = intent.optString("source")
        if (sourceName.isNotEmpty() && sourceName == File(sourceName).name && sourceName !in setOf(".", "..")) {
            val source = File(SharedMiniAppStore.root(), sourceName)
            if (source.isFile && sourceHash(source) == intent.optString("sourceHash") && !source.delete())
                throw InstallException("install_failed", "Could not remove the processed import")
        }
        clearTransaction(transaction)
    }

    private fun recover(transaction: File) {
        val target = File(SharedMiniAppStore.ensureRoot(), transaction.name)
        val journal = File(transaction, "install.json")
        val ready = File(transaction, "new")
        val backup = File(transaction, "old")
        if (journal.isFile && !ready.exists() && target.isDirectory) {
            finishInstall(transaction, target, JSONObject(journal.readText()))
            return
        }
        if (backup.isDirectory) {
            if (target.exists()) {
                // Older builds could switch the active directory without writing a journal.
                val installed = readManifest(target)
                val previous = readManifest(backup)
                if (installed.id != previous.id)
                    throw InstallException("install_failed", "Application folder is already in use")
                val retained = File(transaction, "retained")
                if (!retained.isDirectory && !retained.mkdir())
                    throw InstallException("install_failed", "Could not prepare rollback directory")
                writeRollbackMetadata(retained, installed, previous)
                val slot = rollbackDirectory(SharedMiniAppStore.ensureRoot(), installed.id)
                slot.parentFile!!.mkdirs()
                val intent = JSONObject().put("id", installed.id).put("version", installed.version)
                    .put("token", UUID.randomUUID().toString()).put("timestamp", Instant.now().toString())
                    .put("retain", JSONArray((installed.permissions intersect previous.permissions).sorted()))
                discard(ready)
                writeIntent(transaction, intent)
                finishInstall(transaction, target, intent)
                return
            }
            move(backup, target)
        }
        // Remove the intent before deleting the uncommitted candidate.
        if (journal.exists() && !journal.delete())
            throw InstallException("install_failed", "Could not clear installation journal")
        discard(transaction)
    }

    internal fun recoverInterruptedInstalls(): Boolean = synchronized(SharedMiniAppStore.installLock) {
        var complete = true
        installStagingRoot().listFiles()?.filter(File::isDirectory)?.forEach { transaction ->
            try {
                recover(transaction)
            } catch (error: Exception) {
                complete = false
                Log.w("MiniApps", "Could not recover installation for ${transaction.name}", error)
            }
        }
        complete
    }

    internal fun recoverTarget(target: File) = synchronized(SharedMiniAppStore.installLock) {
        val transaction = File(installStagingRoot(), target.name)
        if (transaction.exists()) recover(transaction)
    }

    private fun clearTransaction(transaction: File) {
        val journal = File(transaction, "install.json")
        if (!journal.delete()) throw InstallException("install_failed", "Could not clear installation journal")
        discard(transaction)
    }

    private fun move(source: File, destination: File) {
        if (!source.renameTo(destination)) throw InstallException("install_failed", "Could not move ${source.name} to ${destination.name}")
    }

    private fun discard(file: File) {
        if (!file.deleteRecursively()) throw InstallException("install_failed", "Could not clean up ${file.name}")
    }

    private fun rollbackDirectory(root: File, appId: String): File {
        val base = File(root.canonicalFile, ".runtime/rollback")
        val directory = File(base, appId)
        if (directory.parentFile != base || directory.canonicalFile != directory || appId in setOf("", ".", ".."))
            throw InstallException("install_failed", "Invalid rollback directory")
        return directory
    }

    companion object {
        private const val INSTALL_TOKEN = "__mini_install_token"
        private val publicFiles = listOf("storage.json", "storage.json.bak")
        private fun installStagingRoot() = File(SharedMiniAppStore.root(), ".runtime/install-staging")
        internal fun hasInterruptedInstalls() = installStagingRoot().listFiles()?.any(File::isDirectory) == true
    }

    private fun bundleState() = context.getSharedPreferences("committed-bundled-apps", Context.MODE_PRIVATE)

    private fun sourceHash(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var size = input.read(buffer)
            while (size != -1) {
                digest.update(buffer, 0, size)
                size = input.read(buffer)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun readManifest(dir: File) = MiniAppManifest.parse(JSONObject(File(dir, "manifest.json").readText()))
    private fun writeManifest(file: File, m: MiniAppManifest) {
        file.writeText(JSONObject().put("id", m.id).put("name", m.name).put("version", m.version).put("sdkVersion", m.sdkVersion).put("entry", m.entry).apply {
            m.description?.let { put("description", it) }; m.author?.let { put("author", it) }; m.icon?.let { put("icon", it) }; m.minRuntimeVersion?.let { put("minRuntimeVersion", it) }; m.network?.let { n -> put("network", JSONObject().put("allow",JSONArray(n.allow.toList())).put("allowSubdomains",n.allowSubdomains).put("allowHttp",n.allowHttp).put("allowLocalNetwork",n.allowLocalNetwork).put("discoveryServices",JSONArray(n.discoveryServices.sorted()))) }; put("permissions", JSONArray(m.permissions.toList()))
        }.toString(2))
    }
}
