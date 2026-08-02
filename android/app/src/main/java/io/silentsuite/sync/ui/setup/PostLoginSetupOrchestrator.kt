package io.silentsuite.sync.ui.setup

/**
 * Android-free decision table for resumable post-login setup.
 *
 * Callers execute at most one returned decision, read durable facts again, and decide again.
 */
object PostLoginSetupOrchestrator {
    enum class Ownership {
        EXACT,
        MISSING_GENERATION,
        GENERATION_MISMATCH,
        OWNED_ROW_MISSING,
        UNOWNED_ROW_MISSING,
    }

    enum class SyncConfigurationOutcome { NOT_STARTED, SUCCEEDED, FAILED }
    enum class InventoryOutcome { NOT_STARTED, LOADING, USABLE, LIMITED, RECOVERY }
    enum class UserDecision {
        NONE,
        CONTINUE,
        SKIP_INTEGRATIONS,
        RETRY_INVENTORY,
        DONE,
        REMOVE_INCOMPLETE,
        OPEN_ANDROID_SETTINGS,
    }

    enum class Integration { CALENDAR, CONTACTS, TASKS }
    enum class PermissionEvidence {
        GRANTED,
        DENIED_CAN_ASK_RETURNED,
        DENIED_BLOCKED_RETURNED,
        UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT,
        NEWLY_ELIGIBLE,
        NO_PROVIDER,
    }

    /** Classifies only an explicit platform callback; prior grants may be absent from its map. */
    fun returnedPermissionEvidence(
        expectedPermissions: Set<String>,
        explicitResults: Map<String, Boolean>,
        grantedPermissions: Set<String>,
        canAskAgain: Boolean,
    ): PermissionEvidence? = when {
        explicitResults.isEmpty() -> null
        explicitResults.values.any { granted -> !granted } && canAskAgain ->
            PermissionEvidence.DENIED_CAN_ASK_RETURNED
        explicitResults.values.any { granted -> !granted } ->
            PermissionEvidence.DENIED_BLOCKED_RETURNED
        explicitResults.values.all { granted -> granted } &&
            expectedPermissions.all(grantedPermissions::contains) -> PermissionEvidence.GRANTED
        else -> null
    }

    enum class ReturnedDenial { CAN_ASK_AGAIN, BLOCKED_OPEN_SETTINGS }

    data class Input(
        val state: PostLoginSetupState,
        val ownership: Ownership,
        val syncConfiguration: SyncConfigurationOutcome = SyncConfigurationOutcome.NOT_STARTED,
        val inventory: InventoryOutcome = InventoryOutcome.NOT_STARTED,
        val userDecision: UserDecision = UserDecision.NONE,
        val permissions: Map<Integration, PermissionEvidence> = emptyMap(),
        val initialSyncRequestId: String? = null,
    )

    sealed class Decision {
        object RequireRecovery : Decision()
        object ConfigureAndroidSync : Decision()
        object ShowSyncConfigurationFailure : Decision()
        object LoadInventory : Decision()
        object WaitForInventory : Decision()
        object ShowInventoryRecovery : Decision()
        object AwaitIntegrationDecision : Decision()
        object IgnoreUserDecision : Decision()
        object PrepareInitialSyncRequestId : Decision()
        object AwaitDone : Decision()
        object OpenDashboard : Decision()
        object ShowRecovery : Decision()
        object ResolveInAndroidSettings : Decision()
        object ClearOwnedRecordAndReturnToLogin : Decision()
        object ReturnToLogin : Decision()
        object RemoveIncompleteAccount : Decision()
        data class PersistState(val state: PostLoginSetupState) : Decision()
        data class BeginInitialSync(val limited: Boolean) : Decision()
        data class RequestPermissions(val integrations: Set<Integration>) : Decision()
        data class ShowReturnedDenials(
            val denials: Map<Integration, ReturnedDenial>,
        ) : Decision()
        data class DispatchInitialSync(val requestId: String) : Decision()
        data class ClearInitialSyncRequestId(val requestId: String) : Decision()
    }

