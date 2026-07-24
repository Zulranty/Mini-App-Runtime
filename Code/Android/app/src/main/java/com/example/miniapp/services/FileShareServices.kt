package com.example.miniapp.services

import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.example.miniapp.installer.RuntimeLimits
import com.example.miniapp.runtime.ApiException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Base64

/** One validation path for both save and share bridge methods. Content is decoded once here. */
data class SaveFileRequest(val name:String, val mimeType:String, val extensions:List<String>, val bytes:ByteArray)
data class ShareTextRequest(val text:String, val title:String?)
data class ShareFileRequest(val title:String?, val text:String?, val file:SaveFileRequest)

object FileShareRequestValidator {
    private val mime = Regex("^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+*-]+$")
    private val base64 = Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")

    fun saveText(p:JSONObject) = save(p, "text")
    fun saveBase64(p:JSONObject) = save(p, "base64")
    fun shareText(p:JSONObject):ShareTextRequest {
        val text = p.opt("text") as? String ?: throw IllegalArgumentException("text is required")
        return ShareTextRequest(text, optionalText(p, "title", 255))
    }
    fun shareFile(p:JSONObject):ShareFileRequest {
        val content=p.optJSONObject("content") ?: throw IllegalArgumentException("content is required")
        val encoding=content.opt("encoding") as? String ?: throw IllegalArgumentException("content.encoding is required")
        if (encoding !in setOf("text", "base64")) throw IllegalArgumentException("content.encoding must be text or base64")
        val data=content.opt("data") as? String ?: throw IllegalArgumentException("content.data is required")
        val copy=JSONObject(p.toString()).put(if(encoding=="text") "text" else "base64",data)
        return ShareFileRequest(optionalText(p,"title",255),optionalText(p,"text",RuntimeLimits.MAX_WRITTEN_FILE_BYTES),save(copy,encoding))
    }
    private fun save(p:JSONObject, encoding:String):SaveFileRequest {
        val rawName=p.opt("suggestedName") as? String ?: throw IllegalArgumentException("suggestedName is required")
        val name=safeName(rawName)
        val type=p.opt("mimeType") as? String ?: throw IllegalArgumentException("mimeType is required")
        if(type.isBlank() || type.length>127 || !mime.matches(type)) throw IllegalArgumentException("mimeType is invalid")
        val extensions=extensions(p.optJSONArray("extensions"))
        val data=p.opt(if(encoding=="text") "text" else "base64") as? String ?: throw IllegalArgumentException("$encoding data is required")
        val bytes=if(encoding=="text") data.toByteArray(StandardCharsets.UTF_8) else decodeBase64(data)
        if(bytes.size>RuntimeLimits.MAX_WRITTEN_FILE_BYTES) throw ApiException("file_too_large","File is too large")
        return SaveFileRequest(name,type,extensions,bytes)
    }
    private fun safeName(value:String):String {
        if(value.isBlank() || value.length>255 || value.contains('/') || value.contains('\\') || value.any { it=='\u0000'||it.code<32||it.code==127 }) throw IllegalArgumentException("suggestedName is invalid")
        val cleaned=value.trim()
        if(cleaned=="." || cleaned=="..") throw IllegalArgumentException("suggestedName is invalid")
        return cleaned
    }
    private fun extensions(a:JSONArray?):List<String> {
        if(a==null)return emptyList(); if(a.length()>16)throw IllegalArgumentException("Too many extensions")
        return List(a.length()){i-> val v=a.opt(i) as? String ?: throw IllegalArgumentException("extension is invalid"); val x=v.trim().lowercase(); if(!Regex("^\\.[a-z0-9]{1,16}$").matches(x)) throw IllegalArgumentException("extension is invalid");x}.distinct()
    }
    private fun decodeBase64(value:String):ByteArray { if(value.length>RuntimeLimits.MAX_WRITTEN_FILE_BYTES*2 || !base64.matches(value))throw IllegalArgumentException("base64 is invalid");return try { Base64.getDecoder().decode(value) } catch(_:IllegalArgumentException){throw IllegalArgumentException("base64 is invalid")} }
    private fun optionalText(p:JSONObject,key:String,max:Int):String? { if(!p.has(key))return null;val value=p.opt(key) as? String ?: throw IllegalArgumentException("$key is invalid");if(value.length>max)throw IllegalArgumentException("$key is too long");return value }
}

