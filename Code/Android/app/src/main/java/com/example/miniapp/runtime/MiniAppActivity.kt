package com.example.miniapp.runtime
import com.example.miniapp.launcher.AppLanguage
import android.content.*
import android.os.Build
import android.os.Bundle
import androidx.activity.OnBackPressedCallback
import com.example.miniapp.bridge.WebOrigin
import android.webkit.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.result.contract.ActivityResultContract
import androidx.appcompat.app.AppCompatActivity
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.repository.MiniAppRepository
import org.json.JSONObject
import com.example.miniapp.services.AndroidFileSaveService
import com.example.miniapp.services.AndroidShareService
import com.example.miniapp.services.DocumentCreator
import com.example.miniapp.services.SystemShareLauncher
import com.example.miniapp.runtime.ApiException
import com.example.miniapp.installer.RuntimeLimits
import com.example.miniapp.installer.SemVer

class MiniAppActivity:AppCompatActivity(){ private lateinit var web:WebView;private lateinit var runtime:MiniAppRuntime;private lateinit var manifest:MiniAppManifest; private lateinit var fileSave:AndroidFileSaveService;private lateinit var share:AndroidShareService; private var pendingPickId:String?=null; private var pendingMultipleId:String?=null; private var pendingDirectoryId:String?=null
 private val picker=registerForActivityResult(ActivityResultContracts.OpenDocument()){uri->val id=pendingPickId?:return@registerForActivityResult;pendingPickId=null;if(uri==null){web.evaluateJavascript("window.__miniRuntimeResolve(JSON.stringify({id:${JSONObject.quote(id)},success:false,error:{code:'file_not_found',message:'No file selected'}}));",null);return@registerForActivityResult};val meta=contentResolver.query(uri,arrayOf(android.provider.OpenableColumns.DISPLAY_NAME,android.provider.OpenableColumns.SIZE),null,null,null)?.use{if(it.moveToFirst())Pair(it.getString(0),it.getLong(1)) else Pair("file",0L)}?:Pair("file",0L);runtime.registerFile(uri,meta.first,contentResolver.getType(uri),meta.second,id)}
 private val multiplePicker=registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()){uris->val id=pendingMultipleId?:return@registerForActivityResult;pendingMultipleId=null;if(uris.isEmpty()){runtime.completeExternal(id,null,ApiException("operation_cancelled","File selection was cancelled"));return@registerForActivityResult};runtime.registerFiles(uris.map{uri->val meta=contentResolver.query(uri,arrayOf(android.provider.OpenableColumns.DISPLAY_NAME,android.provider.OpenableColumns.SIZE),null,null,null)?.use{if(it.moveToFirst())Pair(it.getString(0),it.getLong(1))else Pair("file",0L)}?:Pair("file",0L);com.example.miniapp.services.RuntimeFile(uri,meta.first,contentResolver.getType(uri),meta.second)},id)}
 private val directoryPicker=registerForActivityResult(ActivityResultContracts.OpenDocumentTree()){uri->val id=pendingDirectoryId?:return@registerForActivityResult;pendingDirectoryId=null;if(uri==null){runtime.completeExternal(id,null,ApiException("operation_cancelled","Directory selection was cancelled"));return@registerForActivityResult};runtime.registerDirectory(uri,id)}
 private var pendingNotificationPermissionId:String?=null
 private val notificationPermission=registerForActivityResult(ActivityResultContracts.RequestPermission()){granted->pendingNotificationPermissionId?.let{runtime.completeNotificationPermission(it,granted)};pendingNotificationPermissionId=null}
 private var pendingResult: ((Boolean) -> Unit)? = null
 private val appResult = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
     val complete = pendingResult
     pendingResult = null
     complete?.invoke(result.resultCode == RESULT_OK)
 }

 internal fun launchForResult(intent: Intent, complete: (Boolean) -> Unit) {
     if (pendingResult != null) throw ApiException("operation_in_progress", "An application window is already open")
     pendingResult = complete
     try { appResult.launch(intent) }
     catch (error: Exception) { pendingResult = null; throw error }
 }

 override fun onStart() {
     super.onStart()
     if (::runtime.isInitialized) runtime.functions.onStart?.invoke()
 }

 override fun onStop() {
     if (::runtime.isInitialized) runtime.functions.onStop?.invoke()
     super.onStop()
 }

 private val documentCreator=registerForActivityResult(CreateDocumentContract()){uri->if(::fileSave.isInitialized)fileSave.onDocumentCreated(uri)}
 private val streamDocumentCreator=registerForActivityResult(CreateDocumentContract()){uri->if(::runtime.isInitialized)runtime.streams.onDocumentCreated(uri)}
 override fun onCreate(state: Bundle?) {
     super.onCreate(state)
     onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
         override fun handleOnBackPressed() {
             if (!::runtime.isInitialized) finish()
             else if (!runtime.backInProgress) runtime.requestBack { finish() }
         }
     })
     val id = intent.getStringExtra("appId") ?: run { finish(); return }
     val repo = MiniAppRepository(this)
     val preference = AppLanguage.preference(this)
     val installed = repo.get(id)?.manifest ?: run { finish(); return }
     val content = try { BuiltInMiniApps.resolveContent(this, installed) }
     catch (_: Exception) {
         reportLaunchFailure(installed.name, "The bundled application is unavailable.")
         return
     }
     manifest = content.manifest.localize(preference)
     val required = manifest.minRuntimeVersion
     if (required != null && SemVer.compare(RuntimeLimits.RUNTIME_VERSION, required) < 0) {
         reportLaunchFailure(manifest.name, "Runtime ${RuntimeLimits.RUNTIME_VERSION} is older than required $required.")
         return
     }
     if (!WebOrigin.supported()) {
         reportLaunchFailure(manifest.name, "Update Android System WebView.")
         return
     }

     val host = WebOrigin.appHost(id)
     web = WebView(this)
     WebOrigin.applySystemInsets(web)
     setContentView(web)
     web.settings.apply {
         javaScriptEnabled = true
         domStorageEnabled = true
         allowFileAccess = false
         allowContentAccess = false
         allowFileAccessFromFileURLs = false
         allowUniversalAccessFromFileURLs = false
         mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
         javaScriptCanOpenWindowsAutomatically = false
         setSupportMultipleWindows(false)
     }
     if (com.example.miniapp.BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
     runtime = MiniAppRuntime(this, web, manifest, preference)
     web.settings.mediaPlaybackRequiresUserGesture = !runtime.functions.allowMediaAutoplay
     runtime.setLaunchParams(params(intent))

     fileSave = AndroidFileSaveService(contentResolver,
         DocumentCreator { mime, name -> documentCreator.launch(mime to name) }, runtime::completeExternal)
     share = AndroidShareService(this, manifest.id, SystemShareLauncher { startActivity(it) })
     runtime.fileSave = fileSave
     runtime.share = share
     runtime.streamDocumentCreator = DocumentCreator { mime, name -> streamDocumentCreator.launch(mime to name) }
     runtime.pick = { types, requestId -> pendingPickId = requestId; picker.launch(types) }
     runtime.pickMultiple = { types, requestId -> pendingMultipleId = requestId; multiplePicker.launch(types) }
     runtime.pickDirectory = { requestId -> pendingDirectoryId = requestId; directoryPicker.launch(null) }
     runtime.requestNotifications = { requestId ->
         pendingNotificationPermissionId = requestId
         if (Build.VERSION.SDK_INT < 33 ||
             checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)
             runtime.completeNotificationPermission(requestId, true)
         else notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
     }
     web.webViewClient = MiniAppWebViewClient(host, repo.dir(id), runtime.streams, content)
     WebOrigin.listen(web, "MiniRuntime", host, runtime::receiveMessage)
     web.loadUrl(WebOrigin.url(host, manifest.entry))
 }

 private fun reportLaunchFailure(title: String, message: String) {
     android.app.AlertDialog.Builder(this).setTitle(title).setMessage(message)
         .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
         .setOnCancelListener { finish() }
         .show()
 }
 override fun onNewIntent(intent:android.content.Intent){super.onNewIntent(intent);setIntent(intent);if(::runtime.isInitialized)runtime.setLaunchParams(params(intent))}
 override fun dispatchTouchEvent(event:android.view.MotionEvent):Boolean { if(::runtime.isInitialized&&event.action==android.view.MotionEvent.ACTION_DOWN)runtime.markUserGesture();return super.dispatchTouchEvent(event) }
 private fun params(intent:android.content.Intent)=JSONObject().put("reason",intent.getStringExtra("launchReason")?:"normal").apply{intent.getStringExtra("notificationId")?.let{put("notificationId",it)};intent.getStringExtra("launchPayload")?.let{raw->runCatching{put("payload",JSONObject(raw))}}}
 override fun onResume(){super.onResume();event("app.resume")};override fun onPause(){event("app.pause");super.onPause()};override fun onDestroy(){event("app.destroy");if(::fileSave.isInitialized)fileSave.destroy();if(::runtime.isInitialized){runtime.clearTimers();runtime.clearFiles()};try{if(::web.isInitialized)web.destroy()}finally{if(::runtime.isInitialized)runtime.functions.close?.invoke();super.onDestroy()}};private fun event(name:String){if(::web.isInitialized)web.evaluateJavascript("window.__miniRuntimeEvent&&window.__miniRuntimeEvent(${JSONObject.quote(name)});",null)}
}
private class CreateDocumentContract:ActivityResultContract<Pair<String,String>,android.net.Uri?>(){override fun createIntent(context:android.content.Context,input:Pair<String,String>)=android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT).addCategory(android.content.Intent.CATEGORY_OPENABLE).setType(input.first).putExtra(android.content.Intent.EXTRA_TITLE,input.second);override fun parseResult(resultCode:Int,intent:android.content.Intent?)=if(resultCode==android.app.Activity.RESULT_OK)intent?.data else null}
