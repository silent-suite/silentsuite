package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.edit.NoteMetaCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesLoaderTest {
    private fun hex(s: String) = s.replace(" ", "").chunked(2).map { it.toInt(16).toByte() }.toByteArray()

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

    @Test fun `titles come from the raw metadata bytes`() {
        // A character above U+FFFF never passes through a typed string (design decision 5).
        assertEquals("Plan \uD83D\uDED2", NotesLoader.titleOf(NoteMetaCodec.fresh("  Plan \uD83D\uDED2 ", 5).bytes))
        assertEquals("a lone surrogate was written as U+FFFD", "a\uFFFDb", NotesLoader.titleOf(NoteMetaCodec.fresh("a\uD800b", 5).bytes))
        val noTitle = mapOf(
            "no metadata" to null,
            "empty metadata" to ByteArray(0),
            "an array" to hex("91 01"),
            "a name that is a number" to hex("82 a4 6e616d65 05 a5 6d74696d65 01"),
            "a name that is not UTF-8" to hex("81 a4 6e616d65 a2 c328"),
            "a repeated name" to hex("82 a4 6e616d65 a1 61 a4 6e616d65 a1 62"),
            "a plain name next to another client's key" to hex("83 a4 6e616d65 a1 41 a5 6d74696d65 05 01 a1 42"),
            // These three pass the typed decoder, so they are what reaches titleOf from a real cache.
            "no name" to hex("81 a5 6d74696d65 05"),
            "a nil name" to hex("82 a4 6e616d65 c0 a5 6d74696d65 05"),
            "a name only under another client's key" to hex("82 01 a1 42 a5 6d74696d65 05"),
        )
        for ((what, raw) in noTitle) assertEquals(what, "", NotesLoader.titleOf(raw))
    }
}
