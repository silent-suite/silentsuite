package at.bitfire.cert4android

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.ServiceTestRule
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.TlsVersion
import okhttp3.internal.tls.OkHostnameVerifier
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.conscrypt.Conscrypt
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Runs against the rebuilt Conscrypt AAR in CI. Besides loading the provider, it makes real TLS
 * connections to a local MockWebServer through the composition io.silentsuite.sync.HttpClient
 * uses: a "TLS" SSLContext from the default provider, CustomCertManager (or a platform PKIX
 * trust manager) as trust manager, and CustomCertManager's hostname verifier wrapped around
 * OkHostnameVerifier. Everything stays on localhost; no external endpoint is contacted.
 */
@RunWith(AndroidJUnit4::class)
class ConscryptProviderRuntimeTest {

    @JvmField @Rule val services = ServiceTestRule()

    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private lateinit var service: ICustomCertService

    @Before fun setUp() {
        // Binding creates CustomCertService, whose class initialiser installs Conscrypt at
        // priority 1, as it does in the app.
        service = ICustomCertService.Stub.asInterface(
            services.bindService(Intent(context, CustomCertService::class.java))
        )
        service.resetCertificates()
    }

    @After fun tearDown() {
        service.resetCertificates()
    }

    @Test
    fun providerLoadsAndCreatesTlsContext() {
        val version = Conscrypt.version()
        assertEquals(2, version.major())
        assertEquals(9, version.minor())
        assertEquals(0, version.patch())

        val provider = Conscrypt.newProvider()
        val context = SSLContext.getInstance("TLS", provider)
        context.init(null, null, null)
        val engine = context.createSSLEngine()
        try {
            assertSame(provider, context.provider)
            assertTrue(engine.enabledProtocols.isNotEmpty())
            assertTrue(engine.enabledCipherSuites.isNotEmpty())
        } finally {
            engine.closeOutbound()
        }
    }

    @Test
    fun unacceptedCertificateIsRejectedByCustomTrust() {
        // The hostname matches, so only the trust manager can reject this certificate.
        val leaf = selfSigned("localhost")
        withManager(trustSystemCerts = true) { manager ->
            serve(leaf) { server ->
                val failure = assertThrows(SSLHandshakeException::class.java) {
                    get(client(manager, manager.hostnameVerifier(OkHostnameVerifier)), server)
                }
                assertTrue(
                    "handshake failed for a reason other than certificate validation: $failure",
                    generateSequence<Throwable>(failure) { it.cause }.any { it is CertificateException }
                )
            }
        }
    }

    @Test
    fun acceptedCertificateConnectsDespiteHostnameMismatch() {
        val leaf = selfSigned("silentsuite.invalid")
        accept(leaf.certificate)
        withManager(trustSystemCerts = false) { manager ->
            serve(leaf) { server ->
                val handshake = get(client(manager, manager.hostnameVerifier(OkHostnameVerifier)), server)
                assertTrue(handshake.tlsVersion in setOf(TlsVersion.TLS_1_2, TlsVersion.TLS_1_3))
            }
        }
    }

    @Test
    fun trustedChainWithMatchingHostnameConnects() {
        val root = rootCertificate()
        val leaf = issued(root, "localhost")
        withManager(trustSystemCerts = false) { manager ->
            serve(leaf) { server ->
                val handshake = get(client(trusting(root), manager.hostnameVerifier(OkHostnameVerifier)), server)
                assertEquals(leaf.certificate, handshake.peerCertificates.first())
            }
        }
    }

    @Test
    fun trustedChainWithOtherHostnameIsRejectedWithoutAcceptance() {
        val root = rootCertificate()
        val leaf = issued(root, "silentsuite.invalid")
        withManager(trustSystemCerts = false) { manager ->
            serve(leaf) { server ->
                assertThrows(SSLPeerUnverifiedException::class.java) {
                    get(client(trusting(root), manager.hostnameVerifier(OkHostnameVerifier)), server)
                }
            }
        }
    }

