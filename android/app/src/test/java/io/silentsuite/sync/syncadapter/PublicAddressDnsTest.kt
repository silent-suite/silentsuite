package io.silentsuite.sync.syncadapter

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

class PublicAddressDnsTest {

    /** Parses a literal; never a lookup. */
    private fun ip(literal: String): InetAddress = InetAddress.getByName(literal)

    /** An IPv6 address object even where the platform would turn the bytes into an IPv4 one. */
    private fun v6(literal: String): Inet6Address =
            Inet6Address.getByAddress(null, ip(literal).let { a ->
                if (a.address.size == 16) a.address
                else ByteArray(10) + byteArrayOf(-1, -1) + a.address
            }, null)

    private val local = listOf(
            "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254",
            "192.168.0.1", "192.168.1.100", "169.254.169.254", "0.0.0.0", "100.64.0.1",
            "100.127.255.254", "224.0.0.1", "255.255.255.255",
            "::", "::1", "fe80::1", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1",
            "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::192.168.0.1",
            // Not globally reachable per the IANA special-purpose registries
            "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1",
            "240.0.0.1", "64:ff9b:1::c0a8:1", "100::1", "2001::1", "2001:1ff::1", "2001:db8::1",
            "3fff::1", "5f00::1", "2002:c0a8:101::1", "2002:808:808::1"
    )

    private val public = listOf(
            "1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255",
            "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888",
            "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "198.17.255.255", "198.20.0.1", "203.0.114.1",
            "2001:200::1", "2001:db9::1", "64:ff9b:2::1"
    )

    @Test
    fun localAddressesAreRefused() {
        for (literal in local)
            assertFalse(literal, PublicAddressDns.isPublic(ip(literal)))
    }

    @Test
    fun publicAddressesAreAllowed() {
        for (literal in public)
            assertTrue(literal, PublicAddressDns.isPublic(ip(literal)))
    }

    @Test
    fun ipv4MappedIpv6IsCheckedByItsIpv4Part() {
        assertFalse(PublicAddressDns.isPublic(v6("::ffff:10.0.0.1")))
        assertFalse(PublicAddressDns.isPublic(v6("::ffff:192.168.1.1")))
        assertTrue(PublicAddressDns.isPublic(v6("::ffff:8.8.8.8")))
    }

    private fun resolving(vararg literals: String) = object : Dns {
        override fun lookup(hostname: String) = literals.map { ip(it) }
    }

    private fun assertRefused(dns: Dns, hostname: String) {
        try {
            dns.lookup(hostname)
            fail("$hostname was not refused")
        } catch (expected: UnknownHostException) {
        }
    }

    @Test
    fun targetResolvingToALocalAddressIsRefused() {
        for (literal in listOf("127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "::1", "fe80::1", "fc00::1"))
            assertRefused(PublicAddressDns("photos.example", resolving(literal)), "photos.example")
    }

    @Test
    fun everyResolvedAddressIsChecked() {
        assertRefused(PublicAddressDns("photos.example", resolving("93.184.216.34", "192.168.1.1")), "photos.example")
        assertRefused(PublicAddressDns("photos.example", resolving("2606:4700::1", "::1")), "photos.example")
    }

    @Test
    fun targetResolvingToPublicAddressesIsReturnedUnchanged() {
        val dns = PublicAddressDns("photos.example", resolving("93.184.216.34", "2606:4700::1"))
        assertEquals(listOf(ip("93.184.216.34"), ip("2606:4700::1")), dns.lookup("PHOTOS.example"))
    }

    @Test
    fun otherNamesSuchAsAProxyPassThrough() {
        val dns = PublicAddressDns("photos.example", resolving("127.0.0.1"))
        assertEquals(listOf(ip("127.0.0.1")), dns.lookup("proxy.local"))
    }
}
