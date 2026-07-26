package at.bitfire.cert4android

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TrustCertificateStateTest {
    private fun details(name: String) = TrustCertificateState.Details(name, "issuer", "from", "to", "sha1", "sha256")

    @Test
    fun olderCompletionCannotReplaceNewerRenderedCertificateOrDecision() {
        val state = TrustCertificateState()
        val first = state.begin("generation-a", byteArrayOf(1))!!
        val second = state.begin("generation-b", byteArrayOf(2))!!

        assertNull(state.complete(first, details("A")))
        val screen = state.complete(second, details("B"))!!

        assertTrue(screen.ready)
        assertEquals("B", screen.details!!.issuedFor)
        state.decision()!!.also {
            assertEquals("generation-b", it.generation)
            assertArrayEquals(byteArrayOf(2), it.certificate)
        }
    }

    @Test
    fun decisionsRemainDisabledUntilTheCurrentCertificateIsRendered() {
        val state = TrustCertificateState()
        val request = state.begin("generation-a", byteArrayOf(1))!!

        assertNull(state.decision())
        assertFalse(TrustCertificateState.Screen().ready)
        assertTrue(state.complete(request, details("A"))!!.ready)
    }

    @Test
    fun decisionUsesRenderedSnapshotRatherThanLaterIntentData() {
        val state = TrustCertificateState()
        val request = state.begin("generation-a", byteArrayOf(1))!!
        state.complete(request, details("A"))
        val decision = state.decision()!!

        state.begin("generation-b", byteArrayOf(2))

        assertEquals("generation-a", decision.generation)
        assertArrayEquals(byteArrayOf(1), decision.certificate)
        assertNull(state.decision())
    }

    @Test
    fun missingGenerationOrCertificateFailsClosed() {
        val state = TrustCertificateState()

        assertNull(state.begin(null, byteArrayOf(1)))
        assertNull(state.decision())
        assertNull(state.begin("generation-a", null))
        assertNull(state.decision())
    }
}
