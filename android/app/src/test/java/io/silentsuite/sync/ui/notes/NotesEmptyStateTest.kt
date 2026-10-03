package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Test

class NotesEmptyStateTest {
    @Test fun `an empty cache is only called empty after a Notes sync has succeeded`() {
        assertEquals(NotesEmptyState.NOT_SYNCED, NotesEmptyState.of(syncing = false, loadFailed = false, everSynced = false))
        assertEquals(NotesEmptyState.EMPTY, NotesEmptyState.of(syncing = false, loadFailed = false, everSynced = true))
    }

    @Test fun `a running or queued sync shows as syncing whatever came before`() {
        for (loadFailed in listOf(false, true)) for (everSynced in listOf(false, true)) {
            assertEquals(NotesEmptyState.SYNCING, NotesEmptyState.of(syncing = true, loadFailed, everSynced))
        }
    }

    @Test fun `a failed read is reported as a failure, not as no notebooks`() {
        assertEquals(NotesEmptyState.FAILED, NotesEmptyState.of(syncing = false, loadFailed = true, everSynced = true))
        assertEquals(NotesEmptyState.FAILED, NotesEmptyState.of(syncing = false, loadFailed = true, everSynced = false))
    }
}
