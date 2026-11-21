package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.PendingNotesStore.DeleteRefusal
import io.silentsuite.sync.notes.edit.PendingNotesStore.HoldOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.NoteMove
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendStart
import org.junit.After
import org.junit.Assert.assertArrayEquals
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

/**
 * The user's move of one note to another notebook in the pending store ([PendingNotesStore.moveNote]): the copy is
 * written first and the original's delete second, the delete waits for a run to confirm the copy, and every way the two
 * writes can stop leaves the text in one of the two notes, never in neither.
 */
class PendingNotesStoreMoveTest {
    @get:Rule val tmp = TemporaryFolder()

    private val dir by lazy { tmp.newFolder("store") }

    /** Makes the sync of the store's directory fail, as after a rename or unlink that may not last a power loss. */
    private var failDirectorySync: (File) -> Boolean = { false }
    private val store by lazy { open(dir) }

    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private fun open(d: File) = PendingNotesStore.open(d, syncDirectory = { if (failDirectorySync(it)) throw IOException("directory sync failed") },
        rename = atomicMove)

    @After fun reset() {
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.beforeReadForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
        PendingNotesStore.resetForTesting()
    }

    private fun restarted(): PendingNotesStore {
        PendingNotesStore.resetForTesting()
        return open(dir)
    }

    private fun PendingNotesStore.entry(uid: String): PendingEntry = (read(uid) as Read.Present).entry

    private fun entry(uid: String) = store.entry(uid)

    private fun blob(text: String) = text.toByteArray()

    private fun saved(outcome: SaveOutcome) = (outcome as SaveOutcome.Saved).version

    private fun digest(e: PendingEntry) = PendingNotesStore.digestOf(e.blob)

    private fun copyOf(uid: String = "copy1", text: String = "moved text", notebook: String = "b2") =
        PendingEntry(uid, notebook, PendingEntry.State.UPSERT, 0, "c-$uid", isCreate = true, blob = blob(text))

    /** The user's move as the note screen sends it: [shown] is the entry it showed, or null for none. */
    private fun PendingNotesStore.move(uid: String, shown: PendingEntry?, copy: PendingEntry = copyOf(), notebookCopy: ByteArray? = null,
                                       targetCopy: ByteArray? = null) =
        moveNote(uid, "b1", shown?.version, shown?.let { digest(it) }, "del-$uid", blob("deleted $uid"), copy, notebookCopy, targetCopy)

    private fun permitsOf(s: PendingNotesStore) = PendingNotesDiscardPermits(File(s.dir.parentFile!!, PendingNotesDiscardPermits.ROOT),
        {}, atomicMove, PendingNotesStore.nioPresence)

    private fun filesOf(d: File): Map<String, String> =
        d.listFiles().orEmpty().filter { it.isFile }.associate { it.name to PendingNotesStore.digestOf(it.readBytes()) }

    // ---- what a move writes ----

    @Test fun `a move of a note with no entry writes the copy first, then a delete that names it, and both survive a restart`() {
        assertEquals(NoteMove.Moved("copy1"),
            store.move("n1", shown = null, notebookCopy = blob("source notebook"), targetCopy = blob("target notebook")))
        val s = restarted()
        val copy = s.entry("copy1")
        assertEquals(PendingEntry.State.UPSERT, copy.state)
        assertEquals("b2", copy.notebookUid)
        assertTrue("a create", copy.isCreate)
        assertArrayEquals(blob("moved text"), copy.blob)
        val delete = s.entry("n1")
        assertEquals(PendingEntry.State.DELETE, delete.state)
        assertEquals("b1", delete.notebookUid)
        assertEquals(PendingEntry.Move("copy1", "b2"), delete.move)
        assertEquals("del-n1", delete.revision)
        assertArrayEquals(blob("deleted n1"), delete.blob)
        assertTrue("the copy is older, so a run sends it first", copy.version < delete.version)
        assertArrayEquals(blob("source notebook"), s.notebook("b1"))
        assertArrayEquals(blob("target notebook"), s.notebook("b2"))
        assertTrue("the header-only listing knows the move", s.snapshot { false }.headers.single { it.noteUid == "n1" }.moved)
    }

