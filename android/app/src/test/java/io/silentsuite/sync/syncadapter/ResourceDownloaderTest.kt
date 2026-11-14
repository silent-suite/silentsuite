package io.silentsuite.sync.syncadapter

import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.syncadapter.ContactsSyncManager.ResourceDownloader
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import java.util.logging.Level
import java.util.logging.Logger

class ResourceDownloaderTest {
    private lateinit var server: MockWebServer
    private val client = OkHttpClient.Builder().followRedirects(false).build()

    @Before
    fun start() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
    }

    private fun bytes(size: Int) = ByteArray(size) { (it % 251).toByte() }

    /** Against the local test server, so the public-address check is off here. */
    private fun fetch(maxBytes: Long = 1024, callTimeoutMillis: Long = 5_000) =
        ResourceDownloader.fetchBounded(client, server.url("/photo.jpg"), maxBytes, callTimeoutMillis,
                publicAddressesOnly = false)

    @Test
    fun localHostIsRefusedWithoutARequest() {
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(64))))
        // server.url() names the loopback host; the default check must stop it before connecting.
        assertNull(ResourceDownloader.fetchBounded(client, server.url("/photo.jpg")))
        val literal = server.url("/photo.jpg").newBuilder().host("127.0.0.1").build()
        assertNull(ResourceDownloader.fetchBounded(client, literal))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun throughAProxyTheHostIsResolvedAndCheckedFirst() {
        // The test server acts as the user's HTTP proxy, which resolves photo hosts itself.
        val dns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> = when (hostname) {
                "photos.example" -> listOf(InetAddress.getByName("93.184.216.34"))
                "local.example" -> listOf(InetAddress.getByName("10.0.0.1"))
                "mixed.example" -> listOf(InetAddress.getByName("93.184.216.34"), InetAddress.getByName("::1"))
                "unknown.example" -> throw UnknownHostException(hostname)
                else -> Dns.SYSTEM.lookup(hostname)
            }
        }
        val proxied = client.newBuilder().proxy(server.toProxyAddress()).dns(dns).build()

        for (host in listOf("local.example", "mixed.example", "unknown.example"))
            assertNull(host, ResourceDownloader.fetchBounded(proxied, "http://$host/photo.jpg".toHttpUrl()))
        assertEquals(0, server.requestCount)

        val photo = bytes(64)
        server.enqueue(MockResponse().setBody(Buffer().write(photo)))
        assertArrayEquals(photo, ResourceDownloader.fetchBounded(proxied, "http://photos.example/photo.jpg".toHttpUrl()))
        assertEquals("GET http://photos.example/photo.jpg HTTP/1.1", server.takeRequest().requestLine)
    }

    /** Resolves every photo host to a public address after [delayMillis]; other names normally. */
    private fun slowDns(delayMillis: Long) = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            if (hostname != "photos.example")
                return Dns.SYSTEM.lookup(hostname)
            Thread.sleep(delayMillis)
            return listOf(InetAddress.getByName("93.184.216.34"))
        }
    }

    @Test
    fun aSlowProxiedHostCheckIsCutOffByTheDeadline() {
        val proxied = client.newBuilder().proxy(server.toProxyAddress()).dns(slowDns(10_000)).build()
        val started = System.nanoTime()
        assertNull(ResourceDownloader.fetchBounded(proxied, "http://photos.example/photo.jpg".toHttpUrl(),
                callTimeoutMillis = 500))
        val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("took $elapsedMillis ms", elapsedMillis < 3_000)
        assertEquals(0, server.requestCount)
    }

    @Test
    fun theHostCheckUsesUpPartOfTheCallBudget() {
        var callTimeoutMillis = -1L
        val proxied = client.newBuilder()
                .proxy(server.toProxyAddress())
                .dns(slowDns(1_000))
                .addInterceptor { chain ->
                    callTimeoutMillis = TimeUnit.NANOSECONDS.toMillis(chain.call().timeout().timeoutNanos())
                    chain.proceed(chain.request())
                }
                .build()
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(64))))
        assertArrayEquals(bytes(64), ResourceDownloader.fetchBounded(proxied, "http://photos.example/photo.jpg".toHttpUrl(),
                callTimeoutMillis = 10_000))
        assertTrue("call timeout $callTimeoutMillis ms", callTimeoutMillis in 1..9_000)
    }

    @Test
    fun localLiteralsAreRecognisedWithoutALookup() {
        for (host in listOf("127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1",
                "::1", "fe80::1", "fc00::1", "::ffff:a00:1"))
            assertTrue(host, ResourceDownloader.isLocalLiteral(host))
        for (host in listOf("93.184.216.34", "2606:4700::1", "photos.example", "999.1.1.1"))
            assertFalse(host, ResourceDownloader.isLocalLiteral(host))
    }

    @Test
    fun photoDownloadsAlwaysCheckAddressesAndDoNotLogTheUrl() {
        val downloader = File("src/main/java/io/silentsuite/sync/syncadapter/ContactsSyncManager.kt").readText()
        // Only tests turn the check off.
        assertFalse(downloader.contains("publicAddressesOnly = false"))
        assertTrue(Regex("""dns\(PublicAddressDns\(url\.host, client\.dns\)\)""").containsMatchIn(downloader))
        assertTrue(downloader.contains(".followRedirects(false)"))
        val download = downloader.substringAfter("override fun download(url: String").substringBefore("companion object")
        assertFalse(Regex("""Logger\.log\.[a-z]+\([^)]*\burl\b""").containsMatchIn(download))

        val contact = File("../vcard4android/src/main/java/at/bitfire/vcard4android/Contact.kt").readText()
        val photo = contact.substringAfter("is Photo ->").substringBefore("it.download(url")
        assertTrue(photo.contains("Constants.log.info(\"Downloading photo\")"))
        assertFalse(photo.contains("\$url"))
    }

    @Test
    fun successfulResponseWithinLimitIsReturned() {
        val photo = bytes(1024)
        server.enqueue(MockResponse().setBody(Buffer().write(photo)))
        assertArrayEquals(photo, fetch())
    }

    @Test
    fun nonSuccessResponseBodyIsIgnored() {
        for (code in listOf(302, 403, 404, 500)) {
            server.enqueue(MockResponse().setResponseCode(code).setBody(Buffer().write(bytes(64))))
            assertNull("HTTP $code", fetch())
        }
    }

    @Test
    fun declaredOversizedBodyIsRejected() {
        server.enqueue(MockResponse().setBody(Buffer().write(bytes(1025))))
        assertNull(fetch())
    }

    @Test
    fun undeclaredOversizedBodyIsRejected() {
        // Chunked: no Content-Length, so the cap has to apply while reading.
        server.enqueue(MockResponse().setChunkedBody(Buffer().write(bytes(64 * 1024)), 512))
        assertNull(fetch())
    }

    @Test
    fun slowBodyIsCutOffByTheCallDeadline() {
        // About 4 s to deliver in full; read timeouts alone would never trip on it.
        server.enqueue(MockResponse()
                .setBody(Buffer().write(bytes(1024)))
                .throttleBody(64, 250, TimeUnit.MILLISECONDS))
        val started = System.nanoTime()
        assertNull(fetch(callTimeoutMillis = 500))
        val elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertTrue("took $elapsedMillis ms", elapsedMillis < 3_000)
    }

    @Test
    fun networkLoggingCanBeLeftOffEvenWhenVerbose() {
        val verbose = Logger.getAnonymousLogger().apply { level = Level.FINEST }
        fun hasLogging(networkLogging: Boolean) =
                HttpClient.Builder(null, null, verbose, networkLogging = networkLogging).build().use { client ->
                    client.okHttpClient.interceptors.any { it is HttpLoggingInterceptor }
                }
        assertTrue(hasLogging(networkLogging = true))
        assertFalse(hasLogging(networkLogging = false))
    }

    @Test
    fun photoClientIsNonInteractiveAndUnlogged() {
        val main = File("src/main/java/io/silentsuite/sync")
        val downloader = File(main, "syncadapter/ContactsSyncManager.kt").readText()
        assertTrue(Regex("""HttpClient\.Builder\(\s*context\s*,\s*interactiveCertificates\s*=\s*false\s*,\s*networkLogging\s*=\s*false\s*\)""")
                .containsMatchIn(downloader))
        // The flag must reach cert4android, where false rejects unknown certificates without waiting.
        val builder = File(main, "HttpClient.kt").readText()
        assertTrue(Regex("""CustomCertManager\(\s*context\s*,\s*interactiveCertificates\s*,""").containsMatchIn(builder))
    }

    @Test
    fun nonInteractiveCheckDoesNotJoinAPendingPrompt() {
        // cert4android has no unit-test run in CI, so this checks its source: when a decision for the
        // certificate is already pending, a non-interactive request leaves the lock with a rejection
        // before it could be added to the waiters.
        val service = File("../cert4android/src/main/java/at/bitfire/cert4android/CustomCertService.kt").readText()
        val pendingBranch = Regex("""pendingDecisions\[cert]\?\.let \{ pending ->(.*?)\n\s*}\n""", RegexOption.DOT_MATCHES_ALL)
                .find(service)?.groupValues?.get(1) ?: throw AssertionError("pending-decision branch not found")
        val code = pendingBranch.replace(Regex("//[^\n]*"), "")
        val reject = Regex("""if \(!interactive\)\s*return@synchronized false""").find(code)
                ?: throw AssertionError("non-interactive request is not rejected in the pending branch")
        val join = code.indexOf("pending.callbacks += callback")
        assertTrue(join >= 0)
        assertTrue(reject.range.first < join)
    }
}
