package io.silentsuite.sync.notes.edit

import com.etebase.client.exceptions.ConflictException
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.exceptions.HttpException
import com.etebase.client.exceptions.MsgPackException
import com.etebase.client.exceptions.NotFoundException
import com.etebase.client.exceptions.PermissionDeniedException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.notes.edit.NotePushPolicy.ConflictOutcome
import io.silentsuite.sync.notes.edit.NotePushPolicy.FailureKind
import io.silentsuite.sync.notes.edit.NotePushPolicy.ServerCopy
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.io.InterruptedIOException

class NotePushPolicyTest {
    private fun upsert(revision: String, sent: List<String> = emptyList(), isCreate: Boolean = false) =
        PendingEntry("n", "b", PendingEntry.State.UPSERT, 1, revision, isCreate, sent, blob = ByteArray(0))

    private fun delete(revision: String, sent: List<String> = emptyList()) =
        PendingEntry("n", "b", PendingEntry.State.DELETE, 1, revision, false, sent, blob = ByteArray(0))

    // ---- the conflict table (design section 3.4) ----

    @Test fun `our own landed upload with nothing newer is done`() {
        // Spike 3a: the response was lost, the upload had landed, and the resend conflicts with it.
        assertEquals(ConflictOutcome.DONE, NotePushPolicy.decide(upsert("r1", listOf("r1")), null, ServerCopy("r1", false)))
    }

    @Test fun `our own landed upload with a newer save is rebased`() {
        assertEquals(ConflictOutcome.REBASE, NotePushPolicy.decide(upsert("r2", listOf("r1", "r2")), null, ServerCopy("r1", false)))
    }

    @Test fun `a create whose first send landed is recognized as ours`() {
        // Spike 3c: a create can conflict with its own landed first send.
        assertEquals(ConflictOutcome.REBASE, NotePushPolicy.decide(upsert("c2", listOf("c1", "c2"), isCreate = true), null, ServerCopy("c1", false)))
    }

    @Test fun `the landed record also counts as ours for saves made on the old base`() {
        assertEquals(ConflictOutcome.REBASE, NotePushPolicy.decide(upsert("r3", listOf("r3")), "r1", ServerCopy("r1", false)))
    }

    @Test fun `our own landed delete is done and a newer delete onto our own edit is rebased`() {
        assertEquals(ConflictOutcome.DONE, NotePushPolicy.decide(delete("d1", listOf("d1")), null, ServerCopy("d1", true)))
        assertEquals(ConflictOutcome.REBASE, NotePushPolicy.decide(delete("d1", listOf("r1", "d1")), null, ServerCopy("r1", false)))
    }

    @Test fun `an edit against an edit made elsewhere keeps both`() {
        assertEquals(ConflictOutcome.KEEP_BOTH, NotePushPolicy.decide(upsert("r2", listOf("r2")), null, ServerCopy("web-1", false)))
    }

    @Test fun `an edit against a delete made elsewhere becomes a new note`() {
        assertEquals(ConflictOutcome.RECREATE_AS_NEW_NOTE, NotePushPolicy.decide(upsert("r2", listOf("r2")), null, ServerCopy("web-del", true)))
    }

    @Test fun `a delete against an edit made elsewhere gives the note back`() {
        assertEquals(ConflictOutcome.RESTORE_SERVER_NOTE, NotePushPolicy.decide(delete("d1", listOf("d1")), null, ServerCopy("web-1", false)))
    }

    @Test fun `a delete against a delete made elsewhere is already done`() {
        // Spike step 5: the server answers this with a conflict too.
        assertEquals(ConflictOutcome.ALREADY_DELETED, NotePushPolicy.decide(delete("d1", listOf("d1")), null, ServerCopy("web-del", true)))
    }

    @Test fun `without the server copy nothing is decided`() {
        assertEquals(ConflictOutcome.RETRY_LATER, NotePushPolicy.decide(upsert("r1", listOf("r1")), null, null))
    }

