package com.example.miniapp.runtime

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.example.miniapp.services.DocumentCreator
import com.example.miniapp.services.FileShareRequestValidator
import com.example.miniapp.services.SaveFileRequest
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

internal class WebStreams(
    private val resolver: ContentResolver,
    private val emit: (String, JSONObject) -> Unit,
    private val complete: (String, Any?, ApiException?) -> Unit
) {
    companion object {
        const val HOST = "media.miniapp.local"
        private const val BLOCK = 512 * 1024
        private const val SAVE_BLOCK = 1024 * 1024
        private const val LIMIT = 2_000_000_000L
        private val sourceId = Regex("stream-[0-9]{1,12}")
        private val mediaMime = Regex("(video|audio)/[a-zA-Z0-9_.+\\-]{1,64}")
        private val rangeHeader = Regex("bytes=([0-9]*)-([0-9]*)", RegexOption.IGNORE_CASE)
    }

    private class Source(val id: String, val size: Long, val mime: String) {
        val url = "https://$HOST/${UUID.randomUUID()}"
        @Volatile var cancelled = false
    }

    private data class Save(val requestId: String, val source: Source, val file: SaveFileRequest)
    private data class Read(val source: Source, val length: Int, val result: CompletableFuture<ByteArray?>)
    private val pending = ConcurrentHashMap<String, Read>()
    private val slots = Semaphore(8)
    private val writer = Executors.newSingleThreadExecutor()
    @Volatile private var media: Source? = null
    @Volatile private var save: Save? = null
    @Volatile private var waitUntil = 0L

    fun setWaitUntil(until: Long) {
        waitUntil = until
        notifyWaitUntil(media)
        notifyWaitUntil(save?.source)
    }

    private fun notifyWaitUntil(source: Source?) {
        if (source != null) {
            emit("streams.waitUntil", JSONObject().put("source", source.id).put("until", waitUntil))
        }
    }

    private fun source(params: JSONObject): Source {
        val id = params.optString("source")
        val size = params.optLong("size", -1)
        if (!sourceId.matches(id) || size !in 1..LIMIT) throw ApiException("invalid_params", "Invalid stream source")
        return Source(id, size, params.optString("mimeType"))
    }

    fun open(params: JSONObject): String {
        if (media != null) throw ApiException("operation_in_progress", "A media stream is already open")
        val stream = source(params)
        if (!mediaMime.matches(stream.mime)) throw ApiException("invalid_params", "Invalid media type")
        media = stream
        return stream.url
    }

    fun close(id: String) {
        media?.takeIf { it.id == id }?.let { media = null; cancel(it) }
        save?.source?.takeIf { it.id == id }?.let { cancel(it) }
    }

    private fun cancel(source: Source) {
        source.cancelled = true
        for (read in pending.values) {
            if (read.source === source) read.result.complete(null)
        }
    }

    fun reply(params: JSONObject) {
        val read = pending[params.optString("request")] ?: return
        val data = params.opt("data") as? String
        val bytes = if (data?.length == (read.length + 2) / 3 * 4) {
            try { android.util.Base64.decode(data, android.util.Base64.NO_WRAP) }
            catch (_: IllegalArgumentException) { null }
        } else null
        read.result.complete(bytes?.takeIf { it.size == read.length })
    }

    private fun read(source: Source, offset: Long, length: Int): ByteArray {
        if (source.cancelled) throw ApiException("operation_cancelled", "Stream closed")
        if (!slots.tryAcquire()) throw ApiException("operation_in_progress", "Too many stream reads")
        val request = UUID.randomUUID().toString()
        val result = CompletableFuture<ByteArray?>()
        pending[request] = Read(source, length, result)
        try {
            if (source.cancelled) throw ApiException("operation_cancelled", "Stream closed")
            emit("streams.read", JSONObject().put("source", source.id).put("request", request)
                .put("offset", offset).put("length", length).put("waitUntil", waitUntil))
            val deadline = System.currentTimeMillis() + 45_000
            while (true) {
                val remaining = maxOf(deadline, waitUntil + 45_000) - System.currentTimeMillis()
                if (remaining <= 0) throw ApiException("stream_read_failed", "The stream timed out")
                try {
                    val bytes = result.get(remaining, TimeUnit.MILLISECONDS)
                    if (source.cancelled) throw ApiException("operation_cancelled", "Stream closed")
                    return bytes ?: throw ApiException("stream_read_failed", "Could not read the requested data")
                } catch (_: java.util.concurrent.TimeoutException) {
                    // The source may have extended its wait while the read was pending.
                }
            }
        } finally {
            pending.remove(request)
            slots.release()
        }
    }

    fun beginSave(id: String, params: JSONObject, create: DocumentCreator) {
        val operation = prepareSave(id, params)
        try { create.create(operation.file.mimeType, operation.file.name) }
        catch (error: Exception) {
            save = null
            throw error
        }
    }

    private fun prepareSave(id: String, params: JSONObject): Save {
        if (save != null) throw ApiException("operation_in_progress", "A save operation is already active")
        val stream = source(params)
        val file = FileShareRequestValidator.saveBase64(JSONObject().put("suggestedName", params.opt("suggestedName"))
            .put("mimeType", stream.mime).put("base64", ""))
        return Save(id, stream, file).also { save = it }
    }

    fun saveInDirectory(id: String, params: JSONObject, root: Uri) {
        val parts = params.optJSONArray("folders")
        val count = parts?.length() ?: 0
        if (count > 64) throw ApiException("invalid_params", "Folder path is too deep")
        val folders = List(count) { index ->
            parts!!.getString(index).also { name ->
                if (name.isBlank() || name.length > 255 || name == "." || name == ".." ||
                    name.any { it == '/' || it == '\\' || it < ' ' }) {
                    throw ApiException("invalid_params", "Invalid destination name")
                }
            }
        }
        val operation = prepareSave(id, params)
        writeDocument(operation) {
            var parent = root
            for (name in folders) {
                if (operation.source.cancelled) throw ApiException("operation_cancelled", "Stream closed")
                parent = findOrCreateFolder(parent, name)
            }
            DocumentsContract.createDocument(resolver, parent, operation.file.mimeType, operation.file.name)
                ?: throw ApiException("file_write_failed", "Could not create file")
        }
    }

    private fun findOrCreateFolder(parent: Uri, name: String): Uri {
        val id = DocumentsContract.Document.COLUMN_DOCUMENT_ID
        val displayName = DocumentsContract.Document.COLUMN_DISPLAY_NAME
        val mime = DocumentsContract.Document.COLUMN_MIME_TYPE
        val directory = DocumentsContract.Document.MIME_TYPE_DIR
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(parent, DocumentsContract.getDocumentId(parent))
        resolver.query(children, arrayOf(id, displayName, mime), null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == name && cursor.getString(2) == directory) {
                    return DocumentsContract.buildDocumentUriUsingTree(parent, cursor.getString(0))
                }
            }
        }
        return DocumentsContract.createDocument(resolver, parent, directory, name)
            ?: throw ApiException("file_write_failed", "Could not create directory")
    }

    fun onDocumentCreated(uri: Uri?) {
        val operation = save
        if (operation == null) {
            if (uri != null) writer.execute { discard(uri) }
            return
        }
        if (uri == null) {
            save = null
            complete(operation.requestId, null, null)
            return
        }
        writeDocument(operation, existing = uri)
    }

    private fun writeDocument(operation: Save, existing: Uri? = null, create: (() -> Uri)? = null) {
        writer.execute {
            var uri = existing
            var success = false
            var failure: ApiException? = null
            val stream = operation.source
            try {
                if (!stream.cancelled) {
                    val destination = existing ?: checkNotNull(create).invoke()
                    uri = destination
                    val output = resolver.openOutputStream(destination, "w")
                        ?: throw ApiException("file_write_failed", "Could not open file")
                    output.use {
                        var offset = 0L
                        while (offset < stream.size) {
                            val bytes = read(stream, offset, minOf(SAVE_BLOCK.toLong(), stream.size - offset).toInt())
                            it.write(bytes)
                            offset += bytes.size
                        }
                        it.flush()
                    }
                    success = !stream.cancelled
                }
            } catch (error: ApiException) {
                if (!stream.cancelled) failure = error
            } catch (_: Exception) {
                if (!stream.cancelled) failure = ApiException("file_write_failed", "Could not write file")
            } finally {
                if (!success && uri != null && !discard(uri))
                    failure = ApiException("file_write_failed", "Could not remove the unfinished document")
                save = null
                val value = if (success) JSONObject().put("name", operation.file.name)
                    .put("mimeType", operation.file.mimeType).put("sizeBytes", stream.size) else null
                complete(operation.requestId, value, failure)
            }
        }
    }

    private fun discard(uri: Uri): Boolean =
        runCatching { DocumentsContract.deleteDocument(resolver, uri) }.getOrDefault(false) ||
            runCatching { resolver.delete(uri, null, null) > 0 }.getOrDefault(false)

    fun serve(request: WebResourceRequest): WebResourceResponse {
        fun respond(status: Int, reason: String, mime: String = "text/plain",
                    extra: Map<String, String> = emptyMap(), bytes: ByteArray = byteArrayOf()) =
            WebResourceResponse(mime, null, status, reason,
                extra + mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), ByteArrayInputStream(bytes))

        val source = media?.takeIf { request.url.toString() == it.url } ?: return respond(404, "Not Found")
        val headers = mapOf("Accept-Ranges" to "bytes")
        if (request.method == "HEAD") return respond(200, "OK", source.mime, headers + ("Content-Length" to source.size.toString()))
        if (request.method != "GET") return respond(405, "Method Not Allowed")
        val range = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
        val (start, length) = parseRange(range, source.size)
            ?: return respond(416, "Range Not Satisfiable", extra = mapOf("Content-Range" to "bytes */${source.size}"))
        return try {
            val bytes = read(source, start, length)
            val content = headers + ("Content-Length" to length.toString())
            if (range == null && length.toLong() == source.size) respond(200, "OK", source.mime, content, bytes)
            else respond(206, "Partial Content", source.mime,
                content + ("Content-Range" to "bytes $start-${start + length - 1}/${source.size}"), bytes)
        } catch (_: Exception) {
            if (source.cancelled) respond(404, "Not Found") else respond(502, "Stream Read Failed")
        }
    }

    private fun parseRange(header: String?, size: Long): Pair<Long, Int>? {
        if (header == null) return 0L to minOf(size, BLOCK.toLong()).toInt()
        val match = rangeHeader.matchEntire(header) ?: return null
        val (first, last) = match.destructured
        val start: Long
        val end: Long
        if (first.isEmpty()) {
            val suffix = last.toLongOrNull()?.takeIf { it > 0 } ?: return null
            start = size - minOf(size, suffix)
            end = size - 1
        } else {
            start = first.toLongOrNull()?.takeIf { it < size } ?: return null
            end = if (last.isEmpty()) size - 1 else last.toLongOrNull()?.takeIf { it >= start } ?: return null
        }
        return start to minOf(BLOCK.toLong(), minOf(end, size - 1) - start + 1).toInt()
    }

    fun dispose() {
        media?.let { cancel(it) }
        media = null
        save?.source?.let { cancel(it) }
        writer.shutdown()
    }
}
