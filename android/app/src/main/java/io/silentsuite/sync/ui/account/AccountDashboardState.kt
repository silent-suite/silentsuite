package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore

enum class AccountDashboardState { LOADING, RUNNING, NEVER_SYNCED, SUCCESS, FAILURE, BLOCKED, SETUP_REQUIRED }
enum class AccountDashboardBlock { MASTER_SYNC, PERMISSION, PROVIDER }
data class AccountDashboardModel(
    val state: AccountDashboardState,
    val blockedBy: AccountDashboardBlock? = null,
    val setupDueToMissingCollections: Boolean = false,
)

data class AccountDashboardInput(
    val loaded: Boolean,
    val running: Boolean,
    val setupComplete: Boolean,
    val masterSyncEnabled: Boolean,
    val permissionReady: Boolean,
    val providerReady: Boolean,
    val collectionsAvailable: Boolean,
    val status: SyncStatusStore.Status?,
    val loadFailed: Boolean = false,
)

enum class AccountDashboardLabel {
    CHECKING, SYNCING, NEVER_SYNCED, SYNCED, NEEDS_ATTENTION, SYNC_PAUSED,
    PERMISSION_NEEDED, TASK_APP_NEEDED, SETUP_NEEDED
}
enum class AccountDashboardIcon { PROGRESS, SYNC, HISTORY, SUCCESS, WARNING, PAUSED, PERMISSION, PROVIDER }
enum class AccountDashboardTone { NEUTRAL, PRIMARY, SUCCESS, WARNING, ERROR }
enum class AccountDashboardAction { NONE, SYNC_NOW, RETRY_SYNC, ENABLE_SYNC, FIX_PERMISSIONS, INSTALL_TASK_APP, REVIEW_SETUP }

data class AccountDashboardPresentation(
    val label: AccountDashboardLabel,
    val icon: AccountDashboardIcon,
    val tone: AccountDashboardTone,
    val action: AccountDashboardAction,
    val lastMeaningfulAt: Long?,
    /** Stable semantic key used to suppress duplicate polite live-region transitions. */
    val accessibilityKey: String,
)

data class AccountDashboardResult(val timestamp: Long, val success: Boolean)

/** Pure precedence reducer. Inactive or requested work is never treated as success evidence. */
fun reduceAccountDashboardState(input: AccountDashboardInput): AccountDashboardModel = when {
    input.loadFailed -> AccountDashboardModel(AccountDashboardState.FAILURE)
    !input.loaded -> AccountDashboardModel(AccountDashboardState.LOADING)
    !input.setupComplete -> AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    input.running -> AccountDashboardModel(AccountDashboardState.RUNNING)
    input.status?.lastFailureCategory == SyncStatusStore.FailureCategory.SETUP_REQUIRED &&
        input.status.lastFailureAt != null &&
        input.status.lastFailureAt >= (input.status.lastSuccessAt ?: Long.MIN_VALUE) ->
        AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    !input.masterSyncEnabled -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
    !input.permissionReady -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
    !input.providerReady -> AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
    !input.collectionsAvailable -> AccountDashboardModel(
        AccountDashboardState.SETUP_REQUIRED,
        setupDueToMissingCollections = true,
    )
    input.status?.latestGenerationIncomplete == true -> AccountDashboardModel(AccountDashboardState.FAILURE)
    input.status == null || (input.status.lastSuccessAt == null && input.status.lastFailureAt == null) -> AccountDashboardModel(AccountDashboardState.NEVER_SYNCED)
    input.status.lastFailureAt != null &&
        input.status.lastFailureAt >= (input.status.lastSuccessAt ?: Long.MIN_VALUE) -> AccountDashboardModel(AccountDashboardState.FAILURE)
    input.status.lastSuccessAt != null -> AccountDashboardModel(AccountDashboardState.SUCCESS)
    else -> AccountDashboardModel(AccountDashboardState.FAILURE)
}

/**
 * Aggregates user-facing services conservatively. Success means all loaded services have durable
 * success evidence; mixed success/unknown remains never-synced rather than implying full health.
 */
