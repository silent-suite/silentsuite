package io.silentsuite.sync.notes

import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.EncryptionException
import com.etebase.client.exceptions.MsgPackException
import com.etebase.client.exceptions.NotFoundException
import com.etebase.client.exceptions.PermissionDeniedException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.notes.NotesSyncRunner.NotebookFailure
import io.silentsuite.sync.notes.NotesSyncRunner.NotebooksOutcome
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NotesSyncRunnerNotebookFailureTest {
    @After fun clearInterrupt() {
        Thread.interrupted()
    }

    @Test fun `failures every notebook would share end the run`() {
        assertEquals(NotebookFailure.ABORT_RUN, NotesSyncRunner.notebookFailure(UnauthorizedException("401")))
        // The server answers a read with 403 only for the whole account, never for one notebook.
        assertEquals(NotebookFailure.ABORT_RUN, NotesSyncRunner.notebookFailure(PermissionDeniedException("403")))
        assertEquals(NotebookFailure.ABORT_RUN, NotesSyncRunner.notebookFailure(ConnectionException("offline")))
        assertEquals(NotebookFailure.ABORT_RUN, NotesSyncRunner.notebookFailure(TemporaryServerErrorException("503")))
    }

    @Test fun `a notebook the account lost access to is skipped without failing the run`() {
        // The server answers 404 for a notebook the user is no longer a member of.
        assertEquals(NotebookFailure.LOST_ACCESS, NotesSyncRunner.notebookFailure(NotFoundException("404")))
    }

    @Test fun `a problem with one notebook's data fails only that notebook`() {
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(EncryptionException("bad key")))
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(MsgPackException("bad item")))
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(ServerErrorException("500")))
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(IllegalStateException("cache")))
    }

    @Test fun `one failing notebook does not stop the ones after it, and the run reports the failure`() {
        val fetched = mutableListOf<String>()
        val outcome = NotesSyncRunner.fetchEachNotebook(listOf("a", "broken", "c"), { true }) { notebook ->
            if (notebook == "broken") throw EncryptionException("bad key")
            fetched += notebook
        }
        assertEquals(listOf("a", "c"), fetched)
        assertEquals(NotebooksOutcome.SOME_FAILED, outcome)
    }

    @Test fun `a notebook that is gone is skipped and the others still count as fetched`() {
        val fetched = mutableListOf<String>()
        val outcome = NotesSyncRunner.fetchEachNotebook(listOf("gone", "b"), { true }) { notebook ->
            if (notebook == "gone") throw NotFoundException("404")
            fetched += notebook
        }
        assertEquals(listOf("b"), fetched)
        assertEquals(NotebooksOutcome.ALL_FETCHED, outcome)
    }

    @Test fun `an account-wide failure ends the run at once`() {
        val fetched = mutableListOf<String>()
        val denied = PermissionDeniedException("403")
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "b", "c"), { true }) { notebook ->
                if (notebook == "b") throw denied
                fetched += notebook
            }
            fail("an account-wide failure must propagate")
        } catch (e: PermissionDeniedException) {
            assertSame(denied, e)
        }
        assertEquals(listOf("a"), fetched)
    }

    @Test fun `a replaced account generation stops the run before the next notebook`() {
        val fetched = mutableListOf<String>()
        var current = true
        val outcome = NotesSyncRunner.fetchEachNotebook(listOf("a", "b"), { current }) { notebook ->
            fetched += notebook
            current = false
        }
        assertEquals(listOf("a"), fetched)
        assertEquals(NotebooksOutcome.STALE, outcome)
    }

    @Test fun `cancellation propagates instead of counting as a failed notebook`() {
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "b"), { true }) { throw InterruptedException() }
            fail("cancellation must propagate")
        } catch (_: InterruptedException) {
        }

        // A cancelled run whose error surfaced as some other exception is still a cancellation.
        val fetched = mutableListOf<String>()
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "b"), { true }) { notebook ->
                fetched += notebook
                Thread.currentThread().interrupt()
                throw ServerErrorException("interrupted mid-request")
            }
            fail("an interrupted run must propagate")
        } catch (_: ServerErrorException) {
            assertTrue(Thread.currentThread().isInterrupted)
        }
        assertEquals(listOf("a"), fetched)
    }

    @Test fun `a run that may no longer write stops, instead of counting one failed notebook`() {
        // The guard refused a page write: the account was replaced, the run was cancelled, or
        // Notes was turned off while that notebook's page was in flight.
        val fetched = mutableListOf<String>()
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "b", "c"), { true }) { notebook ->
                if (notebook == "b") throw StaleSyncRunException()
                fetched += notebook
            }
            fail("a stale run must propagate")
        } catch (_: StaleSyncRunException) {
        }
        assertEquals(listOf("a"), fetched)
    }
}
