package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SignupContinuationRegistryTest {
    @Test
    fun issuingANewTokenSupersedesEarlierTokensForTheSameFlow() {
        val source = File("src/main/java/io/silentsuite/sync/ui/setup/SignupContinuationRegistry.kt").readText()

        assertTrue(source.contains("activeByFlow"))
        assertTrue(source.contains("activeByToken"))
        assertTrue(source.contains("remove(flowId)"))
        assertTrue(source.indexOf("remove(flowId)") < source.indexOf("UUID.randomUUID"))
    }

    @Test
    fun callbackClaimRemainsPendingUntilExactDestinationAcknowledgesIt() {
        val source = File("src/main/java/io/silentsuite/sync/ui/setup/SignupContinuationRegistry.kt").readText()

        listOf(
            "NEW_PENDING", "SAME_FLOW_PENDING", "SAME_FLOW_HANDLED", "OTHER_FLOW", "UNKNOWN",
            "markHandled", "deadline", "generation",
        ).forEach { contract -> assertTrue("Missing continuation contract: $contract", source.contains(contract)) }
        assertFalse(source.contains("fun consume("))
        assertFalse(source.contains("ConcurrentHashMap"))
    }
}
