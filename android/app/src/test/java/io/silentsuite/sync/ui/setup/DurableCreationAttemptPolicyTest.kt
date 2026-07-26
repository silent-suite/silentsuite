package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class DurableCreationAttemptPolicyTest {
    private fun outcome(
        rowPresent: Boolean = true,
        creationId: String? = "generation",
        registryOwns: Boolean = true,
        state: PostLoginSetupState? = PostLoginSetupState.ACCOUNT_CREATED
    ) = DurableCreationAttemptPolicy.outcome(
        DurableCreationAttemptPolicy.Evidence(rowPresent, creationId, registryOwns, state))

    @Test fun `post account-created durable states preserve success delivery`() {
        listOf(
            PostLoginSetupState.ACCOUNT_CREATED,
            PostLoginSetupState.COLLECTIONS,
            PostLoginSetupState.PERMISSIONS,
            PostLoginSetupState.INITIAL_SYNC,
            PostLoginSetupState.READY
        ).forEach { assertEquals(DurableCreationAttemptPolicy.Outcome.Created, outcome(state = it)) }
        assertEquals(DurableCreationAttemptPolicy.Outcome.Completed, outcome(state = PostLoginSetupState.COMPLETE))
    }

    @Test fun `exact pre-boundary and recovery states use recovery`() {
        listOf(PostLoginSetupState.CREATING, PostLoginSetupState.RECOVERY_REQUIRED)
            .forEach { assertEquals(DurableCreationAttemptPolicy.Outcome.Recovery, outcome(state = it)) }
    }

    @Test fun `missing or ambiguous generation resolves in settings`() {
        assertEquals(DurableCreationAttemptPolicy.Outcome.SettingsResolution, outcome(creationId = null))
        assertEquals(DurableCreationAttemptPolicy.Outcome.SettingsResolution, outcome(registryOwns = false))
        assertEquals(DurableCreationAttemptPolicy.Outcome.SettingsResolution, outcome(state = null))
    }

    @Test fun `no durable row retries credentials`() {
        assertEquals(DurableCreationAttemptPolicy.Outcome.RetryCredentials, outcome(rowPresent = false))
    }
}
