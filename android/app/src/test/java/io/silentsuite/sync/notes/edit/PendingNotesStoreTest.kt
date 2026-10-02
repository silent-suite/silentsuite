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
    private val store by lazy { open(dir) }

    /**
     * Replaces the target in one step on every platform the tests run on. File.renameTo does that on
     * Linux and Android, but not on Windows, where these tests also run.
     */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    private fun open(d: File) = PendingNotesStore.open(d, rename = atomicMove)

    @After fun reset() {
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        PendingNotesStore.beforeRenameForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.beforeClearForTesting = null
        PendingNotesStore.resetForTesting()
    }

    /** A process restart: the in-memory instance is gone, the directory stays. */
    private fun restarted(): PendingNotesStore {
        PendingNotesStore.resetForTesting()
        return open(dir)
    }

    private fun PendingNotesStore.entry(uid: String): PendingEntry = (read(uid) as Read.Present).entry

    private fun entry(uid: String) = store.entry(uid)

    private fun blob(text: String) = text.toByteArray()

    private fun saved(outcome: SaveOutcome) = (outcome as SaveOutcome.Saved).version

    // ---- one instance and one lock per identity ----

    @Test fun `every caller for one directory gets the same instance and so the same lock`() {
        assertSame(store, open(dir))
        assertSame(store, open(File(dir.parentFile, "./store")))
        assertNotSame(store, open(tmp.newFolder("other")))
    }

    @Test fun `a cleared store stays closed for the rest of the process, whoever opens it again`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        store.putNotebook("b1", blob("k"))
        store.clearAll()
        assertFalse(dir.exists())
        assertThrows(IllegalStateException::class.java) { store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false) }
        assertThrows(IllegalStateException::class.java) { store.completeSend("n1", 1, "r1", blob("late landing")) }
        // A late save that opens the store again (an editor or runner still unwinding) gets the same
        // closed instance, so it cannot bring the signed-out identity's directory back.
        val reopened = open(dir)
        assertSame(store, reopened)
        assertThrows(IllegalStateException::class.java) { reopened.saveLocal("n3", "b1", "r1", blob("later still"), isCreate = false) }
        assertFalse("nothing was written back after sign-out", dir.exists())
        // Only a new process starts over, and it finds nothing.
        assertTrue(restarted().scan().entries.isEmpty())
    }

    @Test fun `a sign-out clear that failed is done by the next try`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("could not clear the pending store") }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        PendingNotesStore.beforeClearForTesting = null
        assertTrue(dir.exists())
        assertThrows("already closed to new writes", IllegalStateException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false)
        }
        store.clearAll()
        assertFalse("the retry deleted what the first try left", dir.exists())
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
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "c1", blob("first"), isCreate = true)
        store.completeSend("n1", store.beginSend("n1")!!.version, "c1", blob("landed"))
        store.saveLocal("n1", "b1", "c2", blob("second"), isCreate = true)
        val e = entry("n1")
        assertFalse(e.isCreate)
        assertEquals(listOf("c1"), e.sent)
        assertEquals("the landed note is not silently forgotten", DeleteOutcome.Queued, store.markDeleted("n1", "b1", "d", blob("x")))
    }

    @Test fun `a delete after a landed save still recognizes the landed revision after the editor clears it`() {
        store.editorOpened("n1")
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
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = true)
        val snapshot = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", snapshot.version, "r1", blob("saved")))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(LandedRecord("n1", "r1", snapshot.version, blob("saved")), store.landed("n1"))
        store.clearLanded("n1")
        assertNull(store.landed("n1"))
    }

    @Test fun `a pushed delete keeps no landed copy of the note and drops an older one`() {
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "r1", blob("text"), isCreate = false)
        store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed text"))
        store.markDeleted("n1", "b1", "d1", blob("deleted"))
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "d1", blob("deleted on server")))
        assertEquals(Read.Missing, store.read("n1"))
        assertNull(store.landed("n1"))
        assertFalse(File(dir, "n1.landed").exists())
    }

    @Test fun `landed copies exist only while an editor for the note is open`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed a"))
        assertNull("with no editor open, no full copy of the note is kept", store.landed("n1"))
        assertFalse(File(dir, "n1.landed").exists())
        val first = store.editorOpened("n2")
        val second = store.editorOpened("n2")
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.completeSend("n2", store.beginSend("n2")!!.version, "r1", blob("landed b"))
        assertEquals("r1", store.landed("n2")?.revision)
        store.editorClosed(first)
        store.editorClosed(first)
        assertEquals("one editor is still open, and closing the other twice counted once", "r1", store.landed("n2")?.revision)
        store.editorClosed(second)
        assertNull(store.landed("n2"))
        assertFalse(File(dir, "n2.landed").exists())
        store.editorClosed(second)
    }

    @Test fun `no landed copy outlives the process that kept it`() {
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed a"))
        assertTrue(File(dir, "n1.landed").exists())
        assertNull("no editor survives a restart, so the copy has no use", restarted().landed("n1"))
        assertFalse(File(dir, "n1.landed").exists())
    }

    @Test fun `a save during the upload keeps the entry for a rebase that keeps its sent list`() {
        store.saveLocal("n1", "b1", "r1", blob("v1"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.saveLocal("n1", "b1", "r2", blob("v2"), isCreate = false)
        val newer = (store.completeSend("n1", snapshot.version, "r1", blob("saved v1")) as SendOutcome.NewerLocalChange).entry
        assertFalse("a stale rebase is refused", store.rebase("n1", snapshot.version, onto = "r1", revision = "r2b", blob = blob("x")))
        assertTrue(store.rebase("n1", newer.version, onto = "r1", revision = "r2b", blob = blob("v2 on r1")))
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
        assertTrue(store.rebase("n1", newer.version, onto = "r1", revision = "r-del-on-r1", blob = blob("deleted on r1")))
        assertEquals(PendingEntry.State.DELETE, entry("n1").state)
    }

    @Test fun `a rebase moves the revision it was built on to the newest end of the sent list`() {
        // 32 revisions sent without one confirmed answer. The oldest, s1, is the server's current copy.
        for (i in 1..PendingEntry.MAX_SENT) {
            store.saveLocal("n1", "b1", "s$i", blob("t$i"), isCreate = false)
            store.beginSend("n1")
        }
        assertEquals((1..PendingEntry.MAX_SENT).map { "s$it" }, entry("n1").sent)
        assertTrue(store.rebase("n1", entry("n1").version, onto = "s1", revision = "x1", blob = blob("on s1")))
        assertEquals("nothing else left the list", (2..PendingEntry.MAX_SENT).map { "s$it" } + "s1", entry("n1").sent)
        // The next send appends the rebased revision. The cap drops the oldest end, not the server's copy.
        assertEquals(listOf("s1", "x1"), store.beginSend("n1")!!.sent.takeLast(2))
        assertEquals("s3", entry("n1").sent.first())
        assertEquals(PendingEntry.MAX_SENT, entry("n1").sent.size)
    }

    @Test fun `a rebase onto a revision matched through the landed record adds it to the sent list`() {
        store.saveLocal("n1", "b1", "r2", blob("t"), isCreate = false)
        store.beginSend("n1")
        assertTrue(store.rebase("n1", entry("n1").version, onto = "landed-1", revision = "r3", blob = blob("on landed-1")))
        assertEquals(listOf("r2", "landed-1"), entry("n1").sent)
        assertEquals("already newest, so nothing moves", listOf("r2", "landed-1"),
            entry("n1").withNewestSent("landed-1").sent)
        // Joining a list that is already full drops the oldest revision, as any send does.
        for (i in 1..PendingEntry.MAX_SENT) {
            store.saveLocal("n2", "b1", "s$i", blob("t$i"), isCreate = false)
            store.beginSend("n2")
        }
        assertTrue(store.rebase("n2", entry("n2").version, onto = "landed-2", revision = "x1", blob = blob("on landed-2")))
        assertEquals((2..PendingEntry.MAX_SENT).map { "s$it" } + "landed-2", entry("n2").sent)
    }

    @Test fun `a failure of an older snapshot does not touch a newer change`() {
        store.saveLocal("n1", "b1", "r1", blob("huge"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.saveLocal("n1", "b1", "r2", blob("trimmed"), isCreate = false)
        assertFalse(store.recordFailure("n1", snapshot.version, "TRANSIENT", now = 10))
        assertEquals("a rejection of the old content does not hold the new", PendingNotesStore.HoldOutcome.NOT_APPLIED,
            store.hold("n1", HeldReason.REJECTED, 10, sentVersion = snapshot.version))
        val e = entry("n1")
        assertEquals(PendingEntry.State.UPSERT, e.state)
        assertEquals(0, e.failureCount)
        assertEquals("a notebook-level reason holds whatever is there", PendingNotesStore.HoldOutcome.HELD,
            store.hold("n1", HeldReason.READ_ONLY, 11))
    }

    @Test fun `a delete that cannot be pushed is dropped, not held as text`() {
        store.markDeleted("n1", "b1", "d1", blob("title only"))
        assertEquals(PendingNotesStore.HoldOutcome.DELETE_DROPPED, store.hold("n1", HeldReason.READ_ONLY, now = 5))
        assertEquals("the server copy stays; nothing local is left to show", Read.Missing, store.read("n1"))
        store.markDeleted("n2", "b1", "d2", blob("title only"))
        val sent = store.beginSend("n2")!!
        assertEquals(PendingNotesStore.HoldOutcome.DELETE_DROPPED,
            store.hold("n2", HeldReason.REJECTED, now = 6, sentVersion = sent.version))
        assertEquals(Read.Missing, store.read("n2"))
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
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("n1", HeldReason.READ_ONLY, now = 50))
        val outcome = store.saveLocal("n1", "b1", "r2", blob("Hello world"), isCreate = false)
        assertTrue(outcome is SaveOutcome.SavedToHolding)
        val e = entry("n1")
        assertEquals(PendingEntry.State.HELD, e.state)
        assertEquals(PendingEntry.Held(HeldReason.READ_ONLY, 50), e.held)
        assertArrayEquals(blob("Hello world"), e.blob)
        assertNull(store.beginSend("n1"))
        assertFalse(store.rebase("n1", e.version, onto = "r1", revision = "r3", blob = blob("x")))
        assertFalse(store.replaceWithNewNote("n1", e.version, "srv", PendingEntry("c", "b1", PendingEntry.State.UPSERT, 0, "c", true, blob = blob("x"))))
        assertEquals(DeleteOutcome.Held, store.markDeleted("n1", "b1", "d", blob("x")))
        assertTrue(snapshot.version < e.version)
        store.discard("n1")
        assertEquals(Read.Missing, store.read("n1"))
    }

    @Test fun `try again puts held text back in line for a push with a fresh backoff`() {
        val v = saved(store.saveLocal("n1", "b1", "r1", blob("rejected once"), isCreate = false))
        assertTrue(store.recordFailure("n1", v, "REJECTED", now = 5))
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("n1", HeldReason.REJECTED, now = 6, sentVersion = v))
        assertTrue(store.release("n1"))
        val e = entry("n1")
        assertEquals(PendingEntry.State.UPSERT, e.state)
        assertNull(e.held)
        assertEquals(0, e.failureCount)
        assertNull(e.lastFailureCategory)
        assertEquals("the base is kept, so a changed server copy still conflicts", "r1", e.revision)
        assertTrue(e.version > v)
        assertArrayEquals(blob("rejected once"), store.beginSend("n1")!!.blob)
        assertFalse("only held text is released", store.release("n1"))
        assertFalse(store.release("none"))
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

    @Test fun `a failed removal of the original is finished by the same instance, with no second copy`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "orig.note") throw java.io.IOException("could not remove orig.note") }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        PendingNotesStore.beforeRemoveForTesting = null
        // No restart: the next operation of this instance runs recovery again and finishes the copy.
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertNull(entry("copy1").origin)
    }

    @Test fun `an original whose conflict copy is unfinished is never sent, and recovery keeps trying`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        var failures = 2
        PendingNotesStore.beforeRemoveForTesting = {
            if (it.name == "orig.note" && failures-- > 0) throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", copy) }
        // The recovery before the next operation fails the same way: the original is still there, but a
        // push of it would conflict and make a second copy, so it is not sent.
        assertNull(store.beginSend("orig"))
        assertTrue(File(dir, "orig.note").exists())
        // Recovery runs again before the operation after that, and this time finishes the copy.
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertNull(entry("copy1").origin)
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

    // ---- what the push step asks of the store ----

    @Test fun `startSend says why nothing is sent`() {
        val refused = { reason: PendingNotesStore.Refusal -> PendingNotesStore.SendStart.Refused(reason) }
        assertEquals(refused(PendingNotesStore.Refusal.NOTHING), store.startSend("none"))
        store.saveLocal("held", "b1", "r1", blob("t"), isCreate = false)
        store.hold("held", HeldReason.READ_ONLY, now = 1)
        assertEquals(refused(PendingNotesStore.Refusal.NOTHING), store.startSend("held"))
        store.saveLocal("bad", "b1", "r1", blob("t"), isCreate = false)
        File(dir, "bad.note").writeBytes(byteArrayOf(0))
        assertEquals(refused(PendingNotesStore.Refusal.UNREADABLE), store.startSend("bad"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        val ready = store.startSend("n1") as PendingNotesStore.SendStart.Ready
        assertEquals(listOf("r1"), ready.entry.sent)
        assertEquals("beginSend is the same call without the reason", ready.entry, store.beginSend("n1"))
        // An original whose removal keeps failing, and the copy that still links to it.
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "orig.note") throw java.io.IOException("could not remove orig.note") }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        assertEquals(refused(PendingNotesStore.Refusal.UNFINISHED_ORIGINAL), store.startSend("orig"))
        assertEquals(refused(PendingNotesStore.Refusal.LINKED_COPY), store.startSend("copy1"))
    }

    @Test fun `a snapshot's headers carry what the push order and the backoff need`() {
        val v = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        store.recordFailure("n1", v, "TRANSIENT", now = 10)
        store.recordFailure("n1", v, "REJECTED", now = 20)
        store.saveLocal("n2", "b1", "r1", blob("two"), isCreate = false)
        val headers = store.snapshot { false }.headers
        assertEquals(PendingNotesStore.EntryHeader("n1", "b1", PendingEntry.State.UPSERT, v, failureCount = 2,
            lastFailureAt = 20, lastFailureCategory = "REJECTED"), headers.first())
        assertEquals(0, headers.last().failureCount)
        assertNull(headers.last().lastFailureAt)
        assertEquals("a header read alone agrees with the whole entry", PendingNotesStore.EntryHeader.of(entry("n1")), headers.first())
    }

    @Test fun `an original that a copy has not finished replacing is not held, since its text is the copy's now`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        assertEquals(PendingNotesStore.HoldOutcome.UNFINISHED_ORIGINAL, store.hold("orig", HeldReason.READ_ONLY, now = 5))
        assertEquals(PendingEntry.State.UPSERT, entry("orig").state)
        // The copy is held in its own right, and keeps its link while the original is there.
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("copy1", HeldReason.READ_ONLY, now = 5))
        assertEquals("orig", entry("copy1").origin?.noteUid)
        failing = false
        // Held as well, the original would have come back through Try again as a second upload of the same text.
        assertFalse(store.release("orig"))
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertEquals(PendingEntry.State.HELD, entry("copy1").state)
        assertNull(entry("copy1").origin)
    }

    @Test fun `dropDelete removes only the delete it was decided for`() {
        store.saveLocal("edit", "b1", "r1", blob("text"), isCreate = false)
        assertFalse("an edit is never dropped this way", store.dropDelete("edit", entry("edit").version))
        assertEquals(DeleteOutcome.Queued, store.markDeleted("n1", "b1", "d1", blob("deleted")))
        val version = entry("n1").version
        assertFalse("a stale version is refused", store.dropDelete("n1", version + 1))
        assertFalse(store.dropDelete("none", 1))
        assertTrue(store.dropDelete("n1", version))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(PendingEntry.State.UPSERT, entry("edit").state)
    }

    // ---- a conflict copy and its origin link ----

    private fun newNote(uid: String = "copy1", revision: String = "c1") =
        PendingEntry(uid, "b1", PendingEntry.State.UPSERT, 0, revision, true, blob = blob("mine as copy"))

    /** A note made from a conflict of "orig[n]", as the runner makes it: a pending create under its own uid. */
    private fun conflictCopy(s: PendingNotesStore = store, n: String = ""): PendingEntry {
        s.saveLocal("orig$n", "b1", "r1", blob("mine"), isCreate = false)
        assertTrue(s.replaceWithNewNote("orig$n", s.entry("orig$n").version, "srv", newNote("copy1$n")))
        return s.entry("copy1$n")
    }

    @Test fun `a conflict copy can be sent as soon as it is made`() {
        conflictCopy()
        // The copy is pushed in the run that makes it: with the original gone its link is cleared already.
        val snapshot = store.beginSend("copy1")!!
        assertNull(snapshot.origin)
        assertEquals(listOf("c1"), snapshot.sent)
    }

    @Test fun `a conflict copy is not sent while the original it replaced cannot be removed`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        // Recovery runs before every operation and fails the same way. The link in the copy's own file is
        // the only record that the original was replaced, so the copy must not land and be dropped with it.
        repeat(3) {
            assertNull(store.beginSend("copy1"))
            assertNull(store.beginSend("orig"))
        }
        assertEquals("orig", entry("copy1").origin?.noteUid)
        assertEquals("nothing was recorded as sent", emptyList<String>(), entry("copy1").sent)
        val next = restarted()
        assertNull("the next process finds the link and refuses too", next.beginSend("copy1"))
        failing = false
        // Once the removal works, the recovery before the next operation finishes the copy and it is sent.
        val snapshot = next.beginSend("copy1")!!
        assertNull(snapshot.origin)
        assertEquals(listOf("c1"), snapshot.sent)
        assertEquals(Read.Missing, next.read("orig"))
    }

    @Test fun `a conflict copy waits while its original cannot be read, and is sent once that file is discarded`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        // The original's file is damaged before the next process starts, so recovery cannot tell whether
        // it is the entry the copy replaced, and keeps the link.
        File(dir, "orig.note").writeBytes(byteArrayOf(0))
        val next = restarted()
        assertNull(next.beginSend("copy1"))
        assertNull(next.beginSend("orig"))
        assertEquals("orig", next.entry("copy1").origin?.noteUid)
        next.discard("orig")
        assertNull("the same instance clears the link, with no restart", next.beginSend("copy1")!!.origin)
    }

    // ---- the mark of a note made from a conflict ----

    @Test fun `a note made from a conflict is marked, and no other note is`() {
        assertTrue(conflictCopy().fromConflict)
        store.saveLocal("n1", "b1", "r1", blob("an ordinary edit"), isCreate = false)
        store.saveLocal("n2", "b1", "c1", blob("an ordinary new note"), isCreate = true)
        assertFalse(entry("n1").fromConflict)
        assertFalse(entry("n2").fromConflict)
        store.markDeleted("n3", "b1", "d1", blob("deleted"))
        assertFalse(entry("n3").fromConflict)
    }

    @Test fun `the mark stays through saves, a failure, a restart, a hold and a save into held text`() {
        var s = store
        conflictCopy(s)
        s.saveLocal("copy1", "b1", "c2", blob("typed more"), isCreate = true)
        assertTrue("a save before the note has landed", s.entry("copy1").fromConflict)
        val sent = s.beginSend("copy1")!!
        assertTrue(sent.fromConflict)
        assertTrue(s.recordFailure("copy1", sent.version, "TRANSIENT", now = 5))
        assertTrue("a failed upload", s.entry("copy1").fromConflict)
        s = restarted()
        assertTrue("a restart", s.entry("copy1").fromConflict)
        assertEquals(PendingNotesStore.HoldOutcome.HELD, s.hold("copy1", HeldReason.REPEATED_CONFLICT, now = 6, sentVersion = sent.version))
        assertTrue("a hold", s.entry("copy1").fromConflict)
        assertEquals(PendingEntry.Held(HeldReason.REPEATED_CONFLICT, 6), s.entry("copy1").held)
        assertTrue(s.saveLocal("copy1", "b1", "c3", blob("typed into held text"), isCreate = true) is SaveOutcome.SavedToHolding)
        assertTrue("a save into held text", s.entry("copy1").fromConflict)
        assertTrue("held text across a restart", restarted().entry("copy1").fromConflict)
    }

    @Test fun `a sent conflict copy that is deleted stays marked as a pending delete`() {
        conflictCopy()
        store.beginSend("copy1")
        assertEquals(DeleteOutcome.Queued, store.markDeleted("copy1", "b1", "d1", blob("deleted")))
        assertEquals(PendingEntry.State.DELETE, entry("copy1").state)
        assertTrue(entry("copy1").fromConflict)
        assertTrue(restarted().entry("copy1").fromConflict)
    }

    @Test fun `try again clears the mark, whatever the text was held for`() {
        for ((n, reason) in listOf("a" to HeldReason.REPEATED_CONFLICT, "b" to HeldReason.READ_ONLY, "c" to HeldReason.REJECTED)) {
            val copy = conflictCopy(n = n)
            assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold(copy.noteUid, reason, now = 5))
            assertTrue(store.release(copy.noteUid))
            assertFalse(reason.name, entry(copy.noteUid).fromConflict)
            assertEquals("the base is kept, so a real conflict goes through the table once more", "c1", entry(copy.noteUid).revision)
        }
        assertFalse(restarted().entry("copy1a").fromConflict)
    }

    @Test fun `a rebase clears the mark, since the note it is built on is on the server`() {
        conflictCopy()
        store.beginSend("copy1")
        store.saveLocal("copy1", "b1", "c2", blob("typed more"), isCreate = true)
        assertTrue(entry("copy1").fromConflict)
        assertTrue(store.rebase("copy1", entry("copy1").version, onto = "c1", revision = "c2b", blob = blob("typed more, on c1")))
        assertFalse(entry("copy1").fromConflict)
        assertFalse(restarted().entry("copy1").fromConflict)
    }

    @Test fun `a marked note saved during its upload loses the mark when the upload lands, and its version stays`() {
        conflictCopy()
        val snapshot = store.beginSend("copy1")!!
        val savedVersion = saved(store.saveLocal("copy1", "b1", "c2", blob("typed during the upload"), isCreate = true))
        val kept = (store.completeSend("copy1", snapshot.version, "c1", blob("landed")) as SendOutcome.NewerLocalChange).entry
        assertFalse(kept.fromConflict)
        assertEquals("the outcome is the entry as written", kept, entry("copy1"))
        assertEquals("the version did not move", savedVersion, kept.version)
        assertArrayEquals(blob("typed during the upload"), kept.blob)
        assertTrue("so the runner's rebase still applies", store.rebase("copy1", kept.version, onto = "c1", revision = "c2b", blob = blob("on c1")))
        assertFalse(restarted().entry("copy1").fromConflict)
    }

    @Test fun `a marked note deleted during its upload stays a delete and loses the mark when the upload lands`() {
        conflictCopy()
        val snapshot = store.beginSend("copy1")!!
        assertEquals(DeleteOutcome.Queued, store.markDeleted("copy1", "b1", "d1", blob("deleted")))
        val kept = (store.completeSend("copy1", snapshot.version, "c1", blob("landed")) as SendOutcome.NewerLocalChange).entry
        assertEquals(PendingEntry.State.DELETE, kept.state)
        assertFalse(kept.fromConflict)
        assertEquals(kept, entry("copy1"))
    }

    @Test fun `if clearing the mark cannot be written the upload still counts as landed, and the rebase clears it`() {
        conflictCopy()
        val snapshot = store.beginSend("copy1")!!
        store.saveLocal("copy1", "b1", "c2", blob("typed during the upload"), isCreate = true)
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw java.io.IOException("rename refused") }
        val kept = (store.completeSend("copy1", snapshot.version, "c1", blob("landed")) as SendOutcome.NewerLocalChange).entry
        PendingNotesStore.beforeRenameForTesting = null
        assertTrue("the mark stays for the moment", kept.fromConflict)
        assertEquals("the outcome is the entry as it is on disk", kept, entry("copy1"))
        assertTrue(store.scan().unreadable.isEmpty())
        assertFalse("the write that did not commit was dropped", File(dir, "copy1.note.new").exists())
        assertTrue(store.rebase("copy1", kept.version, onto = "c1", revision = "c2b", blob = blob("on c1")))
        assertFalse(entry("copy1").fromConflict)
    }

    @Test fun `an unmarked entry kept after its upload is not written again`() {
        store.saveLocal("n1", "b1", "r1", blob("v1"), isCreate = false)
        val snapshot = store.beginSend("n1")!!
        store.saveLocal("n1", "b1", "r2", blob("v2"), isCreate = false)
        var writes = 0
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") writes++ }
        val kept = (store.completeSend("n1", snapshot.version, "r1", blob("saved v1")) as SendOutcome.NewerLocalChange).entry
        assertEquals("the ordinary success path costs no extra write", 0, writes)
        assertEquals(kept, entry("n1"))
    }

    // ---- editors follow their text to a conflict copy ----

    @Test fun `an editor registered on the original points at the copy once the copy is made`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        val elsewhere = store.editorOpened("other")
        assertEquals("orig", editor.noteUid)
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        assertEquals("copy1", editor.noteUid)
        assertEquals("an editor on another note is left alone", "other", elsewhere.noteUid)
        // A save or delete that was built for the original writes nothing and names the copy.
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r2", blob("typed after the copy"), isCreate = false))
        assertEquals(DeleteOutcome.Moved("copy1"), store.markDeleted(editor, "orig", "b1", "d", blob("x")))
        assertEquals(Read.Missing, store.read("orig"))
        assertArrayEquals(blob("mine as copy"), entry("copy1").blob)
        // The editor applies its text to the copy's item and saves again: that save goes into the copy.
        assertTrue(store.saveLocal(editor, "copy1", "b1", "c2", blob("mine as copy, and typed after"), isCreate = true) is SaveOutcome.Saved)
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertArrayEquals(blob("mine as copy, and typed after"), entry("copy1").blob)
    }

    @Test fun `a copy that lands before the editor rebinds keeps its landed record for that editor`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        val snapshot = store.beginSend("copy1")!!
        assertEquals(SendOutcome.Done, store.completeSend("copy1", snapshot.version, "c1", blob("copy as landed")))
        assertEquals("c1", store.landed("copy1")?.revision)
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r2", blob("typed after the copy landed"), isCreate = false))
        assertEquals(DeleteOutcome.Moved("copy1"), store.markDeleted(editor, "orig", "b1", "d", blob("x")))
        assertEquals("no entry is written for the original, which would become a second copy", Read.Missing, store.read("orig"))
        // The editor's save, rebuilt on the copy as it landed: not a create, and the landed revision is ours.
        assertTrue(store.saveLocal(editor, "copy1", "b1", "c2", blob("copy as landed, and typed after"), isCreate = true) is SaveOutcome.Saved)
        val e = entry("copy1")
        assertFalse(e.isCreate)
        assertEquals(listOf("c1"), e.sent)
        assertFalse("a note that landed is an ordinary note again", e.fromConflict)
        store.editorClosed(editor)
        assertNull("closing the editor drops the landed record of the note it points at", store.landed("copy1"))
    }

    @Test fun `a delete from an editor that has not rebound deletes the copy, not the original`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        store.completeSend("copy1", store.beginSend("copy1")!!.version, "c1", blob("copy as landed"))
        assertEquals(DeleteOutcome.Moved("copy1"), store.markDeleted(editor, "orig", "b1", "d", blob("x")))
        assertEquals(DeleteOutcome.Queued, store.markDeleted(editor, "copy1", "b1", "d-copy", blob("copy deleted")))
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertEquals(PendingEntry.State.DELETE, entry("copy1").state)
        assertEquals("the delete starts from the copy as it landed", listOf("c1"), entry("copy1").sent)
    }

    @Test fun `an editor opened on the original after the copy was made is not redirected`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        // The original's server version stays in the list, and this editor is editing that.
        val later = store.editorOpened("orig")
        assertEquals("orig", later.noteUid)
        assertTrue(store.saveLocal(later, "orig", "b1", "r9", blob("an edit of the server's version"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(listOf("copy1", "orig"), store.scan().entries.map { it.noteUid })
    }

    @Test fun `the original's landed record goes when its text moves to a copy`() {
        val editor = store.editorOpened("orig")
        store.saveLocal(editor, "orig", "b1", "r1", blob("first"), isCreate = false)
        store.completeSend("orig", store.beginSend("orig")!!.version, "r1", blob("first as landed"))
        assertEquals("r1", store.landed("orig")?.revision)
        store.saveLocal(editor, "orig", "b1", "r2", blob("mine"), isCreate = false)
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        assertNull(store.landed("orig"))
        assertFalse(File(dir, "orig.landed").exists())
        // An editor opened on the original afterwards starts from the server's copy, not from the record
        // of an upload that is no longer the server's current revision.
        val later = store.editorOpened("orig")
        store.saveLocal(later, "orig", "b1", "r9", blob("an edit of the server's version"), isCreate = false)
        assertEquals(emptyList<String>(), entry("orig").sent)
    }

    @Test fun `editors are moved even when removing the original fails, and recovery finishes the rest`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "orig.note") throw java.io.IOException("could not remove orig.note") }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals("the copy's file is written, so it owns the text", "copy1", editor.noteUid)
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r2", blob("typed after"), isCreate = false))
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertNull(entry("copy1").origin)
    }

    @Test fun `a replacement that is refused moves no editor`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        assertFalse(store.replaceWithNewNote("orig", entry("orig").version + 5, "srv", newNote()))
        assertEquals("orig", editor.noteUid)
        assertTrue(store.saveLocal(editor, "orig", "b1", "r2", blob("still the original"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(listOf("orig"), store.scan().entries.map { it.noteUid })
    }

    @Test fun `an editor follows its text through a second copy`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        assertTrue(store.replaceWithNewNote("copy1", entry("copy1").version, "srv-2", newNote("copy2", "c2")))
        assertEquals("copy2", editor.noteUid)
        assertEquals(SaveOutcome.Moved("copy2"), store.saveLocal(editor, "copy1", "b1", "c1b", blob("late"), isCreate = true))
        assertEquals(listOf("copy2"), store.scan().entries.map { it.noteUid })
    }

    @Test fun `an editor that never meets a conflict keeps its note and saves as before`() {
        val editor = store.editorOpened("n1")
        assertTrue(store.saveLocal(editor, "n1", "b1", "r1", blob("t"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals("n1", editor.noteUid)
        assertTrue(store.saveLocal(editor, "n1", "b1", "r2", blob("t2"), isCreate = false) is SaveOutcome.Saved)
        assertEquals("the save starts from the landed record, as a save by uid does", listOf("r1"), entry("n1").sent)
        assertEquals(DeleteOutcome.Queued, store.markDeleted(editor, "n1", "b1", "d", blob("x")))
        assertEquals("n1", editor.noteUid)
    }

    @Test fun `a closed editor still saves, and an editor of another store is refused`() {
        val editor = store.editorOpened("n1")
        store.editorClosed(editor)
        assertTrue("typed text is not lost to a save that arrives after the close",
            store.saveLocal(editor, "n1", "b1", "r1", blob("late"), isCreate = false) is SaveOutcome.Saved)
        val other = open(tmp.newFolder("other"))
        assertThrows(IllegalArgumentException::class.java) { other.saveLocal(editor, "n1", "b1", "r1", blob("x"), isCreate = false) }
        assertThrows(IllegalArgumentException::class.java) { other.markDeleted(editor, "n1", "b1", "d", blob("x")) }
        assertThrows(IllegalArgumentException::class.java) { other.editorClosed(editor) }
        assertEquals(Read.Missing, other.read("n1"))
    }

    @Test fun `a save that arrives after its editor closed is still kept away from a replaced original`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        val editor = store.editorOpened("orig")
        store.editorClosed(editor)
        assertTrue(store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()))
        assertEquals("copy1", editor.noteUid)
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r2", blob("the last flush"), isCreate = false))
        assertEquals(DeleteOutcome.Moved("copy1"), store.markDeleted(editor, "orig", "b1", "d", blob("x")))
        assertEquals(Read.Missing, store.read("orig"))
        // A closed editor keeps no landed record alive: the copy lands and nothing is kept for it.
        assertEquals(SendOutcome.Done, store.completeSend("copy1", store.beginSend("copy1")!!.version, "c1", blob("copy as landed")))
        assertNull(store.landed("copy1"))
    }

    @Test fun `editors follow a copy that recovery had to commit`() {
        val editor = store.editorOpened("orig")
        store.saveLocal(editor, "orig", "b1", "r1", blob("first"), isCreate = false)
        store.completeSend("orig", store.beginSend("orig")!!.version, "r1", blob("first as landed"))
        store.saveLocal(editor, "orig", "b1", "r2", blob("mine"), isCreate = false)
        // The copy's file is written in full, and the call ends before its rename with something that is
        // not an I/O failure, so the same process, with its editors, goes on.
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw IllegalStateException("not an I/O failure") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeRenameForTesting = null
        assertTrue(File(dir, "copy1.note.new").exists())
        assertEquals("the copy is not committed, so nothing has moved", "orig", editor.noteUid)
        // The recovery before the next operation commits the copy and finishes the replacement, editors included.
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r3", blob("typed after"), isCreate = false))
        assertEquals("copy1", editor.noteUid)
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertNull(entry("copy1").origin)
        assertNull("the original's landed record went with its entry", store.landed("orig"))
        assertFalse(File(dir, "orig.landed").exists())
    }

    @Test fun `a copy whose first write fails is not left behind to be committed later as a second copy`() {
        var refuse = true
        val d = tmp.newFolder("refused-copy")
        val s = refusingRenames(d, "copy1.note") { refuse }
        val editor = s.editorOpened("orig")
        s.saveLocal(editor, "orig", "b1", "r1", blob("mine"), isCreate = false)
        assertThrows(java.io.IOException::class.java) { s.replaceWithNewNote("orig", s.entry("orig").version, "srv", newNote()) }
        assertFalse("the complete but uncommitted copy was removed", File(d, "copy1.note.new").exists())
        refuse = false
        // The original still owns the text: the editor stays on it and saves into it.
        assertEquals("orig", editor.noteUid)
        assertTrue(s.saveLocal(editor, "orig", "b1", "r2", blob("mine, and more"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(listOf("orig"), s.scan().entries.map { it.noteUid })
        // The next run resolves the conflict again, and that makes the only copy.
        assertTrue(s.replaceWithNewNote("orig", s.entry("orig").version, "srv", newNote("copy2", "c2")))
        assertEquals(listOf("copy2"), s.scan().entries.map { it.noteUid })
        assertEquals("copy2", editor.noteUid)
    }

    @Test fun `a save through a handle decides and writes against one recovery, not two`() {
        var refusals = 0
        val d = tmp.newFolder("one-recovery")
        val s = refusingRenames(d, "copy1.note") { refusals-- > 0 }
        val editor = s.editorOpened("orig")
        s.saveLocal(editor, "orig", "b1", "r1", blob("mine"), isCreate = false)
        // The copy is left written but not committed, in a process that goes on.
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "copy1.note") throw IllegalStateException("not an I/O failure") }
        assertThrows(IllegalStateException::class.java) { s.replaceWithNewNote("orig", s.entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeRenameForTesting = null
        // The recovery at the start of this save cannot commit the copy; a recovery right after it could.
        // The save was decided for the original, so it is written to the original: no second recovery runs
        // inside the call to remove the original and move the editor under it.
        refusals = 1
        assertTrue(s.saveLocal(editor, "orig", "b1", "r2", blob("typed on the original"), isCreate = false) is SaveOutcome.Saved)
        assertEquals("orig", editor.noteUid)
        assertArrayEquals(blob("typed on the original"), s.entry("orig").blob)
        // The original changed after the copy was taken, so both are kept and the editor stays where it is.
        assertEquals(listOf("copy1", "orig"), s.scan().entries.map { it.noteUid })
        assertNull(s.entry("copy1").origin)
        assertEquals("orig", editor.noteUid)
    }

    // ---- removing a conflict copy that still carries its origin link ----

    @Test fun `deleting a conflict copy while its original cannot be removed fails and keeps the link`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        // With the copy and its link gone, the original would be an ordinary pending edit again, and its
        // next 409 would bring back as a second copy the text the user just deleted.
        assertThrows(java.io.IOException::class.java) { store.markDeleted("copy1", "b1", "d", blob("x")) }
        assertEquals("orig", entry("copy1").origin?.noteUid)
        assertNull(store.beginSend("orig"))
        assertNull(store.beginSend("copy1"))
        failing = false
        assertEquals(DeleteOutcome.Removed, store.markDeleted("copy1", "b1", "d", blob("x")))
        assertTrue("both are gone, so nothing is left to send or to copy again", store.scan().entries.isEmpty())
    }

    @Test fun `discarding a held conflict copy takes the original it replaced with it, or fails`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        var failing = true
        PendingNotesStore.beforeRemoveForTesting = {
            if (failing && it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("copy1", HeldReason.READ_ONLY, now = 5))
        assertThrows(java.io.IOException::class.java) { store.discard("copy1") }
        assertEquals(PendingEntry.State.HELD, entry("copy1").state)
        assertEquals("orig", entry("copy1").origin?.noteUid)
        failing = false
        store.discard("copy1")
        assertTrue(store.scan().entries.isEmpty())
    }

    @Test fun `a conflict copy whose original cannot be read is not removed until that file is discarded`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        File(dir, "orig.note").writeBytes(byteArrayOf(0))
        val next = restarted()
        // The damaged file may be the entry the copy replaced. It cannot be removed unread, and it must
        // not be left behind without the link.
        assertThrows(java.io.IOException::class.java) { next.markDeleted("copy1", "b1", "d", blob("x")) }
        assertThrows(java.io.IOException::class.java) { next.discard("copy1") }
        assertEquals("orig", next.entry("copy1").origin?.noteUid)
        next.discard("orig")
        assertEquals(DeleteOutcome.Removed, next.markDeleted("copy1", "b1", "d", blob("x")))
        val scan = next.scan()
        assertTrue(scan.entries.isEmpty())
        assertTrue(scan.unreadable.isEmpty())
    }

    @Test fun `an original that could not be read for a moment is not sent, and its copy is released once it reads again`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        val file = File(dir, "orig.note")
        val good = file.readBytes()
        file.writeBytes(byteArrayOf(0))
        val next = restarted()
        // The first recovery of the new process cannot read the original, and nothing in it fails.
        assertEquals(listOf("orig.note"), next.scan().unreadable.map { it.file })
        // The read error was passing. The original reads again, but a copy still links to it.
        file.writeBytes(good)
        assertNull("it would get the same 409 and be copied a second time", next.beginSend("orig"))
        // That refused send had recovery look again: the original is the entry the copy replaced, so it
        // is removed, the link is cleared, and the copy is sent.
        val snapshot = next.beginSend("copy1")!!
        assertNull(snapshot.origin)
        assertEquals(Read.Missing, next.read("orig"))
    }

    /** A copy still linked to an original that the first recovery of a new process could not read, and that reads again. */
    private fun linkedCopyWhoseOriginalReadsAgain(): PendingNotesStore {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        val file = File(dir, "orig.note")
        val good = file.readBytes()
        file.writeBytes(byteArrayOf(0))
        val next = restarted()
        assertEquals(listOf("orig.note"), next.scan().unreadable.map { it.file })
        file.writeBytes(good)
        return next
    }

    @Test fun `a send refused for the origin link has recovery look again, so the copy goes with the next try`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        assertNull("recovery has not looked since the original read badly", next.beginSend("copy1"))
        assertNull(next.beginSend("copy1")!!.origin)
        assertEquals(Read.Missing, next.read("orig"))
    }

    @Test fun `deleting a linked copy removes the original it replaced, which is then an ordinary note again`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        // No recovery runs before this delete, so the delete itself removes the original.
        assertEquals(DeleteOutcome.Removed, next.markDeleted("copy1", "b1", "d", blob("x")))
        assertEquals(Read.Missing, next.read("orig"))
        assertTrue(next.scan().entries.isEmpty())
        // A later edit of the server's version of that note is not held back.
        next.saveLocal("orig", "b1", "r9", blob("a new edit"), isCreate = false)
        assertEquals(listOf("r9"), next.beginSend("orig")!!.sent)
    }

    @Test fun `deleting a linked copy leaves an original that was saved again since`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        next.saveLocal("orig", "b1", "r2", blob("typed later"), isCreate = false)
        assertEquals(DeleteOutcome.Removed, next.markDeleted("copy1", "b1", "d", blob("x")))
        assertArrayEquals("it is no longer the entry the copy replaced", blob("typed later"), next.entry("orig").blob)
        assertEquals(listOf("orig"), next.scan().entries.map { it.noteUid })
    }

    @Test fun `discarding a linked copy removes the original it replaced`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        assertEquals(PendingNotesStore.HoldOutcome.HELD, next.hold("copy1", HeldReason.READ_ONLY, now = 5))
        next.discard("copy1")
        assertTrue(next.scan().entries.isEmpty())
        assertEquals(Read.Missing, next.read("orig"))
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

    /** A store whose rename of "<target>" fails while [refuse] says so, as rename(2) can (EBUSY, EIO). */
    private fun refusingRenames(d: File, target: String, refuse: () -> Boolean) = PendingNotesStore.open(d, rename = { from, to ->
        if (refuse() && to.name == target) throw java.io.IOException("rename refused") else atomicMove(from, to)
    })

    @Test fun `a refused rename never loses the committed entry and is sorted out by the same instance`() {
        var refuse = false
        val d = tmp.newFolder("refusing")
        val s = refusingRenames(d, "n1.note") { refuse }
        s.saveLocal("n1", "b1", "r1", blob("old"), isCreate = false)
        refuse = true
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n1", "b1", "r2", blob("new"), isCreate = false) }
        refuse = false
        // The committed file was never deleted, so the old text is still there under its own name.
        assertEquals("r1", s.entry("n1").revision)
        assertFalse("the uncommitted write was dropped", File(d, "n1.note.new").exists())
        s.saveLocal("n1", "b1", "r3", blob("newer"), isCreate = false)
        assertEquals("a later save still works", "r3", s.entry("n1").revision)
    }

    @Test fun `a write that recovery could not finish is never written over, and is finished later`() {
        var refuse = true
        val d = tmp.newFolder("stranded")
        // The first write of n1 stopped before its rename: this file is the only copy of the text.
        val only = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("the only copy"))
        File(d, "n1.note.new").writeBytes(PendingCodec.encodeEntry(only))
        val s = refusingRenames(d, "n1.note") { refuse }
        assertEquals(SaveOutcome.Blocked, s.saveLocal("n1", "b1", "r5", blob("typed over it"), isCreate = false))
        assertEquals(DeleteOutcome.Blocked, s.markDeleted("n1", "b1", "d", blob("x")))
        assertEquals(Read.Unreadable("n1.note.new", "an interrupted write is not recovered yet"), s.read("n1"))
        assertArrayEquals(PendingCodec.encodeEntry(only), File(d, "n1.note.new").readBytes())
        refuse = false
        assertEquals("the recovery before the next operation commits it", only, s.entry("n1"))
    }

    @Test fun `a save larger than the store keeps is refused before anything is written`() {
        val huge = ByteArray(PendingCodec.MAX_BLOB + 1)
        assertEquals(SaveOutcome.TooLarge, store.saveLocal("n1", "b1", "r1", huge, isCreate = true))
        assertEquals(Read.Missing, store.read("n1"))
        assertEquals(0L, store.observe("n1").sequence)
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

    @Test fun `a snapshot reads entries it does not keep by header alone`() {
        store.saveLocal("n1", "b1", "r1", blob("kept"), isCreate = false)
        val v2 = saved(store.saveLocal("n2", "b2", "r1", blob("counted only"), isCreate = false))
        // Damage n2's blob but not its header: a header-only view still counts it, and a full read,
        // which checks the whole file, reports it.
        val file = File(dir, "n2.note")
        val bytes = file.readBytes()
        bytes[bytes.size - 6] = (bytes[bytes.size - 6].toInt() xor 0x40).toByte()
        file.writeBytes(bytes)
        val snapshot = store.snapshot { it.notebookUid == "b1" }
        assertEquals(PendingNotesStore.EntryHeader("n2", "b2", PendingEntry.State.UPSERT, v2), snapshot.headers.last())
        assertTrue(snapshot.unreadable.isEmpty())
        assertEquals(setOf("n1"), snapshot.entries.keys)
        assertEquals("n2.note", store.scan().unreadable.single().file)
        assertEquals("a kept entry is read whole, checked, and reported with the notebook its header names",
            listOf(Read.Unreadable("n2.note", "bad checksum", notebookUid = "b2")),
            store.snapshot { true }.unreadable.map { it.copy(reason = "bad checksum") })
    }

    @Test fun `a snapshot still reads format 1 entry files, whole`() {
        val v1Upsert = "53534e500100066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff0000000000000003010203f0a8313a"
        dir.mkdirs()
        File(dir, "note-1.note").writeBytes(ByteArray(v1Upsert.length / 2) { v1Upsert.substring(it * 2, it * 2 + 2).toInt(16).toByte() })
        val snapshot = store.snapshot { false }
        assertEquals(PendingNotesStore.EntryHeader("note-1", "book-1", PendingEntry.State.UPSERT, 3), snapshot.headers.single())
        assertTrue(snapshot.unreadable.isEmpty())
    }

    @Test fun `observing a note reads its entry and the sequence together, also when there is no entry`() {
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = false)
        assertEquals(PendingNotesStore.Observed(Read.Present(entry("n1")), 2), store.observe("n1"))
        assertEquals(PendingNotesStore.Observed(Read.Missing, 2), store.observe("n9"))
        // A drop leaves the sequence where it was, so a load after a push is never taken for an older one.
        store.discard("n1")
        assertEquals(2L, store.observe("n1").sequence)
        assertEquals(0L, open(tmp.newFolder("empty")).observe("n1").sequence)
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
            assertThrows(uid, IllegalArgumentException::class.java) { store.editorOpened(uid) }
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
