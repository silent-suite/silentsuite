package io.silentsuite.sync.ui.setup

/** Single admission rule for permission continuation; recovery inventory can never be skipped. */
object SetupContinuationPolicy {
    enum class Action { Continue, SkipIntegrations, RetryInventory }
    fun permits(
        state: PostLoginSetupState,
        outcome: PostLoginSetupOrchestrator.InventoryOutcome,
        action: Action,
    ): Boolean = when (action) {
        Action.Continue, Action.SkipIntegrations -> state == PostLoginSetupState.PERMISSIONS &&
            (outcome == PostLoginSetupOrchestrator.InventoryOutcome.USABLE ||
                outcome == PostLoginSetupOrchestrator.InventoryOutcome.LIMITED)
        Action.RetryInventory -> state == PostLoginSetupState.PERMISSIONS &&
            outcome == PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY
    }
}
