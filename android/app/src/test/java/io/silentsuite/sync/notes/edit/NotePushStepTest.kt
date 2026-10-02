package io.silentsuite.sync.notes.edit

import com.etebase.client.exceptions.ConflictException
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.HttpException
import com.etebase.client.exceptions.NotFoundException
import com.etebase.client.exceptions.PermissionDeniedException
import com.etebase.client.exceptions.ServerErrorException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.notes.edit.NotePushPolicy.FailureKind
import io.silentsuite.sync.notes.edit.NotePushPolicy.NotebookCheck
import io.silentsuite.sync.notes.edit.NotePushStep.Ended
import io.silentsuite.sync.notes.edit.NotePushStep.Notebook
import io.silentsuite.sync.notes.edit.PendingNotesStore.DeleteOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException

/**
 * The push step of design sections 3.3, 3.4 and 3.8, run against a stand-in for the server. Each bound
 * gets a server that misbehaves in exactly the way the bound covers, and a server that behaves, so a
 * bound that fires in an ordinary sequence fails a test.
 *
 * The store and the policy are the real ones. Only [NotePushStep.Remote] is replaced: the stand-in
 * keeps plain text where the app keeps encrypted items, and answers as the test tells it to.
 */
class NotePushStepTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Replaces the target in one step on every platform the tests run on, Windows included. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private val dir by lazy { tmp.newFolder("store") }
    private val store by lazy { PendingNotesStore.open(dir, rename = atomicMove) }

    @After fun reset() {
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.resetForTesting()
        Thread.interrupted()
    }

    // ---- stand-ins ----

    /**
     * What these tests keep in a blob in place of an encrypted item: the note's uid, the revision the
     * item was built on (what the server checks an upload against), its own revision, and the text.
     */
    private data class Item(val uid: String, val base: String?, val revision: String, val deleted: Boolean, val text: String) {
        fun blob(): ByteArray = listOf(uid, base.orEmpty(), revision, deleted.toString(), text).joinToString("\n").toByteArray()
    }

    private fun item(blob: ByteArray): Item =
        String(blob).split("\n", limit = 5).let { Item(it[0], it[1].ifEmpty { null }, it[2], it[3].toBoolean(), it[4]) }

    /**
     * The server. Left alone it makes the project server's checks (design section 2): an upload of the
     * revision it already holds as current is a success, any other upload must be built on its current
     * revision or gets a 409, and fetch(uid) for an item it does not hold is a 500. The switches and
     * the error hooks make it misbehave.
     */
    private class Server {
        val items = HashMap<String, Item>()
        val uploads = mutableListOf<Item>()
        val fetches = mutableListOf<String>()
        val notebookFetches = mutableListOf<String>()

        /** Answers every push with a 409 and changes nothing. */
        var refuseEveryPush = false

        /** Answers fetch(uid) for any uid, known or not, with a copy whose revision no client sent. */
        var inventCopies = false

        /** Takes an upload that passes its checks, and answers it with a 409 all the same. */
        var answerConflictAfterLanding = false

        /** Runs before an upload is checked, for another client's write that gets in first. */
        var beforeUpload: (Item) -> Unit = {}

        /** An error to answer an upload or a fetch(uid) with, in place of the server's own answer. */
        var uploadError: (Item) -> Exception? = { null }
        var fetchError: (String) -> Exception? = { null }

        /** The answer to a fetch of the notebook itself: what it found, or the error to throw. */
        var notebookAnswer: (String) -> Any = { NotebookCheck.Found(readOnly = false, deleted = false) }

        private var invented = 0

        fun transaction(upload: Item) {
            beforeUpload(upload)
            uploads += upload
            uploadError(upload)?.let { throw it }
            if (refuseEveryPush) throw ConflictException("wrong_etag")
            val current = items[upload.uid]
            if (current?.revision == upload.revision) return
            if (current?.revision != upload.base) throw ConflictException("wrong_etag")
            items[upload.uid] = upload
            if (answerConflictAfterLanding) throw ConflictException("wrong_etag")
        }

        fun fetch(uid: String): Item {
            fetches += uid
            fetchError(uid)?.let { throw it }
            if (inventCopies) return Item(uid, null, "srv-invented-${++invented}", false, "theirs")
            return items[uid] ?: throw ServerErrorException("HTTP error 500! Code: ''. Detail: ''")
        }

        fun fetchNotebook(notebookUid: String): NotebookCheck.Found {
            notebookFetches += notebookUid
            return when (val answer = notebookAnswer(notebookUid)) {
                is Exception -> throw answer
                else -> answer as NotebookCheck.Found
            }
        }

        /** Another client's write. */
        fun writeElsewhere(uid: String, revision: String, deleted: Boolean = false) {
            items[uid] = Item(uid, null, revision, deleted, "theirs")
        }
    }

    private val server = Server()

    /** How each notebook stands in the Etebase cache; one that is not listed is writable. */
    private val notebooks = HashMap<String, Notebook>()

    /** Every cache write, as "uid=revision" (" deleted" for a deleted item), and whether the entry was still there. */
    private val cached = mutableListOf<String>()
    private val entryThereAtCacheWrite = HashMap<String, Boolean>()
    private var cacheError: Exception? = null
    private val unset = mutableListOf<String>()

    /** The notes built from conflicts, in order, and whether each was titled as a conflicted copy. */
    private val built = mutableListOf<String>()
    private val titledAsCopy = HashMap<String, Boolean>()

    private var revisions = 0
    private var now = 1_000_000L

    /** Runs while an upload is in flight: after the entry was recorded as sent, before the server answers. */
    private var duringUpload: (String) -> Unit = {}

    /** Uploads whose answer never arrives: the server has acted on them, and the device sees a connection error. */
    private var loseAnswer: (Item) -> Boolean = { false }

    private val remote = object : NotePushStep.Remote {
        override fun notebook(notebookUid: String) = notebooks[notebookUid] ?: Notebook.WRITABLE

        override fun upload(entry: PendingEntry): NotePushStep.ServerItem {
            val upload = item(entry.blob)
            duringUpload(entry.noteUid)
            server.transaction(upload)
            if (loseAnswer(upload)) throw ConnectionException("no answer")
            return NotePushStep.ServerItem(upload.revision, upload.deleted, entry.blob)
        }

        override fun fetch(entry: PendingEntry): NotePushStep.ServerItem =
            server.fetch(entry.noteUid).let { NotePushStep.ServerItem(it.revision, it.deleted, it.blob()) }

        override fun fetchNotebook(notebookUid: String) = server.fetchNotebook(notebookUid)

        override fun cache(entry: PendingEntry, item: NotePushStep.ServerItem) {
            cacheError?.let { throw it }
            cached += "${entry.noteUid}=${item.revision}${if (item.deleted) " deleted" else ""}"
            entryThereAtCacheWrite[entry.noteUid] = store.read(entry.noteUid) is Read.Present
        }

        override fun unsetNotebook(notebookUid: String) {
            unset += notebookUid
        }

        override fun rebase(entry: PendingEntry, onto: NotePushStep.ServerItem): NotePushStep.Built =
            item(entry.blob).copy(base = onto.revision, revision = revision()).let { NotePushStep.Built(it.revision, it.blob()) }

        override fun newNote(entry: PendingEntry, conflictedCopy: Boolean): PendingEntry {
            val note = Item("copy-${built.size + 1}", null, revision(), false, item(entry.blob).text)
            built += note.uid
            titledAsCopy[note.uid] = conflictedCopy
            return PendingEntry(note.uid, entry.notebookUid, PendingEntry.State.UPSERT, 0, note.revision, true, blob = note.blob())
        }
    }

    private val memory = NotePushStep.Memory()

    private fun revision() = "rev-${++revisions}"

    private fun step(userInitiated: Boolean = true, mayWrite: () -> Boolean = { true }) =
        NotePushStep(store, remote, memory, userInitiated, mayWrite) { now }

    /** One run with a single pass. Runs the user started skip no entry for backoff. */
    private fun run(userInitiated: Boolean = true): NotePushStep.Result = step(userInitiated).pass()

    private fun entry(uid: String): PendingEntry = (store.read(uid) as Read.Present).entry

    private fun waiting(): List<String> = store.scan().entries.map { it.noteUid }

    private fun uploaded(): List<String> = server.uploads.map { it.uid }

    /**
     * An editor save of [text] by uid: applied to the entry's item when there is one, else to the landed
     * record, else to the server revision the editor saw ([seen], null for a new note).
     */
    private fun save(uid: String, text: String, seen: String? = null, notebook: String = "b1"): Item {
        val current = (store.read(uid) as? Read.Present)?.entry
        val landed = store.landed(uid)
        val base = when {
            current != null -> item(current.blob).base
            landed != null -> landed.revision
            else -> seen
        }
        val saved = Item(uid, base, revision(), false, text)
        val outcome = store.saveLocal(uid, notebook, saved.revision, saved.blob(),
            isCreate = current == null && landed == null && seen == null)
        assertTrue("$outcome", outcome is SaveOutcome.Saved || outcome is SaveOutcome.SavedToHolding)
        return saved
    }

    /** A pending delete of a note the server holds at [seen]. */
    private fun delete(uid: String, seen: String, notebook: String = "b1") {
        val gone = Item(uid, seen, revision(), true, "")
        assertEquals(DeleteOutcome.Queued, store.markDeleted(uid, notebook, gone.revision, gone.blob()))
    }

    private fun http(status: Int) = HttpException("HTTP error $status! Code: ''. Detail: ''")

    /** n1 was uploaded once, that upload landed and its answer was lost, and the user then saved again. Returns the landed revision. */
    private fun landedWithoutAnswerThenSaved(): String {
        server.items["n1"] = Item("n1", null, "srv-0", false, "theirs")
        val first = save("n1", "one", seen = "srv-0")
        loseAnswer = { true }
        assertEquals(Ended.STOPPED, run().ended)
        loseAnswer = { false }
        assertEquals("the upload landed", first.revision, server.items.getValue("n1").revision)
        save("n1", "one, two")
        return first.revision
    }

    /** n1 is an edit of a note that another client has changed since: its push conflicts with a copy that is not ours. */
    private fun editedElsewhere(deleted: Boolean = false) {
        server.writeElsewhere("n1", "web-1", deleted)
        save("n1", "mine", seen = "srv-0")
    }

    // ---- the ordinary run ----

    @Test fun `every waiting change is pushed alone, the oldest first, and the run succeeds`() {
        save("a", "first")
        save("b", "second", notebook = "b2")
        save("c", "third")
        val result = run()
        assertEquals(listOf("a", "b", "c"), uploaded())
        assertEquals(NotePushStep.Result(Ended.COMPLETED, pushed = 3, held = 0, conflicts = emptyMap(), failure = null, carriedFailure = null), result)
        assertTrue(result.succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals(setOf("a", "b", "c"), server.items.keys)
    }

    @Test fun `the saved item is in the cache before the entry is dropped`() {
        val saved = save("a", "text")
        run()
        assertEquals(listOf("a=${saved.revision}"), cached)
        assertEquals("a load in between must not fall back to an older cache", true, entryThereAtCacheWrite["a"])
        assertEquals(Read.Missing, store.read("a"))
    }

    @Test fun `a save during the upload keeps the entry, rebased onto the item that landed`() {
        val first = save("a", "text")
        duringUpload = {
            duringUpload = {}
            save("a", "text, and more")
        }
        val result = run()
        assertEquals(1, result.pushed)
        assertTrue(result.succeeded)
        val kept = entry("a")
        assertEquals("text, and more", item(kept.blob).text)
        assertEquals("built on the revision that just landed", first.revision, item(kept.blob).base)
        assertEquals(first.revision, kept.sent.last())
        // The save's own run sends it, and it lands with no conflict.
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals(2, server.uploads.size)
        assertTrue(server.fetches.isEmpty())
    }

    @Test fun `if the cache write fails the entry stays, and the resend of the same revision lands`() {
        val saved = save("a", "text")
        cacheError = IOException("disk full")
        val failed = run()
        assertEquals(FailureKind.LOCAL, failed.failure)
        assertEquals(0, failed.pushed)
        assertEquals("the upload did land", saved.revision, server.items.getValue("a").revision)
        assertEquals(1, entry("a").failureCount)
        assertEquals(FailureKind.LOCAL.name, entry("a").lastFailureCategory)
        cacheError = null
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals("the same revision twice, and the server took the second as done", listOf(saved.revision, saved.revision), server.uploads.map { it.revision })
    }

    // ---- notebooks that take no pushes (3.3 step 1) ----

    @Test fun `changes in a notebook that is read-only, deleted or gone are held without an upload, and a pending delete is dropped`() {
        notebooks["ro"] = Notebook.READ_ONLY
        notebooks["del"] = Notebook.DELETED
        notebooks["gone"] = Notebook.MISSING
        save("e1", "one", notebook = "ro")
        save("e2", "two", notebook = "del")
        save("e3", "three", notebook = "gone")
        delete("d1", seen = "srv-0", notebook = "ro")
        save("ok", "fine")
        val result = run()
        assertEquals("only the writable notebook's change is sent", listOf("ok"), uploaded())
        assertEquals(3, result.held)
        assertEquals(1, result.pushed)
        assertTrue("held text is a handled outcome, not a failure", result.succeeded)
        assertEquals(HeldReason.READ_ONLY, entry("e1").held?.reason)
        assertEquals(HeldReason.NOTEBOOK_DELETED, entry("e2").held?.reason)
        assertEquals(HeldReason.LOST_ACCESS, entry("e3").held?.reason)
        assertEquals("a pending delete has no text to keep", Read.Missing, store.read("d1"))
        assertEquals("three", item(entry("e3").blob).text)
    }

    // ---- backoff and the run's status ----

    @Test fun `an automatic run skips an entry in backoff and carries its failure, and a run the user starts pushes it`() {
        save("a", "text")
        server.uploadError = { http(500) }
        val first = run(userInitiated = false)
        assertEquals(FailureKind.TRANSIENT, first.failure)
        assertEquals(Ended.COMPLETED, first.ended)
        val failedAt = now
        assertEquals(1, entry("a").failureCount)
        server.uploadError = { null }
        now += 30_000
        val skipped = run(userInitiated = false)
        assertEquals("not sent again inside its backoff", 1, server.uploads.size)
        assertNull("the run has no failure of its own", skipped.failure)
        assertEquals(FailureKind.TRANSIENT.name, skipped.carriedFailure)
        assertFalse("it does not record success over an entry that is still stuck", skipped.succeeded)
        assertEquals("the skip adds nothing to the count", 1, entry("a").failureCount)
        assertEquals("and does not move the failure time, so the backoff does not grow", failedAt, entry("a").lastFailureAt)
        val manual = run(userInitiated = true)
        assertTrue(manual.succeeded)
        assertEquals(2, server.uploads.size)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `an automatic run pushes an entry again once its backoff is over`() {
        save("a", "text")
        server.uploadError = { http(500) }
        run(userInitiated = false)
        server.uploadError = { null }
        now += NotePushPolicy.backoffMillis(1)
        assertTrue(run(userInitiated = false).succeeded)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `among skipped entries the most recent failure is the one carried, and a failure of the run's own comes first`() {
        save("a", "one")
        save("b", "two")
        server.uploadError = { if (it.uid == "a") http(400) else null }
        run(userInitiated = false)
        assertEquals(FailureKind.REJECTED.name, entry("a").lastFailureCategory)
        save("c", "three")
        now += 1_000
        server.uploadError = { if (it.uid == "c") http(500) else null }
        run(userInitiated = false)
        assertEquals(FailureKind.TRANSIENT.name, entry("c").lastFailureCategory)
        server.uploadError = { null }
        now += 1_000
        val carried = run(userInitiated = false)
        assertNull(carried.failure)
        assertEquals("c failed after a", FailureKind.TRANSIENT.name, carried.carriedFailure)
        save("d", "four")
        server.uploadError = { if (it.uid == "d") IOException("could not encode") else null }
        val own = run(userInitiated = false)
        assertEquals(FailureKind.LOCAL, own.failure)
        assertEquals(FailureKind.TRANSIENT.name, own.carriedFailure)
    }

    // ---- errors about one entry ----

    @Test fun `a server error on one note does not stop the others`() {
        save("a", "one")
        save("b", "two")
        save("c", "three")
        server.uploadError = { if (it.uid == "b") http(500) else null }
        val result = run()
        assertEquals(listOf("a", "b", "c"), uploaded())
        assertEquals(Ended.COMPLETED, result.ended)
        assertEquals(FailureKind.TRANSIENT, result.failure)
        assertEquals(2, result.pushed)
        assertEquals(listOf("b"), waiting())
        assertEquals(1, entry("b").failureCount)
    }

    @Test fun `a rejection backs off once and holds the text the second time in a row`() {
        save("a", "too odd for this server")
        save("b", "fine")
        server.uploadError = { if (it.uid == "a") http(413) else null }
        val first = run()
        assertEquals(FailureKind.REJECTED, first.failure)
        assertEquals(0, first.held)
        assertEquals(PendingEntry.State.UPSERT, entry("a").state)
        val second = run()
        assertEquals(1, second.held)
        assertNull("a hold is a handled outcome", second.failure)
        assertEquals(HeldReason.REJECTED, entry("a").held?.reason)
        assertEquals(2, uploaded().count { it == "a" })
        assertEquals("held text is not sent again", 2, run().let { uploaded().count { uid -> uid == "a" } })
    }

    @Test fun `a rejection of older content does not hold a note that was saved since`() {
        save("a", "too odd")
        server.uploadError = { http(400) }
        run()
        save("a", "changed")
        run()
        assertEquals("the save reset the record, so this was a first rejection again", PendingEntry.State.UPSERT, entry("a").state)
        assertEquals(1, entry("a").failureCount)
    }

    // ---- an error that is not about one entry ends the step ----

    @Test fun `a server that stops answering pushes costs one request, and the note that hit it goes last in the next run`() {
        save("a", "one")
        save("b", "two")
        save("c", "three", notebook = "b2")
        save("d", "four", notebook = "b2")
        server.uploadError = { ConnectionException("timeout") }
        val stopped = run()
        assertEquals("one push in the whole run, across both notebooks", listOf("a"), uploaded())
        assertEquals(Ended.STOPPED, stopped.ended)
        assertEquals(FailureKind.TRANSIENT, stopped.failure)
        assertEquals(1, entry("a").failureCount)
        for (uid in listOf("b", "c", "d")) {
            assertEquals("$uid recorded nothing", 0, entry(uid).failureCount)
            assertTrue("$uid was not sent", entry(uid).sent.isEmpty())
        }
        assertEquals("a", memory.endedLastStep)

        // Before the next run the user saves a again, which resets its count and makes it the newest
        // change, and b gets a failure of its own.
        save("a", "one, again")
        store.recordFailure("b", entry("b").version, FailureKind.TRANSIENT.name, now)
        server.uploads.clear()
        server.uploadError = { null }
        assertTrue(run().succeeded)
        assertEquals("never failed first and oldest first among those, then b, and the note that ended the last step last",
            listOf("c", "d", "b", "a"), uploaded())
        assertNull("a step that ran to its end has nothing to remember", memory.endedLastStep)
    }

    @Test fun `a step that runs to its end forgets that note, even when the note itself was not pushed`() {
        save("a", "one")
        save("b", "two")
        server.uploadError = { ConnectionException("timeout") }
        assertEquals(Ended.STOPPED, run(userInitiated = false).ended)
        assertEquals("a", memory.endedLastStep)
        // The next automatic run skips a, which is in backoff, and reaches its end.
        server.uploadError = { null }
        val next = run(userInitiated = false)
        assertEquals(Ended.COMPLETED, next.ended)
        assertEquals(listOf("a", "b"), uploaded())
        assertEquals(FailureKind.TRANSIENT.name, next.carriedFailure)
        assertNull(memory.endedLastStep)
        // From here a goes by its count and age again: ahead of a newer change with the same count.
        save("c", "three")
        store.recordFailure("c", entry("c").version, FailureKind.TRANSIENT.name, now)
        server.uploads.clear()
        assertTrue(run().succeeded)
        assertEquals(listOf("a", "c"), uploaded())
    }

    @Test fun `the error that ended the step is the run's failure, ahead of an earlier entry's own`() {
        save("a", "too odd")
        save("b", "two")
        server.uploadError = { if (it.uid == "a") http(400) else ConnectionException("timeout") }
        val result = run()
        assertEquals(Ended.STOPPED, result.ended)
        assertEquals(FailureKind.TRANSIENT, result.failure)
        assertEquals(FailureKind.REJECTED.name, entry("a").lastFailureCategory)
    }

    @Test fun `without that memory a just saved note would go by its count and age like any other`() {
        save("a", "one")
        save("b", "two")
        save("c", "three")
        store.recordFailure("b", entry("b").version, FailureKind.TRANSIENT.name, now)
        save("a", "one, again")
        assertTrue(run().succeeded)
        assertEquals("fewest failures first, and the oldest change first among equals", listOf("c", "a", "b"), uploaded())
    }

    @Test fun `a temporary server error ends the step like a connection error`() {
        save("a", "one")
        save("b", "two")
        server.uploadError = { TemporaryServerErrorException("HTTP error 503!") }
        val stopped = run()
        assertEquals(Ended.STOPPED, stopped.ended)
        assertEquals(listOf("a"), uploaded())
        assertEquals(0, entry("b").failureCount)
    }

    // ---- 401: the pass ends, and the pass after the renewal goes on ----

    @Test fun `a 401 records nothing, and the next pass sends that entry and none that the first pass settled`() {
        save("a", "one")
        save("b", "too odd")
        save("c", "three")
        save("d", "four")
        var unauthorized = true
        server.uploadError = {
            when {
                it.uid == "b" -> http(400)
                it.uid == "c" && unauthorized -> UnauthorizedException("Invalid token.")
                else -> null
            }
        }
        val step = step()
        val first = step.pass()
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertEquals(listOf("a", "b", "c"), uploaded())
        assertEquals("the request that got the 401 recorded nothing", 0, entry("c").failureCount)
        unauthorized = false
        val second = step.pass()
        assertEquals(Ended.COMPLETED, second.ended)
        assertEquals("a landed and b was rejected in the first pass: neither is sent again", listOf("a", "b", "c", "c", "d"), uploaded())
        assertEquals("both passes count together", 3, second.pushed)
        assertEquals(FailureKind.REJECTED, second.failure)
        assertEquals("one rejection, so pending and not held", PendingEntry.State.UPSERT, entry("b").state)
        assertEquals(1, entry("b").failureCount)
        assertEquals(listOf("b"), waiting())
    }

    @Test fun `a copy whose first push got the 401 lands in the pass after the renewal`() {
        editedElsewhere()
        var unauthorized = true
        server.uploadError = { if (unauthorized && it.uid == "copy-1") UnauthorizedException("Invalid token.") else null }
        val step = step()
        assertEquals(Ended.NEEDS_AUTHENTICATION, step.pass().ended)
        assertEquals("the copy was made, and its push got the 401", listOf("n1", "copy-1"), uploaded())
        assertEquals(0, entry("copy-1").failureCount)
        unauthorized = false
        val second = step.pass()
        assertEquals(Ended.COMPLETED, second.ended)
        assertEquals("the original is not sent again, and no second copy is made", listOf("n1", "copy-1", "copy-1"), uploaded())
        assertEquals(listOf("copy-1"), built)
        assertEquals(mapOf("b1" to 1), second.conflicts)
        assertEquals(1, second.pushed)
        assertTrue(second.succeeded)
        assertNotNull(server.items["copy-1"])
        assertTrue(waiting().isEmpty())
    }

    @Test fun `an entry whose push after a rebase got the 401 is sent in the next pass and gets no second rebase`() {
        val ours = landedWithoutAnswerThenSaved()
        server.uploads.clear()
        var unauthorized = true
        server.uploadError = { if (unauthorized && it.base == ours) UnauthorizedException("Invalid token.") else null }
        val step = step()
        assertEquals(Ended.NEEDS_AUTHENTICATION, step.pass().ended)
        assertEquals("the stale upload, then the rebased one, which got the 401", 2, server.uploads.size)
        assertEquals(1, server.fetches.size)
        assertEquals(0, entry("n1").failureCount)
        unauthorized = false
        // The server now refuses the rebased upload with our own copy once more.
        server.refuseEveryPush = true
        val second = step.pass()
        assertEquals(Ended.COMPLETED, second.ended)
        assertEquals("sent again, and refused a second rebase in the same run", 3, server.uploads.size)
        assertEquals(2, server.fetches.size)
        assertEquals(FailureKind.TRANSIENT, second.failure)
        assertEquals(1, entry("n1").failureCount)
        assertTrue(built.isEmpty())
    }

    @Test fun `with a server that behaves that entry simply lands in the next pass`() {
        val ours = landedWithoutAnswerThenSaved()
        var unauthorized = true
        server.uploadError = { if (unauthorized && it.base == ours) UnauthorizedException("Invalid token.") else null }
        val step = step()
        assertEquals(Ended.NEEDS_AUTHENTICATION, step.pass().ended)
        unauthorized = false
        val second = step.pass()
        assertTrue(second.succeeded)
        assertEquals(1, second.pushed)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a notebook that had its confirming fetch in the first pass gets no second one after the renewal`() {
        threeInOneNotebook()
        var unauthorized = true
        server.uploadError = {
            if (it.uid == "b" && unauthorized) UnauthorizedException("Invalid token.") else PermissionDeniedException("no_write_access")
        }
        val step = step()
        assertEquals(Ended.NEEDS_AUTHENTICATION, step.pass().ended)
        assertEquals(listOf("b1"), server.notebookFetches)
        unauthorized = false
        val second = step.pass()
        assertEquals("a is settled; b and c are sent, and the stored answer is reused", listOf("a", "b", "b", "c"), uploaded())
        assertEquals(listOf("b1"), server.notebookFetches)
        assertEquals(Ended.COMPLETED, second.ended)
        assertEquals(0, second.held)
        for (uid in listOf("a", "b", "c")) assertEquals(1, entry(uid).failureCount)
    }

    // ---- 403 and 404 on a push ----

    private fun threeInOneNotebook() {
        save("a", "one")
        save("b", "two")
        save("c", "three")
    }

    @Test fun `a 403 on every push while the notebook is still writable backs every entry off and holds none`() {
        threeInOneNotebook()
        server.uploadError = { PermissionDeniedException("no_write_access") }
        val result = run()
        assertEquals("every entry is still pushed", listOf("a", "b", "c"), uploaded())
        assertEquals("one confirming fetch for the notebook", listOf("b1"), server.notebookFetches)
        assertEquals(0, result.held)
        assertEquals(Ended.COMPLETED, result.ended)
        assertEquals(FailureKind.READ_ONLY, result.failure)
        for (uid in listOf("a", "b", "c")) {
            assertEquals(PendingEntry.State.UPSERT, entry(uid).state)
            assertEquals(1, entry(uid).failureCount)
        }
        // The next run asks the notebook again.
        run()
        assertEquals(listOf("b1", "b1"), server.notebookFetches)
    }

    @Test fun `the same when the notebook fetch fails in a way that says nothing`() {
        threeInOneNotebook()
        server.uploadError = { PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { http(500) }
        val result = run()
        assertEquals(listOf("a", "b", "c"), uploaded())
        assertEquals("the failed fetch counts as the one for this run", listOf("b1"), server.notebookFetches)
        assertEquals(0, result.held)
        assertEquals(Ended.COMPLETED, result.ended)
        assertEquals(3, waiting().size)
    }

    @Test fun `a 403 on the push and on the notebook fetch is about the account, and ends the step`() {
        for (answer in listOf<Exception>(PermissionDeniedException("user_inactive"), ConnectionException("timeout"))) {
            val name = answer.javaClass.simpleName
            val uids = listOf("a-$name", "b-$name", "c-$name")
            save(uids[0], "one")
            save(uids[1], "two")
            save(uids[2], "three", notebook = "b2")
            server.uploads.clear()
            server.notebookFetches.clear()
            server.uploadError = { PermissionDeniedException("no_write_access") }
            server.notebookAnswer = { answer }
            val result = run()
            assertEquals(name, listOf(uids[0]), uploaded())
            assertEquals(name, listOf("b1"), server.notebookFetches)
            assertEquals(name, Ended.STOPPED, result.ended)
            assertEquals(name, 0, result.held)
            assertEquals("$name: one failure, on the entry whose push led to the fetch", 1, entry(uids[0]).failureCount)
            assertEquals("$name: the others are untouched, in both notebooks", listOf(0, 0), uids.drop(1).map { entry(it).failureCount })
            assertEquals(name, uids[0], memory.endedLastStep)
            // Clear the store for the next answer.
            uids.forEach { store.discard(it) }
        }
    }

    @Test fun `a 403 confirmed as read-only holds the notebook's other entries without an upload and drops a pending delete`() {
        threeInOneNotebook()
        delete("d", seen = "srv-0")
        save("other", "elsewhere", notebook = "b2")
        server.uploadError = { if (it.uid == "other") null else PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = true, deleted = false) }
        val result = run()
        assertEquals("one push in that notebook, and the other notebook's change", listOf("a", "other"), uploaded())
        assertEquals(listOf("b1"), server.notebookFetches)
        assertEquals(3, result.held)
        assertEquals(1, result.pushed)
        assertTrue(result.succeeded)
        for (uid in listOf("a", "b", "c")) assertEquals(HeldReason.READ_ONLY, entry(uid).held?.reason)
        assertEquals(Read.Missing, store.read("d"))
        assertTrue("the notebook is still there for this account", unset.isEmpty())
    }

    @Test fun `a 403 on the first push only, with the notebook found deleted, sends no later push although the server would take it`() {
        threeInOneNotebook()
        var first = true
        server.uploadError = { if (first) PermissionDeniedException("no_write_access").also { first = false } else null }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = false, deleted = true) }
        val result = run()
        assertEquals("the server accepts writes into a deleted notebook, so none is sent", listOf("a"), uploaded())
        assertEquals(3, result.held)
        for (uid in listOf("a", "b", "c")) assertEquals(HeldReason.NOTEBOOK_DELETED, entry(uid).held?.reason)
    }

    @Test fun `a 404 confirmed by the notebook fetch holds the text as lost access and takes the notebook out of the cache`() {
        threeInOneNotebook()
        server.uploadError = { NotFoundException("Collection matching query does not exist.") }
        server.notebookAnswer = { NotFoundException("Collection matching query does not exist.") }
        val result = run()
        assertEquals(listOf("a"), uploaded())
        assertEquals(3, result.held)
        for (uid in listOf("a", "b", "c")) assertEquals(HeldReason.LOST_ACCESS, entry(uid).held?.reason)
        assertEquals("once, however many entries it had", listOf("b1"), unset)
    }

    @Test fun `a notebook's answer holds nothing in another notebook`() {
        save("a", "one")
        save("z", "other notebook", notebook = "b2")
        server.uploadError = { PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = it == "b1", deleted = false) }
        val result = run()
        assertEquals(listOf("b1", "b2"), server.notebookFetches)
        assertEquals(1, result.held)
        assertEquals(HeldReason.READ_ONLY, entry("a").held?.reason)
        assertEquals("b2 is still writable: passing trouble", PendingEntry.State.UPSERT, entry("z").state)
        assertEquals(1, entry("z").failureCount)
    }

    @Test fun `a redirect on a push is passing trouble, with no notebook fetch`() {
        save("a", "one")
        server.uploadError = { NotFoundException("Got a redirect - should never happen") }
        val result = run()
        assertEquals(FailureKind.TRANSIENT, result.failure)
        assertTrue(server.notebookFetches.isEmpty())
        assertEquals(Ended.COMPLETED, result.ended)
    }

    // ---- a 409 whose server copy is ours ----

    @Test fun `a server that answers every push with a 409 and our own copy gets two pushes per run and never a new note`() {
        val ours = landedWithoutAnswerThenSaved()
        server.refuseEveryPush = true
        server.uploads.clear()
        repeat(40) { n ->
            val result = run()
            assertEquals("run $n: one rebase, a second push and a second fetch, and no third push", (n + 1) * 2, server.uploads.size)
            assertEquals("run $n", (n + 1) * 2, server.fetches.size)
            assertEquals("run $n", FailureKind.TRANSIENT, result.failure)
            assertEquals("run $n", Ended.COMPLETED, result.ended)
            assertEquals("run $n: a recorded failure, so automatic runs back off", n + 1, entry("n1").failureCount)
            assertTrue("run $n: the server's copy is still in the sent list", ours in entry("n1").sent)
        }
        assertTrue("the user's own text never became a conflicted copy", built.isEmpty())
        assertEquals(listOf("n1"), waiting())
        assertEquals("the cap was reached, so the oldest revisions did fall off", PendingEntry.MAX_SENT, entry("n1").sent.size)
        assertEquals("one, two", item(entry("n1").blob).text)
        assertFalse("an automatic run now waits out the backoff", run(userInitiated = false).succeeded)
        assertEquals(80, server.uploads.size)
    }

    @Test fun `the same holds when the user saves the note between runs`() {
        val ours = landedWithoutAnswerThenSaved()
        server.refuseEveryPush = true
        repeat(40) { n ->
            save("n1", "text $n")
            assertEquals("run $n", FailureKind.TRANSIENT, run().failure)
            assertTrue("run $n", ours in entry("n1").sent)
        }
        assertTrue(built.isEmpty())
        assertEquals(PendingEntry.MAX_SENT, entry("n1").sent.size)
        assertEquals("text 39", item(entry("n1").blob).text)
    }

    @Test fun `a second 409 whose server copy is the upload just sent drops the entry`() {
        landedWithoutAnswerThenSaved()
        // The rebased upload passes the server's checks and lands, and the server answers 409 all the same.
        server.answerConflictAfterLanding = true
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(1, result.pushed)
        assertTrue(waiting().isEmpty())
        assertTrue(built.isEmpty())
        assertEquals(server.uploads.last().revision, server.items.getValue("n1").revision)
        assertEquals("the server's copy went into the cache before the entry was dropped", true, entryThereAtCacheWrite["n1"])
    }

    @Test fun `with a server that behaves a lost answer and one newer save take one rebase and one more push`() {
        landedWithoutAnswerThenSaved()
        server.uploads.clear()
        val result = run()
        assertTrue("no failure and no backoff", result.succeeded)
        assertEquals("the stale upload and the rebased one", 2, server.uploads.size)
        assertEquals(1, server.fetches.size)
        assertTrue(waiting().isEmpty())
        assertTrue(built.isEmpty())
    }

    @Test fun `a second 409 in the same run whose server copy is by then another client's goes through the conflict table`() {
        val ours = landedWithoutAnswerThenSaved()
        // Another client writes between the fetch and the rebased upload: an ordinary conflict.
        server.beforeUpload = { if (it.uid == "n1" && it.base == ours) server.writeElsewhere("n1", "web-5") }
        val result = run()
        assertTrue("resolved in this run, with no failure and no backoff", result.succeeded)
        assertEquals(mapOf("b1" to 1), result.conflicts)
        assertEquals(listOf("copy-1"), built)
        assertEquals(true, titledAsCopy["copy-1"])
        assertTrue(waiting().isEmpty())
        assertEquals("the other client's version stays", "web-5", server.items.getValue("n1").revision)
        assertNotNull(server.items["copy-1"])
    }

    // ---- a 409 whose server copy cannot be fetched ----

    @Test fun `a 409 on every push with a fetch that fails every time is one push and one fetch per run, and the entry backs off`() {
        save("a", "mine", seen = "srv-0")
        save("b", "fine")
        server.uploadError = { if (it.uid == "a") ConflictException("wrong_etag") else null }
        repeat(3) { n ->
            val result = run()
            assertEquals("run $n", n + 1, uploaded().count { it == "a" })
            assertEquals("run $n: the server holds no such item and answers 500", n + 1, server.fetches.size)
            assertEquals("run $n", FailureKind.TRANSIENT, result.failure)
            assertEquals("run $n: a 500 on the fetch is about this entry, so the step goes on", Ended.COMPLETED, result.ended)
            assertEquals("run $n", n + 1, entry("a").failureCount)
            assertEquals("run $n", 0, result.held)
            assertTrue("run $n", result.conflicts.isEmpty())
        }
        assertTrue("never resolved without the server copy", built.isEmpty())
        assertEquals(listOf("a"), waiting())
        assertFalse("and an automatic run does not try it inside its backoff", run(userInitiated = false).succeeded)
        assertEquals(3, uploaded().count { it == "a" })
    }

    @Test fun `a fetch answered with a 400 is not a rejection, so one rejected push after it does not hold the text`() {
        save("a", "mine", seen = "srv-0")
        server.uploadError = { ConflictException("wrong_etag") }
        server.fetchError = { http(400) }
        run()
        assertEquals(FailureKind.TRANSIENT.name, entry("a").lastFailureCategory)
        server.uploadError = { http(400) }
        val result = run()
        assertEquals(0, result.held)
        assertEquals(PendingEntry.State.UPSERT, entry("a").state)
        assertEquals(FailureKind.REJECTED.name, entry("a").lastFailureCategory)
    }

    @Test fun `a connection error on the fetch after a 409 ends the step`() {
        save("a", "mine", seen = "srv-0")
        save("b", "two")
        server.uploadError = { if (it.uid == "a") ConflictException("wrong_etag") else null }
        server.fetchError = { ConnectionException("timeout") }
        val result = run()
        assertEquals(Ended.STOPPED, result.ended)
        assertEquals(listOf("a"), uploaded())
        assertEquals(1, entry("a").failureCount)
        assertEquals(0, entry("b").failureCount)
    }

    @Test fun `a 403 on the fetch after a 409 goes through the notebook confirmation`() {
        save("a", "mine", seen = "srv-0")
        save("b", "two")
        server.uploadError = { if (it.uid == "a") ConflictException("wrong_etag") else null }
        server.fetchError = { PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = true, deleted = false) }
        val result = run()
        assertEquals(listOf("b1"), server.notebookFetches)
        assertEquals(2, result.held)
        assertEquals(listOf("a"), uploaded())
    }

    // ---- cancellation and a run that is no longer current ----

    @Test fun `a cancelled request is thrown on, and nothing is counted or backs off`() {
        save("a", "mine", seen = "srv-0")
        server.uploadError = { ConflictException("wrong_etag") }
        server.fetchError = { InterruptedIOException("cancelled") }
        assertThrows(InterruptedIOException::class.java) { run() }
        assertEquals(0, entry("a").failureCount)
        assertNull(memory.endedLastStep)
    }

    @Test fun `an answer that arrives once the run may no longer write records nothing`() {
        // Sign-out, Notes turned off, or the account replaced while the request was in flight. The
        // cancelled call surfaces as an ordinary error.
        save("a", "mine")
        var current = true
        duringUpload = { current = false }
        server.uploadError = { ConnectionException("socket closed") }
        assertThrows(StaleSyncRunException::class.java) { step(mayWrite = { current }).pass() }
        assertEquals("no failure and no backoff", 0, entry("a").failureCount)
        assertNull(memory.endedLastStep)
        // The same for an upload that succeeded: the entry stays with its sent revision, and nothing is cached.
        current = true
        server.uploadError = { null }
        duringUpload = { current = false }
        assertThrows(StaleSyncRunException::class.java) { step(mayWrite = { current }).pass() }
        assertEquals(listOf("a"), waiting())
        assertTrue(cached.isEmpty())
        assertEquals(1, entry("a").sent.size)
        // The next run's resend of the same revision is taken as done.
        current = true
        duringUpload = {}
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    // ---- a 409 whose server copy is not ours, on every push ----

    /** Every push is refused, with a copy no client sent: n1 becomes one new note, which is then held. */
    private fun refusedUntilHeld(): NotePushStep.Result {
        save("n1", "mine", seen = "srv-0")
        server.refuseEveryPush = true
        server.inventCopies = true
        return run()
    }

    @Test fun `a server that refuses every push with a copy that is not ours gets one new note, pushed in the same run, and then the text is held`() {
        val result = refusedUntilHeld()
        assertEquals("the original and, in the same run, the new note", listOf("n1", "copy-1"), uploaded())
        assertEquals(1, result.held)
        assertEquals(mapOf("b1" to 1), result.conflicts)
        assertNull("a conflict is not a failure, and a hold is a handled outcome", result.failure)
        repeat(5) { assertEquals("held text is not sent again", 0, run().pushed) }
        assertEquals(2, server.uploads.size)
        assertEquals(2, server.fetches.size)
        assertEquals(listOf("copy-1"), built)
        assertEquals(listOf("copy-1"), waiting())
        val held = entry("copy-1")
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.REPEATED_CONFLICT, held.held?.reason)
        assertTrue(held.fromConflict)
        assertEquals("the text is kept", "mine", item(held.blob).text)
        assertEquals("the server's copy of the original was cached before the original was removed", true, entryThereAtCacheWrite["n1"])
    }

    @Test fun `try again on text held for a repeated conflict makes exactly one more note and holds it again`() {
        refusedUntilHeld()
        for (tap in 1..2) {
            assertTrue(store.release("copy-$tap"))
            val result = run()
            assertEquals("tap $tap", 1, result.held)
            repeat(3) { run() }
            assertEquals("tap $tap: nothing further until the next tap", (1..tap + 1).map { "copy-$it" }, built)
            assertEquals(listOf("copy-${tap + 1}"), waiting())
            assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-${tap + 1}").held?.reason)
            assertEquals("mine", item(entry("copy-${tap + 1}").blob).text)
        }
        assertEquals("two pushes per tap, after the first two", 6, server.uploads.size)
    }

    @Test fun `a refused marked note that was saved during the upload is held one run later, and still makes no second note`() {
        save("n1", "mine", seen = "srv-0")
        server.refuseEveryPush = true
        server.inventCopies = true
        duringUpload = { uid ->
            if (uid == "copy-1") {
                duringUpload = {}
                save("copy-1", "mine, and more")
            }
        }
        // The hold names the version that was sent, and the entry has moved on, so it stays pending.
        val first = run()
        assertEquals(0, first.held)
        val pending = entry("copy-1")
        assertEquals(PendingEntry.State.UPSERT, pending.state)
        assertTrue(pending.fromConflict)
        assertEquals(0, pending.failureCount)
        // The next run sends the newer text, gets the same answer, and holds it.
        assertEquals(1, run().held)
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertEquals("mine, and more", item(entry("copy-1").blob).text)
        assertEquals(listOf("copy-1"), built)
    }

    /** The copy of n1 was uploaded and landed, its answer was lost, and the user then deleted it on this device. */
    private fun markedDeleteMeets(deletedElsewhere: Boolean): NotePushStep.Result {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(Ended.STOPPED, run().ended)
        loseAnswer = { false }
        val gone = item(entry("copy-1").blob).copy(revision = revision(), deleted = true)
        assertEquals(DeleteOutcome.Queued, store.markDeleted("copy-1", "b1", gone.revision, gone.blob()))
        assertTrue("the delete carries the mark", entry("copy-1").fromConflict)
        server.writeElsewhere("copy-1", "web-2", deleted = deletedElsewhere)
        cached.clear()
        entryThereAtCacheWrite.clear()
        val result = run()
        assertTrue("nothing is held, and no note is made", waiting().isEmpty())
        assertEquals(0, result.held)
        assertEquals(listOf("copy-1"), built)
        assertEquals("the server's copy went into the cache before the delete was dropped", true, entryThereAtCacheWrite["copy-1"])
        return result
    }

    @Test fun `a marked pending delete against an edit made elsewhere gives the note back, through the cache, and nothing is held`() {
        val result = markedDeleteMeets(deletedElsewhere = false)
        assertEquals(listOf("copy-1=web-2"), cached)
        assertEquals("the user is told the delete did not happen", mapOf("b1" to 1), result.conflicts)
        assertTrue(result.succeeded)
    }

    @Test fun `a marked pending delete against a delete made elsewhere is already done, quietly`() {
        val result = markedDeleteMeets(deletedElsewhere = true)
        assertEquals(listOf("copy-1=web-2 deleted"), cached)
        assertTrue(result.conflicts.isEmpty())
        assertTrue(result.succeeded)
    }

    // ---- the mark with a server that behaves ----

    @Test fun `a first conflict on an ordinary note still makes its copy, and the copy lands in the same run`() {
        editedElsewhere()
        val result = run()
        assertTrue("a conflict is resolved, not failed", result.succeeded)
        assertEquals(mapOf("b1" to 1), result.conflicts)
        assertEquals(1, result.pushed)
        assertEquals(listOf("n1", "copy-1"), uploaded())
        assertEquals(true, titledAsCopy["copy-1"])
        assertTrue("nothing is held", waiting().isEmpty())
        assertEquals("the server version stays in place", "web-1", server.items.getValue("n1").revision)
        assertEquals("and is in the cache before the local edit is replaced", listOf("n1=web-1", "copy-1=${server.items.getValue("copy-1").revision}"), cached)
        assertEquals("mine", server.items.getValue("copy-1").text)
    }

    @Test fun `a first conflict with a note deleted elsewhere becomes a new note with its own title that lands in the same run`() {
        editedElsewhere(deleted = true)
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(false, titledAsCopy["copy-1"])
        assertEquals("n1=web-1 deleted", cached.first())
        assertTrue(waiting().isEmpty())
        assertNotNull(server.items["copy-1"])
    }

    @Test fun `a local delete against an edit made elsewhere gives the note back, and against a delete it is simply done`() {
        server.writeElsewhere("x", "web-1")
        server.writeElsewhere("y", "web-2", deleted = true)
        delete("x", seen = "srv-0")
        delete("y", seen = "srv-0")
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(mapOf("b1" to 1), result.conflicts)
        assertTrue(waiting().isEmpty())
        assertEquals(listOf("x=web-1", "y=web-2 deleted"), cached)
        assertTrue(built.isEmpty())
    }

    @Test fun `a conflict copy saved during its first upload is an ordinary note afterwards`() {
        editedElsewhere()
        duringUpload = { uid ->
            if (uid == "copy-1") {
                duringUpload = {}
                save("copy-1", "mine, and more")
            }
        }
        assertTrue(run().succeeded)
        assertFalse("the upload landed, so the note is on the server", entry("copy-1").fromConflict)
        // Another client then edits the copy: an ordinary conflict, so a conflicted copy, not a hold.
        server.writeElsewhere("copy-1", "web-2")
        val result = run()
        assertEquals(0, result.held)
        assertEquals(listOf("copy-1", "copy-2"), built)
        assertTrue("nothing is held", waiting().isEmpty())
    }

    /** The copy of n1 landed with its answer lost, and the user saved it again before the next run. */
    private fun copyLandedWithoutAnswerThenSaved(): String {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(Ended.STOPPED, run().ended)
        loseAnswer = { false }
        save("copy-1", "mine, and more")
        assertTrue("saved before the device knows it landed, so still marked", entry("copy-1").fromConflict)
        return server.items.getValue("copy-1").revision
    }

    @Test fun `a conflict copy whose answer was lost and that was saved again lands with one rebase`() {
        copyLandedWithoutAnswerThenSaved()
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(0, result.held)
        assertEquals(listOf("copy-1"), built)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `after that rebase a conflict with another client's copy makes a conflicted copy, not a hold`() {
        val landed = copyLandedWithoutAnswerThenSaved()
        // Another client writes between the fetch and the rebased upload.
        server.beforeUpload = { if (it.uid == "copy-1" && it.base == landed) server.writeElsewhere("copy-1", "web-3") }
        val result = run()
        assertEquals(0, result.held)
        assertEquals(listOf("copy-1", "copy-2"), built)
        assertTrue("nothing is held", waiting().isEmpty())
        assertNotNull(server.items["copy-2"])
    }

    @Test fun `try again on text held for a real repeated conflict lands as one new note`() {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        run()
        loseAnswer = { false }
        // The conflicted copy is on the server, and the user merges it on another device before this one's next run.
        server.writeElsewhere("copy-1", "web-2")
        assertEquals(1, run().held)
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertTrue(store.release("copy-1"))
        assertTrue(run().succeeded)
        assertEquals(listOf("copy-1", "copy-2"), built)
        assertTrue(waiting().isEmpty())
        assertEquals("the other device's merge stays", "web-2", server.items.getValue("copy-1").revision)
        assertNotNull(server.items["copy-2"])
    }

    @Test fun `try again lands as the same note when the server takes the push after all`() {
        refusedUntilHeld()
        // The refusals were the server's fault, and it behaves again by the time the user taps Try again.
        server.refuseEveryPush = false
        server.inventCopies = false
        assertTrue(store.release("copy-1"))
        assertTrue(run().succeeded)
        assertEquals(listOf("copy-1"), built)
        assertTrue(waiting().isEmpty())
        assertNotNull(server.items["copy-1"])
    }

    // ---- storage trouble ----

    @Test fun `while the original cannot be removed neither note is sent, each run records a storage failure, and no second copy is made`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        assertEquals(FailureKind.LOCAL, run().failure)
        repeat(5) { n ->
            val result = run()
            assertEquals("run $n: never a success over them", FailureKind.LOCAL, result.failure)
            assertEquals("run $n", 0, result.pushed)
        }
        assertEquals("only the first push of the original reached the server", listOf("n1"), uploaded())
        assertEquals(listOf("copy-1"), built)
        assertEquals(listOf("copy-1", "n1"), waiting())
        failing = false
        // Recovery removes the original and clears the link, and the copy is sent like any new note.
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(listOf("copy-1"), built)
        assertTrue(waiting().isEmpty())
        assertEquals(listOf("n1", "copy-1"), uploaded())
        assertEquals("web-1", server.items.getValue("n1").revision)
    }

    @Test fun `deleting the copy while the original cannot be removed does not bring the text back as a second copy`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        run()
        // The user deletes the conflicted copy. The delete fails with the removal, and both notes stay.
        val gone = item(entry("copy-1").blob).copy(revision = revision(), deleted = true)
        assertThrows(IOException::class.java) { store.markDeleted("copy-1", "b1", gone.revision, gone.blob()) }
        run()
        failing = false
        assertEquals(DeleteOutcome.Removed, store.markDeleted("copy-1", "b1", gone.revision, gone.blob()))
        assertTrue("the original went with the copy", run().succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals(listOf("copy-1"), built)
        assertEquals("nothing but the first push of the original reached the server", listOf("n1"), uploaded())
    }

    @Test fun `an entry file that cannot be read fails the run, and the other entries are still pushed`() {
        save("a", "one")
        save("b", "two")
        File(dir, "a.note").writeBytes(byteArrayOf(0))
        val result = run()
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(listOf("b"), uploaded())
        assertEquals(1, result.pushed)
        assertEquals("kept, never deleted", 1L, File(dir, "a.note").length())
    }

    // ---- an editor that has not rebound when the copy lands ----

    @Test fun `a save from an editor that has not rebound ends up in the copy, with no entry for the original and no second copy`() {
        server.writeElsewhere("n1", "web-1")
        val editor = store.editorOpened("n1")
        val first = Item("n1", "srv-0", revision(), false, "mine")
        assertTrue(store.saveLocal(editor, "n1", "b1", first.revision, first.blob(), isCreate = false) is SaveOutcome.Saved)
        // The copy is made and lands in one run, before the editor hears of it.
        assertTrue(run().succeeded)
        assertEquals("copy-1", editor.noteUid)
        // The editor's next autosave was built for the original.
        val late = Item("n1", "srv-0", revision(), false, "mine, and more")
        assertEquals(SaveOutcome.Moved("copy-1"), store.saveLocal(editor, "n1", "b1", late.revision, late.blob(), isCreate = false))
        assertEquals(Read.Missing, store.read("n1"))
        // It applies its text to the copy as it landed, and saves again.
        val onCopy = Item("copy-1", store.landed("copy-1")!!.revision, revision(), false, "mine, and more")
        assertTrue(store.saveLocal(editor, "copy-1", "b1", onCopy.revision, onCopy.blob(), isCreate = false) is SaveOutcome.Saved)
        assertTrue(run().succeeded)
        assertEquals(listOf("copy-1"), built)
        assertEquals("the original was pushed once, before the conflict", 1, uploaded().count { it == "n1" })
        assertEquals(onCopy.revision, server.items.getValue("copy-1").revision)
        assertEquals("web-1", server.items.getValue("n1").revision)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a delete from an editor that has not rebound deletes the copy on the server, not the original`() {
        server.writeElsewhere("n1", "web-1")
        val editor = store.editorOpened("n1")
        val first = Item("n1", "srv-0", revision(), false, "mine")
        store.saveLocal(editor, "n1", "b1", first.revision, first.blob(), isCreate = false)
        assertTrue(run().succeeded)
        val late = Item("n1", "srv-0", revision(), true, "")
        assertEquals(DeleteOutcome.Moved("copy-1"), store.markDeleted(editor, "n1", "b1", late.revision, late.blob()))
        assertEquals(Read.Missing, store.read("n1"))
        val onCopy = Item("copy-1", store.landed("copy-1")!!.revision, revision(), true, "")
        assertEquals(DeleteOutcome.Queued, store.markDeleted(editor, "copy-1", "b1", onCopy.revision, onCopy.blob()))
        assertTrue(run().succeeded)
        assertTrue(server.items.getValue("copy-1").deleted)
        assertEquals("the other client's version of the original is untouched", "web-1", server.items.getValue("n1").revision)
        assertFalse(server.items.getValue("n1").deleted)
        assertEquals(listOf("copy-1"), built)
        assertTrue(waiting().isEmpty())
    }
}
