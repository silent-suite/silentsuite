package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.NotePushPolicy.ConflictOutcome
import io.silentsuite.sync.notes.edit.NotePushPolicy.FailureKind
import io.silentsuite.sync.notes.edit.NotePushPolicy.ServerCopy
import io.silentsuite.sync.notes.edit.PendingNotesStore.Change
import io.silentsuite.sync.notes.edit.PendingNotesStore.DeleteOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * The store and policy rules of design section 3.8, driven by a server's answers. Each rule gets a
 * server that misbehaves in exactly the way the rule bounds, and a server that behaves, so a rule that
 * fires in an ordinary sequence fails a test.
 *
 * The Notes runner's push step does not exist yet. [push] stands in for the part of it these rules
 * need: one entry sent, and the answer applied through the store and [NotePushPolicy.decide] as design
 * 3.3 and 3.4 describe. The limits that belong to the runner itself (one rebase per run, ending the push
 * step, the renewal gate, follow-ups) are tested with the runner. Here they only shape the stand-in.
 */
class NotePushBoundsTest {
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
     * The server's side of a push. Left alone it makes the project server's checks (design section 2):
     * an upload of the revision it already holds as current is a success, and any other upload must be
     * built on its current revision or gets a 409. The switches make it misbehave.
     */
    private class Server {
        val items = HashMap<String, ServerCopy>()
        val uploads = mutableListOf<Item>()
        var fetches = 0

        /** Answers every push with a 409 and changes nothing. */
        var refuseEveryPush = false

        /** Answers fetch(uid) for any uid, known or not, with a copy whose revision no client sent. */
        var inventCopies = false

        /** Takes an upload that passes its checks, and answers it with a 409 all the same. */
        var answerConflictAfterLanding = false

        /** Runs before an upload is checked, for another client's write that gets in first. */
        var beforeUpload: (Item) -> Unit = {}

        private var invented = 0

        /** True for a success, false for a 409. */
        fun transaction(upload: Item): Boolean {
            beforeUpload(upload)
            uploads += upload
            if (refuseEveryPush) return false
            val current = items[upload.uid]
            if (current?.revision == upload.revision) return true
            if (current?.revision != upload.base) return false
            items[upload.uid] = ServerCopy(upload.revision, upload.deleted)
            return !answerConflictAfterLanding
        }

        fun fetch(uid: String): ServerCopy? {
            fetches++
            return if (inventCopies) ServerCopy("srv-invented-${++invented}", false) else items[uid]
        }

        /** Another client's write. */
        fun writeElsewhere(uid: String, revision: String, deleted: Boolean = false) {
            items[uid] = ServerCopy(revision, deleted)
        }
    }

    private val server = Server()

    /** Every conflict decision the push step took, in order. */
    private val decisions = mutableListOf<ConflictOutcome>()

    /** The notes made from conflicts, in order. */
    private val made = mutableListOf<String>()

    private var revisions = 0
    private var copies = 0
    private val now = 1_000L

    /** Runs while an upload is in flight: after the entry was recorded as sent, before the answer is applied. */
    private var duringUpload: (String) -> Unit = {}

    /** Uploads whose answer never arrives. The server has acted on them; the device records a failure. */
    private var loseAnswer: (Item) -> Boolean = { false }

    private fun revision() = "rev-${++revisions}"

    private fun entry(uid: String): PendingEntry = (store.read(uid) as Read.Present).entry

    private fun waiting(): List<String> = store.scan().entries.map { it.noteUid }

    /**
     * An editor save of [text] by uid: applied to the entry's item when there is one, else to the landed
     * record, else to the server revision the editor saw ([seen], null for a new note).
     */
    private fun save(uid: String, text: String, seen: String? = null): Item {
        val current = (store.read(uid) as? Read.Present)?.entry
        val landed = store.landed(uid)
        val base = when {
            current != null -> item(current.blob).base
            landed != null -> landed.revision
            else -> seen
        }
        val saved = Item(uid, base, revision(), false, text)
        val outcome = store.saveLocal(uid, "b1", saved.revision, saved.blob(),
            isCreate = current == null && landed == null && seen == null)
        assertTrue("$outcome", outcome is SaveOutcome.Saved)
        return saved
    }