fun interface DocumentCreator { fun create(mimeType:String, suggestedName:String) }
class AndroidFileSaveService(private val resolver:ContentResolver, private val creator:DocumentCreator, private val complete:(String, Any?, ApiException?)->Unit) {
    private var pending:Pair<String,SaveFileRequest>?=null
    fun save(id:String, request:SaveFileRequest) { if(pending!=null)throw ApiException("operation_in_progress","A save operation is already active"); pending=id to request; creator.create(request.mimeType,request.name) }
    fun onDocumentCreated(uri:Uri?) { val current=pending?:return;pending=null; if(uri==null){complete(current.first,null,null);return};try { resolver.openOutputStream(uri)?.use { out->out.write(current.second.bytes);out.flush() } ?: throw IllegalStateException(); complete(current.first,JSONObject().put("name",current.second.name).put("mimeType",current.second.mimeType).put("sizeBytes",current.second.bytes.size),null) } catch(_:Exception){complete(current.first,null,ApiException("file_write_failed","Could not write file"))} }
    fun destroy(){pending?.let{complete(it.first,null,ApiException("internal_error","Activity was destroyed"))};pending=null}
}

fun interface SystemShareLauncher { fun launch(intent:Intent) }
class AndroidShareService(private val context:Context, private val appId:String, private val launcher:SystemShareLauncher) {
    init { cleanup() }
    fun shareText(request:ShareTextRequest) { val send=Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,request.text);request.title?.let{send.putExtra(Intent.EXTRA_SUBJECT,it)};launch(send,request.title) }
    fun shareFile(requestId:String, request:ShareFileRequest) {
        val root=File(context.cacheDir,"share/${safeAppId(appId)}/$requestId").apply{mkdirs()}; val file=File(root,request.file.name);try{file.outputStream().use{it.write(request.file.bytes);it.flush()}}catch(_:Exception){throw ApiException("file_write_failed","Could not prepare shared file")}
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.shareprovider",file)
        val send=Intent(Intent.ACTION_SEND)
            .setType(request.file.mimeType)
            .putExtra(Intent.EXTRA_STREAM,uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData=ClipData.newRawUri("Mini app file",uri)
        request.text?.let { value -> send.putExtra(Intent.EXTRA_TEXT,value) }
        request.title?.let { value -> send.putExtra(Intent.EXTRA_SUBJECT,value) }
        launch(send,request.title)
    }
    /** Launcher-only path: share a verified runtime file without exposing its path to JavaScript. */
    fun shareExistingFile(requestId:String, source:File, name:String, mimeType:String, title:String?=null) {
        if(!source.isFile) throw ApiException("source_file_not_found","Source file was not found")
        val root=File(context.cacheDir,"share/${safeAppId(appId)}/$requestId").apply{mkdirs()}; val file=File(root,name)
        try { source.inputStream().use { input -> file.outputStream().use { input.copyTo(it) } } } catch(_:Exception){throw ApiException("app_share_failed","Could not prepare shared file")}
        val uri=FileProvider.getUriForFile(context,"${context.packageName}.shareprovider",file)
        val send=Intent(Intent.ACTION_SEND).setType(mimeType).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData=ClipData.newRawUri("Mini app file",uri); launch(send,title)
    }
    private fun launch(send:Intent,title:String?){if(context.packageManager.resolveActivity(send,0)==null)throw ApiException("share_unavailable","No application can share this content");launcher.launch(Intent.createChooser(send,title))}
    private fun cleanup(){val root=File(context.cacheDir,"share");if(!root.exists())return;val cutoff=System.currentTimeMillis()-24*60*60*1000L;root.walkBottomUp().forEach { if(it.lastModified()<cutoff) it.delete() }}
    private fun safeAppId(id:String)=id.replace(Regex("[^A-Za-z0-9._-]"),"_")
}
