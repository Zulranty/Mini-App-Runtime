package com.example.miniapp.bridge
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.*
data class BridgeRequest(val id:String,val method:String,val params:JSONObject) { companion object { fun parse(raw:String):BridgeRequest { val o=JSONObject(raw); val id=o.optString("id");val method=o.optString("method");if(id.isBlank()||method.isBlank()||!o.has("params")) throw IllegalArgumentException("id, method and params are required");return BridgeRequest(id,method,o.optJSONObject("params")?:throw IllegalArgumentException("params must be object")) } } }
data class BridgeResponse(val id:String,val success:Boolean,val result:Any?=null,val errorCode:String?=null,val errorMessage:String?=null) { fun json():String { val o=JSONObject().put("id",id).put("success",success);if(success)o.put("result",result?:JSONObject.NULL) else o.put("error",JSONObject().put("code",errorCode).put("message",errorMessage));return o.toString() } }
interface BridgeMethodHandler { fun handle(request:BridgeRequest):Any? }
class JsBridge(private val dispatch:(String)->Unit) {
 @JavascriptInterface fun call(raw:String) {
  try { dispatch(raw) } catch (t:Throwable) { Log.e("MiniRuntime", "Bridge dispatch failed", t) }
 }
}
