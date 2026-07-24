package com.example.miniapp.permissions
import android.content.*
class MiniAppPermissionManager(context:Context, private val appId:String) {
 private val prefs=context.getSharedPreferences("permissions.$appId",Context.MODE_PRIVATE)
 fun granted(permission:String)=prefs.getBoolean(permission,false)
 fun decided(permission:String)=prefs.contains(permission)
 fun state(permission:String)=if(!decided(permission))"prompt" else if(granted(permission))"granted" else "denied"
 fun decide(permission:String,yes:Boolean){ prefs.edit().putBoolean(permission,yes).apply() }
 fun reset(){prefs.edit().clear().apply()}
}
