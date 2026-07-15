package io.silentsuite.sync.ui

/** Non-secret identity used to keep account destructive work exact and framework-independent. */
data class ExactAccountIdentity(val type: String, val name: String, val creationId: String)

data class CurrentAccountSignOutSnapshot(
    val main: ExactAccountIdentity,
    val children: List<Pair<String, String>>,
    val eligibleSiblings: List<ExactAccountIdentity>
)

data class ActiveAccountReconciliation(val succeeded: Boolean, val active: ExactAccountIdentity?)

sealed class CurrentAccountSignOutState {
    object Idle : CurrentAccountSignOutState()
    object Removing : CurrentAccountSignOutState()
    object CleaningUp : CurrentAccountSignOutState()
    data class RemovalFailed(val errorId: Long) : CurrentAccountSignOutState()
    data class CleanupFailed(val errorId: Long) : CurrentAccountSignOutState()
    data class Complete(val replacement: ExactAccountIdentity?) : CurrentAccountSignOutState()
}

/**
 * Ordered sign-out policy. The snapshot is retained for cleanup-only retry after the main row is
 * absent; a retry can therefore never broaden ownership or issue the main removal twice.
 */
class CurrentAccountSignOutCoordinator(
    private val seams: Seams,
    private val onStateChanged: (CurrentAccountSignOutState) -> Unit = {}
) {
    interface Seams {
        fun snapshot(): CurrentAccountSignOutSnapshot?
        fun cancelSync(identity: Pair<String, String>)
        fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit)
        fun mainGenerationAbsent(main: ExactAccountIdentity): Boolean
        fun clearCache(main: ExactAccountIdentity): Boolean
        fun clearStatus(main: ExactAccountIdentity): Boolean
        fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?): ActiveAccountReconciliation
        fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit)
    }

    var state: CurrentAccountSignOutState = CurrentAccountSignOutState.Idle
        private set
    private var snapshot: CurrentAccountSignOutSnapshot? = null
    private var mainRemovalConfirmed = false
    private var nextErrorId = 1L

    init { onStateChanged(state) }

    fun begin() {
        if (state is CurrentAccountSignOutState.Removing ||
            state is CurrentAccountSignOutState.CleaningUp ||
            state is CurrentAccountSignOutState.Complete) return

        val captured = snapshot ?: runCatching { seams.snapshot() }.getOrNull()?.also { snapshot = it }
        if (captured == null) {
            failRemoval()
            return
        }
        if (mainRemovalConfirmed || state is CurrentAccountSignOutState.CleanupFailed) {
            cleanup(captured)
            return
        }
        if (runCatching { seams.mainGenerationAbsent(captured.main) }.getOrDefault(false)) {
            mainRemovalConfirmed = true
            cleanup(captured)
            return
        }

        transition(CurrentAccountSignOutState.Removing)
        try {
            seams.cancelSync(captured.main.type to captured.main.name)
            captured.children.forEach(seams::cancelSync)
            seams.removeMain(captured.main) { confirmed ->
                if (state !is CurrentAccountSignOutState.Removing) return@removeMain
                if (confirmed && runCatching { seams.mainGenerationAbsent(captured.main) }.getOrDefault(false)) {
                    mainRemovalConfirmed = true
                    cleanup(captured)
                } else failRemoval()
            }
        } catch (_: Exception) {
            failRemoval()
        }
    }

    private fun cleanup(captured: CurrentAccountSignOutSnapshot) {
        transition(CurrentAccountSignOutState.CleaningUp)
        val replacement = AccountSwitcherPolicy.replacement(captured.main, captured.eligibleSiblings)
        val essentialCleanup = runCatching {
            if (!seams.clearCache(captured.main) || !seams.clearStatus(captured.main)) null
            else seams.reconcileActive(captured.main, replacement)
        }.getOrNull()
        if (essentialCleanup?.succeeded != true) {
            failCleanup()
            return
        }
        try {
            seams.removeAndVerifyChildren(captured) { success ->
                if (state !is CurrentAccountSignOutState.CleaningUp) return@removeAndVerifyChildren
                if (success) transition(CurrentAccountSignOutState.Complete(essentialCleanup.active)) else failCleanup()
            }
        } catch (_: Exception) {
            failCleanup()
        }
    }

    private fun failRemoval() = transition(CurrentAccountSignOutState.RemovalFailed(nextErrorId++))
    private fun failCleanup() = transition(CurrentAccountSignOutState.CleanupFailed(nextErrorId++))
    private fun transition(next: CurrentAccountSignOutState) { state = next; onStateChanged(next) }
}

object AccountSwitcherPolicy {
    fun ordered(accounts: List<ExactAccountIdentity>): List<ExactAccountIdentity> =
        accounts.distinct().sortedWith(compareBy<ExactAccountIdentity>({ it.name }, { it.creationId }, { it.type }))

    fun replacement(removed: ExactAccountIdentity, eligible: List<ExactAccountIdentity>): ExactAccountIdentity? =
        ordered(eligible).firstOrNull { it != removed }

    fun canExpand(accountCount: Int) = accountCount >= 1
}

sealed class ActiveAccountReplacementDecision {
    object Preserve : ActiveAccountReplacementDecision()
    data class Replace(val identity: ExactAccountIdentity?) : ActiveAccountReplacementDecision()
}

object ActiveAccountReplacementPolicy {
    fun decide(savedName: String?, savedGeneration: String?, expected: ExactAccountIdentity,
               replacement: ExactAccountIdentity?): ActiveAccountReplacementDecision =
        if (savedName == expected.name && savedGeneration == expected.creationId)
            ActiveAccountReplacementDecision.Replace(replacement)
        else ActiveAccountReplacementDecision.Preserve
}
