package io.silentsuite.sync.notes.edit

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
        PendingNotesStore.listFilesForTesting = null
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

    @Test fun `a lost counter is rebuilt above an entry whose blob is damaged behind a header that reads`() {
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        val high = saved(store.saveLocal("n2", "b1", "r1", blob("two"), isCreate = false))
        // The header still reads on its own; the whole file does not.
        val file = File(dir, "n2.note")
        val bytes = file.readBytes()
        bytes[bytes.size - 6] = (bytes[bytes.size - 6].toInt() xor 0x40).toByte()
        file.writeBytes(bytes)
        assertTrue(File(dir, "sequence").delete())
        assertTrue("n2 still holds its version",
            saved(store.saveLocal("n3", "b1", "r1", blob("three"), isCreate = false)) > high)
    }

    @Test fun `with the counter lost, a write fails while an entry's version cannot be read, and nothing is written`() {
        // As after a downgrade: an entry a newer build wrote, at a version this build cannot read.
        val newer = withFormatVersion(PendingCodec.encodeEntry(
            PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 7, "r7", false, blob = blob("by a newer build"))), 3)
        dir.mkdirs()
        File(dir, "n1.note").writeBytes(newer)
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)
        }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertFalse("and no entry", File(dir, "n2.note").exists() || File(dir, "n2.note.new").exists())
        // Reading still works, and still reports the entry it cannot read.
        val snapshot = store.snapshot { false }
        assertTrue(snapshot.headers.isEmpty())
        assertEquals(listOf(Read.Unreadable("n1.note", "format version 3")), snapshot.unreadable)
        // Once that file is discarded, no version on disk is unknown, and the save goes through.
        store.discard("n1")
        assertTrue(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) is SaveOutcome.Saved)
    }

    @Test fun `with the counter lost, a write fails while a landed record cannot be read`() {
        // An open editor keeps the landed record of a push, with the version that was sent.
        val editor = store.editorOpened("n1")
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed")))
        val landed = File(dir, "n1.landed")
        landed.writeBytes(landed.readBytes().also { it[8] = (it[8].toInt() xor 0x40).toByte() })
        assertTrue(File(dir, "sequence").delete())
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)
        }
        assertFalse("no counter is written", File(dir, "sequence").exists())
        // The record goes with its editor, and then the save goes through.
        store.editorClosed(editor)
        assertTrue(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) is SaveOutcome.Saved)
    }

    @Test fun `a lost counter is rebuilt above a first write that recovery cannot commit yet`() {
        var refuse = true
        val d = tmp.newFolder("stranded-version")
        val stranded = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 9, "r9", false, blob = blob("the only copy"))
        File(d, "n1.note.new").writeBytes(PendingCodec.encodeEntry(stranded))
        val s = refusingRenames(d, "n1.note") { refuse }
        assertTrue("above the version recovery will commit n1 with",
            saved(s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > 9)
        assertArrayEquals(PendingCodec.encodeEntry(stranded), File(d, "n1.note.new").readBytes())
        refuse = false
        assertEquals(stranded, s.entry("n1"))
    }

    @Test fun `a lost counter is rebuilt above a landed record that recovery cannot commit yet`() {
        val d = tmp.newFolder("stranded-landed")
        val landed = PendingCodec.encodeLanded(LandedRecord("n5", "r12", 12, blob("landed")))
        File(d, "n5.landed.new").writeBytes(landed)
        // Committed, the record would go at once, since no editor is open on n5. Refused, it stays.
        val s = refusingRenames(d, "n5.landed") { true }
        assertTrue("above the version the record holds",
            saved(s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > 12)
        assertArrayEquals(landed, File(d, "n5.landed.new").readBytes())
    }

    @Test fun `a counter in a layout this build cannot read stops every new version, while reads and sends go on`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("two"), isCreate = false))
        store.hold("n2", HeldReason.READ_ONLY, now = 1)
        // As after a downgrade: a newer build wrote the counter, and may have handed out versions above
        // every file this build can read. Rebuilt from those files, it could restart below them.
        val counter = withFormatVersion(PendingCodec.encodeSequence(41), 2)
        File(dir, "sequence").writeBytes(counter)
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n3", "b1", "r1", blob("new"), isCreate = true)
        }
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n1", "b1", "r2", blob("edit"), isCreate = false)
        }
        assertThrows(java.io.IOException::class.java) { store.rebase("n1", v1, "r1", "r3", blob("rebased")) }
        assertThrows(java.io.IOException::class.java) { store.replaceWithNewNote("n1", v1, "srv", newNote()) }
        assertThrows(java.io.IOException::class.java) { store.release("n2") }
        assertArrayEquals("left as that build wrote it", counter, File(dir, "sequence").readBytes())
        assertEquals(Read.Missing, store.read("n3"))
        assertEquals(Read.Missing, store.read("copy1"))
        assertEquals("r1", entry("n1").revision)
        assertEquals(PendingEntry.State.HELD, entry("n2").state)
        // Reads take the highest version they can read, and a push needs no new version.
        assertEquals(v2, store.snapshot { false }.sequence)
        assertEquals(v2, store.observe("n1").sequence)
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals(Read.Missing, store.read("n1"))
        assertArrayEquals(counter, File(dir, "sequence").readBytes())
    }

    @Test fun `a counter that fails its checksum, with nothing else on disk, restarts at 1`() {
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = false)
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r2", blob("landed")))
        assertEquals("only the counter is left", listOf("sequence"), dir.list()!!.toList())
        val sequence = File(dir, "sequence")
        assertArrayEquals(PendingCodec.encodeSequence(2), sequence.readBytes())
        sequence.writeBytes(sequence.readBytes().also { it[6] = (it[6].toInt() xor 0x40).toByte() })
        // Damaged, not written in another layout: no version is left on disk to stay above.
        assertEquals(1L, saved(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)))
        assertArrayEquals("written anew", PendingCodec.encodeSequence(1), sequence.readBytes())
    }

    @Test fun `with the counter lost, a file of a kind this build does not know stops every new version`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        // As after a downgrade: a newer build may keep versions in a file or directory this build has no name for.
        File(dir, "n1.draft").writeBytes(blob("a newer build's"))
        assertTrue(File(dir, "versions").mkdir())
        assertEquals("while the counter reads, nothing else is looked at",
            v1 + 1, saved(store.saveLocal("n1", "b1", "r2", blob("two"), isCreate = false)))
        assertTrue(File(dir, "sequence").delete())
        assertThrows(java.io.IOException::class.java) { store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertEquals(Read.Missing, store.read("n2"))
        assertEquals("reads pass over them", v1 + 1, store.snapshot { false }.sequence)
        assertTrue(File(dir, "n1.draft").delete())
        assertThrows(java.io.IOException::class.java) { store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertTrue(File(dir, "versions").delete())
        assertEquals("then above every version on disk",
            v1 + 2, saved(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)))
    }

    @Test fun `a leftover new file of a kind this build does not know is left as it is, and stops new versions`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        store.putNotebook("b9", blob("key b9"))
        // As after a downgrade: one fails this build's check, one sits beside a committed file of its name, and one is
        // intact with nothing of its name.
        val cut = PendingCodec.encodeSequence(7).copyOf(5)
        val beside = PendingCodec.encodeSequence(9)
        val whole = PendingCodec.encodeSequence(11)
        File(dir, "x.draft.new").writeBytes(cut)
        File(dir, "y.draft").writeBytes(blob("a newer build's"))
        File(dir, "y.draft.new").writeBytes(beside)
        File(dir, "z.draft.new").writeBytes(whole)
        // A known kind beside them: an intact landed record with no editor open is committed and then dropped.
        File(dir, "n5.landed.new").writeBytes(PendingCodec.encodeLanded(LandedRecord("n5", "r5", v1, blob("landed"))))
        val s = restarted()
        val scan = s.scan()
        assertEquals(listOf("n1"), scan.entries.map { it.noteUid })
        assertTrue("nothing is reported", scan.unreadable.isEmpty())
        assertArrayEquals("not deleted", cut, File(dir, "x.draft.new").readBytes())
        assertArrayEquals("not deleted beside its committed file", beside, File(dir, "y.draft.new").readBytes())
        assertArrayEquals("not committed", whole, File(dir, "z.draft.new").readBytes())
        assertFalse(File(dir, "z.draft").exists())
        assertFalse("a known kind is finished as before",
            File(dir, "n5.landed.new").exists() || File(dir, "n5.landed").exists())
        assertEquals("the recovery finished, so the prune runs", listOf("b9"), s.pruneNotebooks())
        // With the counter lost, each of them is a file of a kind this build does not know, alone as well.
        assertTrue(File(dir, "sequence").delete())
        assertTrue(File(dir, "y.draft").delete())
        val save = { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertThrows(java.io.IOException::class.java) { save() }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertFalse("no entry is written", File(dir, "n2.note").exists() || File(dir, "n2.note.new").exists())
        assertEquals("reads still work", "r1", (s.read("n1") as Read.Present).entry.revision)
        assertEquals(v1, s.snapshot { false }.sequence)
        assertTrue(File(dir, "y.draft.new").delete() && File(dir, "z.draft.new").delete())
        assertThrows("the one that fails the check, alone", java.io.IOException::class.java) { save() }
        assertTrue(File(dir, "x.draft.new").delete())
        File(dir, "z.draft.new").writeBytes(whole)
        assertThrows("an intact one, alone", java.io.IOException::class.java) { save() }
        assertTrue(File(dir, "z.draft.new").delete())
        assertEquals("then above every version on disk", v1 + 1, saved(save()))
    }

    @Test fun `an uncommitted counter write in a layout this build cannot read stops new versions`() {
        var refuse = true
        val d = tmp.newFolder("stranded-counter")
        // A newer build wrote its counter in full, and the rename never happened.
        val counter = withFormatVersion(PendingCodec.encodeSequence(41), 2)
        File(d, "sequence.new").writeBytes(counter)
        val s = refusingRenames(d, "sequence") { refuse }
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n1", "b1", "r1", blob("u"), isCreate = true) }
        assertArrayEquals("not written over", counter, File(d, "sequence.new").readBytes())
        assertEquals(Read.Missing, s.read("n1"))
        refuse = false
        // Committed by the next recovery, it is a counter this build cannot read, and still stops them.
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n1", "b1", "r1", blob("u"), isCreate = true) }
        assertArrayEquals(counter, File(d, "sequence").readBytes())
        assertFalse(File(d, "sequence.new").exists())
    }

    // ---- editor saves ----

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

    // ---- landed evidence ----

    @Test fun `a save after our own create landed is not a create and knows the landed revision is ours`() {
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "c1", blob("first"), isCreate = true)
        store.completeSend("n1", store.beginSend("n1")!!.version, "c1", blob("landed"))
        store.saveLocal("n1", "b1", "c2", blob("second"), isCreate = true)
        val e = entry("n1")
        assertFalse(e.isCreate)
        assertEquals(listOf("c1"), e.sent)
    }

    @Test fun `a save after a landed save still recognizes the landed revision after the editor clears it`() {
        store.editorOpened("n1")
        store.saveLocal("n1", "b1", "r1", blob("edit"), isCreate = false)
        store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed"))
        store.saveLocal("n1", "b1", "r2", blob("edited again"), isCreate = false)
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
        // The next process finishes the copy, then the user merges by hand and edits another note.
        val after = restarted()
        after.saveLocal("orig", "b1", "r2", blob("merged by hand"), isCreate = false)
        after.saveLocal("other", "b1", "r1", blob("another note"), isCreate = false)
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
        // Held as well, the original could be released: Try again gives it a new version, the copy's
        // link stops matching, and the same text is sent a second time. Not held, there is nothing to release.
        val version = entry("orig").version
        assertFalse(store.release("orig"))
        assertEquals(version, entry("orig").version)
        assertEquals("orig", entry("copy1").origin?.noteUid)
        failing = false
        assertEquals(listOf("copy1"), store.scan().entries.map { it.noteUid })
        assertEquals(PendingEntry.State.HELD, entry("copy1").state)
        assertNull(entry("copy1").origin)
    }

    @Test fun `a hold refused for an original that could not be read has recovery look at it again`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        val file = File(dir, "orig.note")
        file.writeBytes(byteArrayOf(0))
        val next = restarted()
        assertEquals(listOf("orig.note"), next.scan().unreadable.map { it.file })
        assertEquals(PendingNotesStore.HoldOutcome.UNFINISHED_ORIGINAL, next.hold("orig", HeldReason.READ_ONLY, now = 5))
        // The damaged file goes away behind the store's back. Nothing failed, so only the refused hold
        // makes the next call look again, find the original gone, and clear the copy's link.
        assertTrue(file.delete())
        assertNull(next.entry("copy1").origin)
    }

    @Test fun `a recovery that ends with an error other than an I O failure is not taken for done`() {
        val d = tmp.newFolder("interrupted-recovery")
        val only = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("the only copy"))
        File(d, "n1.note.new").writeBytes(PendingCodec.encodeEntry(only))
        var first = true
        val s = PendingNotesStore.open(d, rename = { from, to ->
            if (first) {
                first = false
                throw IllegalStateException("not an I/O failure")
            }
            atomicMove(from, to)
        })
        // The first call's recovery stops while committing the stranded write, and the call fails with it.
        assertThrows(IllegalStateException::class.java) { s.read("n1") }
        // The next call recovers again and commits it. Taken for done, the note would read as not recovered.
        assertEquals(only, s.entry("n1"))
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
        // A save that was built for the original writes nothing and names the copy.
        assertEquals(SaveOutcome.Moved("copy1"), store.saveLocal(editor, "orig", "b1", "r2", blob("typed after the copy"), isCreate = false))
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
        assertEquals("n1", editor.noteUid)
    }

    @Test fun `a closed editor still saves, and an editor of another store is refused`() {
        val editor = store.editorOpened("n1")
        store.editorClosed(editor)
        assertTrue("typed text is not lost to a save that arrives after the close",
            store.saveLocal(editor, "n1", "b1", "r1", blob("late"), isCreate = false) is SaveOutcome.Saved)
        val other = open(tmp.newFolder("other"))
        assertThrows(IllegalArgumentException::class.java) { other.saveLocal(editor, "n1", "b1", "r1", blob("x"), isCreate = false) }
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
        assertThrows(java.io.IOException::class.java) { next.discard("copy1") }
        assertEquals("orig", next.entry("copy1").origin?.noteUid)
        next.discard("orig")
        next.discard("copy1")
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

    @Test fun `discarding a linked copy leaves an original that was saved again since`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        next.saveLocal("orig", "b1", "r2", blob("typed later"), isCreate = false)
        assertEquals(PendingNotesStore.HoldOutcome.HELD, next.hold("copy1", HeldReason.READ_ONLY, now = 5))
        next.discard("copy1")
        assertArrayEquals("it is no longer the entry the copy replaced", blob("typed later"), next.entry("orig").blob)
        assertEquals(listOf("orig"), next.scan().entries.map { it.noteUid })
    }

    @Test fun `discarding a linked copy removes the original it replaced`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        assertEquals(PendingNotesStore.HoldOutcome.HELD, next.hold("copy1", HeldReason.READ_ONLY, now = 5))
        next.discard("copy1")
        assertTrue(next.scan().entries.isEmpty())
        assertEquals(Read.Missing, next.read("orig"))
        // A later edit of the server's version of that note is not held back.
        next.saveLocal("orig", "b1", "r9", blob("a new edit"), isCreate = false)
        assertEquals(listOf("r9"), next.beginSend("orig")!!.sent)
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

    // Linux errno values, as fsync(2) answers them.
    private val eio = 5
    private val einval = 22

    @Test fun `an unexpected directory sync failure is thrown, never reported as saved or removed`() {
        var errno = 0
        val s = PendingNotesStore.open(dir, PendingNotesStore.directorySync({ errno }) { it == einval }, atomicMove)
        s.saveLocal("n1", "b1", "r1", blob("first"), isCreate = false)
        errno = eio
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n1", "b1", "r2", blob("second"), isCreate = false) }
        assertThrows(java.io.IOException::class.java) { s.discard("n1") }
    }

    @Test fun `a filesystem that cannot sync a directory at all still saves`() {
        val s = PendingNotesStore.open(dir, PendingNotesStore.directorySync({ einval }) { it == einval }, atomicMove)
        assertTrue(s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false) is SaveOutcome.Saved)
    }

    @Test fun `a new store directory is synced into each parent before the first file is committed in it`() {
        val base = tmp.newFolder("base").canonicalFile
        fun name(f: File) = f.canonicalFile.relativeTo(base).invariantSeparatorsPath.ifEmpty { "." }
        val events = mutableListOf<String>()
        val s = PendingNotesStore.open(File(base, "a/b/store"), syncDirectory = { events += "sync ${name(it)}" },
            rename = { from, to -> events += "rename ${name(to)}"; atomicMove(from, to) })
        s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        assertEquals(listOf("sync .", "sync a", "sync a/b", "rename a/b/store/sequence", "sync a/b/store"), events.take(5))
    }

    @Test fun `a failed sync of a new directory is tried again by the next write`() {
        val base = tmp.newFolder("base").canonicalFile
        var fail = true
        val synced = mutableListOf<File>()
        val s = PendingNotesStore.open(File(base, "a/store"), syncDirectory = {
            if (fail && it.canonicalFile == base) throw java.io.IOException("sync failed")
            synced += it.canonicalFile
        }, rename = atomicMove)
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false) }
        fail = false
        assertTrue(s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false) is SaveOutcome.Saved)
        assertEquals(listOf(base, File(base, "a")), synced.take(2))
    }

    @Test fun `recovery commits an interrupted first write the way a write commits it`() {
        PendingNotesStore.beforeRenameForTesting = { if (it.name == "n1.note") throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.saveLocal("n1", "b1", "r1", blob("first write"), isCreate = false) }
        PendingNotesStore.beforeRenameForTesting = null
        assertFalse(File(dir, "n1.note").exists())
        PendingNotesStore.resetForTesting()
        val events = mutableListOf<String>()
        val after = PendingNotesStore.open(dir, syncDirectory = { events += "sync ${it.name}" },
            rename = { from, to -> events += "rename ${to.name}"; atomicMove(from, to) })
        assertEquals("r1", after.entry("n1").revision)
        assertEquals(listOf("rename n1.note", "sync store"), events)
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
        assertEquals(10L, file.length())
    }

    @Test fun `an entry held for a reason this build does not know is reported, never overwritten and never deleted`() {
        val held = PendingEntry("n1", "b1", PendingEntry.State.HELD, 4, "r4", false,
            held = PendingEntry.Held(HeldReason.READ_ONLY, 5), blob = blob("held by a newer build"))
        val bytes = withUnknownHeldReason(PendingCodec.encodeEntry(held))
        dir.mkdirs()
        val file = File(dir, "n1.note").also { it.writeBytes(bytes) }
        val reported = listOf(Read.Unreadable("n1.note", "held reason READ_ONLZ"))
        assertEquals(reported, store.scan().unreadable)
        val snapshot = store.snapshot { false }
        assertTrue(snapshot.headers.isEmpty())
        assertEquals("the header read refuses it as well, so its notebook is not known", reported, snapshot.unreadable)
        assertEquals(SaveOutcome.Blocked, store.saveLocal("n1", "b1", "r5", blob("typed over it"), isCreate = false))
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.UNREADABLE), store.startSend("n1"))
        assertFalse(store.release("n1"))
        assertEquals(PendingNotesStore.HoldOutcome.NOT_APPLIED, store.hold("n1", HeldReason.READ_ONLY, now = 6))
        restarted().scan()
        assertArrayEquals("byte for byte as the newer build wrote it", bytes, file.readBytes())
    }

    @Test fun `an entry in the delete state of the prototype branch is reported, never overwritten, never sent and never removed`() {
        // The bytes of v2Deleted in PendingCodecTest: state code 2, which only that branch's tests wrote.
        val hex = "53534e50020000004d00066e6f74652d320006626f6f6b2d3102000000000000000900057265762d64000000000200057265762d6100057265762d62000000020000019980a6340000095452414e5349454e54000000255055b0000000010996f19b9c"
        val bytes = ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        dir.mkdirs()
        val file = File(dir, "note-2.note").also { it.writeBytes(bytes) }
        val reported = listOf(Read.Unreadable("note-2.note", "state 2"))
        assertEquals(reported, store.scan().unreadable)
        val snapshot = store.snapshot { false }
        assertTrue(snapshot.headers.isEmpty())
        assertEquals("the header read refuses it as well, so its notebook is not known", reported, snapshot.unreadable)
        assertEquals(SaveOutcome.Blocked, store.saveLocal("note-2", "book-1", "rev-e", blob("typed over it"), isCreate = false))
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.UNREADABLE), store.startSend("note-2"))
        assertFalse(store.release("note-2"))
        assertEquals(PendingNotesStore.HoldOutcome.NOT_APPLIED, store.hold("note-2", HeldReason.READ_ONLY, now = 6))
        restarted().scan()
        assertArrayEquals("byte for byte as it was written", bytes, file.readBytes())
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

    @Test fun `a first write that fails its checksum is dropped at full length too`() {
        val complete = PendingEntry("n3", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("synced before the crash"))
        dir.mkdirs()
        File(dir, "n3.note.new").writeBytes(PendingCodec.encodeEntry(complete).also { it[12] = (it[12].toInt() xor 0x40).toByte() })
        val scan = store.scan()
        assertTrue(scan.entries.isEmpty())
        assertTrue(scan.unreadable.isEmpty())
        assertFalse(File(dir, "n3.note.new").exists())
        assertFalse(File(dir, "n3.note").exists())
    }

    @Test fun `an intact first write in a layout this build cannot read is committed under its own name, kept and reported`() {
        // As after a downgrade: a newer build wrote these in full, and its rename never happened.
        val newerFormat = withFormatVersion(PendingCodec.encodeEntry(
            PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("written by a newer build"))), 3)
        val newerReason = withUnknownHeldReason(PendingCodec.encodeEntry(PendingEntry("n2", "b1", PendingEntry.State.HELD, 5, "r5", false,
            held = PendingEntry.Held(HeldReason.READ_ONLY, 6), blob = blob("held by a newer build"))))
        dir.mkdirs()
        File(dir, "n1.note.new").writeBytes(newerFormat)
        File(dir, "n2.note.new").writeBytes(newerReason)
        val reported = listOf(Read.Unreadable("n1.note", "format version 3"), Read.Unreadable("n2.note", "held reason READ_ONLZ"))
        val scan = store.scan()
        assertTrue(scan.entries.isEmpty())
        assertEquals("each once, under its own name", reported, scan.unreadable)
        assertFalse(File(dir, "n1.note.new").exists())
        assertFalse(File(dir, "n2.note.new").exists())
        assertEquals(SaveOutcome.Blocked, store.saveLocal("n1", "b1", "r5", blob("typed over it"), isCreate = false))
        // Committed, so the store does not come back to it: nothing is left for recovery to do, and a
        // new process finds an ordinary committed file it cannot read.
        assertEquals(reported, store.snapshot { false }.unreadable)
        assertEquals(reported, restarted().scan().unreadable)
        assertArrayEquals("byte for byte as the newer build wrote it", newerFormat, File(dir, "n1.note").readBytes())
        assertArrayEquals(newerReason, File(dir, "n2.note").readBytes())
    }

    @Test fun `an intact first write this build cannot read is never dropped while its commit keeps failing`() {
        var refuse = true
        val d = tmp.newFolder("stranded-newer")
        val newer = withFormatVersion(PendingCodec.encodeEntry(
            PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("the only copy"))), 3)
        File(d, "n1.note.new").writeBytes(newer)
        val s = refusingRenames(d, "n1.note") { refuse }
        assertEquals(listOf("n1.note.new"), s.scan().unreadable.map { it.file })
        assertEquals(SaveOutcome.Blocked, s.saveLocal("n1", "b1", "r5", blob("typed over it"), isCreate = false))
        assertArrayEquals(newer, File(d, "n1.note.new").readBytes())
        refuse = false
        assertEquals(listOf(Read.Unreadable("n1.note", "format version 3")), s.scan().unreadable)
        assertArrayEquals(newer, File(d, "n1.note").readBytes())
    }

    @Test fun `an uncommitted write beside a committed file is dropped whatever its layout`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        File(dir, "n1.note.new").writeBytes(withFormatVersion(PendingCodec.encodeEntry(entry("n1").copy(revision = "r-newer")), 3))
        val scan = restarted().scan()
        assertEquals("the last content a save reported", "r1", scan.entries.single().revision)
        assertTrue(scan.unreadable.isEmpty())
        assertFalse(File(dir, "n1.note.new").exists())
    }

    @Test fun `an intact first write of another kind that this build cannot read is kept for the build that can, and reported by nobody`() {
        // A notebook copy may be the only way to decrypt held text, so it is not thrown away either.
        val copy = withFormatVersion(PendingCodec.encodeNotebook("b1", blob("key b1")), 2)
        val counter = withFormatVersion(PendingCodec.encodeSequence(41), 2)
        dir.mkdirs()
        File(dir, "b1.notebook.new").writeBytes(copy)
        File(dir, "sequence.new").writeBytes(counter)
        File(dir, "cut.notebook.new").writeBytes(PendingCodec.encodeNotebook("cut", blob("key")).copyOf(12))
        val scan = store.scan()
        assertTrue(scan.entries.isEmpty())
        assertTrue("only entry files are reported", scan.unreadable.isEmpty())
        assertArrayEquals(copy, File(dir, "b1.notebook").readBytes())
        assertNull("this build cannot use it", store.notebook("b1"))
        assertFalse(File(dir, "b1.notebook.new").exists())
        assertFalse("one that was cut short goes, as before", File(dir, "cut.notebook.new").exists() || File(dir, "cut.notebook").exists())
        // A counter written in full in a layout this build cannot read, here a newer build's: no version
        // is handed out over it, and it stays as that build wrote it.
        assertArrayEquals(counter, File(dir, "sequence").readBytes())
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n1", "b1", "r1", blob("first"), isCreate = true)
        }
        assertArrayEquals(counter, File(dir, "sequence").readBytes())
        assertEquals(Read.Missing, store.read("n1"))
    }

    @Test fun `removing an entry also removes a stale new file so a later recovery cannot bring it back`() {
        store.saveLocal("n1", "b1", "r1", blob("draft"), isCreate = true)
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(entry("n1").copy(revision = "r-old")))
        store.discard("n1")
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
        store.saveLocal("n3", "b1", "r1", blob("held"), isCreate = false)
        store.hold("n3", HeldReason.READ_ONLY, now = 1)
        val snapshot = store.snapshot { it.notebookUid == "b1" && it.state == PendingEntry.State.UPSERT }
        assertEquals(listOf("n1", "n2", "n3"), snapshot.headers.map { it.noteUid })
        assertEquals(PendingNotesStore.EntryHeader("n1", "b1", PendingEntry.State.UPSERT, v1), snapshot.headers.first())
        assertEquals(PendingEntry.State.HELD, snapshot.headers.last().state)
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

    @Test fun `a format 1 entry file is reported as unreadable and kept, committed or not`() {
        // The layout of the unreleased branch, before entries had a header section.
        val v1Upsert = "53534e500100066e6f74652d310006626f6f6b2d3101000000000000000300057265762d33010000000100057265762d3200000000ffffffffffffffff0000000000000003010203f0a8313a"
        val bytes = ByteArray(v1Upsert.length / 2) { v1Upsert.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        dir.mkdirs()
        File(dir, "note-1.note").writeBytes(bytes)
        File(dir, "note-2.note.new").writeBytes(bytes) // a first write that never got its rename
        val snapshot = store.snapshot { false }
        assertTrue(snapshot.headers.isEmpty())
        assertEquals(listOf(Read.Unreadable("note-1.note", "format version 1"), Read.Unreadable("note-2.note", "format version 1")),
            snapshot.unreadable)
        assertEquals(SaveOutcome.Blocked, store.saveLocal("note-1", "book-1", "rev-4", blob("typed over it"), isCreate = false))
        restarted().scan()
        assertArrayEquals(bytes, File(dir, "note-1.note").readBytes())
        assertArrayEquals(bytes, File(dir, "note-2.note").readBytes())
        assertFalse(File(dir, "note-2.note.new").exists())
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

    @Test fun `a failed listing prunes nothing, even when the listings after it work`() {
        store.putNotebook("b9", blob("key b9"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1"))
        var listings = 0
        PendingNotesStore.listFilesForTesting = { d -> if (listings++ == 0) null else d.listFiles() }
        assertThrows(java.io.IOException::class.java) { store.pruneNotebooks() }
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
        assertArrayEquals(blob("key b9"), store.notebook("b9"))
        assertEquals(listOf("b9"), store.pruneNotebooks())
    }

    @Test fun `a prune runs no recovery that is owed, and lists and removes nothing until another call has run it`() {
        store.putNotebook("b9", blob("key b9"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1"))
        // A refresh of a copy that is there already stops at its rename, so a recovery is owed: it drops the
        // write left beside that copy.
        PendingNotesStore.beforeRenameForTesting = {
            if (it.name == "b1.notebook") throw java.io.IOException("rename refused")
        }
        assertThrows(java.io.IOException::class.java) { store.putNotebook("b1", blob("key b1 again")) }
        PendingNotesStore.beforeRenameForTesting = null
        assertTrue(File(dir, "b1.notebook.new").exists())
        // Run by the prune, a recovery that fails would only be logged. The prune asks for no listing at all.
        val asked = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d -> asked += d.name; null }
        assertEquals(emptyList<String>(), store.pruneNotebooks())
        assertEquals("no listing, so no recovery either", emptyList<String>(), asked)
        PendingNotesStore.listFilesForTesting = null
        assertTrue(File(dir, "b9.notebook").exists() && File(dir, "b1.notebook.new").exists())
        // The next other call runs the recovery, where a failure counts, and a prune after it works as before.
        assertEquals(listOf("n1"), store.scan().entries.map { it.noteUid })
        assertFalse(File(dir, "b1.notebook.new").exists())
        assertEquals(listOf("b9"), store.pruneNotebooks())
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
        assertNull(store.notebook("b9"))
    }

    @Test fun `a store whose directory was never created prunes nothing and stays uncreated`() {
        val never = File(tmp.root, "never")
        val s = open(never)
        // A prune runs no recovery, so a scan runs it first; the prune then lists the directory itself.
        assertTrue(s.scan().entries.isEmpty())
        val asked = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d -> asked += d.name; d.listFiles() }
        assertTrue(s.pruneNotebooks().isEmpty())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("not there, as the directory above shows", listOf("never", tmp.root.name), asked)
        assertFalse(never.exists())
    }

    // ---- a listing that fails is never an empty store ----

    @Test fun `a listing of the store that fails is not read as an empty store`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == store.dir.name) null else d.listFiles() }
        assertThrows("read as empty, a run would report success while n1 waits", java.io.IOException::class.java) {
            store.scan()
        }
        assertThrows(java.io.IOException::class.java) { store.snapshot { false } }
        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("n1"), store.scan().entries.map { it.noteUid })
        assertEquals(listOf("n1"), store.snapshot { false }.headers.map { it.noteUid })
        // A store whose directory was never made still lists as empty, and asking does not make it.
        val never = File(tmp.root, "never-listed")
        assertTrue(open(never).snapshot { false }.headers.isEmpty())
        assertFalse(never.exists())
    }

    @Test fun `a recovery that cannot list the store decides nothing, and the next call commits what it missed`() {
        // The first write of n1 stopped before its rename, in a process that ended: that file is the only
        // copy of the text, and the notebook copy beside it is the way to decrypt it.
        val only = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("the only copy"))
        store.putNotebook("b1", blob("key b1"))
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(only))
        val s = restarted()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == s.dir.name) null else d.listFiles() }
        assertThrows(java.io.IOException::class.java) { s.read("n1") }
        assertEquals("a prune runs no recovery, and removes nothing while one is owed",
            emptyList<String>(), s.pruneNotebooks())
        PendingNotesStore.listFilesForTesting = null
        // Taken for done, the failed recovery would leave n1 uncommitted, and no scan or snapshot would
        // show it.
        assertEquals(listOf("n1"), s.snapshot { false }.headers.map { it.noteUid })
        assertEquals("the copy the stranded text needs is kept", emptyList<String>(), s.pruneNotebooks())
        assertEquals(only, s.entry("n1"))
        assertFalse(File(dir, "n1.note.new").exists())
        assertArrayEquals(blob("key b1"), s.notebook("b1"))
    }

    @Test fun `a new process whose recovery cannot list the store does not send an unfinished original`() {
        store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = {
            if (it.name == "orig.note") throw java.io.IOException("could not remove orig.note")
        }
        assertThrows(java.io.IOException::class.java) {
            store.replaceWithNewNote("orig", entry("orig").version, "srv", newNote())
        }
        val next = restarted()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == next.dir.name) null else d.listFiles() }
        // Taken for done, this recovery would know of no unfinished original: orig would go out again,
        // get the same 409, and become a second copy of the same text.
        assertThrows(java.io.IOException::class.java) { next.startSend("orig") }
        PendingNotesStore.listFilesForTesting = null
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.UNFINISHED_ORIGINAL),
            next.startSend("orig"))
    }

    @Test fun `a lost version counter is not rebuilt from a listing that fails`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        val sequence = File(dir, "sequence")
        assertTrue(sequence.delete())
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) null else d.listFiles() }
        // Read as an empty store, the rebuild would restart below n1 and hand out a version n1 holds.
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)
        }
        assertFalse(sequence.exists())
        // And a load would carry sequence 0, below the save that n1 holds.
        assertThrows(java.io.IOException::class.java) { store.observe("n1") }
        PendingNotesStore.listFilesForTesting = null
        assertTrue("it restarts above every version on disk",
            saved(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
    }

    @Test fun `a damaged version counter is not rebuilt from a listing that fails, and is left as it is`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        val sequence = File(dir, "sequence")
        val damaged = sequence.readBytes().also { it[6] = (it[6].toInt() xor 0x40).toByte() }
        sequence.writeBytes(damaged)
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) null else d.listFiles() }
        assertThrows(java.io.IOException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)
        }
        assertArrayEquals("nothing was written over it", damaged, sequence.readBytes())
        assertThrows(java.io.IOException::class.java) { store.observe("n1") }
        PendingNotesStore.listFilesForTesting = null
        assertEquals(Read.Missing, store.read("n2"))
        assertTrue(saved(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
    }

    @Test fun `a store directory that is there but cannot be listed is not empty, however far up the walk goes`() {
        // File.exists() answers false for a check that fails as well as for a directory that is not there.
        val root = tmp.newFolder("no_backup")
        val s = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-1"))
        s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        // The directories each case lists, so that every case is seen to take its own way up.
        val asked = ArrayList<String>()
        fun failing(vararg names: String): (File) -> Array<File>? =
            { d -> asked += d.name; if (d.name in names) null else d.listFiles() }
        PendingNotesStore.listFilesForTesting = failing(s.dir.name)
        assertThrows("the directory above shows it is there", java.io.IOException::class.java) { s.snapshot { false } }
        assertEquals(listOf(s.dir.name, "notes-pending"), asked)
        asked.clear()
        PendingNotesStore.listFilesForTesting = failing(s.dir.name, "notes-pending")
        assertThrows("the nearest directory above that can be listed shows the one below it",
            java.io.IOException::class.java) { s.snapshot { false } }
        assertEquals(listOf(s.dir.name, "notes-pending", "no_backup"), asked)
        PendingNotesStore.listFilesForTesting = { null }
        assertThrows("no directory above can be listed", java.io.IOException::class.java) { s.snapshot { false } }
        PendingNotesStore.listFilesForTesting = null
        assertEquals("the change was there all along", listOf("n1"), s.snapshot { false }.headers.map { it.noteUid })
    }

    @Test fun `a store under directories that were never made holds nothing, and asking makes none of them`() {
        // As for an account that never saved a note on a device where no account did: no notes-pending either.
        val root = tmp.newFolder("no_backup")
        val never = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-1"))
        val snapshot = never.snapshot { true }
        assertTrue(snapshot.headers.isEmpty() && snapshot.entries.isEmpty() && snapshot.unreadable.isEmpty())
        assertEquals(PendingNotesStore.Scan(emptyList(), emptyList()), never.scan())
        assertEquals(PendingNotesStore.Observed(Read.Missing, 0), never.observe("n1"))
        assertTrue(never.pruneNotebooks().isEmpty())
        assertFalse(File(root, "notes-pending").exists())
    }

    @Test fun `a listed entry that File isFile does not count as a file is still read, and its notebook copy kept`() {
        // File.isFile answers false when its check fails, as well as for anything that is not a regular
        // file. Dropped for that, the entry would be neither reported nor pushed, its version would be
        // passed over when a lost counter is rebuilt, and the copy of its notebook would look unreferenced.
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1")))
        fun statFails(f: File): File = object : File(f.path) {
            override fun isFile() = false
        }
        PendingNotesStore.listFilesForTesting = { d ->
            d.listFiles()?.map { if (it.name == "n1.note") statFails(it) else it }?.toTypedArray()
        }
        assertEquals(listOf("n1"), store.snapshot { false }.headers.map { it.noteUid })
        assertEquals(listOf("n1"), store.scan().entries.map { it.noteUid })
        assertEquals(emptyList<String>(), store.pruneNotebooks())
        assertTrue(File(dir, "sequence").delete())
        assertTrue("above the version n1 holds",
            saved(store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
    }

    @Test fun `a prune decides from one listing, so a listing above that wrongly shows nothing removes no copy`() {
        store.putNotebook("b9", blob("key b9"))
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1"))
        // The store's own listing fails once, and the listing above it then answers with no names, as if
        // the store were not there. Every listing after those two is real.
        val asked = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d ->
            asked += d.name
            when (asked.size) {
                1 -> null
                2 -> emptyArray()
                else -> d.listFiles()
            }
        }
        assertEquals("read as a store that is not there, which holds no copy to remove",
            emptyList<String>(), store.pruneNotebooks())
        assertEquals("one listing of the store, and the one above it",
            listOf(dir.name, store.dir.parentFile!!.name), asked)
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
        assertArrayEquals(blob("key b9"), store.notebook("b9"))
        assertEquals(listOf("b9"), store.pruneNotebooks())
    }

    @Test fun `a prune keeps every copy while its listing holds a first write that is not committed yet`() {
        store.putNotebook("b1", blob("key b1"))
        // A first write of n1 that recovery does not know of, as when its check that a problem's file is
        // still there fails: written in full after recovery ran. No committed entry names b1, and the next
        // recovery commits this write, which needs that copy.
        val first = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("first write"))
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(first))
        assertEquals(emptyList<String>(), store.pruneNotebooks())
        assertArrayEquals(blob("key b1"), store.notebook("b1"))
        val next = restarted()
        assertEquals(first, next.entry("n1"))
        assertEquals("an entry names it now", emptyList<String>(), next.pruneNotebooks())
        assertArrayEquals(blob("key b1"), next.notebook("b1"))
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

    // ---- on disk: the three requirements on the store from #709, as far as the JVM can show them (design 3.1) ----

    /** Bytes that are no text in any encoding, as a blob from the binding is. The other tests use readable stand-ins. */
    private fun opaque(size: Int, seed: Long) = ByteArray(size).also { java.util.Random(seed).nextBytes(it) }

    @Test fun `the directory holds an entry, a landed record, a notebook copy and the counter, each as encoded and nothing more`() {
        // The store is never handed a title or a text: a save gives it uids, a revision uid and one blob,
        // which the binding has already encrypted. So the JVM can show that the store adds nothing of its
        // own, and that each file is the codec's output for what the store reports. Which fields the
        // codec writes in the clear is frozen by the byte fixtures in PendingCodecTest, not here. That a
        // blob holds no plain text is shown on a device, through the real binding.
        val noteBlob = opaque(4096, 1)
        val copyBlob = opaque(512, 2)
        val landedBlob = opaque(4096, 3)
        val editor = store.editorOpened("n1")
        val v1 = saved(store.saveLocal(editor, "n1", "b1", "rev-1", noteBlob, isCreate = false, notebookCopy = copyBlob))
        val sent = store.beginSend("n1")!!
        // Saved again during the upload, so the entry stays next to the landed record the open editor keeps.
        val v2 = saved(store.saveLocal(editor, "n1", "b1", "rev-2", noteBlob, isCreate = false))
        store.completeSend("n1", sent.version, "rev-1", landedBlob)
        assertTrue(store.recordFailure("n1", v2, "TRANSIENT", now = 1_758_800_000_000))

        assertEquals(setOf("n1.note", "n1.landed", "b1.notebook", "sequence"), dir.list()!!.toSet())
        val expected = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, v2, "rev-2", isCreate = false, sent = listOf("rev-1"),
            failureCount = 1, lastFailureAt = 1_758_800_000_000, lastFailureCategory = "TRANSIENT", blob = noteBlob)
        assertEquals(expected, entry("n1"))
        val bytes = File(dir, "n1.note").readBytes()
        assertArrayEquals("no byte that is not a field, a blob or a checksum", PendingCodec.encodeEntry(expected), bytes)
        // The blob sits whole behind the header, and the plain part of the file ends where it starts.
        val headerEnd = PendingCodec.entryHeaderEnd(bytes)!!
        assertEquals(headerEnd + 4 + noteBlob.size + 4, bytes.size)
        assertArrayEquals(noteBlob, bytes.copyOfRange(headerEnd + 4, headerEnd + 4 + noteBlob.size))
        assertArrayEquals(PendingCodec.encodeLanded(LandedRecord("n1", "rev-1", v1, landedBlob)), File(dir, "n1.landed").readBytes())
        assertArrayEquals(PendingCodec.encodeNotebook("b1", copyBlob), File(dir, "b1.notebook").readBytes())
        assertArrayEquals(PendingCodec.encodeSequence(v2), File(dir, "sequence").readBytes())
    }

    @Test fun `the directory is named by a digest, whatever the account name holds`() {
        // The Etebase cache lives under filesDir/<account name>, so a name decides that path. It never
        // decides this one: no name can point the store into another directory, a cache directory
        // included, and no name shows in the path.
        val root = tmp.newFolder("no_backup")
        val names = listOf("alice@example.invalid", "..", "../cache", "../files/alice@example.invalid", "notes-pending", "a/b", "")
        val dirs = names.map { PendingNotesStore.identityDir(root, "io.silentsuite", it, "gen-1") }
        for (d in dirs) {
            assertEquals(File(root, "notes-pending"), d.parentFile)
            assertTrue(d.name, Regex("[0-9a-f]{64}").matches(d.name))
        }
        assertEquals("one directory per name", names.size, dirs.toSet().size)
    }

    @Test fun `a same-name account with another creation id finds nothing of the first and leaves its files alone`() {
        val root = tmp.newFolder("no_backup")
        val old = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-1"))
        val replacement = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-2"))
        assertNotSame(old, replacement)
        old.saveLocal("n1", "b1", "r1", blob("old draft"), isCreate = false, notebookCopy = blob("old notebook"))
        fun oldFiles() = old.dir.listFiles()!!.associate { it.name to it.readBytes().toList() }
        val before = oldFiles()

        // Nothing is inherited: no entry, no notebook copy, nothing to send, and a counter that starts over.
        assertEquals(PendingNotesStore.Observed(Read.Missing, 0), replacement.observe("n1"))
        assertEquals(PendingNotesStore.Scan(emptyList(), emptyList()), replacement.scan())
        assertTrue(replacement.snapshot { true }.let { it.headers.isEmpty() && it.entries.isEmpty() && it.unreadable.isEmpty() })
        assertNull(replacement.notebook("b1"))
        assertNull(replacement.landed("n1"))
        assertNull(replacement.beginSend("n1"))

        // Nothing is overwritten: its own save of the same note goes to its own directory.
        replacement.saveLocal("n1", "b1", "r9", blob("new draft"), isCreate = false, notebookCopy = blob("new notebook"))
        assertArrayEquals(blob("new draft"), replacement.entry("n1").blob)
        assertArrayEquals(blob("old draft"), old.entry("n1").blob)
        assertEquals(before, oldFiles())

        // Clearing the replacement, as its sign-out will, removes its directory only.
        replacement.clearAll()
        assertFalse(replacement.dir.exists())
        assertEquals(before, oldFiles())
        assertEquals(listOf(old.dir.name), File(root, "notes-pending").list()!!.toList())
    }
}
