package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.UUID

class ProcessIncarnationTest {
    @Test fun `only this process's token is this process's`() {
        assertTrue(ProcessIncarnation.isCurrent(ProcessIncarnation.current()))
        assertEquals("made once", ProcessIncarnation.current(), ProcessIncarnation.current())
        assertFalse("a dialog with no token", ProcessIncarnation.isCurrent(null))
        assertFalse(ProcessIncarnation.isCurrent(""))
        assertFalse("another process's", ProcessIncarnation.isCurrent(UUID.randomUUID().toString()))
        assertFalse(ProcessIncarnation.isCurrent(ProcessIncarnation.current() + " "))
        val token = ProcessIncarnation.current()
        val oneOff = token.dropLast(1) + if (token.last() == '0') '1' else '0'
        assertFalse("one character off", ProcessIncarnation.isCurrent(oneOff))
        // A token with no letter reads the same in upper case; the case check needs a letter.
        if (token != token.uppercase()) assertFalse(ProcessIncarnation.isCurrent(token.uppercase()))
    }

    @Test fun `the token is a random UUID made once, never a process id, a time or a stored value, and nothing sets it`() {
        val token = UUID.fromString(ProcessIncarnation.current())
        assertEquals("a random UUID", 4, token.version())
        assertEquals(2, token.variant())
        val source =
            File("src/main/java/io/silentsuite/sync/ui/ProcessIncarnation.kt").readText().replace("\r\n", "\n")
        for (line in listOf(
            "private val token: String = java.util.UUID.randomUUID().toString()\n",
            "fun current(): String = token\n",
            "fun isCurrent(shownIn: String?): Boolean = shownIn != null && shownIn == token\n",
        )) {
            assertTrue(line, source.contains(line))
        }
        for (word in listOf("var ", "lazy", "lateinit", "@JvmField", "@JvmStatic", "set(", "myPid", "currentTimeMillis",
            "elapsedRealtime", "nanoTime", "SharedPreferences", "File(", "Logger", "Log.", "Bundle")) {
            assertFalse(word, source.contains(word))
        }
    }
}
