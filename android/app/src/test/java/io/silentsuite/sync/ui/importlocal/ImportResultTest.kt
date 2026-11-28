package io.silentsuite.sync.ui.importlocal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ImportResultTest {

    @Test
    fun skippedExcludesAddedUpdatedAndFailed() {
        val result = ResultFragment.ImportResult().also {
            it.total = 3
            it.added = 1
            it.updated = 1
            it.failed = 1
        }

        // failed entries are no longer double-counted as skipped
        assertEquals(0, result.skipped)
    }

    @Test
    fun skippedCountsEntriesNotAddedUpdatedOrFailed() {
        val result = ResultFragment.ImportResult().also {
            it.total = 5
            it.added = 1
            it.updated = 1
            it.failed = 1
        }

        assertEquals(2, result.skipped)
    }

    @Test
    fun toStringDoesNotIncludeRawExceptionMessage() {
        val result = ResultFragment.ImportResult().also {
            it.e = Exception("private contact payload +155****4567")
            it.failureMessage = "Safe import failure"
        }

        val description = result.toString()
        assertTrue(description.contains("java.lang.Exception"))
        assertFalse(description.contains("private contact payload"))
        assertFalse(description.contains("+155****4567"))
        assertFalse(description.contains("Safe import failure"))
    }

    @Test
    fun aFailureIsNotARefusalUnlessMarked() {
        val result = ResultFragment.ImportResult().also { it.e = Exception("boom") }
        assertTrue(result.isFailed)
        assertFalse(result.refused)
    }

    @Test
    fun aRefusedDeviceImportShowsItsReasonWithOnlyOkAndNoReport() {
        val importlocal = "src/main/java/io/silentsuite/sync/ui/importlocal"
        fun source(name: String) = File("$importlocal/$name").readText().replace("\r\n", "\n")

        val dialog = source("ResultFragment.kt").substringAfter("override fun onCreateDialog(")
        val refused = dialog.substringAfter("if (result!!.refused) {").substringBefore("} else if (result!!.isFailed) {")
        assertTrue("the refusal is decided before the generic failure", dialog.indexOf("if (result!!.refused) {") in
            0 until dialog.indexOf("} else if (result!!.isFailed) {"))
        assertTrue(refused.contains(".setMessage(result!!.failureMessage ?: getString(R.string.import_dialog_failed_generic))"))
        assertTrue(refused.contains(".setPositiveButton(android.R.string.ok)"))
        assertFalse("no report question", refused.contains("import_dialog_failed_body"))
        assertFalse("no second button", refused.contains("setNegativeButton"))
        assertFalse("nothing reported", refused.contains("Logger.log"))

        // The destination refusal of both device imports, before anything is copied, is the one marked refused.
        for (name in listOf("LocalCalendarImportFragment.kt", "LocalContactImportFragment.kt")) {
            val text = source(name)
            val destination = text.substringAfter("is DeviceImporter.Destination.Ready -> destination.collection")
                .substringBefore("DeviceImporter.copy")
            assertTrue(name, destination.contains("refused = true"))
            assertEquals(name, 1, text.split("refused = true").size - 1)
        }
    }
}
