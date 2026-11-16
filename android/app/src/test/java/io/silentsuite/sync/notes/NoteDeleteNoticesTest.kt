package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.edit.NotePushPolicy.DeleteNotDone
import io.silentsuite.sync.ui.ExactAccountIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NoteDeleteNoticesTest {
    /** Preferences in memory: one map, written in one step, with a switch for a commit that fails. */
    private class Memory : NoteDeleteNotices.Storage {
        val values = HashMap<String, Any?>()
        var failing = false
        override fun all(): Map<String, *> = HashMap(values)
        override fun write(values: Map<String, Int>, removed: Collection<String>): Boolean {
            if (failing) return false
            this.values.putAll(values)
            removed.forEach { this.values.remove(it) }
            return true
        }
    }

    private val storage = Memory()
    private val notices = NoteDeleteNotices(storage)
    private val alice = ExactAccountIdentity("io.silentsuite", "alice@example.invalid", "gen-1")

    @Test fun `runs add to each reason's count, and a dismissal takes away only what was shown`() {
        notices.add(alice, mapOf(DeleteNotDone.CHANGED_ELSEWHERE to 1))
        notices.add(alice, mapOf(DeleteNotDone.CHANGED_ELSEWHERE to 1, DeleteNotDone.READ_ONLY to 1))
        val shown = notices.read(alice)
        assertEquals(mapOf(DeleteNotDone.CHANGED_ELSEWHERE to 2, DeleteNotDone.READ_ONLY to 1), shown)
        // A run drops another delete while the notice is on screen.
        notices.add(alice, mapOf(DeleteNotDone.CHANGED_ELSEWHERE to 1))
        assertTrue(notices.dismiss(alice, shown))
        assertEquals("the one dropped since stays", mapOf(DeleteNotDone.CHANGED_ELSEWHERE to 1), notices.read(alice))
        assertTrue(notices.dismiss(alice, notices.read(alice)))
        assertTrue(notices.read(alice).isEmpty())
        assertTrue("nothing is left behind", storage.values.isEmpty())
    }

    @Test fun `each exact generation has its own notice, and the keys name no account`() {
        val replaced = alice.copy(creationId = "gen-2")
        notices.add(alice, mapOf(DeleteNotDone.REJECTED to 1))
        assertTrue("a same-name account of another generation shows nothing", notices.read(replaced).isEmpty())
        assertTrue(storage.values.keys.none { it.contains("alice") || it.contains("gen-1") })
        assertEquals(setOf("REJECTED"), storage.values.keys.map { it.substringAfter('.') }.toSet())
    }

    @Test fun `a failed write keeps the notice, and a value that is not a count is left out`() {
        notices.add(alice, mapOf(DeleteNotDone.NOT_BUILT to 2))
        storage.failing = true
        assertFalse(notices.dismiss(alice, notices.read(alice)))
        storage.failing = false
        assertEquals(mapOf(DeleteNotDone.NOT_BUILT to 2), notices.read(alice))
        storage.values[NoteDeleteNotices.key(alice, DeleteNotDone.READ_ONLY)] = "two"
        storage.values[NoteDeleteNotices.key(alice, DeleteNotDone.REJECTED)] = -1
        assertEquals(mapOf(DeleteNotDone.NOT_BUILT to 2), notices.read(alice))
    }

    @Test fun `the runner records a dropped delete for the notice as it happens, under the exact generation`() {
        val runner = File("src/main/java/io/silentsuite/sync/notes/NotesSyncRunner.kt").readText().replace("\r\n", "\n")
        assertTrue(runner.contains("val identity = ExactAccountIdentity(account.type, account.name, creationId)"))
        assertTrue(runner.contains("onDeleteNotDone = { reason -> notices.add(identity, mapOf(reason to 1)) }"))
    }
}