    /**
     * One entry's part of a push step: send it, then apply the answer. Returns what happened. A note made
     * from a conflict is sent here, in the step that makes it, and an entry is rebased once per step.
     */
    private fun push(uid: String, rebased: Boolean = false): String {
        val snapshot = store.beginSend(uid) ?: return "not sent"
        val upload = item(snapshot.blob)
        val accepted = server.transaction(upload)
        duringUpload(uid)
        if (loseAnswer(upload)) {
            store.recordFailure(uid, snapshot.version, FailureKind.TRANSIENT.name, now)
            return "no answer"
        }
        if (accepted) {
            return when (val outcome = store.completeSend(uid, snapshot.version, upload.revision, snapshot.blob)) {
                SendOutcome.Done -> "landed"
                is SendOutcome.NewerLocalChange -> {
                    // Design 3.3 step 5: the newer change is rebased onto the item that just landed.
                    val newer = outcome.entry
                    if (newer.state != PendingEntry.State.HELD) {
                        val onLanded = item(newer.blob).copy(base = upload.revision, revision = revision())
                        assertTrue(store.rebase(uid, newer.version, onto = upload.revision, revision = onLanded.revision, blob = onLanded.blob()))
                    }
                    "landed, newer change kept"
                }
            }
        }
        val copy = server.fetch(uid)
        val latest = entry(uid)
        if (copy == null) {
            store.recordFailure(uid, latest.version, FailureKind.TRANSIENT.name, now)
            return "no server copy"
        }
        val decision = NotePushPolicy.decide(latest, store.landed(uid)?.revision, copy)
        decisions += decision
        return when (decision) {
            ConflictOutcome.DONE -> {
                store.completeSend(uid, latest.version, copy.revision, latest.blob)
                "done"
            }
            ConflictOutcome.REBASE -> if (rebased) {
                store.recordFailure(uid, latest.version, FailureKind.TRANSIENT.name, now)
                "second rebase refused"
            } else {
                val onServer = item(latest.blob).copy(base = copy.revision, revision = revision())
                assertTrue(store.rebase(uid, latest.version, onto = copy.revision, revision = onServer.revision, blob = onServer.blob()))
                push(uid, rebased = true)
            }
            ConflictOutcome.KEEP_BOTH, ConflictOutcome.RECREATE_AS_NEW_NOTE -> {
                val note = Item("copy-${++copies}", null, revision(), false, item(latest.blob).text)
                made += note.uid
                val replaced = try {
                    store.replaceWithNewNote(uid, latest.version, copy.revision,
                        PendingEntry(note.uid, latest.notebookUid, PendingEntry.State.UPSERT, 0, note.revision, true, blob = note.blob()))
                } catch (e: IOException) {
                    // Design 3.8: the original records a storage failure, and neither note is sent in this step.
                    store.recordFailure(uid, latest.version, FailureKind.LOCAL.name, now)
                    return "storage failure"
                }
                if (replaced) "new note, " + push(note.uid) else {
                    made -= note.uid
                    "moved on"
                }
            }
            ConflictOutcome.HOLD_REPEATED_CONFLICT ->
                // Design 3.8: held with the sent version, so a change made during the upload is not held with it.
                when (store.hold(uid, HeldReason.REPEATED_CONFLICT, now, sentVersion = snapshot.version)) {
                    PendingNotesStore.HoldOutcome.HELD -> "held"
                    else -> "newer change kept"
                }
            ConflictOutcome.RESTORE_SERVER_NOTE, ConflictOutcome.ALREADY_DELETED -> {
                store.update(uid) { if ((it as? Read.Present)?.entry?.version == latest.version) Change.Remove else Change.Keep }
                "delete dropped"
            }
            ConflictOutcome.RETRY_LATER -> error("decided with a server copy")
        }
    }

    /**
     * One push step over every entry in the store when it starts, the oldest change first. Backoff is
     * not consulted, as in a run the user started, and held text is not filtered out here: the store has
     * to refuse it, so every step tries every entry.
     */
    private fun run(): List<String> =
        store.scan().entries.sortedBy { it.version }.map { "${it.noteUid}: ${push(it.noteUid)}" }

