package com.example.miniapp.services

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import com.example.miniapp.runtime.ApiException
import java.io.File

/** Owns persisted tree grants shared by aliases and open runtimes. */
internal object DirectoryGrants {
    private val live = mutableMapOf<Uri, Int>()
    private val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION

    private fun prefs(context: Context, id: String) =
        context.getSharedPreferences("directories.$id", Context.MODE_PRIVATE)

    private fun ownerTree(uri: Uri): Uri =
        DocumentsContract.buildTreeDocumentUri(requireNotNull(uri.authority), DocumentsContract.getTreeDocumentId(uri))

    @Synchronized
    fun retain(document: Uri) {
        val tree = ownerTree(document)
        live[tree] = live.getOrDefault(tree, 0) + 1
    }

    @Synchronized
    fun persist(context: Context, id: String, name: String, document: Uri) {
        val tree = ownerTree(document)
        val aliases = prefs(context, id)
        val previous = aliases.getString(name, null)
        if (previous == document.toString()) {
            if (context.contentResolver.persistedUriPermissions.any { it.uri == tree && it.isReadPermission }) return
        }
        try {
            context.contentResolver.takePersistableUriPermission(tree, flags)
        } catch (_: SecurityException) {
            throw ApiException("file_permission_denied", "The system provider did not grant persistent folder access")
        }
        if (!aliases.edit().putString(name, document.toString()).commit()) {
            releaseIfUnused(context, tree)
            throw ApiException("file_write_failed", "Could not save folder access")
        }
        previous?.let { releaseIfUnused(context, ownerTree(Uri.parse(it))) }
    }

    @Synchronized
    fun restore(context: Context, id: String, name: String): Uri? {
        val uri = prefs(context, id).getString(name, null)?.let(Uri::parse) ?: return null
        val tree = ownerTree(uri)
        if (context.contentResolver.persistedUriPermissions.none { it.uri == tree && it.isReadPermission })
            return null
        retain(uri)
        return if (DocumentsContract.isDocumentUri(context, uri)) uri
            else DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    }

    @Synchronized
    fun forget(context: Context, id: String, name: String) {
        val aliases = prefs(context, id)
        val document = aliases.getString(name, null) ?: return
        if (!aliases.edit().remove(name).commit())
            throw ApiException("file_write_failed", "Could not remove folder access")
        releaseIfUnused(context, ownerTree(Uri.parse(document)))
    }

    @Synchronized
    fun clear(context: Context, id: String) {
        val aliases = prefs(context, id)
        val trees = aliases.all.values.filterIsInstance<String>().map { ownerTree(Uri.parse(it)) }.toSet()
        if (!aliases.edit().clear().commit())
            throw ApiException("file_write_failed", "Could not remove folder access")
        trees.forEach { releaseIfUnused(context, it) }
    }

    @Synchronized
    fun release(context: Context, document: Uri) {
        val tree = ownerTree(document)
        val remaining = live.getOrDefault(tree, 0) - 1
        if (remaining > 0) live[tree] = remaining else live.remove(tree)
        releaseIfUnused(context, tree)
    }

    private fun releaseIfUnused(context: Context, tree: Uri) {
        if (live.containsKey(tree)) return
        val sharedPrefs = File(context.applicationInfo.dataDir, "shared_prefs")
        val stillOwned = sharedPrefs.listFiles().orEmpty()
            .filter { it.name.startsWith("directories.") && it.name.endsWith(".xml") }
            .any { file ->
                context.getSharedPreferences(file.nameWithoutExtension, Context.MODE_PRIVATE).all.values
                    .filterIsInstance<String>().any { runCatching { ownerTree(Uri.parse(it)) == tree }.getOrDefault(false) }
            }
        if (stillOwned) return

        val grant = context.contentResolver.persistedUriPermissions.firstOrNull { it.uri == tree } ?: return
        val owned = (if (grant.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or
            (if (grant.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
        if (owned != 0) context.contentResolver.releasePersistableUriPermission(tree, owned)
    }
}
