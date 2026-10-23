package io.silentsuite.sync.notes.edit

import io.silentsuite.sync.notes.edit.PendingNotesStore.Read
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.notes.edit.PendingNotesStore.SendOutcome
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

class PendingNotesDiscardPermitsTest {
    @get:Rule val tmp = TemporaryFolder()

    /** As in PendingNotesStoreTest: replaces the target in one step on Windows too. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    /** The store's own presence check on the JVM. */
    private val presence = PendingNotesStore.nioPresence

    /** The app's no-backup directory: the stores under notes-pending, their permits under notes-discard. */
    private val root by lazy { tmp.newFolder("no_backup") }
    private val permits by lazy { PendingNotesDiscardPermits(File(root, "notes-discard"), {}, atomicMove, presence) }

    /** A reader of its own, as after a restart. */
    private fun freshPermits() = PendingNotesDiscardPermits(File(root, "notes-discard"), {}, atomicMove, presence)

    private fun storeOf(
        type: String = "io.silentsuite",
        name: String = "alice@example.invalid",
        creationId: String = "gen-1",
    ) = PendingNotesStore.open(PendingNotesStore.identityDir(root, type, name, creationId), rename = atomicMove,
        permits = permits)

    private val store by lazy { storeOf() }

    /** A process restart: every instance is forgotten, and the files and the permits stay. */
    private fun restarted(): PendingNotesStore {
        PendingNotesStore.resetForTesting()
        return storeOf()
    }

    private fun blob(text: String) = text.toByteArray()

    private fun saved(outcome: SaveOutcome) = (outcome as SaveOutcome.Saved).version

    /** Every file of [d] with its bytes, read without the store. */
    private fun filesOf(d: File) = d.listFiles()!!.associate { it.name to it.readBytes().toList() }

    @After fun reset() {
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        PendingNotesDiscardPermits.beforeDeleteForTesting = null
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.presenceForTesting = null
        PendingNotesStore.resetForTesting()
    }

    @Test fun `a permit reads back as it was recorded, under its own store's name alone`() {
        val shown = UnsyncedNotes(2, 7, false, names = setOf("n1.note", "n2.note"))
        assertNull("none before one is recorded", permits.read("store-a"))
        permits.record("store-a", shown)
        assertEquals(shown, permits.read("store-a"))
        assertEquals("read by a reader of its own, as after a restart", shown, freshPermits().read("store-a"))
        assertEquals("one file, named by its store", listOf("store-a.permit"), permits.root.list()!!.toList())
        assertArrayEquals(PendingCodec.encodePermit("store-a", shown), File(permits.root, "store-a.permit").readBytes())
        assertNull("another store has none", permits.read("store-b"))

        val uncounted = UnsyncedNotes(3, 0, unreadable = true, names = setOf("n1.note", "n2.draft"))
        permits.record("store-a", uncounted)
        assertEquals("a second record takes the place of the first", uncounted, permits.read("store-a"))
        assertThrows("never one for a store that could not be listed", IllegalArgumentException::class.java) {
            permits.record("store-a", UnsyncedNotes(0, 7, unreadable = true, listed = false))
        }
        assertEquals(uncounted, permits.read("store-a"))
        permits.remove("store-a")
        assertNull(permits.read("store-a"))
        permits.remove("store-a")
        assertTrue("a permit that is not there is removed already", permits.root.list()!!.isEmpty())

        for (name in listOf("", ".", "..", "../x", "a/b", "x.permit")) {
            assertThrows(name, IllegalArgumentException::class.java) { permits.record(name, shown) }
        }
        assertEquals(listOf("notes-discard"), root.list()!!.toList())
    }

    @Test fun `a permit cut short, failing its checksum, in a newer format or naming another store is no permit`() {
        val bytes = PendingCodec.encodePermit("store-a", UnsyncedNotes(2, 7, false))
        val file = File(permits.root.also { assertTrue(it.mkdirs()) }, "store-a.permit")
        for (length in 0 until bytes.size) {
            file.writeBytes(bytes.copyOf(length))
            assertNull("cut to $length", permits.read("store-a"))
        }
        for (i in bytes.indices) {
            file.writeBytes(bytes.copyOf().also { it[i] = (it[i].toInt() xor 0x40).toByte() })
            assertNull("byte $i", permits.read("store-a"))
        }
        file.writeBytes(withFormatVersion(bytes, 2))
        assertNull("a newer format", permits.read("store-a"))
        file.writeBytes(PendingCodec.encodePermit("store-b", UnsyncedNotes(2, 7, false)))
        assertNull("another store's permit under this store's name", permits.read("store-a"))
        assertTrue(file.delete() && file.mkdir())
        assertNull("one that cannot be read", permits.read("store-a"))
    }