    /** n1 was uploaded once, that upload landed and its answer was lost, and the user then saved again. Returns the landed revision. */
    private fun landedWithoutAnswerThenSaved(): String {
        server.items["n1"] = ServerCopy("srv-0", false)
        val first = save("n1", "one", seen = "srv-0")
        loseAnswer = { true }
        assertEquals(listOf("n1: no answer"), run())
        loseAnswer = { false }
        assertEquals("the upload landed", first.revision, server.items.getValue("n1").revision)
        save("n1", "one, two")
        return first.revision
    }

    /** n1 is an edit of a note that another client has changed since: its push conflicts with a copy that is not ours. */
    private fun editedElsewhere(deleted: Boolean = false) {
        server.items["n1"] = ServerCopy("web-1", deleted)
        save("n1", "mine", seen = "srv-0")
    }

    // ---- a 409 whose server copy is ours, on every push ----

    @Test fun `a server that answers every push with a 409 and our own copy never makes that copy read as another client's`() {
        val ours = landedWithoutAnswerThenSaved()
        server.refuseEveryPush = true
        repeat(40) { n ->
            assertEquals("run $n", listOf("n1: second rebase refused"), run())
            assertTrue("run $n: the server's copy is still in the sent list", ours in entry("n1").sent)
            assertEquals("run $n", ConflictOutcome.REBASE, NotePushPolicy.decide(entry("n1"), null, ServerCopy(ours, false)))
        }
        assertEquals(80, decisions.size)
        assertTrue(decisions.all { it == ConflictOutcome.REBASE })
        assertTrue("the user's own text never became a conflicted copy", made.isEmpty())
        assertEquals(listOf("n1"), waiting())
        assertEquals("the cap was reached, so the oldest revisions did fall off", PendingEntry.MAX_SENT, entry("n1").sent.size)
        assertEquals("one, two", item(entry("n1").blob).text)
    }

    @Test fun `the same holds when the user saves the note between runs`() {
        val ours = landedWithoutAnswerThenSaved()
        server.refuseEveryPush = true
        repeat(40) { n ->
            save("n1", "text $n")
            assertEquals("run $n", listOf("n1: second rebase refused"), run())
            assertTrue("run $n", ours in entry("n1").sent)
        }
        assertTrue(decisions.all { it == ConflictOutcome.REBASE })
        assertTrue(made.isEmpty())
        assertEquals(PendingEntry.MAX_SENT, entry("n1").sent.size)
        assertEquals("text 39", item(entry("n1").blob).text)
    }

    @Test fun `a second 409 whose server copy is the upload just sent drops the entry`() {
        landedWithoutAnswerThenSaved()
        // The rebased upload passes the server's checks and lands, and the server answers 409 all the same.
        server.answerConflictAfterLanding = true
        assertEquals(listOf("n1: done"), run())
        assertEquals(listOf(ConflictOutcome.REBASE, ConflictOutcome.DONE), decisions)
        assertTrue(waiting().isEmpty())
        assertTrue(made.isEmpty())
        assertEquals(server.uploads.last().revision, server.items.getValue("n1").revision)
    }

    @Test fun `with a server that behaves a lost answer and one newer save take one rebase and one more push`() {
        landedWithoutAnswerThenSaved()
        assertEquals(listOf("n1: landed"), run())
        assertEquals(listOf(ConflictOutcome.REBASE), decisions)
        assertEquals("the first upload, the stale one, and the rebased one", 3, server.uploads.size)
        assertTrue(waiting().isEmpty())
        assertTrue(made.isEmpty())
    }

