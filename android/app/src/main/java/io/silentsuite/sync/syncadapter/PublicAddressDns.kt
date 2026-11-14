package io.silentsuite.sync.syncadapter

import okhttp3.Dns
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException

/**
 * DNS for external resource downloads (contact photos given by URL): a lookup of [targetHost]
 * fails unless every address it resolves to is public, so the request can never reach the
 * user's own network or device. OkHttp connects only to the addresses returned here, so a name
 * that resolves differently between a check and the connection cannot slip past it.
 *
 * Other names pass through unchanged: with a proxy, OkHttp looks up the proxy's name instead, and
 * the user chose that proxy (it is often local, for example 127.0.0.1).
 */
internal class PublicAddressDns(
        private val targetHost: String,
        private val delegate: Dns = Dns.SYSTEM
) : Dns {

    override fun lookup(hostname: String): List<InetAddress> {
        val addresses = delegate.lookup(hostname)
        if (hostname.equals(targetHost, ignoreCase = true) && !addresses.all { isPublic(it) })
            throw UnknownHostException("External resource host resolves to a local address")
        return addresses
    }

    companion object {
        /**
         * False for loopback, private, link-local, unique-local, carrier-grade NAT, unspecified,
         * multicast and reserved addresses, including IPv4 addresses embedded in IPv6
         * (IPv4-mapped, IPv4-compatible and the NAT64 well-known prefix).
         */
        fun isPublic(address: InetAddress): Boolean {
            val b = address.address.map { it.toInt() and 0xff }
            return when (address) {
                is Inet4Address -> isPublicV4(b)
                is Inet6Address -> isPublicV6(b)
                else -> false
            }
        }

        private fun isPublicV4(b: List<Int>): Boolean = when {
            b[0] == 0 -> false                                  // 0.0.0.0/8 "this network"
            b[0] == 10 -> false                                 // 10.0.0.0/8 private
            b[0] == 100 && b[1] in 64..127 -> false             // 100.64.0.0/10 carrier-grade NAT
            b[0] == 127 -> false                                // 127.0.0.0/8 loopback
            b[0] == 169 && b[1] == 254 -> false                 // 169.254.0.0/16 link-local
            b[0] == 172 && b[1] in 16..31 -> false              // 172.16.0.0/12 private
            b[0] == 192 && b[1] == 168 -> false                 // 192.168.0.0/16 private
            b[0] >= 224 -> false                                // multicast, reserved, broadcast
            else -> true
        }

        private fun isPublicV6(b: List<Int>): Boolean {
            val embeddedV4 = when {
                // ::/96 (IPv4-compatible, also :: and ::1) and ::ffff:0:0/96 (IPv4-mapped)
                (0..9).all { b[it] == 0 } && ((b[10] == 0 && b[11] == 0) || (b[10] == 0xff && b[11] == 0xff)) -> true
                // 64:ff9b::/96 NAT64 well-known prefix
                b[0] == 0 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && (4..11).all { b[it] == 0 } -> true
                else -> false
            }
            if (embeddedV4)
                return isPublicV4(b.subList(12, 16))
            return when {
                (b[0] and 0xfe) == 0xfc -> false                  // fc00::/7 unique local
                b[0] == 0xfe && (b[1] and 0xc0) == 0x80 -> false  // fe80::/10 link-local
                b[0] == 0xfe && (b[1] and 0xc0) == 0xc0 -> false  // fec0::/10 site-local (deprecated)
                b[0] == 0xff -> false                             // ff00::/8 multicast
                else -> true
            }
        }
    }
}
