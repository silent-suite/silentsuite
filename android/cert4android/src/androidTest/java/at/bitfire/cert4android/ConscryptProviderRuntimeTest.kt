package at.bitfire.cert4android

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.conscrypt.Conscrypt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import javax.net.ssl.SSLContext

@RunWith(AndroidJUnit4::class)
class ConscryptProviderRuntimeTest {

    @Test
    fun providerLoadsAndCreatesTlsContext() {
        val version = Conscrypt.version()
        assertEquals(2, version.major())
        assertEquals(6, version.minor())
        assertEquals(3, version.patch())

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
}
