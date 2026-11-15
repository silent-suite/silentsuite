package io.silentsuite.sync.ui.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EditHistoryTest {
    /** Types [text] at the end of [current], one character every [gap] milliseconds from [from]. */
    private fun EditHistory.type(current: String, text: String, from: Long, gap: Long = 100): String {
        var now = from
        var shown = current
        for (c in text) {
            record(shown.length, "", c.toString(), now)
            shown += c
            now += gap
        }
        return shown
    }

    @Test fun `typing is one step per word, and a pause ends a step`() {
        val history = EditHistory()
        var text = history.type("", "hello world", from = 0)
        assertEquals("hello ", history.undo(text)!!.text.also { text = it })
        assertEquals("", history.undo(text)!!.text.also { text = it })
        assertNull("nothing left", history.undo(text))

        val paused = EditHistory()
        var shown = paused.type("", "ab", from = 0)
        shown = paused.type(shown, "cd", from = 5_000)
        assertEquals("ab", paused.undo(shown)!!.text)
    }

    @Test fun `a paste and a deletion of more than one character are steps of their own`() {
        val history = EditHistory()
        var text = history.type("", "abc", from = 0)
        history.record(3, "", "PASTED", now = 400)
        text += "PASTED"
        history.record(9, "", "d", now = 450)
        text += "d"
        assertEquals("abcPASTED", history.undo(text)!!.text.also { text = it })
        assertEquals("abc", history.undo(text)!!.text.also { text = it })
        // A select-all delete comes back whole.
        history.record(0, "abc", "", now = 600)
        assertEquals(EditHistory.Applied("abc", 3), history.undo(""))
    }

    @Test fun `backspaces are grouped, and an undo puts them back`() {
        val history = EditHistory()
        var text = history.type("", "hello", from = 0)
        for (i in 4 downTo 2) {
            history.record(i, text.substring(i, i + 1), "", now = 2_000L + (4 - i) * 100)
            text = text.removeRange(i, i + 1)
        }
        assertEquals("he", text)
        assertEquals(EditHistory.Applied("hello", 5), history.undo(text))
    }

    @Test fun `a keyboard rewriting its composing word records only what changed`() {
        val history = EditHistory()
        history.record(0, "", "h", now = 0)
        history.record(0, "h", "he", now = 100)
        history.record(0, "he", "hel", now = 200)
        assertEquals(EditHistory.Applied("", 0), history.undo("hel"))
        assertFalse(history.canUndo)
    }

    @Test fun `redo applies again, and new typing drops the redo steps`() {
        val history = EditHistory()
        val text = history.type("", "one two", from = 0)
        val undone = history.undo(text)!!.text
        assertTrue(history.canRedo)
        assertEquals(EditHistory.Applied("one two", 7), history.redo(undone))
        val again = history.undo(text)!!.text
        history.record(again.length, "", "x", now = 10_000)
        assertFalse("typing after an undo drops what could be redone", history.canRedo)
        assertEquals("one x", (again + "x"))
        assertEquals("one ", history.undo(again + "x")!!.text)
    }

    @Test fun `the step and character bounds drop the oldest steps first, and keep the newest`() {
        val steps = EditHistory(maxSteps = 3)
        var text = ""
        for (word in listOf("a", "b", "c", "d", "e")) {
            steps.record(text.length, "", word, now = text.length * 10_000L)
            text += word
        }
        repeat(3) { text = steps.undo(text)!!.text }
        assertEquals("ab", text)
        assertNull("the two oldest went", steps.undo(text))

        val chars = EditHistory(maxChars = 10)
        chars.record(0, "", "0123456789", now = 0)
        chars.record(10, "", "abcdefghijklmnop", now = 10_000)
        assertEquals("the newest stays though it is over the bound", "0123456789", chars.undo("0123456789abcdefghijklmnop")!!.text)
        assertNull(chars.undo("0123456789"))
    }

    @Test fun `a step over text it was not recorded on clears the history and changes nothing`() {
        val history = EditHistory()
        history.type("", "abc", from = 0)
        assertNull(history.undo("another version"))
        assertFalse(history.canUndo)
        assertFalse(history.canRedo)
    }

    @Test fun `nothing to undo or redo with no step`() {
        val history = EditHistory()
        assertFalse(history.canUndo)
        assertFalse(history.canRedo)
        assertNull(history.undo("x"))
        assertNull(history.redo("x"))
        history.record(0, "same", "same", now = 0)
        assertFalse("a change that changes nothing is no step", history.canUndo)
    }
}
