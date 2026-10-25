package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.DiscardOutcome
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * The push step of a Notes run over a pending store that was cleared: nothing to push once the clear finished, a
 * storage failure while it has not, whatever is left to list, and the fetch still runs.
 */
class NotesSyncRunnerClearedStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    /** Replaces the target in one step on every platform the tests run on, Windows included. */
    private val atomicMove: (File, File) -> Unit = { from, to ->
        java.nio.file.Files.move(from.toPath(), to.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    }

    @After fun reset() {
        PendingNotesStore.beforeClearForTesting = null
        PendingNotesStore.beforeRemoveForTesting = null
        PendingNotesStore.listFilesForTesting = null
        PendingNotesStore.identityForTesting = null
        PendingNotesStore.resetForTesting()
    }

    private fun storeWithOneChange(name: String = "store"): PendingNotesStore =
        PendingNotesStore.open(tmp.newFolder(name), rename = atomicMove).also {
            it.saveLocal("n1", "b1", "r1", "text".toByteArray(), isCreate = false)
        }

    @Test fun `a store whose clear stopped with a change left is a storage failure, not nothing to push`() {
        val store = storeWithOneChange()
        assertEquals(listOf("n1"), NotesSyncRunner.waitingIn(store)!!.headers.map { it.noteUid })
        PendingNotesStore.beforeClearForTesting = { throw IOException("the clear stops here") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        assertTrue("the change is still on disk", "n1.note" in store.dir.list()!!)
        assertThrows(PendingNotesStore.Cleared::class.java) { store.snapshot { false } }
        assertTrue("still an IllegalStateException, as before",
            runCatching { store.read("n1") }.exceptionOrNull() is IllegalStateException)
        // The run records it as a storage failure, never a success over text still on disk, and still fetches.
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
        // Every opener of the directory in this process gets the same closed instance.
        val again = PendingNotesStore.open(store.dir, rename = atomicMove)
        assertSame(store, again)
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(again) }
    }

    @Test fun `a cleared store that cannot be counted after its clear stopped is a storage failure too`() {
        val store = storeWithOneChange()
        // A file of a kind this build does not know: the store lists, but cannot be counted.
        File(store.dir, "n2.draft").writeBytes("text".toByteArray())
        val shown = store.unsynced()
        assertTrue("could not be counted", shown.unreadable && shown.listed)
        // The clear removes the entry first and stops at that file, so what it leaves counts no change at all and
        // still cannot be counted. Its state tells this one: the discard did not finish.
        PendingNotesStore.beforeRemoveForTesting = {
            if (it.name == "n2.draft") throw IOException("the clear stops here")
        }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        val left = store.dir.list()!!.toSet()
        assertTrue("the entry went and the file of an unknown kind stayed: $left",
            "n1.note" !in left && "n2.draft" in left)
        val now = store.unsynced()
        assertTrue("no change is counted, and the store cannot be counted: $now", now.count == 0 && now.unreadable)
        assertThrows(PendingNotesStore.Cleared::class.java) { store.snapshot { false } }
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
    }

    @Test fun `a store whose clear stopped is a storage failure also when its listing comes back short`() {
        val store = storeWithOneChange()
        PendingNotesStore.beforeClearForTesting = { throw IOException("the clear stops here") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeClearForTesting = null
        // A listing of the store that comes back with nothing, and says nothing.
        PendingNotesStore.listFilesForTesting = { d -> if (d == store.dir) emptyArray() else d.listFiles() }
        assertEquals("the count finds nothing", UnsyncedNotes.NOTHING, store.unsynced())
        assertFalse("but the discard did not finish", store.clearedInFull())
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
    }

    @Test fun `a store whose clear stopped at a note its count missed is a storage failure, though nothing its permit names is left`() {
        val store = storeWithOneChange()
        store.saveLocal("n3", "b1", "r1", "missed by the count".toByteArray(), isCreate = false)
        // The count's listing leaves out n3 until the removal of n1.note starts, so the discard's second listing
        // shows it and the discard stops there.
        var short = true
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (short && all != null && d == store.dir) all.filter { it.name != "n3.note" }.toTypedArray() else all
        }
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") short = false }
        val shown = store.unsynced()
        assertEquals(setOf("n1.note"), shown.names)
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        val left = store.dir.list()!!.toSet()
        assertTrue("n1 went and n3 stayed: $left", "n1.note" !in left && "n3.note" in left)
        // Its state tells this one: the discard did not finish.
        assertFalse(store.clearedInFull())
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
    }

    @Test fun `a cleared store that cannot be counted is a storage failure, though nothing its permit names is left`() {
        val store = storeWithOneChange()
        File(store.dir, "n2.draft").writeBytes("text".toByteArray())
        // The count's listing leaves out the file of an unknown kind until the removal of n1.note starts, so the
        // permit names n1.note alone, and the discard's second listing shows the file and stops there.
        var short = true
        PendingNotesStore.listFilesForTesting = { d ->
            val all = d.listFiles()
            if (short && all != null && d == store.dir) all.filter { it.name != "n2.draft" }.toTypedArray() else all
        }
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "n1.note") short = false }
        val shown = store.unsynced()
        assertFalse("counted", shown.unreadable)
        assertEquals(setOf("n1.note"), shown.names)
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(shown))
        val left = store.dir.list()!!.toSet()
        assertTrue("n1 went and the file of an unknown kind stayed: $left", "n1.note" !in left && "n2.draft" in left)
        val now = store.unsynced()
        assertTrue("no change is counted, and the store cannot be counted: $now", now.count == 0 && now.unreadable)
        // Its state tells this one: the discard did not finish.
        assertFalse(store.clearedInFull())
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
    }

    @Test fun `a store whose clear stopped after its last change went is a storage failure until a clear finishes, whatever its listing shows`() {
        val store = storeWithOneChange()
        // The discard removes the entry and stops at the counter, so nothing is left to count, and nothing its
        // permit names is there.
        PendingNotesStore.beforeRemoveForTesting = { if (it.name == "sequence") throw IOException("the clear stops here") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeRemoveForTesting = null
        assertEquals(UnsyncedNotes.NOTHING, store.unsynced())
        assertFalse("but the discard did not finish", store.clearedInFull())
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
        assertEquals(DiscardOutcome.Done, store.discardStore(store.unsynced()))
        assertTrue(store.clearedInFull())
        assertNull(NotesSyncRunner.waitingIn(store))

        // The same for a clear that did not return: its directory is gone, but a listing still shows it.
        val cleared = storeWithOneChange("cleared")
        PendingNotesStore.listFilesForTesting = { d ->
            if (d == cleared.dir.parentFile) d.listFiles()!! + cleared.dir else d.listFiles()
        }
        assertThrows(IOException::class.java) { cleared.clearAll() }
        PendingNotesStore.listFilesForTesting = null
        assertFalse(cleared.dir.exists())
        assertEquals(UnsyncedNotes.NOTHING, cleared.unsynced())
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(cleared) }
        cleared.clearAll()
        assertNull(NotesSyncRunner.waitingIn(cleared))
    }

    @Test fun `a run whose listing shows nothing still runs its push step while what a discard that has not finished left is there`() {
        val store = storeWithOneChange()
        PendingNotesStore.beforeClearForTesting = { throw IOException("the clear stops here") }
        assertEquals(DiscardOutcome.NotFinished, store.discardStore(store.unsynced()))
        PendingNotesStore.beforeClearForTesting = null
        // After a restart, with a listing of the store that comes back with nothing.
        PendingNotesStore.resetForTesting()
        val next = PendingNotesStore.open(store.dir, rename = atomicMove)
        PendingNotesStore.listFilesForTesting = { d -> if (d == next.dir) emptyArray() else d.listFiles() }
        val waiting = NotesSyncRunner.waitingIn(next)!!
        assertTrue("nothing listed", waiting.headers.isEmpty() && waiting.unreadable.isEmpty())
        assertFalse("but the push step runs, and records the storage failure", NotesSyncRunner.nothingToPush(waiting))
        assertTrue("a store that holds nothing has nothing to push",
            NotesSyncRunner.nothingToPush(PendingNotesStore.Snapshot(emptyList(), emptyMap(), emptyList(), 0)))
        // The run needs an account and a server, so this is checked in its source: the push step asks nothingToPush.
        val runner = File("src/main/java/io/silentsuite/sync/notes/NotesSyncRunner.kt").readText()
            .replace("\r\n", "\n")
        val push = runner.substringAfter("private fun pushPending(", "").substringBefore("\n    }\n")
        assertTrue(push.contains("val waiting = waitingIn(store) ?: return null\n        if (nothingToPush(waiting)) {"))
    }

    @Test fun `a store that was cleared in full has nothing to push either, also once it is dropped`() {
        val store = storeWithOneChange()
        store.clearAll()
        assertNull(NotesSyncRunner.waitingIn(store))
        val discarded = storeWithOneChange("discarded")
        assertEquals(DiscardOutcome.Done, discarded.discardStore(discarded.unsynced()))
        assertNull(NotesSyncRunner.waitingIn(discarded))
        discarded.unregister()
        assertNull("a dropped instance was cleared in full", NotesSyncRunner.waitingIn(discarded))
    }

    @Test fun `a store that cannot be listed is still a storage failure, not nothing to push`() {
        val store = storeWithOneChange()
        PendingNotesStore.listFilesForTesting = { d -> if (d == store.dir) null else d.listFiles() }
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
        // A sign-out confirmed for it is only acknowledged: nothing is deleted and the store is not closed, so
        // it stays a storage failure while it cannot be listed, and its change waits to be pushed once it lists.
        PendingNotesStore.identityForTesting = { PendingNotesStore.DirectoryIdentity(device = 7, inode = 1) }
        assertEquals(DiscardOutcome.Acknowledged, store.discardStore(store.unsynced()))
        assertThrows(IOException::class.java) { NotesSyncRunner.waitingIn(store) }
        PendingNotesStore.listFilesForTesting = null
        assertEquals(listOf("n1"), NotesSyncRunner.waitingIn(store)!!.headers.map { it.noteUid })
    }

    @Test fun `a run whose store was cleared skips the push and goes on to its fetch`() {
        // A run needs an account, a server and a cache, so this is checked in the runner's source: the push
        // step reads the store through waitingIn, which returns null for a store cleared in full
        // ([PendingNotesStore.clearedInFull]) and throws IOException for one whose clear has not finished,
        // whatever is left to list; the run's catch around the push step takes that IOException for a storage
        // failure; and between the push step and the fetch the run returns only after a push that needs
        // authentication, which neither is.
        val runner = File("src/main/java/io/silentsuite/sync/notes/NotesSyncRunner.kt").readText()
            .replace("\r\n", "\n")
        val push = runner.substringAfter("private fun pushPending(", "").substringBefore("\n    }\n")
        assertTrue(push.contains("val waiting = waitingIn(store) ?: return null"))
        assertEquals("the push step reads what waits only through waitingIn", 0,
            Regex("store\\.snapshot").findAll(push).count())
        val between = runner.substringAfter("push = try {", "").substringBefore("fetchEachNotebook(notebooks")
        assertTrue("a store that could not be read is a storage failure",
            between.substringAfter("} catch (e: IOException) {", "").contains("unreadableStore()"))
        assertTrue(between.contains("if (push?.ended == NotePushStep.Ended.NEEDS_AUTHENTICATION) {"))
        assertEquals("the one return before the fetch is the authentication one", 1,
            Regex("\\breturn\\b").findAll(between).count())
        assertTrue(between.substringAfter("NEEDS_AUTHENTICATION) {").contains("return true"))
    }
}
