package com.example.miniapp.launcher

import android.content.Context
import android.system.Os
import com.example.miniapp.installer.ZipExtractor
import com.example.miniapp.repository.SharedMiniAppStore
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

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

    fun openLauncherPage(file: File): InputStream {
        if (file.length() !in 1..128 * 1024L) return file.inputStream()
        val bytes = file.readBytes()
        for (theme in listOf("default", "Metro-Interface")) {
            val english = "$theme/index.html"
            val russian = "launcher-ru/$theme/index.html"
            if (listOf(english, russian).any { asset ->
                context.assets.open(asset).use { bytes.contentEquals(it.readBytes()) }
            }) return context.assets.open(if (AppLanguage.preference(context) == "ru") russian else english)
        }
        return bytes.inputStream()
    }
    fun seedBundled() {
        val defaultDir = File(base, "default")
        defaultDir.mkdirs()
        val defaultIndex = File(defaultDir, "index.html")
        if (defaultIndex.length() == 0L) writeBundledIndex(defaultIndex, "default")
        // Imported themes can have a different folder name. Identify stock HTML by its bytes.
        base.listFiles()?.filter { it.isDirectory }?.forEach { dir ->
            val file = File(dir, "index.html")
            when {
                matchesPreviousIndex(file, PREVIOUS_DEFAULT_HASHES) -> writeBundledIndex(file, "default")
                matchesPreviousIndex(file, PREVIOUS_METRO_HASHES) -> writeBundledIndex(file, "Metro-Interface")
                matchesPreviousIndex(file, PREVIOUS_RUSSIAN_DEFAULT_HASHES) -> writeBundledIndex(file, "launcher-ru/default")
                matchesPreviousIndex(file, PREVIOUS_RUSSIAN_METRO_HASHES) -> writeBundledIndex(file, "launcher-ru/Metro-Interface")
            }
        }
    }
    private fun writeBundledIndex(file: File, theme: String) {
        val staged = File.createTempFile(".index-", ".tmp", file.parentFile)
        try {
            context.assets.open("$theme/index.html").use { input -> staged.outputStream().use(input::copyTo) }
            Os.rename(staged.absolutePath, file.absolutePath)
        } finally {
            staged.delete()
        }
    }
    private fun matchesPreviousIndex(file: File, knownHashes: Map<Long, String>): Boolean {
        val expected = knownHashes[file.length()] ?: return false
        val hash = MessageDigest.getInstance("SHA-256").digest(file.readBytes())
            .joinToString("") { "%02x".format(it) }
        return hash == expected
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
    fun install(source:File) { base.mkdirs(); val id=source.nameWithoutExtension.replace(Regex("[^A-Za-z0-9._-]"),"_").ifBlank{"interface"}; val target=File(base,id); val staging=File(base,".$id-${System.nanoTime()}"); try { if(source.extension.equals("zip",true)){staging.mkdirs();ZipExtractor.extract(source,staging)}else if(source.extension.equals("html",true)||source.extension.equals("htm",true)){staging.mkdirs();source.copyTo(File(staging,"index.html"),true)}else throw IllegalArgumentException("Only ZIP and HTML files are supported"); if(!File(staging,"index.html").isFile)throw IllegalArgumentException("Interface index.html is missing"); val old=File(base,".$id-old");old.deleteRecursively();if(target.exists())target.renameTo(old);if(!staging.renameTo(target))throw IllegalStateException("Could not install interface");old.deleteRecursively() } finally { staging.deleteRecursively() } }
    private fun scan() { base.mkdirs(); base.listFiles()?.filter{it.isFile&&(it.extension.equals("html",true)||it.extension.equals("htm",true)||it.extension.equals("zip",true))}?.forEach { file -> runCatching { install(file); file.delete() } } }
    private fun validInterfaceIds() = base.listFiles()?.filter { it.isDirectory && File(it, "index.html").isFile }?.map { it.name }?.sortedBy { it.lowercase() } ?: emptyList()
    private fun safe(id:String)=Regex("[A-Za-z0-9._-]+").matches(id)
    companion object {
        private const val MAX_SETTINGS_BYTES = 64 * 1024
        // Replace only recognized stock templates.
        private val PREVIOUS_DEFAULT_HASHES = mapOf(
            5617L to "3125526fa47d6951428303882ab995b6280361f46f3dc4f182518c96e2bb0cae",
            5619L to "2944261adccc87e32a634eb21f24a0b50213ed36cad32a266b67fba94b40d5db",
            5746L to "1add0ddd132775ec7e01136c30c50a1db6dca2455939adb470272fd9328ae875",
            5861L to "04ff9ca62ef9705252c4c4d2e560d60fd2d866e3922996adfb2a5322f82e471d",
            5954L to "1d8b4a1256989887b55f9f49fa1b2b56b99999285d9a8f23fce195a8bdce9c03",
            5986L to "ee28365f4e5896678e36653f3fd071ab0c7ef07a70384e47c302df4918394ffc",
            6121L to "99972759500b94b1e6e54212b8af12ab20d8efa2efdf11006f413dcdb9892b36"
        )
        private val PREVIOUS_METRO_HASHES = mapOf(
            46096L to "f6e6f3d11dbb4fc6fc34612a5eb70506b4f34dd76d0e02e432d31d80dc0b7b83",
            47593L to "ef11708255e1bb0c88a008a29a79e7dccd3c530b376dd149b9e081ee04d7e9ec",
            46287L to "86e8cd66c1643946761f32766d080054ebae7bafc24341b4391c59da3aee1665",
            47789L to "1586d3a36d1995e16bdef5753c84d50bd40558445332d4e1e70b98104a8aa328",
            46862L to "165e782ddd9c5f994a92d25d5efbbc88b44f2710dca47bac880a07f5ec0a63d0",
            48377L to "f2d4195a5b5ed1d6ebc6708c04ca755c1fde542743e3dbe4d3ae3c306a77b9ba",
            46894L to "04f2746d68fc0bb488dd5c715d198eae76aec25a83228c3ac793e025682447c0",
            47034L to "e87852c4d8d38aa25add5cb9e3c6a90fe7f7c962a12c5a162cd78fe791edcd37"
        )
        private val PREVIOUS_RUSSIAN_DEFAULT_HASHES = mapOf(
            5947L to "f2641200bfae4064aea0a2c031f126ce5adf758543612fa568d1c1174fe67edb",
            5949L to "7db06a1e4c6d69e0c7b7a947c1dd45d91f04b13e56359f17fc1674b6ee7d3d65"
        )
        private val PREVIOUS_RUSSIAN_METRO_HASHES = mapOf(
            47581L to "71275520a2db3747113c11ae855de07b778a5538e3f244893d4ebf30b27118f5",
            49079L to "19b98fe9864c9c1389f094094cd3968c499323492e764916e7dcd115de7e729b"
        )
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
