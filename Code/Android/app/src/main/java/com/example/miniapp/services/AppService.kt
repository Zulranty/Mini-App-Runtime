package com.example.miniapp.services
import android.content.*
import android.os.Build
import android.view.Window
import com.example.miniapp.installer.RuntimeLimits
import com.example.miniapp.repository.SharedMiniAppStore
import org.json.*
import java.io.File
import java.io.FileOutputStream

/** Per-app serialized JSON storage. Public writes use temp + fsync + rename and retain one valid backup. */
class StorageService(private val context:Context,private val id:String) {
 private val privatePrefs=context.getSharedPreferences("mini.$id",Context.MODE_PRIVATE)
 private val file get()=File(SharedMiniAppStore.findDirById(id) ?: File(SharedMiniAppStore.ensureRoot(), id), "storage.json")
 private fun schemaKey(public:Boolean)="__mini_schema_${if(public) "public" else "private"}"
 @Synchronized private fun readPublic():JSONObject { val main=file; if(!main.isFile)return JSONObject(); return try{JSONObject(main.readText(Charsets.UTF_8))}catch(_:Exception){val backup=File(main.path+".bak");try{val recovered=JSONObject(backup.readText(Charsets.UTF_8));atomicWrite(main,recovered,false);recovered}catch(_:Exception){throw StorageException("storage_corrupted","Storage data is corrupted")}} }
 @Synchronized private fun readPrivate():JSONObject { val out=JSONObject(); privatePrefs.all.forEach{(key,value)->if(!key.startsWith("__mini_schema_")&&value is String)try{out.put(key,JSONTokener(value).nextValue())}catch(_:Exception){throw StorageException("storage_corrupted","Private storage data is corrupted")}};return out }
 private fun atomicWrite(target:File,json:JSONObject,backup:Boolean=true){val raw=json.toString(2);if(raw.toByteArray(Charsets.UTF_8).size>RuntimeLimits.MAX_STORAGE_BYTES)throw StorageException("storage_limit_exceeded","Storage limit exceeded");target.parentFile?.mkdirs();val tmp=File(target.path+".${System.nanoTime()}.tmp");try{FileOutputStream(tmp).use{stream->stream.write(raw.toByteArray(Charsets.UTF_8));stream.fd.sync()};if(backup&&target.isFile)target.copyTo(File(target.path+".bak"),true);if(!tmp.renameTo(target)){tmp.copyTo(target,true);tmp.delete()}}finally{tmp.delete()} }
 private fun savePrivate(data:JSONObject,schema:Int){val raw=data.toString();if(raw.toByteArray().size>RuntimeLimits.MAX_STORAGE_BYTES)throw StorageException("storage_limit_exceeded","Storage limit exceeded");val edit=privatePrefs.edit().clear();data.keys().forEach{key->val encoded=JSONArray().put(data.get(key)).toString().removePrefix("[").removeSuffix("]");edit.putString(key,encoded)};edit.putInt(schemaKey(false),schema);if(!edit.commit())throw StorageException("storage_transaction_failed","Could not save storage")}
 private fun state(public:Boolean)=if(public) readPublic() else readPrivate()
 fun get(k:String,public:Boolean=false):Any?=state(public).takeIf{it.has(k)}?.get(k)
 fun getMany(keys:JSONArray,public:Boolean)=JSONObject().also{out->for(i in 0 until keys.length()){val key=keys.optString(i);if(key.isNotBlank()){val v=get(key,public);if(v!=null)out.put(key,v)}}}
 @Synchronized fun set(k:String,v:Any?,public:Boolean=false){val data=state(public);data.put(k,JSONObject.wrap(v)?:JSONObject.NULL);save(data,public)}
 @Synchronized fun setMany(values:JSONObject,public:Boolean=false){val data=state(public);values.keys().forEach{key->data.put(key,values.get(key))};save(data,public)}
 @Synchronized fun remove(k:String,public:Boolean=false){val data=state(public);data.remove(k);save(data,public)}
 @Synchronized fun clear(public:Boolean=false){save(JSONObject(),public)}
 fun keys(public:Boolean=false)=JSONArray(state(public).keys().asSequence().toList())
 fun schema(public:Boolean)=if(public){ val data=state(true);data.optInt("__mini_schema_version",0) }else privatePrefs.getInt(schemaKey(false),0)
 @Synchronized fun setSchema(value:Int,public:Boolean){if(value<0)throw IllegalArgumentException("schema version must be non-negative");if(public){val data=state(true);data.put("__mini_schema_version",value);save(data,true)}else savePrivate(state(false),value)}
 @Synchronized fun transaction(scope:String,operations:JSONArray){val public=scope=="public";var data=state(public);var schema=schema(public);try{for(i in 0 until operations.length()){val op=operations.optJSONObject(i)?:throw IllegalArgumentException("operation must be object");when(op.optString("type")){"set"->data.put(op.optString("key").ifBlank{throw IllegalArgumentException("key is required")},op.opt("value"));"remove"->data.remove(op.optString("key").ifBlank{throw IllegalArgumentException("key is required")});"clear"->data=JSONObject();"setSchemaVersion"->schema=op.optInt("value",-1).also{if(it<0)throw IllegalArgumentException("schema version must be non-negative")};else->throw IllegalArgumentException("unknown storage operation")}};if(public){data.put("__mini_schema_version",schema);save(data,true)}else savePrivate(data,schema)}catch(e:StorageException){throw e}catch(e:Exception){throw StorageException("storage_transaction_failed","Transaction was not applied")}}
 fun usage(public:Boolean):JSONObject { val bytes=if(public&&file.isFile)file.length() else state(false).toString().toByteArray().size;return JSONObject().put("usedBytes",bytes).put("limitBytes",RuntimeLimits.MAX_STORAGE_BYTES) }
 private fun save(data:JSONObject,public:Boolean){if(public)atomicWrite(file,data)else savePrivate(data,schema(false))}
}
class StorageException(val code:String,override val message:String):Exception(message)
class DeviceService(private val context:Context,private val window:Window){fun info():JSONObject {val dm=context.resources.displayMetrics;return JSONObject().put("platform","android").put("androidVersion",Build.VERSION.RELEASE).put("appVersion",context.packageManager.getPackageInfo(context.packageName,0).versionName).put("locale",context.resources.configuration.locales[0].toLanguageTag()).put("screenWidth",dm.widthPixels).put("screenHeight",dm.heightPixels).put("density",dm.density).put("isDarkTheme",(context.resources.configuration.uiMode and 0x30)==0x20)}}
class ClipboardService(private val context:Context){fun write(text:String){(context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Mini app",text))}}
data class RuntimeFile(val uri:android.net.Uri,val name:String,val mime:String?,val size:Long)
