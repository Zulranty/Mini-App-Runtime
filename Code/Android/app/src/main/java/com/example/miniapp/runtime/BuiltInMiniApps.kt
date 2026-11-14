package com.example.miniapp.runtime

import android.content.Context
import com.example.miniapp.launcher.TelegramPackage
import com.example.miniapp.model.MiniAppManifest
import com.example.miniapp.permissions.MiniAppPermissionManager
import com.example.miniapp.services.SecureStorageService
import java.io.InputStream

internal data class MiniAppContent(
    val manifest: MiniAppManifest,
    val openFile: ((String) -> InputStream?)? = null,
    val openModule: ((String) -> InputStream?)? = null
)

internal object BuiltInMiniApps {
    fun resolveContent(context: Context, installed: MiniAppManifest): MiniAppContent {
        return if (installed.id == TelegramSessionLease.CLIENT_APP_ID) {
            MiniAppContent(TelegramPackage.trustedManifest(context),
                { TelegramPackage.openTrustedClientFile(context, it) },
                { TelegramPackage.openTrustedModule(context, it) })
        } else MiniAppContent(installed)
    }

    fun configure(activity: MiniAppActivity, manifest: MiniAppManifest, storage: SecureStorageService,
        permissions: MiniAppPermissionManager, streams: WebStreams, requireUserGesture: () -> Unit,
        complete: (String, Any?, ApiException?) -> Unit, event: (String) -> Unit): MiniAppFunctions {
        return MiniAppFunctions().also {
            TelegramFunctions.register(it, activity, manifest, storage, permissions, streams, requireUserGesture, complete, event)
        }
    }
}
