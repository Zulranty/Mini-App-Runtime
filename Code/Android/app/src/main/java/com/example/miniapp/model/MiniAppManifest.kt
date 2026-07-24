package com.example.miniapp.model

import org.json.JSONObject

data class NetworkConfig(val allow:Set<String>, val allowSubdomains:Boolean=false, val allowHttp:Boolean=false, val allowLocalNetwork:Boolean=false)
data class MiniAppManifest(val id:String,val name:String,val version:String,val sdkVersion:Int,val entry:String,val description:String?,val author:String?,val icon:String?,val permissions:Set<String>,val minRuntimeVersion:String?=null,val network:NetworkConfig?=null) {
 companion object { fun parse(json: JSONObject):MiniAppManifest { val network=json.optJSONObject("network")?.let { n -> NetworkConfig(buildSet { n.optJSONArray("allow")?.let { a -> for(i in 0 until a.length()) add(a.optString(i)) } },n.optBoolean("allowSubdomains",false),n.optBoolean("allowHttp",false),n.optBoolean("allowLocalNetwork",false)) }; return MiniAppManifest(json.optString("id"),json.optString("name"),json.optString("version"),json.optInt("sdkVersion", -1),json.optString("entry"),json.optString("description").ifBlank { null },json.optString("author").ifBlank { null },json.optString("icon").ifBlank { null }, buildSet { json.optJSONArray("permissions")?.let { a -> for(i in 0 until a.length()) add(a.optString(i)) } },json.optString("minRuntimeVersion").ifBlank { null },network) } }
}
data class InstalledMiniApp(val manifest: MiniAppManifest)
enum class MiniAppPermission { STORAGE, CLIPBOARD_WRITE, CLIPBOARD_READ, FILES_PICK, FILES_SAVE, FILES_DIRECTORY, SHARE, SECURE_STORAGE, NETWORK, NOTIFICATIONS, SYSTEM_OPEN, HAPTICS; companion object { fun fromWire(value:String)=entries.firstOrNull { it.name.lowercase().replace('_','.') == value } ?: if(value=="secureStorage") SECURE_STORAGE else null } }
