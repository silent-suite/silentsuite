package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ListEntriesLineTest {
    @Test fun `a field in the middle of a vCard or iCalendar ends at its line break`() {
        assertEquals("Jane Doe", ListEntriesFragment.getLine("BEGIN:VCARD\nFN:Jane Doe\nEND:VCARD\n", "FN:"))
        assertEquals("Standup", ListEntriesFragment.getLine("BEGIN:VEVENT\nSUMMARY:Standup\nEND:VEVENT", "SUMMARY:"))
    }

    @Test fun `a CRLF line break is not part of the field`() {
        assertEquals("Jane Doe", ListEntriesFragment.getLine("BEGIN:VCARD\r\nFN:Jane Doe\r\nEND:VCARD\r\n", "FN:"))
        assertEquals("Standup", ListEntriesFragment.getLine("BEGIN:VEVENT\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n", "SUMMARY:"))
        assertEquals("Standup", ListEntriesFragment.getLine("BEGIN:VEVENT\r\nSUMMARY:Standup\r\n", "SUMMARY:"))
    }

    @Test fun `the last line needs no line break after it`() {
        // A single-line note body, or a field on the final line, used to throw StringIndexOutOfBounds.
        assertEquals("good body v2", ListEntriesFragment.getLine("good body v2", ""))
        assertEquals("Standup", ListEntriesFragment.getLine("BEGIN:VEVENT\nSUMMARY:Standup", "SUMMARY:"))
    }

    @Test fun `empty content and a missing field`() {
        // A deleted item has empty content.
        assertEquals("", ListEntriesFragment.getLine("", ""))
        assertNull(ListEntriesFragment.getLine("", "SUMMARY:"))
        assertNull(ListEntriesFragment.getLine(null, "FN:"))
        assertNull(ListEntriesFragment.getLine("BEGIN:VEVENT\nEND:VEVENT", "SUMMARY:"))
    }
}
