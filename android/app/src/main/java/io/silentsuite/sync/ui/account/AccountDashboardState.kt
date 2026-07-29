package io.silentsuite.sync.ui.account

import io.silentsuite.sync.syncadapter.SyncStatusStore

enum class AccountDashboardState {
    LOADING, RUNNING, SETTLING, QUEUED, REQUESTED, NEVER_SYNCED, SUCCESS, FAILURE,
    TRANSIENT, INTERRUPTED, ACTION_REQUIRED, BLOCKED, SETUP_REQUIRED,
}
enum class AccountDashboardBlock { MASTER_SYNC, PERMISSION, PROVIDER }
data class DashboardSecondaryIssue(
    val category: SyncStatusStore.FailureCategory? = null,
    val state: AccountDashboardState,
    val blockedBy: AccountDashboardBlock? = null,
    val serviceIndex: Int,
)
data class AccountDashboardModel(
    val state: AccountDashboardState,
    val blockedBy: AccountDashboardBlock? = null,
    val setupDueToMissingCollections: Boolean = false,
    val failure: SyncStatusStore.FailureCategory? = null,
    val secondaryIssues: List<DashboardSecondaryIssue> = emptyList(),
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
    val pending: Boolean = false,
    val now: Long = 0,
    val windows: SyncLifecycleWindows = SyncLifecycleWindows(),
)

enum class AccountDashboardLabel {
    CHECKING, SYNCING, SETTLING, QUEUED, REQUESTED, NEVER_SYNCED, SYNCED, INTERRUPTED,
    NETWORK, AUTHENTICATION, CONFIGURATION, PROVIDER, STORAGE, PARENT_REFRESH, CHILD_REMOVED, UNKNOWN,
    SYNC_PAUSED, PERMISSION_NEEDED, TASK_APP_NEEDED, SETUP_NEEDED, MIXED_FAILURE,
    /** Retained only for source compatibility; presentation never selects it. */ NEEDS_ATTENTION,
}
enum class AccountDashboardIcon { PROGRESS, SYNC, HISTORY, SUCCESS, WARNING, PAUSED, PERMISSION, PROVIDER }
enum class AccountDashboardTone { NEUTRAL, PRIMARY, SUCCESS, WARNING, ERROR }
enum class AccountDashboardAction {
    NONE, SYNC_NOW, RETRY_SYNC, ENABLE_SYNC, FIX_PERMISSIONS, INSTALL_TASK_APP, REVIEW_SETUP,
    OPEN_ACCOUNT_SETTINGS, OPEN_SYNC_SETTINGS,
}

data class AccountDashboardPresentation(
    val label: AccountDashboardLabel,
    val icon: AccountDashboardIcon,
    val tone: AccountDashboardTone,
    val action: AccountDashboardAction,
    val lastMeaningfulAt: Long?,
    val accessibilityKey: String,
    val secondaryIssues: List<DashboardSecondaryIssue> = emptyList(),
)
data class AccountDashboardResult(val timestamp: Long, val success: Boolean)

