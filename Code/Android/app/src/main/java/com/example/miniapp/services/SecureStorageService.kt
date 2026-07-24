package com.example.miniapp.services

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec

/** App-id isolated values encrypted with a non-exportable Android Keystore AES key. */
class SecureStorageService(context: Context, private val appId: String) {
 private val prefs=context.getSharedPreferences("secure-mini.$appId",Context.MODE_PRIVATE)
 private val alias="mini.runtime.secure.$appId"
 private fun key():javax.crypto.SecretKey { val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}; (store.getKey(alias,null) as? javax.crypto.SecretKey)?.let{return it}; val generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());return generator.generateKey() }
 @Synchronized fun get(name:String):Any? { val encoded=prefs.getString(name,null)?:return null;return try{val parts=encoded.split(":",limit=2);val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,Base64.decode(parts[0],Base64.NO_WRAP)));org.json.JSONTokener(cipher.doFinal(Base64.decode(parts[1],Base64.NO_WRAP)).toString(Charsets.UTF_8)).nextValue()}catch(_:Exception){throw StorageException("secure_storage_failed","Secure storage data is unavailable")} }
 @Synchronized fun set(name:String,value:Any?){try{val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());val raw=JSONObject.wrap(value)?.toString() ?: "null";val payload=Base64.encodeToString(cipher.iv,Base64.NO_WRAP)+":"+Base64.encodeToString(cipher.doFinal(raw.toByteArray()),Base64.NO_WRAP);if(!prefs.edit().putString(name,payload).commit())throw IllegalStateException()}catch(e:StorageException){throw e}catch(_:Exception){throw StorageException("secure_storage_unavailable","Secure storage is unavailable")}}
 fun remove(name:String){prefs.edit().remove(name).commit()}; fun keys()=prefs.all.keys.toList(); fun clear(){prefs.edit().clear().commit()}
}
