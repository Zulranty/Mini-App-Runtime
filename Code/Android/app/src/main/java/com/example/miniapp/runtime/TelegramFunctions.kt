package com.example.miniapp.runtime

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.view.WindowManager
import androidx.annotation.RequiresApi
import com.example.miniapp.bridge.BridgeRequest
import com.example.miniapp.launcher.TelegramPackage
import com.example.miniapp.launcher.TelegramSettings
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.permissions.MiniAppPermissionManager
import com.example.miniapp.repository.MiniAppRepository
import com.example.miniapp.services.SecureStorageService
import com.example.miniapp.services.StorageException
import org.json.JSONArray
import org.json.JSONObject

internal class TelegramFunctions(
    private val activity: MiniAppActivity,
    private val permissions: MiniAppPermissionManager,
    private val lease: TelegramSessionLease,
    private val requireUserGesture: () -> Unit,
    private val complete: (String, Any?, ApiException?) -> Unit,
    private val event: (String) -> Unit
) {
    private var telegramCodeProtection = false
    private var telegramCaptureWatch: AutoCloseable? = null

    companion object {
        fun register(functions: MiniAppFunctions, activity: MiniAppActivity, manifest: MiniAppManifest,
            storage: SecureStorageService, permissions: MiniAppPermissionManager, streams: WebStreams,
            requireUserGesture: () -> Unit, complete: (String, Any?, ApiException?) -> Unit, event: (String) -> Unit) {
            val provider = manifest.id == TelegramSessionLease.CLIENT_APP_ID
            if (!provider && TelegramAccess.PERMISSION !in manifest.permissions) return

            val lease = TelegramSessionLease(activity.filesDir)
            val telegram = TelegramFunctions(activity, permissions, lease, requireUserGesture, complete, event)
            functions.close = lease::close
            val cloud = manifest.id == TelegramCloudState.APP_ID
            if (!provider) {
                val access = TelegramAccess(activity, storage,
                    if (cloud) TelegramCloudState.GRANT_KEY else TelegramAccess.CONSUMER_GRANT_KEY,
                    if (cloud) "Облако файлов" else "${manifest.name} (${manifest.id})")
                functions.handlers["telegram.connect"] = { telegram.connect(it, access) }
                functions.handlers["telegram.restoreSaved"] = { request ->
                    if (permissions.state(TelegramAccess.PERMISSION) == "denied")
                        complete(request.id, null, null)
                    else access.use(false) { value, error -> complete(request.id, value, error) }
                }
                if (cloud) TelegramCloudFunctions.register(functions, activity, storage, access, complete)
                functions.register("telegram.acquire", complete) {
                    if (permissions.state(TelegramAccess.PERMISSION) == "denied" || !access.hasApproval())
                        throw ApiException("telegram_session_unavailable", "Connect to the shared Telegram account first")
                    lease.acquire(it.optString("owner"), false).also { until ->
                        if (functions.enableStreams) streams.setWaitUntil(until)
                    }
                }
            } else {
                val sharedSignIn = activity.intent.getStringExtra("launchReason") == TelegramAccess.LOGIN_REASON
                functions.beforeLogWrite = {
                    if (!TelegramSettings.read(activity).getBoolean("writeLoginLog"))
                        throw ApiException("telegram_log_disabled", "Telegram login logging is disabled")
                }
                functions.onStart = telegram::onStart
                functions.onStop = telegram::onStop
                functions.register("telegram.getSettings", complete) { TelegramSettings.read(activity, sharedSignIn) }
                functions.register("telegram.getAppCredentials", complete) { TelegramPackage.readAppCredentials(activity) }
                functions.register("telegram.setCodeCaptureProtection", complete) {
                    telegram.setTelegramCodeCaptureProtection(it.getBoolean("enabled"))
                    null
                }
                if (sharedSignIn) {
                    functions.register("telegram.finishSignIn", complete) {
                        if (storage.get("telegram.session.v1") !is JSONObject)
                            throw ApiException("telegram_session_unavailable", "Save the Telegram session before returning")
                        activity.setResult(Activity.RESULT_OK)
                        activity.finish()
                        null
                    }
                } else {
                    functions.register("telegram.acquireTest", complete) { lease.acquire(it.optString("owner"), true) }
                }
                functions.register("telegram.acquire", complete) { lease.acquire(it.optString("owner"), false) }
            }
            functions.register("telegram.setWaitUntil", complete) {
                lease.setWaitUntil(it.optString("owner"), it.optLong("until", -1)).also { until ->
                    if (functions.enableStreams) streams.setWaitUntil(until)
                }
            }
            functions.register("telegram.release", complete) {
                lease.release(it.optString("owner"))
                if (functions.enableStreams) streams.setWaitUntil(0)
                null
            }
            if (provider || cloud) functions.register("telegram.serviceNotices", complete, telegram::telegramServiceNotices)
        }
    }
 private fun connect(request: BridgeRequest, access: TelegramAccess) {
     requireUserGesture()
     if (permissions.state(TelegramAccess.PERMISSION) == "denied")
         throw ApiException("permission_denied", "Enable Telegram access in the mini-app permissions")
     fun approve() = access.use(true) { value, error ->
         if (value is JSONObject) permissions.decide(TelegramAccess.PERMISSION, true)
         complete(request.id, value, error)
     }
     if (access.hasSaved() && !request.params.optBoolean("reauthenticate")) {
         approve()
         return
     }
     if (MiniAppRepository(activity).get(TelegramSessionLease.CLIENT_APP_ID) == null)
         throw ApiException("telegram_package_missing", "Install Telegram from the launcher")
     val intent = Intent(activity, MiniAppActivity::class.java)
         .putExtra("appId", TelegramSessionLease.CLIENT_APP_ID)
         .putExtra("launchReason", TelegramAccess.LOGIN_REASON)
     activity.launchForResult(intent) { signedIn ->
         if (!signedIn) {
             complete(request.id, null, ApiException("operation_cancelled", "Telegram sign-in was cancelled"))
         } else {
             try {
                 approve()
             } catch (error: StorageException) {
                 complete(request.id, null, ApiException(error.code, error.message))
             } catch (error: ApiException) {
                 complete(request.id, null, error)
             } catch (_: Exception) {
                 complete(request.id, null, ApiException("internal_error", "Could not restore Telegram sign-in"))
             }
         }
     }
 }

 private fun telegramServiceNotices(params:JSONObject):JSONArray {
  lease.requireOwner(params.optString("owner"))
  val accountId=params.optString("accountId")
  if(!Regex("[0-9]{1,20}").matches(accountId))throw ApiException("invalid_params","Invalid Telegram account ID")
  val storage=SecureStorageService(activity,TelegramSessionLease.CLIENT_APP_ID)
  val key=if(lease.testServers)"runtime.telegram.test.notices.$accountId" else "runtime.telegram.notices.$accountId"
  val notices=storage.get(key) as? JSONArray ?: JSONArray()
  val notice=params.optJSONObject("notice") ?: return notices
  val text=notice.optString("text")
  val type=notice.optString("type")
  val date=notice.optLong("date")
  if(text.length !in 1..4096||type.length>128||date<1)throw ApiException("invalid_params","Invalid Telegram notice")
  notices.put(JSONObject().put("text",text).put("type",type).put("date",date))
  while(notices.length()>64)notices.remove(0)
  storage.set(key,notices)
  return notices
 }
 internal fun setTelegramCodeCaptureProtection(enabled: Boolean) {
     if (telegramCodeProtection == enabled) return
     telegramCodeProtection = enabled
     updateTelegramCodeCaptureProtection()
 }

 private fun updateTelegramCodeCaptureProtection() {
     if (!telegramCodeProtection) {
         telegramCaptureWatch?.close()
         telegramCaptureWatch = null
         activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
     } else if (Build.VERSION.SDK_INT >= 34 && telegramCaptureWatch == null) {
         telegramCaptureWatch = runCatching { watchTelegramScreenshots() }.getOrNull()
         if (telegramCaptureWatch == null) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
         else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
     } else if (Build.VERSION.SDK_INT < 34) {
         activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
     }
 }

 @RequiresApi(34)
 private fun watchTelegramScreenshots(): AutoCloseable {
     val callback = Activity.ScreenCaptureCallback { event("telegram.screenCaptured") }
     activity.registerScreenCaptureCallback(activity.mainExecutor, callback)
     return AutoCloseable { activity.unregisterScreenCaptureCallback(callback) }
 }

 fun onStart() {
     if (telegramCodeProtection) updateTelegramCodeCaptureProtection()
 }

 fun onStop() {
     telegramCaptureWatch?.close()
     telegramCaptureWatch = null
 }

}
