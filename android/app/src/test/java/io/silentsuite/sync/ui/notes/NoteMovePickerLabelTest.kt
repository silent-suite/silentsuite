package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Move picker's lines ([movePickerLabel]): notebook names come from other accounts too, so a name must not be able to
 * reorder the shared mark or push it out of view and make a shared notebook look private.
 */
class NoteMovePickerLabelTest {
    /** The characters for [codes], built from code points so no special character sits in this source. */
    private fun chars(vararg codes: Int) = codes.joinToString("") { it.toChar().toString() }

    private val bidiControls = listOf(0x061C, 0x200E, 0x200F) + (0x202A..0x202E) + (0x2066..0x2069)
    private val lineBreaks = listOf(0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029)

    private fun label(name: String, shared: Boolean) =
        movePickerLabel(NoteEditorViewModel.MoveTarget("uid", name, shared), "Untitled") { "Shared: $it" }

    @Test fun `every bidirectional control is taken out of a name`() {
        for (code in bidiControls) {
            assertEquals("U+%04X".format(code), "Work", pickerName("Wo" + chars(code) + "rk"))
        }
        assertEquals("an override around the whole name", "Team", pickerName(chars(0x202E) + "Team" + chars(0x202C)))
    }

    @Test fun `each run of line breaks becomes one space, and none is left at either end`() {
        for (code in lineBreaks) {
            assertEquals("U+%04X".format(code), "Team notes", pickerName("Team" + chars(code) + "notes"))
        }
        assertEquals("Team notes", pickerName(chars(0x0D, 0x0A, 0x0D, 0x0A) + "Team" + chars(0x0D, 0x0A, 0x2028) + "notes" + chars(0x0A)))
        assertEquals("a control between breaks", "Team notes", pickerName("Team" + chars(0x0A, 0x202E, 0x0A) + "notes"))
    }

    @Test fun `the shared mark comes before the name, which cannot reorder it or push it to another line`() {
        val name = chars(0x202E) + "Team" + chars(0x0A, 0x0A, 0x0A) + "notes" + chars(0x2066)
        assertEquals("Shared: Team notes", label(name, shared = true))
        assertEquals("Team notes", label(name, shared = false))
    }

    @Test fun `a name of controls and breaks alone shows as untitled, with the mark when shared`() {
        val name = chars(0x202E, 0x0A, 0x2029, 0x200F)
        assertEquals("Untitled", label(name, shared = false))
        assertEquals("Shared: Untitled", label(name, shared = true))
    }

    @Test fun `every translation of the shared label puts the mark before the name`() {
        val resources = File("src/main/res")
        val found = resources.listFiles().orEmpty().filter { it.name.startsWith("values") }
            .map { File(it, "strings.xml") }.filter { it.isFile }
            .mapNotNull { file ->
                Regex("<string name=\"notes_move_shared\">([^<]*)</string>").find(file.readText())?.let { file.parentFile!!.name to it.groupValues[1] }
            }
        assertTrue("the default strings have it", found.any { it.first == "values" })
        for ((folder, text) in found) {
            assertTrue("$folder: $text", text.endsWith("%1\$s") && text.removeSuffix("%1\$s").isNotBlank())
        }
    }
}
