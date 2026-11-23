package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.PendingNotesStore.DeleteRefusal
import io.silentsuite.sync.notes.edit.PendingNotesStore.HoldOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.NoteDelete
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The user's delete of one note in the pending store ([PendingNotesStore.deleteNote]) and what every other store path
 * does with a pending delete: it is sent like an edit, never held (a hold drops it), never replaced by a save, and dropped
 * when a run finds the note changed elsewhere ([PendingNotesStore.dropDelete]).
 */
class PendingNotesStoreDeleteTest {
    @get:Rule val tmp = TemporaryFolder()

    private val dir by lazy { tmp.newFolder("store") }
    private val store by lazy { open(dir) }

    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private fun open(d: File) = PendingNotesStore.open(d, rename = atomicMove)

    @After fun reset() {
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.presenceForTesting = null
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

    /** The user's delete as the note screen sends it: [shown] is the entry it showed, or null for none. */
    private fun PendingNotesStore.delete(uid: String, shown: PendingEntry?, discard: Boolean = shown != null,
                                         revision: String = "del-$uid", notebookCopy: ByteArray? = null) =
        deleteNote(uid, "b1", shown?.version, shown?.let { digest(it) }, discard, revision, blob("deleted $uid"), notebookCopy)

    private fun permitsOf(s: PendingNotesStore) = PendingNotesDiscardPermits(File(s.dir.parentFile!!, PendingNotesDiscardPermits.ROOT),
        {}, atomicMove, PendingNotesStore.nioPresence)

    private fun filesOf(d: File): Map<String, String> =
        d.listFiles().orEmpty().filter { it.isFile }.associate { it.name to PendingNotesStore.digestOf(it.readBytes()) }

    // ---- a note with no entry ----

    @Test fun `a delete of a note with no entry writes a pending delete that survives a restart and is sent like an edit`() {
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null, notebookCopy = blob("notebook")))
        val s = restarted()
        val e = s.entry("n1")
        assertEquals(PendingEntry.State.DELETE, e.state)
        assertEquals("del-n1", e.revision)
        assertFalse("the note is on the server", e.isCreate)
        assertArrayEquals(blob("deleted n1"), e.blob)
        assertArrayEquals("its notebook copy is kept, as a save keeps it", blob("notebook"), s.notebook("b1"))
        // Sent as any entry: its revision recorded before the upload, then dropped once the server took it.
        val sent = (s.startSend("n1") as PendingNotesStore.SendStart.Ready).entry
        assertEquals(listOf("del-n1"), sent.sent)
        assertEquals(SendOutcome.Done, s.completeSend("n1", sent.version, "del-n1", blob("server deleted")))
        assertEquals(Read.Missing, s.read("n1"))
    }

    @Test fun `a delete with no entry takes a landed upload of this editor as ours`() {
        val editor = store.editorOpened("n1")
        saved(store.saveLocal(editor, "n1", "b1", "r1", blob("mine"), isCreate = true))
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "s1", blob("landed")))
        assertNotNull(store.landed("n1"))
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val e = entry("n1")
        assertFalse("not a create once it landed", e.isCreate)
        assertTrue("the landed revision counts as ours on a 409: ${e.sent}", "s1" in e.sent)
    }

    @Test fun `an entry or upload is an editor's own only when that editor wrote it, its load showed it, or a step moved its text there`() {
        val showing = store.editorOpened("n1")
        val writing = store.editorOpened("n1")
        val v1 = saved(store.saveLocal(writing, "n1", "b1", "r1", blob("typed in the second editor"), isCreate = false))
        assertFalse("another editor's entry", store.owns(showing, v1))
        assertTrue(store.owns(writing, v1))
        // An editor whose load showed that entry showed its text.
        val loaded = store.editorOpened("n1", base = v1)
        assertTrue(store.owns(loaded, v1))
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "s1", blob("landed")))
        val landed = store.landed("n1")!!
        assertEquals(v1, landed.version)
        assertFalse("nor its upload", store.owns(showing, landed.version))
        assertTrue(store.owns(writing, landed.version))
        assertTrue(store.owns(loaded, landed.version))
    }

    @Test fun `a delete that showed an entry finds none and writes nothing`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        val shown = entry("n1")
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "s1", blob("landed")))
        assertEquals(NoteDelete.Changed(Read.Missing), store.delete("n1", shown))
        assertEquals(Read.Missing, store.read("n1"))
    }

    // ---- unsynced text ----

    @Test fun `a delete over unsynced text needs the version and digest shown and the separate discard`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("mine"), isCreate = false))
        store.recordFailure("n1", entry("n1").version, "TRANSIENT", now = 5)
        store.beginSend("n1")
        val shown = entry("n1")
        assertEquals("none shown", NoteDelete.Changed(Read.Present(shown)), store.delete("n1", shown = null, discard = true))
        assertEquals("another version", NoteDelete.Changed(Read.Present(shown)),
            store.deleteNote("n1", "b1", shown.version + 1, digest(shown), true, "d", blob("deleted")))
        assertEquals("other text", NoteDelete.Changed(Read.Present(shown)),
            store.deleteNote("n1", "b1", shown.version, PendingNotesStore.digestOf(blob("other")), true, "d", blob("deleted")))
        assertEquals("another notebook", NoteDelete.Changed(Read.Present(shown)),
            store.deleteNote("n1", "b2", shown.version, digest(shown), true, "d", blob("deleted")))
        assertEquals("without the discard", NoteDelete.NeedsDiscard(Read.Present(shown)), store.delete("n1", shown, discard = false))
        assertEquals("nothing was written by any of them", shown, entry("n1"))

        assertEquals(NoteDelete.Recorded, store.delete("n1", shown, discard = true))
        val e = entry("n1")
        assertEquals(PendingEntry.State.DELETE, e.state)
        assertTrue("a new version above the text's", e.version > shown.version)
        assertEquals("its sent list stays, so an upload of ours is still known as ours", shown.sent, e.sent)
        assertEquals(0, e.failureCount)
        assertArrayEquals(blob("deleted n1"), e.blob)
    }

    @Test fun `a note that never reached the server is removed and nothing is sent`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("typed offline"), isCreate = true))
        assertEquals(NoteDelete.Dropped, store.delete("n1", entry("n1")))
        assertEquals(Read.Missing, store.read("n1"))
        assertTrue("nothing waits", restarted().snapshot { false }.headers.isEmpty())
    }

    @Test fun `a create that may have reached the server gets a pending delete instead`() {
        // Sent once: the upload may have landed.
        saved(store.saveLocal("sent", "b1", "r1", blob("a"), isCreate = true))
        store.beginSend("sent")
        assertEquals(NoteDelete.Recorded, store.delete("sent", entry("sent")))
        assertEquals(PendingEntry.State.DELETE, entry("sent").state)
        // A landed record there, or one whose check fails, counts as there.
        saved(store.saveLocal("landed", "b1", "r1", blob("b"), isCreate = true))
        File(dir, "landed.landed").writeBytes(blob("not even a record"))
        assertEquals(NoteDelete.Recorded, store.delete("landed", entry("landed")))
        saved(store.saveLocal("unknown", "b1", "r1", blob("c"), isCreate = true))
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == "unknown.landed") PendingNotesStore.Presence.UNKNOWN else null
        }
        assertEquals(NoteDelete.Recorded, store.delete("unknown", entry("unknown")))
        assertEquals(PendingEntry.State.DELETE, entry("unknown").state)
    }

    @Test fun `an original a conflict copy has not finished replacing is not deleted by itself, and the copy's drop leaves neither`() {
        saved(store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false))
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine"))
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        // The original's text is the copy's now: it cannot be deleted by itself.
        val original = entry("orig")
        assertEquals(NoteDelete.Refused(DeleteRefusal.UNFINISHED_ORIGINAL), store.delete("orig", original))
        assertEquals(original, entry("orig"))
        // Once the original can go, the copy, a create that never reached the server, is dropped, and its original is not
        // left to be sent as an edit later: recovery finishes the replacement first, or the drop takes it along.
        failing = false
        assertEquals(NoteDelete.Dropped, store.delete("copy1", entry("copy1")))
        assertEquals(Read.Missing, store.read("copy1"))
        assertEquals(Read.Missing, store.read("orig"))
    }

    // ---- refusals ----

    @Test fun `held text and an entry that cannot be read are not deleted here`() {
        saved(store.saveLocal("held", "b1", "r1", blob("a"), isCreate = false))
        store.hold("held", HeldReason.REJECTED, now = 5)
        val held = entry("held")
        assertEquals(NoteDelete.Refused(DeleteRefusal.HELD), store.delete("held", held))
        assertEquals(held, entry("held"))
        File(dir, "bad.note").writeBytes(blob("not an entry"))
        val before = filesOf(dir)
        assertEquals(NoteDelete.Refused(DeleteRefusal.UNREADABLE), store.delete("bad", shown = null))
        assertEquals(before, filesOf(dir))
    }

    @Test fun `a delete is refused while a discard of the whole store is unfinished, and the permit stays`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        saved(store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        val s = restarted()
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = setOf("n1.note")))
        val n2 = s.entry("n2")
        assertEquals(NoteDelete.Refused(DeleteRefusal.DISCARD_UNFINISHED), s.delete("n2", n2))
        assertEquals(NoteDelete.Refused(DeleteRefusal.DISCARD_UNFINISHED), s.delete("other", shown = null))
        assertEquals(n2, s.entry("n2"))
        assertEquals("the permit still holds back what it names",
            PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
        // While a permit that may be there cannot be read, too.
        PendingNotesDiscardPermits.onReadForTesting = { if (it.name.endsWith(".permit")) throw java.io.IOException("the read fails") }
        val t = restarted()
        assertEquals(NoteDelete.Refused(DeleteRefusal.DISCARD_UNFINISHED), t.delete("other", shown = null))
        assertEquals(Read.Missing, t.read("other"))
    }

    @Test fun `a removal hold refuses a delete and nothing is written`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = PendingNotesStore.forNoBackup(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1", {}, atomicMove)
        saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val hold = PendingNotesStore.RemovalHold()
        assertTrue(s.removalCheck(hold) is PendingNotesStore.RemovalCheck.Blocks)
        val before = filesOf(s.dir)
        assertEquals(NoteDelete.RemovalPending, s.delete("n1", s.entry("n1")))
        assertEquals(NoteDelete.RemovalPending, s.delete("n2", shown = null))
        assertEquals(before, filesOf(s.dir))
        hold.release()
        assertEquals(NoteDelete.Recorded, s.delete("n2", shown = null))
    }

    @Test fun `a pending delete already there is not written again`() {
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val e = entry("n1")
        assertEquals(NoteDelete.AlreadyDeleted, store.delete("n1", shown = null, revision = "other"))
        assertEquals(e, entry("n1"))
    }

    // ---- what other store paths do with a pending delete ----

    @Test fun `a save over a pending delete writes nothing, by uid and through an editor`() {
        val editor = store.editorOpened("n1")
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val e = entry("n1")
        assertEquals(SaveOutcome.Deleted, store.saveLocal("n1", "b1", "r2", blob("late"), isCreate = false))
        assertEquals(SaveOutcome.Deleted, store.saveLocal(editor, "n1", "b1", "r3", blob("later"), isCreate = false))
        assertEquals("the delete stays as it was", e, entry("n1"))
    }

    @Test fun `a delete that lands while an editor is open leaves no landed record to save onto`() {
        val editor = store.editorOpened("n1")
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "del-n1", blob("server deleted")))
        assertEquals(null, store.landed("n1"))
        // A save from that editor starts again from the copy it had, as a new entry, and its push meets the deleted copy.
        assertTrue(store.saveLocal(editor, "n1", "b1", "r2", blob("typed after"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(PendingEntry.State.UPSERT, entry("n1").state)
    }

    @Test fun `a pending delete is never held - a hold drops it, with the version check`() {
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val v = entry("n1").version
        assertEquals("another version", HoldOutcome.NOT_APPLIED, store.hold("n1", HeldReason.REJECTED, now = 5, sentVersion = v + 1))
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
        assertEquals(HoldOutcome.DELETE_DROPPED, store.hold("n1", HeldReason.REJECTED, now = 5, sentVersion = v))
        assertEquals(Read.Missing, store.read("n1"))
        // A reason about the notebook drops whatever version is there.
        assertEquals(NoteDelete.Recorded, store.delete("n2", shown = null))
        assertEquals(HoldOutcome.DELETE_DROPPED, store.hold("n2", HeldReason.READ_ONLY, now = 5))
        assertEquals(Read.Missing, store.read("n2"))
    }

    @Test fun `dropDelete removes only the pending delete at the version sent`() {
        saved(store.saveLocal("edit", "b1", "r1", blob("a"), isCreate = false))
        assertFalse("an edit is never dropped this way", store.dropDelete("edit", entry("edit").version))
        assertEquals(NoteDelete.Recorded, store.delete("n1", shown = null))
        val v = entry("n1").version
        assertFalse(store.dropDelete("n1", v + 1))
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
        assertTrue(store.dropDelete("n1", v))
        assertEquals(Read.Missing, store.read("n1"))
        assertFalse("nothing left to drop", store.dropDelete("n1", v))
    }

    @Test fun `a rebase of a pending delete onto an upload of ours keeps it a delete with that base`() {
        saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        store.beginSend("n1")
        assertEquals(NoteDelete.Recorded, store.delete("n1", entry("n1")))
        val e = entry("n1")
        assertTrue(store.rebase("n1", e.version, onto = "r1", revision = "del-2", blob = blob("deleted onto r1")))
        val rebased = entry("n1")
        assertEquals(PendingEntry.State.DELETE, rebased.state)
        assertTrue(rebased.version > e.version)
        assertEquals("r1", rebased.sent.last())
        assertEquals("del-2", rebased.revision)
    }

    @Test fun `a pending delete is written and read back in its own state code`() {
        val e = PendingEntry("n1", "b1", PendingEntry.State.DELETE, 7, "d1", false, sent = listOf("s1"), blob = blob("deleted"))
        val bytes = PendingCodec.encodeEntry(e)
        assertEquals(PendingCodec.Decoded.Ok(e), PendingCodec.decodeEntry(bytes))
        val header = PendingCodec.decodeEntryHeader(bytes.copyOf(PendingCodec.entryHeaderEnd(bytes)!!))
        assertEquals(PendingCodec.Decoded.Ok(PendingNotesStore.EntryHeader.of(e)), header)
        // Code 4, after the header's two uids, as entry files hold it; code 2 stays unread.
        val stateAt = PendingCodec.ENTRY_PREFIX + 2 + "n1".length + 2 + "b1".length
        assertEquals(4, bytes[stateAt].toInt())
    }
}
