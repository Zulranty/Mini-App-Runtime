package com.example.miniapp.services

import android.content.ContentResolver
import com.example.miniapp.runtime.ApiException
import java.io.InputStream
import java.util.concurrent.Executors

/** Keeps at most one selected document open, including forward-only provider streams. */
internal class SequentialFileReader(private val resolver: ContentResolver) {
    private val worker = Executors.newSingleThreadExecutor()
    private var file: RuntimeFile? = null
    private var stream: InputStream? = null
    private var position = 0L

    fun read(target: RuntimeFile, offset: Long, length: Int, complete: (Result<ByteArray>) -> Unit) {
        worker.execute {
            val result = runCatching {
                if (target !== file || offset < position) {
                    reset()
                    stream = resolver.openInputStream(target.uri)
                        ?: throw ApiException("file_read_failed", "Could not open file")
                    file = target
                }
                val input = checkNotNull(stream)
                input.skipFileBytes(offset - position)
                input.readFileBytes(length).also { position = offset + it.size }
            }
            if (result.isFailure) reset()
            complete(result)
        }
    }

    fun release(target: RuntimeFile) {
        worker.execute { if (file === target) reset() }
    }

    fun close() {
        worker.execute { reset() }
        worker.shutdown()
    }

    private fun reset() {
        runCatching { stream?.close() }
        stream = null
        file = null
        position = 0
    }
}

internal fun InputStream.skipFileBytes(count: Long) {
    var remaining = count
    while (remaining > 0) {
        val skipped = skip(remaining)
        if (skipped > 0) remaining -= skipped
        else if (read() == -1) throw ApiException("invalid_params", "Offset is outside the file")
        else remaining--
    }
}

internal fun InputStream.readFileBytes(length: Int): ByteArray {
    val buffer = ByteArray(length)
    var total = 0
    while (total < length) {
        val count = read(buffer, total, length - total)
        if (count <= 0) break
        total += count
    }
    return if (total == length) buffer else buffer.copyOf(total)
}
