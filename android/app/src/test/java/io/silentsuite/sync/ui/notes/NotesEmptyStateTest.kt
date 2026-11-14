package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NotesEmptyStateTest {
    @Test fun `an empty cache is only called empty after a Notes sync has succeeded`() {
        assertEquals(NotesEmptyState.NOT_SYNCED, NotesEmptyState.of(syncing = false, loadFailed = false, everSynced = false))
        assertEquals(NotesEmptyState.EMPTY, NotesEmptyState.of(syncing = false, loadFailed = false, everSynced = true))
    }

    @Test fun `a running or queued sync shows as syncing whatever came before`() {
        for (loadFailed in listOf(false, true)) for (everSynced in listOf(false, true)) {
            assertEquals(NotesEmptyState.SYNCING, NotesEmptyState.of(syncing = true, loadFailed, everSynced))
        }
    }

    @Test fun `a failed read is reported as a failure, not as no notebooks`() {
        assertEquals(NotesEmptyState.FAILED, NotesEmptyState.of(syncing = false, loadFailed = true, everSynced = true))
        assertEquals(NotesEmptyState.FAILED, NotesEmptyState.of(syncing = false, loadFailed = true, everSynced = false))
    }

    @Test fun `a note list with only items that could not be read is not called empty after a sync`() {
        assertNull(NotesEmptyState.ofNoteList(syncing = false, everSynced = true, unreadable = 1))
        assertEquals(NotesEmptyState.EMPTY, NotesEmptyState.ofNoteList(syncing = false, everSynced = true, unreadable = 0))
    }

    @Test fun `a note list keeps the syncing and not synced texts whatever could not be read, and never reports a failed read`() {
        for (unreadable in listOf(0, 1)) {
            for (everSynced in listOf(false, true)) {
                assertEquals(NotesEmptyState.SYNCING, NotesEmptyState.ofNoteList(syncing = true, everSynced, unreadable))
            }
            assertEquals(NotesEmptyState.NOT_SYNCED, NotesEmptyState.ofNoteList(syncing = false, everSynced = false, unreadable))
        }
    }

    // No device step opens a notebook whose only items could not be read, so this keeps the wiring.
    @Test fun `the note list decides its empty text with the count its last load could not read`() {
        val fragment = File("src/main/java/io/silentsuite/sync/ui/notes/NoteListFragment.kt").readText().replace("\r\n", "\n")
        val ask = "NotesEmptyState.ofNoteList(syncing(identity), everSynced, unreadable)"
        assertEquals("the note list asks for its empty text in one place, with the count", 1, fragment.split(ask).size - 1)
        val hide = "view.findViewById<View>(R.id.notes_empty).visibility = if (state == null) View.GONE else View.VISIBLE"
        assertEquals("the empty text hides whenever that answer is nothing", 1, fragment.split(hide).size - 1)
        val keep = "unreadable = contents.unreadable"
        assertEquals("the count is kept in one place", 1, fragment.split(keep).size - 1)
        val start = "private fun render(view: View, contents: NotebookContents) {"
        assertEquals("the note list renders a load in one function", 1, fragment.split(start).size - 1)
        val render = fragment.substringAfter(start).substringBefore("\n    }\n")
        assertTrue("at each render, before the empty text is decided",
            render.indexOf(keep) in 0 until render.indexOf("renderEmptyState()"))
    }
}
