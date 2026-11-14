package io.silentsuite.sync.syncadapter

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TasksReplayTest {

    @Test fun `outside a listing from the start every item is applied`() {
        assertFalse(replayKeepsStoredRevision(false, false, "a", "a"))
        assertFalse(replayKeepsStoredRevision(false, true, "a", "a"))
    }

    @Test fun `a listing from the start adds a task the list is missing`() {
        assertFalse(replayKeepsStoredRevision(true, false, null, "a"))
    }

    @Test fun `a listing from the start rewrites a task holding another revision`() {
        assertFalse(replayKeepsStoredRevision(true, false, "a", "b"))
    }

    @Test fun `a listing from the start leaves a task holding the listed revision alone`() {
        assertTrue(replayKeepsStoredRevision(true, false, "a", "a"))
    }

    @Test fun `a listing from the start still applies a server deletion`() {
        assertFalse(replayKeepsStoredRevision(true, true, "a", "a"))
    }
}
