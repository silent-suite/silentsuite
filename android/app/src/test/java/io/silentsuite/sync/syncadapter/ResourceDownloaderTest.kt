package io.silentsuite.sync.syncadapter

import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.syncadapter.ContactsSyncManager.ResourceDownloader
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
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

    private fun fetch(maxBytes: Long = 1024, callTimeoutMillis: Long = 5_000) =
        ResourceDownloader.fetchBounded(client, server.url("/photo.jpg"), maxBytes, callTimeoutMillis)

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
}
