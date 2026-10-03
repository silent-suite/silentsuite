package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesLoaderTest {
    @Test fun `preview takes the first meaningful line without markdown markers`() {
        assertEquals("Shopping", NotesLoader.previewOf("\n\n# Shopping\n- milk"))
        assertEquals("milk", NotesLoader.previewOf("- milk\n- eggs"))
        assertEquals("first step", NotesLoader.previewOf("1. first step\n2. second"))
        assertEquals("quoted", NotesLoader.previewOf("> quoted"))
        assertEquals("", NotesLoader.previewOf("   \n\t\n"))
        assertEquals(140, NotesLoader.previewOf("x".repeat(500)).length)
    }

    @Test fun `notes sort newest edit first and untimed notes last`() {
        val sorted = NotesLoader.sortNotes(listOf(
            NoteRow("c", "Charlie", "", null),
            NoteRow("a", "alpha", "", 10),
            NoteRow("b", "Bravo", "", 20),
            NoteRow("d", "delta", "", null),
        )).map { it.uid }
        assertEquals(listOf("b", "a", "c", "d"), sorted)
    }

    @Test fun `only a missing or empty item type is a note as on the web`() {
        assertTrue(NotesLoader.isMarkdownNote(null))
        assertTrue(NotesLoader.isMarkdownNote(""))
        // packages/core isMarkdownNoteItem skips these, so Android must too.
        assertFalse(NotesLoader.isMarkdownNote(" "))
        assertFalse(NotesLoader.isMarkdownNote("attachment"))
    }
}
