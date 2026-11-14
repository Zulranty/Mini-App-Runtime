package com.example.miniapp.model

import org.json.JSONObject
import com.example.miniapp.launcher.AppLanguage
import com.example.miniapp.installer.InstallException

data class NetworkConfig(val allow:Set<String>, val allowSubdomains:Boolean=false, val allowHttp:Boolean=false, val allowLocalNetwork:Boolean=false, val discoveryServices:Set<String> = emptySet())
data class LocalizedEntry(val entry: String, val name: String?, val description: String?)
data class MiniAppManifest(val id:String,val name:String,val version:String,val sdkVersion:Int,val entry:String,val description:String?,val author:String?,val icon:String?,val permissions:Set<String>,val minRuntimeVersion:String?=null,val network:NetworkConfig?=null,
    val defaultLanguage:String?=null, val locales:Map<String,LocalizedEntry> = emptyMap(), val language:String?=null) {
 fun localize(preference: String): MiniAppManifest {
    val fallback = defaultLanguage ?: return this
    val resolved = AppLanguage.match(preference, locales.keys, fallback)
    val locale = locales.getValue(resolved)
    return copy(entry = locale.entry, name = locale.name ?: name, description = locale.description ?: description, language = resolved)
 }

 companion object {
    private val localeEntry = Regex("[A-Za-z0-9_./-]{1,240}")
    private fun invalidLocales(): Nothing = throw InstallException("Invalid localized app entries")

    private fun readLocales(json: JSONObject, entry: String): Pair<String?, Map<String, LocalizedEntry>> {
        if (json.isNull("locales") && json.isNull("defaultLanguage")) return null to emptyMap()
        val definitions = json.optJSONObject("locales") ?: invalidLocales()
        val fallback = AppLanguage.normalize(json.opt("defaultLanguage") as? String) ?: invalidLocales()
        if (definitions.length() !in 1..32) invalidLocales()
        val entries = buildMap {
            for (tag in definitions.keys()) {
                val language = AppLanguage.normalize(tag) ?: invalidLocales()
                val definition = definitions.optJSONObject(tag) ?: invalidLocales()
                val path = definition.opt("entry") as? String ?: invalidLocales()
                if (!localeEntry.matches(path) || !path.endsWith(".html", ignoreCase = true) ||
                    path.split('/').any { it.isEmpty() || it == "." || it == ".." } || containsKey(language)) invalidLocales()
                fun optionalText(key: String, limit: Int): String? {
                    if (definition.isNull(key)) return null
                    return (definition.opt(key) as? String)?.takeIf { it.length <= limit } ?: invalidLocales()
                }
                put(language, LocalizedEntry(path, optionalText("name", 256), optionalText("description", 1024)))
            }
        }
        if (entries[fallback]?.entry != entry) invalidLocales()
        return fallback to entries
    }

    fun parse(json: JSONObject): MiniAppManifest {
        val network = json.optJSONObject("network")?.let { n ->
            NetworkConfig(strings(n, "allow"), n.optBoolean("allowSubdomains", false), n.optBoolean("allowHttp", false),
                n.optBoolean("allowLocalNetwork", false), strings(n, "discoveryServices"))
        }
        val entry = json.optString("entry")
        val (fallback, locales) = readLocales(json, entry)
        return MiniAppManifest(json.optString("id"), json.optString("name"), json.optString("version"),
            json.optInt("sdkVersion", -1), entry, json.optString("description").ifBlank { null },
            json.optString("author").ifBlank { null }, json.optString("icon").ifBlank { null }, strings(json, "permissions"),
            json.optString("minRuntimeVersion").ifBlank { null }, network, fallback, locales)
    }

    private fun strings(json: JSONObject, key: String) = buildSet {
        json.optJSONArray(key)?.let { array -> for (i in 0 until array.length()) add(array.optString(i)) }
    }
 }
}
data class InstalledMiniApp(val manifest: MiniAppManifest)
enum class MiniAppPermission { STORAGE, CLIPBOARD_WRITE, CLIPBOARD_READ, FILES_PICK, FILES_SAVE, FILES_DIRECTORY, SHARE, SECURE_STORAGE, NETWORK, NOTIFICATIONS, SYSTEM_OPEN, HAPTICS, LOCAL_PEERS, TELEGRAM_SESSION; companion object { fun fromWire(value:String)=entries.firstOrNull { it.name.lowercase().replace('_','.') == value } ?: if(value=="secureStorage") SECURE_STORAGE else null } }
