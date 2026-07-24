package com.example.miniapp.repository

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import com.example.miniapp.installer.HtmlManifestReader
import com.example.miniapp.installer.MiniAppInstaller
import com.example.miniapp.model.MiniAppManifest
import org.json.JSONObject
import java.io.File

object SharedMiniAppStore {
    const val DIR_NAME = "MiniApps"
    internal val installLock = Any()
    fun root(): File = File(Environment.getExternalStorageDirectory(), DIR_NAME)
    fun hasFileAccess() = Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
    fun settingsIntent(context: Context): Intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply { data=Uri.parse("package:${context.packageName}") } else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply { data=Uri.parse("package:${context.packageName}") }
    fun ensureRoot(): File = root().apply { mkdirs() }
    fun targetForSource(file:File)=File(ensureRoot(),file.nameWithoutExtension.sanitizeFolderName())
    fun htmlFilesWithoutManifest():List<File>{if(!hasFileAccess())return emptyList();return ensureRoot().listFiles()?.filter{it.isFile&&it.extension.lowercase() in setOf("html","htm")&&readHtmlManifest(it)==null}?: emptyList()}
    fun syncZips(context:Context) = synchronized(installLock) { val root=ensureRoot(); root.listFiles()?.filter{it.isFile&&it.extension.lowercase() in setOf("zip","html","htm")}?.forEach { source -> runCatching{MiniAppInstaller(context).install(source)}.onFailure{Log.w("MiniRuntime","Could not install ${source.name}: ${it.message}")} } }
    fun appDirs():List<File>{if(!hasFileAccess())return emptyList();return ensureRoot().listFiles()?.filter{it.isDirectory&&!it.name.startsWith(".")&&File(it,"manifest.json").isFile}?: emptyList()}
    fun findDirById(id:String):File?=appDirs().firstOrNull{readManifest(it)?.id==id}
    fun readManifest(dir:File):MiniAppManifest?=runCatching{MiniAppManifest.parse(JSONObject(File(dir,"manifest.json").readText()))}.getOrNull()
    fun folderForId(id:String)=id.sanitizeFolderName()
    private fun readHtmlManifest(file:File)=runCatching{HtmlManifestReader.read(file)}.getOrNull()
    private fun String.sanitizeFolderName()=replace(Regex("[^A-Za-z0-9._-]"),"_").ifBlank{"mini_app"}
}
