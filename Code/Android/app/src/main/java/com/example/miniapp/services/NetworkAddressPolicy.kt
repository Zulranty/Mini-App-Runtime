package com.example.miniapp.services

import okhttp3.Dns
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

internal object NetworkAddressPolicy {
    class LocalAddressDenied : UnknownHostException("Local network is not allowed")

    fun publicDns(resolver: Dns = Dns.SYSTEM): Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            if (isLocalName(hostname)) throw LocalAddressDenied()
            return resolver.lookup(hostname).also { addresses ->
                if (addresses.any { !isPublic(it) }) throw LocalAddressDenied()
            }
        }
    }

    fun checkPublicHost(host: String) {
        if (isLocalName(host)) throw LocalAddressDenied()
        // OkHttp bypasses its custom DNS for IP literals. Reject ambiguous numeric forms
        // before the client can interpret them as a literal or pass them to the resolver.
        if (':' in host) {
            if (!isPublic(InetAddress.getByName(host))) throw LocalAddressDenied()
        } else if (host.all { it in '0'..'9' || it == '.' }) {
            val parts = host.split('.')
            if (parts.size != 4) throw LocalAddressDenied()
            val octets = parts.map { part ->
                val value = part.toIntOrNull() ?: throw LocalAddressDenied()
                if (value !in 0..255 || value.toString() != part) throw LocalAddressDenied()
                value.toByte()
            }
            val address = InetAddress.getByAddress(octets.toByteArray())
            if (!isPublic(address)) throw LocalAddressDenied()
        }
    }

    private fun isLocalName(host: String): Boolean {
        val name = host.trimEnd('.')
        return name == "localhost" || name.endsWith(".localhost")
    }

    internal fun isPublic(address: InetAddress): Boolean {
        val bytes = address.address
        if (bytes.size == 4) return isPublicV4(bytes, 0)
        if (address !is Inet6Address || address.scopeId != 0) return false
        if (bytes.take(10).all { it == 0.toByte() } && bytes[10] == (-1).toByte() && bytes[11] == (-1).toByte()) {
            return isPublicV4(bytes, 12)
        }
        // The well-known DNS64 prefix carries an IPv4 destination.
        if (bytes[0] == 0.toByte() && bytes[1] == 0x64.toByte() && bytes[2] == 0xff.toByte() &&
            bytes[3] == 0x9b.toByte() && bytes.slice(4..11).all { it == 0.toByte() }) {
            return isPublicV4(bytes, 12)
        }
        val first = bytes[0].toInt() and 0xff
        val second = bytes[1].toInt() and 0xff
        val third = bytes[2].toInt() and 0xff
        val fourth = bytes[3].toInt() and 0xff
        // Global unicast, excluding protocol assignments, transition and documentation ranges.
        return first in 0x20..0x3f &&
            !(first == 0x20 && second == 0x01 && (third < 2 || (third == 0x0d && fourth == 0xb8))) &&
            !(first == 0x20 && second == 0x02) &&
            !(first == 0x3f && second == 0xfe) &&
            !(first == 0x3f && second == 0xff && third < 0x10)
    }

    private fun isPublicV4(bytes: ByteArray, offset: Int): Boolean {
        val first = bytes[offset].toInt() and 0xff
        val second = bytes[offset + 1].toInt() and 0xff
        val third = bytes[offset + 2].toInt() and 0xff
        return when (first) {
            0, 10, 127, in 224..255 -> false
            100 -> second !in 64..127
            169 -> second != 254
            172 -> second !in 16..31
            192 -> second != 168 && !(second == 0 && (third == 0 || third == 2)) &&
                !(second == 88 && third == 99)
            198 -> second !in 18..19 && !(second == 51 && third == 100)
            203 -> !(second == 0 && third == 113)
            else -> true
        }
    }
}
