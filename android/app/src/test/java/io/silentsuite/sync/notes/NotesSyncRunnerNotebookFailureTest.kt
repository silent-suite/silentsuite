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
import io.silentsuite.sync.notes.NotesSyncRunner.NotebookStillListedException
import io.silentsuite.sync.notes.NotesSyncRunner.NotebooksOutcome
import io.silentsuite.sync.syncadapter.PagedListingStalledException
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

    @Test fun `a notebook whose listing cannot finish fails only that notebook`() {
        // It is a temporary server error to the adapters, but the server still answers, so the
        // other notebooks are not skipped the way they are for a 503.
        val stalled = PagedListingStalledException("The notebook item listing is not done but repeated a cursor")
        assertTrue(stalled is TemporaryServerErrorException)
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(stalled))

        val fetched = mutableListOf<String>()
        val outcome = NotesSyncRunner.fetchEachNotebook(listOf("a", "stalled", "c"), { true }) { notebook ->
            if (notebook == "stalled") throw stalled
            fetched += notebook
        }
        assertEquals(listOf("a", "c"), fetched)
        assertEquals(NotebooksOutcome.SOME_FAILED, outcome)
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

    // ---- a notes listing that answered 404: the fetch of the notebook itself decides ----

    /** A run's guard: counts its checks, and rejects the run from check number [rejectFrom] on. */
    private class Guard(private val rejectFrom: Int = Int.MAX_VALUE) {
        var checks = 0
            private set

        fun check() {
            if (++checks >= rejectFrom) throw StaleSyncRunException()
        }
    }

    private fun thrownBy(block: () -> Nothing): Throwable = try {
        block()
    } catch (t: Throwable) {
        t
    }

    @Test fun `a notebook its own fetch shows as deleted is lost access, with the listing's own 404`() {
        val notFound = NotFoundException("404")
        val guard = Guard()
        assertSame(notFound, thrownBy { NotesSyncRunner.confirmNotebookGone(notFound, guard::check) { true } })
        assertEquals("checked before the fetch and after it", 2, guard.checks)
        assertEquals(NotebookFailure.LOST_ACCESS, NotesSyncRunner.notebookFailure(notFound))
    }

    @Test fun `a notebook whose own fetch also answers 404 is lost access, with the listing's own 404`() {
        val notFound = NotFoundException("404")
        val guard = Guard()
        val thrown = thrownBy { NotesSyncRunner.confirmNotebookGone(notFound, guard::check) { throw NotFoundException("404 again") } }
        assertSame(notFound, thrown)
        assertEquals(2, guard.checks)
    }

    @Test fun `a notebook that is still there fails alone and the others still sync`() {
        val notFound = NotFoundException("404")
        val guard = Guard()
        val thrown = thrownBy { NotesSyncRunner.confirmNotebookGone(notFound, guard::check) { false } }
        assertTrue("$thrown", thrown is NotebookStillListedException)
        assertSame(notFound, thrown.cause)
        assertEquals(2, guard.checks)
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(thrown as Exception))

        val fetched = mutableListOf<String>()
        val outcome = NotesSyncRunner.fetchEachNotebook(listOf("a", "listed", "c"), { true }) { notebook ->
            if (notebook == "listed") NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard()::check) { false }
            fetched += notebook
        }
        assertEquals(listOf("a", "c"), fetched)
        assertEquals(NotebooksOutcome.SOME_FAILED, outcome)
    }

    @Test fun `a fetch of the notebook that fails for the whole account is passed on, and never as lost access`() {
        val offline = ConnectionException("offline")
        val guard = Guard()
        assertSame(offline, thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), guard::check) { throw offline } })
        assertEquals(2, guard.checks)
        assertEquals(NotebookFailure.ABORT_RUN, NotesSyncRunner.notebookFailure(offline))
    }

    @Test fun `a fetch of the notebook that fails after the run went stale stops the run with nothing counted`() {
        val stale = thrownBy {
            NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) { throw ConnectionException("offline") }
        }
        assertTrue("$stale", stale is StaleSyncRunException)

        val fetched = mutableListOf<String>()
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "checked", "c"), { true }) { notebook ->
                if (notebook == "checked") {
                    NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) {
                        throw ConnectionException("offline")
                    }
                }
                fetched += notebook
            }
            fail("a stale run must propagate")
        } catch (_: StaleSyncRunException) {
        }
        assertEquals(listOf("a"), fetched)
    }

    @Test fun `a fetch of the notebook that fails for this notebook alone is this notebook's failure`() {
        val serverError = ServerErrorException("500")
        assertSame(serverError, thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard()::check) { throw serverError } })
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(serverError))

        // The answer was another collection, or not a notebook.
        val other = IllegalStateException("the server answered with another collection")
        assertSame(other, thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard()::check) { throw other } })
        assertEquals(NotebookFailure.NOTEBOOK_FAILED, NotesSyncRunner.notebookFailure(other))
    }

    @Test fun `a run that is stale before the notebook is fetched does not fetch it`() {
        var fetches = 0
        val stale = thrownBy {
            NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 1)::check) {
                fetches++
                false
            }
        }
        assertTrue("$stale", stale is StaleSyncRunException)
        assertEquals(0, fetches)
    }

    @Test fun `a notebook that is still there after the run went stale records nothing`() {
        val stale = thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) { false } }
        assertTrue("$stale", stale is StaleSyncRunException)
        val gone = thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) { true } }
        assertTrue("$gone", gone is StaleSyncRunException)
    }

    @Test fun `an Error from the fetch of the notebook after the run went stale stops the run with nothing counted`() {
        val stale = thrownBy {
            NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) { throw OutOfMemoryError("test") }
        }
        assertTrue("$stale", stale is StaleSyncRunException)

        val fetched = mutableListOf<String>()
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "checked", "c"), { true }) { notebook ->
                if (notebook == "checked") {
                    NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard(rejectFrom = 2)::check) {
                        throw OutOfMemoryError("test")
                    }
                }
                fetched += notebook
            }
            fail("a stale run must propagate")
        } catch (_: StaleSyncRunException) {
        }
        assertEquals(listOf("a"), fetched)
    }

    @Test fun `an Error from the fetch of the notebook in a current run is passed on as it is`() {
        val error = OutOfMemoryError("test")
        val guard = Guard()
        assertSame(error, thrownBy { NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), guard::check) { throw error } })
        assertEquals("checked before the fetch and after it", 2, guard.checks)

        val fetched = mutableListOf<String>()
        try {
            NotesSyncRunner.fetchEachNotebook(listOf("a", "checked", "c"), { true }) { notebook ->
                if (notebook == "checked") NotesSyncRunner.confirmNotebookGone(NotFoundException("404"), Guard()::check) { throw error }
                fetched += notebook
            }
            fail("an Error must propagate")
        } catch (e: OutOfMemoryError) {
            assertSame(error, e)
        }
        assertEquals(listOf("a"), fetched)
    }
}
