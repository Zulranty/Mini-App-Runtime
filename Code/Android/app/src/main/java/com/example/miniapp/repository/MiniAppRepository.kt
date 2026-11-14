package com.example.miniapp.repository
import android.content.Context
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.*
import com.example.miniapp.services.MiniNotificationService
import com.example.miniapp.services.DirectoryGrants
import com.example.miniapp.services.AppInfoService
import com.example.miniapp.services.SecureStorageService
import com.example.miniapp.services.StorageException
import java.io.File
class MiniAppRepository(private val context:Context){
 private val root get()=SharedMiniAppStore.ensureRoot()
 fun sync(){if(SharedMiniAppStore.hasFileAccess())SharedMiniAppStore.syncZips(context)}
 fun list()=SharedMiniAppStore.appDirs().mapNotNull{SharedMiniAppStore.readManifest(it)?.let(::InstalledMiniApp)}.sortedBy{it.manifest.name.lowercase()}
 fun get(id:String)=list().firstOrNull{it.manifest.id==id}
 fun dir(id:String)=SharedMiniAppStore.findDirById(id)?:File(root,SharedMiniAppStore.folderForId(id))
 fun rollbackInfo(id:String):org.json.JSONObject { val data=File(root,".runtime/rollback/$id/rollback.json");return if(data.isFile && File(data.parentFile, "app").isDirectory) runCatching{org.json.JSONObject(data.readText()).put("available",true)}.getOrElse{org.json.JSONObject().put("available",false)} else org.json.JSONObject().put("available",false) }
 fun deleteRollback(id:String){File(root,".runtime/rollback/$id").deleteRecursively()}
 fun rollback(id:String) = MiniAppInstaller(context).rollback(id)
 fun delete(id:String, @Suppress("UNUSED_PARAMETER") data:Boolean=true){synchronized(SharedMiniAppStore.installLock){val app=SharedMiniAppStore.findDirById(id) ?: throw IllegalArgumentException("Application was not found");MiniAppInstaller(context).recoverTarget(app);val failures=mutableListOf<String>();AppInfoService.clear(context,id);MiniNotificationService(context,id).cancelAll();context.getSharedPreferences("notifications.$id",Context.MODE_PRIVATE).edit().clear().commit();context.getSharedPreferences("notification.apps",Context.MODE_PRIVATE).edit().remove(id).commit();try { DirectoryGrants.clear(context,id) } catch (_:Exception) { failures+="directory grants" };if(app.exists()&&!app.deleteRecursively())failures+="application";deleteRollback(id);val private=File(context.filesDir,"mini-private/$id");if(private.exists()&&!private.deleteRecursively())failures+="private storage";context.getSharedPreferences("mini.$id",Context.MODE_PRIVATE).edit().clear().commit();context.getSharedPreferences("permissions.$id",Context.MODE_PRIVATE).edit().clear().commit()
  try { SecureStorageService(context,id).clear() } catch (_:StorageException) { failures+="secure storage" }
  if(failures.isNotEmpty())throw IllegalStateException("Could not delete: ${failures.joinToString()}")
 }}
}