    // helpers

    private fun selfSigned(host: String) = HeldCertificate.Builder()
        .commonName(host)
        .addSubjectAlternativeName(host)
        .build()

    private fun rootCertificate() = HeldCertificate.Builder()
        .commonName("SilentSuite test root")
        .certificateAuthority(0)
        .build()

    private fun issued(root: HeldCertificate, host: String) = HeldCertificate.Builder()
        .commonName(host)
        .addSubjectAlternativeName(host)
        .signedBy(root)
        .build()

    /** A PKIX trust manager from the default provider that trusts only [root]. */
    private fun trusting(root: HeldCertificate): X509TrustManager {
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType())
        keyStore.load(null, null)
        keyStore.setCertificateEntry("root", root.certificate)
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(keyStore)
        return factory.trustManagers.first() as X509TrustManager
    }

    /** Mirrors HttpClient.Builder.build(): no client key, one trust manager, the given verifier. */
    private fun client(trustManager: X509TrustManager, verifier: HostnameVerifier): OkHttpClient {
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf(trustManager), null)
        assertEquals("Conscrypt", sslContext.provider.name)
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(verifier)
            .build()
    }

    private fun serve(certificate: HeldCertificate, block: (MockWebServer) -> Unit) {
        val server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
        server.enqueue(MockResponse().setBody("ok"))
        server.start(InetAddress.getByName("localhost"), 0)
        try {
            block(server)
        } finally {
            server.shutdown()
        }
    }

    private fun get(client: OkHttpClient, server: MockWebServer): okhttp3.Handshake {
        val url = server.url("/").newBuilder().host("localhost").build()
        client.newCall(Request.Builder().url(url).build()).execute().use { response ->
            assertEquals(200, response.code)
            assertEquals("ok", response.body!!.string())
            return requireNotNull(response.handshake)
        }
    }

    private fun withManager(trustSystemCerts: Boolean, block: (CustomCertManager) -> Unit) {
        val manager = CustomCertManager(context, interactive = false, trustSystemCerts = trustSystemCerts)
        try {
            block(manager)
        } finally {
            manager.close()
        }
    }

    /**
     * Accepts [certificate] through the same foreground decision and service command as the app.
     * The decision screen itself is intercepted rather than shown: this library's test APK has no
     * AppCompat theme, and only the generation the service puts into its intent is needed.
     */
    private fun accept(certificate: X509Certificate) {
        val launched = LinkedBlockingQueue<Intent>()
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? =
                if (intent.component?.className == TrustCertificateActivity::class.java.name) {
                    launched.add(intent)
                    Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null)
                } else
                    null
        }
        instrumentation.addMonitor(monitor)
        val callback = Callback()
        val intent = try {
            service.checkTrusted(certificate.encoded, true, true, callback)
            launched.poll(15, TimeUnit.SECONDS)
        } finally {
            instrumentation.removeMonitor(monitor)
        }
        requireNotNull(intent) { "Foreground certificate decision did not start TrustCertificateActivity" }
        val generation = requireNotNull(intent.getStringExtra(CustomCertService.EXTRA_DECISION_GENERATION))
        context.startService(Intent(context, CustomCertService::class.java).apply {
            action = CustomCertService.CMD_CERTIFICATION_DECISION
            putExtra(CustomCertService.EXTRA_CERTIFICATE, certificate.encoded)
            putExtra(CustomCertService.EXTRA_DECISION_GENERATION, generation)
            putExtra(CustomCertService.EXTRA_TRUSTED, true)
        })
        assertTrue("certificate decision was not accepted", callback.accepted.await(5, TimeUnit.SECONDS))
    }

    private class Callback : IOnCertificateDecision.Stub() {
        val accepted = CountDownLatch(1)
        override fun accept() = accepted.countDown()
        override fun reject() {}
    }
}
