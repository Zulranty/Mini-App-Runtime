package com.example.miniapp.launcher

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import com.example.miniapp.bridge.WebOrigin
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.example.miniapp.BuildConfig
import com.example.miniapp.installer.BundledMiniApps
import com.example.miniapp.installer.HtmlManifestReader
import com.example.miniapp.installer.InstallException
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.MiniAppRepository
import com.example.miniapp.repository.SharedMiniAppStore
import com.example.miniapp.runtime.ApiException
import com.example.miniapp.runtime.MiniAppActivity
import com.example.miniapp.runtime.RuntimeLog
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
    private var applyingBundledUpdates = false
    private var webViewUpdatePromptShown = false
    private var telegramDialog: AlertDialog? = null
    private var pendingInterfaceId: String? = null
    private val legacyStoragePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && BundledMiniApps.needsCheck(this) && !applyingBundledUpdates) applyBundledUpdates()
        else if (granted && !applyingBundledUpdates) loadInterface()
    }
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
        thread {
            var staged: File? = null
            try {
                val source = File.createTempFile("interface-", ".tmp", cacheDir)
                staged = source
                contentResolver.openInputStream(uri)!!.use { input -> source.outputStream().use(input::copyTo) }
                interfaces.install(source, name)
                reply(id,true,JSONObject.NULL,null,null)
            } catch(e:Exception) { reply(id,false,null,"source_file_invalid",e.message?:"Interface import failed") }
            finally { staged?.delete() }
        }
    }
    override fun onCreate(state: Bundle?) { super.onCreate(state); onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() = requestLauncherBack() }); ensureAccess(); web = WebView(this); WebOrigin.applySystemInsets(web); setContentView(web); web.settings.apply { javaScriptEnabled=true; domStorageEnabled=false; mixedContentMode=android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW; allowFileAccess=false; allowContentAccess=false; allowFileAccessFromFileURLs=false; allowUniversalAccessFromFileURLs=false }; if (WebOrigin.supported()) { WebOrigin.listen(web, "LauncherRuntime", WebOrigin.LAUNCHER_HOST, Bridge()::call); WebOrigin.listen(web, "InterfaceRuntime", WebOrigin.LAUNCHER_HOST, InterfaceBridge()::call) }; web.webViewClient=InterfaceClient() }
    override fun onResume() {
        super.onResume()
        if (telegramDialog != null || applyingBundledUpdates || operation || !canAccessFiles()) return
        if (BundledMiniApps.needsCheck(this)) applyBundledUpdates() else loadInterface()
    }
    override fun onDestroy() {
        telegramDialog?.dismiss()
        super.onDestroy()
    }
    private fun requestLauncherBack() {
        web.evaluateJavascript("Boolean(window.__launcherCloseSettings?.() || window.__launcherClosePopup?.())") {
            if (it != "true") finish()
        }
    }
    private fun ensureAccess() {
        if (canAccessFiles()) {
            SharedMiniAppStore.ensureRoot()
            seedInterface()
            return
        }
        if (android.os.Build.VERSION.SDK_INT < 30) {
            legacyStoragePermission.launch(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
            return
        }
        android.app.AlertDialog.Builder(this).setTitle("Доступ к mini-apps")
            .setMessage("Для доступа к MiniApps нужен системный доступ к файлам.")
            .setPositiveButton("Открыть настройки") { _, _ -> startActivity(SharedMiniAppStore.settingsIntent(this)) }
            .setNegativeButton("Позже", null).show()
    }
    private fun canAccessFiles() = if (android.os.Build.VERSION.SDK_INT >= 30) SharedMiniAppStore.hasFileAccess()
        else checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == android.content.pm.PackageManager.PERMISSION_GRANTED
    private fun interfaceRoot() = interfaces.activeDir()
    private fun seedInterface() { interfaces.seedBundled() }
    private fun loadInterface() {
        if (!canAccessFiles()) return
        // The launcher uses modern JavaScript, and bundled apps use structuredClone.
        val chromiumVersion = Regex("""Chrome/(\d+)\.""")
            .find(web.settings.userAgentString)?.groupValues?.get(1)?.toIntOrNull()
        if (chromiumVersion == null || chromiumVersion < 98 || !WebOrigin.supported()) {
            if (webViewUpdatePromptShown) return
            webViewUpdatePromptShown = true
            val russian = AppLanguage.preference(this) == "ru"
            AlertDialog.Builder(this)
                .setTitle(if (russian) "Обновите WebView" else "Update WebView")
                .setMessage(
                    if (russian) "Требуется WebView 98 или новее. Обновите Android System WebView или Chrome и снова запустите Mini Apps."
                    else "WebView 98 or newer is required. Update Android System WebView or Chrome, then reopen Mini Apps."
                )
                .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                .setOnCancelListener { finish() }
                .show()
            return
        }
        seedInterface()
        web.loadUrl(WebOrigin.url(WebOrigin.LAUNCHER_HOST, "index.html"))
    }
    private fun applyBundledUpdates() {
        applyingBundledUpdates = true
        thread(name = "bundled-mini-apps") {
            val complete = try {
                BundledMiniApps.applyUpdates(applicationContext)
            } catch (error: Exception) {
                Log.w("MiniApps", "Could not apply bundled updates", error)
                false
            }
            runOnUiThread {
                applyingBundledUpdates = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (!complete) {
                    val message = if (AppLanguage.preference(this) == "ru")
                        "Не все встроенные приложения обновились. Повторим при следующем запуске."
                    else "Some built-in apps could not be updated. MiniApps will retry on the next launch."
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                }
                loadInterface()
            }
        }
    }
    private fun installImported(id:String,file:File,manifest:MiniAppManifest?) { thread { try { val result=MiniAppInstaller(this@WebLauncherActivity).install(file,manifest); reply(id,true,JSONObject().put("installed",result.installed).put("appId", result.manifest.id),null,null) } catch(e:InstallException) { reply(id,false,null,e.code,e.message?:"Import failed") } catch(e:Exception) { reply(id,false,null,"source_file_invalid",e.message?:"Import failed") } finally { file.delete(); operation=false } } }
    private fun reply(id:String,success:Boolean,result:Any?,code:String?,message:String?) = runOnUiThread { val value=JSONObject().put("id",id).put("success",success); if(success)value.put("result",result?:JSONObject.NULL) else value.put("error",JSONObject().put("code",code).put("message",message)); web.evaluateJavascript("window.__launcherResolve(${JSONObject.quote(value.toString())})",null) }
    private fun runOperation(id:String, block:()->Any?) { if(operation){reply(id,false,null,"operation_in_progress","Another operation is running");return}; operation=true; thread { try { reply(id,true,block(),null,null) } catch(e:ApiException) { reply(id,false,null,e.code,e.message) } catch(e:Exception) { reply(id,false,null,"app_delete_failed",e.message?:"Operation failed") } finally { operation=false } } }
    private fun installTelegram(id: String) {
        if (operation || telegramDialog != null) {
            reply(id, false, null, "operation_in_progress", "Another operation is running")
            return
        }
        val updating = TelegramPackage.hasClient(this)
        val title = if (updating) "Обновление Telegram" else "Установка Telegram"
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            contentDescription = title
        }
        val padding = (24 * resources.displayMetrics.density).toInt()
        val content = FrameLayout(this).apply {
            setPadding(padding, padding, padding, padding)
            addView(bar, FrameLayout.LayoutParams(-1, -2))
        }
        val dialog = AlertDialog.Builder(this).setTitle(title).setView(content).setCancelable(false).show()
        telegramDialog = dialog
        operation = true
        thread(name = "telegram-install") {
            var installed = false
            val error = try {
                installed = TelegramPackage.install(applicationContext) { percent ->
                    runOnUiThread { if (dialog.isShowing) bar.progress = percent }
                }
                null
            } catch (error: Exception) {
                error
            }
            runOnUiThread {
                operation = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                dialog.dismiss()
                telegramDialog = null
                if (error != null) {
                    reply(id, false, null, (error as? ApiException)?.code ?: "telegram_install_failed",
                        error.message ?: "Не удалось установить Telegram")
                    return@runOnUiThread
                }
                if (!installed) {
                    reply(id, true, JSONObject().put("message", "Установлена более новая версия Telegram"), null, null)
                    return@runOnUiThread
                }
                val message = if (updating) "Telegram обновлён" else "Telegram установлен"
                val confirm = AlertDialog.Builder(this)
                    .setTitle(message)
                    .setMessage("Перезапустить MiniApps сейчас?")
                    .setPositiveButton("Да") { _, _ ->
                        startActivity(Intent.makeRestartActivityTask(componentName))
                    }
                    .setNegativeButton("Нет", null)
                    .create()
                telegramDialog = confirm
                confirm.setOnDismissListener {
                    telegramDialog = null
                    if (!isFinishing && !isDestroyed)
                        reply(id, true, JSONObject().put("message", message), null, null)
                }
                confirm.show()
            }
        }
    }
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
        fun call(raw:String) { runOnUiThread {
            var id = ""
            try {
                val request=JSONObject(raw); id=request.optString("id"); val params=request.optJSONObject("params")?:JSONObject()
                when(request.getString("method")) {
                    "apps.list" -> {
                        repo.sync()
                        val language = AppLanguage.preference(this@WebLauncherActivity)
                        val apps = JSONArray()
                        repo.list().forEach { app ->
                            val manifest = app.manifest.localize(language)
                            apps.put(JSONObject().put("id",manifest.id).put("name",manifest.name)
                                .put("version",manifest.version).put("description",manifest.description))
                        }
                        reply(id,true,apps,null,null)
                    }
                    "apps.getAppInfo" -> { repo.sync(); val app=repo.get(params.getString("id"))?:throw ApiException("app_not_found","Application was not found"); reply(id,true,com.example.miniapp.services.AppInfoService.get(this@WebLauncherActivity,app.manifest.localize(AppLanguage.preference(this@WebLauncherActivity))),null,null) }
                    "apps.open", "apps.openNewWindow" -> {
                        val appId = params.getString("id")
                        val manifest = repo.get(appId)?.manifest ?: throw ApiException("source_file_not_found", "Application was not found")
                        val minimum = manifest.minRuntimeVersion
                        if (minimum != null && com.example.miniapp.installer.SemVer.compare(
                                com.example.miniapp.installer.RuntimeLimits.RUNTIME_VERSION, minimum) < 0)
                            throw ApiException("runtime_version_too_old", "Mini-app requires runtime $minimum")
                        startActivity(Intent(this@WebLauncherActivity, MiniAppActivity::class.java).putExtra("appId", appId))
                        reply(id,true,JSONObject.NULL,null,null)
                    }
                    "telegram.installStatus" -> reply(id,true,TelegramPackage.hasClient(this@WebLauncherActivity),null,null)
                    "language.get" -> reply(id,true,AppLanguage.preference(this@WebLauncherActivity),null,null)
                    "language.set" -> {
                        AppLanguage.save(this@WebLauncherActivity, params.opt("language"))
                        reply(id,true,JSONObject.NULL,null,null)
                    }
                    "telegram.install" -> installTelegram(id)
                    "telegram.settings.get" -> reply(id,true,TelegramSettings.read(this@WebLauncherActivity),null,null)
                    "telegram.settings.set" -> reply(id,true,TelegramSettings.save(this@WebLauncherActivity, params),null,null)
                    "telegram.log.read" -> reply(id,true,RuntimeLog.readTelegram(),null,null)
                    "telegram.log.copy" -> {
                        val text = RuntimeLog.readTelegram().getString("text")
                        if (text.isEmpty()) throw ApiException("log_empty", "No Telegram login events to copy")
                        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Telegram login log", text))
                        reply(id,true,JSONObject.NULL,null,null)
                    }
                    "apps.refresh" -> runOperation(id){ repo.sync(); JSONObject.NULL }
                    "apps.importApp" -> if(operation)reply(id,false,null,"operation_in_progress","Another operation is running") else { operation=true; pendingImportId=id; picker.launch(arrayOf("application/zip","text/html","application/octet-stream")) }
                    "apps.delete" -> runOperation(id){repo.delete(params.getString("id"));JSONObject.NULL}
                    "apps.share" -> runOperation(id){sharePackage(params.getString("id"));JSONObject.NULL}
                    "apps.shareData" -> runOperation(id){shareStorage(params.getString("id"));JSONObject.NULL}
                    "apps.settings" -> reply(id,true,JSONObject().put("version",BuildConfig.VERSION_NAME).put("platform","Android").put("appsPath",SharedMiniAppStore.root().absolutePath),null,null)
                    else -> reply(id,false,null,"method_not_found","Unknown method")
                }
            } catch(e:ApiException) { reply(id,false,null,e.code,e.message) }
            catch(e:Exception) { reply(id,false,null,"invalid_request",e.message?:"Invalid request") }
        } }
    }
    private inner class InterfaceBridge { fun call(raw:String) { runOnUiThread { try { val request=JSONObject(raw); val id=request.optString("id"); val params=request.optJSONObject("params") ?: JSONObject(); when(request.getString("method")) { "interfaces.list" -> reply(id,true,interfaces.list(),null,null); "interfaces.select" -> { interfaces.select(params.getString("id")); reply(id,true,JSONObject.NULL,null,null) }; "interfaces.import" -> { pendingInterfaceId=id; interfacePicker.launch(arrayOf("text/html","application/zip","application/octet-stream")) }; "interfaces.settings.get" -> reply(id,true,interfaces.getSettings(),null,null); "interfaces.settings.set" -> { val settings=params.opt("settings"); if (settings !is JSONObject) throw IllegalArgumentException("settings must be a JSON object"); interfaces.setSettings(settings); reply(id,true,JSONObject.NULL,null,null) }; else -> reply(id,false,null,"method_not_found","Unknown method") } } catch(e:Exception) { reply("",false,null,"source_file_invalid",e.message?:"Interface error") } } } }
    private inner class InterfaceClient : WebViewClient() {
        private val endOfHead = Regex("</head>", RegexOption.IGNORE_CASE)
        private val doctype = Regex("<!doctype[^>]*>", RegexOption.IGNORE_CASE)

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
            val uri = request?.url ?: return null
            if (WebOrigin.matches(uri, WebOrigin.ASSET_HOST) && uri.path == "/launcher-runtime.js")
                return WebResourceResponse("application/javascript", "utf-8", 200, "OK",
                    mapOf("Cache-Control" to "no-store"), assets.open("launcher-runtime.js"))
            if (!WebOrigin.matches(uri, WebOrigin.LAUNCHER_HOST)) return forbidden()
            val relative = uri.path?.removePrefix("/") ?: return forbidden()
            if (relative.isBlank() || relative.split('/').any { it == "." || it == ".." }) return forbidden()
            val root = interfaceRoot()
            val file = File(root, relative)
            if (!file.isFile || !file.canonicalPath.startsWith(root.canonicalPath + File.separator)) return forbidden()
            if (!file.extension.equals("html", true))
                return WebResourceResponse(if (file.extension.equals("css", true)) "text/css" else "application/javascript",
                    "utf-8", file.inputStream())
            val source = if (relative == "index.html") interfaces.readIndex(root) else file.readText()
            val injectionPoint = endOfHead.find(source)?.range?.first ?: doctype.find(source)?.range?.last?.plus(1) ?: 0
            val bridge = "<script src=\"https://${WebOrigin.ASSET_HOST}/launcher-runtime.js\"></script>"
            val html = source.substring(0, injectionPoint) + bridge + source.substring(injectionPoint)
            return WebResourceResponse("text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store", "Content-Security-Policy" to "frame-src 'none'"), ByteArrayInputStream(html.toByteArray()))
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = true

        private fun forbidden() =
            WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }
}
