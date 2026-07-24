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
        val fallback = validInterfaceIds().firstOrNull() ?: "default"
        if (selected != fallback) {
            base.mkdirs()
            activeFile.writeText(fallback)
        }
        return fallback
    }
    fun activeDir() = File(base, active())
    fun seedDefault() { val target=File(base,"default"); target.mkdirs(); listOf("app.js","style.css","appbar.css","appbar.js").forEach { File(target,it).delete() }; val file=File(target,"index.html"); if(!file.exists()) context.assets.open("launcher-interface/index.html").use { input -> file.outputStream().use(input::copyTo) } }
    fun list(): JSONArray { scan(); seedDefault(); val activeId=active(); return JSONArray().also { output -> validInterfaceIds().forEach { id -> output.put(JSONObject().put("id",id).put("name",id).put("active",id==activeId)) } } }
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
    fun install(source:File) { base.mkdirs(); val id=source.nameWithoutExtension.replace(Regex("[^A-Za-z0-9._-]"),"_").ifBlank{"interface"}; val target=File(base,id); val staging=File(base,".$id-${System.nanoTime()}"); try { if(source.extension.equals("zip",true)){staging.mkdirs();ZipExtractor.extract(source,staging)}else if(source.extension.equals("html",true)||source.extension.equals("htm",true)){staging.mkdirs();source.copyTo(File(staging,"index.html"),true)}else throw IllegalArgumentException("Only ZIP and HTML files are supported"); if(!File(staging,"index.html").isFile)throw IllegalArgumentException("Interface index.html is missing"); val old=File(base,".$id-old");old.deleteRecursively();if(target.exists())target.renameTo(old);if(!staging.renameTo(target))throw IllegalStateException("Could not install interface");old.deleteRecursively() } finally { staging.deleteRecursively() } }
    private fun scan() { base.mkdirs(); base.listFiles()?.filter{it.isFile&&(it.extension.equals("html",true)||it.extension.equals("htm",true)||it.extension.equals("zip",true))}?.forEach { file -> runCatching { install(file); file.delete() } } }
    private fun validInterfaceIds() = base.listFiles()?.filter { it.isDirectory && File(it, "index.html").isFile }?.map { it.name }?.sortedBy { it.lowercase() } ?: emptyList()
    private fun safe(id:String)=Regex("[A-Za-z0-9._-]+").matches(id)
    companion object {
        private const val MAX_SETTINGS_BYTES = 64 * 1024
        fun activeDir():File {
            val base=File(SharedMiniAppStore.ensureRoot(),"Interface")
            val selected=File(base,".active-interface").takeIf{it.isFile}?.readText()?.trim()?.takeIf{Regex("[A-Za-z0-9._-]+").matches(it)}
            if (selected != null && File(base, selected).let { File(it, "index.html").isFile }) return File(base, selected)
            val fallback=base.listFiles()?.filter { it.isDirectory && File(it,"index.html").isFile }?.map { it.name }?.sortedBy { it.lowercase() }?.firstOrNull() ?: "default"
            if (selected != fallback) { base.mkdirs(); File(base,".active-interface").writeText(fallback) }
            return File(base, fallback)
        }
    }
}
