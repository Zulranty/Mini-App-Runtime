package com.example.miniapp.services

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

class NetworkAddressPolicyTest {
    @Test
    fun publicResolverPassesTheValidatedAddressesThrough() {
        val expected = listOf(address("8.8.8.8"), address("2606:4700::1111"))
        var calls = 0
        val resolver = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                assertEquals("example.test", hostname)
                calls++
                return expected
            }
        }
        assertEquals(expected, NetworkAddressPolicy.publicDns(resolver).lookup("example.test"))
        assertEquals(1, calls)
    }

    @Test
    fun publicResolverRejectsASetContainingAnyLocalAddress() {
        val resolver = object : Dns {
            override fun lookup(hostname: String) = listOf(address("8.8.8.8"), address("fd00::1"))
        }
        assertThrows(NetworkAddressPolicy.LocalAddressDenied::class.java) {
            NetworkAddressPolicy.publicDns(resolver).lookup("example.test")
        }
    }

    @Test
    fun classifiesSpecialAndEmbeddedAddresses() {
        listOf("0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.31.255.255",
            "192.168.0.1", "198.18.0.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1",
            "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "fd00::1", "fe80::1", "ff02::1").forEach {
            assertFalse(it, NetworkAddressPolicy.isPublic(address(it)))
        }
        listOf("8.8.8.8", "172.32.0.1", "2606:4700::1111", "64:ff9b::808:808").forEach {
            assertTrue(it, NetworkAddressPolicy.isPublic(address(it)))
        }
    }

    @Test
    fun checksLiteralsBeforeOkHttpCanBypassDns() {
        listOf("127.0.0.1", "127.1", "2130706433", "::1", "sub.localhost.").forEach { host ->
            assertThrows(host, NetworkAddressPolicy.LocalAddressDenied::class.java) {
                NetworkAddressPolicy.checkPublicHost(host)
            }
        }
        NetworkAddressPolicy.checkPublicHost("8.8.8.8")
        NetworkAddressPolicy.checkPublicHost("2606:4700::1111")
        NetworkAddressPolicy.checkPublicHost("example.test")
    }

    private fun address(literal: String) = InetAddress.getByName(literal)
}
