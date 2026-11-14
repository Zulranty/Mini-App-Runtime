package com.example.miniapp.runtime

import com.example.miniapp.bridge.BridgeRequest
import org.json.JSONObject

internal class MiniAppFunctions {
    val handlers = mutableMapOf<String, (BridgeRequest) -> Unit>()
    var enableStreams = false
    var allowMediaAutoplay = false
    var beforeLogWrite: (() -> Unit)? = null
    var onStart: (() -> Unit)? = null
    var onStop: (() -> Unit)? = null
    var close: (() -> Unit)? = null

    fun register(method: String, complete: (String, Any?, ApiException?) -> Unit, handler: (JSONObject) -> Any?) {
        check(handlers.put(method) { request -> complete(request.id, handler(request.params), null) } == null)
    }
}
