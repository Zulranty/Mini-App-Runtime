package com.example.miniapp.launcher

import android.content.Context
import android.system.Os
import com.example.miniapp.installer.ZipExtractor
import com.example.miniapp.repository.SharedMiniAppStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets

/** Launcher themes are ordinary externally editable HTML modules. */
class LauncherInterfaceStore(private val context: Context) {
    private val base get() = File(SharedMiniAppStore.ensureRoot(), "Interface")
    private val activeFile get() = File(base, ".active-interface")
    fun active(): String {
        val selected = activeFile.takeIf { it.isFile }?.readText()?.trim()?.takeIf { safe(it) }
        if (selected != null && File(base, selected).let { File(it, "index.html").isFile }) return selected
        val fallback = "default"
        if (selected != fallback) {
            base.mkdirs()
            activeFile.writeText(fallback)
        }
        return fallback
    }
    fun activeDir() = File(base, active())

    fun seedBundled() {
        for (theme in bundledThemes) {
            val folder = File(base, theme)
            val index = File(folder, "index.html")
            if (index.length() == 0L) {
                folder.mkdirs()
                writeBundledIndex(index, theme)
            }
        }
    }

    fun readIndex(directory: File): String =
        if (directory.name in bundledThemes)
            context.assets.open("${directory.name}/index.html").bufferedReader().use { it.readText() }
        else File(directory, "index.html").readText()

    private fun writeBundledIndex(file: File, theme: String) {
        val staged = File.createTempFile(".index-", ".tmp", file.parentFile)
        try {
            context.assets.open("$theme/index.html").use { input -> staged.outputStream().use(input::copyTo) }
            Os.rename(staged.absolutePath, file.absolutePath)
        } finally {
            staged.delete()
        }
    }
    fun list(): JSONArray { scan(); seedBundled(); val activeId=active(); return JSONArray().also { output -> validInterfaceIds().forEach { id -> output.put(JSONObject().put("id",id).put("name",id).put("active",id==activeId)) } } }
    fun select(id:String) { val dir=File(base,id); if(!safe(id)||!File(dir,"index.html").isFile) throw IllegalArgumentException("Interface not found"); base.mkdirs(); activeFile.writeText(id) }
    fun getSettings(): JSONObject {
        val file = File(activeDir(), "settings.json")
        if (!file.isFile) return JSONObject()
        return runCatching { JSONObject(file.readText()) }.getOrElse { JSONObject() }
    }
    fun setSettings(settings: JSONObject) {
        val target = File(activeDir(), "settings.json")
        val bytes = settings.toString().toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_SETTINGS_BYTES) throw IllegalArgumentException("Interface settings exceed 64 KiB")
        target.parentFile?.mkdirs()
        val temporary = File(target.parentFile, ".settings-${System.nanoTime()}.tmp")
        try {
            temporary.outputStream().use { it.write(bytes); it.fd.sync() }
            Os.rename(temporary.absolutePath, target.absolutePath)
        } finally { if (temporary.exists()) temporary.delete() }
    }
    fun install(source:File, sourceName: String = source.name) {
        val id = sourceName.substringBeforeLast('.').replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "interface" }
        require(safe(id) && bundledThemes.none { it.equals(id, ignoreCase = true) }) { "Interface name is reserved or invalid" }
        base.mkdirs()
        val target = File(base, id)
        val staging = File(base, ".$id-${System.nanoTime()}")
        try {
            staging.mkdirs()
            when (sourceName.substringAfterLast('.', "").lowercase()) {
                "zip" -> ZipExtractor.extract(source, staging)
                "html", "htm" -> source.copyTo(File(staging, "index.html"), true)
                else -> throw IllegalArgumentException("Only ZIP and HTML files are supported")
            }
            require(File(staging, "index.html").isFile) { "Interface index.html is missing" }
            val old = File(base, ".${staging.name.drop(1)}-old")
            if (target.exists()) Os.rename(target.absolutePath, old.absolutePath)
            try {
                Os.rename(staging.absolutePath, target.absolutePath)
            } catch (error: Exception) {
                if (old.exists()) Os.rename(old.absolutePath, target.absolutePath)
                throw error
            }
            if (old.exists()) old.deleteRecursively()
        } finally { staging.deleteRecursively() }
    }
    private fun scan() { base.mkdirs(); base.listFiles()?.filter{it.isFile&&(it.extension.equals("html",true)||it.extension.equals("htm",true)||it.extension.equals("zip",true))}?.forEach { file -> runCatching { install(file); file.delete() } } }
    private fun validInterfaceIds() = base.listFiles()?.filter { it.isDirectory && File(it, "index.html").isFile }?.map { it.name }?.sortedBy { it.lowercase() } ?: emptyList()
    private fun safe(id:String)=Regex("[A-Za-z0-9._-]+").matches(id) && id != "." && id != ".."
    companion object {
        private const val MAX_SETTINGS_BYTES = 64 * 1024
        private val bundledThemes = listOf("default", "Metro-Interface")
        fun activeDir():File {
            val base=File(SharedMiniAppStore.ensureRoot(),"Interface")
            val selected=File(base,".active-interface").takeIf{it.isFile}?.readText()?.trim()?.takeIf{Regex("[A-Za-z0-9._-]+").matches(it)}
            if (selected != null && File(base, selected).let { File(it, "index.html").isFile }) return File(base, selected)
            val fallback = "default"
            if (selected != fallback) { base.mkdirs(); File(base,".active-interface").writeText(fallback) }
            return File(base, fallback)
        }
    }
}