    @Test fun `a second 409 in the same run whose server copy is by then another client's goes through the conflict table`() {
        val ours = landedWithoutAnswerThenSaved()
        // Another client writes between the fetch and the rebased upload: an ordinary conflict.
        server.beforeUpload = { if (it.uid == "n1" && it.base == ours) server.writeElsewhere("n1", "web-5") }
        assertEquals(listOf("n1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.REBASE, ConflictOutcome.KEEP_BOTH), decisions)
        assertEquals(listOf("copy-1"), made)
        assertTrue("nothing failed and nothing is held", waiting().isEmpty())
        assertEquals("the other client's version stays", "web-5", server.items.getValue("n1").revision)
        assertNotNull(server.items["copy-1"])
    }

    // ---- a 409 whose server copy is not ours, on every push ----

    /** Every push is refused, with a copy no client sent: n1 becomes one new note, which is then held. */
    private fun refusedUntilHeld() {
        save("n1", "mine", seen = "srv-0")
        server.refuseEveryPush = true
        server.inventCopies = true
        assertEquals(listOf("n1: new note, held"), run())
    }

    @Test fun `a server that refuses every push with a copy that is not ours gets one new note, and then the text is held`() {
        refusedUntilHeld()
        repeat(5) { assertEquals("held text is not sent again", listOf("copy-1: not sent"), run()) }
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.HOLD_REPEATED_CONFLICT), decisions)
        assertEquals(listOf("copy-1"), made)
        assertEquals(listOf("copy-1"), waiting())
        val held = entry("copy-1")
        assertEquals(PendingEntry.State.HELD, held.state)
        assertEquals(HeldReason.REPEATED_CONFLICT, held.held?.reason)
        assertTrue(held.fromConflict)
        assertEquals("the text is kept", "mine", item(held.blob).text)
        assertEquals("one push for the original and one for the new note", 2, server.uploads.size)
        assertEquals(2, server.fetches)
    }

    @Test fun `try again on text held for a repeated conflict makes exactly one more note and holds it again`() {
        refusedUntilHeld()
        for (tap in 1..2) {
            val heldUid = "copy-$tap"
            assertTrue(store.release(heldUid))
            assertEquals("tap $tap", listOf("$heldUid: new note, held"), run())
            repeat(3) { assertEquals("nothing further until the next tap", listOf("copy-${tap + 1}: not sent"), run()) }
            assertEquals((1..tap + 1).map { "copy-$it" }, made)
            assertEquals(listOf("copy-${tap + 1}"), waiting())
            assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-${tap + 1}").held?.reason)
            assertEquals("mine", item(entry("copy-${tap + 1}").blob).text)
        }
        assertEquals("two pushes per tap, after the first two", 6, server.uploads.size)
    }

