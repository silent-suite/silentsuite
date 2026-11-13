package io.silentsuite.sync.syncadapter

import org.junit.Assert.assertEquals
import org.junit.Test

class CalendarReplayLocalChangeTest {

    @Test fun `outside a re-read every listed item is applied`() {
        for (deleted in listOf(false, true))
            for (pending in listOf(false, true))
                assertEquals(ReplayLocalChange.APPLY, replayLocalChange(false, deleted, pending))
    }

    @Test fun `a re-read applies items without a pending local change`() {
        assertEquals(ReplayLocalChange.APPLY, replayLocalChange(true, false, false))
        assertEquals(ReplayLocalChange.APPLY, replayLocalChange(true, true, false))
    }

    @Test fun `a re-read keeps a pending local change over a listed revision`() {
        assertEquals(ReplayLocalChange.SKIP_APPLY, replayLocalChange(true, false, true))
    }

    @Test fun `a re-read neither applies nor caches a server deletion over a pending local change`() {
        // the cached live revision stays the base of the local change's upload
        assertEquals(ReplayLocalChange.SKIP_APPLY_AND_CACHE, replayLocalChange(true, true, true))
    }
}