/** Pure lifecycle precedence. Expiry is a store command, never a render side effect. */
fun reduceAccountDashboardState(input: AccountDashboardInput): AccountDashboardModel {
    val status = input.status
    if (input.loadFailed) return AccountDashboardModel(AccountDashboardState.TRANSIENT, failure = SyncStatusStore.FailureCategory.STORAGE)
    if (!input.loaded) return AccountDashboardModel(AccountDashboardState.LOADING)
    if (status?.structuralStorageFailure == true)
        return AccountDashboardModel(AccountDashboardState.TRANSIENT, failure = SyncStatusStore.FailureCategory.STORAGE)
    if (input.running) return AccountDashboardModel(AccountDashboardState.RUNNING)
    if (status?.activeAttemptId != null)
        return AccountDashboardModel(AccountDashboardState.SETTLING)
    // Android reports periodic/background pending work without an app-owned request ID.
    if (input.pending)
        return AccountDashboardModel(AccountDashboardState.QUEUED)
    if (status?.activeRequestId != null)
        return AccountDashboardModel(AccountDashboardState.REQUESTED)
    if (!input.setupComplete || !input.collectionsAvailable)
        return AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED, setupDueToMissingCollections = !input.collectionsAvailable)
    if (status?.lastFailureCategory == SyncStatusStore.FailureCategory.SETUP_REQUIRED && latestIsFailure(status))
        return AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED, failure = status.lastFailureCategory)
    if (status != null && latestIsFailure(status) && status.lastFailureCategory == SyncStatusStore.FailureCategory.AUTHENTICATION)
        return failureModel(SyncStatusStore.FailureCategory.AUTHENTICATION)
    if (!input.masterSyncEnabled) return AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.MASTER_SYNC)
    if (status != null && latestIsFailure(status) && status.lastFailureCategory == SyncStatusStore.FailureCategory.PERMISSION)
        return failureModel(SyncStatusStore.FailureCategory.PERMISSION)
    if (!input.permissionReady) return AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PERMISSION)
    if (status != null && latestIsFailure(status) && status.lastFailureCategory == SyncStatusStore.FailureCategory.CONFIGURATION)
        return failureModel(SyncStatusStore.FailureCategory.CONFIGURATION)
    if (!input.providerReady) return AccountDashboardModel(AccountDashboardState.BLOCKED, AccountDashboardBlock.PROVIDER)
    if (status?.latestGenerationIncomplete == true) return AccountDashboardModel(AccountDashboardState.INTERRUPTED,
        failure = SyncStatusStore.FailureCategory.INTERRUPTED)
    if (status == null || (status.lastSuccessAt == null && status.lastFailureAt == null)) return AccountDashboardModel(AccountDashboardState.NEVER_SYNCED)
    if (latestIsFailure(status)) return failureModel(status.lastFailureCategory ?: SyncStatusStore.FailureCategory.UNKNOWN)
    return AccountDashboardModel(AccountDashboardState.SUCCESS)
}

private fun latestIsFailure(status: SyncStatusStore.Status) = status.lastFailureAt != null &&
    when (status.lastTerminalResult) {
        SyncStatusStore.TerminalResult.FAILURE -> true
        SyncStatusStore.TerminalResult.SUCCESS -> false
        null -> status.lastFailureAt >= (status.lastSuccessAt ?: Long.MIN_VALUE)
    }

private fun failureModel(category: SyncStatusStore.FailureCategory) = when (category) {
    SyncStatusStore.FailureCategory.SETUP_REQUIRED -> AccountDashboardModel(AccountDashboardState.SETUP_REQUIRED, failure = category)
    SyncStatusStore.FailureCategory.AUTHENTICATION, SyncStatusStore.FailureCategory.PERMISSION,
    SyncStatusStore.FailureCategory.CONFIGURATION -> AccountDashboardModel(AccountDashboardState.ACTION_REQUIRED, failure = category)
    SyncStatusStore.FailureCategory.INTERRUPTED -> AccountDashboardModel(AccountDashboardState.INTERRUPTED, failure = category)
    else -> AccountDashboardModel(AccountDashboardState.TRANSIENT, failure = category)
}

/** Stable service order is supplied by the caller: Calendar, Contacts, Tasks. */
fun aggregateAccountDashboard(services: List<AccountDashboardModel>): AccountDashboardModel {
    if (services.isEmpty() || services.any { it.state == AccountDashboardState.LOADING }) return AccountDashboardModel(AccountDashboardState.LOADING)
    val current = listOf(AccountDashboardState.RUNNING, AccountDashboardState.SETTLING, AccountDashboardState.QUEUED, AccountDashboardState.REQUESTED)
    val indexed = services.withIndex().toList()
    val issues = indexed.mapNotNull { (index, model) -> asIssue(model, index) }
    current.mapNotNull { wanted -> indexed.firstOrNull { it.value.state == wanted } }.firstOrNull()?.let { primary ->
        return primary.value.copy(secondaryIssues = issues.filter { it.serviceIndex != primary.index }.sortedBy(::issueRank))
    }
    val actionPrimary = indexed.filter { (_, model) -> model.state in setOf(
        AccountDashboardState.SETUP_REQUIRED, AccountDashboardState.ACTION_REQUIRED, AccountDashboardState.BLOCKED,
    ) }.minWithOrNull(compareBy<IndexedValue<AccountDashboardModel>>(
        { actionIssueRank(requireNotNull(asIssue(it.value, it.index))) }, { it.index },
    ))
    actionPrimary?.let { primary ->
        return primary.value.copy(secondaryIssues = issues.filter { it.serviceIndex != primary.index }.sortedBy(::issueRank))
    }
    val terminalIssues = issues.filter { it.state == AccountDashboardState.INTERRUPTED || it.state == AccountDashboardState.TRANSIENT }
    if (terminalIssues.size > 1) {
        val headline = terminalIssues.minWithOrNull(compareBy<DashboardSecondaryIssue>(
            { issueRank(it) }, { it.serviceIndex },
        ))!!
        return AccountDashboardModel(headline.state, failure = headline.category,
            secondaryIssues = terminalIssues.sortedBy(::issueRank))
    }
    if (terminalIssues.size == 1) return services[terminalIssues.single().serviceIndex]
    if (services.all { it.state == AccountDashboardState.SUCCESS }) return AccountDashboardModel(AccountDashboardState.SUCCESS)
    return AccountDashboardModel(AccountDashboardState.NEVER_SYNCED)
}

