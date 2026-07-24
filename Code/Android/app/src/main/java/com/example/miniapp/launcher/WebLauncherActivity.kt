package com.example.miniapp.launcher

import android.content.Intent
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.example.miniapp.installer.HtmlManifestReader
import com.example.miniapp.installer.InstallException
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.MiniAppRepository
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.runtime.ApiException
import com.example.miniapp.runtime.MiniAppActivity
import com.example.miniapp.services.AndroidShareService
import com.example.miniapp.services.SystemShareLauncher
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.concurrent.thread

class WebLauncherActivity : AppCompatActivity() {
    private val repo by lazy { MiniAppRepository(this) }
    private val interfaces by lazy { LauncherInterfaceStore(this) }
    private lateinit var web: WebView
    private var pendingImportId: String? = null
    private var operation = false
    private var pendingInterfaceId: String? = null
    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val id = pendingImportId ?: return@registerForActivityResult
        pendingImportId = null
        if (uri == null) { operation = false; reply(id, false, null, "source_file_not_found", "No file selected"); return@registerForActivityResult }
        val name = contentResolver.query(uri, null, null, null, null)?.use { cursor -> cursor.takeIf { it.moveToFirst() }?.let { it.getString(it.getColumnIndex(OpenableColumns.DISPLAY_NAME)) } } ?: "import"
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext !in setOf("zip", "html", "htm")) { operation = false; reply(id, false, null, "source_file_invalid", "Only ZIP and HTML files are supported"); return@registerForActivityResult }
        val staging = File(cacheDir, "picker-${System.nanoTime()}.$ext")
        thread {
            try {
                contentResolver.openInputStream(uri)!!.use { input -> staging.outputStream().use(input::copyTo) }
                if (ext in setOf("html", "htm") && runCatching { HtmlManifestReader.read(staging) }.isFailure) {
                    runOnUiThread { HtmlManifestDialog(this@WebLauncherActivity, staging, { manual -> installImported(id, staging, manual) }, { staging.delete(); operation = false; reply(id, false, null, "source_file_invalid", "Manifest was not provided") }).show() }
                } else installImported(id, staging, null)
            } catch (e: Exception) { staging.delete(); operation = false; reply(id, false, null, "source_file_invalid", e.message ?: "Import failed") }
        }
    }

    private val interfacePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val id=pendingInterfaceId ?: return@registerForActivityResult; pendingInterfaceId=null
        if(uri==null){reply(id,false,null,"source_file_not_found","No file selected");return@registerForActivityResult}
        val name=contentResolver.query(uri,null,null,null,null)?.use{cursor->cursor.takeIf{it.moveToFirst()}?.let{it.getString(it.getColumnIndex(OpenableColumns.DISPLAY_NAME))}}?:"interface.html"
        val staged=File(cacheDir,"interface-${System.nanoTime()}-$name")
        thread { try { contentResolver.openInputStream(uri)!!.use{input->staged.outputStream().use(input::copyTo)}; interfaces.install(staged); reply(id,true,JSONObject.NULL,null,null) } catch(e:Exception) { reply(id,false,null,"source_file_invalid",e.message?:"Interface import failed") } finally { staged.delete() } }
    }
    override fun onCreate(state: Bundle?) { super.onCreate(state); ensureAccess(); web = WebView(this); setContentView(web); web.settings.apply { javaScriptEnabled=true; domStorageEnabled=false; allowFileAccess=false; allowContentAccess=false; allowFileAccessFromFileURLs=false; allowUniversalAccessFromFileURLs=false }; web.addJavascriptInterface(Bridge(), "LauncherRuntime"); web.addJavascriptInterface(InterfaceBridge(), "InterfaceRuntime"); web.webViewClient=InterfaceClient(); loadInterface() }
    override fun onResume() { super.onResume(); if (::web.isInitialized && SharedMiniAppStore.hasFileAccess()) loadInterface() }
    override fun onBackPressed() { web.evaluateJavascript("window.__launcherClosePopup ? window.__launcherClosePopup() : false") { if (it != "true") super.onBackPressed() } }
    private fun ensureAccess() { if (SharedMiniAppStore.hasFileAccess()) { SharedMiniAppStore.ensureRoot(); seedInterface(); return }; android.app.AlertDialog.Builder(this).setTitle("Доступ к mini-apps").setMessage("Для доступа к MiniApps нужен системный доступ к файлам.").setPositiveButton("Открыть настройки") { _, _ -> startActivity(SharedMiniAppStore.settingsIntent(this)) }.setNegativeButton("Позже", null).show() }
    private fun interfaceRoot() = interfaces.activeDir()
    private fun seedInterface() { interfaces.seedDefault() }
    private fun loadInterface() { if (SharedMiniAppStore.hasFileAccess()) { seedInterface(); web.loadUrl("launcher://interface/index.html") } }
    private fun installImported(id:String,file:File,manifest:MiniAppManifest?) { thread { try { val result=MiniAppInstaller(this@WebLauncherActivity).install(file,manifest); reply(id,true,JSONObject().put("installed",result.installed),null,null) } catch(e:InstallException) { reply(id,false,null,e.code,e.message?:"Import failed") } catch(e:Exception) { reply(id,false,null,"source_file_invalid",e.message?:"Import failed") } finally { file.delete(); operation=false } } }
    private fun reply(id:String,success:Boolean,result:Any?,code:String?,message:String?) = runOnUiThread { val value=JSONObject().put("id",id).put("success",success); if(success)value.put("result",result?:JSONObject.NULL) else value.put("error",JSONObject().put("code",code).put("message",message)); web.evaluateJavascript("window.__launcherResolve(${JSONObject.quote(value.toString())})",null) }
    private fun runOperation(id:String, block:()->Any?) { if(operation){reply(id,false,null,"operation_in_progress","Another operation is running");return}; operation=true; thread { try { reply(id,true,block(),null,null) } catch(e:ApiException) { reply(id,false,null,e.code,e.message) } catch(e:Exception) { reply(id,false,null,"app_delete_failed",e.message?:"Operation failed") } finally { operation=false } } }
    private fun sharePackage(id:String) {
        val app=repo.get(id)?.manifest?:throw ApiException("source_file_not_found","Application was not found")
        val directory=repo.dir(id)
        val files=directory.walkTopDown().filter { it.isFile && it.name !in setOf("storage.json","storage.json.bak") }.toList()
        val entry=File(directory,app.entry)
        val safeName=app.name.replace(Regex("[\\\\/:*?\"<>|]"),"_")
        val output=if(files.size==2&&entry.isFile&&entry.readText().contains("application/miniapp+json",true)) {
            File(cacheDir,"share/$safeName-${app.version}.html").apply { parentFile?.mkdirs(); entry.copyTo(this,true) }
        } else File(cacheDir,"share/$safeName-${app.version}.zip").apply {
            parentFile?.mkdirs()
            ZipOutputStream(outputStream()).use { zip -> files.forEach { file ->
                zip.putNextEntry(ZipEntry(file.relativeTo(directory).invariantSeparatorsPath))
                file.inputStream().use { it.copyTo(zip) }; zip.closeEntry()
            } }
        }
        AndroidShareService(this,"launcher",SystemShareLauncher { intent -> runOnUiThread { startActivity(intent) } })
            .shareExistingFile("launcher-${System.nanoTime()}",output,output.name,if(output.extension.equals("zip",true))"application/zip" else "text/html",app.name)
    }
    private fun shareStorage(id:String) {
        val app=repo.get(id)?.manifest?:throw ApiException("app_not_found","Application was not found")
        val storage=File(repo.dir(id),"storage.json")
        if(!storage.isFile) throw ApiException("app_data_not_found","No public data file exists")
        AndroidShareService(this,"launcher",SystemShareLauncher { intent -> runOnUiThread { startActivity(intent) } })
            .shareExistingFile("launcher-${System.nanoTime()}",storage,"${app.name}-storage.json","application/json",app.name)
    }
    private inner class Bridge {
        @JavascriptInterface fun call(raw:String) { runOnUiThread {
            try {
                val request=JSONObject(raw); val id=request.optString("id"); val params=request.optJSONObject("params")?:JSONObject()
                when(request.getString("method")) {
                    "apps.list" -> { repo.sync(); val apps=JSONArray(); repo.list().forEach { app -> apps.put(JSONObject().put("id",app.manifest.id).put("name",app.manifest.name).put("version",app.manifest.version).put("description",app.manifest.description)) }; reply(id,true,apps,null,null) }
                    "apps.getAppInfo" -> { repo.sync(); val app=repo.get(params.getString("id"))?:throw ApiException("app_not_found","Application was not found"); reply(id,true,com.example.miniapp.services.AppInfoService.get(this@WebLauncherActivity,app.manifest),null,null) }
                    "apps.open", "apps.openNewWindow" -> { startActivity(Intent(this@WebLauncherActivity,MiniAppActivity::class.java).putExtra("appId",params.getString("id"))); reply(id,true,JSONObject.NULL,null,null) }
                    "apps.refresh" -> runOperation(id){ repo.sync(); JSONObject.NULL }
                    "apps.importApp" -> if(operation)reply(id,false,null,"operation_in_progress","Another operation is running") else { operation=true; pendingImportId=id; picker.launch(arrayOf("application/zip","text/html","application/octet-stream")) }
                    "apps.delete" -> runOperation(id){repo.delete(params.getString("id"));JSONObject.NULL}
                    "apps.share" -> runOperation(id){sharePackage(params.getString("id"));JSONObject.NULL}
                    "apps.shareData" -> runOperation(id){shareStorage(params.getString("id"));JSONObject.NULL}
                    "apps.settings" -> reply(id,true,JSONObject().put("version","1.0.0").put("platform","Android").put("appsPath",SharedMiniAppStore.root().absolutePath),null,null)
                    else -> reply(id,false,null,"method_not_found","Unknown method")
                }
            } catch(e:Exception) { reply("",false,null,"invalid_request",e.message?:"Invalid request") }
        } }
    }
    private inner class InterfaceBridge { @JavascriptInterface fun call(raw:String) { runOnUiThread { try { val request=JSONObject(raw); val id=request.optString("id"); val params=request.optJSONObject("params") ?: JSONObject(); when(request.getString("method")) { "interfaces.list" -> reply(id,true,interfaces.list(),null,null); "interfaces.select" -> { interfaces.select(params.getString("id")); reply(id,true,JSONObject.NULL,null,null) }; "interfaces.import" -> { pendingInterfaceId=id; interfacePicker.launch(arrayOf("text/html","application/zip","application/octet-stream")) }; "interfaces.settings.get" -> reply(id,true,interfaces.getSettings(),null,null); "interfaces.settings.set" -> { val settings=params.opt("settings"); if (settings !is JSONObject) throw IllegalArgumentException("settings must be a JSON object"); interfaces.setSettings(settings); reply(id,true,JSONObject.NULL,null,null) }; else -> reply(id,false,null,"method_not_found","Unknown method") } } catch(e:Exception) { reply("",false,null,"source_file_invalid",e.message?:"Interface error") } } } }
    private inner class InterfaceClient:WebViewClient() { override fun shouldInterceptRequest(view:WebView?,request:WebResourceRequest?):WebResourceResponse? { val uri=request?.url?:return null; if(uri.scheme!="launcher")return forbidden(); if(uri.host=="runtime"&&uri.path=="/launcher-runtime.js")return WebResourceResponse("application/javascript","utf-8",assets.open("launcher-runtime.js")); if(uri.host!="interface")return forbidden(); val relative=uri.path?.removePrefix("/")?:return forbidden(); if(relative.isBlank()||relative.split('/').any{it=="."||it==".."})return forbidden(); val file=File(interfaceRoot(),relative); if(!file.isFile||!file.canonicalPath.startsWith(interfaceRoot().canonicalPath+File.separator))return forbidden(); return if(file.extension.equals("html",true)){val html=file.readText().replaceFirst(Regex("(?i)</head>"),"<script src=\"launcher://runtime/launcher-runtime.js\"></script></head>");WebResourceResponse("text/html","utf-8",ByteArrayInputStream(html.toByteArray()))}else WebResourceResponse(if(file.extension.equals("css",true))"text/css" else "application/javascript","utf-8",file.inputStream()) }; override fun shouldOverrideUrlLoading(view:WebView?,request:WebResourceRequest?)=true; private fun forbidden()=WebResourceResponse("text/plain","utf-8",403,"Forbidden",emptyMap(),ByteArrayInputStream(ByteArray(0))) }
}
