package io.silentsuite.sync.dataexport

import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream

class AtomicExportCommitTest {
    private lateinit var stagedFile: File

    @Before
    fun setUp() {
        stagedFile = File.createTempFile("silentsuite-export-test", ".tmp")
    }

    @After
    fun tearDown() {
        stagedFile.delete()
    }

    @Test
    fun invalidationDuringDestinationWriteClearsPlaintext() {
        stagedFile.writeBytes(ByteArray(32 * 1024) { index -> (index % 251).toByte() })
        val destination = ByteArrayOutputStream()
        var current = true
        var cleanupCalls = 0
        val invalidatingStream = object : OutputStream() {
            override fun write(value: Int) {
                destination.write(value)
                current = false
            }

            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                destination.write(bytes, offset, length)
                current = false
            }
        }

        val committed = AndroidDataExporter.commitStagedExport(
            stagedFile = stagedFile,
            openDestination = { invalidatingStream },
            clearDestination = {
                cleanupCalls += 1
                destination.reset()
            },
            exactGenerationStillCurrent = { current },
        )

        assertFalse(committed)
        assertEquals(1, cleanupCalls)
        assertEquals(0, destination.size())
    }

    @Test
    fun successfulDestinationWritePublishesExactStagedBytes() {
        val expected = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n".toByteArray()
        stagedFile.writeBytes(expected)
        val destination = ByteArrayOutputStream()
        var cleanupCalls = 0

        val committed = AndroidDataExporter.commitStagedExport(
            stagedFile = stagedFile,
            openDestination = { destination },
            clearDestination = { cleanupCalls += 1 },
            exactGenerationStillCurrent = { true },
        )

        assertTrue(committed)
        assertEquals(0, cleanupCalls)
        assertArrayEquals(expected, destination.toByteArray())
    }

    @Test
    fun destinationFailureClearsPartialPlaintextAndPropagates() {
        stagedFile.writeText("private calendar data")
        val destination = ByteArrayOutputStream()
        var cleanupCalls = 0
        val failingStream = object : OutputStream() {
            override fun write(value: Int) {
                destination.write(value)
                throw IOException("destination failed")
            }

            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                destination.write(bytes, offset, minOf(length, 4))
                throw IOException("destination failed")
            }
        }

        assertThrows(IOException::class.java) {
            AndroidDataExporter.commitStagedExport(
                stagedFile = stagedFile,
                openDestination = { failingStream },
                clearDestination = {
                    cleanupCalls += 1
                    destination.reset()
                },
                exactGenerationStillCurrent = { true },
            )
        }

        assertEquals(1, cleanupCalls)
        assertEquals(0, destination.size())
    }
}
