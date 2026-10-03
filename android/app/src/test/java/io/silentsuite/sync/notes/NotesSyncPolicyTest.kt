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

    // ---- a forced collection refresh (after an invitation is accepted) ----

    @Test fun `a forced refresh starts a forced run and survives every merge into a pending run`() {
        val (forced, decision) = policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "accept", forceRefresh = true)
        assertEquals(Decision.START, decision)
        assertTrue(forced.forceRefresh)
        val (afterPiggyback, _) = policy.request(forced, Trigger.PIGGYBACK, null)
        assertTrue("a later automatic request never clears it", afterPiggyback.forceRefresh)

        val pending = policy.request(NotesSyncPolicy.Slot(), Trigger.SCREEN_OPEN, null).first
        assertFalse(pending.forceRefresh)
        val (merged, mergedDecision) = policy.request(pending, Trigger.MANUAL, "accept", forceRefresh = true)
        assertEquals(Decision.COALESCED, mergedDecision)
        assertTrue("a forced request upgrades the pending run", merged.forceRefresh)
        assertEquals("accept", merged.queuedRequestId)
    }

    @Test fun `a forced refresh during a run always queues a forced follow-up, even from an automatic trigger`() {
        val running = policy.started(policy.request(NotesSyncPolicy.Slot(), Trigger.SCREEN_OPEN, null).first)
        val (afterUser, userDecision) = policy.request(running, Trigger.MANUAL, "accept", forceRefresh = true)
        assertEquals(Decision.COALESCED, userDecision)
        assertTrue(afterUser.rerun)
        assertTrue(afterUser.forceRefresh)
        val (next, runAgain) = policy.finished(afterUser)
        assertTrue(runAgain)
        assertEquals(State.PENDING, next.state)
        assertTrue("the follow-up run lists from scratch", next.forceRefresh)

        // The running run may already be past its listing, so a forced request is never dropped.
        val (afterAutomatic, automaticDecision) = policy.request(running, Trigger.PIGGYBACK, null, forceRefresh = true)
        assertEquals(Decision.COALESCED, automaticDecision)
        assertTrue(afterAutomatic.rerun)
        assertTrue(afterAutomatic.forceRefresh)
        assertFalse("an automatic request does not bypass Wi-Fi-only", afterAutomatic.manual)

        // The same while a user's run is in progress: the follow-up is still automatic.
        val runningManual = policy.started(policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "sync-now").first)
        val (automaticFollowUp, _) = policy.finished(policy.request(runningManual, Trigger.PIGGYBACK, null, forceRefresh = true).first)
        assertTrue(automaticFollowUp.forceRefresh)
        assertFalse("it does not inherit the running run's Wi-Fi-only bypass", automaticFollowUp.manual)
        assertNull("nor its request id, which that run closes", automaticFollowUp.queuedRequestId)

        // A user follow-up that was already queued keeps its request id and bypass.
        val queued = policy.request(runningManual, Trigger.TOGGLE, "toggle").first
        val (userFollowUp, _) = policy.finished(policy.request(queued, Trigger.PIGGYBACK, null, forceRefresh = true).first)
        assertTrue(userFollowUp.forceRefresh)
        assertTrue(userFollowUp.manual)
        assertEquals("toggle", userFollowUp.queuedRequestId)
    }

    @Test fun `a run takes its forced refresh when it starts, so only a later one reaches the follow-up`() {
        val forced = policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "accept", forceRefresh = true).first
        val running = policy.started(forced)
        assertFalse("the running run took it; the slot now collects for a follow-up", running.forceRefresh)
        val (afterScreen, _) = policy.request(running, Trigger.SCREEN, null)
        val (next, _) = policy.finished(afterScreen)
        assertFalse("a plain follow-up is not forced", next.forceRefresh)
    }

    @Test fun `a forced run that did not finish its listing leaves the force owed to the next run`() {
        val running = policy.started(policy.request(NotesSyncPolicy.Slot(), Trigger.MANUAL, "accept", forceRefresh = true).first)
        val (idle, runAgain) = policy.finished(running, forcedRefreshOwed = true)
        assertFalse("nothing is scheduled by itself, so a failure cannot loop", runAgain)
        assertEquals(State.IDLE, idle.state)
        assertTrue(idle.forceRefresh)
        val (next, decision) = policy.request(idle, Trigger.SCREEN_OPEN, null)
        assertEquals(Decision.START, decision)
        assertTrue("the next run of any kind lists from scratch", next.forceRefresh)

        val withFollowUp = policy.request(running, Trigger.SCREEN, null).first
        assertTrue("an owed force also joins a follow-up already queued",
            policy.finished(withFollowUp, forcedRefreshOwed = true).first.forceRefresh)
        assertEquals("a run that finished its listing owes nothing", NotesSyncPolicy.Slot(), policy.finished(running).first)
    }
}
