package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.NotebookDiscard
import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalCheck
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes

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
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.identityForTesting = null
        PendingNotesStore.linkForTesting = null
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        PendingNotesDiscardPermits.beforeDeleteForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
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
        // A new instance, as after a restart, so that only the rebuild keeps the save above.
        assertTrue("n2 still holds its version",
            saved(restarted().saveLocal("n3", "b1", "r1", blob("three"), isCreate = false)) > high)
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

    @Test fun `with the counter lost after the highest note was pushed, a confirmation does not cover a later save`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(2, 2, false, names = notes("n1", "n2")), shown)
        // n2, at the highest version, is pushed, and the counter is lost: the rebuild falls to n1's version.
        assertEquals(SendOutcome.Done, store.completeSend("n2", store.beginSend("n2")!!.version, "r2", blob("landed")))
        assertTrue(File(dir, "sequence").delete())
        val typed = saved(store.saveLocal("n1", "b1", "r2", blob("typed after the confirmation"), isCreate = false))
        assertTrue("above the sequence that was confirmed", typed > shown.sequence)
        val before = filesOf(dir)
        assertEquals(DiscardOutcome.Changed(store.unsynced()), store.discardStore(shown))
        assertEquals("nothing was deleted", before, filesOf(dir))
        assertArrayEquals(blob("typed after the confirmation"), entry("n1").blob)
    }

    @Test fun `with the counter lost, text saved after an answer was shown is not covered by it, though the rebuild falls`() {
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        // An instance that handed out no version itself shows the answer.
        val s = restarted()
        val shown = s.unsynced()
        assertEquals(UnsyncedNotes(2, 2, false, names = notes("n1", "n2")), shown)
        // n1 held the highest version and goes, and the counter is lost: the rebuild falls to n2's version.
        s.discard("n1")
        assertTrue(File(dir, "sequence").delete())
        val typed = saved(s.saveLocal("n1", "b1", "r2", blob("typed after the answer was shown"), isCreate = false))
        assertTrue("above the sequence that was shown", typed > shown.sequence)
        val before = filesOf(dir)
        assertEquals(DiscardOutcome.Changed(s.unsynced()), s.discardStore(shown))
        assertEquals("nothing was deleted", before, filesOf(dir))
        assertArrayEquals(blob("typed after the answer was shown"), s.entry("n1").blob)
    }

    @Test fun `with the counter lost, a save does not give back the sequence an editor was handed`() {
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val s = restarted()
        val handed = s.observe("n2").sequence
        s.discard("n1")
        assertTrue(File(dir, "sequence").delete())
        s.saveLocal("n1", "b1", "r2", blob("typed later"), isCreate = false)
        assertTrue(s.observe("n2").sequence > handed)
    }

    @Test fun `with the counter lost, a note saved again after its entry went does not take the version an upload carries`() {
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n1", "b1", "r1", blob("sent"), isCreate = false)
        // A new instance, as after a restart, that reads no sequence before the upload starts: only the upload keeps
        // the next version above the one it carries.
        val s = restarted()
        val sent = s.beginSend("n1")!!
        // n1's entry goes while its upload is in flight, the counter is lost, and n1 is saved again: the rebuild
        // falls to n2's version.
        s.discard("n1")
        assertTrue(File(dir, "sequence").delete())
        val typed = saved(s.saveLocal("n1", "b1", "r2", blob("typed after the discard"), isCreate = false))
        assertTrue("above the version that was sent", typed > sent.version)
        assertTrue(s.completeSend("n1", sent.version, "r1", blob("landed")) is SendOutcome.NewerLocalChange)
        assertArrayEquals("the new text stays to be sent", blob("typed after the discard"), s.entry("n1").blob)
    }

    @Test fun `with the counter lost, an instance does not hand out a version it handed out before`() {
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val handed = saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        store.discard("n1")
        assertTrue(File(dir, "sequence").delete())
        assertTrue(saved(store.saveLocal("n1", "b1", "r2", blob("again"), isCreate = false)) > handed)
    }

    @Test fun `in one process the sequence an answer carries does not fall when the counter is lost`() {
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val s = restarted()
        assertEquals(2L, s.unsynced().sequence)
        s.discard("n1")
        assertTrue(File(dir, "sequence").delete())
        assertEquals("n2 alone holds version 1 now", UnsyncedNotes(1, 2, false, names = notes("n2")), s.unsynced())
        assertEquals(2L, s.observe("n2").sequence)
        assertFalse("and nothing is written", File(dir, "sequence").exists())
    }

    @Test fun `an answer shown before a discard that finished does not cover text saved in the store opened after it`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = store.unsynced()
        assertEquals(DiscardOutcome.Done, store.discardStore(shown))
        store.unregister()
        // The discard deleted the counter with the store; the next instance in this process starts above it all
        // the same.
        val next = open(dir)
        val typed = saved(next.saveLocal("n1", "b1", "r2", blob("typed after the discard"), isCreate = false))
        assertTrue("above the sequence that was shown", typed > shown.sequence)
        val before = filesOf(dir)
        assertEquals(DiscardOutcome.Changed(next.unsynced()), next.discardStore(shown))
        assertEquals("nothing was deleted", before, filesOf(dir))
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
        // Reads take the highest version they can read, and a push needs no new version. In a new instance, as after
        // a restart, so that what the reads find on disk alone gives the sequence.
        val s = restarted()
        assertEquals(v2, s.snapshot { false }.sequence)
        assertEquals(v2, s.observe("n1").sequence)
        assertEquals(SendOutcome.Done, s.completeSend("n1", s.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals(Read.Missing, s.read("n1"))
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
        // Damaged, not written in another layout: no version is left on disk to stay above, so a new instance, as
        // after a restart, starts at 1. The instance that handed out 2 would stay above it.
        assertEquals(1L, saved(restarted().saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)))
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
        // A new instance, as after a restart, so that what is on disk alone gives each version below.
        val s = restarted()
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertEquals(Read.Missing, s.read("n2"))
        assertEquals("reads pass over them", v1 + 1, s.snapshot { false }.sequence)
        assertTrue(File(dir, "n1.draft").delete())
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertTrue(File(dir, "versions").delete())
        assertEquals("then above every version on disk",
            v1 + 2, saved(s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)))
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
        // A new instance, as after a restart, so that what is on disk alone gives each version below.
        val t = restarted()
        val save = { t.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertThrows(java.io.IOException::class.java) { save() }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertFalse("no entry is written", File(dir, "n2.note").exists() || File(dir, "n2.note.new").exists())
        assertEquals("reads still work", "r1", (t.read("n1") as Read.Present).entry.revision)
        assertEquals(v1, t.snapshot { false }.sequence)
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
        // In a new instance, as after a restart, so that only the rebuild keeps it above.
        assertTrue("it restarts above every version on disk",
            saved(restarted().saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
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
        // In a new instance, as after a restart, so that only the rebuild keeps it above.
        assertTrue(saved(restarted().saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
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
        // A new instance, as after a restart, so that only the rebuild keeps the save above.
        val s = restarted()
        assertTrue("above the version n1 holds",
            saved(s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)) > v1)
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(blob("key b1"), s.notebook("b1"))
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

    @Test fun `a prune removes no copy while a file a discard that has not finished was confirmed for is there`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n2", "b2", "r1", blob("confirmed for discard"), isCreate = false, notebookCopy = blob("key b2"))
        val s = restarted()
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = notes("n2")))
        // The listing comes back short and leaves out n2.note, whose notebook copy may be the only key to its text
        // once a save withdraws the permit.
        listingLeavesOut("n2.note")
        val waiting = s.snapshot { false }
        assertEquals(listOf("n1"), waiting.headers.map { it.noteUid })
        assertTrue(waiting.discardUnfinished)
        val copy = File(dir, "b2.notebook").readBytes()
        assertEquals(emptyList<String>(), s.pruneNotebooks())
        assertArrayEquals("the copy stays, byte for byte", copy, File(dir, "b2.notebook").readBytes())
    }

    @Test fun `a prune removes no copy while a permit that may be there cannot be read`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false, notebookCopy = blob("key b2"))
        val s = restarted()
        // Read, this permit would hold nothing back: what it names is gone.
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = notes("gone")))
        permitReadsFail()
        listingLeavesOut("n2.note")
        assertTrue(s.snapshot { false }.discardUnfinished)
        val copy = File(dir, "b2.notebook").readBytes()
        assertEquals(emptyList<String>(), s.pruneNotebooks())
        assertArrayEquals("the copy stays, byte for byte", copy, File(dir, "b2.notebook").readBytes())
    }

    // ---- a check that fails is never an absence ----

    /** Every check of whether one of [names] is there fails, as lstat(2) can (EACCES, EIO); others work. */
    private fun checksFailFor(vararg names: String) {
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name in names) PendingNotesStore.Presence.UNKNOWN else null
        }
    }

    @Test fun `an entry whose presence cannot be told reads as unreadable, never as missing`() {
        store.saveLocal("n0", "b1", "r1", blob("t"), isCreate = false)
        // n1 has neither an entry nor a first write, but neither can be shown not to be there.
        checksFailFor("n1.note")
        assertEquals(Read.Unreadable("n1.note", "could not tell whether n1.note is there"), store.read("n1"))
        assertEquals(Read.Unreadable("n1.note", "could not tell whether n1.note is there"), store.observe("n1").read)
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.UNREADABLE), store.startSend("n1"))
        checksFailFor("n1.note.new")
        assertEquals(Read.Unreadable("n1.note.new", "could not tell whether n1.note.new is there"), store.read("n1"))
        PendingNotesStore.presenceForTesting = null
        assertEquals("shown not to be there, it is missing as before", Read.Missing, store.read("n1"))
    }

    @Test fun `a save over an entry whose presence cannot be told is blocked and writes nothing`() {
        store.saveLocal("n0", "b1", "r1", blob("t"), isCreate = false)
        fun files() = dir.listFiles()!!.associate { it.name to it.readBytes().toList() }
        val before = files()
        for (name in listOf("n1.note", "n1.note.new")) {
            checksFailFor(name)
            assertEquals(name, SaveOutcome.Blocked,
                store.saveLocal("n1", "b2", "r1", blob("typed"), isCreate = true, notebookCopy = blob("key b2")))
            assertEquals("no entry, no counter and no notebook copy: $name", before, files())
        }
        PendingNotesStore.presenceForTesting = null
        assertTrue(store.saveLocal("n1", "b2", "r1", blob("typed"), isCreate = true) is SaveOutcome.Saved)
    }

    @Test fun `a removal whose check fails throws and keeps the file`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        val bytes = File(dir, "n1.note").readBytes()
        // The entry, and a first write that may be left beside it: either one passed over as absent, the
        // removal would report success over a file that may still be there.
        for (name in listOf("n1.note", "n1.note.new")) {
            checksFailFor(name)
            assertThrows(name, java.io.IOException::class.java) { store.discard("n1") }
            assertThrows(name, java.io.IOException::class.java) { store.completeSend("n1", v1, "r1", blob("landed")) }
            assertArrayEquals(name, bytes, File(dir, "n1.note").readBytes())
        }
        checksFailFor("n1.landed")
        assertThrows(java.io.IOException::class.java) { store.clearLanded("n1") }
        PendingNotesStore.presenceForTesting = null
        store.discard("n1")
        assertEquals(Read.Missing, store.read("n1"))
    }

    @Test fun `a recovery problem stays reported while its file cannot be shown gone`() {
        val d = tmp.newFolder("problem")
        val only = PendingEntry("n1", "b1", PendingEntry.State.UPSERT, 4, "r4", false, blob = blob("the only copy"))
        File(d, "n1.note.new").writeBytes(PendingCodec.encodeEntry(only))
        // Its commit keeps failing, so recovery reports it each time it runs.
        val s = refusingRenames(d, "n1.note") { true }
        assertEquals(listOf("n1.note.new"), s.scan().unreadable.map { it.file })
        checksFailFor("n1.note.new")
        // Dropped, the problem would show in no report, and a run could record success while the text waits.
        assertEquals(listOf("n1.note.new"), s.scan().unreadable.map { it.file })
        assertEquals(listOf("n1.note.new"), s.snapshot { false }.unreadable.map { it.file })
        assertArrayEquals(PendingCodec.encodeEntry(only), File(d, "n1.note.new").readBytes())
    }

    @Test fun `an uncommitted write beside a committed file whose check fails is dropped, not committed over it`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        val committed = File(dir, "n1.note").readBytes()
        // An intact later entry whose write never reported success: committed, it would replace the text a save did.
        val later = entry("n1").copy(version = 9, revision = "r-newer", blob = blob("never reported saved"))
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(later))
        checksFailFor("n1.note")
        val s = restarted()
        assertTrue(s.scan().unreadable.isEmpty())
        assertFalse(File(dir, "n1.note.new").exists())
        assertArrayEquals("the last content a save reported", committed, File(dir, "n1.note").readBytes())
    }

    /**
     * A listing of the store that comes back short, as File.listFiles can when reading the directory fails
     * partway: it still shows the write beside [name] but leaves out [name] itself.
     */
    private fun listingLeavesOut(name: String) {
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == dir.name) d.listFiles()?.filter { it.name != name }?.toTypedArray() else d.listFiles()
        }
    }

    @Test fun `an uncommitted write beside a committed file that a short listing leaves out is dropped, not committed over it`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        val committed = File(dir, "n1.note").readBytes()
        // An intact later entry whose write never reported success: committed, it would replace the text a save did.
        val later = entry("n1").copy(version = 9, revision = "r-newer", blob = blob("never reported saved"))
        File(dir, "n1.note.new").writeBytes(PendingCodec.encodeEntry(later))
        listingLeavesOut("n1.note")
        // The committed file's own check still finds it there.
        val s = restarted()
        assertTrue(s.scan().unreadable.isEmpty())
        assertArrayEquals("the last content a save reported", committed, File(dir, "n1.note").readBytes())
        assertFalse(File(dir, "n1.note.new").exists())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("r1", s.entry("n1").revision)
    }

    @Test fun `an uncommitted write beside a committed file that a short listing leaves out and whose check fails is kept and reported`() {
        store.saveLocal("n1", "b1", "r1", blob("committed"), isCreate = false)
        val committed = File(dir, "n1.note").readBytes()
        val later = PendingCodec.encodeEntry(
            entry("n1").copy(version = 9, revision = "r-newer", blob = blob("never reported saved")))
        File(dir, "n1.note.new").writeBytes(later)
        listingLeavesOut("n1.note")
        checksFailFor("n1.note")
        val s = restarted()
        val scan = s.scan()
        assertArrayEquals("the last content a save reported", committed, File(dir, "n1.note").readBytes())
        assertArrayEquals("neither dropped nor committed while it cannot be told", later, File(dir, "n1.note.new").readBytes())
        val problem = listOf(Read.Unreadable("n1.note.new", "could not tell whether n1.note is there"))
        assertEquals(problem, scan.unreadable)
        assertEquals(problem, s.snapshot { false }.unreadable)
        assertArrayEquals(later, File(dir, "n1.note.new").readBytes())
        // With a full listing and a check that works, the next recovery drops the write as usual.
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.presenceForTesting = null
        val after = s.scan()
        assertTrue(after.unreadable.isEmpty())
        assertEquals(listOf("r1"), after.entries.map { it.revision })
        assertArrayEquals(committed, File(dir, "n1.note").readBytes())
        assertFalse(File(dir, "n1.note.new").exists())
    }

    @Test fun `a landed record or notebook copy whose presence cannot be told is not read as none`() {
        store.saveLocal("n0", "b1", "r1", blob("t"), isCreate = false)
        checksFailFor("n1.landed", "b2.notebook")
        assertThrows(java.io.IOException::class.java) { store.landed("n1") }
        assertThrows(java.io.IOException::class.java) { store.notebook("b2") }
        // A new entry starts from the note's landed record, so none is written while that cannot be ruled out.
        assertThrows(java.io.IOException::class.java) { store.saveLocal("n1", "b1", "r1", blob("u"), isCreate = true) }
        assertFalse(File(dir, "n1.note").exists() || File(dir, "n1.note.new").exists())
        PendingNotesStore.presenceForTesting = null
        assertNull(store.landed("n1"))
        assertNull(store.notebook("b2"))
        assertTrue(store.saveLocal("n1", "b1", "r1", blob("u"), isCreate = true) is SaveOutcome.Saved)
        assertTrue("no landed record, so still a create", entry("n1").isCreate)
    }

    @Test fun `with the counter lost, a counter whose presence cannot be told stops new versions and reads`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false))
        assertTrue(File(dir, "sequence").delete())
        checksFailFor("sequence")
        // Its own check fails, so the counter is not taken for lost, though the listing no longer shows it.
        assertThrows(java.io.IOException::class.java) { store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertFalse("no counter is written", File(dir, "sequence").exists() || File(dir, "sequence.new").exists())
        assertThrows(java.io.IOException::class.java) { store.observe("n1") }
        assertThrows(java.io.IOException::class.java) { store.snapshot { false } }
        PendingNotesStore.presenceForTesting = null
        assertEquals(Read.Missing, store.read("n2"))
        // In a new instance, as after a restart, so that only the rebuild gives it.
        assertEquals("shown to be lost, it is rebuilt as before",
            v1 + 1, saved(restarted().saveLocal("n2", "b1", "r1", blob("u"), isCreate = false)))
    }

    @Test fun `a conflict copy keeps its link while the original it replaced cannot be shown gone`() {
        val v1 = saved(store.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false))
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) { store.replaceWithNewNote("orig", v1, "srv", newNote()) }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        // The original goes, and the next process cannot show that it is gone.
        assertTrue(File(dir, "orig.note").delete())
        checksFailFor("orig.note")
        val next = restarted()
        assertNull(next.beginSend("copy1"))
        assertThrows(java.io.IOException::class.java) { next.discard("copy1") }
        assertEquals("orig", next.entry("copy1").origin?.noteUid)
        PendingNotesStore.presenceForTesting = null
        assertNull("shown gone, the link is cleared", restarted().beginSend("copy1")!!.origin)
    }

    @Test fun `a sign-out clear returns only once the store directory is shown gone`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        // The deletion works, but no directory above the store can be listed, so it cannot be shown gone.
        PendingNotesStore.listFilesForTesting = { null }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        // A listing above that still shows the directory is no proof either.
        val above = store.dir.parentFile!!
        PendingNotesStore.listFilesForTesting = { d -> if (d.path == above.path) arrayOf(store.dir) else d.listFiles() }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        // Nor is a listing that no longer shows it while its own check fails, since a listing can come back short.
        PendingNotesStore.listFilesForTesting = null
        checksFailFor(store.dir.name)
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        PendingNotesStore.presenceForTesting = null
        store.clearAll()
        assertFalse(dir.exists())
        assertThrows(IllegalStateException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false)
        }
    }

    @Test fun `the store asks File exists nothing, and keeps only checks that cannot make a file absent`() {
        // File.exists() answers false for a check that failed as well as for a file that is not there.
        val code = File("src/main/java/io/silentsuite/sync/notes/edit/PendingNotesStore.kt").readText()
            .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")
        // Words, not calls, so that a reference such as File::exists is caught as well.
        assertFalse(Regex("""\b(exists|notExists)\b""").containsMatchIn(code))
        // A true answer from these needs a check that worked. Each removal keeps only regular files on top
        // of a listing, so a false answer keeps a file; mkdir answered first, so a false answer fails a write.
        assertEquals(2, Regex("""\bisFile\b""").findAll(code).count())
        assertEquals(2, Regex("""\.filter \{ it\.isFile\b""").findAll(code).count())
        assertEquals(1, Regex("""\bisDirectory\b""").findAll(code).count())
        assertEquals(1, Regex("""!level\.mkdir\(\) && !level\.isDirectory\)""").findAll(code).count())
        // The presence check is asked only where a check that failed cannot pass for an absence: isPresent and
        // syncRemoval, which throw on UNKNOWN, six decisions that need ABSENT (a recovery problem stays; shownGone,
        // for a clear and for a count of nothing; a file a discard permit names holds back; storeDirectories, for a
        // notes-pending that holds no store; a removal check's store folder that cannot be listed, which it never
        // takes for gone; a count's check that its listing holds the counter, where a failed check counts the
        // counter as there), and createDirectory, which makes a level not shown PRESENT and lets mkdir decide.
        assertFalse(Regex("""==\s*Presence\.PRESENT\b|\bPresence\.PRESENT\s*==""").containsMatchIn(code))
        assertEquals(10, Regex("""\bpresenceOf\(""").findAll(code).count())
        assertEquals(2, Regex("""\bwhen \(presenceOf\(""").findAll(code).count())
        assertEquals(4, Regex("""\) != Presence\.ABSENT\b""").findAll(code).count())
        assertEquals(1, Regex("""\?: presence\(root\)\) == Presence\.ABSENT\b""").findAll(code).count())
        assertEquals(1, Regex("""presenceOf\(dir\) == Presence\.ABSENT -> RemovalCheck\.UnlistedAbsent""")
            .findAll(code).count())
        assertEquals(1, Regex("""SEQUENCE !in names && presenceOf\(File\(dir, SEQUENCE\)\) != Presence\.ABSENT""")
            .findAll(code).count())
        assertEquals("no other test for ABSENT", 6, Regex("""[=!]=\s*Presence\.ABSENT\b""").findAll(code).count())
        assertEquals(2, Regex("""\) != Presence\.PRESENT\b""").findAll(code).count())
        // A clear returns only on its own check that the directory is gone, never on what the deletion answered.
        assertEquals(listOf("dir.deleteRecursively()"),
            code.lines().filter { "deleteRecursively" in it }.map { it.trim() })

        // The discard permits decide the same way: no File.exists(), and mkdir answers first.
        val permits = File("src/main/java/io/silentsuite/sync/notes/edit/PendingNotesDiscardPermits.kt").readText()
            .replace(Regex("(?s)/\\*.*?\\*/"), "").replace(Regex("//[^\n]*"), "")
        assertFalse(Regex("""\b(exists|notExists|isFile)\b""").containsMatchIn(permits))
        assertEquals(1, Regex("""\bisDirectory\b""").findAll(permits).count())
        assertEquals(1, Regex("""!level\.mkdir\(\) && !level\.isDirectory\)""").findAll(permits).count())
        assertFalse(Regex("""==\s*(PendingNotesStore\.)?Presence\.PRESENT\b""").containsMatchIn(permits))
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

    // ---- what a removal of the account would lose ----

    /** Every file of [d] with its bytes, read without the store. */
    private fun filesOf(d: File) = d.listFiles()!!.associate { it.name to it.readBytes().toList() }

    /** The names an answer gives the notes [uids]: their entry files'. */
    private fun notes(vararg uids: String): Set<String> = uids.mapTo(HashSet()) { "$it.note" }

    @Test fun `what a store holds is read from its directory alone, and asking changes nothing`() {
        val never = tmp.newFolder("never").also { it.delete() }
        assertEquals(UnsyncedNotes.NOTHING, open(never).unsynced())
        assertFalse("asking does not create the directory", never.exists())
        assertEquals("a store whose directory cannot be listed could not be counted, which is not nothing",
            UnsyncedNotes(0, 0, unreadable = true, listed = false), open(tmp.newFile("plain")).unsynced())
        assertTrue("an answer that could not be counted is not nothing",
            UnsyncedNotes(0, 0, unreadable = true).anything)
        assertFalse(UnsyncedNotes.NOTHING.anything)

        // The notebook copy that comes with the first save is in the directory and is not counted, and
        // neither is the landed record an open editor keeps after a push.
        store.saveLocal("waiting", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.editorOpened("pushed")
        store.saveLocal("pushed", "b1", "r1", blob("p"), isCreate = false)
        val sent = store.beginSend("pushed")!!
        assertEquals(SendOutcome.Done, store.completeSend("pushed", sent.version, "r1", blob("landed")))
        assertTrue(File(dir, "pushed.landed").exists())
        store.saveLocal("held", "b1", "r1", blob("b"), isCreate = false)
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("held", HeldReason.READ_ONLY, now = 5))
        val last = entry("held").version
        assertEquals("a waiting change and held text; the hold did not move the counter",
            UnsyncedNotes(2, last, false, names = notes("waiting", "held")), store.unsynced())

        // Behind the store's back: an entry this build cannot read, an intact first write that never
        // got its name, a first write that was cut short, and an intact uncommitted write beside an entry.
        File(dir, "damaged.note").writeBytes(byteArrayOf(0))
        val complete = PendingEntry("stranded", "b1", PendingEntry.State.UPSERT, 9, "r9", false, blob = blob("c"))
        File(dir, "stranded.note.new").writeBytes(PendingCodec.encodeEntry(complete))
        File(dir, "cut.note.new").writeBytes(PendingCodec.encodeEntry(complete.copy(noteUid = "cut")).copyOf(20))
        File(dir, "waiting.note.new").writeBytes(PendingCodec.encodeEntry(complete.copy(noteUid = "waiting")))
        val before = filesOf(dir)
        // A new instance, as after a restart: any other read of it would run recovery first.
        val fresh = restarted()
        assertEquals("the damaged entry and the intact first write count; the cut one and the leftover do not",
            UnsyncedNotes(4, last, false, names = notes("waiting", "held", "damaged", "stranded")), fresh.unsynced())
        assertEquals("no recovery ran and nothing was written", before, filesOf(dir))
    }

    @Test fun `a store whose last change was pushed holds nothing, and what a failed clear left is counted`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        assertTrue(store.unsynced().anything)
        val sent = store.beginSend("n1")!!
        assertEquals(SendOutcome.Done, store.completeSend("n1", sent.version, "r1", blob("landed")))
        assertEquals("only the counter is left", setOf("sequence"), dir.list()!!.toSet())
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())

        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("t"), isCreate = false))
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("could not clear the pending store") }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        PendingNotesStore.beforeClearForTesting = null
        assertTrue("the failed clear left the files", File(dir, "n2.note").exists())
        assertEquals("a cleared store still answers, from what is on disk",
            UnsyncedNotes(1, v2, false, names = notes("n2")), store.unsynced())
        store.clearAll()
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())
        assertFalse(dir.exists())
    }

    @Test fun `with the counter lost the answer still carries the highest version on disk`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        assertTrue(File(dir, "sequence").delete())
        assertEquals(UnsyncedNotes(2, v2, false, names = notes("n1", "n2")), restarted().unsynced())
        assertFalse("and it does not write the counter back", File(dir, "sequence").exists())

        // A directory named like a first write cannot be read as a file, so the read fails. The answer
        // then is "could not be counted", with every entry file and first write by name, and not "nothing".
        // With the counter lost too, the rebuild meets the same directory, so it carries sequence 0.
        assertTrue(File(dir, "x.note.new").mkdir())
        assertEquals(UnsyncedNotes(3, 0, unreadable = true, names = notes("n1", "n2", "x")), restarted().unsynced())
    }

    @Test fun `a counter that cannot be read, or a lost one that cannot be rebuilt, could not be counted`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        val sequence = File(dir, "sequence")
        assertTrue(sequence.delete() && sequence.mkdir())
        // Carrying the highest sequence this instance handed out.
        assertEquals("a counter file that cannot be read at all",
            UnsyncedNotes(1, v1, unreadable = true, names = notes("n1")), store.unsynced())
        // Counted by its name then, an uncommitted write beside the entry counts as a file of its own, under the
        // name of the same note.
        val beside = File(dir, "n1.note.new").also { it.writeBytes(File(dir, "n1.note").readBytes()) }
        assertEquals(UnsyncedNotes(2, v1, unreadable = true, names = notes("n1")), store.unsynced())
        assertTrue(beside.delete() && sequence.delete())
        // As after a downgrade: with the counter lost, the rebuild meets an entry a newer build wrote, at a
        // version this build cannot read. The highest version it can read would not be above that one.
        val newer = PendingEntry("n2", "b1", PendingEntry.State.UPSERT, 7, "r7", false, blob = blob("by a newer build"))
        File(dir, "n2.note").writeBytes(withFormatVersion(PendingCodec.encodeEntry(newer), 3))
        assertEquals(UnsyncedNotes(2, v1, unreadable = true, names = notes("n1", "n2")), store.unsynced())
        assertFalse("and nothing is written", sequence.exists())
        assertEquals("a new instance has read none", UnsyncedNotes(2, 0, unreadable = true, names = notes("n1", "n2")),
            restarted().unsynced())
    }

    @Test fun `a save between two answers given while the counter cannot be read moves their sequence`() {
        store.saveLocal("n1", "b1", "r1", blob("shown"), isCreate = false)
        val sequence = File(dir, "sequence")
        val counter = sequence.readBytes()
        assertTrue(sequence.delete() && sequence.mkdir())
        val shown = store.unsynced()
        assertTrue(shown.unreadable)
        // The counter reads again, the note is saved over, and the counter fails again: the same note and the
        // same number of files, with text that was never shown.
        assertTrue(sequence.delete())
        sequence.writeBytes(counter)
        store.saveLocal("n1", "b1", "r1", blob("typed after the question"), isCreate = false)
        assertTrue(sequence.delete() && sequence.mkdir())
        val now = store.unsynced()
        assertEquals(shown.copy(sequence = now.sequence), now)
        assertTrue("above the one shown", now.sequence > shown.sequence)
        assertEquals(DiscardOutcome.Changed(now), store.discardStore(shown))
        assertEquals("nothing was deleted", setOf("n1.note", "sequence"), dir.list()!!.toSet())
        assertArrayEquals(blob("typed after the question"), entry("n1").blob)
    }

    @Test fun `a file of a kind this build does not know could not be counted, whether or not the counter reads`() {
        // A newer build may keep text in a file of a kind this one does not know, so it never counts as nothing.
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        File(dir, "n2.draft").writeBytes(blob("kept by a newer build"))
        val before = filesOf(dir)
        assertEquals("beside an entry, with the counter there, and named by its own name",
            UnsyncedNotes(1, v1, unreadable = true, names = notes("n1") + "n2.draft"), store.unsynced())
        assertEquals("and asking changes nothing", before, filesOf(dir))
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed")))
        val alone = setOf("n2.draft")
        assertEquals("on its own", UnsyncedNotes(0, v1, unreadable = true, names = alone), store.unsynced())
        assertTrue(File(dir, "sequence").delete())
        assertEquals("with the counter lost, the rebuild stops at it as well, and the answer keeps what was read",
            UnsyncedNotes(0, v1, unreadable = true, names = alone), store.unsynced())
        // An uncommitted write of an unknown kind, which recovery leaves as it is, and a directory.
        assertTrue(File(dir, "n2.draft").renameTo(File(dir, "n2.draft.new")))
        val next = restarted()
        assertTrue(next.scan().entries.isEmpty())
        assertTrue("recovery left it as it is", File(dir, "n2.draft.new").isFile)
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, names = setOf("n2.draft.new")), next.unsynced())
        assertTrue(File(dir, "n2.draft.new").delete() && File(dir, "attachments").mkdir())
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, names = setOf("attachments")), next.unsynced())
        assertTrue(File(dir, "attachments").delete())
        assertEquals(UnsyncedNotes.NOTHING, next.unsynced())
    }

    @Test fun `an answer that could not be counted carries the sequence, so a save since moves it`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        // A first write that cannot be read: a directory under its name.
        assertTrue(File(dir, "n9.note.new").mkdir())
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(2, v1, unreadable = true, names = notes("n1", "n9")), shown)
        val v2 = saved(store.saveLocal("n1", "b1", "r2", blob("typed after the answer was shown"), isCreate = false))
        assertEquals("the same number of files, at the new sequence",
            UnsyncedNotes(2, v2, unreadable = true, names = notes("n1", "n9")), store.unsynced())
        assertFalse(shown.covers(store.unsynced()))

        // One note pushed and a new one saved leave the number of files as it was; the sequence moves on.
        val again = store.unsynced()
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r2", blob("landed")))
        val v3 = saved(store.saveLocal("n3", "b1", "r1", blob("a new note"), isCreate = false))
        assertEquals(UnsyncedNotes(2, v3, unreadable = true, names = notes("n3", "n9")), store.unsynced())
        assertFalse("one note took the place of another", again.covers(store.unsynced()))
    }

    @Test fun `a store directory that is there but cannot be listed is not counted as nothing, however far up`() {
        // File.exists() answers false for a check that fails as well as for a directory that is not there.
        val root = tmp.newFolder("no_backup")
        val s = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-1"))
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false))
        // The counter file reads without a listing, so the answer carries the sequence still.
        val uncounted = UnsyncedNotes(0, v, unreadable = true, listed = false)
        // The directories each case lists, so that every case is seen to take its own way up.
        val asked = ArrayList<String>()
        fun failing(vararg names: String): (File) -> Array<File>? =
            { d -> asked += d.name; if (d.name in names) null else d.listFiles() }
        PendingNotesStore.listFilesForTesting = failing(s.dir.name)
        assertEquals("the directory above shows it is there", uncounted, s.unsynced())
        assertEquals(listOf(s.dir.name, "notes-pending"), asked)
        asked.clear()
        PendingNotesStore.listFilesForTesting = failing(s.dir.name, "notes-pending")
        assertEquals("the nearest directory above that can be listed shows the one below it", uncounted, s.unsynced())
        assertEquals(listOf(s.dir.name, "notes-pending", "no_backup"), asked)
        PendingNotesStore.listFilesForTesting = { null }
        assertEquals("no directory above can be listed", uncounted, s.unsynced())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("the change was there all along", UnsyncedNotes(1, v, false, names = notes("n1")), s.unsynced())
    }

    @Test fun `a store under directories that were never made counts nothing, and asking makes none of them`() {
        // As for an account that never saved a note on a device where no account did: no notes-pending either.
        val root = tmp.newFolder("no_backup")
        val never = open(PendingNotesStore.identityDir(root, "io.silentsuite", "alice@example.invalid", "gen-1"))
        assertEquals(UnsyncedNotes.NOTHING, never.unsynced())
        assertFalse(File(root, "notes-pending").exists())
        // A listing above that does not show it is no proof while its own check fails: a listing can come back short.
        checksFailFor(never.dir.name)
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, listed = false), never.unsynced())
        assertFalse(File(root, "notes-pending").exists())
    }

    @Test fun `an answer covers the store as it was shown or with less in it, and not after a save`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val shown = store.unsynced()
        assertTrue(shown.covers(store.unsynced()))
        // A change that was pushed meanwhile takes away nothing the user did not see.
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals(UnsyncedNotes(1, shown.sequence, false, names = notes("n2")), store.unsynced())
        assertTrue(shown.covers(store.unsynced()))
        // A save moves the sequence on, also when the count stays the same.
        store.saveLocal("n2", "b1", "r2", blob("typed after the answer was shown"), isCreate = false)
        assertEquals(1, store.unsynced().count)
        assertFalse(shown.covers(store.unsynced()))

        val counted = UnsyncedNotes(2, 7, false)
        assertFalse("one change more than was shown", counted.covers(UnsyncedNotes(3, 7, false)))
        assertFalse("what was counted can no longer be counted", counted.covers(UnsyncedNotes(2, 7, true)))
        assertFalse("a store that holds nothing now carries sequence 0", counted.covers(UnsyncedNotes.NOTHING))
        assertTrue(UnsyncedNotes.NOTHING.covers(UnsyncedNotes.NOTHING))
        // Shown as a store that could not be counted: it covers an answer that again could not be counted,
        // with no higher number of files than was shown, and no counted answer.
        val uncounted = UnsyncedNotes(2, 0, unreadable = true)
        assertTrue(uncounted.covers(uncounted))
        assertTrue("fewer files", uncounted.covers(UnsyncedNotes(1, 0, unreadable = true)))
        assertFalse("a higher number of files than was shown", uncounted.covers(UnsyncedNotes(3, 0, unreadable = true)))
        assertFalse("a store that is counted now", uncounted.covers(UnsyncedNotes(1, 1, false)))
        assertFalse("not even a counted answer that carries sequence 0", uncounted.covers(UnsyncedNotes(1, 0, false)))

        // Nothing it does not name, whatever the number: a listing that came back short may have hidden it.
        val named = UnsyncedNotes(2, 7, false, names = notes("n1", "n2"))
        assertTrue("fewer of the notes it names", named.covers(UnsyncedNotes(1, 7, false, names = notes("n2"))))
        assertFalse("one it does not name", named.covers(UnsyncedNotes(1, 7, false, names = notes("n3"))))
        val other = UnsyncedNotes(1, 7, unreadable = true, names = notes("n1") + "n2.draft")
        assertFalse("nor a file of an unknown kind", other.copy(names = notes("n1")).covers(other))
        // A store that could not be listed and one that lists never cover each other, the same numbers or not.
        val unlisted = UnsyncedNotes(0, 7, unreadable = true, listed = false)
        assertTrue(unlisted.covers(unlisted))
        val listed = unlisted.copy(listed = true)
        assertFalse("an acknowledgement is no confirmation of a listed store", unlisted.covers(listed))
        assertFalse("nor the other way round", listed.covers(unlisted))
    }

    // ---- discarding the whole store ----

    /**
     * A reader of [s]'s permits of its own, as after a restart, where [s] keeps them: beside notes-pending for
     * a store in the app's layout ([identityStore]), otherwise in the default root beside its directory.
     */
    private fun permitsOf(s: PendingNotesStore): PendingNotesDiscardPermits {
        val parent = s.dir.parentFile!!
        val root = if (parent.name == "notes-pending") parent.parentFile!! else parent
        return PendingNotesDiscardPermits(File(root, PendingNotesDiscardPermits.ROOT), {}, atomicMove,
            PendingNotesStore.nioPresence)
    }

    /**
     * A store in the app's layout, opened as forIdentity opens one: notes-pending/<digest> in a no-backup
     * directory of its own, with its permits in notes-discard beside notes-pending. [syncDirectory] syncs for both.
     */
    private fun identityStore(
        noBackup: File = tmp.newFolder("no_backup"),
        creationId: String = "gen-1",
        syncDirectory: (File) -> Unit = {},
    ) = PendingNotesStore.forNoBackup(noBackup, "io.silentsuite", "alice@example.invalid", creationId, syncDirectory,
        atomicMove)

    /**
     * Stand-ins for lstat's inode numbers, which the JVM cannot read on every platform these tests run on: one
     * per directory path, and a new one each time the directory is made again behind the store's back.
     */
    private val inodes = HashMap<String, Long>()
    private var lastInode = 0L

    /** Every directory has an identity of its own, a new one once it is replaced ([replace]); nothing else has one. */
    private fun identifyDirectories() {
        PendingNotesStore.identityForTesting = { d ->
            if (!d.isDirectory) null
            else PendingNotesStore.DirectoryIdentity(device = 7, inode = inodes.getOrPut(d.path) { ++lastInode })
        }
    }

    /** [d] made again under the same path, with the same files in it, as a restore would: another directory. */
    private fun replace(d: File) {
        val away = File(d.parentFile, d.name + "-away")
        assertTrue(d.renameTo(away) && d.mkdir())
        for (file in away.listFiles()!!) assertTrue(file.renameTo(File(d, file.name)))
        assertTrue(away.delete())
        inodes[d.path] = ++lastInode
    }

    /** Every listing of [stores]' own directories fails; the directories above them list. */
    private fun unlisted(vararg stores: PendingNotesStore) {
        val names = stores.map { it.dir.name }
        PendingNotesStore.listFilesForTesting = { d -> if (d.name in names) null else d.listFiles() }
    }

    @Test fun `a discard whose permit cannot be recorded deletes nothing`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false, notebookCopy = blob("key b1"))
        val shown = store.unsynced()
        val before = filesOf(dir)
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record the permit") }
        assertEquals(DiscardOutcome.PermitNotRecorded, store.discardStore(shown))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertEquals("byte for byte", before, filesOf(dir))
        assertNull(permitsOf(store).read(dir.name))
        assertTrue("and no file of one", permitsOf(store).root.list()!!.isEmpty())
        // Stands in for a permit a failed record left on disk, as when taking it back fails as well. This
        // instance withdrew once already, at its first save; the discard attempt makes it withdraw again.
        permitsOf(store).record(dir.name, store.unsynced())
        // As after a restart, a rebase or a conflict copy makes no new version while what it names is there.
        assertThrows(PendingNotesStore.HeldBack::class.java) {
            store.rebase("n1", entry("n1").version, "r1", "r2", blob("rebased"))
        }
        assertThrows(PendingNotesStore.HeldBack::class.java) {
            store.replaceWithNewNote("n1", entry("n1").version, "srv", newNote())
        }
        assertNotNull(permitsOf(store).read(dir.name))
        assertTrue("the store stays open",
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) is SaveOutcome.Saved)
        assertNull("and its next save on the same instance withdraws the permit", permitsOf(store).read(dir.name))

        // A permit that reached the disk before the sync after its rename failed is removed again.
        PendingNotesStore.resetForTesting()
        val root = permitsOf(store).root
        val failing = PendingNotesDiscardPermits(root, syncDirectory = {
            if (it.name == root.name) throw java.io.IOException("sync failed")
        }, rename = atomicMove, presence = PendingNotesStore.nioPresence)
        val s = PendingNotesStore.open(dir, rename = atomicMove, permits = failing)
        val again = filesOf(dir)
        assertEquals(DiscardOutcome.PermitNotRecorded, s.discardStore(s.unsynced()))
        assertEquals(again, filesOf(dir))
        assertNull(permitsOf(s).read(dir.name))
    }

    @Test fun `the permit is on disk before the first file goes, the files go in order, and then the directory`() {
        store.editorOpened("pushed")
        store.saveLocal("pushed", "b1", "r1", blob("p"), isCreate = false, notebookCopy = blob("key b1"))
        val sent = store.beginSend("pushed")!!
        assertEquals(SendOutcome.Done, store.completeSend("pushed", sent.version, "r1", blob("landed")))
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false, notebookCopy = blob("key b2"))
        // A first write that never got its name, behind the store's back.
        val first = PendingEntry("n3", "b1", PendingEntry.State.UPSERT, 1, "r1", false, blob = blob("c"))
        File(dir, "n3.note.new").writeBytes(PendingCodec.encodeEntry(first))
        val shown = store.unsynced()
        assertEquals(3, shown.count)

        PendingNotesStore.beforeClearForTesting = {
            assertThrows("closed before any file goes", IllegalStateException::class.java) { store.read("n1") }
        }
        val removed = ArrayList<String>()
        PendingNotesStore.beforeRemoveForTesting = { file ->
            if (removed.isEmpty() || file.name == "sequence") {
                assertEquals("read back from disk, by a reader of its own", shown, permitsOf(store).read(dir.name))
            }
            removed += file.name
        }
        assertEquals(DiscardOutcome.Done, store.discardStore(shown))
        assertEquals("entries and first writes, landed records, notebook copies, then the counter",
            listOf("n1.note", "n2.note", "n3.note.new", "pushed.landed", "b1.notebook", "b2.notebook", "sequence"),
            removed)
        assertFalse(dir.exists())
        assertNull("the permit went once the directory had", permitsOf(store).read(dir.name))
        assertTrue(permitsOf(store).root.list()!!.isEmpty())
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())
    }

    @Test fun `a discard that stops is finished later under the same permit, also after a restart`() {
        // n1 holds the highest version and goes first. With the counter gone before it, what is left would
        // read at a lower sequence, which the permit no longer covers.
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = store.unsynced()
        var removals = 0
        PendingNotesStore.beforeRemoveForTesting = {
            removals++
            if (it.name == "n2.note") throw java.io.IOException("stopped")
        }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals("it stopped at the second file", 2, removals)
        assertFalse("the first entry went", File(dir, "n1.note").exists())
        assertTrue("the second did not, nor the counter",
            File(dir, "n2.note").exists() && File(dir, "sequence").exists())
        assertEquals("the permit stays", shown, permitsOf(store).read(dir.name))
        assertThrows("closed to every other operation", IllegalStateException::class.java) {
            store.saveLocal("n3", "b1", "r1", blob("late"), isCreate = false)
        }
        // A retry whose record fails keeps the permit that covers what is left, and deletes nothing.
        val remaining = filesOf(dir)
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record the permit") }
        assertEquals(DiscardOutcome.PermitNotRecorded, store.discardStore(shown))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertEquals("the earlier permit stays", shown, permitsOf(store).read(dir.name))
        assertEquals(remaining, filesOf(dir))

        val next = restarted()
        val left = next.unsynced()
        assertEquals(UnsyncedNotes(1, shown.sequence, false, names = notes("n2")), left)
        val permit = permitsOf(next).read(next.dir.name)!!
        assertTrue("what is left is still covered", permit.covers(left))
        assertEquals(DiscardOutcome.Done, next.discardStore(permit))
        assertFalse(dir.exists())
        assertNull(permitsOf(next).read(next.dir.name))
    }

    @Test fun `with a damaged counter, a discard that stops is asked about again and deletes no more`() {
        // A counter that fails its checksum is rebuilt from what is left, which falls as entries go. n1 holds
        // the highest version and goes first. (One in a layout this build does not know is not damage: it
        // stops the rebuild, and the count could not be made.)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val sequence = File(dir, "sequence")
        sequence.writeBytes(sequence.readBytes().also { it[6] = (it[6].toInt() xor 0x40).toByte() })
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(2, 2, false, names = notes("n1", "n2")), shown)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null

        val next = restarted()
        val left = next.unsynced()
        assertEquals("rebuilt from what is left", UnsyncedNotes(1, 1, false, names = notes("n2")), left)
        val permit = permitsOf(next).read(next.dir.name)!!
        assertEquals(shown, permit)
        val before = filesOf(dir)
        assertEquals("the permit no longer covers it", DiscardOutcome.Changed(left), next.discardStore(permit))
        assertEquals("and nothing more was deleted", before, filesOf(dir))
        assertEquals("confirmed again, it finishes", DiscardOutcome.Done, next.discardStore(left))
        assertFalse(dir.exists())
        assertNull(permitsOf(next).read(next.dir.name))
    }

    @Test fun `what a discard that stopped was confirmed for is not sent after a restart, and what its count missed is`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n3", "b1", "r1", blob("missed by the count"), isCreate = false)
        // The count's listing leaves out n3, as a listing that comes back short can.
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "n3.note" }.toTypedArray() else all
        }
        val shown = store.unsynced()
        assertEquals(notes("n1", "n2"), shown.names)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null

        val s = restarted()
        val left = listOf("n1", "n2").filterTo(HashSet()) { File(dir, "$it.note").isFile }
        assertTrue("n2", "n2" in left)
        val before = filesOf(dir)
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n2"))
        assertEquals("n2 is not touched", before, filesOf(dir))
        assertEquals(left, s.snapshot { false }.discardConfirmed)
        assertTrue("what the count missed is sent", s.startSend("n3") is PendingNotesStore.SendStart.Ready)
    }

    @Test fun `a permit holds back what it names until a save withdraws it, and a damaged one holds nothing`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val s = restarted()
        permitsOf(s).record(dir.name, s.unsynced())
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
        // A save withdraws the permit first, and the note is sent again.
        s.saveLocal("n1", "b1", "r2", blob("typed later"), isCreate = false)
        assertNull(permitsOf(s).read(dir.name))
        assertTrue(s.startSend("n1") is PendingNotesStore.SendStart.Ready)

        permitsOf(s).record(dir.name, s.unsynced())
        val next = restarted()
        val permit = File(permitsOf(next).root, "${dir.name}.permit")
        permit.writeBytes(permit.readBytes().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() })
        assertNull("a damaged permit is none", permitsOf(next).read(dir.name))
        assertTrue(next.startSend("n1") is PendingNotesStore.SendStart.Ready)
        assertTrue(next.snapshot { false }.discardConfirmed.isEmpty())
    }

    @Test fun `after a restart, a rebase or a conflict copy writes nothing while what the permit names is there, and a save still withdraws it`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n3", "b1", "r1", blob("missed by the count"), isCreate = false)
        // As in the test of what a discard that stopped was confirmed for, after a restart: the count's listing
        // leaves out n3, and the discard stops at n2.note.
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "n3.note" }.toTypedArray() else all
        }
        val shown = store.unsynced()
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null

        val s = restarted()
        val v3 = s.entry("n3").version
        val before = filesOf(dir)
        // A new version would withdraw the permit, and n2, whose discard the user confirmed, would then be sent.
        assertThrows("a rebase", PendingNotesStore.HeldBack::class.java) {
            s.rebase("n3", v3, "r1", "r2", blob("rebased"))
        }
        assertThrows("a conflict copy", PendingNotesStore.HeldBack::class.java) {
            s.replaceWithNewNote("n3", v3, "srv", newNote())
        }
        assertEquals("nothing was written, the counter included", before, filesOf(dir))
        assertEquals("the permit stays", shown, permitsOf(s).read(dir.name))
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n2"))
        // A save, of any note, still withdraws the permit, and what it named is sent again.
        s.saveLocal("n3", "b1", "r3", blob("typed later"), isCreate = false)
        assertNull(permitsOf(s).read(dir.name))
        assertTrue(s.startSend("n2") is PendingNotesStore.SendStart.Ready)
        // Once the instance has shown the permit gone, a rebase does not read it again.
        var reads = 0
        PendingNotesDiscardPermits.onReadForTesting = { if (it.name.endsWith(".permit")) reads++ }
        assertTrue(s.rebase("n3", s.entry("n3").version, "r3", "r4", blob("rebased")))
        assertEquals("no permit read", 0, reads)
    }

    @Test fun `a permit's names count as there unless shown absent, and a permit of names that are gone, or a damaged one, holds nothing back`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        // As after a restart, with the permit of a discard that has not finished.
        fun permitFor(vararg names: String): PendingNotesStore = restarted().also {
            permitsOf(it).record(dir.name, UnsyncedNotes(names.size, 1, false, names = names.toSet()))
        }
        fun rebased(s: PendingNotesStore) = s.rebase("n1", s.entry("n1").version, "r1", "r2", blob("rebased"))

        var s = permitFor("gone.note")
        checksFailFor("gone.note")
        assertTrue("its check fails", s.snapshot { false }.discardUnfinished)
        assertThrows(PendingNotesStore.HeldBack::class.java) { rebased(s) }
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == "gone.note.new") PendingNotesStore.Presence.PRESENT else null
        }
        assertTrue("a first write beside it", s.snapshot { false }.discardUnfinished)
        assertThrows(PendingNotesStore.HeldBack::class.java) { rebased(s) }

        // A name that is not one file name in the store counts as there, and is never looked up.
        val asked = ArrayList<String>()
        PendingNotesStore.presenceForTesting = { f -> asked += f.path; null }
        for (odd in listOf("../outside.note", "x/y", "", ".", "..", "a\u0000b")) {
            s = permitFor(odd)
            asked.clear()
            assertTrue(odd, s.snapshot { false }.discardUnfinished)
            assertThrows(odd, PendingNotesStore.HeldBack::class.java) { rebased(s) }
            assertTrue("$odd is not looked up: $asked",
                File(dir, odd).path !in asked && File(dir, odd + ".new").path !in asked)
        }

        // Nor is anything looked up through a folder whose lstat cannot tell: the store refuses it first.
        s = permitFor("gone.note")
        PendingNotesStore.linkForTesting = { null }
        asked.clear()
        assertThrows("lstat cannot tell", java.io.IOException::class.java) { s.snapshot { false } }
        assertThrows(java.io.IOException::class.java) { rebased(s) }
        assertEquals("nothing was asked", emptyList<String>(), asked)
        PendingNotesStore.linkForTesting = null
        PendingNotesStore.presenceForTesting = null

        // A permit that names only what is shown gone holds nothing back, and the rebase withdraws it.
        s = permitFor("gone.note")
        assertFalse(s.snapshot { false }.discardUnfinished)
        assertTrue(rebased(s))
        assertNull(permitsOf(s).read(dir.name))

        // Nor does a damaged one, which the rebase removes.
        s = permitFor("n1.note")
        assertThrows("n1 is named and there", PendingNotesStore.HeldBack::class.java) { rebased(s) }
        val permit = File(permitsOf(s).root, "${dir.name}.permit")
        permit.writeBytes(permit.readBytes().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() })
        s = restarted()
        assertFalse(s.snapshot { false }.discardUnfinished)
        assertTrue(rebased(s))
        assertFalse("the damaged permit is gone", permit.exists())
    }

    /** Every read of a discard permit fails, as a read of a file that is there can (EIO, EACCES, EMFILE). */
    private fun permitReadsFail() {
        PendingNotesDiscardPermits.onReadForTesting = {
            if (it.name.endsWith(".permit")) throw java.io.IOException("the read fails")
        }
    }

    @Test fun `a permit that is there but cannot be read holds back every note, until a save withdraws it, and so does the permit a sign-out records in its place`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val permit = File(permitsOf(store).root, "${dir.name}.permit")
        var s = restarted()
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = notes("n1")))
        permitReadsFail()
        assertEquals(PendingNotesDiscardPermits.Lookup.Unknown, permitsOf(s).lookup(dir.name))
        assertNull(permitsOf(s).read(dir.name))
        for (uid in listOf("n1", "n2")) {
            assertEquals(uid, PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED),
                s.startSend(uid))
        }
        val waiting = s.snapshot { false }
        assertEquals("every note counts as confirmed", setOf("n1", "n2"), waiting.discardConfirmed)
        assertTrue(waiting.discardUnfinished)
        val before = filesOf(dir)
        assertThrows("a rebase", PendingNotesStore.HeldBack::class.java) {
            s.rebase("n2", s.entry("n2").version, "r1", "r2", blob("rebased"))
        }
        assertThrows("a conflict copy", PendingNotesStore.HeldBack::class.java) {
            s.replaceWithNewNote("n2", s.entry("n2").version, "srv", newNote())
        }
        assertEquals("nothing was written", before, filesOf(dir))
        assertTrue("and the permit stays", permit.isFile)
        // A save, of any note, removes it unread, and the notes are sent again.
        assertTrue(s.saveLocal("n3", "b1", "r1", blob("typed later"), isCreate = false) is SaveOutcome.Saved)
        assertFalse("the permit is gone", permit.exists())
        assertTrue(s.startSend("n1") is PendingNotesStore.SendStart.Ready)

        // After a restart, a sign-out records its own permit in place of one it cannot read, and goes on. It names
        // what the count and the confirmation name, and not p0, which only the permit it could not read named. It is
        // recorded as for an answer that could not be counted, since the one it could not read may have been for such
        // an answer, so it holds back every note too.
        PendingNotesDiscardPermits.onReadForTesting = null
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 2, false, names = notes("n1", "p0")))
        s = restarted()
        permitReadsFail()
        val shown = s.unsynced()
        assertEquals(notes("n1", "n2", "n3"), shown.names)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
        assertEquals("the count and the confirmation, and nothing more, as for an answer that could not be counted",
            shown.copy(unreadable = true), permitsOf(s).read(dir.name))

        // And a sign-out over a permit it cannot read finishes, and removes it.
        s = restarted()
        permitReadsFail()
        assertEquals(DiscardOutcome.Done, s.discardStore(s.unsynced()))
        assertFalse("the permit went with the store", permit.exists())
    }

    @Test fun `a permit for an answer that could not be counted holds back every note, one its count's listing missed included, until a save withdraws it`() {
        val v1 = saved(store.saveLocal("n1", "b1", "r1", blob("missed by the count"), isCreate = false))
        store.putNotebook("b9", blob("key b9"))
        // A file of a kind this build does not know, so the store cannot be counted, and a count's listing that
        // leaves out n1, as a listing that comes back short can.
        File(dir, "x.draft").writeBytes(blob("kept by a newer build"))
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "n1.note" }.toTypedArray() else all
        }
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(0, v1, unreadable = true, names = setOf("x.draft")), shown)
        // The user confirms the discard of all of it, and the discard stops before anything goes.
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeClearForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertEquals("the permit names only what the count's listing held", shown, permitsOf(store).read(dir.name))

        // After a restart, with the listing whole, n1 is not sent, though the permit does not name it.
        val s = restarted()
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
        val waiting = s.snapshot { false }
        assertEquals("every note counts as confirmed", setOf("n1"), waiting.discardConfirmed)
        assertTrue(waiting.discardUnfinished)
        // With the file the permit names gone, the rule alone holds back: a run records no success, a rebase writes
        // nothing, and no notebook copy is pruned.
        assertTrue(File(dir, "x.draft").delete())
        assertTrue(s.snapshot { false }.discardUnfinished)
        assertThrows(PendingNotesStore.HeldBack::class.java) {
            s.rebase("n1", s.entry("n1").version, "r1", "r2", blob("rebased"))
        }
        assertEquals(emptyList<String>(), s.pruneNotebooks())
        // A save, of any note, withdraws the permit, and n1 is sent again.
        assertTrue(s.saveLocal("n2", "b1", "r1", blob("typed later"), isCreate = false) is SaveOutcome.Saved)
        assertNull(permitsOf(s).read(dir.name))
        assertTrue(s.startSend("n1") is PendingNotesStore.SendStart.Ready)
    }

    @Test fun `a sign-out confirmed for a counted answer in place of a permit for one that could not be counted still holds back every note, until a save withdraws it`() {
        store.saveLocal("n1", "b1", "r1", blob("missed by every count"), isCreate = false)
        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("counted"), isCreate = false))
        // A file of a kind this build does not know, so the store cannot be counted, and listings that leave out n1,
        // as a listing that comes back short can.
        File(dir, "x.draft").writeBytes(blob("kept by a newer build"))
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "n1.note" }.toTypedArray() else all
        }
        val uncounted = store.unsynced()
        assertEquals(UnsyncedNotes(1, v2, unreadable = true, names = setOf("n2.note", "x.draft")), uncounted)
        // The user confirms the discard of all of it, and the discard stops before anything goes.
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(uncounted))

        // After a restart, with the file of an unknown kind gone, the store is counted, though the listing still
        // leaves out n1, and a sign-out confirmed for that count stops as well.
        assertTrue(File(dir, "x.draft").delete())
        var s = restarted()
        val counted = s.unsynced()
        assertEquals(UnsyncedNotes(1, v2, unreadable = false, names = notes("n2")), counted)
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(counted))
        PendingNotesStore.beforeClearForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertEquals("its permit does not name n1", setOf("n2.note", "x.draft"), permitsOf(s).read(dir.name)!!.names)

        // After another restart, with the listing whole, n1 is still not sent.
        s = restarted()
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
        val waiting = s.snapshot { false }
        assertEquals("every note counts as confirmed", setOf("n1", "n2"), waiting.discardConfirmed)
        assertTrue(waiting.discardUnfinished)
        // A save, of any note, withdraws the permit, and n1 is sent again.
        assertTrue(s.saveLocal("n3", "b1", "r1", blob("typed later"), isCreate = false) is SaveOutcome.Saved)
        assertNull(permitsOf(s).read(dir.name))
        assertTrue(s.startSend("n1") is PendingNotesStore.SendStart.Ready)
    }

    @Test fun `once a save has withdrawn the permit, a check of its path that keeps failing holds nothing back, until a sign-out has it read again`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.putNotebook("b9", blob("key b9"))
        val s = restarted()
        permitsOf(s).record(dir.name, UnsyncedNotes(1, 1, false, names = notes("n1")))
        // A save withdraws the permit, and from then on every check of its path fails.
        assertTrue(s.saveLocal("n1", "b1", "r2", blob("typed later"), isCreate = false) is SaveOutcome.Saved)
        val permit = File(permitsOf(s).root, "${dir.name}.permit")
        assertFalse(permit.exists())
        checksFailFor(permit.name)
        assertEquals(PendingNotesDiscardPermits.Lookup.Unknown, permitsOf(s).lookup(dir.name))
        assertTrue(s.startSend("n1") is PendingNotesStore.SendStart.Ready)
        assertFalse(s.snapshot { false }.discardUnfinished)
        assertEquals("the prune runs", listOf("b9"), s.pruneNotebooks())

        // A sign-out that stops has the instance read the permit again, and the hold-back holds once more.
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record the permit") }
        assertEquals(DiscardOutcome.PermitNotRecorded, s.discardStore(s.unsynced()))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n1"))
        assertTrue(s.snapshot { false }.discardUnfinished)
    }

    @Test fun `a sign-out whose permit cannot be recorded keeps a permit from before that cannot be read, and what it names stays held back`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        val permit = File(permitsOf(store).root, "${dir.name}.permit")
        assertEquals(notes("n1", "n2"), permitsOf(store).read(dir.name)!!.names)
        val recorded = permit.readBytes()

        // After a restart, that permit cannot be read, and a new one cannot be recorded.
        val s = restarted()
        val before = filesOf(dir)
        permitReadsFail()
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record the permit") }
        assertEquals(DiscardOutcome.PermitNotRecorded, s.discardStore(s.unsynced()))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertArrayEquals("the permit from before stays, byte for byte", recorded, permit.readBytes())
        assertEquals("and nothing was deleted", before, filesOf(dir))
        // The instance stays open, and holds back what it cannot read.
        for (uid in listOf("n1", "n2")) {
            assertEquals(uid, PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED),
                s.startSend(uid))
        }
        // Once it reads again, after another restart, it holds back what it names.
        PendingNotesDiscardPermits.onReadForTesting = null
        val next = restarted()
        for (uid in listOf("n1", "n2")) {
            assertEquals(uid, PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED),
                next.startSend(uid))
        }
    }

    /** The presence check of [dir]'s counter answers absent, as for a lost counter; every other check is real. */
    private fun counterShownGone() {
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == "sequence" && f.parentFile?.name == dir.name) PendingNotesStore.Presence.ABSENT else null
        }
    }

    @Test fun `a listing that comes back short does not hide what a stopped discard left, after a restart or on the closed instance`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        // A listing of the store that comes back with nothing, and says nothing. Its counter is there by path, so the
        // closed instance could not count it.
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) emptyArray() else d.listFiles() }
        assertTrue("could not be counted", store.unsynced().let { it.unreadable && it.listed && it.names.isEmpty() })
        // With the counter shown gone as well, as for a lost one, the count finds nothing, and the state still decides.
        counterShownGone()
        assertEquals("the closed instance counts nothing", UnsyncedNotes.NOTHING, store.unsynced())
        assertFalse("but its discard did not finish", store.clearedInFull())
        PendingNotesStore.presenceForTesting = null

        val s = restarted()
        val short = s.snapshot { false }
        assertTrue("nothing listed", short.headers.isEmpty() && short.discardConfirmed.isEmpty())
        assertTrue("and what the permit names is there all the same", short.discardUnfinished)
        PendingNotesStore.listFilesForTesting = null
        val listed = s.snapshot { false }
        assertEquals(setOf("n2"), listed.discardConfirmed)
        assertTrue(listed.discardUnfinished)
        // Another confirmed sign-out finishes the clear, and then nothing is left.
        assertEquals(DiscardOutcome.Done, s.discardStore(permitsOf(s).read(dir.name)))
        assertTrue(s.clearedInFull())
        s.unregister()
        assertTrue("also once it is dropped", s.clearedInFull())
    }

    @Test fun `a discard or a clear that stopped is told by the instance's state, not by its count`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val shown = store.unsynced()
        assertFalse("open", store.clearStopped())
        assertTrue(store.discardStore(UnsyncedNotes.NOTHING) is DiscardOutcome.Changed)
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record the permit") }
        assertEquals(DiscardOutcome.PermitNotRecorded, store.discardStore(shown))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertFalse("nothing was deleted, and the instance stays open", store.clearStopped())
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue("it got as far as deleting", store.clearStopped())
        assertFalse(store.clearedInFull())
        // Also while a listing of the store comes back with nothing: with its counter there by path, the closed
        // instance could not count it, and with the counter shown gone as well, as for a lost one, it counts
        // nothing.
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == dir.name) emptyArray() else d.listFiles() }
        assertTrue(store.unsynced().let { it.unreadable && it.listed })
        assertTrue(store.clearStopped())
        counterShownGone()
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())
        assertTrue(store.clearStopped())
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.listFilesForTesting = null
        // A call that asks again leaves it so; one that finishes ends it.
        assertTrue(store.discardStore(UnsyncedNotes.NOTHING) is DiscardOutcome.Changed)
        assertTrue(store.clearStopped())
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        assertFalse(store.clearStopped())
        assertTrue(store.clearedInFull())
        store.unregister()
        assertFalse("dropped", store.clearStopped())

        // A clear that stops before it deletes anything has closed the instance as well; one that returns finished.
        val other = open(tmp.newFolder("other"))
        other.saveLocal("n1", "b1", "r1", blob("c"), isCreate = false)
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("stopped") }
        assertThrows(java.io.IOException::class.java) { other.clearAll() }
        PendingNotesStore.beforeClearForTesting = null
        assertTrue(other.clearStopped())
        PendingNotesStore.resetForTesting()
        assertFalse("a new instance, as after a restart, starts with none", open(other.dir).clearStopped())
        other.clearAll()
        assertFalse(other.clearStopped())
        assertTrue(other.clearedInFull())
    }

    @Test fun `unregisterIfFinishedOnce drops only an instance that one discard alone finished`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        assertFalse("nothing finished it", store.unregisterIfFinishedOnce())
        assertSame(store, open(dir))
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        // Another call finishes it as well, over the folder that is gone, as the sign-out's can before or after a
        // Settings Retry: it stays, closed, so a late save is refused and does not bring the folder back.
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        assertFalse(store.unregisterIfFinishedOnce())
        assertSame(store, open(dir))
        assertThrows(PendingNotesStore.Cleared::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false)
        }
        assertFalse(dir.name in tmp.root.list()!!.toSet())

        val once = open(tmp.newFolder("once"))
        once.saveLocal("n1", "b1", "r1", blob("b"), isCreate = false)
        assertEquals(DiscardOutcome.Done, once.discardStore(once.unsynced()))
        assertTrue(once.unregisterIfFinishedOnce())
        assertNotSame(once, open(once.dir))
        assertFalse("a second call does nothing", once.unregisterIfFinishedOnce())

        val cleared = open(tmp.newFolder("cleared"))
        cleared.clearAll()
        assertEquals(DiscardOutcome.Done, cleared.discardStore(cleared.unsynced()))
        assertFalse("a clear finished it as well", cleared.unregisterIfFinishedOnce())
        assertSame(cleared, open(cleared.dir))
    }

    @Test fun `stoppedIn names the store folders whose discard stopped in this process, from memory alone`() {
        val noBackup = tmp.newFolder("no_backup")
        var failAbove = false
        val gone = identityStore(noBackup, "gen-1") { d ->
            if (failAbove && d.name == "notes-pending") throw java.io.IOException("could not sync notes-pending")
        }
        val partway = identityStore(noBackup, "gen-2")
        val finished = identityStore(noBackup, "gen-3")
        // The same account's store in another no_backup folder: another root, whose folder has the same name.
        val elsewhere = identityStore(tmp.newFolder("elsewhere"), "gen-1")
        for (s in listOf(gone, partway, finished, elsewhere)) s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        assertEquals(emptyList<String>(), PendingNotesStore.stoppedIn(noBackup))
        // One stops once its folder is gone, at the sync of the folder above; two stop partway; one finishes.
        failAbove = true
        assertEquals(DiscardOutcome.NotFinished, gone.discardStore(gone.unsynced()))
        failAbove = false
        PendingNotesStore.beforeRemoveForTesting = {
            if (it.parentFile == partway.dir || it.parentFile == elsewhere.dir) throw java.io.IOException("stopped")
        }
        assertEquals(DiscardOutcome.NotFinished, partway.discardStore(partway.unsynced()))
        assertEquals(DiscardOutcome.NotFinished, elsewhere.discardStore(elsewhere.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(DiscardOutcome.Done, finished.discardStore(finished.unsynced()))
        assertFalse("no listing holds it", gone.dir.name in PendingNotesStore.storeDirectories(noBackup).stores)
        assertEquals(listOf(gone.dir.name, partway.dir.name).sorted(), PendingNotesStore.stoppedIn(noBackup))
        // Once its discard finishes, it is no longer named, and after a restart none is.
        assertEquals(DiscardOutcome.Done, gone.discardStore(gone.unsynced()))
        assertEquals(listOf(partway.dir.name), PendingNotesStore.stoppedIn(noBackup))
        PendingNotesStore.resetForTesting()
        assertEquals(emptyList<String>(), PendingNotesStore.stoppedIn(noBackup))
    }

    /**
     * After a restart, [confirmed], text the user confirmed for a discard that stopped, is held back though a count
     * whose listing left it out recorded the permit: it is not sent, a run records no success, and [unnamed], which
     * no count named, is not rebased.
     */
    private fun assertHeldBackAfterRestart(confirmed: String, unnamed: String) {
        val s = restarted()
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED),
            s.startSend(confirmed))
        assertTrue(s.snapshot { false }.discardUnfinished)
        assertThrows(PendingNotesStore.HeldBack::class.java) {
            s.rebase(unnamed, s.entry(unnamed).version, "r1", "r2", blob("rebased"))
        }
    }

    @Test fun `a sign-out whose recount comes back short still holds back what its confirmation named`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n3", "b1", "r1", blob("missed by every count"), isCreate = false)
        var hidden = setOf("n3.note")
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name !in hidden }.toTypedArray() else all
        }
        val shown = store.unsynced()
        assertEquals(notes("n1", "n2"), shown.names)
        // The recount leaves out n2 as well, until the removal of n1.note starts, so the discard's second listing
        // shows n2 and n3, and the discard stops there.
        hidden = setOf("n2.note", "n3.note")
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") hidden = emptySet() }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertEquals("n1 went, n2 and n3 stayed", notes("n2", "n3"),
            dir.list()!!.filterTo(HashSet()) { it.endsWith(".note") })
        assertEquals("the permit names n2 all the same", notes("n1", "n2"), permitsOf(store).read(dir.name)!!.names)
        assertHeldBackAfterRestart("n2", unnamed = "n3")
    }

    @Test fun `a second sign-out whose count comes back short still holds back what the first one's permit names`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        store.saveLocal("n3", "b1", "r1", blob("missed by every count"), isCreate = false)
        var hidden = setOf("n3.note")
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name !in hidden }.toTypedArray() else all
        }
        // The first sign-out stops before anything goes, with a permit for n1 and n2.
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        assertEquals(notes("n1", "n2"), permitsOf(store).read(dir.name)!!.names)

        // After a restart, a second sign-out whose count and recount leave out n2 as well, until the removal of
        // n1.note starts: the user is shown n1 alone, and the discard stops at its second listing.
        val s = restarted()
        hidden = setOf("n2.note", "n3.note")
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") hidden = emptySet() }
        val shown = s.unsynced()
        assertEquals(notes("n1"), shown.names)
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertFalse(File(dir, "n1.note").exists())
        assertEquals("the permit still names n2", notes("n1", "n2"), permitsOf(s).read(dir.name)!!.names)
        assertHeldBackAfterRestart("n2", unnamed = "n3")
    }

    @Test fun `a discard that meets more than was shown gives Changed, and writes and deletes nothing`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = store.unsynced()
        store.saveLocal("n1", "b1", "r2", blob("typed after the answer was shown"), isCreate = false)
        val now = store.unsynced()
        val before = filesOf(dir)
        assertEquals(DiscardOutcome.Changed(now), store.discardStore(shown))
        assertEquals("nothing was shown", DiscardOutcome.Changed(now), store.discardStore(null))
        assertEquals(before, filesOf(dir))
        assertNull("no permit", permitsOf(store).read(dir.name))
        assertTrue("the store stays open",
            store.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) is SaveOutcome.Saved)

        // A permit a save withdrew covers nothing, so its answer gives Changed too.
        val s = restarted()
        permitsOf(s).record(dir.name, s.unsynced())
        val permit = permitsOf(s).read(dir.name)!!
        s.saveLocal("n2", "b1", "r2", blob("typed later"), isCreate = false)
        assertNull(permitsOf(s).read(dir.name))
        assertEquals(DiscardOutcome.Changed(s.unsynced()), s.discardStore(permit))

        // A store that holds nothing unsynced needs no confirmation, and records no permit, so a permit root
        // that fails does not hold it up.
        val clean = open(tmp.newFolder("clean"))
        clean.putNotebook("b1", blob("key b1"))
        var records = 0
        PendingNotesDiscardPermits.beforeRecordForTesting = { records++; throw java.io.IOException("the root fails") }
        assertEquals(DiscardOutcome.Done, clean.discardStore(null))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertEquals("no permit was recorded", 0, records)
        assertFalse(clean.dir.exists())
    }

    @Test fun `a discard confirmed for a store that could not be counted still sees a save since`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        // A first write that cannot be read: a directory under its name.
        val stranded = File(dir, "n9.note.new").also { assertTrue(it.mkdir()) }
        fun files() = dir.listFiles()!!.filter { it.isFile }.associate { it.name to it.readBytes().toList() }
        val shown = store.unsynced()
        assertTrue(shown.unreadable)
        store.saveLocal("n1", "b1", "r2", blob("typed after the answer was shown"), isCreate = false)
        val before = files()
        assertEquals(DiscardOutcome.Changed(store.unsynced()), store.discardStore(shown))
        assertEquals("byte for byte", before, files())
        assertTrue(stranded.isDirectory)
        assertNull("no permit", permitsOf(store).read(dir.name))

        // The same with one note pushed and a new one saved, which leaves the number of files as it was.
        val again = store.unsynced()
        assertEquals(SendOutcome.Done, store.completeSend("n1", store.beginSend("n1")!!.version, "r2", blob("landed")))
        store.saveLocal("n3", "b1", "r1", blob("a new note"), isCreate = false)
        assertEquals(again.count, store.unsynced().count)
        val after = files()
        assertEquals(DiscardOutcome.Changed(store.unsynced()), store.discardStore(again))
        assertEquals(after, files())
        assertTrue(stranded.isDirectory)
        assertNull(permitsOf(store).read(dir.name))
    }

    @Test fun `a save that holds the lock first is seen as Changed, and a save after the discard is refused`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = store.unsynced()
        val inSave = java.util.concurrent.CountDownLatch(1)
        val finishSave = java.util.concurrent.CountDownLatch(1)
        // The save stops at its first rename, the counter's, while it holds the lock: nothing it writes is
        // counted on disk yet, so only a count taken under the lock sees it.
        PendingNotesStore.beforeRenameForTesting = { target ->
            if (target.name == "sequence" && inSave.count > 0) {
                inSave.countDown()
                finishSave.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        var saved: SaveOutcome? = null
        val saving = kotlin.concurrent.thread {
            saved = store.saveLocal("n2", "b1", "r1", blob("typed while the question was open"), isCreate = false)
        }
        var outcome: DiscardOutcome? = null
        var discarding: Thread? = null
        try {
            assertTrue(inSave.await(10, java.util.concurrent.TimeUnit.SECONDS))
            val thread = kotlin.concurrent.thread { outcome = store.discardStore(shown) }
            discarding = thread
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
            while (thread.state != Thread.State.BLOCKED) {
                assertTrue("the discard waits for the lock the save holds", System.nanoTime() < deadline)
                Thread.sleep(1)
            }
        } finally {
            // On every path, so that neither thread outlives this test and meets the next one's seams.
            finishSave.countDown()
            saving.join(10_000)
            discarding?.join(10_000)
            PendingNotesStore.beforeRenameForTesting = null
        }
        assertTrue(saved is SaveOutcome.Saved)
        assertEquals(DiscardOutcome.Changed(store.unsynced()), outcome)
        assertEquals(2, store.unsynced().count)
        assertNull(permitsOf(store).read(dir.name))

        // Confirmed again, it goes through, and a save after it is refused.
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        assertThrows(IllegalStateException::class.java) {
            store.saveLocal("n3", "b1", "r1", blob("late"), isCreate = false)
        }
        assertFalse("nothing was written back", dir.exists())
    }

    @Test fun `a discard that cannot show the directory gone is not finished, and keeps its permit`() {
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = s.unsynced()
        // Every file goes, but notes-pending cannot be listed, so the directory's going cannot be shown.
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-pending") null else d.listFiles() }
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        assertFalse("the files and the directory went", s.dir.exists())
        assertEquals("the permit stays", shown, permitsOf(s).read(s.dir.name))
        assertEquals("a later call finishes", DiscardOutcome.Done, s.discardStore(null))
        assertNull(permitsOf(s).read(s.dir.name))

        // Nor while the directory's own check fails, though the listing above no longer shows it.
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val counted = store.unsynced()
        checksFailFor(dir.name)
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(counted))
        PendingNotesStore.presenceForTesting = null
        assertFalse(dir.exists())
        assertEquals("the permit stays", counted, permitsOf(store).read(dir.name))
        assertEquals(DiscardOutcome.Done, store.discardStore(null))
        assertNull(permitsOf(store).read(dir.name))
    }

    /** Each directory sync asked, by the directory's name, and each removal of a discard permit, in order. */
    private val steps = ArrayList<String>()

    /** Whether a sync of notes-pending, the directory that holds a store in the app's layout, fails. */
    private var parentSyncFails = false

    /**
     * A sync for [identityStore] that records each one in [steps]. It fails for a directory that is not there, as
     * fsync(2)'s open does on a device, and for notes-pending while [parentSyncFails].
     */
    private val recordingSync: (File) -> Unit = { d ->
        steps += "sync ${d.name}"
        if (!d.isDirectory) throw java.io.IOException("${d.name} is not there")
        if (parentSyncFails && d.name == "notes-pending") throw java.io.IOException("the sync fails")
    }

    /** Records each removal of a discard permit in [steps], before it. */
    private fun recordPermitRemovals() {
        PendingNotesDiscardPermits.beforeDeleteForTesting = { f ->
            if (f.name.endsWith(".permit")) steps += "remove permit"
        }
    }

    @Test fun `a discard whose removal of the directory is not synced is not finished, and keeps its permit`() {
        val s = identityStore(syncDirectory = recordingSync)
        s.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)
        val shown = s.unsynced()
        val permit = File(permitsOf(s).root, s.dir.name + ".permit")
        val recorded = PendingCodec.encodePermit(s.dir.name, shown)
        recordPermitRemovals()
        parentSyncFails = true
        steps.clear()
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        assertFalse("the directory went", s.dir.exists())
        assertEquals("its removal is not synced", "sync notes-pending", steps.last())
        assertFalse("and the permit was not removed", "remove permit" in steps)
        assertArrayEquals("the permit stays, byte for byte", recorded, permit.readBytes())
        assertThrows("nor is the instance dropped", IllegalStateException::class.java) { s.unregister() }

        // A retry finds the directory gone and removes nothing. It is not finished while the sync still fails.
        val kept = permitsOf(s).read(s.dir.name)!!
        steps.clear()
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(kept))
        assertEquals(listOf("sync notes-pending"), steps)
        assertArrayEquals(recorded, permit.readBytes())
        parentSyncFails = false
        steps.clear()
        assertEquals(DiscardOutcome.Done, s.discardStore(kept))
        assertEquals("the removal is synced before the permit goes",
            listOf("sync notes-pending", "remove permit", "sync notes-discard"), steps)
        assertFalse(permit.exists())
        s.unregister()
    }

    @Test fun `after a restart, a discard that finds the directory gone syncs its removal before the permit goes`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup, syncDirectory = recordingSync)
        s.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)
        val shown = s.unsynced()
        val permit = File(permitsOf(s).root, s.dir.name + ".permit")
        val recorded = PendingCodec.encodePermit(s.dir.name, shown)
        parentSyncFails = true
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        assertFalse(s.dir.exists())
        assertEquals("the permit stays", shown, permitsOf(s).read(s.dir.name))

        // New instances, as after a restart, go on under the permit on disk. Each lists first, which withdraws the
        // store's acknowledgement and syncs notes-discard.
        recordPermitRemovals()
        PendingNotesStore.resetForTesting()
        val next = identityStore(noBackup, syncDirectory = recordingSync)
        val kept = permitsOf(next).read(next.dir.name)!!
        assertEquals(shown, kept)
        steps.clear()
        assertEquals("while the sync still fails", DiscardOutcome.NotFinished, next.discardStore(kept))
        assertEquals(listOf("sync notes-discard", "sync notes-pending"), steps)
        assertArrayEquals("the permit stays, byte for byte", recorded, permit.readBytes())

        parentSyncFails = false
        PendingNotesStore.resetForTesting()
        val last = identityStore(noBackup, syncDirectory = recordingSync)
        steps.clear()
        assertEquals(DiscardOutcome.Done, last.discardStore(kept))
        assertEquals("the removal is synced before the permit goes",
            listOf("sync notes-discard", "sync notes-pending", "remove permit", "sync notes-discard"), steps)
        assertFalse(permit.exists())
        assertFalse(last.dir.exists())
    }

    @Test fun `after a restart, a save syncs the removal of a discarded directory before its permit goes`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup, syncDirectory = recordingSync)
        s.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)
        val shown = s.unsynced()
        val permit = File(permitsOf(s).root, s.dir.name + ".permit")
        val recorded = PendingCodec.encodePermit(s.dir.name, shown)
        parentSyncFails = true
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        assertFalse(s.dir.exists())

        // A new instance, as after a restart, takes a save before any retry of the discard. Its first new version
        // retires the permit, and that waits until the removal of the old directory is synced.
        recordPermitRemovals()
        PendingNotesStore.resetForTesting()
        val next = identityStore(noBackup, syncDirectory = recordingSync)
        steps.clear()
        assertThrows("while the sync fails, the save fails", java.io.IOException::class.java) {
            next.saveLocal("n2", "b1", "r1", blob("new"), isCreate = false)
        }
        assertFalse("and the permit was not removed", "remove permit" in steps)
        assertArrayEquals("it stays, byte for byte", recorded, permit.readBytes())
        parentSyncFails = false
        steps.clear()
        next.saveLocal("n2", "b1", "r1", blob("new"), isCreate = false)
        assertTrue("the removal is synced before the permit goes: $steps",
            steps.indexOf("sync notes-pending") in 0 until steps.indexOf("remove permit"))
        assertFalse(permit.exists())
    }

    @Test fun `after a restart, a rebase once what the permit names is gone syncs the store's directory before the permit goes`() {
        val noBackup = tmp.newFolder("no_backup")
        // Records each sync, and fails the store directory's own while storeSyncFails.
        var storeSyncFails = false
        val sync: (File) -> Unit = { d ->
            steps += "sync ${d.name}"
            if (storeSyncFails && d.parentFile?.name == "notes-pending") throw java.io.IOException("the sync fails")
        }
        val s = identityStore(noBackup, syncDirectory = sync)
        s.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)
        s.saveLocal("n3", "b1", "r1", blob("missed by the count"), isCreate = false)
        // The count's listing leaves out n3. The discard removes n1.note and stops at the sync of that removal.
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d == s.dir) all.filter { it.name != "n3.note" }.toTypedArray() else all
        }
        val shown = s.unsynced()
        assertEquals(notes("n1"), shown.names)
        storeSyncFails = true
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        storeSyncFails = false
        PendingNotesStore.listFilesForTesting = null
        assertFalse("n1.note is unlinked, and the unlink is not synced", File(s.dir, "n1.note").exists())
        assertEquals("the permit stays", shown, permitsOf(s).read(s.dir.name))

        // After a restart nothing the permit names is there, so a rebase of n3 may withdraw it, and the store's own
        // directory is synced first: until then a power loss can bring n1.note back.
        recordPermitRemovals()
        PendingNotesStore.resetForTesting()
        val next = identityStore(noBackup, syncDirectory = sync)
        val version = next.entry("n3").version
        steps.clear()
        assertTrue(next.rebase("n3", version, "r1", "r2", blob("rebased")))
        assertNull(permitsOf(next).read(next.dir.name))
        assertTrue("the store's directory, then the one above, then the permit: $steps",
            steps.indexOf("sync ${next.dir.name}") in 0 until steps.indexOf("sync notes-pending") &&
                steps.indexOf("sync notes-pending") < steps.indexOf("remove permit"))
    }

    @Test fun `a discard syncs the nearest directory above that is there, never one that is not`() {
        // A store never made, on a device where no store was: notes-pending is not there either, so the directory
        // above it holds the highest level that is gone. A sync of notes-pending would fail.
        val noBackup = tmp.newFolder("no_backup")
        val never = identityStore(noBackup, syncDirectory = recordingSync)
        assertEquals(UnsyncedNotes.NOTHING, never.unsynced())
        steps.clear()
        assertEquals(DiscardOutcome.Done, never.discardStore(null))
        assertEquals(listOf("sync no_backup"), steps)
        assertFalse("and it makes nothing", File(noBackup, "notes-pending").exists())
    }

    @Test fun `a discard is not finished while the check of the directory above fails, and keeps its permit`() {
        val s = identityStore(syncDirectory = recordingSync)
        s.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)
        val shown = s.unsynced()
        recordPermitRemovals()
        // Which directory held the store cannot be told while notes-pending's own check fails.
        checksFailFor("notes-pending")
        steps.clear()
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        assertFalse("the directory went", s.dir.exists())
        assertFalse("notes-pending was not synced", "sync notes-pending" in steps)
        assertFalse("and the permit was not removed", "remove permit" in steps)
        assertEquals("the permit stays", shown, permitsOf(s).read(s.dir.name))
        PendingNotesStore.presenceForTesting = null
        steps.clear()
        assertEquals(DiscardOutcome.Done, s.discardStore(null))
        assertEquals(listOf("sync notes-pending", "remove permit", "sync notes-discard"), steps)
    }

    @Test fun `a note a short listing left out of the count is not deleted under that confirmation`() {
        // File.listFiles can return what it read so far when reading a directory fails partway, and say nothing.
        // n3 holds the highest version, so once the counter is gone, what is left reads at the sequence shown.
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val v3 = saved(store.saveLocal("n3", "b1", "r1", blob("never counted"), isCreate = false))
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "n3.note" }.toTypedArray() else all
        }
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(2, v3, false, names = notes("n1", "n2")), shown)
        assertEquals("what was listed went, and the rest keeps the directory", DiscardOutcome.NotFinished,
            store.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("n3.note"), dir.list()!!.toList())
        val left = filesOf(dir)
        val now = store.unsynced()
        assertEquals("the same sequence, and fewer than were shown",
            UnsyncedNotes(1, v3, false, names = notes("n3")), now)
        assertEquals("but not a note it names", DiscardOutcome.Changed(now), store.discardStore(shown))
        assertEquals("byte for byte", left, filesOf(dir))

        // Nor the permit, which records the names too, after a restart.
        val next = restarted()
        val permit = permitsOf(next).read(next.dir.name)!!
        assertEquals(shown, permit)
        assertEquals(DiscardOutcome.Changed(now), next.discardStore(permit))
        assertEquals(left, filesOf(dir))
        assertEquals("confirmed for what is there, it goes", DiscardOutcome.Done, next.discardStore(now))
        assertFalse(dir.exists())
    }

    @Test fun `a write a short listing holds without the file beside it goes alone, and that file stays`() {
        // The listing holds two writes cut short and not the entry and notebook copy beside them. A write cut
        // short is not counted, so the count names no note, and only what the listing held may go.
        store.saveLocal("n1", "b1", "r1", blob("never counted"), isCreate = false, notebookCopy = blob("key b1"))
        val entry = File(dir, "n1.note").readBytes()
        val copy = File(dir, "b1.notebook").readBytes()
        File(dir, "n1.note.new").writeBytes(byteArrayOf(1, 2, 3))
        File(dir, "b1.notebook.new").writeBytes(byteArrayOf(4, 5, 6))
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) {
                all.filter { it.name != "n1.note" && it.name != "b1.notebook" }.toTypedArray()
            } else all
        }
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())
        assertEquals("what was listed went, and the rest keeps the directory", DiscardOutcome.NotFinished,
            store.discardStore(null))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("b1.notebook", "n1.note"), dir.list()!!.sorted())
        assertArrayEquals("the entry, byte for byte", entry, File(dir, "n1.note").readBytes())
        assertArrayEquals("the notebook copy, byte for byte", copy, File(dir, "b1.notebook").readBytes())
        val now = store.unsynced()
        assertEquals(notes("n1"), now.names)
        assertEquals("and it is not deleted unconfirmed", DiscardOutcome.Changed(now), store.discardStore(null))
        assertArrayEquals(entry, File(dir, "n1.note").readBytes())
    }

    @Test fun `a notebook copy stays while a note a short listing left out is still there`() {
        // The count's listing leaves the entry out and holds its notebook copy. The copy is the only way to decrypt the
        // entry once the Etebase cache drops the notebook, so it goes only once a second listing shows no note.
        store.saveLocal("n1", "b1", "r1", blob("never counted"), isCreate = false, notebookCopy = blob("key b1"))
        val before = filesOf(dir)
        var listings = 0
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name && listings++ == 0) all.filter { it.name != "n1.note" }.toTypedArray()
            else all
        }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(null))
        PendingNotesStore.listFilesForTesting = null
        assertEquals("the count's listing and the second one", 2, listings)
        assertEquals("the entry, its notebook copy and the counter, byte for byte", before, filesOf(dir))
        val now = store.unsynced()
        assertEquals(notes("n1"), now.names)
        assertEquals(DiscardOutcome.Changed(now), store.discardStore(null))
        assertEquals(before, filesOf(dir))
    }

    @Test fun `the notebook copies stay while a second listing shows a file the count's listing left out`() {
        // A short listing can leave out more than notes; whatever it left out may matter, so nothing more goes.
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false, notebookCopy = blob("key b2"))
        val shown = store.unsynced()
        val kept = filesOf(dir).filterKeys { !it.endsWith(".note") }
        var listings = 0
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name && listings++ == 0) {
                all.filter { it.name != "b2.notebook" }.toTypedArray()
            } else all
        }
        assertEquals("the confirmed notes went, and nothing after them", DiscardOutcome.NotFinished,
            store.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals("the notebook copies and the counter, byte for byte", kept, filesOf(dir))
        assertEquals("listed in full, it finishes under the same confirmation", DiscardOutcome.Done,
            store.discardStore(shown))
        assertFalse(dir.exists())
    }

    @Test fun `a listed file of a kind this build does not know goes as listed, and a write beside it stays`() {
        // A newer build may write anything in the store, so a confirmation covers such a file by its own name only.
        File(dir, "x.unknown").writeBytes(byteArrayOf(1, 2, 3))
        File(dir, "x.unknown.new").writeBytes(byteArrayOf(4, 5, 6))
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (all != null && d.name == dir.name) all.filter { it.name != "x.unknown.new" }.toTypedArray() else all
        }
        val shown = store.unsynced()
        assertTrue(shown.unreadable)
        assertEquals(setOf("x.unknown"), shown.names)
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("x.unknown.new"), dir.list()!!.toList())
        assertArrayEquals("byte for byte", byteArrayOf(4, 5, 6), File(dir, "x.unknown.new").readBytes())
    }

    @Test fun `a listed write goes with the listed file beside it`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        File(dir, "n1.note.new").writeBytes(byteArrayOf(1, 2, 3))
        File(dir, "b1.notebook.new").writeBytes(byteArrayOf(4, 5, 6))
        val shown = store.unsynced()
        assertEquals(notes("n1"), shown.names)
        assertEquals(DiscardOutcome.Done, store.discardStore(shown))
        assertFalse(dir.exists())
    }

    // ---- a store that cannot be listed: an acknowledgement, never a permit ----

    @Test fun `a store that cannot be listed gets an acknowledgement in place of a permit, and nothing is deleted`() {
        identifyDirectories()
        val s = identityStore()
        val noBackup = s.dir.parentFile!!.parentFile!!
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1")))
        val before = filesOf(s.dir)
        unlisted(s)
        val shown = s.unsynced()
        assertEquals(UnsyncedNotes(0, v, unreadable = true, listed = false), shown)
        assertEquals("nothing was shown", DiscardOutcome.Changed(shown), s.discardStore(null))
        assertFalse(s.acknowledged())
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        assertTrue(s.acknowledged())
        assertNull("no permit", permitsOf(s).read(s.dir.name))
        assertEquals("a record of its own", listOf(s.dir.name + ".acknowledgement"),
            File(noBackup, "notes-discard").list()!!.toList())
        // It is no authority for anything: the next discard asks again, and deletes nothing either.
        assertEquals(DiscardOutcome.Changed(shown), s.discardStore(null))
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        assertTrue("the store stays open", s.read("n1") is Read.Present)
        assertEquals("nothing was deleted, byte for byte", before, filesOf(s.dir))

        // A fresh reader, as after a restart, sees it without listing the store.
        PendingNotesStore.resetForTesting()
        val asked = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d -> asked += d.name; null }
        assertTrue(identityStore(noBackup).acknowledged())
        assertEquals("no listing at all", emptyList<String>(), asked)
        PendingNotesStore.listFilesForTesting = null
        assertEquals(before, filesOf(s.dir))
    }

    @Test fun `an acknowledgement stops holding once the store lists again, and a discard asks with the real count`() {
        identifyDirectories()
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val v2 = saved(s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        val before = filesOf(s.dir)
        unlisted(s)
        val shown = s.unsynced()
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        val counted = s.unsynced()
        assertEquals(UnsyncedNotes(2, v2, false, names = notes("n1", "n2")), counted)
        assertFalse("counted again, it no longer holds", s.acknowledged())
        assertNull("and it is gone from disk, for every reader", permitsOf(s).acknowledgement(s.dir.name))
        unlisted(s)
        assertFalse("nor once the store cannot be listed again", s.acknowledged())

        // Any listing of the store that works ends it, not only a count. A new acknowledgement comes from a new
        // answer.
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        assertTrue(s.acknowledged())
        PendingNotesStore.listFilesForTesting = null
        assertEquals(2, s.scan().entries.size)
        assertFalse("a scan", s.acknowledged())
        assertNull(permitsOf(s).acknowledgement(s.dir.name))

        // The answer that was acknowledged covers no answer from a store that lists: the user is asked again
        // with the real count.
        assertEquals(DiscardOutcome.Changed(counted), s.discardStore(shown))
        assertEquals("nothing was deleted", before, filesOf(s.dir))
        assertNull("and no permit was recorded", permitsOf(s).read(s.dir.name))
        // Confirmed with the real count, it records a permit of its own before any file goes.
        val removed = ArrayList<String>()
        PendingNotesStore.beforeRemoveForTesting = { file ->
            assertEquals(counted, permitsOf(s).read(s.dir.name))
            removed += file.name
        }
        assertEquals(DiscardOutcome.Done, s.discardStore(counted))
        assertEquals(listOf("n1.note", "n2.note", "sequence"), removed)
        assertFalse(s.dir.exists())
    }

    @Test fun `an acknowledgement stops holding once anything is written to the store or removed from it`() {
        identifyDirectories()
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        // The store cannot be listed, but this instance has recovered already, so it can still write.
        unlisted(s)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        assertTrue(s.acknowledged())
        assertTrue(s.saveLocal("n1", "b1", "r2", blob("typed after"), isCreate = false) is SaveOutcome.Saved)
        assertFalse("a save", s.acknowledged())
        assertNull("and it is gone from disk", permitsOf(s).acknowledgement(s.dir.name))

        // A write that hands out no new version, a removal and a clear end it as well.
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        assertEquals(PendingNotesStore.HoldOutcome.HELD, s.hold("n1", HeldReason.READ_ONLY, now = 1))
        assertFalse("a hold", s.acknowledged())
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        s.discard("n1")
        assertFalse("a removal", s.acknowledged())
        assertNull(permitsOf(s).acknowledgement(s.dir.name))
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        s.clearAll()
        assertFalse("a clear", s.acknowledged())
        assertNull(permitsOf(s).acknowledgement(s.dir.name))
    }

    @Test fun `an acknowledgement holds for its own directory only, not one that replaced it, nor another store`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val a = identityStore(noBackup)
        val b = identityStore(noBackup, creationId = "gen-2")
        a.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        b.saveLocal("n1", "b1", "r1", blob("b"), isCreate = false)
        unlisted(a, b)
        assertEquals(DiscardOutcome.Acknowledged, a.discardStore(a.unsynced()))
        assertTrue(a.acknowledged())
        // Read by fresh instances, as after a restart, which have listed and written nothing since.
        PendingNotesStore.resetForTesting()
        val other = identityStore(noBackup, creationId = "gen-2")
        assertFalse("another store, though it cannot be listed either", other.acknowledged())
        // Not even with a's record under its name: the record names a, and a's directory.
        val root = File(noBackup, "notes-discard")
        File(root, b.dir.name + ".acknowledgement").writeBytes(File(root, a.dir.name + ".acknowledgement").readBytes())
        assertFalse(other.acknowledged())
        val again = identityStore(noBackup)
        assertTrue(again.acknowledged())

        // A directory that takes the store's place, with the same files in it, is another directory.
        val files = filesOf(a.dir)
        replace(a.dir)
        assertEquals(files, filesOf(a.dir))
        assertFalse("replaced", again.acknowledged())
        assertNotNull("the record is passed over, not used", permitsOf(a).acknowledgement(a.dir.name))
        PendingNotesStore.resetForTesting()
        assertFalse("by a fresh reader too", identityStore(noBackup).acknowledged())
        // Nor while the directory's identity cannot be read.
        PendingNotesStore.identityForTesting = { null }
        assertFalse(identityStore(noBackup).acknowledged())
    }

    @Test fun `with no identity to bind it to, or a record that fails, no acknowledgement is recorded`() {
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val before = filesOf(s.dir)
        val root = permitsOf(s).root
        unlisted(s)
        val shown = s.unsynced()
        PendingNotesStore.identityForTesting = { null }
        assertEquals(DiscardOutcome.AcknowledgementNotRecorded, s.discardStore(shown))
        assertFalse(s.acknowledged())
        assertNull("nothing was recorded", root.list())

        identifyDirectories()
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw java.io.IOException("could not record") }
        assertEquals(DiscardOutcome.AcknowledgementNotRecorded, s.discardStore(shown))
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertFalse(s.acknowledged())
        assertTrue(root.list()!!.isEmpty())
        // Nor one that reached the disk before the sync after its rename failed: it is withdrawn, as it can be here.
        PendingNotesStore.resetForTesting()
        val failing = PendingNotesDiscardPermits(root, syncDirectory = {
            if (it.name == root.name) throw java.io.IOException("sync failed")
        }, rename = atomicMove, presence = PendingNotesStore.nioPresence)
        val again = PendingNotesStore.open(s.dir, rename = atomicMove, permits = failing)
        assertEquals(DiscardOutcome.AcknowledgementNotRecorded, again.discardStore(shown))
        assertFalse(again.acknowledged())
        assertNull(permitsOf(s).acknowledgement(s.dir.name))
        PendingNotesStore.listFilesForTesting = null
        assertEquals("nothing was deleted", before, filesOf(s.dir))
    }

    @Test fun `a confirmation given while the store could not be listed covers none once it lists, nor the reverse`() {
        identifyDirectories()
        val s = identityStore()
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        assertEquals(SendOutcome.Done, s.completeSend("n1", s.beginSend("n1")!!.version, "r1", blob("landed")))
        // Only the counter is left, and a file of a kind this build does not know.
        File(s.dir, "n2.draft").writeBytes(blob("kept by a newer build"))
        val before = filesOf(s.dir)
        unlisted(s)
        val shown = s.unsynced()
        assertEquals(UnsyncedNotes(0, v, unreadable = true, listed = false), shown)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        val listed = s.unsynced()
        assertEquals(UnsyncedNotes(0, v, unreadable = true, names = setOf("n2.draft")), listed)
        assertEquals("asked again", DiscardOutcome.Changed(listed), s.discardStore(shown))
        assertEquals("nothing was deleted, byte for byte", before, filesOf(s.dir))
        assertNull("and no permit was recorded", permitsOf(s).read(s.dir.name))

        // The reverse: a confirmation for the store as listed, which could not be counted either, is taken for no
        // acknowledgement once the store cannot be listed.
        unlisted(s)
        val now = s.unsynced()
        assertEquals(DiscardOutcome.Changed(now), s.discardStore(listed))
        assertFalse(s.acknowledged())
        assertTrue("nothing was recorded", permitsOf(s).root.list()!!.isEmpty())

        // Nor does the acknowledged answer cover one with the same numbers and no names, as a store gives that
        // lists while its acknowledgement cannot be shown gone.
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(now))
        PendingNotesStore.listFilesForTesting = null
        assertTrue(File(s.dir, "n2.draft").delete())
        PendingNotesDiscardPermits.beforeDeleteForTesting = { throw java.io.IOException("could not remove it") }
        val stuck = s.unsynced()
        assertEquals(UnsyncedNotes(0, v, unreadable = true), stuck)
        assertEquals(DiscardOutcome.Changed(stuck), s.discardStore(now))
        assertNull(permitsOf(s).read(s.dir.name))
        PendingNotesDiscardPermits.beforeDeleteForTesting = null
        assertTrue("and the store was not closed", s.read("n1") is Read.Missing)
    }

    @Test fun `a confirmation given while the store could not be listed deletes nothing once it lists and counts nothing`() {
        identifyDirectories()
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        s.discard("n1")
        // What is left holds nothing a count counts: the counter, and whatever else the removal kept.
        val left = filesOf(s.dir)
        assertTrue("sequence" in left)
        unlisted(s)
        val shown = s.unsynced()
        assertFalse(shown.listed)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(UnsyncedNotes.NOTHING, s.unsynced())
        assertEquals("asked again", DiscardOutcome.Changed(UnsyncedNotes.NOTHING), s.discardStore(shown))
        assertEquals("nothing was deleted, byte for byte", left, filesOf(s.dir))
        assertNull("and no permit was recorded", permitsOf(s).read(s.dir.name))
        assertEquals("and the store was not closed", 0, s.scan().entries.size)

        // A first write cut short is not counted either, and it is not deleted under an acknowledgement.
        File(s.dir, "n3.note.new").writeBytes(blob("cut"))
        unlisted(s)
        val again = s.unsynced()
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(again))
        PendingNotesStore.listFilesForTesting = null
        val withCut = filesOf(s.dir)
        assertEquals(DiscardOutcome.Changed(UnsyncedNotes.NOTHING), s.discardStore(again))
        assertEquals(withCut, filesOf(s.dir))
        assertNull(permitsOf(s).read(s.dir.name))

        // With nothing shown, a store that holds nothing a count counts still goes, as before.
        assertEquals(DiscardOutcome.Done, s.discardStore(null))
        assertFalse(s.dir.exists())
    }

    @Test fun `after a discard that stopped, no acknowledgement is recorded, and the discard finishes once the store lists`() {
        identifyDirectories()
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val v2 = saved(s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        val shown = s.unsynced()
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        assertFalse("the discard deleted before it stopped", File(s.dir, "n1.note").exists())
        val left = filesOf(s.dir)
        val permit = permitsOf(s).read(s.dir.name)
        assertNotNull(permit)

        // The store cannot be listed now. A confirmation of what it answers is no acknowledgement here, since the
        // discard that closed the instance deleted: nothing is recorded, with an identity to bind it to or none.
        unlisted(s)
        val unlistedNow = s.unsynced()
        assertEquals(UnsyncedNotes(0, v2, unreadable = true, listed = false), unlistedNow)
        repeat(2) {
            assertEquals(DiscardOutcome.NotFinished, s.discardStore(unlistedNow))
            assertFalse(s.acknowledged())
            assertNull("no record", permitsOf(s).acknowledgement(s.dir.name))
        }
        PendingNotesStore.identityForTesting = { null }
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(unlistedNow))
        identifyDirectories()
        assertEquals("nothing was recorded", listOf(s.dir.name + ".permit"), permitsOf(s).root.list()!!.toList())
        assertEquals("the permit stays as it was", permit, permitsOf(s).read(s.dir.name))
        assertFalse(s.clearedInFull())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("and nothing more was deleted", left, filesOf(s.dir))

        // Once the store lists again, a discard confirmed for what is left finishes.
        val now = s.unsynced()
        assertEquals(UnsyncedNotes(1, v2, false, names = notes("n2")), now)
        assertEquals(DiscardOutcome.Done, s.discardStore(now))
        assertFalse(s.dir.exists())
        assertTrue(s.clearedInFull())
        assertNull(permitsOf(s).read(s.dir.name))
    }

    @Test fun `while the acknowledgement cannot be shown gone, nothing is written or removed, and none holds`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        unlisted(s)
        val shown = s.unsynced()
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        PendingNotesStore.listFilesForTesting = null
        // A record that cannot be removed: here a directory with a file in it, which the listing still shows.
        val record = File(permitsOf(s).root, s.dir.name + ".acknowledgement")
        assertTrue(record.delete() && record.mkdir() && File(record, "x").createNewFile())
        val before = filesOf(s.dir)
        val now = s.unsynced()
        assertEquals("listed, and not counted",
            UnsyncedNotes(1, shown.sequence, unreadable = true, names = notes("n1")), now)
        assertEquals(DiscardOutcome.Changed(now), s.discardStore(shown))
        assertThrows(java.io.IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false) }
        assertThrows(java.io.IOException::class.java) { s.hold("n1", HeldReason.READ_ONLY, now = 1) }
        assertThrows(java.io.IOException::class.java) { s.discard("n1") }
        assertEquals("nothing was written or removed, byte for byte", before, filesOf(s.dir))
        assertFalse(s.acknowledged())
        // A new instance lists first, in its recovery, so it reads nothing either; a clear deletes nothing.
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup)
        assertThrows(java.io.IOException::class.java) { fresh.scan() }
        assertThrows(java.io.IOException::class.java) { fresh.read("n1") }
        assertFalse(fresh.acknowledged())
        assertThrows(java.io.IOException::class.java) { fresh.clearAll() }
        assertEquals(before, filesOf(s.dir))
        assertTrue(File(record, "x").delete() && record.delete())
        fresh.clearAll()
        assertFalse(fresh.dir.exists())

        // A record that can be removed goes before anything is written or removed: the first rename of a save,
        // and the first removal, find it gone.
        PendingNotesStore.resetForTesting()
        val t = identityStore(noBackup)
        t.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        unlisted(t)
        assertEquals(DiscardOutcome.Acknowledged, t.discardStore(t.unsynced()))
        PendingNotesStore.listFilesForTesting = null
        val checked = ArrayList<String>()
        val gone: (File) -> Unit = { file ->
            if (checked.isEmpty()) assertNull(permitsOf(t).acknowledgement(t.dir.name))
            checked += file.name
        }
        PendingNotesStore.beforeRenameForTesting = gone
        assertTrue(t.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false) is SaveOutcome.Saved)
        PendingNotesStore.beforeRenameForTesting = null
        unlisted(t)
        assertEquals(DiscardOutcome.Acknowledged, t.discardStore(t.unsynced()))
        checked.clear()
        PendingNotesStore.beforeRemoveForTesting = gone
        t.discard("n1")
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(listOf("n1.note"), checked)

        // A removal that fails leaves the record on disk, where it still reads, and this instance, which has
        // listed the store since, takes it for valid no more. A new instance that has not listed it reads it.
        assertEquals(DiscardOutcome.Acknowledged, t.discardStore(t.unsynced()))
        PendingNotesStore.listFilesForTesting = null
        PendingNotesDiscardPermits.beforeDeleteForTesting = { f ->
            if (f.name.endsWith(".acknowledgement")) throw java.io.IOException("could not remove it")
        }
        assertTrue(t.unsynced().unreadable)
        PendingNotesDiscardPermits.beforeDeleteForTesting = null
        assertNotNull(permitsOf(t).acknowledgement(t.dir.name))
        unlisted(t)
        assertFalse(t.acknowledged())
        PendingNotesStore.resetForTesting()
        assertTrue(identityStore(noBackup).acknowledged())
    }

    @Test fun `while notes-discard cannot be listed, a new instance reads nothing, with no acknowledgement recorded`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        assertTrue("there, as after a permit that came and went", File(noBackup, "notes-discard").mkdir())
        val before = filesOf(s.dir)
        PendingNotesStore.resetForTesting()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-discard") null else d.listFiles() }
        val fresh = identityStore(noBackup)
        assertThrows(java.io.IOException::class.java) { fresh.scan() }
        assertThrows(java.io.IOException::class.java) { fresh.read("n1") }
        assertThrows(java.io.IOException::class.java) { fresh.beginSend("n1") }
        assertThrows(java.io.IOException::class.java) { fresh.snapshot { true } }
        assertEquals("listed, and not counted", UnsyncedNotes(1, v, unreadable = true, names = notes("n1")),
            fresh.unsynced())
        assertFalse(fresh.acknowledged())
        val never = identityStore(noBackup, creationId = "gen-2")
        assertEquals("nor a store that was never made", UnsyncedNotes(0, 0, unreadable = true), never.unsynced())
        assertThrows(java.io.IOException::class.java) { never.clearAll() }
        assertEquals(before, filesOf(fresh.dir))

        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("n1"), fresh.scan().entries.map { it.noteUid })
        assertNotNull(fresh.beginSend("n1"))
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), fresh.unsynced())
    }

    // ---- a store folder that is a link: never followed ----

    /** A symbolic link at [at] to [target], or a skip where this machine cannot make one. */
    private fun linked(at: File, target: File) {
        assertTrue("the link's folder is there", at.parentFile!!.isDirectory)
        val made = try {
            Files.createSymbolicLink(at.toPath(), target.toPath())
            true
        } catch (e: java.io.IOException) {
            false
        } catch (e: UnsupportedOperationException) {
            false
        }
        assumeTrue("this machine cannot make a symbolic link", made)
    }

    /**
     * Every path at and below [root] as lstat shows it, no link followed: a link by what it points to, a directory
     * as null, a file by its bytes. A path that is not there gives nothing.
     */
    private fun treeOf(root: File): Map<String, List<Byte>?> {
        val tree = HashMap<String, List<Byte>?>()
        fun walk(f: File, name: String) {
            val path = f.toPath()
            when {
                Files.isSymbolicLink(path) -> tree[name] = "-> ${Files.readSymbolicLink(path)}".toByteArray().toList()
                Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) -> {
                    tree[name] = null
                    for (child in f.listFiles()!!) walk(child, "$name/${child.name}")
                }
                Files.exists(path, LinkOption.NOFOLLOW_LINKS) -> tree[name] = f.readBytes().toList()
            }
        }
        walk(root, root.name)
        return tree
    }

    /**
     * Stand-ins for lstat's numbers ([inodes]) of any path that is there, read without following a link: a link has
     * one of its own, and a directory that takes a link's place has another.
     */
    private fun identifyWithoutFollowing() {
        PendingNotesStore.identityForTesting = { d ->
            val read = try {
                Files.readAttributes(d.toPath(), BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            } catch (e: java.io.IOException) {
                null
            }
            read?.let {
                val key = (if (it.isSymbolicLink) "link " else "") + d.path
                PendingNotesStore.DirectoryIdentity(device = 7, inode = inodes.getOrPut(key) { ++lastInode })
            }
        }
    }

    /**
     * Store A's folder made a link to [target], given store B beside it, which holds a saved note. A is not B's
     * instance and keeps the link's name; it could not be counted and is not listed; nothing is read, written or
     * sent through it, on every call; its only step is an acknowledgement under its own name; and a clear deletes
     * nothing. The target, B and the link are as they were, and no permit or record is read but A's own.
     */
    private fun assertLinkNeverFollowed(target: (PendingNotesStore) -> File) {
        identifyWithoutFollowing()
        val noBackup = tmp.newFolder("no_backup")
        val b = identityStore(noBackup, creationId = "gen-2")
        b.saveLocal("n1", "b1", "r1", blob("B's own note"), isCreate = false, notebookCopy = blob("key b1"))
        val to = target(b)
        val folder = PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1")
        linked(folder, to)
        val tree = treeOf(to)
        val bFiles = filesOf(b.dir)
        val bCount = b.unsynced()
        val pointsAt = Files.readSymbolicLink(folder.toPath())
        val read = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { read += it.name }

        val a = identityStore(noBackup)
        assertNotSame("a link never shares its target's instance", b, a)
        assertEquals("the link's own name", folder.name, a.dir.name)
        val shown = a.unsynced()
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, listed = false), shown)
        repeat(2) {
            assertThrows(java.io.IOException::class.java) { a.scan() }
            assertThrows(java.io.IOException::class.java) { a.read("n1") }
            assertThrows(java.io.IOException::class.java) { a.snapshot { true } }
            assertThrows(java.io.IOException::class.java) {
                a.saveLocal("n2", "b1", "r1", blob("typed"), isCreate = false)
            }
            assertThrows(java.io.IOException::class.java) { a.startSend("n1") }
            assertThrows(java.io.IOException::class.java) { a.putNotebook("b1", blob("key b1")) }
        }
        assertEquals("a prune with a recovery owed lists nothing", emptyList<String>(), a.pruneNotebooks())

        assertEquals("B's own answer covers nothing here", DiscardOutcome.Changed(shown), a.discardStore(bCount))
        assertFalse(a.acknowledged())
        assertEquals(DiscardOutcome.Acknowledged, a.discardStore(shown))
        assertTrue(a.acknowledged())
        assertEquals("a record under the link's own name, and nothing under B's or the target's",
            listOf(folder.name + ".acknowledgement"), File(noBackup, "notes-discard").list()!!.toList())
        assertThrows(java.io.IOException::class.java) { a.clearAll() }
        assertTrue("a clear refused withdraws nothing", a.acknowledged())
        assertThrows("a clear refused still closes the instance", IllegalStateException::class.java) { a.scan() }

        assertEquals("the target, byte for byte", tree, treeOf(to))
        assertEquals("B's files", bFiles, filesOf(b.dir))
        assertEquals("B's count", bCount, b.unsynced())
        assertTrue("the link is still a link", Files.isSymbolicLink(folder.toPath()))
        assertEquals("to the same path", pointsAt, Files.readSymbolicLink(folder.toPath()))
        assertEquals("no permit or record read but the link's own", setOf(folder.name + ".acknowledgement"),
            read.toSet())
    }

    @Test fun `a store folder that is a link to another store is never followed, only acknowledged`() =
        assertLinkNeverFollowed { b -> b.dir }

    @Test fun `a store folder that is a link to a file is never followed, only acknowledged`() =
        assertLinkNeverFollowed { tmp.newFile("plain").also { it.writeBytes(blob("not a store")) } }

    @Test fun `a store folder that is a link to nothing is never followed, only acknowledged`() =
        assertLinkNeverFollowed { File(tmp.root, "missing") }

    @Test fun `an instance that recovered over its folder refuses everything once a link takes the folder's place`() {
        identifyWithoutFollowing()
        val s = identityStore()
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1")))
        val editor = s.editorOpened("n1")
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), s.unsynced())
        // The same folder, moved aside, with a link to it in its place: it holds the same, and is not followed.
        val aside = File(s.dir.parentFile!!.parentFile!!, "aside")
        assertTrue(s.dir.renameTo(aside))
        linked(s.dir, aside)
        val held = filesOf(aside)
        val shown = s.unsynced()
        assertEquals("not counted through the link", UnsyncedNotes(0, v, unreadable = true, listed = false), shown)
        assertThrows("a recovered instance's prune", java.io.IOException::class.java) { s.pruneNotebooks() }
        assertEquals("a recovery is owed from then on", emptyList<String>(), s.pruneNotebooks())
        repeat(2) {
            assertThrows(java.io.IOException::class.java) { s.read("n1") }
            assertThrows(java.io.IOException::class.java) { s.scan() }
            assertThrows(java.io.IOException::class.java) { s.saveLocal(editor, "n1", "b1", "r2", blob("b"), false) }
            assertThrows(java.io.IOException::class.java) { s.beginSend("n1") }
        }
        assertThrows(java.io.IOException::class.java) { s.snapshot { true } }
        assertThrows(java.io.IOException::class.java) { s.observe("n1") }
        assertThrows(java.io.IOException::class.java) { s.completeSend("n1", v, "r1", blob("landed")) }
        assertThrows(java.io.IOException::class.java) { s.recordFailure("n1", v, "TRANSIENT", now = 1) }
        assertThrows(java.io.IOException::class.java) { s.hold("n1", HeldReason.READ_ONLY, now = 1) }
        assertThrows(java.io.IOException::class.java) { s.release("n1") }
        assertThrows(java.io.IOException::class.java) { s.discard("n1") }
        assertThrows(java.io.IOException::class.java) { s.landed("n1") }
        assertThrows(java.io.IOException::class.java) { s.clearLanded("n1") }
        assertThrows(java.io.IOException::class.java) { s.notebook("b1") }
        assertThrows(java.io.IOException::class.java) { s.putNotebook("b1", blob("key")) }
        assertThrows(java.io.IOException::class.java) { s.editorOpened("n2") }
        assertThrows(java.io.IOException::class.java) { s.editorClosed(editor) }
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        assertTrue(s.acknowledged())
        assertEquals("nothing was read, written or deleted through it", held, filesOf(aside))

        // The real folder back in the link's place is not what was acknowledged, and the instance recovers over it
        // and works again.
        Files.delete(s.dir.toPath())
        assertTrue(aside.renameTo(s.dir))
        assertFalse(s.acknowledged())
        assertTrue(s.read("n1") is Read.Present)
        assertNull("the listing removed the record", permitsOf(s).acknowledgement(s.dir.name))
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), s.unsynced())
        assertTrue(s.saveLocal(editor, "n1", "b1", "r2", blob("b"), isCreate = false) is SaveOutcome.Saved)
    }

    @Test fun `a store folder whose lstat cannot tell is taken for a link, and nothing is read or deleted`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1")))
        val before = filesOf(s.dir)
        val asked = HashSet<String>()
        PendingNotesStore.linkForTesting = { d -> asked += d.path; null }
        val shown = s.unsynced()
        assertEquals(UnsyncedNotes(0, v, unreadable = true, listed = false), shown)
        assertThrows(java.io.IOException::class.java) { s.pruneNotebooks() }
        repeat(2) {
            assertThrows(java.io.IOException::class.java) { s.scan() }
            assertThrows(java.io.IOException::class.java) { s.read("n1") }
            assertThrows(java.io.IOException::class.java) {
                s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
            }
            assertThrows(java.io.IOException::class.java) { s.beginSend("n1") }
        }
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(shown))
        assertTrue(s.acknowledged())
        assertEquals("nothing was read, written or deleted", before, filesOf(s.dir))

        // Once lstat tells, the folder is followed again.
        PendingNotesStore.linkForTesting = null
        assertTrue(s.read("n1") is Read.Present)
        assertFalse(s.acknowledged())
        // A new instance, as after a restart, is refused before its recovery, and its clear deletes nothing.
        PendingNotesStore.linkForTesting = { d -> asked += d.path; null }
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup)
        assertThrows(java.io.IOException::class.java) { fresh.scan() }
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, listed = false), fresh.unsynced())
        assertThrows(java.io.IOException::class.java) { fresh.clearAll() }
        assertThrows("a clear refused still closes the instance", IllegalStateException::class.java) { fresh.scan() }
        assertEquals(before, filesOf(s.dir))
        assertEquals("only the store's own folder was asked about", setOf(s.dir.path), asked)
    }

    // ---- what a removal of the account would lose, in one step, for a removal guard ----

    @Test fun `a removal check of a store that lists is clean, covered by its permit, or blocked by what it holds`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        assertEquals("a store never made", RemovalCheck.Clean, s.removalCheck())
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        assertEquals(SendOutcome.Done, s.completeSend("n1", s.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals("the save showed the permit gone, so the send read none", emptyList<String>(), reads)
        reads.clear()
        assertEquals("the counter and a notebook copy hold no text", RemovalCheck.Clean, s.removalCheck())
        assertEquals("and no permit is read for a store that holds nothing", emptyList<String>(), reads)

        val v = saved(s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        val held = UnsyncedNotes(1, v, false, names = notes("n2"))
        assertEquals(RemovalCheck.Blocks(held), s.removalCheck())
        assertEquals("its permit, by path", listOf("${s.dir.name}.permit"), reads)
        // The permit a confirmed discard records for exactly that covers it, and the answer is the count's.
        permitsOf(s).record(s.dir.name, held)
        assertEquals(RemovalCheck.Covered, s.removalCheck())
        assertEquals(held, s.unsynced())
        // A store that cannot be counted is blocked too, unless a permit for that answer covers it.
        File(s.dir, "n3.draft").writeBytes(blob("kept by a newer build"))
        val uncounted = s.unsynced()
        assertTrue(uncounted.unreadable)
        assertEquals(RemovalCheck.Blocks(uncounted), s.removalCheck())
        permitsOf(s).record(s.dir.name, uncounted)
        assertEquals(RemovalCheck.Covered, s.removalCheck())
        // A permit that cannot be read is none.
        val permit = File(noBackup, "notes-discard/${s.dir.name}.permit")
        assertTrue(permit.delete() && permit.mkdir())
        assertEquals(RemovalCheck.Blocks(uncounted), s.removalCheck())
    }

    @Test fun `a permit recorded for less than the store holds now covers no removal`() {
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val older = s.unsynced()
        s.saveLocal("n1", "b1", "r2", blob("typed after"), isCreate = false)
        // Recorded directly: a save removes the permit before it hands out a version, so after one there is none.
        permitsOf(s).record(s.dir.name, older)
        assertEquals(RemovalCheck.Blocks(s.unsynced()), s.removalCheck())
        // Nor one at the same sequence that names a note less.
        s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val now = s.unsynced()
        permitsOf(s).record(s.dir.name, now.copy(count = 1, names = notes("n1")))
        assertEquals(RemovalCheck.Blocks(now), s.removalCheck())
    }

    @Test fun `a store that cannot be listed is acknowledged, unlisted, or absent by its own check alone`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        unlisted(s)
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        assertEquals(RemovalCheck.Unlisted, s.removalCheck())
        assertEquals("no permit is read, and no acknowledgement by an instance that wrote since", emptyList<String>(),
            reads)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        assertEquals(RemovalCheck.Acknowledged, s.removalCheck())
        assertTrue("never a permit", reads.none { it.endsWith(".permit") })
        // A fresh instance, as after a restart, has listed nothing, so the acknowledgement holds for it as well.
        PendingNotesStore.resetForTesting()
        assertEquals(RemovalCheck.Acknowledged, identityStore(noBackup).removalCheck())
        // Not for a directory that took its place, nor while the identity cannot be read.
        val files = filesOf(s.dir)
        replace(s.dir)
        assertEquals(RemovalCheck.Unlisted, identityStore(noBackup).removalCheck())
        PendingNotesStore.identityForTesting = { null }
        assertEquals(RemovalCheck.Unlisted, identityStore(noBackup).removalCheck())
        assertEquals("nothing in it changed", files, filesOf(s.dir))

        // While notes-pending cannot be listed, a store folder that was never made is absent by its own check alone,
        // which shows no directory gone, and one whose check fails is no absence.
        val never = identityStore(noBackup, creationId = "gen-2")
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-pending") null else d.listFiles() }
        assertEquals(RemovalCheck.UnlistedAbsent, never.removalCheck())
        checksFailFor(never.dir.name)
        assertEquals(RemovalCheck.Unlisted, never.removalCheck())
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertEquals("shown gone once notes-pending lists", RemovalCheck.Clean, never.removalCheck())
    }

    @Test fun `an absent answer is ENOENT for the store's own path, asked under its lock, and writes nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        // notes-pending is there but cannot be listed, and the store's own folder was never made.
        assertTrue(File(noBackup, "notes-pending").mkdir())
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-pending") null else d.listFiles() }
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw AssertionError("a record of ${it.name}") }
        PendingNotesDiscardPermits.beforeDeleteForTesting = { throw AssertionError("a withdrawal of ${it.name}") }
        val reads = java.util.Collections.synchronizedList(ArrayList<String>())
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        fun snapshot() = noBackup.walk().associate { f ->
            f.relativeTo(noBackup).path to (if (f.isFile) f.readBytes().toList() else null)
        }
        val before = snapshot()
        val path = PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1")
            .canonicalPath
        val caller = Thread.currentThread()
        val asked = ArrayList<String>()
        var other: Thread? = null
        var blocked = false
        PendingNotesStore.presenceForTesting = { f ->
            if (Thread.currentThread() === caller) asked += f.canonicalPath
            if (other == null) {
                // Another caller of the same store while the presence check runs waits for the store lock.
                val thread = kotlin.concurrent.thread { s.unsynced() }
                other = thread
                val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
                while (thread.state != Thread.State.BLOCKED && thread.state != Thread.State.TERMINATED &&
                        System.nanoTime() < deadline) Thread.sleep(1)
                blocked = thread.state == Thread.State.BLOCKED
            }
            null
        }
        val answer = try {
            s.removalCheck()
        } finally {
            other?.join(10_000)
        }
        assertEquals(RemovalCheck.UnlistedAbsent, answer)
        assertTrue("the presence check ran under the store lock", blocked)
        assertEquals("one check, of the store's own path", listOf(path), asked)
        assertEquals("only its acknowledgement is read, by path, and no permit",
            listOf("${s.dir.name}.acknowledgement"), reads)
        assertEquals("nothing was written, made or withdrawn", before, snapshot())

        // Any other answer for that path is no absence, and a check that throws is no answer.
        for (presence in listOf(PendingNotesStore.Presence.PRESENT, PendingNotesStore.Presence.UNKNOWN)) {
            PendingNotesStore.presenceForTesting = { f -> if (f.canonicalPath == path) presence else null }
            assertEquals("$presence", RemovalCheck.Unlisted, s.removalCheck())
        }
        PendingNotesStore.presenceForTesting = { f ->
            if (f.canonicalPath == path) throw SecurityException("denied") else null
        }
        assertThrows(SecurityException::class.java) { s.removalCheck() }
        PendingNotesStore.presenceForTesting = null

        // A discard in the same state, as sign-out's clear: no identity to bind an acknowledgement to, so nothing is
        // recorded or deleted, and nothing is taken for gone.
        val shown = s.unsynced()
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, listed = false), shown)
        assertEquals(DiscardOutcome.AcknowledgementNotRecorded, s.discardStore(shown))
        assertEquals(DiscardOutcome.Changed(shown), s.discardStore(null))
        assertEquals(before, snapshot())

        // A regular file at the store's path is there, by the platform's own check.
        File(path).writeBytes(blob("not a folder"))
        assertEquals(RemovalCheck.Unlisted, s.removalCheck())
    }

    @Test fun `a removal check withdraws the acknowledgement of a store that lists, and writes and recovers nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        unlisted(s)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        PendingNotesStore.listFilesForTesting = null
        // Behind the store's back: an intact first write that recovery would commit.
        val stranded = PendingEntry("n9", "b1", PendingEntry.State.UPSERT, 9, "r9", false, blob = blob("c"))
        File(s.dir, "n9.note.new").writeBytes(PendingCodec.encodeEntry(stranded))
        val before = filesOf(s.dir)
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup)
        assertEquals(RemovalCheck.Blocks(UnsyncedNotes(2, 1, false, names = notes("n1", "n9"))), fresh.removalCheck())
        assertNull("withdrawn, as a count withdraws it", permitsOf(s).acknowledgement(s.dir.name))
        assertFalse(fresh.acknowledged())
        assertEquals("no recovery ran and nothing was written in the store", before, filesOf(s.dir))
    }

    @Test fun `while the acknowledgement cannot be shown gone, an empty store says so, and text is still counted`() {
        val noBackup = tmp.newFolder("no_backup")
        val v = saved(identityStore(noBackup).saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val covered = identityStore(noBackup, creationId = "gen-3")
        covered.saveLocal("n1", "b1", "r1", blob("b"), isCreate = false)
        // The permit is there, so notes-discard is too.
        covered.coverForTesting()
        PendingNotesStore.resetForTesting()
        PendingNotesStore.listFilesForTesting = { d -> if (d.name == "notes-discard") null else d.listFiles() }
        assertEquals("a store never made", RemovalCheck.NothingUnwithdrawn,
            identityStore(noBackup, creationId = "gen-2").removalCheck())
        val s = identityStore(noBackup)
        assertEquals(RemovalCheck.Blocks(UnsyncedNotes(1, v, false, names = notes("n1"))), s.removalCheck())
        assertEquals("its permit is read by path", RemovalCheck.Covered,
            identityStore(noBackup, creationId = "gen-3").removalCheck())
        assertFalse("and the acknowledgement is taken for valid no more", s.acknowledged())
        // Once notes-discard lists, the same instances withdraw it and answer as before.
        PendingNotesStore.listFilesForTesting = null
        assertEquals(RemovalCheck.Clean, identityStore(noBackup, creationId = "gen-2").removalCheck())
    }

    @Test fun `a folder that lists and holds no text is NothingUnwithdrawn while notes-discard cannot be listed`() {
        val noBackup = tmp.newFolder("no_backup")
        // A store whose last change was pushed, which keeps only its counter and a notebook copy, and an empty folder.
        val pushed = identityStore(noBackup)
        pushed.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        assertEquals(SendOutcome.Done,
            pushed.completeSend("n1", pushed.beginSend("n1")!!.version, "r1", blob("landed")))
        assertEquals(setOf("sequence", "b1.notebook"), filesOf(pushed.dir).keys)
        assertTrue(PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-2").mkdir())
        // notes-discard is there, as after a permit that came and went, and cannot be listed.
        assertTrue(File(noBackup, PendingNotesDiscardPermits.ROOT).mkdir())
        PendingNotesStore.resetForTesting()
        val listed = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d ->
            listed += d.name
            if (d.name == PendingNotesDiscardPermits.ROOT) null else d.listFiles()
        }
        val reads = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { reads += it.name }
        val before = treeOf(noBackup)
        val stores = listOf("gen-1", "gen-2").map { identityStore(noBackup, creationId = it) }
        for (s in stores) {
            listed.clear()
            assertEquals(RemovalCheck.NothingUnwithdrawn, s.removalCheck())
            assertEquals("counted from its own listing, which worked", s.dir.name, listed.first())
        }
        assertEquals("no permit is read", emptyList<String>(), reads)
        assertEquals("nothing changes", before, treeOf(noBackup))
        // A count of the same stores, as the Unsynced Notes screen asks, could not be counted, and names nothing.
        for (s in stores) {
            val shown = s.unsynced()
            assertTrue(shown.unreadable && shown.listed && shown.count == 0 && shown.names.isEmpty())
        }
    }

    @Test fun `a dropped store refuses a removal check, and a cleared one still answers from what is on disk`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("could not clear the pending store") }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        PendingNotesStore.beforeClearForTesting = null
        assertEquals("what the failed clear left", RemovalCheck.Blocks(store.unsynced()), store.removalCheck())
        store.clearAll()
        assertEquals(RemovalCheck.Clean, store.removalCheck())

        val other = open(tmp.newFolder("other"))
        other.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        assertEquals(DiscardOutcome.Done, other.discardStore(other.unsynced()))
        other.unregister()
        assertThrows(IllegalStateException::class.java) { other.removalCheck() }
    }

    /** Every listing of [s]'s own folder holds only the names in [keep], as a listing that comes back short can. */
    private fun listingKeeps(s: PendingNotesStore, vararg keep: String) {
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == s.dir.name) d.listFiles()?.filter { it.name in keep }?.toTypedArray() else d.listFiles()
        }
    }

    @Test fun `a removal check whose listing lacks the counter while lstat shows it there blocks, as could not be counted`() {
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val v2 = saved(s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        // A listing that comes back with nothing, and says nothing, while the counter is there by path.
        listingKeeps(s)
        val empty = UnsyncedNotes(0, v2, unreadable = true)
        assertEquals("could not be counted, at the counter's sequence, read by path", RemovalCheck.Blocks(empty),
            s.removalCheck())
        assertEquals(empty, s.unsynced())
        // One that stopped after n1.note, before n2.note and the counter: a permit recorded for n1 alone, as a count
        // from that listing would have named it, covers none of it.
        listingKeeps(s, "n1.note")
        val short = s.unsynced()
        assertEquals(UnsyncedNotes(1, v2, unreadable = true, names = notes("n1")), short)
        permitsOf(s).record(s.dir.name, UnsyncedNotes(1, v2, false, names = notes("n1")))
        assertEquals(RemovalCheck.Blocks(short), s.removalCheck())
        // Nor does it cover the empty listing, which lists no note, so only the permit decides.
        listingKeeps(s)
        assertEquals("a permit for a counted answer covers none that could not be counted", RemovalCheck.Blocks(empty),
            s.removalCheck())
        // The limit: a listing that skips n2.note and still lists the counter is taken as it comes, and that permit
        // covers it.
        listingKeeps(s, "n1.note", "sequence")
        assertEquals(UnsyncedNotes(1, v2, false, names = notes("n1")), s.unsynced())
        assertEquals("not caught: the counter is listed", RemovalCheck.Covered, s.removalCheck())
    }

    @Test fun `a lost counter, a store never made and an empty folder are no short listing, and a counter check that fails is no absence`() {
        val noBackup = tmp.newFolder("no_backup")
        assertEquals("a store never made", RemovalCheck.Clean, identityStore(noBackup, "gen-never").removalCheck())
        val empty = identityStore(noBackup, "gen-empty")
        assertTrue(empty.dir.mkdirs())
        assertEquals("an empty folder", RemovalCheck.Clean, empty.removalCheck())
        // A store whose last change was pushed keeps its counter and a notebook copy, which hold no text.
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        assertEquals(SendOutcome.Done, s.completeSend("n1", s.beginSend("n1")!!.version, "r1", blob("landed")))
        val counter = File(s.dir, "sequence")
        // Its listing leaves out the counter, and the counter's check fails: that is no absence, so the store could not
        // be counted.
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == s.dir.name) d.listFiles()?.filter { it.name != "sequence" }?.toTypedArray() else d.listFiles()
        }
        PendingNotesStore.presenceForTesting = { f -> if (f == counter) PendingNotesStore.Presence.UNKNOWN else null }
        val uncheckable = s.removalCheck()
        assertTrue("$uncheckable", uncheckable is RemovalCheck.Blocks && uncheckable.answer.unreadable &&
            uncheckable.answer.listed && uncheckable.answer.names.isEmpty())
        // With the counter shown absent, as for one lost after the listing, there is nothing to refuse.
        PendingNotesStore.presenceForTesting = { f -> if (f == counter) PendingNotesStore.Presence.ABSENT else null }
        assertEquals(RemovalCheck.Clean, s.removalCheck())
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.listFilesForTesting = null
        // A counter that is lost: clean while the store holds no note, and counted from its listing, as before, once it
        // holds one.
        assertTrue(counter.delete())
        assertEquals("its counter lost", RemovalCheck.Clean, s.removalCheck())
        val v = saved(s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        assertTrue(counter.delete())
        assertEquals(RemovalCheck.Blocks(UnsyncedNotes(1, v, false, names = notes("n2"))), s.removalCheck())
    }

    @Test fun `a count whose listing lacks the counter could not be counted, and a discard of that answer deletes only what was listed and holds back the rest`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false))
        // The listing stops after n1.note, before n2.note and the counter.
        listingKeeps(store, "n1.note")
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(1, v2, unreadable = true, names = notes("n1")), shown)
        // Confirmed as shown, the discard deletes what that listing held and stops, since n2.note keeps the folder.
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        assertEquals("only what was listed went", setOf("n2.note", "sequence"), filesOf(dir).keys)
        assertEquals("its permit is for that answer", shown, permitsOf(store).read(dir.name))
        assertEquals("which covers what the same listing shows now", RemovalCheck.Covered, store.removalCheck())
        PendingNotesStore.listFilesForTesting = null

        // After a restart, with the listing whole, no note of the store is sent, n2 included, which no listing named.
        val s = restarted()
        assertEquals(PendingNotesStore.SendStart.Refused(PendingNotesStore.Refusal.DISCARD_CONFIRMED), s.startSend("n2"))
        val waiting = s.snapshot { false }
        assertEquals(setOf("n2"), waiting.discardConfirmed)
        assertTrue(waiting.discardUnfinished)
        // While what is left counts, that permit covers no removal; a discard confirmed for what is left finishes.
        val left = s.unsynced()
        assertEquals(UnsyncedNotes(1, v2, false, names = notes("n2")), left)
        assertEquals(RemovalCheck.Blocks(left), s.removalCheck())
        assertEquals(DiscardOutcome.Done, s.discardStore(left))
        assertEquals(RemovalCheck.Clean, s.removalCheck())
    }

    @Test fun `a removal check over a discard that stopped answers from what is left, and a permit that cannot be read or is damaged covers nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(s.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue(s.clearStopped())
        assertEquals("what is left, under its permit", RemovalCheck.Covered, s.removalCheck())
        // A folder in the permit's place, or a permit whose bytes are damaged, is no permit: what is left blocks.
        val left = s.unsynced()
        val permit = File(noBackup, "notes-discard/${s.dir.name}.permit")
        val bytes = permit.readBytes()
        assertTrue(permit.delete() && permit.mkdir())
        assertEquals(RemovalCheck.Blocks(left), s.removalCheck())
        assertTrue(permit.delete())
        permit.writeBytes(bytes.also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() })
        assertEquals(RemovalCheck.Blocks(left), s.removalCheck())

        // A discard that stops at the counter leaves no note, and nothing a count counts.
        val other = identityStore(noBackup, "gen-2")
        other.saveLocal("n1", "b1", "r1", blob("c"), isCreate = false)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "sequence") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, other.discardStore(other.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertTrue(other.clearStopped())
        assertEquals(setOf("sequence"), filesOf(other.dir).keys)
        assertEquals(RemovalCheck.Clean, other.removalCheck())
        // Its folder cannot be listed now: Unlisted, and a confirmation records no acknowledgement on the instance
        // whose discard stopped. A new one, as after a restart, records one.
        unlisted(other)
        assertEquals(RemovalCheck.Unlisted, other.removalCheck())
        assertEquals(DiscardOutcome.NotFinished, other.discardStore(other.unsynced()))
        assertNull(permitsOf(other).acknowledgement(other.dir.name))
        assertEquals(RemovalCheck.Unlisted, other.removalCheck())
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup, "gen-2")
        assertEquals(DiscardOutcome.Acknowledged, fresh.discardStore(fresh.unsynced()))
        assertEquals(RemovalCheck.Acknowledged, fresh.removalCheck())
        PendingNotesStore.listFilesForTesting = null

        // A permit from before that cannot be read: the discard's own permit in its place is recorded as for an answer
        // that could not be counted, so what a discard that stopped under it left blocks while it counts, and a Retry
        // that finishes leaves the store clean.
        val third = identityStore(noBackup, "gen-3")
        third.saveLocal("n1", "b1", "r1", blob("d"), isCreate = false)
        val v2 = saved(third.saveLocal("n2", "b1", "r1", blob("e"), isCreate = false))
        permitsOf(third).record(third.dir.name, UnsyncedNotes(1, v2, false, names = notes("n1")))
        val shown = third.unsynced()
        permitReadsFail()
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, third.discardStore(shown))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesDiscardPermits.onReadForTesting = null
        assertEquals(shown.copy(unreadable = true), permitsOf(third).read(third.dir.name))
        val remainder = third.unsynced()
        assertEquals(UnsyncedNotes(1, v2, false, names = notes("n2")), remainder)
        assertEquals(RemovalCheck.Blocks(remainder), third.removalCheck())
        // A listing that lacks the counter and lists what is left blocks whatever the permit, as that counted answer
        // did before the counter check.
        listingKeeps(third, "n2.note")
        assertEquals(RemovalCheck.Blocks(UnsyncedNotes(1, v2, unreadable = true, names = notes("n2"))),
            third.removalCheck())
        // The limit: one that lists nothing could not be counted, and at its sequence that permit covers it.
        listingKeeps(third)
        assertEquals("not caught", RemovalCheck.Covered, third.removalCheck())
        PendingNotesStore.listFilesForTesting = null
        assertEquals(DiscardOutcome.Done, third.discardStore(shown))
        assertEquals(RemovalCheck.Clean, third.removalCheck())
    }

    @Test fun `a permit recorded as for an answer that could not be counted in place of another covers no counted remainder, and covers an empty listing at its sequence`() {
        store.saveLocal("n1", "b1", "r1", blob("missed by every count"), isCreate = false)
        val v2 = saved(store.saveLocal("n2", "b1", "r1", blob("counted"), isCreate = false))
        // As for a sign-out confirmed for a counted answer in place of a permit for one that could not be counted: a
        // file of a kind this build does not know, and listings that leave out n1.
        File(dir, "x.draft").writeBytes(blob("kept by a newer build"))
        listingLeavesOut("n1.note")
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("stopped") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        assertTrue(File(dir, "x.draft").delete())
        val s = restarted()
        val counted = s.unsynced()
        assertEquals(UnsyncedNotes(1, v2, unreadable = false, names = notes("n2")), counted)
        assertEquals(DiscardOutcome.NotFinished, s.discardStore(counted))
        PendingNotesStore.beforeClearForTesting = null
        assertTrue("recorded as for an answer that could not be counted", permitsOf(s).read(dir.name)!!.unreadable)
        // While the same listing counts what is left, the permit covers no removal, though it names all of it.
        assertEquals(RemovalCheck.Blocks(counted), s.removalCheck())
        // Nor is a listing that lacks the counter and lists what is left taken as covered, which before the counter
        // check was that counted answer, while n1 is still there.
        listingKeeps(s, "n2.note")
        assertEquals(RemovalCheck.Blocks(UnsyncedNotes(1, v2, unreadable = true, names = notes("n2"))),
            s.removalCheck())
        // The limit: a listing that comes back with nothing, while the counter is there, could not be counted, and at
        // the permit's sequence that permit covers it, whatever the listing left out.
        listingKeeps(s)
        assertEquals(UnsyncedNotes(0, v2, unreadable = true), s.unsynced())
        assertEquals("not caught", RemovalCheck.Covered, s.removalCheck())
    }

    /**
     * Store A's folder made a link to [target], given store B beside it, which holds a saved note. A's removal check
     * lists nothing, reads no permit, records and withdraws nothing, and changes nothing on disk, B and the target
     * included: it is Unlisted, never Clean, Blocks or UnlistedAbsent, and Acknowledged once A is acknowledged, for the
     * link's own identity, in a new instance as well.
     */
    private fun assertRemovalCheckNeverFollowsLink(target: (PendingNotesStore) -> File) {
        identifyWithoutFollowing()
        val noBackup = tmp.newFolder("no_backup")
        val b = identityStore(noBackup, creationId = "gen-2")
        b.saveLocal("n1", "b1", "r1", blob("B's own note"), isCreate = false, notebookCopy = blob("key b1"))
        val to = target(b)
        val folder = PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1")
        linked(folder, to)
        fun check(expected: RemovalCheck) {
            val listed = ArrayList<String>()
            val read = ArrayList<String>()
            PendingNotesStore.listFilesForTesting = { d -> listed += d.path; d.listFiles() }
            PendingNotesDiscardPermits.onReadForTesting = { read += it.name }
            PendingNotesDiscardPermits.beforeRecordForTesting = { throw AssertionError("a record of ${it.name}") }
            PendingNotesDiscardPermits.beforeDeleteForTesting = { throw AssertionError("a withdrawal of ${it.name}") }
            val before = treeOf(noBackup) + treeOf(to)
            assertEquals(expected, identityStore(noBackup).removalCheck())
            assertEquals("nothing is listed", emptyList<String>(), listed)
            assertEquals("no permit is read, only the link's own acknowledgement",
                listOf(folder.name + ".acknowledgement"), read)
            assertEquals("nothing changes on disk", before, treeOf(noBackup) + treeOf(to))
            PendingNotesStore.listFilesForTesting = null
            PendingNotesDiscardPermits.onReadForTesting = null
            PendingNotesDiscardPermits.beforeRecordForTesting = null
            PendingNotesDiscardPermits.beforeDeleteForTesting = null
        }
        check(RemovalCheck.Unlisted)
        val a = identityStore(noBackup)
        assertEquals(DiscardOutcome.Acknowledged, a.discardStore(a.unsynced()))
        check(RemovalCheck.Acknowledged)
        PendingNotesStore.resetForTesting()
        check(RemovalCheck.Acknowledged)
        assertTrue("the link is still a link", Files.isSymbolicLink(folder.toPath()))
    }

    @Test fun `a removal check of a store folder that is a link to another store is unlisted until acknowledged`() =
        assertRemovalCheckNeverFollowsLink { b -> b.dir }

    @Test fun `a removal check of a store folder that is a link to a file is unlisted until acknowledged`() =
        assertRemovalCheckNeverFollowsLink { tmp.newFile("plain").also { it.writeBytes(blob("not a store")) } }

    @Test fun `a removal check of a store folder that is a link to nothing is unlisted until acknowledged`() =
        assertRemovalCheckNeverFollowsLink { File(tmp.root, "missing") }

    @Test fun `a removal check of a store folder whose lstat cannot tell lists, reads and withdraws nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        // Followed, these would be Blocks, Clean, and absent by lstat under a notes-pending that cannot be listed.
        identityStore(noBackup).saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val clean = identityStore(noBackup, creationId = "gen-2")
        clean.saveLocal("n1", "b1", "r1", blob("b"), isCreate = false, notebookCopy = blob("key b1"))
        assertEquals(SendOutcome.Done, clean.completeSend("n1", clean.beginSend("n1")!!.version, "r1", blob("landed")))
        PendingNotesStore.resetForTesting()
        val stores = listOf("gen-1", "gen-2", "gen-3").map { identityStore(noBackup, creationId = it) }
        val listed = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d ->
            listed += d.path
            if (d.name == "notes-pending") null else d.listFiles()
        }
        val read = ArrayList<String>()
        PendingNotesDiscardPermits.onReadForTesting = { read += it.name }
        val asked = HashSet<String>()
        PendingNotesStore.linkForTesting = { d -> asked += d.path; null }
        fun check(s: PendingNotesStore, expected: RemovalCheck) {
            listed.clear()
            read.clear()
            PendingNotesDiscardPermits.beforeRecordForTesting = { throw AssertionError("a record of ${it.name}") }
            PendingNotesDiscardPermits.beforeDeleteForTesting = { throw AssertionError("a withdrawal of ${it.name}") }
            val before = treeOf(noBackup)
            assertEquals(s.dir.name, expected, s.removalCheck())
            assertEquals("nothing is listed", emptyList<String>(), listed)
            assertEquals("no permit is read", listOf(s.dir.name + ".acknowledgement"), read)
            assertEquals("nothing changes on disk", before, treeOf(noBackup))
            PendingNotesDiscardPermits.beforeRecordForTesting = null
            PendingNotesDiscardPermits.beforeDeleteForTesting = null
        }
        for (s in stores) check(s, RemovalCheck.Unlisted)
        // The acknowledgement holds for each folder that is there; the one never made has no identity to bind it to.
        val outcomes = stores.map { it.discardStore(it.unsynced()) }
        assertEquals(listOf(DiscardOutcome.Acknowledged, DiscardOutcome.Acknowledged,
            DiscardOutcome.AcknowledgementNotRecorded), outcomes)
        check(stores[0], RemovalCheck.Acknowledged)
        check(stores[1], RemovalCheck.Acknowledged)
        check(stores[2], RemovalCheck.Unlisted)
        assertEquals("only the stores' own folders were asked about", stores.map { it.dir.path }.toSet(), asked)

        // Once lstat tells, each folder is followed again.
        PendingNotesStore.linkForTesting = null
        assertTrue(stores[0].removalCheck() is RemovalCheck.Blocks)
        assertEquals(RemovalCheck.Clean, stores[1].removalCheck())
        assertEquals(RemovalCheck.UnlistedAbsent, stores[2].removalCheck())
    }

    @Test fun `coverForTesting covers what the store holds without closing it, and the next version withdraws it`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        assertEquals("nothing to cover", UnsyncedNotes.NOTHING, s.coverForTesting())
        assertFalse("and no permit", File(noBackup, "notes-discard").exists())
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val before = filesOf(s.dir)
        val now = s.coverForTesting()
        assertEquals(s.unsynced(), now)
        assertEquals(now, permitsOf(s).read(s.dir.name))
        assertEquals(RemovalCheck.Covered, s.removalCheck())
        assertEquals("nothing was deleted", before, filesOf(s.dir))
        // This instance withdrew its permit once, at its first save; covering makes it withdraw again.
        assertTrue("open", s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false) is SaveOutcome.Saved)
        assertNull(permitsOf(s).read(s.dir.name))
        assertEquals(RemovalCheck.Blocks(s.unsynced()), s.removalCheck())
    }

    @Test fun `no main code covers a store with no confirmation`() {
        val main = File("src/main/java")
        val naming = main.walk().filter { it.isFile && it.extension in setOf("kt", "java") }.flatMap { file ->
            file.readLines().map { it.trim() }.filter { line ->
                "coverForTesting" in line && !line.startsWith("*") && !line.startsWith("/*") && !line.startsWith("//")
            }.map { file.name to it }
        }.toList()
        val definition = "internal fun coverForTesting(): UnsyncedNotes = synchronized(lock) {"
        assertEquals("only its definition", listOf("PendingNotesStore.kt" to definition), naming)
    }

    @Test fun `a folder counter moves on a listing of its folder that works or when shown gone, and on nothing else`() {
        val noBackup = tmp.newFolder("no_backup")
        val pending = File(noBackup, "notes-pending")
        val discard = File(noBackup, PendingNotesDiscardPermits.ROOT)
        fun counts() = NotesFolderListings.Folder.entries.map { NotesFolderListings.count(it) }
        var last = counts()
        /** How far each counter moved since the last call: notes-pending's, then notes-discard's. */
        fun moved(): List<Long> = counts().let { now -> now.zip(last) { a, b -> a - b }.also { last = now } }

        // Shown not to be there, each moves its own, and a store folder shown gone with notes-pending moves that one.
        assertTrue(PendingNotesStore.knownAbsent(pending))
        assertEquals(listOf(1L, 0L), moved())
        assertTrue(PendingNotesStore.knownAbsent(discard))
        assertEquals(listOf(0L, 1L), moved())
        val folder = File(pending, "0".repeat(64))
        assertTrue(PendingNotesStore.knownAbsent(folder))
        assertEquals(listOf(1L, 0L), moved())

        // There: a check that shows it there moves nothing, and each listing that works moves its folder's once.
        assertTrue(folder.mkdirs() && discard.mkdir())
        assertFalse(PendingNotesStore.knownAbsent(pending))
        assertEquals(listOf(0L, 0L), moved())
        assertNotNull(PendingNotesStore.listDirectory(pending))
        assertEquals(listOf(1L, 0L), moved())
        assertNotNull(PendingNotesStore.listDirectory(discard))
        assertEquals(listOf(0L, 1L), moved())
        assertEquals(listOf(folder.name), PendingNotesStore.storeDirectories(noBackup).stores)
        assertEquals(listOf(1L, 0L), moved())
        val permits = PendingNotesDiscardPermits(discard, {}, atomicMove, PendingNotesStore.nioPresence)
        assertEquals(emptySet<String>(), permits.listNames())
        assertEquals(listOf(0L, 1L), moved())
        // A store folder's own listing, and a store folder shown gone while notes-pending lists, move nothing else.
        assertNotNull(PendingNotesStore.listDirectory(folder))
        assertEquals(listOf(0L, 0L), moved())
        assertTrue(PendingNotesStore.knownAbsent(File(pending, "1".repeat(64))))
        assertEquals("the listing of notes-pending only", listOf(1L, 0L), moved())

        // A listing that fails moves nothing; one the seam answers is a listing that worked.
        PendingNotesStore.listFilesForTesting = { null }
        assertNull(PendingNotesStore.listDirectory(pending))
        assertNull(PendingNotesStore.listDirectory(discard))
        assertFalse(PendingNotesStore.knownAbsent(folder))
        assertEquals(listOf(0L, 0L), moved())
        PendingNotesStore.listFilesForTesting = { d -> d.listFiles() }
        assertNotNull(PendingNotesStore.listDirectory(pending))
        assertEquals(listOf(1L, 0L), moved())
    }

    @Test fun `presenceOnDevice answers what the presence seam says first`() {
        PendingNotesStore.presenceForTesting = { f -> if (f == tmp.root) PendingNotesStore.Presence.UNKNOWN else null }
        assertEquals(PendingNotesStore.Presence.UNKNOWN, PendingNotesStore.presenceOnDevice(tmp.root))
    }

    @Test fun `a dropped store refuses everything, and the next open starts empty and takes a save`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        assertThrows("only a store discarded in full is dropped", IllegalStateException::class.java) {
            store.unregister()
        }
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        assertSame("a discarded store stays registered until it is dropped", store, open(dir))
        store.unregister()
        val next = open(dir)
        assertNotSame(store, next)
        assertEquals(UnsyncedNotes.NOTHING, next.unsynced())
        assertTrue(next.saveLocal("n1", "b1", "r1", blob("new"), isCreate = false) is SaveOutcome.Saved)
        // The dropped one refuses everything, so it can never act on the directory the new one owns.
        assertThrows(IllegalStateException::class.java) { store.unsynced() }
        assertThrows(IllegalStateException::class.java) { store.discardStore(null) }
        assertThrows(IllegalStateException::class.java) { store.clearAll() }
        assertThrows(IllegalStateException::class.java) { store.read("n1") }
        assertThrows(IllegalStateException::class.java) {
            store.saveLocal("n2", "b1", "r1", blob("late"), isCreate = false)
        }
        store.unregister()
        assertSame("a second call does nothing", next, open(dir))
        assertEquals(1, next.unsynced().count)
    }

    // ---- the store folders in notes-pending, and a store opened by its folder's name ----

    /** A store folder's name, as identityDir makes one. */
    private fun storeName(accountName: String) =
        PendingNotesStore.identityDir(tmp.root, "io.silentsuite", accountName, "gen-1").name

    /**
     * The names in [d], read from listings that must work: of [d], or of the folder above it when that listing shows
     * [d] is not there. File.exists() is not asked.
     */
    private fun namesIn(d: File): Set<String> {
        val above = d.parentFile!!.list() ?: throw AssertionError("${d.parentFile!!.name} could not be listed")
        if (d.name !in above) return emptySet()
        return (d.list() ?: throw AssertionError("${d.name} could not be listed")).toSet()
    }

    @Test fun `storeDirectories of a folder never created is empty and creates nothing`() {
        val noBackup = tmp.newFolder("no_backup")
        val folders = PendingNotesStore.storeDirectories(noBackup)
        assertEquals(emptyList<String>(), folders.stores)
        assertFalse(folders.unknown)
        assertEquals("nothing was made", emptySet<String>(), namesIn(noBackup))
    }

    @Test fun `storeDirectories keeps only lowercase 64-hex names, in order, flags any other, and asks nothing`() {
        val noBackup = tmp.newFolder("no_backup")
        val pending = File(noBackup, "notes-pending")
        val (a, b) = listOf(storeName("a"), storeName("b")).sorted()
        assertTrue(File(pending, b).mkdirs() && File(pending, a).mkdir())
        // Nothing is asked of a name: no presence check, and no listing but the one of notes-pending.
        val asked = ArrayList<String>()
        PendingNotesStore.presenceForTesting = { f -> asked += "presence ${f.name}"; null }
        // In reverse order, so the order kept is the sort's, whatever order a file system lists in.
        PendingNotesStore.listFilesForTesting = { d ->
            asked += "listing ${d.name}"
            d.listFiles()?.sortedByDescending { it.name }?.toTypedArray()
        }
        val folders = PendingNotesStore.storeDirectories(noBackup)
        assertEquals(listOf(a, b), folders.stores)
        assertFalse(folders.unknown)
        assertEquals(listOf("listing notes-pending"), asked)

        // Anything else is of a kind this build does not know: flagged, never kept, and never read as nothing.
        val hex = "0123456789abcdef".repeat(4)
        for (other in listOf("Abcdef" + hex.drop(6), hex.uppercase(), hex.drop(1), "$a.new", "$a.permit",
                "notes-discard")) {
            assertTrue(other, File(pending, other).mkdir())
            asked.clear()
            val withOther = PendingNotesStore.storeDirectories(noBackup)
            assertEquals(other, listOf(a, b), withOther.stores)
            assertTrue(other, withOther.unknown)
            assertEquals(listOf("listing notes-pending"), asked)
            assertTrue(File(pending, other).delete())
        }
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.listFilesForTesting = null

        // A plain file with a store folder's name is kept, as nothing is asked of it, and its count then says that it
        // could not be listed.
        val plain = storeName("plain")
        assertTrue(File(pending, plain).createNewFile())
        assertEquals((listOf(a, b) + plain).sorted(), PendingNotesStore.storeDirectories(noBackup).stores)
        val opened = PendingNotesStore.forNoBackupDirectory(noBackup, plain, {}, atomicMove)
        assertEquals(UnsyncedNotes(0, 0, unreadable = true, listed = false), opened.unsynced())
    }

    @Test fun `storeDirectories names every entry of another kind, sorted, whatever the entry is`() {
        val noBackup = tmp.newFolder("no_backup")
        val pending = File(noBackup, "notes-pending")
        val store = storeName("a")
        assertTrue(File(pending, store).mkdirs())
        // A plain file and a hidden one, and folders named with uppercase hex, one character short, or a suffix, one
        // of them holding a file.
        File(pending, "future.dat").writeBytes(ByteArray(4))
        File(pending, ".nomedia").writeBytes(ByteArray(0))
        val folders = listOf("0123456789ABCDEF".repeat(4), store.drop(1), "$store.new", "FUTURE")
        for (folder in folders) assertTrue(folder, File(pending, folder).mkdir())
        File(pending, "FUTURE/inside.dat").writeBytes(ByteArray(1))
        // A plain file with a store folder's name is a store: nothing is asked of a name.
        val plain = storeName("plain")
        assertTrue(File(pending, plain).createNewFile())
        // A link of another name, dangling, where this JVM may make one (Windows needs a privilege for it).
        val link = try {
            java.nio.file.Files.createSymbolicLink(File(pending, "link").toPath(), File(noBackup, "gone").toPath())
            listOf("link")
        } catch (e: java.io.IOException) {
            emptyList()
        } catch (e: UnsupportedOperationException) {
            emptyList()
        }
        // Listed in reverse order, so the order given is the sort's, whatever order a file system lists in.
        PendingNotesStore.listFilesForTesting = { d -> d.listFiles()?.sortedByDescending { it.name }?.toTypedArray() }
        val found = PendingNotesStore.storeDirectories(noBackup)
        assertEquals(listOf(store, plain).sorted(), found.stores)
        assertEquals((listOf("future.dat", ".nomedia") + folders + link).sorted(), found.others)
        assertTrue(found.unknown)
        // Shown gone, notes-pending holds none.
        assertTrue(pending.deleteRecursively())
        PendingNotesStore.listFilesForTesting = null
        assertEquals(emptyList<String>(), PendingNotesStore.storeDirectories(noBackup).others)
    }

    @Test fun `storeDirectories throws while notes-pending cannot be listed and is not shown gone`() {
        val noBackup = tmp.newFolder("no_backup")
        val pending = File(noBackup, "notes-pending")
        assertTrue(File(pending, storeName("a")).mkdirs())
        fun failing(vararg names: String): (File) -> Array<File>? =
            { d -> if (d.name in names) null else d.listFiles() }
        PendingNotesStore.listFilesForTesting = failing("notes-pending")
        assertThrows(java.io.IOException::class.java) { PendingNotesStore.storeDirectories(noBackup) }
        PendingNotesStore.listFilesForTesting = failing("notes-pending", "no_backup")
        assertThrows(java.io.IOException::class.java) { PendingNotesStore.storeDirectories(noBackup) }
        // A listing of no_backup that comes back short, without notes-pending, is no proof on its own: the presence
        // check still finds it.
        PendingNotesStore.listFilesForTesting = { d ->
            when (d.name) {
                "notes-pending" -> null
                "no_backup" -> d.listFiles()?.filter { it.name != "notes-pending" }?.toTypedArray()
                else -> d.listFiles()
            }
        }
        assertThrows(java.io.IOException::class.java) { PendingNotesStore.storeDirectories(noBackup) }
        // Not there, but the folder above cannot be listed to show it, and the one above that shows no_backup.
        assertTrue(File(pending, storeName("a")).delete() && pending.delete())
        PendingNotesStore.listFilesForTesting = failing("no_backup")
        assertThrows(java.io.IOException::class.java) { PendingNotesStore.storeDirectories(noBackup) }
        // Not there, and the folder above shows it, but the presence check fails.
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.presenceForTesting = { f -> if (f == pending) PendingNotesStore.Presence.UNKNOWN else null }
        assertThrows(java.io.IOException::class.java) { PendingNotesStore.storeDirectories(noBackup) }
        PendingNotesStore.presenceForTesting = null
        assertEquals(emptyList<String>(), PendingNotesStore.storeDirectories(noBackup).stores)
    }

    @Test fun `forDirectory and forIdentity share one instance whichever opens first`() {
        val noBackup = tmp.newFolder("no_backup")
        val byIdentity = identityStore(noBackup)
        val name = byIdentity.dir.name
        assertEquals(PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1").name,
            name)
        assertSame(byIdentity, PendingNotesStore.forNoBackupDirectory(noBackup, name, {}, atomicMove))
        PendingNotesStore.resetForTesting()
        val byFolder = PendingNotesStore.forNoBackupDirectory(noBackup, name, {}, atomicMove)
        assertNotSame(byIdentity, byFolder)
        assertSame(byFolder, identityStore(noBackup))
        assertEquals(byIdentity.dir, byFolder.dir)
    }

    @Test fun `a discard through forDirectory keeps its permit beside notes-pending`() {
        val noBackup = tmp.newFolder("no_backup")
        val name = identityStore(noBackup).dir.name
        identityStore(noBackup).saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        PendingNotesStore.resetForTesting()
        val s = PendingNotesStore.forNoBackupDirectory(noBackup, name, {}, atomicMove)
        val shown = s.unsynced()
        // Recorded at the first removal, and checked after it, so nothing is asserted inside the store.
        val atFirstRemoval = ArrayList<Pair<UnsyncedNotes?, Set<String>>>()
        PendingNotesStore.beforeRemoveForTesting = {
            if (atFirstRemoval.isEmpty()) {
                atFirstRemoval += permitsOf(s).read(name) to namesIn(File(noBackup, PendingNotesDiscardPermits.ROOT))
            }
        }
        assertEquals(DiscardOutcome.Done, s.discardStore(shown))
        assertEquals(listOf(shown to setOf("$name.permit")), atFirstRemoval)
        assertEquals("nothing else was ever put in notes-pending", emptySet<String>(), namesIn(File(noBackup,
            "notes-pending")))
        assertEquals("the permit went with the folder", emptySet<String>(), namesIn(File(noBackup,
            PendingNotesDiscardPermits.ROOT)))
    }

    @Test fun `forDirectory refuses a name that is not a store folder`() {
        val noBackup = tmp.newFolder("no_backup")
        val name = storeName("a")
        for (wrong in listOf("", ".", "..", "../x", "../$name".take(64), name.uppercase(), name.drop(1), name + "0",
                "$name/x")) {
            assertThrows(wrong, IllegalArgumentException::class.java) {
                PendingNotesStore.forNoBackupDirectory(noBackup, wrong, {}, atomicMove)
            }
        }
        assertEquals("nothing was made", emptySet<String>(), namesIn(noBackup))
    }

    // ---- one notebook: what it holds, and the discard of it after a leave or delete ----

    @Test fun `a notebook's count names only its own entries, held entries and conflict copies included`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("n2", HeldReason.READ_ONLY, now = 5))
        store.saveLocal("n3", "b2", "r1", blob("c"), isCreate = false, notebookCopy = blob("key b2"))
        conflictCopy()
        store.editorOpened("pushed")
        store.saveLocal("pushed", "b1", "r1", blob("p"), isCreate = false)
        assertEquals(SendOutcome.Done, store.completeSend("pushed", store.beginSend("pushed")!!.version, "r1",
            blob("landed")))
        assertTrue("a landed record and two notebook copies are there",
            setOf("pushed.landed", "b1.notebook", "b2.notebook").all { File(dir, it).isFile })
        val sequence = store.unsynced().sequence
        assertEquals(UnsyncedNotes(3, sequence, false, names = notes("n1", "n2", "copy1")),
            store.unsyncedInNotebook("b1"))
        assertEquals(UnsyncedNotes(1, sequence, false, names = notes("n3")), store.unsyncedInNotebook("b2"))
        assertEquals("a notebook with no entry", UnsyncedNotes.NOTHING, store.unsyncedInNotebook("b3"))
        assertThrows(IllegalArgumentException::class.java) { store.unsyncedInNotebook("../b1") }
    }

    @Test fun `an intact first write counts in the notebook its header names, and one cut short counts nowhere`() {
        store.saveLocal("waiting", "b1", "r1", blob("a"), isCreate = false)
        // Behind the store's back, all in notebook b2: an intact first write that never got its name, one cut short,
        // and an intact write beside an entry, which recovery drops unread.
        val complete = PendingEntry("stranded", "b2", PendingEntry.State.UPSERT, 9, "r9", false, blob = blob("c"))
        File(dir, "stranded.note.new").writeBytes(PendingCodec.encodeEntry(complete))
        File(dir, "cut.note.new").writeBytes(PendingCodec.encodeEntry(complete.copy(noteUid = "cut")).copyOf(20))
        File(dir, "waiting.note.new").writeBytes(PendingCodec.encodeEntry(complete.copy(noteUid = "waiting")))
        val before = filesOf(dir)
        val fresh = restarted()
        val sequence = fresh.unsynced().sequence
        assertEquals(UnsyncedNotes(1, sequence, false, names = notes("stranded")), fresh.unsyncedInNotebook("b2"))
        assertEquals("the entry's own header decides", UnsyncedNotes(1, sequence, false, names = notes("waiting")),
            fresh.unsyncedInNotebook("b1"))
        assertEquals("no recovery ran and nothing was written", before, filesOf(dir))
    }

    @Test fun `each file that cannot be placed in a notebook makes every notebook's count uncountable, and is named`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false)
        val sequence = store.unsynced().sequence
        val other = PendingEntry("n9", "b1", PendingEntry.State.UPSERT, 1, "r1", false, blob = blob("c"))
        val cases = linkedMapOf(
            "an entry whose header cannot be read" to ("damaged.note" to byteArrayOf(0)),
            "a file of a kind this build does not know" to ("n3.draft" to blob("kept by a newer build")),
            "a first write whose header cannot be read" to
                ("n4.note.new" to withFormatVersion(PendingCodec.encodeEntry(other.copy(noteUid = "n4")), 3)),
            "a name that is not an Etebase uid" to
                ("bad.uid.note" to PendingCodec.encodeEntry(other.copy(noteUid = "bad.uid"))),
            "a header that names another note" to ("n5.note" to File(dir, "n1.note").readBytes()),
        )
        for ((case, file) in cases) {
            val (name, bytes) = file
            val written = File(dir, name).also { it.writeBytes(bytes) }
            val named = name.removeSuffix(".new")
            assertEquals(case, UnsyncedNotes(2, sequence, unreadable = true, names = notes("n1") + named),
                store.unsyncedInNotebook("b1"))
            assertEquals(case, UnsyncedNotes(2, sequence, unreadable = true, names = notes("n2") + named),
                store.unsyncedInNotebook("b2"))
            assertEquals(case, UnsyncedNotes(1, sequence, unreadable = true, names = setOf(named)),
                store.unsyncedInNotebook("b3"))
            assertTrue(written.delete())
        }
        assertEquals(UnsyncedNotes(1, sequence, false, names = notes("n1")), store.unsyncedInNotebook("b1"))
    }

    @Test fun `while the store cannot be listed every notebook's count says so, and one never made counts nothing`() {
        val s = identityStore()
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        unlisted(s)
        for (notebook in listOf("b1", "b2")) {
            assertEquals(notebook, UnsyncedNotes(0, v, unreadable = true, listed = false),
                s.unsyncedInNotebook(notebook))
        }
        PendingNotesStore.listFilesForTesting = null
        val root = tmp.newFolder("never_backup")
        assertEquals(UnsyncedNotes.NOTHING, identityStore(root, creationId = "gen-2").unsyncedInNotebook("b1"))
        assertEquals("asking makes nothing", emptySet<String>(), namesIn(root))
    }

    @Test fun `a notebook's count runs no recovery, writes nothing, and withdraws the acknowledgement`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        unlisted(s)
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        PendingNotesStore.listFilesForTesting = null
        // Behind the store's back: an intact first write that recovery would commit.
        val stranded = PendingEntry("n9", "b1", PendingEntry.State.UPSERT, 9, "r9", false, blob = blob("c"))
        File(s.dir, "n9.note.new").writeBytes(PendingCodec.encodeEntry(stranded))
        val before = filesOf(s.dir)
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup)
        assertEquals(UnsyncedNotes(2, 1, false, names = notes("n1", "n9")), fresh.unsyncedInNotebook("b1"))
        assertNull("withdrawn, as a count withdraws it", permitsOf(s).acknowledgement(s.dir.name))
        assertFalse(fresh.acknowledged())
        assertEquals("no recovery ran and nothing was written in the store", before, filesOf(s.dir))

        // While the acknowledgement cannot be shown gone, a notebook could not be counted, and names what it holds.
        val record = File(permitsOf(s).root, s.dir.name + ".acknowledgement")
        assertTrue(record.mkdir() && File(record, "x").createNewFile())
        PendingNotesStore.resetForTesting()
        val stuck = identityStore(noBackup)
        assertEquals(UnsyncedNotes(2, 1, unreadable = true, names = notes("n1", "n9")), stuck.unsyncedInNotebook("b1"))
        assertEquals(UnsyncedNotes(0, 1, unreadable = true), stuck.unsyncedInNotebook("b2"))
        assertEquals(before, filesOf(s.dir))
    }

    @Test fun `a notebook's discard removes only its own readable entries, and every other file stays byte for byte`() {
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        assertEquals(PendingNotesStore.HoldOutcome.HELD, s.hold("n2", HeldReason.LOST_ACCESS, now = 5))
        s.saveLocal("n3", "b2", "r1", blob("c"), isCreate = false, notebookCopy = blob("key b2"))
        s.editorOpened("pushed")
        s.saveLocal("pushed", "b1", "r1", blob("p"), isCreate = false)
        assertEquals(SendOutcome.Done, s.completeSend("pushed", s.beginSend("pushed")!!.version, "r1", blob("landed")))
        val shown = s.unsyncedInNotebook("b1")
        val other = s.unsyncedInNotebook("b2")
        val kept = filesOf(s.dir) - setOf("n1.note", "n2.note")
        val root = File(noBackup, PendingNotesDiscardPermits.ROOT)
        val records = namesIn(root)
        assertEquals(NotebookDiscard.Done(2, 0), s.discardNotebook("b1", shown))
        assertEquals("the notebook copies, the landed record, the counter and the other notebook's entry", kept,
            filesOf(s.dir))
        assertEquals("no permit and no acknowledgement", records, namesIn(root))
        assertEquals(UnsyncedNotes.NOTHING, s.unsyncedInNotebook("b1"))
        assertEquals("the sequence did not move, so the other notebook's answer still holds", other,
            s.unsyncedInNotebook("b2"))
        assertTrue("the store stays open",
            s.saveLocal("n4", "b1", "r1", blob("d"), isCreate = false) is SaveOutcome.Saved)
    }

    @Test fun `an entry whose text cannot be read is kept, and so is one whose header cannot be read`() {
        store.saveLocal("n1", "b1", "r1", blob("one"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("two"), isCreate = false)
        // The header still reads on its own; the whole file does not.
        val file = File(dir, "n2.note")
        val damaged = file.readBytes().also { it[it.size - 6] = (it[it.size - 6].toInt() xor 0x40).toByte() }
        file.writeBytes(damaged)
        val shown = store.unsyncedInNotebook("b1")
        assertEquals("counted by its header", UnsyncedNotes(2, 2, false, names = notes("n1", "n2")), shown)
        assertEquals(NotebookDiscard.Done(1, 1), store.discardNotebook("b1", shown))
        assertArrayEquals("kept as it was", damaged, file.readBytes())
        assertEquals(Read.Missing, store.read("n1"))

        // One whose header cannot be read cannot be placed: every notebook could not be counted, and it stays too.
        store.saveLocal("n3", "b1", "r1", blob("three"), isCreate = false)
        File(dir, "n4.note").writeBytes(byteArrayOf(0))
        val uncounted = store.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(3, 3, unreadable = true, names = notes("n2", "n3", "n4")), uncounted)
        assertEquals("the discard says the notebook could not be counted", NotebookDiscard.Done(1, 1, uncounted = true),
            store.discardNotebook("b1", uncounted))
        assertEquals(setOf("n2.note", "n4.note", "sequence"), dir.list()!!.toSet())
        assertArrayEquals(damaged, file.readBytes())
        // A notebook with no entry of its own deletes nothing, and still could not be counted: n4 may be its.
        val none = store.unsyncedInNotebook("b2")
        assertEquals(UnsyncedNotes(1, 3, unreadable = true, names = notes("n4")), none)
        assertEquals(NotebookDiscard.Done(0, 0, uncounted = true), store.discardNotebook("b2", none))
        assertEquals(setOf("n2.note", "n4.note", "sequence"), dir.list()!!.toSet())
    }

    @Test fun `while the counter cannot be read a notebook could not be counted, and its discard says so`() {
        val v = saved(store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val sequence = File(dir, "sequence")
        assertTrue(sequence.delete() && sequence.mkdir())
        val shown = store.unsyncedInNotebook("b1")
        assertEquals("the instance's high-water mark for the sequence", UnsyncedNotes(1, v, unreadable = true,
            names = notes("n1")), shown)
        assertEquals("a notebook with no entry holds nothing", UnsyncedNotes.NOTHING, store.unsyncedInNotebook("b2"))
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), store.discardNotebook("b1", shown))
        assertEquals("only the counter is left", setOf("sequence"), dir.list()!!.toSet())
    }

    @Test fun `a held conflict copy takes its original with it, and one whose original cannot be read stays`() {
        val next = linkedCopyWhoseOriginalReadsAgain()
        assertEquals(PendingNotesStore.HoldOutcome.HELD, next.hold("copy1", HeldReason.NOTEBOOK_DELETED, now = 5))
        val shown = next.unsyncedInNotebook("b1")
        assertEquals(notes("copy1", "orig"), shown.names)
        // While the original cannot be removed, the copy is not removed either, so it keeps its link and is not sent.
        val files = filesOf(dir)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "orig.note") throw java.io.IOException("stopped") }
        assertEquals(NotebookDiscard.Partly(0, 2), next.discardNotebook("b1", shown))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals("both stay, byte for byte", files, filesOf(dir))
        assertEquals(NotebookDiscard.Done(1, 0), next.discardNotebook("b1", shown))
        assertTrue(next.scan().entries.isEmpty())
        assertEquals(Read.Missing, next.read("orig"))

        // The original is there, its header reads and its text does not: the copy cannot go without it, and it is
        // kept for being unreadable.
        PendingNotesStore.resetForTesting()
        val s = open(tmp.newFolder("linked"))
        s.saveLocal("orig", "b1", "r1", blob("mine"), isCreate = false)
        PendingNotesStore.beforeOriginalRemovedForTesting = { throw IllegalStateException("process died") }
        assertThrows(IllegalStateException::class.java) {
            s.replaceWithNewNote("orig", s.entry("orig").version, "srv", newNote())
        }
        PendingNotesStore.beforeOriginalRemovedForTesting = null
        val original = File(s.dir, "orig.note")
        original.writeBytes(original.readBytes().also { it[it.size - 6] = (it[it.size - 6].toInt() xor 0x40).toByte() })
        PendingNotesStore.resetForTesting()
        val after = open(s.dir)
        assertEquals("orig", after.entry("copy1").origin?.noteUid)
        val linked = after.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(2, linked.sequence, false, names = notes("copy1", "orig")), linked)
        val before = filesOf(s.dir)
        assertEquals(NotebookDiscard.Partly(0, 2), after.discardNotebook("b1", linked))
        assertEquals("both stay, byte for byte", before, filesOf(s.dir))
    }

    @Test fun `a save, a rebase or a release since the shown answer gives Changed, in this notebook or another`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false)
        fun changedBy(change: String, make: () -> Unit) {
            val shown = store.unsyncedInNotebook("b1")
            make()
            val before = filesOf(dir)
            assertEquals(change, NotebookDiscard.Changed(store.unsyncedInNotebook("b1")),
                store.discardNotebook("b1", shown))
            assertEquals("nothing was deleted: $change", before, filesOf(dir))
        }
        changedBy("a save in another notebook") {
            store.saveLocal("n2", "b2", "r2", blob("typed in the other notebook"), isCreate = false)
        }
        changedBy("a save in this one") {
            store.saveLocal("n1", "b1", "r2", blob("typed in this one"), isCreate = false)
        }
        changedBy("a new note in this one") { store.saveLocal("n3", "b1", "r1", blob("a new note"), isCreate = false) }
        changedBy("a rebase") { assertTrue(store.rebase("n1", entry("n1").version, "r2", "r3", blob("rebased"))) }
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("n1", HeldReason.READ_ONLY, now = 5))
        changedBy("a release from holding") { assertTrue(store.release("n1")) }
    }

    @Test fun `a hold, a recorded failure or a completed send since the shown answer leaves it covered`() {
        for (uid in listOf("n1", "n2", "n3")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        assertEquals(PendingNotesStore.HoldOutcome.HELD, store.hold("n1", HeldReason.NOTEBOOK_DELETED, now = 5))
        assertTrue(store.recordFailure("n2", entry("n2").version, "NETWORK", now = 6))
        assertEquals(SendOutcome.Done, store.completeSend("n3", store.beginSend("n3")!!.version, "r1", blob("landed")))
        assertEquals(NotebookDiscard.Done(2, 0), store.discardNotebook("b1", shown))
        assertEquals(UnsyncedNotes.NOTHING, store.unsyncedInNotebook("b1"))
    }

    @Test fun `a confirmation given while the store could not be listed deletes nothing of a notebook once it lists`() {
        val s = identityStore()
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        unlisted(s)
        val shown = s.unsyncedInNotebook("b1")
        val empty = s.unsyncedInNotebook("b2")
        assertFalse(shown.listed || empty.listed)
        PendingNotesStore.listFilesForTesting = null
        val before = filesOf(s.dir)
        assertEquals("asked again with the real count", NotebookDiscard.Changed(s.unsyncedInNotebook("b1")),
            s.discardNotebook("b1", shown))
        assertEquals("nothing of that notebook is there", NotebookDiscard.Done(0, 0), s.discardNotebook("b2", empty))
        assertEquals("nothing was deleted, byte for byte", before, filesOf(s.dir))
    }

    @Test fun `while the store cannot be listed a notebook's discard deletes and records nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val before = filesOf(s.dir)
        val root = File(noBackup, PendingNotesDiscardPermits.ROOT)
        val records = namesIn(root)
        unlisted(s)
        val shown = s.unsyncedInNotebook("b1")
        assertEquals(NotebookDiscard.NotListed, s.discardNotebook("b1", shown))
        assertEquals("no acknowledgement", RemovalCheck.Unlisted, s.removalCheck())
        // A new instance runs its recovery first, which cannot list the store, so it throws before anything goes.
        PendingNotesStore.resetForTesting()
        val fresh = identityStore(noBackup)
        assertThrows(java.io.IOException::class.java) { fresh.discardNotebook("b1", shown) }
        assertEquals(RemovalCheck.Unlisted, fresh.removalCheck())
        PendingNotesStore.listFilesForTesting = null
        assertEquals("nothing was deleted, byte for byte", before, filesOf(s.dir))
        assertEquals("and nothing was recorded", records, namesIn(root))
    }

    /** Records every listing and permit read, and fails any record or withdrawal, while [block] runs. */
    private fun <T> unseen(block: () -> T): Triple<T, List<String>, List<String>> {
        val listed = ArrayList<String>()
        val read = ArrayList<String>()
        PendingNotesStore.listFilesForTesting = { d -> listed += d.path; d.listFiles() }
        PendingNotesDiscardPermits.onReadForTesting = { read += it.name }
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw AssertionError("a record of ${it.name}") }
        PendingNotesDiscardPermits.beforeDeleteForTesting = { throw AssertionError("a withdrawal of ${it.name}") }
        try {
            return Triple(block(), listed, read)
        } finally {
            PendingNotesStore.listFilesForTesting = null
            PendingNotesDiscardPermits.onReadForTesting = null
            PendingNotesDiscardPermits.beforeRecordForTesting = null
            PendingNotesDiscardPermits.beforeDeleteForTesting = null
        }
    }

    /**
     * Store A's folder made a link to [target], given store B beside it, which holds a saved note in notebook b1, and
     * A acknowledged. A notebook's count lists nothing, reads nothing (B's counter included, so the sequence is A's
     * own 0), reads no permit, records and withdraws nothing, and changes nothing on disk, B and the target included:
     * for every notebook it could not be counted and is not listed, in a new instance as well. A's discard throws for
     * every confirmation, B's own count of b1 included, and changes nothing.
     */
    private fun assertNotebookNeverFollowsLink(target: (PendingNotesStore) -> File) {
        identifyWithoutFollowing()
        val noBackup = tmp.newFolder("no_backup")
        val b = identityStore(noBackup, creationId = "gen-2")
        b.saveLocal("n1", "b1", "r1", blob("B's own note"), isCreate = false, notebookCopy = blob("key b1"))
        val bCount = b.unsyncedInNotebook("b1")
        val to = target(b)
        val folder = PendingNotesStore.identityDir(noBackup, "io.silentsuite", "alice@example.invalid", "gen-1")
        linked(folder, to)
        val a = identityStore(noBackup)
        assertEquals(DiscardOutcome.Acknowledged, a.discardStore(a.unsynced()))
        val before = treeOf(noBackup) + treeOf(to)
        val unlistedLink = UnsyncedNotes(0, 0, unreadable = true, listed = false)
        for (s in listOf(a, PendingNotesStore.resetForTesting().let { identityStore(noBackup) })) {
            val (answers, listed, read) = unseen { listOf("b1", "b2").map { s.unsyncedInNotebook(it) } }
            assertEquals(listOf(unlistedLink, unlistedLink), answers)
            assertEquals("nothing is listed", emptyList<String>(), listed)
            assertEquals("no permit or acknowledgement is read", emptyList<String>(), read)
            for (confirmed in listOf(answers[0], bCount)) {
                val (thrown, discardListed, discardRead) = unseen {
                    assertThrows(java.io.IOException::class.java) { s.discardNotebook("b1", confirmed) }
                }
                assertNotNull(thrown)
                assertEquals("nothing is listed", emptyList<String>(), discardListed)
                assertEquals("nothing is read", emptyList<String>(), discardRead)
            }
            assertEquals("nothing changes on disk", before, treeOf(noBackup) + treeOf(to))
            assertTrue("the acknowledgement still holds", s.acknowledged())
        }
        assertEquals("B's count", bCount, b.unsyncedInNotebook("b1"))
        assertTrue("the link is still a link", Files.isSymbolicLink(folder.toPath()))
    }

    @Test fun `a notebook's count and discard of a store folder that is a link to another store follow nothing`() =
        assertNotebookNeverFollowsLink { b -> b.dir }

    @Test fun `a notebook's count and discard of a store folder that is a link to a file follow nothing`() =
        assertNotebookNeverFollowsLink { tmp.newFile("plain").also { it.writeBytes(blob("not a store")) } }

    @Test fun `a notebook's count and discard of a store folder that is a link to nothing follow nothing`() =
        assertNotebookNeverFollowsLink { File(tmp.root, "missing") }

    @Test fun `a notebook's count of a store folder whose lstat cannot tell lists, reads and withdraws nothing`() {
        identifyDirectories()
        val noBackup = tmp.newFolder("no_backup")
        val s = identityStore(noBackup)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false, notebookCopy = blob("key b1"))
        val v = saved(s.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false))
        val counted = s.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), counted)
        val asked = HashSet<String>()
        PendingNotesStore.linkForTesting = { d -> asked += d.path; null }
        assertEquals(DiscardOutcome.Acknowledged, s.discardStore(s.unsynced()))
        val before = treeOf(noBackup)
        val (answers, listed, read) = unseen { listOf("b1", "b2").map { s.unsyncedInNotebook(it) } }
        assertEquals("the instance's own sequence", List(2) { UnsyncedNotes(0, v, unreadable = true, listed = false) },
            answers)
        assertEquals("nothing is listed", emptyList<String>(), listed)
        assertEquals("no permit or acknowledgement is read", emptyList<String>(), read)
        for (confirmed in listOf(answers[0], counted)) {
            assertThrows(java.io.IOException::class.java) { unseen { s.discardNotebook("b1", confirmed) } }
        }
        assertEquals("nothing changes on disk", before, treeOf(noBackup))
        assertTrue("the acknowledgement still holds", s.acknowledged())
        assertEquals("only the store's own folder was asked about", setOf(s.dir.path), asked)

        // Once lstat tells, the folder is followed: the count withdraws the acknowledgement, and the discard goes.
        PendingNotesStore.linkForTesting = null
        assertEquals(counted, s.unsyncedInNotebook("b1"))
        assertFalse(s.acknowledged())
        assertEquals(NotebookDiscard.Done(1, 0), s.discardNotebook("b1", counted))
    }

    @Test fun `a removal that fails keeps that entry while the others go, and the same confirmation finishes later`() {
        val failures = listOf(java.io.IOException("could not remove it"), IllegalStateException("a removal that broke"))
        for ((n, failure) in failures.withIndex()) {
            val s = open(tmp.newFolder("store$n"))
            for (uid in listOf("n1", "n2", "n3")) s.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
            val shown = s.unsyncedInNotebook("b1")
            PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw failure }
            assertEquals("$failure", NotebookDiscard.Partly(2, 1), s.discardNotebook("b1", shown))
            PendingNotesStore.beforeRemoveForTesting = null
            assertEquals("$failure", setOf("n2.note", "sequence"), s.dir.list()!!.toSet())
            assertEquals("$failure", NotebookDiscard.Done(1, 0), s.discardNotebook("b1", shown))
            assertEquals("$failure", setOf("sequence"), s.dir.list()!!.toSet())
        }
    }

    @Test fun `running out of memory on one entry keeps it and the rest, and nothing is thrown`() {
        for (uid in listOf("n1", "n2", "n3")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n2.note") throw OutOfMemoryError("a large entry") }
        assertEquals(NotebookDiscard.Partly(1, 2), store.discardNotebook("b1", shown))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(setOf("n2.note", "n3.note", "sequence"), dir.list()!!.toSet())
        assertEquals(NotebookDiscard.Done(2, 0), store.discardNotebook("b1", shown))
    }

    @Test fun `a cleared store counts a notebook from disk and refuses its discard, and a dropped one refuses both`() {
        store.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        PendingNotesStore.beforeClearForTesting = { throw java.io.IOException("could not clear the pending store") }
        assertThrows(java.io.IOException::class.java) { store.clearAll() }
        PendingNotesStore.beforeClearForTesting = null
        val left = store.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(1, 1, false, names = notes("n1")), left)
        val before = filesOf(dir)
        assertThrows(PendingNotesStore.Cleared::class.java) { store.discardNotebook("b1", left) }
        assertEquals(before, filesOf(dir))

        val other = open(tmp.newFolder("other"))
        other.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        assertEquals(DiscardOutcome.Done, other.discardStore(other.unsynced()))
        other.unregister()
        assertThrows(IllegalStateException::class.java) { other.unsyncedInNotebook("b1") }
        assertThrows(IllegalStateException::class.java) { other.discardNotebook("b1", UnsyncedNotes.NOTHING) }
    }

    @Test fun `a save that holds the lock first is seen as Changed by a notebook's discard`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        val inSave = java.util.concurrent.CountDownLatch(1)
        val finishSave = java.util.concurrent.CountDownLatch(1)
        // The save stops at its first rename, the counter's, while it holds the lock.
        PendingNotesStore.beforeRenameForTesting = { target ->
            if (target.name == "sequence" && inSave.count > 0) {
                inSave.countDown()
                finishSave.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        var saved: SaveOutcome? = null
        val saving = kotlin.concurrent.thread {
            saved = store.saveLocal("n1", "b1", "r2", blob("typed while the question was open"), isCreate = false)
        }
        var outcome: NotebookDiscard? = null
        var discarding: Thread? = null
        try {
            assertTrue(inSave.await(10, java.util.concurrent.TimeUnit.SECONDS))
            val thread = kotlin.concurrent.thread { outcome = store.discardNotebook("b1", shown) }
            discarding = thread
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
            while (thread.state != Thread.State.BLOCKED) {
                assertTrue("the discard waits for the lock the save holds", System.nanoTime() < deadline)
                Thread.sleep(1)
            }
        } finally {
            // On every path, so that neither thread outlives this test and meets the next one's seams.
            finishSave.countDown()
            saving.join(10_000)
            discarding?.join(10_000)
            PendingNotesStore.beforeRenameForTesting = null
        }
        assertTrue(saved is SaveOutcome.Saved)
        assertEquals(NotebookDiscard.Changed(store.unsyncedInNotebook("b1")), outcome)
        assertArrayEquals(blob("typed while the question was open"), entry("n1").blob)
    }

    @Test fun `a notebook's count whose listing lacks the counter could not be counted, and its discard deletes only what that listing placed`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val v = saved(store.saveLocal("n3", "b2", "r1", blob("c"), isCreate = false))
        val counted = store.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(2, v, false, names = notes("n1", "n2")), counted)
        val before = filesOf(dir)
        // A listing that comes back with nothing, and says nothing, while the counter is there by path.
        listingKeeps(store)
        for (notebook in listOf("b1", "b2", "b3")) {
            assertEquals(notebook, UnsyncedNotes(0, v, unreadable = true), store.unsyncedInNotebook(notebook))
        }
        val empty = store.unsyncedInNotebook("b1")
        assertEquals("the counted answer covers none that could not be counted", NotebookDiscard.Changed(empty),
            store.discardNotebook("b1", counted))
        assertEquals(NotebookDiscard.Done(0, 0, uncounted = true), store.discardNotebook("b1", empty))
        PendingNotesStore.listFilesForTesting = null
        assertEquals("nothing was deleted, byte for byte", before, filesOf(dir))
        // One that stopped after n1.note, before n2.note and the counter.
        listingKeeps(store, "n1.note")
        val short = store.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(1, v, unreadable = true, names = notes("n1")), short)
        assertEquals(UnsyncedNotes(0, v, unreadable = true), store.unsyncedInNotebook("b2"))
        assertEquals("only what that listing placed goes", NotebookDiscard.Done(1, 0, uncounted = true),
            store.discardNotebook("b1", short))
        PendingNotesStore.listFilesForTesting = null
        assertEquals("every other file stays, byte for byte", before - "n1.note", filesOf(dir))
    }

    @Test fun `a lost counter, a store never made and an empty folder are no short listing for a notebook, and a counter check that fails is no absence`() {
        val noBackup = tmp.newFolder("no_backup")
        assertEquals("a store never made", UnsyncedNotes.NOTHING,
            identityStore(noBackup, "gen-never").unsyncedInNotebook("b1"))
        val empty = identityStore(noBackup, "gen-empty")
        assertTrue(empty.dir.mkdirs())
        assertEquals("an empty folder", UnsyncedNotes.NOTHING, empty.unsyncedInNotebook("b1"))
        val s = identityStore(noBackup)
        val v = saved(s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false))
        val counter = File(s.dir, "sequence")
        // Its listing leaves out the counter, and the counter's check fails: that is no absence.
        PendingNotesStore.listFilesForTesting = { d ->
            if (d.name == s.dir.name) d.listFiles()?.filter { it.name != "sequence" }?.toTypedArray() else d.listFiles()
        }
        PendingNotesStore.presenceForTesting = { f -> if (f == counter) PendingNotesStore.Presence.UNKNOWN else null }
        assertEquals(UnsyncedNotes(1, v, unreadable = true, names = notes("n1")), s.unsyncedInNotebook("b1"))
        // With the counter shown absent, as for one lost after the listing, the notebook is counted.
        PendingNotesStore.presenceForTesting = { f -> if (f == counter) PendingNotesStore.Presence.ABSENT else null }
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), s.unsyncedInNotebook("b1"))
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.listFilesForTesting = null
        // A counter that is lost: counted from its listing, as before, and its discard finishes.
        assertTrue(counter.delete())
        val lost = s.unsyncedInNotebook("b1")
        assertEquals(UnsyncedNotes(1, v, false, names = notes("n1")), lost)
        assertEquals(NotebookDiscard.Done(1, 0), s.discardNotebook("b1", lost))
    }

    @Test fun `a notebook's discard lists again, and what the first listing left out stays and is reported`() {
        for (uid in listOf("n1", "n2")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        assertEquals(notes("n1", "n2"), shown.names)
        val n2 = File(dir, "n2.note").readBytes()
        // Only the discard's own count leaves out n2.note, and it still lists the counter.
        var listings = 0
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (d.name == dir.name && listings++ == 0) all?.filter { it.name != "n2.note" }?.toTypedArray() else all
        }
        assertEquals("n2 stays, and is not said to be gone", NotebookDiscard.Partly(1, 1),
            store.discardNotebook("b1", shown))
        assertEquals("the discard's two listings", 2, listings)
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n2.note", "sequence"), dir.list()!!.toSet())
        assertArrayEquals("nothing more was deleted for it", n2, File(dir, "n2.note").readBytes())

        // A second listing that comes back with nothing cannot count the notebook, and the discard says so. The read
        // runs the recovery the removal left owed, so that only the discard lists below.
        val again = store.unsyncedInNotebook("b1")
        assertTrue(store.read("n2") is Read.Present)
        listings = 0
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (d.name == dir.name && listings++ > 0) emptyArray() else all
        }
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), store.discardNotebook("b1", again))
        PendingNotesStore.listFilesForTesting = null

        // A removal that fails keeps its entry and gives Partly by itself, also when the second listing leaves it out.
        for (uid in listOf("n3", "n4", "n5")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val three = store.unsyncedInNotebook("b1")
        listings = 0
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (d.name == dir.name && listings++ > 0) all?.filter { it.name != "n4.note" }?.toTypedArray() else all
        }
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n4.note") throw java.io.IOException("stopped") }
        assertEquals(NotebookDiscard.Partly(2, 1), store.discardNotebook("b1", three))
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n4.note", "sequence"), dir.list()!!.toSet())
    }

    @Test fun `a discard whose two listings leave out a confirmed entry finds it by path, and never says it went`() {
        fun leaveOut(name: String, folder: File = dir) {
            PendingNotesStore.listFilesForTesting = { d ->
                val all = d.listFiles()
                if (d.name == folder.name) all?.filter { it.name != name }?.toTypedArray() else all
            }
        }
        for (uid in listOf("n1", "n2")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val shown = store.unsyncedInNotebook("b1")
        val n2 = File(dir, "n2.note").readBytes()
        leaveOut("n2.note")
        assertEquals("n2 stays, and is not said to be gone", NotebookDiscard.Partly(1, 1),
            store.discardNotebook("b1", shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n2.note", "sequence"), dir.list()!!.toSet())
        assertArrayEquals("nothing more was deleted for it", n2, File(dir, "n2.note").readBytes())

        // With the only entry left out the notebook reads as holding nothing, and that is not taken for gone.
        val alone = store.unsyncedInNotebook("b1")
        assertEquals(notes("n2"), alone.names)
        leaveOut("n2.note")
        assertEquals(NotebookDiscard.Partly(0, 1), store.discardNotebook("b1", alone))
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(n2, File(dir, "n2.note").readBytes())

        // Gone from the folder and from both listings: a look that fails counts as there, and only one shown absent is gone.
        assertTrue(File(dir, "n2.note").delete())
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == "n2.note") PendingNotesStore.Presence.UNKNOWN else null
        }
        assertEquals(NotebookDiscard.Partly(0, 1), store.discardNotebook("b1", alone))
        PendingNotesStore.presenceForTesting = null
        assertEquals(NotebookDiscard.Done(0, 0), store.discardNotebook("b1", alone))

        // A first write that stopped before its rename counts under its entry's name, and is found as that write.
        val d = tmp.newFolder("left-out-first-write")
        val s = PendingNotesStore.open(d, rename = atomicMove)
        s.saveLocal("n3", "b1", "r1", blob("c"), isCreate = false)
        val first = PendingEntry("n4", "b1", PendingEntry.State.UPSERT, 1, "r1", false, blob = blob("d"))
        File(d, "n4.note.new").writeBytes(PendingCodec.encodeEntry(first))
        val both = s.unsyncedInNotebook("b1")
        assertEquals(notes("n3", "n4"), both.names)
        leaveOut("n4.note.new", d)
        assertEquals(NotebookDiscard.Partly(1, 1), s.discardNotebook("b1", both))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n4.note.new", "sequence"), d.list()!!.toSet())

        // A first write cut short shows nothing of its entry, so the entry left out beside it is still looked up.
        val b = tmp.newFolder("left-out-beside-cut-write")
        val r = PendingNotesStore.open(b, rename = atomicMove)
        for (uid in listOf("n7", "n8")) r.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val beside = r.unsyncedInNotebook("b1")
        File(b, "n8.note.new").writeBytes(byteArrayOf(0))
        leaveOut("n8.note", b)
        assertEquals(NotebookDiscard.Partly(1, 1), r.discardNotebook("b1", beside))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n8.note", "n8.note.new", "sequence"), b.list()!!.toSet())

        // A link that takes the folder's place during the discard: n6 counts, not looked up, and n5, which went, does not.
        val e = tmp.newFolder("left-out-link")
        val t = PendingNotesStore.open(e, rename = atomicMove)
        for (uid in listOf("n5", "n6")) t.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val linked = t.unsyncedInNotebook("b1")
        leaveOut("n6.note", e)
        val asked = ArrayList<String>()
        PendingNotesStore.presenceForTesting = { f ->
            asked += f.name
            null
        }
        PendingNotesStore.beforeRemoveForTesting = { PendingNotesStore.linkForTesting = { true } }
        assertEquals(NotebookDiscard.Partly(1, 1), t.discardNotebook("b1", linked))
        assertFalse("nothing is looked up through it", "n6.note" in asked)
    }

    @Test fun `a discard's second listing reports what the confirmation does not name, and a file it cannot place stays uncounted`() {
        // The shown count and the discard's own both leave out n2.note, so only the second listing shows it.
        for (uid in listOf("n1", "n2")) store.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        var hidden = 2
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (d.name == dir.name && hidden-- > 0) all?.filter { it.name != "n2.note" }?.toTypedArray() else all
        }
        val shown = store.unsyncedInNotebook("b1")
        assertEquals(notes("n1"), shown.names)
        assertEquals("n2 is reported, though nothing names it", NotebookDiscard.Partly(1, 1),
            store.discardNotebook("b1", shown))
        PendingNotesStore.listFilesForTesting = null
        assertEquals(setOf("n2.note", "sequence"), dir.list()!!.toSet())

        // n4 is named and left out of the discard's own count, and its second listing cannot place it: the file stays,
        // which Done's uncounted says, and it is not a Partly as well.
        val d = tmp.newFolder("second-listing-cannot-place")
        val s = PendingNotesStore.open(d, rename = atomicMove)
        for (uid in listOf("n3", "n4")) s.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        val named = s.unsyncedInNotebook("b1")
        assertEquals(notes("n3", "n4"), named.names)
        val damaged = byteArrayOf(0)
        File(d, "n4.note").writeBytes(damaged)
        hidden = 1
        PendingNotesStore.listFilesForTesting = { f ->
            val all = f.listFiles()
            if (f.name == d.name && hidden-- > 0) all?.filter { it.name != "n4.note" }?.toTypedArray() else all
        }
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), s.discardNotebook("b1", named))
        PendingNotesStore.listFilesForTesting = null
        assertArrayEquals(damaged, File(d, "n4.note").readBytes())

        // n6 the other way round: the discard's own count cannot place it, and its second listing leaves it out.
        val e = tmp.newFolder("first-listing-cannot-place")
        val t = PendingNotesStore.open(e, rename = atomicMove)
        for (uid in listOf("n5", "n6")) t.saveLocal(uid, "b1", "r1", blob(uid), isCreate = false)
        File(e, "n6.note").writeBytes(damaged)
        val uncounted = t.unsyncedInNotebook("b1")
        assertEquals(notes("n5", "n6"), uncounted.names)
        var listings = 0
        PendingNotesStore.listFilesForTesting = { f ->
            val all = f.listFiles()
            if (f.name == e.name && listings++ > 0) all?.filter { it.name != "n6.note" }?.toTypedArray() else all
        }
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), t.discardNotebook("b1", uncounted))
        PendingNotesStore.listFilesForTesting = null

        // A first write that cannot be placed is listed under its own name and named under its entry's.
        val g = tmp.newFolder("first-write-cannot-place")
        val u = PendingNotesStore.open(g, rename = atomicMove)
        u.saveLocal("n7", "b1", "r1", blob("g"), isCreate = false)
        val other = PendingEntry("n9", "b1", PendingEntry.State.UPSERT, 1, "r1", false, blob = blob("h"))
        File(g, "n8.note.new").writeBytes(PendingCodec.encodeEntry(other))
        val written = u.unsyncedInNotebook("b1")
        assertEquals(notes("n7", "n8"), written.names)
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), u.discardNotebook("b1", written))
        assertEquals(setOf("n8.note.new", "sequence"), g.list()!!.toSet())

        // A file of a kind this build does not know is listed and named by the same name, whatever it ends in.
        val h = tmp.newFolder("unknown-kind-write")
        val w = PendingNotesStore.open(h, rename = atomicMove)
        w.saveLocal("n9", "b1", "r1", blob("i"), isCreate = false)
        File(h, "x.draft.new").writeBytes(blob("a newer build's"))
        val kinds = w.unsyncedInNotebook("b1")
        assertEquals(notes("n9") + "x.draft.new", kinds.names)
        assertEquals(NotebookDiscard.Done(1, 0, uncounted = true), w.discardNotebook("b1", kinds))
        assertEquals(setOf("x.draft.new", "sequence"), h.list()!!.toSet())
    }

    @Test fun `a discard looks up no confirmed name that a listing shows in another notebook`() {
        store.saveLocal("n1", "b2", "r1", blob("a"), isCreate = false)
        assertEquals("not this notebook's now", NotebookDiscard.Done(0, 0),
            store.discardNotebook("b1", UnsyncedNotes(1, 1, unreadable = false, names = notes("n1"))))
        assertTrue(File(dir, "n1.note").exists())

        // The same for a first write, which a listing shows by its own name and the confirmation names by its entry's.
        val d = tmp.newFolder("first-write-elsewhere")
        val s = PendingNotesStore.open(d, rename = atomicMove)
        s.saveLocal("n3", "b2", "r1", blob("c"), isCreate = false)
        val first = PendingEntry("n2", "b2", PendingEntry.State.UPSERT, 1, "r1", false, blob = blob("b"))
        File(d, "n2.note.new").writeBytes(PendingCodec.encodeEntry(first))
        assertEquals(NotebookDiscard.Done(0, 0),
            s.discardNotebook("b1", UnsyncedNotes(1, 1, unreadable = false, names = notes("n2"))))
        assertTrue(File(d, "n2.note.new").exists())
    }

    @Test fun `a removal that failed after its unlink never says nothing was deleted, and Done waits for the sync it owes`() {
        var failing = 0
        val syncs = ArrayList<String>()
        val s = PendingNotesStore.open(dir, syncDirectory = { d ->
            syncs += d.name
            if (failing > 0) {
                failing--
                throw java.io.IOException("could not sync the store's directory")
            }
        }, rename = atomicMove)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        s.saveLocal("n2", "b2", "r1", blob("b"), isCreate = false)
        val shown = s.unsyncedInNotebook("b1")
        // The sync right after n1.note's unlink fails: the entry is gone from the folder, and that may not last.
        failing = 1
        assertEquals(NotebookDiscard.Partly(0, 1, unsure = true), s.discardNotebook("b1", shown))
        assertEquals(setOf("n2.note", "sequence"), dir.list()!!.toSet())
        // The same confirmation again finds nothing left in the notebook, and is Done only once that sync worked.
        failing = 1
        syncs.clear()
        assertEquals(NotebookDiscard.Partly(0, 0, unsure = true), s.discardNotebook("b1", shown))
        assertEquals(listOf(dir.name), syncs)
        syncs.clear()
        assertEquals(NotebookDiscard.Done(0, 0), s.discardNotebook("b1", shown))
        assertEquals("the sync it owed", listOf(dir.name), syncs)
        syncs.clear()
        assertEquals("and none once nothing is owed", NotebookDiscard.Done(0, 0), s.discardNotebook("b1", shown))
        assertEquals(emptyList<String>(), syncs)

        // A conflict copy whose removal fails after its original went is not said to have deleted nothing either.
        PendingNotesStore.resetForTesting()
        val next = linkedCopyWhoseOriginalReadsAgain()
        assertEquals(PendingNotesStore.HoldOutcome.HELD, next.hold("copy1", HeldReason.NOTEBOOK_DELETED, now = 5))
        val linked = next.unsyncedInNotebook("b1")
        assertEquals(notes("copy1", "orig"), linked.names)
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "copy1.note") throw java.io.IOException("stopped") }
        assertEquals(NotebookDiscard.Partly(0, 1, unsure = true), next.discardNotebook("b1", linked))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals("the original went, and the copy stays", setOf("copy1.note", "n2.note"),
            dir.list()!!.filter { it.endsWith(".note") }.toSet())
    }

    @Test fun `an Error right after an unlink ends a notebook's discard as Partly unsure, is never thrown, and the same confirmation finishes`() {
        var failing: Throwable? = null
        val s = PendingNotesStore.open(dir, syncDirectory = { d ->
            val error = failing
            if (error != null && d.name == dir.name && "n1.note" !in dir.list()!!) {
                failing = null
                throw error
            }
        }, rename = atomicMove)
        s.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        s.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val shown = s.unsyncedInNotebook("b1")
        // The sync right after n1.note's unlink runs out of memory: n1 is gone from the folder, and n2 was not tried.
        failing = OutOfMemoryError("the sync after an unlink")
        assertEquals(NotebookDiscard.Partly(0, 2, unsure = true), s.discardNotebook("b1", shown))
        assertEquals(null, failing)
        assertEquals(setOf("n2.note", "sequence"), dir.list()!!.toSet())
        assertEquals(NotebookDiscard.Done(1, 0), s.discardNotebook("b1", shown))
        assertEquals(setOf("sequence"), dir.list()!!.toSet())
    }

    @Test fun `outside the store's package only the sign-out seam and the Settings discard call discardStore`() {
        // A discard deletes unsynced text, so each caller comes with a change and a review of its own. Any code
        // line that names the function counts, so a call inside a scope function or a reference is found too;
        // comment and KDoc lines, which only link to it, do not.
        val main = File("src/main/java")
        fun callersOf(name: String): List<String> {
            val word = Regex("\\b$name\\b")
            return main.walk().filter { it.isFile && it.extension in setOf("kt", "java") }
                .filter { file ->
                    file.readLines().any { line ->
                        val code = line.trim()
                        !code.startsWith("*") && !code.startsWith("/*") && !code.startsWith("//") &&
                            word.containsMatchIn(line)
                    }
                }
                .map { it.relativeTo(main).invariantSeparatorsPath }
                .filterNot { it.startsWith("io/silentsuite/sync/notes/edit/") }.sorted().toList()
        }
        assertTrue("the store defines it",
            File(main, "io/silentsuite/sync/notes/edit/PendingNotesStore.kt").readText().contains("fun discardStore("))
        // Sorted, since the order of the walk is not defined.
        val signOut = "io/silentsuite/sync/ui/AndroidCurrentAccountSignOut.kt"
        val settings = "io/silentsuite/sync/ui/UnsyncedNotesStores.kt"
        assertEquals(listOf(signOut, settings), callersOf("discardStore"))
        // The sign-out drops its instance after a removal that failed, Settings only one that its own discard alone
        // finished.
        assertEquals(listOf(signOut), callersOf("unregister"))
        assertEquals(listOf(settings), callersOf("unregisterIfFinishedOnce"))
        // The Settings way out, and a notebook's leave or delete before it words a failure of its server call.
        val notebook = "io/silentsuite/sync/ui/etebase/NotebookLeaveOrDelete.kt"
        assertEquals("only these ask whether a discard stopped", listOf(settings, notebook), callersOf("clearStopped"))
        // The removal guard also reads from memory which stores stopped.
        val guard = "io/silentsuite/sync/ui/PendingNotesRemovalGuard.kt"
        assertEquals(listOf(guard, settings, notebook), callersOf("stoppedIn"))
        assertEquals("clearAll is for test teardown only", emptyList<String>(), callersOf("clearAll"))
        assertEquals("a notebook's leave or delete only",
            listOf("io/silentsuite/sync/ui/etebase/NotebookLeaveOrDelete.kt"), callersOf("discardNotebook"))
    }
}
