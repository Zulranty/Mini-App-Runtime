package com.example.miniapp.model

import org.json.JSONObject
import com.example.miniapp.installer.InstallException

data class NetworkConfig(val allow:Set<String>, val allowSubdomains:Boolean=false, val allowHttp:Boolean=false, val allowLocalNetwork:Boolean=false, val discoveryServices:Set<String> = emptySet())
data class AppTranslation(val name: String?, val description: String?)
data class MiniAppManifest(val id:String,val name:String,val version:String,val sdkVersion:Int,val entry:String,val description:String?,val author:String?,val icon:String?,val permissions:Set<String>,val minRuntimeVersion:String?=null,val network:NetworkConfig?=null,
    val translations: Map<String, AppTranslation> = emptyMap()) {
 fun localize(preference: String): MiniAppManifest {
    val translation = translations[preference] ?: return this
    return copy(name = translation.name ?: name, description = translation.description ?: description)
 }

 companion object {
    private fun invalidTranslations(): Nothing = throw InstallException("Invalid app translations")

    private fun readTranslations(json: JSONObject): Map<String, AppTranslation> {
        if (json.isNull("translations")) return emptyMap()
        val definitions = json.optJSONObject("translations") ?: invalidTranslations()
        return buildMap {
            for (language in definitions.keys()) {
                if (language != "en" && language != "ru") invalidTranslations()
                val fields = definitions.optJSONObject(language) ?: invalidTranslations()
                if (fields.keys().asSequence().any { it != "name" && it != "description" }) invalidTranslations()
                val name = readText(fields, "name", 256)
                val description = readText(fields, "description", 1024)
                if (name == null && description == null) invalidTranslations()
                put(language, AppTranslation(name, description))
            }
        }
    }

    private fun readText(fields: JSONObject, key: String, limit: Int): String? {
        if (!fields.has(key)) return null
        return (fields.opt(key) as? String)?.takeIf { it.isNotBlank() && it.length <= limit }
            ?: invalidTranslations()
    }

    fun parse(json: JSONObject): MiniAppManifest {
        val network = json.optJSONObject("network")?.let { n ->
            NetworkConfig(strings(n, "allow"), n.optBoolean("allowSubdomains", false), n.optBoolean("allowHttp", false),
                n.optBoolean("allowLocalNetwork", false), strings(n, "discoveryServices"))
        }
        val entry = json.optString("entry")
        return MiniAppManifest(json.optString("id"), json.optString("name"), json.optString("version"),
            json.optInt("sdkVersion", -1), entry, json.optString("description").ifBlank { null },
            json.optString("author").ifBlank { null }, json.optString("icon").ifBlank { null }, strings(json, "permissions"),
            json.optString("minRuntimeVersion").ifBlank { null }, network, readTranslations(json))
    }

    private fun strings(json: JSONObject, key: String) = buildSet {
        json.optJSONArray(key)?.let { array -> for (i in 0 until array.length()) add(array.optString(i)) }
    }
 }
}
data class InstalledMiniApp(val manifest: MiniAppManifest)
enum class MiniAppPermission { STORAGE, CLIPBOARD_WRITE, CLIPBOARD_READ, FILES_PICK, FILES_SAVE, FILES_DIRECTORY, SHARE, SECURE_STORAGE, NETWORK, NOTIFICATIONS, SYSTEM_OPEN, HAPTICS, LOCAL_PEERS, TELEGRAM_SESSION; companion object { fun fromWire(value:String)=entries.firstOrNull { it.name.lowercase().replace('_','.') == value } ?: if(value=="secureStorage") SECURE_STORAGE else null } }
