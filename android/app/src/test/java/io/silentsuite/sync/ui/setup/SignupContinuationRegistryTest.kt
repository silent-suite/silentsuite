package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SignupContinuationRegistryTest {
    @Test
    fun issuingANewTokenSupersedesEarlierTokensForTheSameFlow() {
        val flowId = "flow-${System.nanoTime()}"
        val firstToken = SignupContinuationRegistry.issue(flowId)
        val secondToken = SignupContinuationRegistry.issue(flowId)

        try {
            assertFalse(SignupContinuationRegistry.isValid(firstToken))
            assertFalse(SignupContinuationRegistry.consume(firstToken, flowId))
            assertTrue(SignupContinuationRegistry.consume(secondToken, flowId))
            assertFalse(SignupContinuationRegistry.isValid(secondToken))
        } finally {
            SignupContinuationRegistry.remove(flowId)
        }
    }
}
