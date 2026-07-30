package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class SetupContinuationPolicyTest {
    @Test fun `all state inventory and action combinations are explicit`() {
        PostLoginSetupState.values().forEach { state ->
            PostLoginSetupOrchestrator.InventoryOutcome.values().forEach { outcome ->
                SetupContinuationPolicy.Action.values().forEach { action ->
                    val expected = state == PostLoginSetupState.PERMISSIONS && when (action) {
                        SetupContinuationPolicy.Action.Continue,
                        SetupContinuationPolicy.Action.SkipIntegrations ->
                            outcome == PostLoginSetupOrchestrator.InventoryOutcome.USABLE ||
                                outcome == PostLoginSetupOrchestrator.InventoryOutcome.LIMITED
                        SetupContinuationPolicy.Action.RetryInventory ->
                            outcome == PostLoginSetupOrchestrator.InventoryOutcome.RECOVERY
                    }
                    assertEquals(
                        "$state / $outcome / $action",
                        expected,
                        SetupContinuationPolicy.permits(state, outcome, action),
                    )
                }
            }
        }
    }
}
