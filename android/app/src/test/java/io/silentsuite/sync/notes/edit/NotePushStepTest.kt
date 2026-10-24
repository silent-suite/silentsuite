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
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.listFilesForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
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

    /** At each cache write, the state the entry was in (null when it was gone). A held entry is still there, so its presence alone cannot show the order. */
    private val stateAtCacheWrite = HashMap<String, PendingEntry.State?>()
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

    /** Runs while a fetch(uid) is in flight. */
    private var duringFetch: (String) -> Unit = {}

    /** Runs while an item is written into the cache, for a save that lands after the step read the entry. */
    private var duringCache: (String) -> Unit = {}

    /** Failures of the remote's own work on an item (decrypting, building), not of the server. */
    private var rebaseError: Exception? = null
    private var newNoteError: Exception? = null

    /** Makes every rebase and new note come out one byte larger than the pending store keeps. */
    private var builtTooLarge = false

    /** Runs when a rebase or a new note starts, for a save that lands while the note is being built. */
    private var duringBuild: () -> Unit = {}

    /** A notebook whose cached state cannot be read. */
    private var notebookLookupError: (String) -> Exception? = { null }

    private val remote = object : NotePushStep.Remote {
        override fun notebook(notebookUid: String): Notebook {
            notebookLookupError(notebookUid)?.let { throw it }
            return notebooks[notebookUid] ?: Notebook.WRITABLE
        }

        override fun upload(entry: PendingEntry): NotePushStep.ServerItem {
            val upload = item(entry.blob)
            duringUpload(entry.noteUid)
            server.transaction(upload)
            if (loseAnswer(upload)) throw ConnectionException("no answer")
            return NotePushStep.ServerItem(upload.revision, upload.deleted, entry.blob)
        }

        override fun fetch(entry: PendingEntry): NotePushStep.ServerItem {
            duringFetch(entry.noteUid)
            return server.fetch(entry.noteUid).let { NotePushStep.ServerItem(it.revision, it.deleted, it.blob()) }
        }

        override fun fetchNotebook(notebookUid: String) = server.fetchNotebook(notebookUid)

        override fun cache(entry: PendingEntry, item: NotePushStep.ServerItem) {
            duringCache(entry.noteUid)
            cacheError?.let { throw it }
            cached += "${entry.noteUid}=${item.revision}${if (item.deleted) " deleted" else ""}"
            val there = store.read(entry.noteUid) as? Read.Present
            entryThereAtCacheWrite[entry.noteUid] = there != null
            stateAtCacheWrite[entry.noteUid] = there?.entry?.state
        }

        override fun unsetNotebook(notebookUid: String) {
            unset += notebookUid
        }

        override fun rebase(entry: PendingEntry, onto: NotePushStep.ServerItem): NotePushStep.Built {
            duringBuild()
            rebaseError?.let { throw it }
            return item(entry.blob).copy(base = onto.revision, revision = revision()).let {
                NotePushStep.Built(it.revision, if (builtTooLarge) ByteArray(PendingCodec.MAX_BLOB + 1) else it.blob())
            }
        }

        override fun newNote(entry: PendingEntry, conflictedCopy: Boolean): PendingEntry {
            duringBuild()
            newNoteError?.let { throw it }
            val note = Item("copy-${built.size + 1}", null, revision(), false, item(entry.blob).text)
            built += note.uid
            titledAsCopy[note.uid] = conflictedCopy
            return PendingEntry(note.uid, entry.notebookUid, PendingEntry.State.UPSERT, 0, note.revision, true,
                blob = if (builtTooLarge) ByteArray(PendingCodec.MAX_BLOB + 1) else note.blob())
        }
    }

    private val memory = NotePushStep.Memory()

    private fun revision() = "rev-${++revisions}"

    private fun step(userInitiated: Boolean = true, mayWrite: () -> Boolean = { true }) =
        NotePushStep(store, remote, memory, userInitiated, mayWrite) { now }

    /** One run: a new step and its one pass. Runs the user started skip no entry for backoff. */
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
        save("c", "first")
        save("a", "second", notebook = "b2")
        save("b", "third")
        val result = run()
        assertEquals("by age of the change, not by uid", listOf("c", "a", "b"), uploaded())
        assertEquals(NotePushStep.Result(Ended.COMPLETED, pushed = 3, held = 0, conflicts = emptyMap(), failure = null, carriedFailure = null), result)
        assertTrue(result.succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals(setOf("a", "b", "c"), server.items.keys)
    }

    @Test fun `a store listing that fails ends the step with an error, not with a pass that pushed nothing`() {
        save("a", "first")
        save("b", "second", notebook = "b2")
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) null else d.listFiles() }
        // Read as an empty store, the pass would end COMPLETED with nothing pushed, and the run would
        // record success while both wait. The runner records the error as a storage failure.
        assertThrows(IOException::class.java) { run() }
        assertTrue("nothing went to the server", server.uploads.isEmpty())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("nothing was counted against either", listOf(0, 0),
            listOf("a", "b").map { entry(it).failureCount })
        assertTrue(run().succeeded)
        assertEquals(listOf("a", "b"), uploaded())
        assertTrue(waiting().isEmpty())
    }

    @Test fun `text a discard that has not finished was confirmed for is not sent, and the run is a storage failure`() {
        save("n1", "confirmed for discard")
        save("n2", "not named")
        // As after a restart: the discard permit, which a discard that stopped keeps, names n1 alone.
        PendingNotesDiscardPermits(File(dir.parentFile, PendingNotesDiscardPermits.ROOT), {}, atomicMove,
            PendingNotesStore.nioPresence).record(dir.name, UnsyncedNotes(1, 2, false, names = setOf("n1.note")))
        PendingNotesStore.resetForTesting()
        val s = PendingNotesStore.open(dir, rename = atomicMove)
        val kept = File(dir, "n1.note").readBytes()
        val result = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertEquals(listOf("n2"), uploaded())
        assertEquals(FailureKind.LOCAL, result.failure)
        assertFalse(result.succeeded)
        assertTrue("n1 is kept as it was", kept.contentEquals(File(dir, "n1.note").readBytes()))
    }

    @Test fun `held text a discard that has not finished was confirmed for still keeps the run from success`() {
        save("n1", "confirmed for discard")
        store.hold("n1", HeldReason.LOST_ACCESS, now)
        PendingNotesDiscardPermits(File(dir.parentFile, PendingNotesDiscardPermits.ROOT), {}, atomicMove,
            PendingNotesStore.nioPresence).record(dir.name, UnsyncedNotes(1, 1, false, names = setOf("n1.note")))
        PendingNotesStore.resetForTesting()
        val s = PendingNotesStore.open(dir, rename = atomicMove)
        val result = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertTrue(uploaded().isEmpty())
        assertEquals(FailureKind.LOCAL, result.failure)
    }

    /** The discard permits beside the store, read and written as after a restart. */
    private fun permits() = PendingNotesDiscardPermits(File(dir.parentFile, PendingNotesDiscardPermits.ROOT), {},
        atomicMove, PendingNotesStore.nioPresence)

    /**
     * A new store instance, as after a restart, under a discard permit that names [names]. Every save is made
     * before: the old instance withdrew its permit at its first save and does not ask again.
     */
    private fun restartedUnderPermit(vararg names: String): PendingNotesStore {
        permits().record(dir.name, UnsyncedNotes(names.size, 1, false, names = names.toSet()))
        PendingNotesStore.resetForTesting()
        return PendingNotesStore.open(dir, rename = atomicMove)
    }

    private fun permitBytes() = File(permits().root, "${dir.name}.permit").readBytes()

    @Test fun `after a restart, a note the permit does not name is not rebased, so what the permit names is never sent`() {
        landedWithoutAnswerThenSaved()
        save("n2", "confirmed for discard")
        val s = restartedUnderPermit("n2.note")
        val permit = permitBytes()
        val n2 = File(dir, "n2.note").readBytes()
        val n1 = (s.read("n1") as Read.Present).entry
        val uploads = server.uploads.size
        val fetches = server.fetches.size
        repeat(2) {
            val result = NotePushStep(s, remote, NotePushStep.Memory(), true, { true }) { now }.pass()
            assertEquals("pass $it", FailureKind.LOCAL, result.failure)
            assertFalse(result.succeeded)
        }
        assertEquals("one upload of n1 per pass, and none of n2", listOf("n1", "n1"), uploaded().drop(uploads))
        assertEquals(listOf("n1", "n1"), server.fetches.drop(fetches))
        assertTrue("the permit stays as it was", permit.contentEquals(permitBytes()))
        assertTrue("n2 is kept as it was", n2.contentEquals(File(dir, "n2.note").readBytes()))
        val kept = (s.read("n1") as Read.Present).entry
        assertEquals("n1 is not rebased", n1.version, kept.version)
        assertEquals("one, two", item(kept.blob).text)
        assertEquals("and backs off", 2, kept.failureCount)
    }

    @Test fun `after a restart, a conflict on a note the permit does not name makes no copy, so what the permit names is never sent`() {
        editedElsewhere()
        save("n2", "confirmed for discard")
        val s = restartedUnderPermit("n2.note")
        val permit = permitBytes()
        val n2 = File(dir, "n2.note").readBytes()
        val version = (s.read("n1") as Read.Present).entry.version
        val result = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertEquals(listOf("n1"), uploaded())
        assertTrue("no conflict is reported", result.conflicts.isEmpty())
        assertEquals(FailureKind.LOCAL, result.failure)
        assertFalse(result.succeeded)
        assertTrue("no copy on the server", server.items.keys.none { it.startsWith("copy-") })
        assertTrue("and none in the store", dir.list()!!.none { it.startsWith("copy-") })
        val kept = (s.read("n1") as Read.Present).entry
        assertEquals(PendingEntry.State.UPSERT, kept.state)
        assertEquals("mine", item(kept.blob).text)
        assertEquals(version, kept.version)
        assertEquals("and backs off", 1, kept.failureCount)
        assertEquals(FailureKind.LOCAL.name, kept.lastFailureCategory)
        assertTrue("the permit stays as it was", permit.contentEquals(permitBytes()))
        assertTrue("n2 is kept as it was", n2.contentEquals(File(dir, "n2.note").readBytes()))
    }

    @Test fun `after a restart, a pass whose listing comes back short is still a storage failure while what the permit names is there`() {
        save("n1", "confirmed for discard")
        save("n2", "confirmed for discard too")
        val s = restartedUnderPermit("n1.note", "n2.note")
        // A listing of the store that comes back with nothing, and says nothing.
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) emptyArray() else d.listFiles() }
        val result = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertTrue(uploaded().isEmpty())
        assertEquals(FailureKind.LOCAL, result.failure)
        assertFalse(result.succeeded)
    }

    @Test fun `a permit that names only files that are gone lets a 409 rebase as before, which withdraws it`() {
        landedWithoutAnswerThenSaved()
        val s = restartedUnderPermit("gone.note")
        val uploads = server.uploads.size
        val result = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertTrue(result.succeeded)
        assertEquals("the stale upload and the rebased one", listOf("n1", "n1"), uploaded().drop(uploads))
        assertNull(permits().read(dir.name))
    }

    /** The messages logged while [block] runs. */
    private fun logged(block: () -> Unit): List<String> {
        val lines = mutableListOf<String>()
        val handler = object : java.util.logging.Handler() {
            override fun publish(record: java.util.logging.LogRecord) { lines += record.message }
            override fun flush() = Unit
            override fun close() = Unit
        }
        io.silentsuite.sync.log.Logger.log.addHandler(handler)
        try {
            block()
        } finally {
            io.silentsuite.sync.log.Logger.log.removeHandler(handler)
        }
        return lines
    }

    private val heldBackPass = "Notes changes wait: a discard that has not finished holds them back"

    @Test fun `after a restart, a permit that cannot be read holds back every note, and the pass is a storage failure`() {
        save("n1", "confirmed for discard")
        save("n2", "not named")
        val s = restartedUnderPermit("n1.note")
        val permit = permitBytes()
        PendingNotesDiscardPermits.onReadForTesting = {
            if (it.name.endsWith(".permit")) throw IOException("the read fails")
        }
        var result: NotePushStep.Result? = null
        val lines = logged { result = NotePushStep(s, remote, memory, true, { true }) { now }.pass() }
        assertTrue("nothing is uploaded", uploaded().isEmpty())
        assertEquals(FailureKind.LOCAL, result!!.failure)
        assertFalse(result!!.succeeded)
        assertTrue("the permit stays as it was", permit.contentEquals(permitBytes()))
        assertEquals("one line gives the reason", listOf(heldBackPass), lines.filter { "discard" in it })
        assertTrue("and no text", lines.none { "confirmed for discard" in it || "not named" in it })
        // Once it reads again, the next pass sends what the permit does not name, and still holds back what it does.
        PendingNotesDiscardPermits.onReadForTesting = null
        val next = NotePushStep(s, remote, memory, true, { true }) { now }.pass()
        assertEquals(listOf("n2"), uploaded())
        assertEquals(FailureKind.LOCAL, next.failure)
        assertTrue("n1 waits", s.read("n1") is Read.Present)
    }

    @Test fun `a rebase and a conflict copy declined while a discard has not finished leave one line in the log each, with the reason and no text`() {
        landedWithoutAnswerThenSaved()
        server.writeElsewhere("m", "web-1")
        save("m", "mine", seen = "srv-0")
        save("n2", "confirmed for discard")
        val s = restartedUnderPermit("n2.note")
        val lines = logged { NotePushStep(s, remote, memory, true, { true }) { now }.pass() }
        assertEquals("the rebase of n1 and the copy of m",
            List(2) { "A Notes change waits as it is: a discard that has not finished holds back new versions" },
            lines.filter { it.startsWith("A Notes change waits") })
        assertEquals("and one line for the pass", listOf(heldBackPass), lines.filter { it == heldBackPass })
        assertTrue("no text", lines.none { "mine" in it || "one, two" in it || "confirmed for discard" in it })
        assertTrue("no copy was made", dir.list()!!.none { it.startsWith("copy-") })
    }

    @Test fun `a store listing that fails while a notebook's entries are held is a storage failure, not a pass`() {
        save("a", "one")
        server.uploadError = { PermissionDeniedException("no_write_access") }
        // The store cannot be listed from the moment the notebook is confirmed read-only.
        var listingFails = true
        val failing: (File) -> Array<File>? = { d -> if (d.name == dir.name) null else d.listFiles() }
        server.notebookAnswer = {
            if (listingFails) PendingNotesStore.listFilesForTesting = failing
            NotebookCheck.Found(readOnly = true, deleted = false)
        }
        val result = run()
        // Read as an empty store, the listing that holds the notebook's entries would hold none, and the
        // run would record success while "a" waits, neither held nor failed.
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(0, result.held)
        assertEquals(listOf("a"), uploaded())
        listingFails = false
        PendingNotesStore.listFilesForTesting = null
        assertEquals(PendingEntry.State.UPSERT, entry("a").state)
        assertEquals(1, entry("a").failureCount)
        // With the store listed again, the next run holds it.
        assertEquals(1, run().held)
        assertEquals(HeldReason.READ_ONLY, entry("a").held?.reason)
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

    @Test fun `a step is one run and cannot be run twice`() {
        save("a", "one")
        val step = step()
        assertTrue(step.pass().succeeded)
        assertThrows(IllegalStateException::class.java) { step.pass() }
    }

    // ---- notebooks that take no pushes (3.3 step 1) ----

    @Test fun `changes in a notebook that is read-only, deleted or gone are held without an upload`() {
        notebooks["ro"] = Notebook.READ_ONLY
        notebooks["del"] = Notebook.DELETED
        notebooks["gone"] = Notebook.MISSING
        save("e1", "one", notebook = "ro")
        save("e2", "two", notebook = "del")
        save("e3", "three", notebook = "gone")
        save("ok", "fine")
        val result = run()
        assertEquals("only the writable notebook's change is sent", listOf("ok"), uploaded())
        assertEquals(3, result.held)
        assertEquals(1, result.pushed)
        assertTrue("held text is a handled outcome, not a failure", result.succeeded)
        assertEquals(HeldReason.READ_ONLY, entry("e1").held?.reason)
        assertEquals(HeldReason.NOTEBOOK_DELETED, entry("e2").held?.reason)
        assertEquals(HeldReason.LOST_ACCESS, entry("e3").held?.reason)
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

    @Test fun `among skipped entries the most recent failure is the one carried, and a failure of the run's own is reported next to it`() {
        save("a", "one")
        save("c", "three")
        // c failed first and a after it, while a is the older change and so is looked at first.
        store.recordFailure("c", entry("c").version, FailureKind.TRANSIENT.name, now)
        now += 1_000
        store.recordFailure("a", entry("a").version, FailureKind.REJECTED.name, now)
        now += 1_000
        val carried = run(userInitiated = false)
        assertTrue("both sat out the run", server.uploads.isEmpty())
        assertNull(carried.failure)
        assertEquals("a failed after c", FailureKind.REJECTED.name, carried.carriedFailure)
        save("d", "four")
        server.uploadError = { if (it.uid == "d") IOException("could not encode") else null }
        val own = run(userInitiated = false)
        assertEquals(FailureKind.LOCAL, own.failure)
        assertEquals(FailureKind.REJECTED.name, own.carriedFailure)
    }

    @Test fun `a skipped entry that the same run then holds is not carried`() {
        // b is in backoff and is skipped first (one failure). a, in the same notebook, has two older
        // failures and is past its backoff; it is answered 403, and the notebook turns out to be
        // read-only: both are held, and nothing is left stuck.
        save("a", "one")
        save("b", "two")
        repeat(2) { store.recordFailure("a", entry("a").version, FailureKind.TRANSIENT.name, now - 600_000) }
        store.recordFailure("b", entry("b").version, FailureKind.TRANSIENT.name, now - 10_000)
        server.uploadError = { PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = true, deleted = false) }
        val heldBoth = run(userInitiated = false)
        assertEquals(listOf("a"), uploaded())
        assertEquals(2, heldBoth.held)
        assertNull(heldBoth.carriedFailure)
        assertTrue(heldBoth.succeeded)
    }

    @Test fun `a run that ends in a 401 still carries the failure of an entry it skipped`() {
        // d is in backoff and is skipped before c's push gets the 401.
        save("c", "three", notebook = "b2")
        save("d", "four", notebook = "b2")
        repeat(2) { store.recordFailure("c", entry("c").version, FailureKind.TRANSIENT.name, now - 600_000) }
        store.recordFailure("d", entry("d").version, FailureKind.TRANSIENT.name, now - 59_000)
        server.uploadError = { UnauthorizedException("Invalid token.") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = false, deleted = false) }
        val ended = run(userInitiated = false)
        assertEquals(Ended.NEEDS_AUTHENTICATION, ended.ended)
        assertEquals(listOf("c"), uploaded())
        assertEquals(FailureKind.TRANSIENT.name, ended.carriedFailure)
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

    // ---- 401: the step ends, no failure is recorded, and the next run goes on ----

    @Test fun `a 401 on a push ends the step and records no failure on any entry, and the next run sends what was left`() {
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
        val first = run(userInitiated = false)
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertFalse(first.succeeded)
        assertEquals("nothing is sent after the 401", listOf("a", "b", "c"), uploaded())
        assertEquals("what the run did before the 401 stands", 1, first.pushed)
        assertEquals(FailureKind.REJECTED, first.failure)
        assertEquals(1, entry("b").failureCount)
        assertEquals("the request that got the 401 recorded no failure", 0, entry("c").failureCount)
        assertNull(entry("c").lastFailureCategory)
        assertEquals("and neither did the entry after it", 0, entry("d").failureCount)
        assertTrue("which was not sent", entry("d").sent.isEmpty())
        assertNull("a 401 is about the account, so no note is remembered for it", memory.endedLastStep)
        // The next run has a session again. c has no backoff and is sent; b waits out its own.
        unauthorized = false
        val next = run(userInitiated = false)
        assertEquals(Ended.COMPLETED, next.ended)
        assertEquals(listOf("a", "b", "c", "c", "d"), uploaded())
        assertEquals("each run counts its own", 2, next.pushed)
        assertNull(next.failure)
        assertEquals(FailureKind.REJECTED.name, next.carriedFailure)
        assertEquals("one rejection, so pending and not held", PendingEntry.State.UPSERT, entry("b").state)
        assertEquals(listOf("b"), waiting())
    }

    @Test fun `a copy whose first push got the 401 is sent again by the next run, and no second copy is made`() {
        editedElsewhere()
        var unauthorized = true
        server.uploadError = { if (unauthorized && it.uid == "copy-1") UnauthorizedException("Invalid token.") else null }
        val first = run()
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertEquals("the copy was made, and its push got the 401", listOf("n1", "copy-1"), uploaded())
        assertEquals("the conflict is reported by the run that made the copy", mapOf("b1" to 1), first.conflicts)
        assertEquals(0, entry("copy-1").failureCount)
        assertEquals("the text waits in its copy", listOf("copy-1"), waiting())
        unauthorized = false
        val next = run()
        assertEquals(Ended.COMPLETED, next.ended)
        assertEquals("the original is not sent again, and no second copy is made", listOf("n1", "copy-1", "copy-1"), uploaded())
        assertEquals(listOf("copy-1"), built)
        assertTrue("the conflict is not reported twice", next.conflicts.isEmpty())
        assertEquals(1, next.pushed)
        assertTrue(next.succeeded)
        assertNotNull(server.items["copy-1"])
        assertTrue(waiting().isEmpty())
    }

    @Test fun `an entry whose push after a rebase got the 401 lands in the next run`() {
        val ours = landedWithoutAnswerThenSaved()
        server.uploads.clear()
        var unauthorized = true
        server.uploadError = { if (unauthorized && it.base == ours) UnauthorizedException("Invalid token.") else null }
        val first = run()
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertEquals("the stale upload, then the rebased one, which got the 401", 2, server.uploads.size)
        assertEquals(1, server.fetches.size)
        assertEquals(0, entry("n1").failureCount)
        unauthorized = false
        val next = run()
        assertTrue(next.succeeded)
        assertEquals(1, next.pushed)
        assertEquals("the rebase was stored, so the next run sends the rebased item", 3, server.uploads.size)
        assertEquals("and needs no fetch", 1, server.fetches.size)
        assertTrue(built.isEmpty())
        assertTrue(waiting().isEmpty())
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
        for (uid in listOf("a", "b", "c")) {
            assertEquals(PendingEntry.State.UPSERT, entry(uid).state)
            assertEquals(1, entry(uid).failureCount)
        }
    }

    @Test fun `a redirect on the notebook fetch says nothing about the notebook either`() {
        threeInOneNotebook()
        server.uploadError = { NotFoundException("Collection matching query does not exist.") }
        server.notebookAnswer = { NotFoundException("Got a redirect - should never happen") }
        val result = run()
        assertEquals(listOf("a", "b", "c"), uploaded())
        assertEquals(listOf("b1"), server.notebookFetches)
        assertEquals("not taken for a notebook that is gone", 0, result.held)
        assertTrue(unset.isEmpty())
        for (uid in listOf("a", "b", "c")) assertEquals(1, entry(uid).failureCount)
    }

    @Test fun `a confirmed refusal also holds an entry of that notebook that failed earlier in the run`() {
        threeInOneNotebook()
        server.uploadError = { if (it.uid == "a") http(500) else PermissionDeniedException("no_write_access") }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = true, deleted = false) }
        val result = run()
        assertEquals(listOf("a", "b"), uploaded())
        assertEquals("the notebook takes no pushes, so its text belongs in the holding area, a's too", 3, result.held)
        for (uid in listOf("a", "b", "c")) assertEquals(HeldReason.READ_ONLY, entry(uid).held?.reason)
        assertEquals("the failure a had before the answer stays on record", 1, entry("a").failureCount)
        assertEquals("and stays the run's failure: that request did fail in this run", FailureKind.TRANSIENT, result.failure)
        assertFalse(result.succeeded)
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
            val kind = if (answer is PermissionDeniedException) FailureKind.READ_ONLY else FailureKind.TRANSIENT
            assertEquals(name, kind, result.failure)
            assertEquals(name, kind.name, entry(uids[0]).lastFailureCategory)
            assertEquals("$name: the others are untouched, in both notebooks", listOf(0, 0), uids.drop(1).map { entry(it).failureCount })
            assertEquals(name, uids[0], memory.endedLastStep)
            // Clear the store for the next answer.
            uids.forEach { store.discard(it) }
        }
    }

    @Test fun `a 403 confirmed as read-only holds the notebook's other entries without an upload`() {
        threeInOneNotebook()
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

    @Test fun `an entry that a confirmed refusal could not hold is still not uploaded in that run`() {
        threeInOneNotebook()
        server.uploadError = { if (it.uid == "a") PermissionDeniedException("no_write_access") else null }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = false, deleted = true) }
        var failedOnce = false
        PendingNotesStore.beforeRenameForTesting = {
            if (!failedOnce && it.name == "b.note") {
                failedOnce = true
                throw IOException("no space left on device")
            }
        }
        val result = run()
        assertEquals("the server would take a write into the deleted notebook, so b is not sent", listOf("a"), uploaded())
        assertEquals(2, result.held)
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(PendingEntry.State.UPSERT, entry("b").state)
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

    @Test fun `a save while the step settles a 409 that is its own upload is rebased onto that upload`() {
        val first = save("y", "one")
        // The upload lands and is answered 409 all the same, so the step fetches the copy and finds its own.
        server.answerConflictAfterLanding = true
        // The user saves again after the step read the entry, while the server's copy goes into the cache.
        duringCache = { uid ->
            if (uid == "y") {
                duringCache = {}
                save("y", "one, two")
            }
        }
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(1, result.pushed)
        val kept = entry("y")
        assertEquals("one, two", item(kept.blob).text)
        assertEquals("built on the revision that landed", first.revision, item(kept.blob).base)
        // The save's own run sends it, and it lands with no conflict.
        server.answerConflictAfterLanding = false
        server.uploads.clear()
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals("one upload, and no 409", 1, server.uploads.size)
        assertEquals("only the first run's fetch", 1, server.fetches.size)
        assertEquals("one, two", server.items.getValue("y").text)
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
        assertEquals("and the copy's server copy too", listOf("n1=srv-invented-1", "copy-1=srv-invented-2"), cached)
        assertEquals("while the copy was still waiting, so before it was held", PendingEntry.State.UPSERT, stateAtCacheWrite["copy-1"])
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
        assertEquals("the deletion was cached before the edit was replaced", true, entryThereAtCacheWrite["n1"])
        assertTrue(waiting().isEmpty())
        assertNotNull(server.items["copy-1"])
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
        val first = run()
        assertEquals(FailureKind.LOCAL, first.failure)
        assertEquals("the text has its new note, so the conflict is reported now", mapOf("b1" to 1), first.conflicts)
        assertEquals("the storage failure is recorded for the original", 1, entry("n1").failureCount)
        assertEquals(0, entry("copy-1").failureCount)
        repeat(5) { n ->
            val result = run()
            assertEquals("run $n: never a success over them", FailureKind.LOCAL, result.failure)
            assertEquals("run $n", 0, result.pushed)
            assertEquals("run $n: and once more for the original", n + 2, entry("n1").failureCount)
            assertTrue("run $n: reported once, not in every run", result.conflicts.isEmpty())
        }
        assertEquals(FailureKind.LOCAL.name, entry("n1").lastFailureCategory)
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

    @Test fun `discarding the copy while the original cannot be removed does not bring the text back as a second copy`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        run()
        // The user discards the conflicted copy. The discard fails with the removal, and both notes stay.
        assertThrows(IOException::class.java) { store.discard("copy-1") }
        run()
        failing = false
        store.discard("copy-1")
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

    // ---- a pending store that fails ----

    @Test fun `a store removal that fails for one entry is that entry's failure, and the others are still pushed`() {
        save("a", "one")
        save("b", "two")
        save("c", "three")
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = { if (failing && it.name == "a.note") throw IOException("could not remove a.note") }
        val first = run()
        assertEquals("the run goes on past the entry whose file could not be dropped", listOf("a", "b", "c"), uploaded())
        assertEquals(Ended.COMPLETED, first.ended)
        assertEquals(FailureKind.LOCAL, first.failure)
        assertEquals(2, first.pushed)
        assertEquals(listOf("a"), waiting())
        assertEquals("it backs off like any failed entry", 1, entry("a").failureCount)
        assertEquals(FailureKind.LOCAL.name, entry("a").lastFailureCategory)
        failing = false
        assertTrue("the resend of the revision that landed is taken as done", run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a store write that fails before the upload sends nothing for that entry and goes on with the next`() {
        save("a", "one")
        save("b", "two")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "a.note") throw IOException("no space left on device") }
        val result = run()
        assertEquals("a's sent revision could not be recorded, so a is not uploaded", listOf("b"), uploaded())
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(Ended.COMPLETED, result.ended)
        assertEquals(1, result.pushed)
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals("the text is untouched", "one", item(entry("a").blob).text)
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a failure that cannot be written down still ends the step when the error is not about one entry`() {
        save("a", "one")
        save("b", "two")
        // Both failed in an earlier run, so their revisions are already recorded as sent and the next
        // send has nothing to write before the upload.
        server.uploadError = { http(500) }
        run()
        server.uploads.clear()
        // The store can no longer write, and the server stops answering.
        PendingNotesStore.beforeRenameForTesting = { if (it.name.endsWith(".note")) throw IOException("no space left on device") }
        server.uploadError = { ConnectionException("timeout") }
        val result = run()
        assertEquals("one request and one timeout, not one per waiting entry", listOf("a"), uploaded())
        assertEquals(Ended.STOPPED, result.ended)
        assertEquals(FailureKind.TRANSIENT, result.failure)
        assertEquals("a", memory.endedLastStep)
    }

    @Test fun `a newer change that cannot be stored on the item that landed leaves the push counted and nothing recorded against it`() {
        save("a", "text")
        duringUpload = {
            duringUpload = {}
            save("a", "text, and more")
            // From here on the entry's file cannot be rewritten: the next write is the rebase.
            PendingNotesStore.beforeRenameForTesting = { if (it.name == "a.note") throw IOException("no space left on device") }
        }
        val result = run()
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals("the upload did land", 1, result.pushed)
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals("the newer text was never sent, so it has no failure of its own", 0, entry("a").failureCount)
        assertNull("still on its old base", item(entry("a").blob).base)
        assertTrue(run().succeeded)
        assertEquals("text, and more", server.items.getValue("a").text)
    }

    @Test fun `a conflict is not reported while its copy could not be written, and is reported by the run that makes the copy`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRenameForTesting = { if (failing && it.name == "copy-1.note") throw IOException("no space left on device") }
        val failed = run()
        assertEquals(FailureKind.LOCAL, failed.failure)
        assertTrue("the text has no new note yet", failed.conflicts.isEmpty())
        assertEquals(listOf("n1"), waiting())
        assertEquals(1, entry("n1").failureCount)
        failing = false
        val result = run()
        assertEquals(mapOf("b1" to 1), result.conflicts)
        assertTrue(result.succeeded)
        assertEquals("one copy on the server", 1, server.items.keys.count { it.startsWith("copy-") })
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a notebook whose cached state cannot be read fails the pass before anything is held`() {
        notebooks["ro"] = Notebook.READ_ONLY
        save("e1", "one", notebook = "ro")
        save("e2", "two", notebook = "unreadable")
        notebookLookupError = { if (it == "unreadable") IllegalStateException("cache entry cannot be read") else null }
        assertThrows(IllegalStateException::class.java) { run() }
        assertEquals("nothing was written before the failure", PendingEntry.State.UPSERT, entry("e1").state)
        assertTrue(server.uploads.isEmpty())
        notebookLookupError = { null }
        assertEquals(1, run().held)
    }

    @Test fun `a hold that cannot be written is that entry's failure, and the run goes on`() {
        notebooks["ro"] = Notebook.READ_ONLY
        save("e", "one", notebook = "ro")
        save("ok", "fine")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "e.note") throw IOException("no space left on device") }
        val result = run()
        assertEquals(listOf("ok"), uploaded())
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(0, result.held)
        assertEquals(1, result.pushed)
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals("not held, and still there", PendingEntry.State.UPSERT, entry("e").state)
        assertEquals(1, run().held)
    }

    @Test fun `a copy whose link cannot be cleared is never a success, and its conflict is reported once`() {
        editedElsewhere()
        var failing = true
        var copyWrites = 0
        // The copy's first write commits. Every later write of its file, which is the one that clears
        // the link, fails.
        PendingNotesStore.beforeRenameForTesting = {
            if (failing && it.name == "copy-1.note" && ++copyWrites >= 2) throw IOException("no space left on device")
        }
        val first = run()
        assertEquals(FailureKind.LOCAL, first.failure)
        assertEquals("the text has its new note", mapOf("b1" to 1), first.conflicts)
        assertEquals("the original is gone", Read.Missing, store.read("n1"))
        repeat(3) { n ->
            val result = run()
            assertEquals("run $n", FailureKind.LOCAL, result.failure)
            assertFalse("run $n: the copy is not sent, and that is not a success", result.succeeded)
            assertEquals("run $n", 0, result.pushed)
            assertTrue("run $n", result.conflicts.isEmpty())
        }
        assertEquals(listOf("n1"), uploaded())
        failing = false
        assertTrue(run().succeeded)
        assertEquals(listOf("n1", "copy-1"), uploaded())
        assertTrue(waiting().isEmpty())
    }

    @Test fun `an entry whose text cannot be read is not passed over in silence in a notebook that takes no pushes`() {
        notebooks["ro"] = Notebook.READ_ONLY
        save("e", "one", notebook = "ro")
        // Damage the blob, behind a header that still reads on its own.
        val file = File(dir, "e.note")
        val bytes = file.readBytes()
        bytes[bytes.size - 6] = (bytes[bytes.size - 6].toInt() xor 0x40).toByte()
        file.writeBytes(bytes)
        val result = run()
        assertEquals(0, result.held)
        assertEquals(FailureKind.LOCAL, result.failure)
        assertTrue(server.uploads.isEmpty())
        assertEquals("kept as it is", bytes.size.toLong(), file.length())
    }

    @Test fun `an unfinished original in a notebook that takes no pushes is not held next to its copy`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        run()
        notebooks["b1"] = Notebook.READ_ONLY
        val result = run()
        assertEquals("the text is held once, through the copy", 1, result.held)
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
        assertEquals(PendingEntry.State.HELD, entry("copy-1").state)
        failing = false
        assertEquals("recovery removes the original, and the copy stays held", listOf("copy-1"), waiting())
        assertNull(entry("copy-1").origin)
        assertEquals(PendingEntry.State.HELD, entry("copy-1").state)
    }

    // ---- more places a 401 can arrive ----

    @Test fun `a hold made before a 401 in the same run stays`() {
        save("a", "one")
        save("c", "three", notebook = "b2")
        server.uploadError = {
            if (it.uid == "a") PermissionDeniedException("no_write_access") else UnauthorizedException("Invalid token.")
        }
        server.notebookAnswer = { NotebookCheck.Found(readOnly = false, deleted = it == "b1") }
        val ended = run()
        assertEquals(Ended.NEEDS_AUTHENTICATION, ended.ended)
        assertEquals(listOf("a", "c"), uploaded())
        assertEquals(1, ended.held)
        assertEquals(HeldReason.NOTEBOOK_DELETED, entry("a").held?.reason)
        assertEquals(0, entry("c").failureCount)
    }

    @Test fun `a 401 on the fetch after a 409 records no failure, and the next run resolves the conflict`() {
        editedElsewhere()
        var unauthorized = true
        server.fetchError = { if (unauthorized) UnauthorizedException("Invalid token.") else null }
        val first = run()
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertTrue(first.conflicts.isEmpty())
        assertEquals(0, entry("n1").failureCount)
        assertTrue(built.isEmpty())
        unauthorized = false
        val next = run()
        assertTrue(next.succeeded)
        assertEquals(listOf("copy-1"), built)
        assertEquals(listOf("n1", "n1", "copy-1"), uploaded())
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a 401 on the confirming notebook fetch records no failure, and the next run makes that fetch again`() {
        save("a", "one")
        var unauthorized = true
        server.uploadError = { PermissionDeniedException("no_write_access") }
        server.notebookAnswer = {
            if (unauthorized) UnauthorizedException("Invalid token.") else NotebookCheck.Found(readOnly = false, deleted = false)
        }
        val first = run()
        assertEquals(Ended.NEEDS_AUTHENTICATION, first.ended)
        assertEquals(0, entry("a").failureCount)
        unauthorized = false
        val next = run()
        assertEquals("each run makes its own confirming fetch", listOf("b1", "b1"), server.notebookFetches)
        assertEquals(listOf("a", "a"), uploaded())
        assertEquals(1, entry("a").failureCount)
        assertEquals(Ended.COMPLETED, next.ended)
    }

    // ---- the result is built from the entry as it is when the answer arrives (3.3 step 4) ----

    @Test fun `a save during an upload that conflicts with another client's copy goes into the one copy that is made`() {
        editedElsewhere()
        duringUpload = { uid ->
            if (uid == "n1") {
                duringUpload = {}
                save("n1", "mine, and more")
            }
        }
        val result = run()
        assertTrue(result.succeeded)
        assertEquals(listOf("copy-1"), built)
        assertEquals("mine, and more", server.items.getValue("copy-1").text)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a failure of the upload is recorded against the text that was sent, not against text saved during it`() {
        save("a", "too odd")
        server.uploadError = { http(400) }
        run()
        assertEquals(FailureKind.REJECTED.name, entry("a").lastFailureCategory)
        // The second rejection in a row arrives for the old text, while the user has saved again.
        duringUpload = {
            duringUpload = {}
            save("a", "changed during the upload")
        }
        val result = run()
        assertEquals("the newer text is not held with the text that was rejected", 0, result.held)
        assertEquals(PendingEntry.State.UPSERT, entry("a").state)
        assertEquals(0, entry("a").failureCount)
        assertEquals("changed during the upload", item(entry("a").blob).text)
        // The same for a server error.
        save("b", "text")
        server.uploadError = { if (it.uid == "b") http(500) else null }
        duringUpload = { uid ->
            if (uid == "b") {
                duringUpload = {}
                save("b", "text, and more")
            }
        }
        run()
        assertEquals(0, entry("b").failureCount)
    }

    // ---- the cache write comes first on every path that lets a note fall back to the cache ----

    @Test fun `if the cache cannot take the server's copy a conflict is not resolved, and the next run makes the one copy`() {
        editedElsewhere()
        cacheError = IOException("disk full")
        val failed = run()
        assertEquals(FailureKind.LOCAL, failed.failure)
        assertTrue(failed.conflicts.isEmpty())
        assertEquals("the original stays, with no copy beside it", listOf("n1"), waiting())
        assertEquals(1, entry("n1").failureCount)
        cacheError = null
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
        assertEquals("one copy on the server", 1, server.items.keys.count { it.startsWith("copy-") })
    }

    @Test fun `if the cache cannot take the server's copy an upload that is found to have landed stays pending`() {
        save("y", "one")
        // The upload lands and is answered 409 all the same, so the step fetches the copy and finds its own.
        server.answerConflictAfterLanding = true
        cacheError = IOException("disk full")
        val failed = run()
        assertEquals(FailureKind.LOCAL, failed.failure)
        assertEquals(0, failed.pushed)
        assertEquals(listOf("y"), waiting())
        cacheError = null
        server.answerConflictAfterLanding = false
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    /**
     * The copy of n1 was uploaded and landed, its answer was lost, and another client then wrote to the
     * copy: the copy's next push meets a conflict that is not ours while it still carries its mark.
     */
    private fun copyLandedWithoutAnswerThenWrittenElsewhere(deleted: Boolean = false) {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(Ended.STOPPED, run().ended)
        loseAnswer = { false }
        assertTrue("still marked: the device never saw the upload land", entry("copy-1").fromConflict)
        server.writeElsewhere("copy-1", "web-2", deleted)
        cached.clear()
        stateAtCacheWrite.clear()
    }

    @Test fun `text held for a repeated conflict falls back to the server's copy, which is in the cache before the hold`() {
        copyLandedWithoutAnswerThenWrittenElsewhere()
        val result = run()
        assertEquals("the text is held, and the run has no failure of its own",
            NotePushStep.Result(Ended.COMPLETED, pushed = 0, held = 1, conflicts = emptyMap(), failure = null, carriedFailure = null), result)
        val held = entry("copy-1")
        assertEquals(HeldReason.REPEATED_CONFLICT, held.held?.reason)
        assertEquals("the text survives", "mine", item(held.blob).text)
        assertEquals("the other client's version is what the note's row falls back to, so it was written into the cache",
            listOf("copy-1=web-2"), cached)
        assertEquals("and before the hold: the text was still waiting at that moment", PendingEntry.State.UPSERT, stateAtCacheWrite["copy-1"])
        assertEquals("no second note", listOf("copy-1"), built)
    }

    @Test fun `a repeated conflict with a copy deleted elsewhere puts the deletion into the cache before the hold`() {
        copyLandedWithoutAnswerThenWrittenElsewhere(deleted = true)
        assertEquals(1, run().held)
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertEquals("so a note deleted elsewhere does not stay in the list under the held text",
            listOf("copy-1=web-2 deleted"), cached)
        assertEquals(PendingEntry.State.UPSERT, stateAtCacheWrite["copy-1"])
    }

    @Test fun `text whose repeated conflict cannot be cached first is not held, and waits with a storage failure`() {
        copyLandedWithoutAnswerThenWrittenElsewhere()
        cacheError = IllegalStateException("the cache could not be written")
        val result = run()
        assertEquals(0, result.held)
        assertEquals(FailureKind.LOCAL, result.failure)
        val waiting = entry("copy-1")
        assertEquals(PendingEntry.State.UPSERT, waiting.state)
        assertTrue("still marked, so the next run holds it and makes no second note", waiting.fromConflict)
        assertEquals(FailureKind.LOCAL.name, waiting.lastFailureCategory)
        assertEquals("the lost answer, and now the cache", 2, waiting.failureCount)
        assertEquals("mine", item(waiting.blob).text)
        // Once the cache takes the write, the same run of events ends in the hold.
        cacheError = null
        assertEquals(1, run().held)
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertEquals(listOf("copy-1=web-2"), cached)
        assertEquals("and no second note was made on the way", listOf("copy-1"), built)
    }

    @Test fun `a refused marked note that moved on during the upload gets no cache write, so a cache that cannot be written is not its failure`() {
        save("n1", "mine", seen = "srv-0")
        server.refuseEveryPush = true
        server.inventCopies = true
        duringUpload = { uid ->
            if (uid == "copy-1") {
                duringUpload = {}
                save("copy-1", "mine, and more")
                // From here on the cache takes no write. Nothing about this entry needs one: no hold follows.
                cacheError = IllegalStateException("the cache could not be written")
            }
        }
        val result = run()
        assertEquals(0, result.held)
        assertNull("no hold follows, so no cache write was owed", result.failure)
        assertEquals("only the original's server copy, written before the original was replaced", listOf("n1=srv-invented-1"), cached)
        val pending = entry("copy-1")
        assertEquals(PendingEntry.State.UPSERT, pending.state)
        assertEquals(0, pending.failureCount)
        assertEquals("mine, and more", item(pending.blob).text)
    }

    @Test fun `a run that is no longer current at the cache write holds nothing for a repeated conflict and records nothing`() {
        copyLandedWithoutAnswerThenWrittenElsewhere()
        cacheError = StaleSyncRunException()
        assertThrows(StaleSyncRunException::class.java) { run() }
        val waiting = entry("copy-1")
        assertEquals(PendingEntry.State.UPSERT, waiting.state)
        assertEquals("only the lost answer", 1, waiting.failureCount)
        assertTrue(waiting.fromConflict)
    }

    // ---- a note that cannot be built for the upload ----

    @Test fun `a conflict copy that does not read back holds the text with that reason, and is not tried again`() {
        editedElsewhere()
        newNoteError = NotePushStep.NotBuilt(HeldReason.READ_BACK_FAILED, "did not read back as written")
        val result = run()
        assertEquals("the text is held, and the run has no failure of its own",
            NotePushStep.Result(Ended.COMPLETED, pushed = 0, held = 1, conflicts = emptyMap(), failure = null, carriedFailure = null), result)
        val held = entry("n1")
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.READ_BACK_FAILED, held.held!!.reason)
        assertEquals("the text survives", "mine", item(held.blob).text)
        assertEquals("nothing is counted against it as a failure", 0, held.failureCount)
        assertNull("and no storage error is on record for it", held.lastFailureCategory)
        assertTrue("no copy was made", built.isEmpty())
        assertEquals("the server's version stays", "web-1", server.items.getValue("n1").revision)
        assertEquals("and it is what the note's row falls back to, so it was written into the cache before the hold",
            listOf("n1=web-1"), cached)
        assertEquals("the text was still waiting at that moment", true, entryThereAtCacheWrite["n1"])

        // Held text is not pushed: the next runs send nothing for it, however often they come.
        server.uploads.clear()
        repeat(3) { assertTrue(run(userInitiated = it == 0).succeeded) }
        assertTrue(server.uploads.isEmpty())
        assertEquals("mine", item(entry("n1").blob).text)

        // Try again by hand, once the copy can be made: the text gets its note.
        assertTrue(store.release("n1"))
        newNoteError = null
        val retried = run()
        assertTrue(retried.succeeded)
        assertEquals(listOf("copy-1"), built)
        assertEquals("mine", server.items.getValue("copy-1").text)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a conflict copy that cannot be made for another reason holds the text as not built`() {
        editedElsewhere()
        newNoteError = IllegalStateException("could not encrypt")
        val result = run()
        assertEquals(1, result.held)
        assertNull("not a storage failure", result.failure)
        val held = entry("n1")
        assertEquals(HeldReason.NOT_BUILT, held.held!!.reason)
        assertEquals("mine", item(held.blob).text)
        assertEquals(0, held.failureCount)
        assertTrue(result.conflicts.isEmpty())
    }

    @Test fun `a change that cannot go onto metadata it cannot write into is held with its text, and nothing more is sent`() {
        landedWithoutAnswerThenSaved()
        server.uploads.clear()
        rebaseError = NotePushStep.NotBuilt(HeldReason.UNREADABLE_METADATA, "not one map")
        val result = run()
        assertEquals(1, result.held)
        assertNull(result.failure)
        assertEquals("only the push that met the conflict", listOf("n1"), uploaded())
        val held = entry("n1")
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.UNREADABLE_METADATA, held.held!!.reason)
        assertEquals("one, two", item(held.blob).text)
        assertEquals("the server keeps the upload that landed", "one", server.items.getValue("n1").text)
        assertEquals("and that upload, which the cache never got, is in it before the hold",
            listOf("n1=${server.items.getValue("n1").revision}"), cached)
        assertEquals("while the text was still waiting, so before the hold", PendingEntry.State.UPSERT, stateAtCacheWrite["n1"])

        server.uploads.clear()
        assertTrue(run().succeeded)
        assertTrue("held text is not sent again", server.uploads.isEmpty())
    }

    @Test fun `a rebase that fails for another reason is held as not built too`() {
        landedWithoutAnswerThenSaved()
        rebaseError = IllegalStateException("could not decrypt")
        val result = run()
        assertEquals(1, result.held)
        assertNull(result.failure)
        assertEquals(HeldReason.NOT_BUILT, entry("n1").held!!.reason)
        assertEquals("one, two", item(entry("n1").blob).text)
    }

    @Test fun `a rebase too large for the store holds the text as not built, and is not tried again`() {
        landedWithoutAnswerThenSaved()
        server.uploads.clear()
        builtTooLarge = true
        val result = run()
        assertEquals(1, result.held)
        assertNull("not a storage failure", result.failure)
        val held = entry("n1")
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.NOT_BUILT, held.held!!.reason)
        assertEquals("the text survives", "one, two", item(held.blob).text)
        assertEquals(0, held.failureCount)
        assertNull(held.lastFailureCategory)
        assertEquals("only the push that met the conflict", listOf("n1"), uploaded())

        server.uploads.clear()
        assertTrue(run().succeeded)
        assertTrue("held text is not sent again", server.uploads.isEmpty())
    }

    @Test fun `a conflict copy too large for the store holds the text as not built, and no copy is kept`() {
        editedElsewhere()
        builtTooLarge = true
        val result = run()
        assertEquals("the text is held, and the run has no failure of its own",
            NotePushStep.Result(Ended.COMPLETED, pushed = 0, held = 1, conflicts = emptyMap(), failure = null, carriedFailure = null), result)
        val held = entry("n1")
        assertEquals(HeldReason.NOT_BUILT, held.held!!.reason)
        assertEquals("mine", item(held.blob).text)
        assertEquals(0, held.failureCount)
        assertEquals("no copy was kept", listOf("n1"), waiting())
        assertEquals("the server's version went into the cache before the hold", listOf("n1=web-1"), cached)

        server.uploads.clear()
        repeat(2) { assertTrue(run().succeeded) }
        assertTrue("held text is not sent again", server.uploads.isEmpty())

        // Try again by hand, once the copy fits: the text gets its note.
        assertTrue(store.release("n1"))
        builtTooLarge = false
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a newer change too large to rebase onto the item that landed is not a storage failure, and the next run holds it`() {
        save("a", "text")
        duringUpload = {
            duringUpload = {}
            save("a", "text, and more")
        }
        builtTooLarge = true
        val result = run()
        assertEquals(1, result.pushed)
        assertTrue("no storage failure", result.succeeded)
        assertNull("still on its old base", item(entry("a").blob).base)
        assertEquals(0, entry("a").failureCount)
        // Its push gets a 409 whose server copy is ours, and the rebase that does not fit holds the text then.
        val next = run()
        assertEquals(1, next.held)
        assertNull(next.failure)
        assertEquals(HeldReason.NOT_BUILT, entry("a").held!!.reason)
        assertEquals("text, and more", item(entry("a").blob).text)
    }

    @Test fun `a storage error while a note is being built stays the entry's storage failure, with backoff`() {
        landedWithoutAnswerThenSaved()
        rebaseError = IOException("the notebook copy could not be read")
        val failedRebase = run()
        assertEquals(FailureKind.LOCAL, failedRebase.failure)
        assertEquals(0, failedRebase.held)
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
        assertEquals(1, entry("n1").failureCount)
        assertEquals("one, two", item(entry("n1").blob).text)
        rebaseError = null
        assertTrue(run().succeeded)

        server.writeElsewhere("m", "web-1")
        save("m", "mine", seen = "srv-0")
        newNoteError = IOException("the notebook copy could not be read")
        val failedCopy = run()
        assertEquals(FailureKind.LOCAL, failedCopy.failure)
        assertEquals(0, failedCopy.held)
        assertTrue(failedCopy.conflicts.isEmpty())
        assertEquals(listOf("m"), waiting())
        assertEquals("mine", item(entry("m").blob).text)
        newNoteError = null
        assertTrue(run().succeeded)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a change saved while the note was being built is not held with it`() {
        editedElsewhere()
        newNoteError = NotePushStep.NotBuilt(HeldReason.READ_BACK_FAILED, "did not read back as written")
        duringBuild = {
            duringBuild = {}
            save("n1", "mine, and more")
        }
        val result = run()
        assertEquals("the hold was for the text that was built from, and that is no longer the entry", 0, result.held)
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
        assertEquals("mine, and more", item(entry("n1").blob).text)

        // The newer text gets its own run, and is held then if it cannot be built either.
        val next = run()
        assertEquals(1, next.held)
        assertEquals(HeldReason.READ_BACK_FAILED, entry("n1").held!!.reason)
        assertEquals("mine, and more", item(entry("n1").blob).text)
    }

    @Test fun `a run cancelled while a note is being built holds nothing and records nothing`() {
        editedElsewhere()
        newNoteError = InterruptedException()
        assertThrows(InterruptedException::class.java) { run() }
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
        assertEquals(0, entry("n1").failureCount)
        assertEquals("mine", item(entry("n1").blob).text)
    }

    @Test fun `text whose server copy cannot be cached first is not held, and waits with a storage failure`() {
        editedElsewhere()
        newNoteError = NotePushStep.NotBuilt(HeldReason.READ_BACK_FAILED, "did not read back as written")
        cacheError = IllegalStateException("the cache could not be written")
        val result = run()
        assertEquals(0, result.held)
        assertEquals(FailureKind.LOCAL, result.failure)
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
        assertEquals(1, entry("n1").failureCount)
        assertEquals("mine", item(entry("n1").blob).text)
        // Once the cache takes the write, the same run of events ends in the hold.
        cacheError = null
        assertEquals(1, run().held)
        assertEquals(HeldReason.READ_BACK_FAILED, entry("n1").held!!.reason)
        assertEquals(listOf("n1=web-1"), cached)
    }

    @Test fun `a note that cannot be built leaves one line in the log, with the reason and no text`() {
        val lines = mutableListOf<String>()
        val handler = object : java.util.logging.Handler() {
            override fun publish(record: java.util.logging.LogRecord) { lines += record.message }
            override fun flush() = Unit
            override fun close() = Unit
        }
        io.silentsuite.sync.log.Logger.log.addHandler(handler)
        try {
            editedElsewhere()
            newNoteError = NotePushStep.NotBuilt(HeldReason.READ_BACK_FAILED, "note metadata did not read back as written")
            run()
            server.writeElsewhere("m", "web-1")
            save("m", "a text nobody should find in a log", seen = "srv-0")
            newNoteError = IllegalStateException("a message that may quote the note: a text nobody should find in a log")
            run()
        } finally {
            io.silentsuite.sync.log.Logger.log.removeHandler(handler)
        }
        val notBuilt = lines.filter { it.contains("could not be built for upload") }
        assertEquals(2, notBuilt.size)
        assertEquals("A Notes change could not be built for upload (READ_BACK_FAILED): note metadata did not read back as written", notBuilt[0])
        assertEquals("A Notes change could not be built for upload (NOT_BUILT): IllegalStateException", notBuilt[1])
        assertTrue("another error's message is not logged, nor any text", lines.none { it.contains("nobody should find") || it.contains("mine") })
    }

    @Test fun `if the newer change cannot be rebased onto the item that landed the push still counts, and the next run rebases it`() {
        save("a", "text")
        duringUpload = {
            duringUpload = {}
            save("a", "text, and more")
        }
        rebaseError = IllegalStateException("could not decrypt")
        val result = run()
        assertEquals(1, result.pushed)
        assertTrue(result.succeeded)
        assertNull("still on its old base", item(entry("a").blob).base)
        rebaseError = null
        // Its push gets a 409 whose server copy is ours, and it is rebased then.
        assertTrue(run().succeeded)
        assertEquals(1, server.fetches.size)
        assertEquals("text, and more", server.items.getValue("a").text)
        assertTrue(waiting().isEmpty())
    }

    // ---- more moments at which a run stops being current ----

    @Test fun `a run that stops being current during the fetch of a server copy stores no rebase`() {
        landedWithoutAnswerThenSaved()
        server.uploads.clear()
        val before = entry("n1")
        var current = true
        duringFetch = { current = false }
        assertThrows(StaleSyncRunException::class.java) { step(mayWrite = { current }).pass() }
        val after = entry("n1")
        assertEquals(before.version, after.version)
        assertEquals(before.revision, after.revision)
        assertEquals(0, after.failureCount)
        assertTrue(cached.isEmpty())
        assertEquals(1, server.uploads.size)
    }

    @Test fun `a 401 that arrives once the run is no longer current is thrown on as a stale run and records nothing`() {
        save("a", "one")
        var current = true
        duringUpload = { current = false }
        server.uploadError = { UnauthorizedException("Invalid token.") }
        assertThrows(StaleSyncRunException::class.java) { step(mayWrite = { current }).pass() }
        assertEquals(0, entry("a").failureCount)
    }
}
