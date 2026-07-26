package io.silentsuite.sync.ui.setup
import org.junit.Assert.assertEquals
import org.junit.Test
class SetupContinuationPolicyTest {
 @Test fun `only usable and limited permissions outcomes continue or skip`() {
  PostLoginSetupState.values().forEach { state -> PostLoginSetupViewModel.InventoryOutcome.values().forEach { outcome ->
   val expected=state==PostLoginSetupState.PERMISSIONS && (outcome==PostLoginSetupViewModel.InventoryOutcome.Usable||outcome==PostLoginSetupViewModel.InventoryOutcome.Limited)
   assertEquals(expected, SetupContinuationPolicy.permits(state,outcome,SetupContinuationPolicy.Action.SkipIntegrations))
   assertEquals(expected, SetupContinuationPolicy.permits(state,outcome,SetupContinuationPolicy.Action.Continue))
  } }
 }
 @Test fun `only recovery can retry inventory`() { assertEquals(true,SetupContinuationPolicy.permits(PostLoginSetupState.PERMISSIONS,PostLoginSetupViewModel.InventoryOutcome.Recovery,SetupContinuationPolicy.Action.RetryInventory)) }
}
