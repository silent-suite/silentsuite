package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Wished-for PR2 API: one Android-free decision function over durable evidence.
 *
 * The Activity executes one returned effect and then calls [PostLoginSetupOrchestrator.decide]
 * again with freshly read durable facts. Neither Activity callbacks nor rendering own transitions.
 */
class PostLoginSetupOrchestratorTest {
    private val exact = PostLoginSetupOrchestrator.Ownership.EXACT
    private val notStarted = PostLoginSetupOrchestrator.InventoryOutcome.NOT_STARTED
    private val usable = PostLoginSetupOrchestrator.InventoryOutcome.USABLE
    private val none = PostLoginSetupOrchestrator.UserDecision.NONE

    @Test
    fun `every durable state has one cold-start decision`() {
        val expected = mapOf(
            PostLoginSetupState.CREATING to
                PostLoginSetupOrchestrator.Decision.RequireRecovery,
            PostLoginSetupState.ACCOUNT_CREATED to
                PostLoginSetupOrchestrator.Decision.ConfigureAndroidSync,
            PostLoginSetupState.COLLECTIONS to
                PostLoginSetupOrchestrator.Decision.LoadInventory,
            PostLoginSetupState.PERMISSIONS to
                PostLoginSetupOrchestrator.Decision.LoadInventory,
            PostLoginSetupState.INITIAL_SYNC to
                PostLoginSetupOrchestrator.Decision.PrepareInitialSyncRequestId,
            PostLoginSetupState.READY to
                PostLoginSetupOrchestrator.Decision.AwaitDone,
            PostLoginSetupState.COMPLETE to
                PostLoginSetupOrchestrator.Decision.OpenDashboard,
            PostLoginSetupState.RECOVERY_REQUIRED to
                PostLoginSetupOrchestrator.Decision.ShowRecovery,
        )

        assertEquals(PostLoginSetupState.values().toSet(), expected.keys)
        expected.forEach { (state, decision) ->
            assertEquals(decision, decide(state = state))
        }
    }

    @Test
    fun `account configuration and every inventory outcome are total and forward only`() {
        val configuration = mapOf(
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.NOT_STARTED to
                PostLoginSetupOrchestrator.Decision.ConfigureAndroidSync,
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.SUCCEEDED to
                PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.COLLECTIONS),
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.FAILED to
                PostLoginSetupOrchestrator.Decision.ShowSyncConfigurationFailure,
        )
        assertEquals(
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.values().toSet(),
            configuration.keys,
        )
        configuration.forEach { (outcome, decision) ->
            assertEquals(
                decision,
                decide(
                    state = PostLoginSetupState.ACCOUNT_CREATED,
                    syncConfiguration = outcome,
                ),
            )
        }

