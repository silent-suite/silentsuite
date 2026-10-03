package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.NotesSyncRunner.NotebooksOutcome
import io.silentsuite.sync.notes.edit.NotePushPolicy.FailureKind
import io.silentsuite.sync.notes.edit.NotePushStep
import io.silentsuite.sync.syncadapter.SyncStatusStore.FailureCategory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What a Notes run records once its push step and its fetch are done (design 3.3 and 3.8). */
class NotesSyncRunnerPushStatusTest {
    private fun push(failure: FailureKind? = null, carried: String? = null, pushed: Int = 1) =
        NotePushStep.Result(NotePushStep.Ended.COMPLETED, pushed, held = 0, conflicts = emptyMap(), failure = failure, carriedFailure = carried)

    @Test fun `a run with nothing to push records what its fetch did`() {
        assertNull(NotesSyncRunner.runFailure(null, NotebooksOutcome.ALL_FETCHED))
        assertEquals(FailureCategory.UNKNOWN, NotesSyncRunner.runFailure(null, NotebooksOutcome.SOME_FAILED))
    }

    @Test fun `a push and a fetch that both worked record success`() {
        assertNull(NotesSyncRunner.runFailure(push(), NotebooksOutcome.ALL_FETCHED))
        assertNull(NotesSyncRunner.runFailure(push(pushed = 0), NotebooksOutcome.ALL_FETCHED))
    }

    @Test fun `the push step's own failure comes first`() {
        assertEquals(FailureCategory.NETWORK, NotesSyncRunner.runFailure(push(FailureKind.TRANSIENT), NotebooksOutcome.ALL_FETCHED))
        assertEquals(FailureCategory.NETWORK,
            NotesSyncRunner.runFailure(push(FailureKind.TRANSIENT, carried = FailureKind.LOCAL.name), NotebooksOutcome.SOME_FAILED))
    }

    @Test fun `a failure carried from an entry in backoff keeps the run from recording success`() {
        assertEquals(FailureCategory.NETWORK, NotesSyncRunner.runFailure(push(carried = FailureKind.TRANSIENT.name), NotebooksOutcome.ALL_FETCHED))
        // A notebook that failed in this run is the run's own failure, so it comes before the carried one.
        assertEquals(FailureCategory.UNKNOWN, NotesSyncRunner.runFailure(push(carried = FailureKind.LOCAL.name), NotebooksOutcome.SOME_FAILED))
    }

    @Test fun `a pending store that cannot be read is a storage failure, whatever the fetch did`() {
        assertEquals(FailureCategory.STORAGE, NotesSyncRunner.runFailure(NotesSyncRunner.unreadableStore(), NotebooksOutcome.ALL_FETCHED))
        assertEquals(FailureCategory.STORAGE, NotesSyncRunner.runFailure(NotesSyncRunner.unreadableStore(), NotebooksOutcome.SOME_FAILED))
    }

    @Test fun `push failures map to the categories the dashboard shows`() {
        assertEquals(FailureCategory.NETWORK, NotesSyncRunner.pushFailureCategory(FailureKind.TRANSIENT.name))
        assertEquals(FailureCategory.AUTHENTICATION, NotesSyncRunner.pushFailureCategory(FailureKind.AUTHENTICATION.name))
        assertEquals(FailureCategory.STORAGE, NotesSyncRunner.pushFailureCategory(FailureKind.LOCAL.name))
        for (kind in listOf(FailureKind.READ_ONLY, FailureKind.LOST_ACCESS, FailureKind.REJECTED)) {
            assertEquals(kind.name, FailureCategory.UNKNOWN, NotesSyncRunner.pushFailureCategory(kind.name))
        }
        // A name an older or newer build wrote is not trusted to mean anything.
        assertEquals(FailureCategory.UNKNOWN, NotesSyncRunner.pushFailureCategory("SOMETHING_ELSE"))
    }

    @Test fun `no push failure reads as a missing Android permission`() {
        // PERMISSION makes the dashboard offer "Allow access", which a server 403 must never do.
        for (kind in FailureKind.values()) {
            assertNotEquals(kind.name, FailureCategory.PERMISSION, NotesSyncRunner.pushFailureCategory(kind.name))
        }
    }
}