private fun asIssue(model: AccountDashboardModel, serviceIndex: Int): DashboardSecondaryIssue? = when (model.state) {
    AccountDashboardState.ACTION_REQUIRED, AccountDashboardState.INTERRUPTED, AccountDashboardState.TRANSIENT ->
        model.failure?.let { DashboardSecondaryIssue(it, model.state, serviceIndex = serviceIndex) }
    AccountDashboardState.BLOCKED -> DashboardSecondaryIssue(state = model.state, blockedBy = model.blockedBy, serviceIndex = serviceIndex)
    AccountDashboardState.SETUP_REQUIRED -> DashboardSecondaryIssue(state = model.state, serviceIndex = serviceIndex)
    else -> null
}
private fun issueRank(issue: DashboardSecondaryIssue) = when (issue.state) {
    AccountDashboardState.SETUP_REQUIRED -> 0
    AccountDashboardState.ACTION_REQUIRED -> when (issue.category) {
        SyncStatusStore.FailureCategory.AUTHENTICATION -> 1
        SyncStatusStore.FailureCategory.PERMISSION -> 3
        SyncStatusStore.FailureCategory.CONFIGURATION -> 4
        else -> 6
    }
    AccountDashboardState.BLOCKED -> when (issue.blockedBy) {
        AccountDashboardBlock.MASTER_SYNC -> 2
        AccountDashboardBlock.PERMISSION -> 3
        AccountDashboardBlock.PROVIDER -> 5
        null -> 6
    }
    AccountDashboardState.INTERRUPTED -> 7
    else -> 8
}

private fun actionIssueRank(issue: DashboardSecondaryIssue) = issueRank(issue)

fun latestMeaningfulResult(statuses: List<SyncStatusStore.Status?>): AccountDashboardResult? = statuses.flatMap { status ->
    if (status == null) emptyList() else when (status.lastTerminalResult) {
        SyncStatusStore.TerminalResult.SUCCESS -> listOfNotNull(status.lastTerminalAt?.let { AccountDashboardResult(it, true) })
        SyncStatusStore.TerminalResult.FAILURE -> listOfNotNull(status.lastTerminalAt?.let { AccountDashboardResult(it, false) })
        null -> listOfNotNull(status.lastSuccessAt?.let { AccountDashboardResult(it, true) },
            status.lastFailureAt?.let { AccountDashboardResult(it, false) })
    }
}.maxWithOrNull(compareBy<AccountDashboardResult>({ it.timestamp }, { !it.success }))

