package io.silentsuite.sync.ui.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LatestRequestWinsTest {
    @Test
    fun `old success or running completion cannot replace a newer failure`() {
        val coordinator = LatestRequestWins<AccountDashboardModel>()
        var displayed: AccountDashboardModel? = null
        val oldRequest = coordinator.begin()
        val newerRequest = coordinator.begin()
        val failure = AccountDashboardModel(AccountDashboardState.FAILURE)

        assertTrue(coordinator.publishIfLatest(newerRequest, failure) { displayed = it })
        assertEquals(failure, displayed)

        listOf(AccountDashboardState.SUCCESS, AccountDashboardState.RUNNING).forEach { staleState ->
            assertFalse(coordinator.publishIfLatest(
                oldRequest,
                AccountDashboardModel(staleState),
            ) { displayed = it })
            assertEquals(failure, displayed)
        }
    }

    @Test
    fun `old error completion cannot replace a newer success or running result`() {
        listOf(AccountDashboardState.SUCCESS, AccountDashboardState.RUNNING).forEach { latestState ->
            val coordinator = LatestRequestWins<AccountDashboardModel>()
            var displayed: AccountDashboardModel? = null
            val oldRequest = coordinator.begin()
            val newerRequest = coordinator.begin()
            val latest = AccountDashboardModel(latestState)

            assertTrue(coordinator.publishIfLatest(newerRequest, latest) { displayed = it })
            assertFalse(coordinator.publishIfLatest(
                oldRequest,
                AccountDashboardModel(AccountDashboardState.FAILURE),
            ) { displayed = it })
            assertEquals(latest, displayed)
        }
    }

    @Test
    fun `invalidation rejects an in flight completion`() {
        val coordinator = LatestRequestWins<AccountDashboardModel>()
        var displayed: AccountDashboardModel? = null
        val request = coordinator.begin()

        coordinator.invalidate()

        assertFalse(coordinator.publishIfLatest(
            request,
            AccountDashboardModel(AccountDashboardState.SUCCESS),
        ) { displayed = it })
        assertEquals(null, displayed)
    }
}
