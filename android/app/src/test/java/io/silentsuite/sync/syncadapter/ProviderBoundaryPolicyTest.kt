package io.silentsuite.sync.syncadapter

import android.accounts.Account
import at.bitfire.ical4android.TaskProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderBoundaryPolicyTest {
    private fun aggregate(vararg outcomes: SyncManager.ProviderOutcome) = outcomes.fold(
        DirectProviderAggregate.NONE,
        ::aggregateDirectProviderOutcome,
    )

    @Test fun `empty and all skipped providers are not success`() {
        assertEquals(DirectProviderAggregate.NONE, aggregate())
        assertEquals(DirectProviderAggregate.NONE, aggregate(SyncManager.ProviderOutcome.SKIPPED, SyncManager.ProviderOutcome.SKIPPED))
    }

    @Test fun `success requires a completed provider and failure survives later cancellation`() {
        assertEquals(DirectProviderAggregate.SUCCESS, aggregate(SyncManager.ProviderOutcome.SUCCESS))
        assertEquals(DirectProviderAggregate.CANCELLED, aggregate(SyncManager.ProviderOutcome.CANCELLED))
        assertEquals(
            DirectProviderAggregate.FAILURE,
            aggregate(SyncManager.ProviderOutcome.FAILURE, SyncManager.ProviderOutcome.CANCELLED),
        )
    }

    @Test fun `outer completion recording preserves known failure despite cancellation`() {
        val before = SyncCompletionSnapshot(0, 0, 0, 0, false, false)
        val cancelledAfterIoFailure = SyncCompletionSnapshot(0, 1, 0, 0, false, true)
        assertEquals(
            CompletedOutcome.NETWORK_FAILURE,
            classifyCompletedOutcome(before, cancelledAfterIoFailure, false),
        )
        assertEquals(
            CompletedOutcome.PROVIDER_FAILURE,
            classifyCompletedOutcome(before, before.copy(fullSyncRequested = true), true),
        )
    }

    @Test fun `both supported task wrappers use the shared task adapter policy`() {
        assertTrue(TASK_OUTCOME_PROVIDERS.containsAll(setOf(
            TaskProvider.ProviderName.OpenTasks,
            TaskProvider.ProviderName.TasksOrg,
        )))
    }

    @Test fun `contacts child outcome requires exact main mapping and propagated attempt`() {
        val main = Account("main", "main-type")
        val target = contactsChildTarget(main, "attempt")
        assertSame(main, target?.mainAccount)
        assertEquals("attempt", target?.attemptId)
        assertEquals(null, contactsChildTarget(main, null))
        assertEquals(null, contactsChildTarget(null, "attempt"))
    }
}