    @Test fun `a permit covers the store as shown across a restart, and a change pushed since does not end it`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        store.saveLocal("n2", "b1", "r1", blob("b"), isCreate = false)
        val shown = store.unsynced()
        permits.record(store.dir.name, shown)

        val again = restarted()
        val permit = freshPermits().read(again.dir.name)!!
        assertTrue(permit.covers(again.unsynced()))
        assertTrue("asking does not use it up", permit.covers(again.unsynced()))
        // A push hands out no new version, so the permit stays, and what is left is still covered.
        val sent = again.beginSend("n1")!!
        assertEquals(SendOutcome.Done, again.completeSend("n1", sent.version, "r1", blob("landed")))
        assertEquals(UnsyncedNotes(1, shown.sequence, false, names = setOf("n2.note")), again.unsynced())
        assertEquals(shown, freshPermits().read(again.dir.name))
        assertTrue(permit.covers(again.unsynced()))
    }

    @Test fun `every new version withdraws the permit first, from a save, a rebase, a release and a conflict copy`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        // Each step runs on a new instance, since an instance asks once, at its first new version.
        fun permitted(): PendingNotesStore = restarted().also { permits.record(it.dir.name, it.unsynced()) }

        var s = permitted()
        val shown = s.unsynced()
        s.saveLocal("n1", "b1", "r2", blob("typed after the confirmation"), isCreate = false)
        assertNull("a save", permits.read(s.dir.name))
        assertEquals("the count did not change", shown.count, s.unsynced().count)
        assertFalse("and the answer shown no longer covers the store", shown.covers(s.unsynced()))

        s = permitted()
        assertTrue(s.rebase("n1", (s.read("n1") as Read.Present).entry.version, "r2", "r3", blob("rebased")))
        assertNull("a rebase", permits.read(s.dir.name))

        s = permitted()
        assertEquals(PendingNotesStore.HoldOutcome.HELD, s.hold("n1", HeldReason.READ_ONLY, now = 1))
        assertNotNull("a hold needs no new version", permits.read(s.dir.name))
        assertTrue(s.release("n1"))
        assertNull("a release from holding", permits.read(s.dir.name))

        s = permitted()
        val copy = PendingEntry("copy1", "b1", PendingEntry.State.UPSERT, 0, "c1", true, blob = blob("mine as copy"))
        assertTrue(s.replaceWithNewNote("n1", (s.read("n1") as Read.Present).entry.version, "srv", copy))
        assertNull("a conflict copy", permits.read(s.dir.name))
    }

    @Test fun `a permit covers one store directory only, and a save withdraws its own store's permit alone`() {
        val stores = listOf(storeOf(), storeOf(creationId = "gen-2"), storeOf(name = "bob@example.invalid"),
            storeOf(type = "io.silentsuite.other"))
        val names = stores.map { it.dir.name }
        assertEquals("another creation id, name or type is another directory", 4, names.toSet().size)
        val shown = UnsyncedNotes(1, 1, false)
        for (name in names) permits.record(name, shown)
        stores[1].saveLocal("n1", "b1", "r1", blob("t"), isCreate = false)
        assertNull(permits.read(names[1]))
        for (name in names - names[1]) assertEquals(shown, permits.read(name))
    }

    @Test fun `a store opened for an identity keeps its permit beside notes-pending, not in it`() {
        // As forIdentity opens it, with the JVM's own sync and rename.
        val s = PendingNotesStore.forNoBackup(root, "io.silentsuite", "alice@example.invalid", "gen-1", {}, atomicMove)
        assertEquals(File(root, "notes-pending"), s.dir.parentFile)
        val shown = UnsyncedNotes(1, 1, false)
        permits.record(s.dir.name, shown)
        // Where the default of open() keeps permits, for JVM tests: inside notes-pending.
        val inside = PendingNotesDiscardPermits(File(s.dir.parentFile, PendingNotesDiscardPermits.ROOT), {}, atomicMove,
            presence)
        inside.record(s.dir.name, shown)
        assertTrue(s.saveLocal("n1", "b1", "r1", blob("t"), isCreate = false) is SaveOutcome.Saved)
        assertNull("the save withdrew the permit beside notes-pending", freshPermits().read(s.dir.name))
        assertEquals("and left notes-pending alone", shown, inside.read(s.dir.name))
    }

    @Test fun `a permit left in a store emptied down to its directory does not cover a new save at version 1`() {
        assertEquals(1L, saved(store.saveLocal("n1", "b1", "r1", blob("discarded"), isCreate = false)))
        val shown = store.unsynced()
        assertEquals(UnsyncedNotes(1, 1, false, names = setOf("n1.note")), shown)
        permits.record(store.dir.name, shown)
        // What a discard leaves when it stops after the counter, before the directory: the empty
        // directory and the permit.
        assertTrue(File(store.dir, "n1.note").delete() && File(store.dir, "sequence").delete())
        assertTrue(store.dir.list()!!.isEmpty())

        // The same note typed again, so that even its name is the one the permit holds.
        val next = restarted()
        assertEquals("with nothing versioned left, versions start at 1 again",
            1L, saved(next.saveLocal("n1", "b1", "r1", blob("typed later"), isCreate = false)))
        assertEquals("so the store now reads as the answer the permit was recorded for", shown, next.unsynced())
        assertNull("but the save withdrew the permit first", permits.read(next.dir.name))
    }

    @Test fun `a save fails, writing nothing, while the permit cannot be shown gone`() {
        store.saveLocal("n1", "b1", "r1", blob("a"), isCreate = false)
        val before = filesOf(store.dir)

        // A permit that cannot be removed: here a directory with a file in it, which the listing still shows.
        var s = restarted()
        val inTheWay = File(permits.root, s.dir.name + ".permit")
        assertTrue(inTheWay.mkdirs() && File(inTheWay, "x").createNewFile())
        assertThrows(IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertEquals("no entry and no counter written", before, filesOf(s.dir))
        assertTrue(File(inTheWay, "x").delete() && inTheWay.delete())

        // A permit whose own check fails, though the root's listing does not show it: a listing can come back short.
        s = restarted()
        PendingNotesStore.presenceForTesting = { f ->
            if (f.name == s.dir.name + ".permit") PendingNotesStore.Presence.UNKNOWN else null
        }
        assertThrows(IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertEquals(before, filesOf(s.dir))
        PendingNotesStore.presenceForTesting = null

        // A root that cannot be listed, while the directory above it shows that it is there. The instance lists
        // the store first, while the root still lists, so its acknowledgement is shown gone and only the
        // permit's removal is left to fail.
        s = restarted()
        assertTrue(s.scan().entries.isNotEmpty())
        val unlistedRoot: (File) -> Array<File>? = { d -> if (d.name == "notes-discard") null else d.listFiles() }
        PendingNotesStore.listFilesForTesting = unlistedRoot
        assertThrows(IOException::class.java) { s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) }
        assertEquals(before, filesOf(s.dir))
        PendingNotesStore.listFilesForTesting = null
        assertTrue(s.saveLocal("n2", "b1", "r1", blob("u"), isCreate = false) is SaveOutcome.Saved)

        // Once shown gone, the instance does not ask again.
        PendingNotesStore.listFilesForTesting = unlistedRoot
        assertTrue(s.saveLocal("n3", "b1", "r1", blob("v"), isCreate = false) is SaveOutcome.Saved)

        // A new instance's first listing, in its recovery, shows the acknowledgement gone first, so with that
        // root it fails before anything is read or written, whether or not one was ever recorded.
        val written = filesOf(s.dir)
        s = restarted()
        assertThrows(IOException::class.java) { s.saveLocal("n4", "b1", "r1", blob("w"), isCreate = false) }
        assertThrows(IOException::class.java) { s.scan() }
        assertEquals(written, filesOf(s.dir))
    }

    @Test fun `an acknowledgement is a record of its own, which is never read as a permit, nor a permit as one`() {
        val identity = PendingNotesStore.DirectoryIdentity(device = 7, inode = 42)
        assertNull(permits.acknowledgement("store-a"))
        permits.acknowledge("store-a", identity)
        assertEquals(identity, permits.acknowledgement("store-a"))
        assertEquals("read by a reader of its own, as after a restart",
            identity, freshPermits().acknowledgement("store-a"))
        assertEquals("a file of its own", listOf("store-a.acknowledgement"), permits.root.list()!!.toList())
        assertNull("it is no permit", permits.read("store-a"))
        val acknowledgement = File(permits.root, "store-a.acknowledgement")
        val bytes = acknowledgement.readBytes()
        File(permits.root, "store-a.permit").writeBytes(bytes)
        assertNull("not even under a permit's name", permits.read("store-a"))
        permits.record("store-a", UnsyncedNotes(1, 1, false))
        acknowledgement.writeBytes(File(permits.root, "store-a.permit").readBytes())
        assertNull("and a permit under its name is no acknowledgement", permits.acknowledgement("store-a"))

        for (length in 0 until bytes.size) {
            acknowledgement.writeBytes(bytes.copyOf(length))
            assertNull("cut to $length", permits.acknowledgement("store-a"))
        }
        for (i in bytes.indices) {
            acknowledgement.writeBytes(bytes.copyOf().also { it[i] = (it[i].toInt() xor 0x40).toByte() })
            assertNull("byte $i", permits.acknowledgement("store-a"))
        }
        acknowledgement.writeBytes(withFormatVersion(bytes, 2))
        assertNull("a newer format", permits.acknowledgement("store-a"))
        acknowledgement.writeBytes(PendingCodec.encodeAcknowledgement("store-b", identity))
        assertNull("another store's acknowledgement under this store's name", permits.acknowledgement("store-a"))

        // Withdrawn on its own: the permit beside it stays.
        permits.acknowledge("store-a", identity)
        permits.withdrawAcknowledgement("store-a")
        assertNull(permits.acknowledgement("store-a"))
        permits.withdrawAcknowledgement("store-a")
        assertEquals(UnsyncedNotes(1, 1, false), permits.read("store-a"))
        assertEquals(listOf("store-a.permit"), permits.root.list()!!.toList())
        assertThrows(IllegalArgumentException::class.java) { permits.acknowledge("../x", identity) }
    }

    @Test fun `a permit is written in full and synced into place, or not at all, and its removal is synced`() {
        val events = ArrayList<String>()
        val p = PendingNotesDiscardPermits(File(root, "notes-discard"), syncDirectory = { events += "sync ${it.name}" },
            rename = { from, to -> events += "rename ${from.name} ${to.name}"; atomicMove(from, to) },
            presence = presence)
        val first = UnsyncedNotes(2, 7, false)
        p.record("store-a", first)
        assertEquals("the new root is synced into its parent before the permit is committed in it",
            listOf("sync no_backup", "rename store-a.permit.new store-a.permit", "sync notes-discard"), events)
        events.clear()
        val second = UnsyncedNotes(1, 7, false)
        p.record("store-a", second)
        assertEquals("the root's parent is synced on every record",
            listOf("sync no_backup", "rename store-a.permit.new store-a.permit", "sync notes-discard"), events)

        // A record that stops before its rename leaves the permit before it, and no temporary file.
        PendingNotesDiscardPermits.beforeRecordForTesting = { throw IOException("stopped before the rename") }
        assertThrows(IOException::class.java) { p.record("store-a", UnsyncedNotes(9, 9, false)) }
        PendingNotesDiscardPermits.beforeRecordForTesting = null
        assertEquals(second, p.read("store-a"))
        assertEquals(listOf("store-a.permit"), p.root.list()!!.toList())

        events.clear()
        p.remove("store-a")
        assertEquals(listOf("sync notes-discard"), events)
        assertTrue(p.root.list()!!.isEmpty())
    }

    @Test fun `a removal whose sync failed after the unlink is synced by the next, which finds the permit gone`() {
        val events = ArrayList<String>()
        var failing = false
        val p = PendingNotesDiscardPermits(File(root, "notes-discard"), syncDirectory = {
            events += "sync ${it.name}"
            if (failing && it.name == "notes-discard") throw IOException("the sync fails")
        }, rename = atomicMove, presence = presence)
        p.record("store-a", UnsyncedNotes(2, 7, false))
        failing = true
        assertThrows(IOException::class.java) { p.remove("store-a") }
        assertTrue("unlinked, though the removal may not be on disk", p.root.list()!!.isEmpty())
        // Found gone while the sync still fails: not reported gone either.
        events.clear()
        assertThrows(IOException::class.java) { p.remove("store-a") }
        assertEquals(listOf("sync notes-discard"), events)
        failing = false
        events.clear()
        p.remove("store-a")
        assertEquals("the root is synced before the permit is reported gone", listOf("sync notes-discard"), events)
    }
}