    @Test fun `held text is never pushed so it is never decided`() {
        val held = PendingEntry("n", "b", PendingEntry.State.HELD, 1, "r", false, held = PendingEntry.Held(HeldReason.READ_ONLY, 1), blob = ByteArray(0))
        assertThrows(IllegalArgumentException::class.java) { NotePushPolicy.decide(held, null, ServerCopy("x", false)) }
    }

    // ---- failures ----

    @Test fun `each server answer maps to its handling`() {
        assertEquals(FailureKind.CONFLICT, NotePushPolicy.classify(ConflictException("Items failed to validate")))
        assertEquals(FailureKind.READ_ONLY, NotePushPolicy.classify(PermissionDeniedException("no write access")))
        assertEquals(FailureKind.LOST_ACCESS, NotePushPolicy.classify(NotFoundException("does not exist")))
        assertEquals(FailureKind.AUTHENTICATION, NotePushPolicy.classify(UnauthorizedException("Invalid token.")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(TemporaryServerErrorException("503")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(ServerErrorException("500")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(ConnectionException("offline")))
        // A raw IOException comes from this device (the pending store, a full disk), not the network.
        assertEquals(FailureKind.LOCAL, NotePushPolicy.classify(IOException("no space left on device")))
        // Statuses without their own exception class, in the binding's own message format.
        assertEquals(FailureKind.REJECTED, NotePushPolicy.classify(HttpException("HTTP error 413! Code: 'too_large'. Detail: ''")))
        assertEquals(FailureKind.REJECTED, NotePushPolicy.classify(HttpException("HTTP error 400! Code: 'bad'. Detail: 'x'")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(HttpException("HTTP error 429! Code: 'throttled'. Detail: ''")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(HttpException("HTTP error 408! Code: ''. Detail: ''")))
        assertEquals(FailureKind.TRANSIENT, NotePushPolicy.classify(HttpException("HTTP error 502! Code: ''. Detail: ''")))
        assertEquals("an unreadable status is retried, not held", FailureKind.TRANSIENT, NotePushPolicy.classify(HttpException("something else")))
        assertEquals("a redirect is not lost access", FailureKind.TRANSIENT, NotePushPolicy.classify(NotFoundException("Got a redirect - should never happen")))
        assertEquals(FailureKind.CANCELLED, NotePushPolicy.classify(InterruptedException()))
        assertEquals(FailureKind.CANCELLED, NotePushPolicy.classify(InterruptedIOException("timeout interrupted")))
        assertEquals("a run that is no longer current is not a failure", FailureKind.CANCELLED, NotePushPolicy.classify(StaleSyncRunException()))
        assertEquals(FailureKind.LOCAL, NotePushPolicy.classify(MsgPackException("encode")))
        assertEquals(FailureKind.LOCAL, NotePushPolicy.classify(EtebaseException("other")))
    }

    @Test fun `only permanent refusals move text to the holding area`() {
        for (kind in listOf(FailureKind.CONFLICT, FailureKind.AUTHENTICATION, FailureKind.TRANSIENT, FailureKind.LOCAL, FailureKind.CANCELLED)) {
            assertFalse(kind.name, NotePushPolicy.needsNotebookCheck(kind))
            assertNull(kind.name, NotePushPolicy.heldReasonFor(kind))
            assertNull(kind.name, NotePushPolicy.heldReasonFor(kind, previousFailure = kind.name))
        }
    }

    @Test fun `a rejection holds text only when the same content was rejected the time before too`() {
        assertFalse(NotePushPolicy.needsNotebookCheck(FailureKind.REJECTED))
        assertNull("one odd answer moves nothing", NotePushPolicy.heldReasonFor(FailureKind.REJECTED))
        assertNull(NotePushPolicy.heldReasonFor(FailureKind.REJECTED, previousFailure = FailureKind.TRANSIENT.name))
        assertEquals(HeldReason.REJECTED, NotePushPolicy.heldReasonFor(FailureKind.REJECTED, previousFailure = FailureKind.REJECTED.name))
    }

    @Test fun `a notebook takes pushes only when it is neither deleted nor read-only`() {
        assertTrue(NotePushPolicy.acceptsWrites(deleted = false, readOnly = false))
        assertFalse(NotePushPolicy.acceptsWrites(deleted = true, readOnly = false))
        assertFalse(NotePushPolicy.acceptsWrites(deleted = false, readOnly = true))
        assertFalse(NotePushPolicy.acceptsWrites(deleted = true, readOnly = true))
    }

    @Test fun `a 403 or 404 holds text only once a fetch of the notebook confirms it`() {
        val found = { readOnly: Boolean, deleted: Boolean -> NotePushPolicy.NotebookCheck.Found(readOnly, deleted) }
        for (kind in listOf(FailureKind.READ_ONLY, FailureKind.LOST_ACCESS)) {
            assertTrue(NotePushPolicy.needsNotebookCheck(kind))
            assertNull("not checked yet", NotePushPolicy.heldReasonFor(kind))
            assertNull("the check itself failed", NotePushPolicy.heldReasonFor(kind, NotePushPolicy.NotebookCheck.Unknown))
            // This server also answers 403 for the whole account; a writable notebook means passing trouble.
            assertNull("the notebook is still writable", NotePushPolicy.heldReasonFor(kind, found(false, false)))
            assertEquals(HeldReason.READ_ONLY, NotePushPolicy.heldReasonFor(kind, found(true, false)))
            assertEquals(HeldReason.NOTEBOOK_DELETED, NotePushPolicy.heldReasonFor(kind, found(false, true)))
            assertEquals(HeldReason.NOTEBOOK_DELETED, NotePushPolicy.heldReasonFor(kind, found(true, true)))
            assertEquals(HeldReason.LOST_ACCESS, NotePushPolicy.heldReasonFor(kind, NotePushPolicy.NotebookCheck.Gone))
        }
    }

    @Test fun `backoff doubles from a minute and stops at six hours`() {
        assertEquals(0L, NotePushPolicy.backoffMillis(0))
        assertEquals(60_000L, NotePushPolicy.backoffMillis(1))
        assertEquals(120_000L, NotePushPolicy.backoffMillis(2))
        assertEquals(240_000L, NotePushPolicy.backoffMillis(3))
        assertEquals(256 * 60_000L, NotePushPolicy.backoffMillis(9))
        assertEquals(NotePushPolicy.BACKOFF_MAX_MILLIS, NotePushPolicy.backoffMillis(10))
        assertEquals(NotePushPolicy.BACKOFF_MAX_MILLIS, NotePushPolicy.backoffMillis(1_000))
    }

    @Test fun `an entry is skipped only inside its backoff window`() {
        val failedTwice = upsert("r1").copy(failureCount = 2, lastFailureAt = 1_000)
        assertTrue(NotePushPolicy.inBackoff(failedTwice, now = 1_000 + 119_999, userInitiated = false))
        assertFalse(NotePushPolicy.inBackoff(failedTwice, now = 1_000 + 120_000, userInitiated = false))
        assertFalse(NotePushPolicy.inBackoff(upsert("r1"), now = 0, userInitiated = false))
        // The clock went back after the failure was recorded: retry rather than wait out the difference.
        assertFalse(NotePushPolicy.inBackoff(failedTwice, now = 500, userInitiated = false))
    }

    @Test fun `a sync the user asked for tries every entry, backoff or not`() {
        val failedOften = upsert("r1").copy(failureCount = 10, lastFailureAt = 1_000)
        assertTrue(NotePushPolicy.inBackoff(failedOften, now = 2_000, userInitiated = false))
        assertFalse(NotePushPolicy.inBackoff(failedOften, now = 2_000, userInitiated = true))
    }

    // ---- conflicted copy title ----

    @Test fun `conflicted copy titles are built from the displayed title and never stack`() {
        val t = { title: String? -> NotePushPolicy.conflictCopyTitle(title, "Untitled", "(conflicted copy)") }
        assertEquals("Groceries (conflicted copy)", t("Groceries"))
        assertEquals("Groceries (conflicted copy)", t("  Groceries  "))
        assertEquals("Untitled (conflicted copy)", t(""))
        assertEquals("Untitled (conflicted copy)", t(null))
        assertEquals("Groceries (conflicted copy)", t("Groceries (conflicted copy)"))
    }
}
