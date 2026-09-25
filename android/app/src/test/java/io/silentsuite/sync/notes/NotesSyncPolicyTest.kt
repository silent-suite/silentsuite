package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.NotesSyncPolicy.Decision
import io.silentsuite.sync.notes.NotesSyncPolicy.State
import io.silentsuite.sync.notes.NotesSyncPolicy.Trigger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesSyncPolicyTest {
    private val policy = NotesSyncPolicy()

    @Test fun `an idle account starts one pending run that carries the request id and manual flag`() {
        val (manual, decision) = policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "request-1")
        assertEquals(Decision.START, decision)
        assertEquals(State.PENDING, manual.state)
        assertEquals("request-1", manual.queuedRequestId)
        assertTrue(manual.manual)

        val (piggyback, piggybackDecision) = policy.request(NotesSyncPolicy.Slot(), Trigger.PIGGYBACK, null)
        assertEquals(Decision.START, piggybackDecision)
        assertNull(piggyback.queuedRequestId)
        assertFalse("piggyback runs honor the Wi-Fi-only restriction", piggyback.manual)

        val (screenOpen, _) = policy.request(NotesSyncPolicy.Slot(), Trigger.SCREEN_OPEN, null)
        assertFalse("opening the screen is automatic, not a sync gesture", screenOpen.manual)
        assertTrue("pull to refresh is a sync gesture", policy.request(NotesSyncPolicy.Slot(), Trigger.SCREEN, null).first.manual)
    }

    @Test fun `adapters finishing together collapse into the pending run and adopt the newest request`() {
        val pending = policy.request(NotesSyncPolicy.Slot(), Trigger.PIGGYBACK, null).first
        val (afterSecondAdapter, first) = policy.request(pending, Trigger.PIGGYBACK, null)
        assertEquals(Decision.COALESCED, first)
        assertEquals(State.PENDING, afterSecondAdapter.state)
        assertFalse(afterSecondAdapter.manual)

        val (afterManual, second) = policy.request(afterSecondAdapter, Trigger.MANUAL, "manual-request")
        assertEquals(Decision.COALESCED, second)
        assertEquals("manual-request", afterManual.queuedRequestId)
        assertTrue("a user request upgrades the pending run to manual", afterManual.manual)

        val (afterScreen, third) = policy.request(afterManual, Trigger.SCREEN, null)
        assertEquals(Decision.COALESCED, third)
        assertEquals("a request without an id never drops the queued request evidence", "manual-request", afterScreen.queuedRequestId)
    }

    @Test fun `a running sync drops piggybacks and queues exactly one user follow-up`() {
        val running = policy.started(policy.request(NotesSyncPolicy.Slot(), Trigger.SCREEN, null).first)
        assertEquals(State.RUNNING, running.state)

        val (afterPiggyback, dropped) = policy.request(running, Trigger.PIGGYBACK, null)
        assertEquals(Decision.DROPPED, dropped)
        assertFalse(afterPiggyback.rerun)
        assertEquals(Decision.DROPPED, policy.request(running, Trigger.SCREEN_OPEN, null).second)

        val (afterManual, coalesced) = policy.request(afterPiggyback, Trigger.MANUAL, "manual-request")
        assertEquals(Decision.COALESCED, coalesced)
        assertTrue(afterManual.rerun)
        val (afterSecondManual, again) = policy.request(afterManual, Trigger.TOGGLE, "toggle-request")
        assertEquals(Decision.COALESCED, again)
        assertTrue("two user requests still queue one rerun", afterSecondManual.rerun)
        assertEquals("toggle-request", afterSecondManual.queuedRequestId)

        val (next, runAgain) = policy.finished(afterSecondManual)
        assertTrue(runAgain)
        assertEquals(State.PENDING, next.state)
        assertEquals("toggle-request", next.queuedRequestId)
        assertTrue(next.manual)
        assertFalse(next.rerun)
    }

    @Test fun `finishing without a rerun and cancelling both return to idle`() {
        val running = policy.started(policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "request").first)
        val (idle, runAgain) = policy.finished(running)
        assertFalse(runAgain)
        assertEquals(NotesSyncPolicy.Slot(), idle)
        assertEquals(NotesSyncPolicy.Slot(), policy.cancelled())
        assertEquals("finishing a slot that never ran is a no-op", NotesSyncPolicy.Slot() to false, policy.finished(NotesSyncPolicy.Slot()))
    }

    @Test fun `only a pending slot can start`() {
        val result = runCatching { policy.started(NotesSyncPolicy.Slot()) }
        assertTrue(result.exceptionOrNull() is IllegalStateException)
    }
}
