package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore
import org.junit.Assert.assertEquals
import org.junit.Test

class AccountDashboardStateTest {
    private fun input(
        loaded: Boolean = true, running: Boolean = false, setup: Boolean = true,
        master: Boolean = true, permission: Boolean = true, provider: Boolean = true,
        collections: Boolean = true, status: SyncStatusStore.Status? = SyncStatusStore.Status(),
    ) = AccountDashboardInput(loaded, running, setup, master, permission, provider, collections, status)

    @Test fun `all visible states have deterministic precedence`() {
        assertEquals(AccountDashboardState.LOADING, reduceAccountDashboardState(input(loaded = false, running = true)).state)
        assertEquals(AccountDashboardState.SETUP_REQUIRED, reduceAccountDashboardState(input(setup = false, running = true)).state)
        assertEquals(AccountDashboardState.SETUP_REQUIRED, reduceAccountDashboardState(input(collections = false)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(running = true, master = false)).state)
        assertEquals(AccountDashboardBlock.MASTER_SYNC, reduceAccountDashboardState(input(master = false)).blockedBy)
        assertEquals(AccountDashboardBlock.PERMISSION, reduceAccountDashboardState(input(permission = false)).blockedBy)
        assertEquals(AccountDashboardBlock.PROVIDER, reduceAccountDashboardState(input(provider = false)).blockedBy)
        assertEquals(AccountDashboardState.NEVER_SYNCED, reduceAccountDashboardState(input(status = null)).state)
        assertEquals(AccountDashboardState.NEVER_SYNCED, reduceAccountDashboardState(input()).state)
        assertEquals(AccountDashboardState.SETUP_REQUIRED, reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastFailureAt = 30, lastFailureCategory = SyncStatusStore.FailureCategory.SETUP_REQUIRED))).state)
        assertEquals(AccountDashboardState.SUCCESS, reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 20, lastFailureAt = 10, lastFailureCategory = SyncStatusStore.FailureCategory.NETWORK))).state)
        assertEquals(AccountDashboardState.FAILURE, reduceAccountDashboardState(input(status = SyncStatusStore.Status(lastSuccessAt = 10, lastFailureAt = 20, lastFailureCategory = SyncStatusStore.FailureCategory.PERMISSION))).state)
    }

    @Test fun `inactive without evidence is never success`() {
        assertEquals(AccountDashboardState.NEVER_SYNCED, reduceAccountDashboardState(input(running = false, status = SyncStatusStore.Status())).state)
    }

    @Test fun `inactive incomplete latest contacts generation cannot expose old success`() {
        val status = SyncStatusStore.Status(lastSuccessAt = 10, latestGenerationIncomplete = true, pendingChildren = 1)
        assertEquals(AccountDashboardState.FAILURE, reduceAccountDashboardState(input(running = false, status = status)).state)
        assertEquals(AccountDashboardState.RUNNING, reduceAccountDashboardState(input(running = true, status = status)).state)
    }
}