        val inventory = mapOf(
            PostLoginSetupOrchestrator.InventoryOutcome.NOT_STARTED to
                PostLoginSetupOrchestrator.Decision.LoadInventory,
            PostLoginSetupOrchestrator.InventoryOutcome.LOADING to
                PostLoginSetupOrchestrator.Decision.WaitForInventory,
            PostLoginSetupOrchestrator.InventoryOutcome.USABLE to
                PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.PERMISSIONS),
            PostLoginSetupOrchestrator.InventoryOutcome.LIMITED to
                PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.PERMISSIONS),
            PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY to
                PostLoginSetupOrchestrator.Decision.ShowInventoryRecovery,
        )
        assertEquals(
            PostLoginSetupOrchestrator.InventoryOutcome.values().toSet(),
            inventory.keys,
        )
        inventory.forEach { (outcome, decision) ->
            assertEquals(
                decision,
                decide(state = PostLoginSetupState.COLLECTIONS, inventory = outcome),
            )
        }

        assertEquals(
            PostLoginSetupOrchestrator.Decision.LoadInventory,
            decide(
                state = PostLoginSetupState.PERMISSIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.NOT_STARTED,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.WaitForInventory,
            decide(
                state = PostLoginSetupState.PERMISSIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.LOADING,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ShowInventoryRecovery,
            decide(
                state = PostLoginSetupState.PERMISSIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY,
            ),
        )
    }

    @Test
    fun `every user decision is admitted only at its durable decision point`() {
        val expectedAtPermissions = mapOf(
            PostLoginSetupOrchestrator.UserDecision.NONE to
                PostLoginSetupOrchestrator.Decision.AwaitIntegrationDecision,
            PostLoginSetupOrchestrator.UserDecision.CONTINUE to
                PostLoginSetupOrchestrator.Decision.BeginInitialSync(limited = false),
            PostLoginSetupOrchestrator.UserDecision.SKIP_INTEGRATIONS to
                PostLoginSetupOrchestrator.Decision.BeginInitialSync(limited = true),
            PostLoginSetupOrchestrator.UserDecision.RETRY_INVENTORY to
                PostLoginSetupOrchestrator.Decision.IgnoreUserDecision,
            PostLoginSetupOrchestrator.UserDecision.DONE to
                PostLoginSetupOrchestrator.Decision.IgnoreUserDecision,
            PostLoginSetupOrchestrator.UserDecision.REMOVE_INCOMPLETE to
                PostLoginSetupOrchestrator.Decision.IgnoreUserDecision,
            PostLoginSetupOrchestrator.UserDecision.OPEN_ANDROID_SETTINGS to
                PostLoginSetupOrchestrator.Decision.IgnoreUserDecision,
        )
        assertEquals(
            PostLoginSetupOrchestrator.UserDecision.values().toSet(),
            expectedAtPermissions.keys,
        )
        expectedAtPermissions.forEach { (userDecision, expected) ->
            assertEquals(
                expected,
                decide(
                    state = PostLoginSetupState.PERMISSIONS,
                    inventory = usable,
                    userDecision = userDecision,
                ),
            )
        }

        assertEquals(
            PostLoginSetupOrchestrator.Decision.LoadInventory,
            decide(
                state = PostLoginSetupState.PERMISSIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY,
                userDecision = PostLoginSetupOrchestrator.UserDecision.RETRY_INVENTORY,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.COMPLETE),
            decide(
                state = PostLoginSetupState.READY,
                userDecision = PostLoginSetupOrchestrator.UserDecision.DONE,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.RemoveIncompleteAccount,
            decide(
                state = PostLoginSetupState.RECOVERY_REQUIRED,
                userDecision = PostLoginSetupOrchestrator.UserDecision.REMOVE_INCOMPLETE,
            ),
        )
    }

    @Test
    fun `ambiguous missing and recovery ownership never mutate an adopted row`() {
        val decisions = mapOf(
            PostLoginSetupOrchestrator.Ownership.EXACT to
                PostLoginSetupOrchestrator.Decision.AwaitIntegrationDecision,
            PostLoginSetupOrchestrator.Ownership.MISSING_GENERATION to
                PostLoginSetupOrchestrator.Decision.ResolveInAndroidSettings,
            PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH to
                PostLoginSetupOrchestrator.Decision.ResolveInAndroidSettings,
            PostLoginSetupOrchestrator.Ownership.OWNED_ROW_MISSING to
                PostLoginSetupOrchestrator.Decision.ClearOwnedRecordAndReturnToLogin,
            PostLoginSetupOrchestrator.Ownership.UNOWNED_ROW_MISSING to
                PostLoginSetupOrchestrator.Decision.ReturnToLogin,
        )
        assertEquals(PostLoginSetupOrchestrator.Ownership.values().toSet(), decisions.keys)
        decisions.forEach { (ownership, expected) ->
            assertEquals(
                expected,
                decide(
                    state = PostLoginSetupState.PERMISSIONS,
                    ownership = ownership,
                    inventory = usable,
                ),
            )
        }

        assertEquals(
            PostLoginSetupOrchestrator.Decision.ResolveInAndroidSettings,
            decide(
                state = PostLoginSetupState.RECOVERY_REQUIRED,
                ownership = PostLoginSetupOrchestrator.Ownership.GENERATION_MISMATCH,
                userDecision = PostLoginSetupOrchestrator.UserDecision.REMOVE_INCOMPLETE,
            ),
        )
    }

    @Test
    fun `request id is prepared once reused for dispatch and cleaned only after ready`() {
        val requestId = "setup-request-123"

        // Cold INITIAL_SYNC: prepare the bounded marker before any sync evidence or dispatch.
        assertEquals(
            PostLoginSetupOrchestrator.Decision.PrepareInitialSyncRequestId,
            decide(state = PostLoginSetupState.INITIAL_SYNC),
        )

        // Crash after prepare, during status recording, or between recording and platform
        // dispatch: every restart dispatches with the exact same durable identifier.
        repeat(3) {
            assertEquals(
                PostLoginSetupOrchestrator.Decision.DispatchInitialSync(requestId),
                decide(
                    state = PostLoginSetupState.INITIAL_SYNC,
                    initialSyncRequestId = requestId,
                ),
            )
        }

        // Crash after dispatch but before READY has the same safe, correlated replay.
        assertEquals(
            PostLoginSetupOrchestrator.Decision.DispatchInitialSync(requestId),
            decide(
                state = PostLoginSetupState.INITIAL_SYNC,
                initialSyncRequestId = requestId,
            ),
        )

        // Crash after READY but before cleanup may only clear the inert marker.
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ClearInitialSyncRequestId(requestId),
            decide(
                state = PostLoginSetupState.READY,
                initialSyncRequestId = requestId,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.AwaitDone,
            decide(state = PostLoginSetupState.READY),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ClearInitialSyncRequestId(requestId),
            decide(
                state = PostLoginSetupState.COMPLETE,
                initialSyncRequestId = requestId,
            ),
        )
    }

    @Test
    fun `returned denial policy is per integration and never upgrades unknown evidence`() {
        PostLoginSetupOrchestrator.Integration.values().forEach { integration ->
            assertEquals(
                PostLoginSetupOrchestrator.Decision.ShowReturnedDenials(
                    mapOf(
                        integration to
                            PostLoginSetupOrchestrator.ReturnedDenial.CAN_ASK_AGAIN
                    )
                ),
                continueWith(
                    integration,
                    PostLoginSetupOrchestrator.PermissionEvidence.DENIED_CAN_ASK_RETURNED,
                ),
            )
            assertEquals(
                PostLoginSetupOrchestrator.Decision.ShowReturnedDenials(
                    mapOf(
                        integration to
                            PostLoginSetupOrchestrator.ReturnedDenial.BLOCKED_OPEN_SETTINGS
                    )
                ),
                continueWith(
                    integration,
                    PostLoginSetupOrchestrator.PermissionEvidence.DENIED_BLOCKED_RETURNED,
                ),
            )
            assertEquals(
                PostLoginSetupOrchestrator.Decision.RequestPermissions(setOf(integration)),
                continueWith(
                    integration,
                    PostLoginSetupOrchestrator.PermissionEvidence.UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT,
                ),
            )
            assertEquals(
                PostLoginSetupOrchestrator.Decision.RequestPermissions(setOf(integration)),
                continueWith(
                    integration,
                    PostLoginSetupOrchestrator.PermissionEvidence.NEWLY_ELIGIBLE,
                ),
            )
        }

        assertEquals(
            PostLoginSetupOrchestrator.Decision.BeginInitialSync(limited = true),
            continueWith(
                PostLoginSetupOrchestrator.Integration.TASKS,
                PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ShowInventoryRecovery,
            continueWith(
                PostLoginSetupOrchestrator.Integration.CALENDAR,
                PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ShowInventoryRecovery,
            continueWith(
                PostLoginSetupOrchestrator.Integration.CONTACTS,
                PostLoginSetupOrchestrator.PermissionEvidence.NO_PROVIDER,
            ),
        )
    }

    @Test
    fun `explicit success admits permissions granted before and during the callback`() {
        val read = "android.permission.READ_CONTACTS"
        val write = "android.permission.WRITE_CONTACTS"

        assertEquals(
            PostLoginSetupOrchestrator.PermissionEvidence.GRANTED,
            PostLoginSetupOrchestrator.returnedPermissionEvidence(
                expectedPermissions = setOf(read, write),
                explicitResults = mapOf(write to true),
                grantedPermissions = setOf(read, write),
                canAskAgain = false,
            ),
        )
        assertEquals(
            null,
            PostLoginSetupOrchestrator.returnedPermissionEvidence(
                expectedPermissions = setOf(read, write),
                explicitResults = mapOf(write to true),
                grantedPermissions = setOf(read),
                canAskAgain = false,
            ),
        )
    }

    private fun continueWith(
        integration: PostLoginSetupOrchestrator.Integration,
        evidence: PostLoginSetupOrchestrator.PermissionEvidence,
    ) = decide(
        state = PostLoginSetupState.PERMISSIONS,
        inventory = usable,
        userDecision = PostLoginSetupOrchestrator.UserDecision.CONTINUE,
        permissions = mapOf(integration to evidence),
    )

    private fun decide(
        state: PostLoginSetupState,
        ownership: PostLoginSetupOrchestrator.Ownership = exact,
        syncConfiguration: PostLoginSetupOrchestrator.SyncConfigurationOutcome =
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.NOT_STARTED,
        inventory: PostLoginSetupOrchestrator.InventoryOutcome = notStarted,
        userDecision: PostLoginSetupOrchestrator.UserDecision = none,
        permissions: Map<
            PostLoginSetupOrchestrator.Integration,
            PostLoginSetupOrchestrator.PermissionEvidence,
        > = emptyMap(),
        initialSyncRequestId: String? = null,
    ): PostLoginSetupOrchestrator.Decision =
        PostLoginSetupOrchestrator.decide(
            PostLoginSetupOrchestrator.Input(
                state = state,
                ownership = ownership,
                syncConfiguration = syncConfiguration,
                inventory = inventory,
                userDecision = userDecision,
                permissions = permissions,
                initialSyncRequestId = initialSyncRequestId,
            )
        )
}
