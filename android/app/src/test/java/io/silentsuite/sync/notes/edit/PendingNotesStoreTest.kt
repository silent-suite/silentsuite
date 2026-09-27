package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.PendingNotesStore.DeleteOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PendingNotesStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val dir by lazy { tmp.newFolder("store") }
    private val store by lazy { PendingNotesStore.open(dir) }

    @After fun reset() {
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.afterFallbackDeleteForTesting = null
        PendingNotesStore.forceRenameFallbackForTesting = false
        PendingNotesStore.resetForTesting()
    }

    /** A process restart: the in-memory instance is gone, the directory stays. */
    private fun restarted(): PendingNotesStore {
        PendingNotesStore.resetForTesting()
        return PendingNotesStore.open(dir)
    }

    private fun PendingNotesStore.entry(uid: String): PendingEntry = (read(uid) as Read.Present).entry

    private fun entry(uid: String) = store.entry(uid)

    private fun blob(text: String) = text.toByteArray()

    private fun saved(outcome: SaveOutcome) = (outcome as SaveOutcome.Saved).version

    // ---- one instance and one lock per identity ----

    @Test fun `every caller for one directory gets the same instance and so the same lock`() {
        assertSame(store, PendingNotesStore.open(dir))
        assertSame(store, PendingNotesStore.open(File(dir.parentFile, "./store")))
        assertNotSame(store, PendingNotesStore.open(tmp.newFolder("other")))
    }

    @Test fun `a cleared store refuses any later use and the next open starts fresh`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        store.putNotebook("b1", blob("k"))
        store.clearAll()
        assertFalse(dir.exists())
        assertThrows(IllegalStateException::class.java) { store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false) }
        assertThrows(IllegalStateException::class.java) { store.completeSend("n1", 1, "r1", blob("late landing")) }
        assertFalse("nothing was written back after sign-out", dir.exists())
        val fresh = PendingNotesStore.open(dir)
        assertNotSame(store, fresh)
        assertTrue(fresh.scan().entries.isEmpty())
    }

    // ---- versions ----

    @Test fun `versions only grow even across a drop and a new entry for the same note`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = true))
        val snapshot = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", snapshot.version, "r1", blob("landed")))
        val v2 = saved(store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = false))
        assertTrue(v2 > v1)
        assertTrue("the counter survives a restart", saved(restarted().saveLocal("n2", "b1", "x", blob("x"), isCreate = true)) > v2)
    }

    @Test fun `a lost counter restarts above every version still on disk`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val high = saved(store.saveLocal("n1", "b1", "r2", blob("b"), isCreate = false))
        File(dir, "sequence").delete()
        assertTrue(saved(restarted().saveLocal("n2", "b1", "r", blob("c"), isCreate = false)) > high)
    }

    // ---- editor saves and deletes ----

    @Test fun `a later save replaces the content and resets the backoff`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = true))
        assertTrue(store.recordFailure("n1", v1, "TRANSIENT", now = 100))
        store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = true)
        val e = entry("n1")
        assertEquals("r2", e.revision)
        assertTrue(e.isCreate)
        assertEquals(0, e.failureCount)
        assertNull(e.lastFailureAt)
        assertArrayEquals(blob("two"), e.blob)
    }

    @Test fun `a save that reaches a pending delete is discarded since a delete is final`() {
        store.saveLocal("n1", "b1", "r1", blob("text"), isCreate = false)
        assertEquals(DeleteOutcome.Queued, store.markDeleted("n1", "b1", "r-del", blob("deleted")))
        assertEquals(SaveOutcome.Discarded, store.saveLocal("n1", "b1", "r3", blob("late autosave"), isCreate = false))
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
        assertEquals("r-del", entry("n1").revision)
    }

    @Test fun `deleting a create that was never sent just removes it`() {
        store.saveLocal("n1", "b1", "r1", blob("draft"), isCreate = true)
        assertEquals(DeleteOutcome.Removed, store.markDeleted("n1", "b1", "r-del", blob("x")))
        assertEquals(Read.Missing, store.read("n1"))
    }

    @Test fun `deleting a sent create queues a delete that keeps the sent list and is pushed`() {
        store.saveLocal("n1", "b1", "r1", blob("draft"), isCreate = true)
        store.beginSend("n1")
        assertEquals(DeleteOutcome.Queued, store.markDeleted("n1", "b1", "r-del", blob("x")))
        assertEquals(listOf("r1"), entry("n1").sent)
        val snapshot = store.beginSend("n1")!!
        assertEquals(PendingEntry.State.DELETE, snapshot.state)
        assertEquals(listOf("r1", "r-del"), snapshot.sent)
        assertEquals(snapshot, entry("n1"))
    }

    @Test fun `deleting a synced note with no entry queues a delete and a second delete is a no-op`() {
        assertEquals(DeleteOutcome.Queued, store.markDeleted("n1", "b1", "r-del", blob("x")))
        assertEquals(DeleteOutcome.AlreadyQueued, store.markDeleted("n1", "b1", "r-del2", blob("y")))
        assertEquals("r-del", entry("n1").revision)
    }

    // ---- landed evidence ----

    @Test fun `a save after our own create landed is not a create and knows the landed revision is ours`() {
        store.saveLocal("n1", "b1", "c1", blob("first"), isCreate = true)
        store.completeSend("n1", store.beginSend("n1")!!.version, "c1", blob("landed"))
        store.saveLocal("n1", "b1", "c2", blob("second"), isCreate = true)
        val e = entry("n1")
        assertFalse(e.isCreate)
        assertEquals(listOf("c1"), e.sent)
        assertEquals("the landed note is not silently forgotten", DeleteOutcome.Queued, store.markDeleted("n1", "b1", "d", blob("x")))
    }

    @Test fun `a delete after a landed save still recognizes the landed revision after the editor clears it`() {
        store.saveLocal("n1", "b1", "r1", blob("edit"), isCreate = false)
        store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed"))
        store.markDeleted("n1", "b1", "d1", blob("deleted"))
        store.clearLanded("n1")
        val e = entry("n1")
        assertEquals(listOf("r1"), e.sent)
        assertEquals(NotePushPolicy.ConflictOutcome.REBASE, NotePushPolicy.decide(e, null, NotePushPolicy.ServerCopy("r1", false)))
    }

    // ---- pushing ----

    @Test fun `beginSend records the revision once and never moves the version`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = true)
        val version = entry("n1").version
        val snapshot = store.beginSend("n1")!!
        assertEquals(listOf("r1"), snapshot.sent)
        assertEquals(version, snapshot.version)
        assertEquals(snapshot, store.beginSend("n1"))
    }

    @Test fun `a successful send drops the entry and keeps the landed item with its version`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = true)
        val snapshot = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", snapshot.version, "r1", blob("saved")))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(LandedRecord("n1", "r1", snapshot.version, blob("saved")), store.landed("n1"))
        store.clearLanded("n1")
        assertNull(store.landed("n1"))
    }

    @Test fun `a save during the upload keeps the entry for a rebase that keeps its sent list`() {
        store.saveLocal("n1", "b1", "r1", blob("v1"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.saveLocal("n1", "b1", "r2", blob("v2"), isCreate = false)
        val newer = (store.completeSend("n1", snapshot.version, "r1", blob("saved v1")) as SendOutcome.NewerLocalChange).entry
        assertFalse("a stale rebase is refused", store.rebase("n1", snapshot.version, "r2b", blob("x")))
        assertTrue(store.rebase("n1", newer.version, "r2b", blob("v2 on r1")))
        val rebased = entry("n1")
        assertTrue(rebased.version > newer.version)
        assertEquals("r2b", rebased.revision)
        assertEquals(listOf("r1"), rebased.sent)
    }

    @Test fun `a delete made during the upload stays a delete through the rebase`() {
        store.saveLocal("n1", "b1", "r1", blob("v1"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.markDeleted("n1", "b1", "r-del", blob("deleted"))
        assertEquals(listOf("r1"), entry("n1").sent)
        val newer = (store.completeSend("n1", snapshot.version, "r1", blob("s")) as SendOutcome.NewerLocalChange).entry
        assertTrue(store.rebase("n1", newer.version, "r-del-on-r1", blob("deleted on r1")))
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
    }

    @Test fun `a failure of an older snapshot does not touch a newer change`() {
        store.saveLocal("n1", "b1", "r1", blob("huge"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.saveLocal("n1", "b1", "r2", blob("trimmed"), isCreate = false)
        assertFalse(store.recordFailure("n1", snapshot.version, "TRANSIENT", now = 10))
        assertFalse("a rejection of the old content does not hold the new", store.hold("n1", HeldReason.REJECTED, 10, sentVersion = snapshot.version))
        val e = entry("n1")
        assertEquals(PendingEntry.State.UPSERT, e.state)
        assertEquals(0, e.failureCount)
        assertTrue("a notebook-level reason holds whatever is there", store.hold("n1", HeldReason.READ_ONLY, 11))
    }

    @Test fun `failures count up without moving the version`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        val version = entry("n1").version
        store.recordFailure("n1", version, "TRANSIENT", now = 10)
        store.recordFailure("n1", version, "LOCAL", now = 20)
        val e = entry("n1")
        assertEquals(2, e.failureCount)
        assertEquals(20L, e.lastFailureAt)
        assertEquals("LOCAL", e.lastFailureCategory)
        assertEquals(version, e.version)
    }

    // ---- holding ----

    @Test fun `held text takes the editor's latest save and is never sent`() {
        store.saveLocal("n1", "b1", "r1", blob("Hello"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        assertTrue(store.hold("n1", HeldReason.READ_ONLY, now = 50))
        val outcome = store.saveLocal("n1", "b1", "r2", blob("Hello world"), isCreate = false)
        assertTrue(outcome is SaveOutcome.SavedToHolding)
        val e = entry("n1")
        assertEquals(PendingEntry.State.HELD, e.state)
        assertEquals(PendingEntry.Held(HeldReason.READ_ONLY, 50), e.held)
        assertArrayEquals(blob("Hello world"), e.blob)
        assertNull(store.beginSend("n1"))
        assertFalse(store.rebase("n1", e.version, "r3", blob("x")))
        assertFalse(store.replaceWithNewNote("n1", e.version, "srv", PendingEntry("c", "b1", PendingEntry.State.UPSERT, 0, "c", true, blob = blob("x"))))
        assertEquals(DeleteOutcome.Held, store.markDeleted("n1", "b1", "d", blob("x")))
        assertTrue(snapshot.version < e.version)
        store.discard("n1")
        assertEquals(Read.Missing, store.read("n1"))
    }

    // ---- conflicts ----

    @Test fun `a conflict's new note replaces the original and keeps no link once done`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        assertFalse("a stale version is refused", store.replaceWithNewNote("orig", entry("orig").version + 5, "srv", copy))
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", copy))
        assertEquals(Read.Missing, store.read("orig"))
        assertNull(entry("copy1").origin)
    }

    @Test fun `a crash between writing the copy and removing the original is finished with no second copy`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        val after = restarted()
        assertEquals(listOf("copy1"), after.scan().entries.map { it.noteUid })
        assertNull(after.entry("copy1").origin)
    }

    @Test fun `text typed after a conflict is never removed by the recovery of that conflict`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        // The next process finishes the copy, then the user merges by hand and deletes another note.
        val after = restarted()
        after.saveLocal("orig", "b1", "r2", blob("merged by hand"), isCreate = false)
        after.markDeleted("other", "b1", "d", blob("x"))
        for (i in 1..3) restarted().scan()
        assertArrayEquals(blob("merged by hand"), restarted().entry("orig").blob)
    }

    @Test fun `if the original changed after the copy was taken both are kept`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        PendingNotesStore.beforeOriginalRemovedForTesting = {
            // Another save lands in the gap (same instance, same thread, so under the same lock).
            store.saveLocal("orig", "b1", "r2", blob("typed after the copy"), isCreate = false)
            throw IllegalStateException("process died")
        }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        assertEquals(listOf("copy1", "orig"), restarted().scan().entries.map { it.noteUid })
    }

    // ---- crash safety and damage ----

    @Test fun `a crash before the rename leaves the last committed entry`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.saveLocal("n1", "b1", "r2", blob("in flight"), isCreate = false) }
        PendingNotesStore.beforeRenameForTesting = null
        assertTrue("the crash hit the note write itself", File(dir, "n1.note.new").exists())
        val after = restarted()
        assertEquals("r1", after.entry("n1").revision)
        assertTrue(after.scan().unreadable.isEmpty())
        assertFalse("the complete but uncommitted write was dropped", File(dir, "n1.note.new").exists())
    }

    @Test fun `a crash in the rename fallback after the old file went restores the complete new one`() {
        store.saveLocal("n1", "b1", "r1", blob("old"), isCreate = false)
        PendingNotesStore.forceRenameFallbackForTesting = true
        PendingNotesStore.afterFallbackDeleteForTesting = { if (it.name == "n1.note") throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.saveLocal("n1", "b1", "r2", blob("new"), isCreate = false) }
        PendingNotesStore.afterFallbackDeleteForTesting = null
        PendingNotesStore.forceRenameFallbackForTesting = false
        val after = restarted()
        assertEquals("r2", after.entry("n1").revision)
        assertArrayEquals(blob("new"), after.entry("n1").blob)
    }

    @Test fun `a failed write is sorted out before the next operation of the same instance`() {
        store.saveLocal("n1", "b1", "r1", blob("old"), isCreate = false)
        PendingNotesStore.forceRenameFallbackForTesting = true
        PendingNotesStore.afterFallbackDeleteForTesting = { if (it.name == "n1.note") throw java.io.IOException("rename refused") }
        assertThrows(java.io.IOException::class.java) { store.saveLocal("n1", "b1", "r2", blob("new"), isCreate = false) }
        PendingNotesStore.afterFallbackDeleteForTesting = null
        PendingNotesStore.forceRenameFallbackForTesting = false
        assertEquals("the same instance recovers the synced write instead of reading Missing", "r2", entry("n1").revision)
    }

    @Test fun `an unreadable entry is reported never overwritten and never deleted by a scan`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        val file = File(dir, "n1.note")
        file.writeBytes(file.readBytes().copyOf(10))
        val scan = store.scan()
        assertTrue(scan.entries.isEmpty())
        assertEquals("n1.note", scan.unreadable.single().file)
        assertEquals(SaveOutcome.Blocked, store.saveLocal("n1", "b1", "r2", blob("new"), isCreate = false))
        assertEquals(DeleteOutcome.Blocked, store.markDeleted("n1", "b1", "r3", blob("x")))
        assertEquals(10L, file.length())
    }

    @Test fun `a leftover new file beside a committed one is dropped and the committed one wins`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        File(dir, "n1.note.new").writeBytes(byteArrayOf(1, 2, 3))
        assertEquals("r1", restarted().scan().entries.single().revision)
        assertFalse(File(dir, "n1.note.new").exists())
    }

    @Test fun `a complete new file with no committed one is restored and an incomplete one is dropped`() {
        val complete = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("synced before the crash"))
        dir.mkdirs()
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(complete))
        File(dir, "n2.note.new").writeBytes(PendingCodec.encodeEntry(complete.copy(noteUid = "n2")).copyOf(20))
        val scan = store.scan()
        assertEquals(listOf(complete), scan.entries)
        assertTrue(scan.unreadable.isEmpty())
        assertFalse(File(dir, "n2.note.new").exists())
    }

    @Test fun `removing an entry also removes a stale new file so a later recovery cannot bring it back`() {
        store.saveLocal("n1", "b1", "r1", blob("draft"), isCreate = true)
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(entry("n1").copy(revision = "r-old")))
        assertEquals(DeleteOutcome.Removed, store.markDeleted("n1", "b1", "d", blob("x")))
        assertEquals(Read.Missing, restarted().read("n1"))
    }

    @Test fun `one bad leftover does not stop recovery or listing of the others`() {
        store.saveLocal("n1", "b1", "r1", blob("fine"), isCreate = false)
        File(dir, "bad.note.new").mkdirs()
        val scan = restarted().scan()
        assertEquals(listOf("n1"), scan.entries.map { it.noteUid })
        assertEquals("bad.note.new", scan.unreadable.single().file)
    }

    // ---- views for the screens ----

    @Test fun `a snapshot keeps only the blobs asked for and reads the sequence with the headers`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        store.saveLocal("n2", "b2", "r1", blob("two"), isCreate = true)
        store.markDeleted("n3", "b1", "d", blob("gone"))
        val snapshot = store.snapshot { it.notebookUid == "b1" && it.state == PendingEntry.State.UPSERT }
        assertEquals(listOf("n1", "n2", "n3"), snapshot.headers.map { it.noteUid })
        assertEquals(PendingNotesStore.EntryHeader("n1", "b1", PendingEntry.State.UPSERT, v1), snapshot.headers.first())
        assertEquals(PendingEntry.State.DELETE, snapshot.headers.last().state)
        assertEquals(setOf("n1"), snapshot.entries.keys)
        assertArrayEquals(blob("one"), snapshot.entries.getValue("n1").blob)
        assertEquals(3L, snapshot.sequence)
    }

    @Test fun `observing a note reads its entry and the sequence together, also when there is no entry`() {
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = false)
        assertEquals(PendingNotesStore.Observed(Read.Present(entry("n1")), 2), store.observe("n1"))
        assertEquals(PendingNotesStore.Observed(Read.Missing, 2), store.observe("n9"))
        // A drop leaves the sequence where it was, so a load after a push is never taken for an older one.
        store.discard("n1")
        assertEquals(2L, store.observe("n1").sequence)
        assertEquals(0L, PendingNotesStore.open(tmp.newFolder("empty")).observe("n1").sequence)
    }

    @Test fun `a recovery problem does not outlive its file`() {
        store.saveLocal("n1", "b1", "r1", blob("fine"), isCreate = false)
        File(dir, "bad.note.new").mkdirs()
        val reopened = restarted()
        assertEquals(listOf("bad.note.new"), reopened.scan().unreadable.map { it.file })
        assertEquals(listOf("bad.note.new"), reopened.snapshot { false }.unreadable.map { it.file })
        File(dir, "bad.note.new").delete()
        assertTrue(reopened.scan().unreadable.isEmpty())
        assertTrue(reopened.snapshot { false }.unreadable.isEmpty())
    }

    // ---- notebooks, identity, safety ----

    @Test fun `notebook copies stay while an entry or held text needs them`() {
        store.putNotebook("b3", blob("key b3"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n2", "b2", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b2"))
        store.hold("n2", HeldReason.LOST_ACCESS, 1)
        assertEquals(listOf("b3"), store.pruneNotebooks())
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
        assertArrayEquals(blob("key b2"), store.notebook("b2"))
        assertNull(store.notebook("b3"))
    }

    @Test fun `no notebook copy is pruned while any entry is unreadable`() {
        store.putNotebook("b9", blob("key"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        File(dir, "n1.note").writeBytes(byteArrayOf(0))
        assertTrue(store.pruneNotebooks().isEmpty())
        assertArrayEquals(blob("key"), store.notebook("b9"))
    }

    @Test fun `uids that could escape the directory are refused for every kind of file`() {
        for (uid in listOf("../x", "a/b", "", ".", "a b", "x".repeat(129))) {
            assertThrows(uid, IllegalArgumentException::class.java) { store.read(uid) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.putNotebook(uid, blob("k")) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.notebook(uid) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.landed(uid) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.clearLanded(uid) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.completeSend(uid, 1, "r", blob("x")) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.discard(uid) }
            assertThrows(uid, IllegalArgumentException::class.java) { store.saveLocal("n1", uid, "r", blob("x"), isCreate = false, notebookCopy = blob("k")) }
        }
        assertEquals(listOf("store"), tmp.root.listFiles()!!.map { it.name })
    }

    @Test fun `each exact identity gets its own directory`() {
        val root = tmp.root
        val a = PendingNotesStore.identityDir(root, "io.silentsuite", "alice", "gen-1")
        val b = PendingNotesStore.identityDir(root, "io.silentsuite", "alice", "gen-2")
        val c = PendingNotesStore.identityDir(root, "io.silentsuite", "alic", "egen-1")
        assertNotEquals(a, b)
        assertNotEquals(a, c)
        assertEquals(a, PendingNotesStore.identityDir(root, "io.silentsuite", "alice", "gen-1"))
        assertEquals(File(root, "notes-pending"), a.parentFile)
    }
}
