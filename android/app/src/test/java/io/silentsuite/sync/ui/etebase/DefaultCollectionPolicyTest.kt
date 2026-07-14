package io.silentsuite.sync.ui.etebase

import io.silentsuite.sync.Constants.ETEBASE_TYPE_ADDRESS_BOOK
import io.silentsuite.sync.Constants.ETEBASE_TYPE_CALENDAR
import io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS
import org.junit.Assert.assertEquals
import org.junit.Test

class DefaultCollectionPolicyTest {
    @Test
    fun partialCompletionCreatesOnlyMissingDefaultTypes() {
        val missing = missingDefaultCollections(setOf(ETEBASE_TYPE_ADDRESS_BOOK))

        assertEquals(
            listOf(ETEBASE_TYPE_CALENDAR, ETEBASE_TYPE_TASKS),
            missing.map { it.collectionType },
        )
    }

    @Test
    fun completeDefaultsCreateNothingOnRetry() {
        val missing = missingDefaultCollections(
            setOf(
                ETEBASE_TYPE_ADDRESS_BOOK,
                ETEBASE_TYPE_CALENDAR,
                ETEBASE_TYPE_TASKS,
            ),
        )

        assertEquals(emptyList<DefaultCollectionSpec>(), missing)
    }

    @Test
    fun unrelatedCollectionsDoNotSuppressDefaults() {
        val missing = missingDefaultCollections(setOf("io.silentsuite.notes"))

        assertEquals(
            listOf(
                ETEBASE_TYPE_ADDRESS_BOOK,
                ETEBASE_TYPE_CALENDAR,
                ETEBASE_TYPE_TASKS,
            ),
            missing.map { it.collectionType },
        )
    }
}