    fun decide(input: Input): Decision {
        when (input.ownership) {
            Ownership.MISSING_GENERATION,
            Ownership.GENERATION_MISMATCH -> return Decision.ResolveInAndroidSettings
            Ownership.OWNED_ROW_MISSING -> return Decision.ClearOwnedRecordAndReturnToLogin
            Ownership.UNOWNED_ROW_MISSING -> return Decision.ReturnToLogin
            Ownership.EXACT -> Unit
        }

        if (
            input.initialSyncRequestId != null &&
            (input.state == PostLoginSetupState.READY ||
                input.state == PostLoginSetupState.COMPLETE)
        ) {
            return Decision.ClearInitialSyncRequestId(input.initialSyncRequestId)
        }

        return when (input.state) {
            PostLoginSetupState.CREATING -> Decision.RequireRecovery
            PostLoginSetupState.ACCOUNT_CREATED -> when (input.syncConfiguration) {
                SyncConfigurationOutcome.NOT_STARTED -> Decision.ConfigureAndroidSync
                SyncConfigurationOutcome.SUCCEEDED ->
                    Decision.PersistState(PostLoginSetupState.COLLECTIONS)
                SyncConfigurationOutcome.FAILED -> Decision.ShowSyncConfigurationFailure
            }
            PostLoginSetupState.COLLECTIONS -> inventoryDecision(input)
            PostLoginSetupState.PERMISSIONS -> permissionsDecision(input)
            PostLoginSetupState.INITIAL_SYNC ->
                input.initialSyncRequestId?.let(Decision::DispatchInitialSync)
                    ?: Decision.PrepareInitialSyncRequestId
            PostLoginSetupState.READY ->
                if (input.userDecision == UserDecision.DONE) {
                    Decision.PersistState(PostLoginSetupState.COMPLETE)
                } else {
                    Decision.AwaitDone
                }
            PostLoginSetupState.COMPLETE -> Decision.OpenDashboard
            PostLoginSetupState.RECOVERY_REQUIRED ->
                if (input.userDecision == UserDecision.REMOVE_INCOMPLETE) {
                    Decision.RemoveIncompleteAccount
                } else {
                    Decision.ShowRecovery
                }
        }
    }

    private fun inventoryDecision(input: Input): Decision = when (input.inventory) {
        InventoryOutcome.NOT_STARTED -> Decision.LoadInventory
        InventoryOutcome.LOADING -> Decision.WaitForInventory
        InventoryOutcome.USABLE,
        InventoryOutcome.LIMITED -> Decision.PersistState(PostLoginSetupState.PERMISSIONS)
        InventoryOutcome.RECOVERY -> Decision.ShowInventoryRecovery
    }

    private fun permissionsDecision(input: Input): Decision {
        when (input.inventory) {
            InventoryOutcome.NOT_STARTED -> return Decision.LoadInventory
            InventoryOutcome.LOADING -> return Decision.WaitForInventory
            InventoryOutcome.RECOVERY ->
                return if (input.userDecision == UserDecision.RETRY_INVENTORY) {
                    Decision.LoadInventory
                } else {
                    Decision.ShowInventoryRecovery
                }
            InventoryOutcome.USABLE,
            InventoryOutcome.LIMITED -> Unit
        }

        return when (input.userDecision) {
            UserDecision.NONE -> Decision.AwaitIntegrationDecision
            UserDecision.SKIP_INTEGRATIONS -> Decision.BeginInitialSync(limited = true)
            UserDecision.CONTINUE -> continueWithPermissions(input)
            UserDecision.RETRY_INVENTORY,
            UserDecision.DONE,
            UserDecision.REMOVE_INCOMPLETE,
            UserDecision.OPEN_ANDROID_SETTINGS -> Decision.IgnoreUserDecision
        }
    }

    private fun continueWithPermissions(input: Input): Decision {
        val denials = input.permissions.mapNotNull { (integration, evidence) ->
            when (evidence) {
                PermissionEvidence.DENIED_CAN_ASK_RETURNED ->
                    integration to ReturnedDenial.CAN_ASK_AGAIN
                PermissionEvidence.DENIED_BLOCKED_RETURNED ->
                    integration to ReturnedDenial.BLOCKED_OPEN_SETTINGS
                else -> null
            }
        }.toMap()
        if (denials.isNotEmpty()) return Decision.ShowReturnedDenials(denials)

        val unavailable = input.permissions
            .filterValues { it == PermissionEvidence.NO_PROVIDER }
            .keys
        if (Integration.CALENDAR in unavailable || Integration.CONTACTS in unavailable) {
            return Decision.ShowInventoryRecovery
        }

        val requestable = input.permissions.mapNotNull { (integration, evidence) ->
            integration.takeIf {
                evidence == PermissionEvidence.NEWLY_ELIGIBLE ||
                    evidence == PermissionEvidence.UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT
            }
        }.toSet()
        if (requestable.isNotEmpty()) return Decision.RequestPermissions(requestable)

        return Decision.BeginInitialSync(
            limited = input.inventory == InventoryOutcome.LIMITED ||
                Integration.TASKS in unavailable,
        )
    }
}
