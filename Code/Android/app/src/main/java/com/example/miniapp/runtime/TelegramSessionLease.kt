package com.example.miniapp.runtime

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.channels.OverlappingFileLockException

internal class TelegramSessionLease(private val directory: File) {
    companion object {
        const val CLIENT_APP_ID = "com.miniapps.telegram"
        private val held = mutableSetOf<String>()
    }

    private var heldPath: String? = null
    private var lease: RandomAccessFile? = null
    private var owner: String? = null
    private var waitUntil = 0L
    var testServers = false
        private set

    fun acquire(token: String, useTestServers: Boolean): Long = synchronized(held) {
        if (token.length !in 1..80) throw ApiException("invalid_params", "Invalid Telegram lease owner")
        if (lease != null) {
            if (owner != token || testServers != useTestServers)
                throw ApiException("telegram_session_busy", "Close the other Telegram mini-app first")
            return@synchronized waitUntil
        }
        val path = File(directory, if (useTestServers) "telegram-test-session.lock" else "telegram-session.lock").absoluteFile
        if (path.path in held) throw ApiException("telegram_session_busy", "Close the other Telegram mini-app first")
        var opened: RandomAccessFile? = null
        try {
            opened = RandomAccessFile(path, "rw")
            val lock = try { opened.channel.tryLock() } catch (_: OverlappingFileLockException) { null }
            if (lock == null) throw ApiException("telegram_session_busy", "Close the other Telegram mini-app first")
            waitUntil = if (opened.length() == Long.SIZE_BYTES.toLong()) opened.readLong() else 0L
            lease = opened
            owner = token
            testServers = useTestServers
            heldPath = path.path
            held.add(path.path)
            waitUntil
        } catch (_: IOException) {
            throw ApiException("telegram_session_unavailable", "Could not lock the Telegram session")
        } finally {
            if (lease == null) runCatching { opened?.close() }
        }
    }

    fun requireOwner(token: String) {
        if (owner != token) throw ApiException("telegram_session_unavailable", "Telegram session is not held by this client")
    }

    fun setWaitUntil(token: String, until: Long): Long {
        requireOwner(token)
        val opened = checkNotNull(lease)
        if (until !in 0L..253402300799999L) throw ApiException("invalid_params", "Invalid Telegram wait deadline")
        if (until <= waitUntil) return waitUntil
        opened.seek(0)
        opened.writeLong(until)
        opened.setLength(Long.SIZE_BYTES.toLong())
        opened.fd.sync()
        waitUntil = until
        return waitUntil
    }

    fun close() = synchronized(held) {
        val opened = lease ?: return@synchronized
        lease = null
        owner = null
        try { opened.close() }
        finally {
            heldPath?.let { held.remove(it) }
            heldPath = null
        }
    }

    fun release(token: String) {
        requireOwner(token)
        close()
    }
}
