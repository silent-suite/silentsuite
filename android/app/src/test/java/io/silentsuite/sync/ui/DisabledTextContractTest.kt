package io.silentsuite.sync.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * AppTheme's text colours are state lists, so a disabled row (a setting that depends on another switch)
 * looks unavailable in both themes. Rows that only show a message are not selectable instead of disabled,
 * so their text keeps full contrast.
 */
class DisabledTextContractTest {
    private val main = File("src/main")
    private fun source(relative: String) = File(main, relative).readText()

    @Test
    fun appThemeTextColoursDimWhenDisabledInBothThemes() {
        for (themes in listOf("res/values/themes.xml", "res/values-night/themes.xml")) {
            val xml = source(themes)
            assertTrue(themes, xml.contains("<item name=\"android:textColorPrimary\">@color/theme_text_primary</item>"))
            assertTrue(themes, xml.contains("<item name=\"android:textColorSecondary\">@color/theme_text_secondary</item>"))
        }
        for ((list, colour) in listOf(
            "theme_text_primary" to "semantic_on_surface",
            "theme_text_secondary" to "semantic_on_surface_variant"
        )) {
            val xml = source("res/color/$list.xml")
            assertTrue(list, xml.contains(
                "<item android:state_enabled=\"false\" android:alpha=\"0.38\" android:color=\"@color/$colour\" />"))
            assertTrue(list, xml.contains("<item android:color=\"@color/$colour\" />"))
            // The disabled item comes first: a state list uses the first item that matches.
            assertTrue(list, xml.indexOf("state_enabled=\"false\"") < xml.indexOf("<item android:color="))
        }
    }

    @Test
    fun messageRowsStayReadable() {
        val notes = source("java/io/silentsuite/sync/ui/UnsyncedNotesFragment.kt")
        val addNote = notes.substring(notes.indexOf("private fun addNote("), notes.indexOf("private fun addNote(") + 400)
        assertTrue(addNote.contains("isSelectable = false"))
        assertFalse(addNote.contains("isEnabled = false"))

        val settings = source("java/io/silentsuite/sync/ui/AppSettingsActivity.kt")
        val none = settings.substring(settings.indexOf("key = RECOVERY_NONE_KEY"), settings.indexOf("key = RECOVERY_NONE_KEY") + 250)
        assertTrue(none.contains("isSelectable = false"))
        assertFalse(none.contains("isEnabled = false"))
    }
}
