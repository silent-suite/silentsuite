package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore

enum class AccountDashboardState { LOADING, RUNNING, NEVER_SYNCED, SUCCESS, FAILURE, BLOCKED, SETUP_REQUIRED }
enum class AccountDashboardBlock { MASTER_SYNC, PERMISSION, PROVIDER }
data class AccountDashboardModel(val state: AccountDashboardState, val blockedBy: AccountDashboardBlock? = null)

data class AccountDashboardInput(
    val loaded: Boolean,
    val running: Boolean,
    val setupComplete: Boolean,
    val masterSyncEnabled: Boolean,
    val permissionReady: Boolean,
    val providerReady: Boolean,
    val collectionsAvailable: Boolean,
    val status: SyncStatusStore.Status?,
)

/** Pure precedence reducer; presentation copy/icons/actions remain a Slice 11 concern. */
fun reduceAccountDashboardState(input: AccountDashboardInput): AccountDashboardModel = when {
    !input.loaded -> AccountDashboardModel(AccountDashboardState.LOADING)
    !input.setupComplete || !input.collectionsAvailable -> AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    input.running -> AccountDashboardModel(AccountDashboardState.RUNNING)
    input.status?.lastFailureCategory == SyncStatusStore.FailureCategory.SETUP_REQUIRED &&
        (input.status.lastFailureAt ?: Long.MIN_VALUE) > (input.status.lastSuccessAt ?: Long.MIN_VALUE) ->
        AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    !input.masterSyncEnabled -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
    !input.permissionReady -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
    !input.providerReady -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
    input.status?.latestGenerationIncomplete == true -> AccountDashboardModel(AccountDashboardState.FAILURE)
    input.status == null || (input.status.lastSuccessAt == null && input.status.lastFailureAt == null) -> AccountDashboardModel(AccountDashboardState.NEVER_SYNCED)
    (input.status.lastFailureAt ?: Long.MIN_VALUE) > (input.status.lastSuccessAt ?: Long.MIN_VALUE) -> AccountDashboardModel(AccountDashboardState.FAILURE)
    input.status.lastSuccessAt != null -> AccountDashboardModel(AccountDashboardState.SUCCESS)
    else -> AccountDashboardModel(AccountDashboardState.FAILURE)
}
