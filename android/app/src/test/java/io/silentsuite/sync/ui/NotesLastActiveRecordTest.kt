package io.silentsuite.sync.ui

import io.silentsuite.sync.ui.NotesLastActiveRecord.Read
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

/**
 * The record of the store folder the active-account preference named at the last startup sweep that went ahead: what
 * a read of it finds, and what a write leaves. Real files in a temporary no_backup folder.
 */
class NotesLastActiveRecordTest {
    @get:Rule val tmp = TemporaryFolder()

    private val noBackup by lazy { tmp.newFolder("no_backup") }
    private val record get() = File(noBackup, NotesLastActiveRecord.FILE)

    private fun folder(c: Char) = c.toString().repeat(64)

    @Test fun `no record reads as missing`() {
        assertEquals(Read.Missing, NotesLastActiveRecord.read(noBackup))
    }

    @Test fun `a write reads back as the folder it names, and a write of none as none`() {
        NotesLastActiveRecord.write(noBackup, folder('a'))
        assertEquals(Read.Holds(folder('a')), NotesLastActiveRecord.read(noBackup))
        NotesLastActiveRecord.write(noBackup, "0123456789abcdef".repeat(4))
        assertEquals(Read.Holds("0123456789abcdef".repeat(4)), NotesLastActiveRecord.read(noBackup))
        NotesLastActiveRecord.write(noBackup, null)
        assertEquals(0L, record.length())
        assertEquals(Read.Holds(null), NotesLastActiveRecord.read(noBackup))
        assertEquals("no temp file is left", listOf(NotesLastActiveRecord.FILE), noBackup.list()!!.toList())
    }

    @Test fun `a record that holds anything but one store folder name or nothing is unreadable`() {
        for (content in listOf("x", folder('A'), "${folder('a')}\n", "a".repeat(63), "a".repeat(65), " ${folder('a')}",
                "${folder('a')}${folder('b')}")) {
            record.writeText(content)
            assertEquals(content, Read.Unreadable, NotesLastActiveRecord.read(noBackup))
        }
    }

    @Test fun `a directory where the record belongs is unreadable`() {
        assertTrue(record.mkdir())
        assertEquals(Read.Unreadable, NotesLastActiveRecord.read(noBackup))
    }

    @Test fun `a write whose move fails throws, and leaves no temp file and what was there as it was`() {
        // The record's place holds a folder that is not empty, so the move over it fails.
        assertTrue(File(record, "inside").mkdirs())
        assertThrows(IOException::class.java) { NotesLastActiveRecord.write(noBackup, folder('a')) }
        assertFalse("no temp file is left", File(noBackup, "${NotesLastActiveRecord.FILE}.new").exists())
        assertArrayEquals(arrayOf("inside"), record.list())
        assertEquals(listOf(NotesLastActiveRecord.FILE), noBackup.list()!!.toList())
    }
}