    @Test fun `a move over unsynced text checks what was shown, asks no discard, and keeps the sent list on the delete`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        store.recordFailure("n1", entry("n1").version, "TRANSIENT", now = 5)
        store.beginSend("n1")
        val shown = entry("n1")
        val copy = copyOf()
        assertEquals("none shown", NoteMove.Changed(Read.Present(shown)), store.move("n1", shown = null))
        assertEquals("another version", NoteMove.Changed(Read.Present(shown)),
            store.moveNote("n1", "b1", shown.version + 1, digest(shown), "d", blob("deleted"), copy))
        assertEquals("other text", NoteMove.Changed(Read.Present(shown)),
            store.moveNote("n1", "b1", shown.version, PendingNotesStore.digestOf(blob("other")), "d", blob("deleted"), copy))
        assertEquals("another notebook", NoteMove.Changed(Read.Present(shown)),
            store.moveNote("n1", "b3", shown.version, digest(shown), "d", blob("deleted"), copy))
        assertEquals("nothing was written by any of them", shown, entry("n1"))
        assertEquals(Read.Missing, store.read("copy1"))

        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown))
        val e = entry("n1")
        assertEquals(PendingEntry.State.DELETE, e.state)
        assertTrue(e.version > entry("copy1").version && entry("copy1").version > shown.version)
        assertEquals("its sent list stays, so an upload of ours is still known as ours", shown.sent, e.sent)
        assertEquals(0, e.failureCount)
        assertEquals(PendingEntry.Move("copy1", "b2"), e.move)
    }

    @Test fun `a move with no entry takes a landed upload of this editor as ours`() {
        val editor = store.editorOpened("n1")
        saved(store.saveLocal(editor, "n1", "b1", "r1", blob("mine"), isCreate = true))
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "s1", blob("landed")))
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val e = entry("n1")
        assertFalse("not a create once it landed", e.isCreate)
        assertTrue("the landed revision counts as ours on a 409: ${e.sent}", "s1" in e.sent)
    }

    @Test fun `a note that never reached the server leaves no delete, only the copy`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", entry("n1")))
        val s = restarted()
        assertEquals(Read.Missing, s.read("n1"))
        assertEquals(listOf("copy1"), s.snapshot { false }.headers.map { it.noteUid })
    }

    @Test fun `a conflict copy still linked to its original takes the original along`() {
        saved(store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false))
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "orig.note") throw IOException("could not remove orig.note") }
        val conflict = PendingEntry("conflict1", "b1", PendingEntry.State.UPSERT, 0, "k1", true, blob = blob("mine"))
        assertThrows(IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", conflict) }
        assertEquals("the original cannot move by itself", NoteMove.Refused(DeleteRefusal.UNFINISHED_ORIGINAL),
            store.move("orig", entry("orig")))
        // Recovery would finish the replacement by itself before the move. A listing that leaves the copy out keeps it from
        // seeing the link, and a landed record that cannot be shown absent keeps the copy from counting as never sent, so
        // the step under test, the move's own, is what takes the original along.
        PendingNotesStore.listFilesForTesting = { d -> d.listFiles()?.filter { it.name != "conflict1.note" }?.toTypedArray() }
        PendingNotesStore.presenceForTesting = { if (it.name == "conflict1.landed") PendingNotesStore.Presence.UNKNOWN else null }
        PendingNotesStore.beforeRemoveForTesting = null
        val linked = entry("conflict1")
        assertNotNull("still linked when the move starts", linked.origin)
        assertEquals(NoteMove.Moved("copy1"), store.move("conflict1", linked))
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.presenceForTesting = null
        assertEquals("the original goes first, so its text is never sent as an edit", Read.Missing, store.read("orig"))
        val delete = entry("conflict1")
        assertEquals(PendingEntry.State.DELETE, delete.state)
        assertNull(delete.origin)
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
    }

    // ---- refusals ----

    @Test fun `held text, a pending delete and an entry that cannot be read are not moved, and nothing is written`() {
        saved(store.saveLocal("held", "b1", "r1", blob("a"), isCreate = false))
        store.hold("held", HeldReason.REJECTED, now = 5)
        assertEquals(NoteMove.Refused(DeleteRefusal.HELD), store.move("held", entry("held")))
        assertEquals(NoteMove.Moved("copy1"), store.move("moved", shown = null))
        val delete = entry("moved")
        assertEquals("moved or deleted already", NoteMove.Changed(Read.Present(delete)), store.move("moved", shown = null, copy = copyOf("copy2")))
        File(dir, "bad.note").writeBytes(blob("not an entry"))
        val before = filesOf(dir)
        assertEquals(NoteMove.Refused(DeleteRefusal.UNREADABLE), store.move("bad", shown = null, copy = copyOf("copy3")))
        assertEquals(before, filesOf(dir))
    }

    @Test fun `a move is refused while a discard of the whole store is unfinished, and the permit stays`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val s = restarted()
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = setOf("n1.note")))
        val before = filesOf(dir)
        assertEquals(NoteMove.Refused(DeleteRefusal.DISCARD_UNFINISHED), s.move("other", shown = null))
        assertEquals(before, filesOf(dir))
        assertEquals("the permit still holds back what it names",
            SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
    }

    @Test fun `a removal hold refuses a move and nothing is written`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = PendingNotesStore.forNoBackup(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1", {}, atomicMove)
        saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val hold = PendingNotesStore.RemovalHold()
        assertTrue(s.removalCheck(hold) is PendingNotesStore.RemovalCheck.Blocks)
        val before = filesOf(s.dir)
        assertEquals(NoteMove.RemovalPending, s.move("n1", s.entry("n1")))
        assertEquals(before, filesOf(s.dir))
        hold.release()
        assertEquals(NoteMove.Moved("copy1"), s.move("n1", s.entry("n1")))
    }

    @Test fun `a copy too large to keep, or a uid already there, writes nothing`() {
        val large = copyOf().copy(blob = ByteArray(PendingCodec.MAX_BLOB + 1))
        assertEquals(NoteMove.Refused(DeleteRefusal.TOO_LARGE), store.move("n1", shown = null, copy = large))
        saved(store.saveLocal("copy1", "b2", "r1", blob("someone's"), isCreate = false))
        val before = filesOf(dir)
        assertEquals(NoteMove.NotMoved, store.move("n1", shown = null))
        assertEquals("never written over", before, filesOf(dir))
        // A check that cannot tell counts as there.
        PendingNotesStore.presenceForTesting = { if (it.name == "copy9.note") PendingNotesStore.Presence.UNKNOWN else null }
        assertEquals(NoteMove.NotMoved, store.move("n1", shown = null, copy = copyOf("copy9")))
        assertEquals(Read.Missing, store.read("n1"))
    }

    // ---- what other store paths do with a move's delete ----

    @Test fun `a move's delete is sent only together with the copy the run just fetched, and nothing keeps that check`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val delete = entry("n1")
        assertEquals(SendStart.MoveUnconfirmed(delete), store.startSend("n1"))
        assertEquals("another copy", SendStart.MoveUnconfirmed(delete), store.startSend("n1", PendingEntry.Move("copy9", "b2")))
        assertEquals("nothing recorded as sent", delete, entry("n1"))
        assertNull(store.beginSend("n1"))
        val sent = (restarted().startSend("n1", PendingEntry.Move("copy1", "b2")) as SendStart.Ready).entry
        assertEquals(listOf("del-n1"), sent.sent)
        assertEquals("the next send asks for the copy again", SendStart.MoveUnconfirmed(sent), restarted().startSend("n1"))
    }

    @Test fun `a save over a moved note writes nothing and says it moved, by uid and through an editor`() {
        val editor = store.editorOpened("n1")
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val e = entry("n1")
        assertEquals(SaveOutcome.MovedAway, store.saveLocal("n1", "b1", "r2", blob("late"), isCreate = false))
        assertEquals(SaveOutcome.MovedAway, store.saveLocal(editor, "n1", "b1", "r3", blob("later"), isCreate = false))
        assertEquals("the delete stays as it was", e, entry("n1"))
        assertEquals("the editor is not pointed at the copy", "n1", editor.noteUid)
    }

    @Test fun `a move's delete is never held - a hold drops it, and the copy stays`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        assertEquals(HoldOutcome.MOVE_DELETE_DROPPED, store.hold("n1", HeldReason.READ_ONLY, now = 5))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
    }

    @Test fun `a hold reports a move's delete as the entry is when it drops it, also when its removal may not last a power loss`() {
        // Made plain by the user's delete of the copy: an ordinary delete's drop.
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val copy = entry("copy1")
        assertEquals(PendingNotesStore.NoteDelete.Recorded, store.deleteNote("copy1", "b2", copy.version, digest(copy),
            discardConfirmed = true, revision = "d-copy1", deleted = blob("deleted copy1")))
        assertNull(entry("n1").move)
        assertEquals(HoldOutcome.DELETE_DROPPED, store.hold("n1", HeldReason.READ_ONLY, now = 5))
        // A move's delete never sent, whose removal may not last a power loss: the exception says it was a move's.
        assertEquals(NoteMove.Moved("copy2"), store.move("n2", shown = null, copy = copyOf("copy2")))
        var removing = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") removing = true }
        failDirectorySync = { removing }
        val unsynced = assertThrows(PendingNotesStore.RemovalNotSynced::class.java) { store.hold("n2", HeldReason.READ_ONLY, now = 5) }
        failDirectorySync = { false }
        assertTrue(unsynced.moveDelete)
        assertFalse(unsynced.deleteSent)
        assertEquals(Read.Missing, store.read("n2"))
    }

    @Test fun `a move's delete that was sent, dropped by a hold, is reported as sent, also when its removal may not last a power loss`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        assertTrue(store.startSend("n1", PendingEntry.Move("copy1", "b2")) is SendStart.Ready)
        assertEquals(HoldOutcome.SENT_MOVE_DELETE_DROPPED, store.hold("n1", HeldReason.READ_ONLY, now = 5))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(NoteMove.Moved("copy2"), store.move("n2", shown = null, copy = copyOf("copy2")))
        assertTrue(store.startSend("n2", PendingEntry.Move("copy2", "b2")) is SendStart.Ready)
        var removing = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") removing = true }
        failDirectorySync = { removing }
        val unsynced = assertThrows(PendingNotesStore.RemovalNotSynced::class.java) { store.hold("n2", HeldReason.READ_ONLY, now = 5) }
        failDirectorySync = { false }
        assertTrue("the exception says the delete was sent", unsynced.deleteSent)
        assertTrue("and a move's", unsynced.moveDelete)
        assertEquals(Read.Missing, store.read("n2"))
    }

    // ---- acting on the copy before the move syncs ----

    @Test fun `moving the copy of an unsynced move again points the original's delete at the new copy`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        val copy1 = entry("copy1")
        val again = store.moveNote("copy1", "b2", copy1.version, digest(copy1), "del-copy1", blob("deleted copy1"),
            copyOf("copy2", notebook = "b3"))
        assertEquals(NoteMove.Moved("copy2"), again)
        assertEquals("the first copy never reached the server: it is gone", Read.Missing, store.read("copy1"))
        val s = restarted()
        val delete = s.entry("n1")
        assertEquals(PendingEntry.Move("copy2", "b3"), delete.move)
        assertTrue("a new version, so a run that read the old one can neither confirm nor drop it", delete.version > first.version)
        assertEquals(PendingEntry.State.UPSERT to "b3", s.entry("copy2").let { it.state to it.notebookUid })
        assertEquals(setOf("n1", "copy2"), s.snapshot { false }.headers.mapTo(HashSet()) { it.noteUid })
    }

    @Test fun `deleting the copy of an unsynced move makes the original's delete an ordinary one`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        val copy1 = entry("copy1")
        assertTrue("the confirmation must not say it is only on this device", store.hasWaitingMoves("copy1"))
        assertFalse(store.hasWaitingMoves("n1"))
        // The copy never synced, but the original's delete is sent: the answer says a delete goes, not that nothing is sent.
        assertEquals(PendingNotesStore.NoteDelete.Recorded,
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")))
        assertEquals(Read.Missing, store.read("copy1"))
        assertFalse(store.hasWaitingMoves("copy1"))
        val delete = restarted().entry("n1")
        assertEquals(PendingEntry.State.DELETE, delete.state)
        assertNull("the user deleted the note: no copy to wait for", delete.move)
        assertTrue(delete.version > first.version)
        assertArrayEquals("still the original's deleted item", blob("deleted n1"), delete.blob)
    }

    @Test fun `deleting a never-synced copy whose original's delete could not be made ordinary says nothing is sent`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val copy1 = entry("copy1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw IOException("rename failed") }
        assertEquals("the original still waits for the copy, so a run drops its delete", PendingNotesStore.NoteDelete.Dropped,
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")))
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals(Read.Missing, store.read("copy1"))
        assertEquals(PendingEntry.Move("copy1", "b2"), entry("n1").move)
    }

    @Test fun `deleting a copy that may have reached the server makes the original's delete an ordinary one too`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        store.beginSend("copy1")
        val copy1 = entry("copy1")
        assertEquals(PendingNotesStore.NoteDelete.Recorded,
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")))
        assertEquals(PendingEntry.State.DELETE, entry("copy1").state)
        val delete = entry("n1")
        assertNull("the user deleted the note here: a run never takes it for a delete elsewhere", delete.move)
        assertTrue(delete.version > first.version)
    }

    @Test fun `a listing that leaves the original's delete out still moves the copy, and that delete keeps waiting for the old one`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        val copy1 = entry("copy1")
        PendingNotesStore.listFilesForTesting = { d -> d.listFiles()?.filter { it.name != "n1.note" }?.toTypedArray() }
        try {
            assertEquals(NoteMove.Moved("copy2"), store.moveNote("copy1", "b2", copy1.version, digest(copy1), "d", blob("deleted"),
                copyOf("copy2", notebook = "b3")))
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        // A run then finds that copy never landed and drops this delete: the original shows again, beside copy2. This listing
        // still holds the store's counter, which makes it the one short listing no check of the store can see.
        assertEquals(first, entry("n1"))
    }

    /** Sets up the notes [assertNeitherMovedNorDeleted] acts on: n1 moved to copy1, and n5, a create that may have been sent. */
    private fun movedAndSent(): Pair<PendingEntry, PendingEntry> {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        saved(store.saveLocal("n5", "b1", "r5", blob("sent once"), isCreate = true))
        store.beginSend("n5")
        return entry("copy1") to entry("n5")
    }

    /**
     * The user moves copy1, as [copy1] showed it, and deletes it, n5 ([sent]), and n9, a note with no entry (it may be a copy
     * that landed): each is refused before anything is written.
     */
    private fun assertNeitherMovedNorDeleted(copy1: PendingEntry, sent: PendingEntry) {
        val before = filesOf(dir)
        val refused = PendingNotesStore.NoteDelete.Refused(DeleteRefusal.MOVES_UNKNOWN)
        assertEquals(listOf<Any>(NoteMove.Refused(DeleteRefusal.MOVES_UNKNOWN), refused, refused, refused), listOf<Any>(
            store.moveNote("copy1", "b2", copy1.version, digest(copy1), "d", blob("deleted"), copyOf("copy2", notebook = "b3")),
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")),
            store.deleteNote("n5", "b1", sent.version, digest(sent), discardConfirmed = true, "del-n5", blob("deleted n5")),
            store.deleteNote("n9", "b1", null, null, discardConfirmed = false, "del-n9", blob("deleted n9"))))
        assertEquals("nothing written", before, filesOf(dir))
    }

    @Test fun `a store that cannot be listed refuses moving or deleting a note, since a waiting original's delete may be left out`() {
        val (copy1, sent) = movedAndSent()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) null else d.listFiles() }
        try {
            assertNeitherMovedNorDeleted(copy1, sent)
            assertTrue("moves that cannot be told count as waiting, for the delete's wording", store.hasWaitingMoves("n9"))
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        assertEquals(PendingEntry.Move("copy1", "b2"), entry("n1").move)
    }

    @Test fun `a listing that comes back short by the store's counter refuses moving or deleting a note`() {
        val (copy1, sent) = movedAndSent()
        // As File.listFiles returns what it read so far: this one stopped before the original's delete and the counter.
        PendingNotesStore.listFilesForTesting = { d ->
            d.listFiles()?.let { all -> if (d.name == dir.name) all.filter { it.name < "n1.note" }.toTypedArray() else all }
        }
        try {
            assertNeitherMovedNorDeleted(copy1, sent)
        } finally {
            PendingNotesStore.listFilesForTesting = null
        }
        assertEquals(PendingEntry.Move("copy1", "b2"), entry("n1").move)
    }

    @Test fun `a read that fails, or a first write not committed yet, refuses moving or deleting a note`() {
        val (copy1, sent) = movedAndSent()
        // The read of the original's delete fails: first its header; then, with the header read, the rest of it (each call
        // reads the header, then the whole file, so every second read of it is the whole file).
        var failHeader = true
        var reads = 0
        PendingNotesStore.beforeReadForTesting = {
            if (it.name == "n1.note" && (failHeader || ++reads % 2 == 0)) throw IOException("read failed")
        }
        assertNeitherMovedNorDeleted(copy1, sent)
        failHeader = false
        assertNeitherMovedNorDeleted(copy1, sent)
        assertTrue("the whole file was read", reads > 0)
        PendingNotesStore.beforeReadForTesting = null
        // A first write that recovery has not committed yet.
        val stranded = File(dir, "n8.note.new")
        stranded.writeBytes(File(dir, "n1.note").readBytes())
        assertNeitherMovedNorDeleted(copy1, sent)
        assertTrue(stranded.delete())
        assertEquals(NoteMove.Moved("copy2"), store.moveNote("copy1", "b2", copy1.version, digest(copy1), "d", blob("deleted"),
            copyOf("copy2", notebook = "b3")))
        assertEquals(PendingEntry.Move("copy2", "b3"), entry("n1").move)
    }

    @Test fun `a file that reads in full but never decodes holds back no move or delete, and is left as it is`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val copy1 = entry("copy1")
        // No run of this build sends either file: one that holds no entry, and the original's delete once its checksum fails.
        val garbage = File(dir, "n7.note")
        garbage.writeBytes("not an entry".toByteArray())
        val original = File(dir, "n1.note")
        val damaged = original.readBytes().also { it[it.size - 1] = (it[it.size - 1] + 1).toByte() }
        original.writeBytes(damaged)
        assertEquals(NoteMove.Moved("copy2"), store.moveNote("copy1", "b2", copy1.version, digest(copy1), "d", blob("deleted"),
            copyOf("copy2", notebook = "b3")))
        val copy2 = entry("copy2")
        assertEquals(PendingNotesStore.NoteDelete.Dropped,
            store.deleteNote("copy2", "b3", copy2.version, digest(copy2), discardConfirmed = true, "del-copy2", blob("deleted copy2")))
        assertArrayEquals(damaged, original.readBytes())
        assertArrayEquals("not an entry".toByteArray(), garbage.readBytes())
    }

    /** A run sends [uid]'s pending create and it lands: the entry is gone, as for any note on the server. */
    private fun PendingNotesStore.sendAndLand(uid: String) {
        val sent = (startSend(uid) as SendStart.Ready).entry
        assertEquals(SendOutcome.Done, completeSend(uid, sent.version, "server-$uid", sent.blob))
        assertEquals(Read.Missing, read(uid))
    }

    @Test fun `moving a copy that reached the server points the original's delete at the new copy too`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        store.sendAndLand("copy1")
        // The original's delete has not gone yet (a run failed after the copy landed). The user moves the copy on.
        assertEquals(NoteMove.Moved("copy2"), store.moveNote("copy1", "b2", null, null, "del-copy1", blob("deleted copy1"),
            copyOf("copy2", notebook = "b3")))
        val s = restarted()
        val original = s.entry("n1")
        assertEquals("the original waits for the newest copy, not for one this device deletes", PendingEntry.Move("copy2", "b3"),
            original.move)
        assertTrue(original.version > first.version)
        assertEquals(PendingEntry.Move("copy2", "b3"), s.entry("copy1").move)
    }

    @Test fun `deleting the newest copy after one that reached the server makes every waiting delete an ordinary one`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        store.sendAndLand("copy1")
        assertEquals(NoteMove.Moved("copy2"), store.moveNote("copy1", "b2", null, null, "del-copy1", blob("deleted copy1"),
            copyOf("copy2", notebook = "b3")))
        val copy2 = entry("copy2")
        assertEquals(PendingNotesStore.NoteDelete.Recorded,
            store.deleteNote("copy2", "b3", copy2.version, digest(copy2), discardConfirmed = true, "del-copy2", blob("deleted copy2")))
        val s = restarted()
        for (uid in listOf("n1", "copy1")) {
            val delete = s.entry(uid)
            assertEquals(uid, PendingEntry.State.DELETE, delete.state)
            assertNull("$uid: the user deleted the note, so nothing waits for a copy", delete.move)
        }
    }

    @Test fun `an original's delete that lands while the user moves or deletes the copy is done, and waits for no copy`() {
        for ((original, copy, deleteCopy) in listOf(Triple("n1", "copy1", false), Triple("n2", "copy3", true))) {
            assertEquals(NoteMove.Moved(copy), store.move(original, shown = null, copy = copyOf(copy)))
            store.sendAndLand(copy)
            val sent = (store.startSend(original, PendingEntry.Move(copy, "b2")) as SendStart.Ready).entry
            // While that delete is out, the user moves the copy on, or deletes it: the delete gets a new version.
            if (deleteCopy) {
                assertEquals(PendingNotesStore.NoteDelete.Recorded,
                    store.deleteNote(copy, "b2", null, null, discardConfirmed = false, "del-$copy", blob("deleted $copy")))
                assertNull(entry(original).move)
            } else {
                assertEquals(NoteMove.Moved("copy2"), store.moveNote(copy, "b2", null, null, "del-$copy", blob("deleted $copy"),
                    copyOf("copy2", notebook = "b3")))
                assertEquals(PendingEntry.Move("copy2", "b3"), entry(original).move)
            }
            assertTrue(entry(original).version > sent.version)
            assertEquals(original, SendOutcome.Done, store.completeSend(original, sent.version, sent.revision, blob("server deleted")))
            assertEquals("$original: the server deleted it, so nothing is left to wait or to say it stays", Read.Missing,
                store.read(original))
            assertEquals("the copy's own delete still waits", PendingEntry.State.DELETE, entry(copy).state)
        }
    }

    @Test fun `a delete written while the note's own upload is out is still sent after that upload lands`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val sent = (store.startSend("n1") as SendStart.Ready).entry
        val shown = entry("n1")
        assertEquals(PendingNotesStore.NoteDelete.Recorded,
            store.deleteNote("n1", "b1", shown.version, digest(shown), discardConfirmed = true, "del-n1", blob("deleted n1")))
        val outcome = store.completeSend("n1", sent.version, sent.revision, blob("landed"))
        assertEquals("what landed was the edit, not the delete", PendingEntry.State.DELETE,
            (outcome as SendOutcome.NewerLocalChange).entry.state)
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
    }

    @Test fun `a never-synced note moved while another editor is open on it answers that editor's save as moved`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        val other = store.editorOpened("n1", entry("n1").version)
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", entry("n1")))
        assertEquals(SaveOutcome.MovedAway, store.saveLocal(other, "n1", "b1", "r2", blob("late"), isCreate = true))
        assertEquals("nothing brings the original back", Read.Missing, store.read("n1"))
        assertEquals("the editor is not pointed at the copy", "n1", other.noteUid)
        assertEquals(listOf("copy1"), store.snapshot { false }.headers.map { it.noteUid })
    }

    @Test fun `a stray note file whose name is not a uid is passed over when a delete looks for a waiting move`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val stray = File(dir, "a stray name.note") // listed before every uid used here
        File(dir, "n1.note").copyTo(stray)
        val bytes = stray.readBytes()
        val copy1 = entry("copy1")
        assertEquals(PendingNotesStore.NoteDelete.Recorded,
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")))
        assertNull(entry("n1").move)
        assertArrayEquals("left as it was", bytes, stray.readBytes())
    }

    // ---- every way the two writes can stop ----

    @Test fun `a crash between the two writes leaves the copy as a plain create and the original as it was`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        // A process that dies on the original's write: an Error, which no catch in the store takes.
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw OutOfMemoryError("the process dies here") }
        try {
            store.move("n1", shown)
        } catch (_: OutOfMemoryError) {
        }
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals("the original keeps its text", shown, s.entry("n1"))
        val copy = s.entry("copy1")
        assertEquals("an ordinary pending create in the other notebook", PendingEntry.State.UPSERT to "b2", copy.state to copy.notebookUid)
        assertTrue(copy.isCreate)
        assertTrue("no leftover write", File(dir, "n1.note.new").let { !it.exists() })
    }

    @Test fun `a failed write of the original removes the copy again and says nothing moved`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw IOException("disk full") }
        assertEquals(NoteMove.NotMoved, store.move("n1", shown))
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals(shown, s.entry("n1"))
        assertEquals(Read.Missing, s.read("copy1"))
        assertEquals(listOf("n1"), s.snapshot { false }.headers.map { it.noteUid })
        // With no entry, too: nothing is left to be committed later.
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n2.note") throw IOException("disk full") }
        assertEquals(NoteMove.NotMoved, s.move("n2", shown = null, copy = copyOf("copy2")))
        PendingNotesStore.beforeRenameForTesting = null
        val t = restarted()
        assertEquals(Read.Missing, t.read("n2"))
        assertEquals(Read.Missing, t.read("copy2"))
    }

    @Test fun `a failed write of the copy writes nothing and leaves nothing to commit`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw IOException("disk full") }
        assertEquals(NoteMove.NotMoved, store.move("n1", shown))
        PendingNotesStore.beforeRenameForTesting = null
        assertFalse(File(dir, "copy1.note.new").exists())
        val s = restarted()
        assertEquals(shown, s.entry("n1"))
        assertEquals(Read.Missing, s.read("copy1"))
    }

    @Test fun `an original written whose directory sync fails is a move that may not last a power loss, and the copy stays`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        var renamed = false
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") renamed = true }
        failDirectorySync = { renamed }
        assertEquals(NoteMove.Unsure("copy1"), store.move("n1", shown))
        failDirectorySync = { false }
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals(PendingEntry.Move("copy1", "b2"), entry("n1").move)
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
    }

    @Test fun `a never-synced original whose removal may not last a power loss is a move that may not, and the copy stays`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        var removing = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") removing = true }
        failDirectorySync = { removing }
        assertEquals(NoteMove.Unsure("copy1"), store.move("n1", entry("n1")))
        failDirectorySync = { false }
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
    }

    @Test fun `a move of a landed copy whose step may not last a power loss still points the waiting original's delete at the new copy`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        store.sendAndLand("copy1")
        var renamed = false
        var failed = false
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") renamed = true }
        failDirectorySync = { (renamed && !failed).also { if (it) failed = true } }
        assertEquals(NoteMove.Unsure("copy2"), store.moveNote("copy1", "b2", null, null, "del-copy1", blob("deleted copy1"),
            copyOf("copy2", notebook = "b3")))
        failDirectorySync = { false }
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals(PendingEntry.Move("copy2", "b3"), s.entry("copy1").move)
        assertEquals("the original never waits for a copy this device is deleting", PendingEntry.Move("copy2", "b3"), s.entry("n1").move)
    }

    @Test fun `a never-synced original whose removal may not last a power loss still answers its other editor's save as moved`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        val other = store.editorOpened("n1", entry("n1").version)
        var removing = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") removing = true }
        failDirectorySync = { removing }
        assertEquals(NoteMove.Unsure("copy1"), store.move("n1", entry("n1")))
        failDirectorySync = { false }
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(SaveOutcome.MovedAway, store.saveLocal(other, "n1", "b1", "r2", blob("late"), isCreate = true))
        assertEquals(Read.Missing, store.read("n1"))
    }

    @Test fun `a never-synced original whose removal may not last a power loss and then cannot be read is still moved, with its editor stopped`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        val other = store.editorOpened("n1", entry("n1").version)
        var removing = false
        var unlinked = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") removing = true }
        // The removal's unlink goes through and its directory sync fails; from then on the original cannot be read either.
        failDirectorySync = { if (removing) unlinked = true; removing }
        PendingNotesStore.beforeReadForTesting = { if (unlinked && it.name == "n1.note") throw IOException("read failed") }
        PendingNotesStore.presenceForTesting = { if (unlinked && it.name == "n1.note") PendingNotesStore.Presence.UNKNOWN else null }
        assertEquals("the original is gone in this process, whatever the read after it says", NoteMove.Unsure("copy1"),
            store.move("n1", entry("n1")))
        assertTrue(unlinked)
        failDirectorySync = { false }
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.beforeReadForTesting = null
        PendingNotesStore.presenceForTesting = null
        assertEquals(SaveOutcome.MovedAway, store.saveLocal(other, "n1", "b1", "r2", blob("late"), isCreate = true))
        assertEquals("nothing brings the original back", Read.Missing, store.read("n1"))
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
    }

    @Test fun `deleting a never-synced copy whose removal may not last a power loss and then cannot be read makes the waiting delete ordinary`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val copy1 = entry("copy1")
        var removing = false
        var unlinked = false
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "copy1.note") removing = true }
        // Only the removal's directory sync fails; from then on the copy cannot be read either.
        failDirectorySync = { (removing && !unlinked).also { if (it) unlinked = true } }
        PendingNotesStore.beforeReadForTesting = { if (unlinked && it.name == "copy1.note") throw IOException("read failed") }
        PendingNotesStore.presenceForTesting = { if (unlinked && it.name == "copy1.note") PendingNotesStore.Presence.UNKNOWN else null }
        assertThrows(PendingNotesStore.RemovalNotSynced::class.java) {
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1"))
        }
        assertTrue(unlinked)
        failDirectorySync = { false }
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.beforeReadForTesting = null
        PendingNotesStore.presenceForTesting = null
        assertEquals(Read.Missing, store.read("copy1"))
        assertNull("the user deleted the note: no copy to wait for", entry("n1").move)
    }

    /**
     * Makes the directory sync after the next rename onto [name] fail once, and every read of [name] fail from then on, as
     * when that step went through and nothing can show it. Returns whether the step was reached.
     */
    private fun failSyncThenReadsAfterRenameOf(name: String): () -> Boolean {
        var renaming = false
        var failed = false
        PendingNotesStore.beforeRenameForTesting = { if (it.name == name) renaming = true }
        failDirectorySync = { (renaming && !failed).also { if (it) failed = true } }
        PendingNotesStore.beforeReadForTesting = { if (failed && it.name == name) throw IOException("read failed") }
        PendingNotesStore.presenceForTesting = { if (failed && it.name == name) PendingNotesStore.Presence.UNKNOWN else null }
        return { failed }
    }

    private fun stopFailing() {
        failDirectorySync = { false }
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.beforeReadForTesting = null
        PendingNotesStore.presenceForTesting = null
    }

    @Test fun `deleting a copy whose delete is renamed into place before its sync fails, and then cannot be read, makes the waiting delete ordinary`() {
        // A copy that landed, so its delete is a new entry, and one that may have been sent, so its delete replaces its entry.
        for ((original, copy) in listOf("n1" to "copy1", "n2" to "copy3")) {
            assertEquals(NoteMove.Moved(copy), store.move(original, shown = null, copy = copyOf(copy)))
            if (copy == "copy1") store.sendAndLand(copy) else store.beginSend(copy)
            val shown = (store.read(copy) as? Read.Present)?.entry
            val reached = failSyncThenReadsAfterRenameOf("$copy.note")
            assertThrows(IOException::class.java) {
                store.deleteNote(copy, "b2", shown?.version, shown?.let { digest(it) }, discardConfirmed = shown != null, "del-$copy",
                    blob("deleted $copy"))
            }
            assertTrue(reached())
            stopFailing()
            assertEquals(PendingEntry.State.DELETE, entry(copy).state)
            assertNull("$original: the user deleted the note, so nothing waits for a copy", entry(original).move)
        }
    }

    @Test fun `moving a landed copy whose move delete is renamed into place before its sync fails, and then cannot be read, moves the waiting delete along`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        store.sendAndLand("copy1")
        val reached = failSyncThenReadsAfterRenameOf("copy1.note")
        assertEquals("the move stands in this process, whatever the read after it says", NoteMove.Unsure("copy2"),
            store.moveNote("copy1", "b2", null, null, "del-copy1", blob("deleted copy1"), copyOf("copy2", notebook = "b3")))
        assertTrue(reached())
        stopFailing()
        assertEquals(PendingEntry.Move("copy2", "b3"), entry("copy1").move)
        assertEquals(PendingEntry.Move("copy2", "b3"), entry("n1").move)
    }

    @Test fun `deleting a landed copy whose delete may not last a power loss still makes the waiting original's delete an ordinary one`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        store.sendAndLand("copy1")
        var renamed = false
        var failed = false
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") renamed = true }
        failDirectorySync = { (renamed && !failed).also { if (it) failed = true } }
        assertThrows(IOException::class.java) {
            store.deleteNote("copy1", "b2", null, null, discardConfirmed = true, "del-copy1", blob("deleted copy1"))
        }
        failDirectorySync = { false }
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals(PendingEntry.State.DELETE, s.entry("copy1").state)
        assertNull("the copy's delete went through here, so the original goes as an ordinary delete", s.entry("n1").move)
    }

    @Test fun `a delete of a copy whose write changed nothing leaves the waiting original's delete waiting`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val first = entry("n1")
        store.beginSend("copy1")
        val copy1 = entry("copy1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw IOException("rename failed") }
        assertThrows(IOException::class.java) {
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1"))
        }
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals("recovery drops a write over a committed entry", copy1, s.entry("copy1"))
        assertEquals("nothing was deleted, so the original still waits for its copy", first, s.entry("n1"))
    }

    @Test fun `a first delete of a landed copy stopped before its rename still makes the waiting original's delete an ordinary one`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        store.sendAndLand("copy1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw IOException("rename failed") }
        assertThrows(IOException::class.java) {
            store.deleteNote("copy1", "b2", null, null, discardConfirmed = true, "del-copy1", blob("deleted copy1"))
        }
        PendingNotesStore.beforeRenameForTesting = null
        val s = restarted()
        assertEquals("recovery commits the first write of a file", PendingEntry.State.DELETE, s.entry("copy1").state)
        assertNull(s.entry("n1").move)
    }

    @Test fun `a note file named for one uid that holds another note's move delete is never written back over that note`() {
        assertEquals(NoteMove.Moved("copy1"), store.move("n1", shown = null))
        val stale = File(dir, "n9.note")
        File(dir, "n1.note").copyTo(stale)
        val bytes = stale.readBytes()
        // The move does not finish (a run dropped its delete), so n1 shows again, and the user writes in it.
        assertTrue(store.dropDelete("n1", entry("n1").version))
        saved(store.saveLocal("n1", "b1", "r2", blob("newer text"), isCreate = false))
        val copy1 = entry("copy1")
        assertEquals(PendingNotesStore.NoteDelete.Dropped,
            store.deleteNote("copy1", "b2", copy1.version, digest(copy1), discardConfirmed = true, "del-copy1", blob("deleted copy1")))
        val n1 = entry("n1")
        assertEquals("n1's newer text is not replaced by the stale delete", PendingEntry.State.UPSERT, n1.state)
        assertArrayEquals(blob("newer text"), n1.blob)
        assertArrayEquals("left as it was", bytes, stale.readBytes())
    }

    @Test fun `a failed write of the original whose copy cannot be removed again keeps both`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw IOException("disk full") }
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "copy1.note") throw IOException("could not remove") }
        assertEquals(NoteMove.MaybeBoth, store.move("n1", shown))
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(shown, entry("n1"))
        assertEquals("the copy is kept: a duplicate, never a loss", PendingEntry.State.UPSERT, entry("copy1").state)
    }

    @Test fun `a failed write whose original then cannot be read keeps the copy`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        var failed = false
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") { failed = true; throw IOException("disk full") } }
        PendingNotesStore.beforeReadForTesting = { if (failed && it.name == "n1.note") throw IOException("read fails") }
        try {
            assertEquals(NoteMove.MaybeBoth, store.move("n1", shown))
        } finally {
            PendingNotesStore.beforeReadForTesting = null
        }
        PendingNotesStore.beforeRenameForTesting = null
        assertEquals(shown, entry("n1"))
        assertEquals(PendingEntry.State.UPSERT, entry("copy1").state)
        assertNull(store.landed("copy1"))
    }
}