    /** The copy of n1 was uploaded and landed, its answer was lost, and the user then deleted it on this device. */
    private fun markedDeleteMeets(deletedElsewhere: Boolean): ConflictOutcome {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(listOf("n1: new note, no answer"), run())
        loseAnswer = { false }
        val gone = item(entry("copy-1").blob).copy(revision = revision(), deleted = true)
        assertEquals(DeleteOutcome.Queued, store.markDeleted("copy-1", "b1", gone.revision, gone.blob()))
        assertTrue("the delete carries the mark", entry("copy-1").fromConflict)
        server.writeElsewhere("copy-1", "web-2", deleted = deletedElsewhere)
        assertEquals(listOf("copy-1: delete dropped"), run())
        assertTrue("nothing is held, and no note is made", waiting().isEmpty())
        assertEquals(listOf("copy-1"), made)
        return decisions.last()
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
        assertEquals(listOf("n1: new note, newer change kept"), run())
        val pending = entry("copy-1")
        assertEquals(PendingEntry.State.UPSERT, pending.state)
        assertTrue(pending.fromConflict)
        assertEquals(0, pending.failureCount)
        // The next run sends the newer text, gets the same answer, and holds it.
        assertEquals(listOf("copy-1: held"), run())
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertEquals("mine, and more", item(entry("copy-1").blob).text)
        assertEquals(listOf("copy-1"), made)
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.HOLD_REPEATED_CONFLICT, ConflictOutcome.HOLD_REPEATED_CONFLICT), decisions)
    }

    @Test fun `a marked pending delete against an edit made elsewhere takes the delete row and is dropped, and nothing is held`() {
        assertEquals(ConflictOutcome.RESTORE_SERVER_NOTE, markedDeleteMeets(deletedElsewhere = false))
    }

    @Test fun `a marked pending delete against a delete made elsewhere is already done`() {
        assertEquals(ConflictOutcome.ALREADY_DELETED, markedDeleteMeets(deletedElsewhere = true))
    }

    // ---- the mark with a server that behaves ----

    @Test fun `a first conflict on an ordinary note still makes its copy, and the copy lands in the same run`() {
        editedElsewhere()
        assertEquals(listOf("n1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH), decisions)
        assertTrue("nothing is held", waiting().isEmpty())
        assertEquals("the server version stays in place", "web-1", server.items.getValue("n1").revision)
        assertNotNull(server.items["copy-1"])
        assertEquals("one push for the original and one for the copy", 2, server.uploads.size)
    }

    @Test fun `a first conflict with a note deleted elsewhere still becomes a new note that lands in the same run`() {
        editedElsewhere(deleted = true)
        assertEquals(listOf("n1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.RECREATE_AS_NEW_NOTE), decisions)
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
        assertEquals(listOf("n1: new note, landed, newer change kept"), run())
        assertFalse("the upload landed, so the note is on the server", entry("copy-1").fromConflict)
        // Another client then edits the copy: an ordinary conflict, so a conflicted copy, not a hold.
        server.writeElsewhere("copy-1", "web-2")
        assertEquals(listOf("copy-1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.KEEP_BOTH), decisions)
        assertEquals(listOf("copy-1", "copy-2"), made)
        assertTrue("nothing is held", waiting().isEmpty())
    }

    /** The copy of n1 landed with its answer lost, and the user saved it again before the next run. */
    private fun copyLandedWithoutAnswerThenSaved(): String {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(listOf("n1: new note, no answer"), run())
        loseAnswer = { false }
        save("copy-1", "mine, and more")
        assertTrue("saved before the device knows it landed, so still marked", entry("copy-1").fromConflict)
        return server.items.getValue("copy-1").revision
    }

    @Test fun `a conflict copy whose answer was lost and that was saved again lands with one rebase`() {
        copyLandedWithoutAnswerThenSaved()
        assertEquals(listOf("copy-1: landed"), run())
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.REBASE), decisions)
        assertEquals(listOf("copy-1"), made)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `after that rebase a conflict with another client's copy makes a conflicted copy, not a hold`() {
        val landed = copyLandedWithoutAnswerThenSaved()
        // Another client writes between the fetch and the rebased upload.
        server.beforeUpload = { if (it.uid == "copy-1" && it.base == landed) server.writeElsewhere("copy-1", "web-3") }
        assertEquals(listOf("copy-1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.REBASE, ConflictOutcome.KEEP_BOTH), decisions)
        assertEquals(listOf("copy-1", "copy-2"), made)
        assertTrue("nothing is held", waiting().isEmpty())
        assertNotNull(server.items["copy-2"])
    }

    @Test fun `try again on text held for a real repeated conflict lands as one new note`() {
        editedElsewhere()
        loseAnswer = { it.uid == "copy-1" }
        assertEquals(listOf("n1: new note, no answer"), run())
        loseAnswer = { false }
        // The conflicted copy is on the server, and the user merges it on another device before this one's next run.
        server.writeElsewhere("copy-1", "web-2")
        assertEquals(listOf("copy-1: held"), run())
        assertEquals(HeldReason.REPEATED_CONFLICT, entry("copy-1").held?.reason)
        assertTrue(store.release("copy-1"))
        assertEquals(listOf("copy-1: new note, landed"), run())
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH, ConflictOutcome.HOLD_REPEATED_CONFLICT, ConflictOutcome.KEEP_BOTH), decisions)
        assertEquals(listOf("copy-1", "copy-2"), made)
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
        assertEquals(listOf("copy-1: landed"), run())
        assertEquals(listOf("copy-1"), made)
        assertTrue(waiting().isEmpty())
        assertNotNull(server.items["copy-1"])
    }

    // ---- an original that cannot be removed ----

    @Test fun `while the original cannot be removed neither note is sent, and no second copy is made`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        assertEquals(listOf("n1: storage failure"), run())
        repeat(5) { assertEquals(listOf("n1: not sent", "copy-1: not sent"), run()) }
        assertEquals("only the first push of the original reached the server", 1, server.uploads.size)
        assertEquals(listOf("copy-1"), made)
        assertEquals(listOf("copy-1", "n1"), waiting())
        failing = false
        // Recovery removes the original and clears the link, and the copy is sent like any new note.
        assertEquals(listOf("copy-1: landed"), run())
        assertEquals(listOf("copy-1"), made)
        assertTrue(waiting().isEmpty())
        assertEquals(2, server.uploads.size)
        assertEquals("web-1", server.items.getValue("n1").revision)
    }

    @Test fun `deleting the copy while the original cannot be removed does not bring the text back as a second copy`() {
        editedElsewhere()
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "n1.note") throw IOException("could not remove n1.note")
        }
        assertEquals(listOf("n1: storage failure"), run())
        // The user deletes the conflicted copy. The delete fails with the removal, and both notes stay.
        val gone = item(entry("copy-1").blob).copy(revision = revision(), deleted = true)
        assertThrows(IOException::class.java) { store.markDeleted("copy-1", "b1", gone.revision, gone.blob()) }
        assertEquals(listOf("n1: not sent", "copy-1: not sent"), run())
        failing = false
        assertEquals(DeleteOutcome.Removed, store.markDeleted("copy-1", "b1", gone.revision, gone.blob()))
        assertEquals("the original went with the copy", emptyList<String>(), run())
        assertTrue(waiting().isEmpty())
        assertEquals(listOf("copy-1"), made)
        assertEquals("nothing but the first push of the original reached the server", 1, server.uploads.size)
    }

    // ---- an editor that has not rebound when the copy lands ----

    @Test fun `a save from an editor that has not rebound ends up in the copy, with no entry for the original and no second copy`() {
        server.items["n1"] = ServerCopy("web-1", false)
        val editor = store.editorOpened("n1")
        val first = Item("n1", "srv-0", revision(), false, "mine")
        assertTrue(store.saveLocal(editor, "n1", "b1", first.revision, first.blob(), isCreate = false) is SaveOutcome.Saved)
        // The copy is made and lands in one run, before the editor hears of it.
        assertEquals(listOf("n1: new note, landed"), run())
        assertEquals("copy-1", editor.noteUid)
        // The editor's next autosave was built for the original.
        val late = Item("n1", "srv-0", revision(), false, "mine, and more")
        assertEquals(SaveOutcome.Moved("copy-1"), store.saveLocal(editor, "n1", "b1", late.revision, late.blob(), isCreate = false))
        assertEquals(Read.Missing, store.read("n1"))
        // It applies its text to the copy as it landed, and saves again.
        val onCopy = Item("copy-1", store.landed("copy-1")!!.revision, revision(), false, "mine, and more")
        assertTrue(store.saveLocal(editor, "copy-1", "b1", onCopy.revision, onCopy.blob(), isCreate = false) is SaveOutcome.Saved)
        assertEquals(listOf("copy-1: landed"), run())
        assertEquals(listOf("copy-1"), made)
        assertEquals(listOf(ConflictOutcome.KEEP_BOTH), decisions)
        assertEquals("the original was pushed once, before the conflict", 1, server.uploads.count { it.uid == "n1" })
        assertEquals(onCopy.revision, server.items.getValue("copy-1").revision)
        assertEquals("web-1", server.items.getValue("n1").revision)
        assertTrue(waiting().isEmpty())
    }

    @Test fun `a delete from an editor that has not rebound deletes the copy on the server, not the original`() {
        server.items["n1"] = ServerCopy("web-1", false)
        val editor = store.editorOpened("n1")
        val first = Item("n1", "srv-0", revision(), false, "mine")
        store.saveLocal(editor, "n1", "b1", first.revision, first.blob(), isCreate = false)
        assertEquals(listOf("n1: new note, landed"), run())
        val late = Item("n1", "srv-0", revision(), true, "")
        assertEquals(DeleteOutcome.Moved("copy-1"), store.markDeleted(editor, "n1", "b1", late.revision, late.blob()))
        assertEquals(Read.Missing, store.read("n1"))
        val onCopy = Item("copy-1", store.landed("copy-1")!!.revision, revision(), true, "")
        assertEquals(DeleteOutcome.Queued, store.markDeleted(editor, "copy-1", "b1", onCopy.revision, onCopy.blob()))
        assertEquals(listOf("copy-1: landed"), run())
        assertTrue(server.items.getValue("copy-1").deleted)
        assertEquals("the other client's version of the original is untouched", ServerCopy("web-1", false), server.items["n1"])
        assertEquals(listOf("copy-1"), made)
        assertTrue(waiting().isEmpty())
    }
}