fun aggregateAccountDashboard(services: List<AccountDashboardModel>): AccountDashboardModel {
    if (services.isEmpty() || services.any { it.state == AccountDashboardState.LOADING })
        return AccountDashboardModel(AccountDashboardState.LOADING)
    if (services.any {
            it.state == AccountDashboardState.SETUP_REQUIRED && !it.setupDueToMissingCollections
        })
        return AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    if (services.any { it.state == AccountDashboardState.RUNNING })
        return AccountDashboardModel(AccountDashboardState.RUNNING)
    val blocked = services.filter { it.state == AccountDashboardState.BLOCKED }
    if (blocked.isNotEmpty()) {
        val block = listOf(AccountDashboardBlock.MASTER_SYNC, AccountDashboardBlock.PERMISSION, AccountDashboardBlock.PROVIDER)
            .firstOrNull { candidate -> blocked.any { it.blockedBy == candidate } }
        return AccountDashboardModel(AccountDashboardState.BLOCKED, block)
    }
    if (services.any { it.state == AccountDashboardState.SETUP_REQUIRED })
        return AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED)
    if (services.any { it.state == AccountDashboardState.FAILURE })
        return AccountDashboardModel(AccountDashboardState.FAILURE)
    if (services.all { it.state == AccountDashboardState.SUCCESS })
        return AccountDashboardModel(AccountDashboardState.SUCCESS)
    return AccountDashboardModel(AccountDashboardState.NEVER_SYNCED)
}

fun latestMeaningfulResult(statuses: List<SyncStatusStore.Status?>): AccountDashboardResult? =
    statuses.flatMap { status ->
        if (status == null) emptyList() else listOfNotNull(
            status.lastSuccessAt?.let { AccountDashboardResult(it, true) },
            status.lastFailureAt?.let { AccountDashboardResult(it, false) },
        )
    }.maxWithOrNull(compareBy<AccountDashboardResult>({ it.timestamp }, { !it.success }))

fun presentAccountDashboard(model: AccountDashboardModel, lastMeaningfulAt: Long?): AccountDashboardPresentation {
    val semantics = when (model.state) {
        AccountDashboardState.LOADING -> Semantics(AccountDashboardLabel.CHECKING, AccountDashboardIcon.PROGRESS, AccountDashboardTone.NEUTRAL, AccountDashboardAction.NONE)
        AccountDashboardState.RUNNING -> Semantics(AccountDashboardLabel.SYNCING, AccountDashboardIcon.SYNC, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE)
        AccountDashboardState.NEVER_SYNCED -> Semantics(AccountDashboardLabel.NEVER_SYNCED, AccountDashboardIcon.HISTORY, AccountDashboardTone.NEUTRAL, AccountDashboardAction.SYNC_NOW)
        AccountDashboardState.SUCCESS -> Semantics(AccountDashboardLabel.SYNCED, AccountDashboardIcon.SUCCESS, AccountDashboardTone.SUCCESS, AccountDashboardAction.SYNC_NOW)
        AccountDashboardState.FAILURE -> Semantics(AccountDashboardLabel.NEEDS_ATTENTION, AccountDashboardIcon.WARNING, AccountDashboardTone.ERROR, AccountDashboardAction.RETRY_SYNC)
        AccountDashboardState.SETUP_REQUIRED -> Semantics(AccountDashboardLabel.SETUP_NEEDED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.REVIEW_SETUP)
        AccountDashboardState.BLOCKED -> when (model.blockedBy) {
            AccountDashboardBlock.MASTER_SYNC -> Semantics(AccountDashboardLabel.SYNC_PAUSED, AccountDashboardIcon.PAUSED, AccountDashboardTone.WARNING, AccountDashboardAction.ENABLE_SYNC)
            AccountDashboardBlock.PERMISSION -> Semantics(AccountDashboardLabel.PERMISSION_NEEDED, AccountDashboardIcon.PERMISSION, AccountDashboardTone.WARNING, AccountDashboardAction.FIX_PERMISSIONS)
            AccountDashboardBlock.PROVIDER -> Semantics(AccountDashboardLabel.TASK_APP_NEEDED, AccountDashboardIcon.PROVIDER, AccountDashboardTone.WARNING, AccountDashboardAction.INSTALL_TASK_APP)
            null -> Semantics(AccountDashboardLabel.NEEDS_ATTENTION, AccountDashboardIcon.WARNING, AccountDashboardTone.ERROR, AccountDashboardAction.RETRY_SYNC)
        }
    }
    val key = "${model.state}:${model.blockedBy}:${semantics.label}:$lastMeaningfulAt"
    return AccountDashboardPresentation(semantics.label, semantics.icon, semantics.tone, semantics.action, lastMeaningfulAt, key)
}

/** Process-only dedupe. Loading is deliberately silent and does not consume the last transition. */
class MeaningfulDashboardTransitionDeduper {
    private var lastKey: String? = null
    fun shouldAnnounce(presentation: AccountDashboardPresentation): Boolean {
        if (presentation.label == AccountDashboardLabel.CHECKING) return false
        if (presentation.accessibilityKey == lastKey) return false
        lastKey = presentation.accessibilityKey
        return true
    }
}

private data class Semantics(
    val label: AccountDashboardLabel,
    val icon: AccountDashboardIcon,
    val tone: AccountDashboardTone,
    val action: AccountDashboardAction,
)
