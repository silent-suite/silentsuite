package io.silentsuite.sync.ui.importlocal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
