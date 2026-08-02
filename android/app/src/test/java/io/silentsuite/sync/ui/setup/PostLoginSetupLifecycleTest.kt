package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginSetupLifecycleTest {
    @Test fun `safe work advances only to the permission decision`() {
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ConfigureAndroidSync,
            decide(PostLoginSetupState.ACCOUNT_CREATED),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.COLLECTIONS),
            decide(
                PostLoginSetupState.ACCOUNT_CREATED,
                sync = PostLoginSetupOrchestrator.SyncConfigurationOutcome.SUCCEEDED,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.PERMISSIONS),
            decide(
                PostLoginSetupState.COLLECTIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.USABLE,
            ),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.AwaitIntegrationDecision,
            decide(
                PostLoginSetupState.PERMISSIONS,
                inventory = PostLoginSetupOrchestrator.InventoryOutcome.USABLE,
            ),
        )
    }

    @Test fun `recovery and ready require their exact user decisions`() {
        assertEquals(
            PostLoginSetupOrchestrator.Decision.ShowRecovery,
            decide(PostLoginSetupState.RECOVERY_REQUIRED),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.AwaitDone,
            decide(PostLoginSetupState.READY),
        )
        assertEquals(
            PostLoginSetupOrchestrator.Decision.PersistState(PostLoginSetupState.COMPLETE),
            decide(
                PostLoginSetupState.READY,
                userDecision = PostLoginSetupOrchestrator.UserDecision.DONE,
            ),
        )
    }

    private fun decide(
        state: PostLoginSetupState,
        sync: PostLoginSetupOrchestrator.SyncConfigurationOutcome =
            PostLoginSetupOrchestrator.SyncConfigurationOutcome.NOT_STARTED,
        inventory: PostLoginSetupOrchestrator.InventoryOutcome =
            PostLoginSetupOrchestrator.InventoryOutcome.NOT_STARTED,
        userDecision: PostLoginSetupOrchestrator.UserDecision =
            PostLoginSetupOrchestrator.UserDecision.NONE,
    ) = PostLoginSetupOrchestrator.decide(
        PostLoginSetupOrchestrator.Input(
            state = state,
            ownership = PostLoginSetupOrchestrator.Ownership.EXACT,
            syncConfiguration = sync,
            inventory = inventory,
            userDecision = userDecision,
        )
    )
}