fun presentAccountDashboard(model: AccountDashboardModel, lastMeaningfulAt: Long?): AccountDashboardPresentation {
    val semantics = if ((model.state == AccountDashboardState.TRANSIENT || model.state == AccountDashboardState.INTERRUPTED) &&
        model.secondaryIssues.map { it.category }.distinct().size > 1) {
        Semantics(AccountDashboardLabel.MIXED_FAILURE, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    } else when (model.state) {
        AccountDashboardState.LOADING -> Semantics(AccountDashboardLabel.CHECKING, AccountDashboardIcon.PROGRESS, AccountDashboardTone.NEUTRAL, AccountDashboardAction.NONE)
        AccountDashboardState.RUNNING -> Semantics(AccountDashboardLabel.SYNCING, AccountDashboardIcon.SYNC, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE)
        AccountDashboardState.SETTLING -> Semantics(AccountDashboardLabel.SETTLING, AccountDashboardIcon.PROGRESS, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE)
        AccountDashboardState.QUEUED -> Semantics(AccountDashboardLabel.QUEUED, AccountDashboardIcon.PROGRESS, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE)
        AccountDashboardState.REQUESTED -> Semantics(AccountDashboardLabel.REQUESTED, AccountDashboardIcon.PROGRESS, AccountDashboardTone.PRIMARY, AccountDashboardAction.NONE)
        AccountDashboardState.NEVER_SYNCED -> Semantics(AccountDashboardLabel.NEVER_SYNCED, AccountDashboardIcon.HISTORY, AccountDashboardTone.NEUTRAL, AccountDashboardAction.SYNC_NOW)
        AccountDashboardState.SUCCESS -> Semantics(AccountDashboardLabel.SYNCED, AccountDashboardIcon.SUCCESS, AccountDashboardTone.SUCCESS, AccountDashboardAction.SYNC_NOW)
        AccountDashboardState.SETUP_REQUIRED -> Semantics(AccountDashboardLabel.SETUP_NEEDED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.REVIEW_SETUP)
        AccountDashboardState.BLOCKED -> when (model.blockedBy) {
            AccountDashboardBlock.MASTER_SYNC -> Semantics(AccountDashboardLabel.SYNC_PAUSED, AccountDashboardIcon.PAUSED, AccountDashboardTone.WARNING, AccountDashboardAction.ENABLE_SYNC)
            AccountDashboardBlock.PERMISSION -> Semantics(AccountDashboardLabel.PERMISSION_NEEDED, AccountDashboardIcon.PERMISSION, AccountDashboardTone.WARNING, AccountDashboardAction.FIX_PERMISSIONS)
            AccountDashboardBlock.PROVIDER -> Semantics(AccountDashboardLabel.TASK_APP_NEEDED, AccountDashboardIcon.PROVIDER, AccountDashboardTone.WARNING, AccountDashboardAction.INSTALL_TASK_APP)
            null -> Semantics(AccountDashboardLabel.UNKNOWN, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
        }
        AccountDashboardState.ACTION_REQUIRED, AccountDashboardState.TRANSIENT, AccountDashboardState.INTERRUPTED, AccountDashboardState.FAILURE -> failureSemantics(model.failure)
    }
    val key = "${model.state}:${model.failure}:${semantics.label}:$lastMeaningfulAt"
    return AccountDashboardPresentation(semantics.label, semantics.icon, semantics.tone, semantics.action, lastMeaningfulAt, key, model.secondaryIssues)
}

private fun failureSemantics(category: SyncStatusStore.FailureCategory?): Semantics = when (category) {
    SyncStatusStore.FailureCategory.AUTHENTICATION -> Semantics(AccountDashboardLabel.AUTHENTICATION, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.OPEN_ACCOUNT_SETTINGS)
    SyncStatusStore.FailureCategory.PERMISSION -> Semantics(AccountDashboardLabel.PERMISSION_NEEDED, AccountDashboardIcon.PERMISSION, AccountDashboardTone.WARNING, AccountDashboardAction.FIX_PERMISSIONS)
    SyncStatusStore.FailureCategory.CONFIGURATION -> Semantics(AccountDashboardLabel.CONFIGURATION, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.OPEN_SYNC_SETTINGS)
    SyncStatusStore.FailureCategory.INTERRUPTED -> Semantics(AccountDashboardLabel.INTERRUPTED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    SyncStatusStore.FailureCategory.NETWORK -> Semantics(AccountDashboardLabel.NETWORK, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    SyncStatusStore.FailureCategory.STORAGE -> Semantics(AccountDashboardLabel.STORAGE, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    SyncStatusStore.FailureCategory.PARENT_REFRESH -> Semantics(AccountDashboardLabel.PARENT_REFRESH, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    SyncStatusStore.FailureCategory.CHILD_REMOVED -> Semantics(AccountDashboardLabel.CHILD_REMOVED, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    SyncStatusStore.FailureCategory.PROVIDER -> Semantics(AccountDashboardLabel.PROVIDER, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
    else -> Semantics(AccountDashboardLabel.UNKNOWN, AccountDashboardIcon.WARNING, AccountDashboardTone.WARNING, AccountDashboardAction.RETRY_SYNC)
}

class MeaningfulDashboardTransitionDeduper {
    private var lastKey: String? = null
    fun shouldAnnounce(presentation: AccountDashboardPresentation): Boolean {
        if (presentation.label == AccountDashboardLabel.CHECKING) return false
        if (presentation.accessibilityKey == lastKey) return false
        lastKey = presentation.accessibilityKey
        return true
    }
}
private data class Semantics(val label: AccountDashboardLabel, val icon: AccountDashboardIcon, val tone: AccountDashboardTone, val action: AccountDashboardAction)
