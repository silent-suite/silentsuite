package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostLoginSetupStateTest {
    @Test fun `codec round trips the exact durable state ledger and fails closed`() {
        assertEquals(
            listOf(
                "CREATING", "ACCOUNT_CREATED", "COLLECTIONS", "PERMISSIONS",
                "INITIAL_SYNC", "READY", "COMPLETE", "RECOVERY_REQUIRED",
            ),
            PostLoginSetupState.values().map { it.name },
        )
        PostLoginSetupState.values().forEach {
            assertEquals(it, PostLoginSetupState.decode(it.name, bootstrapped = true))
        }
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupState.decode("future", bootstrapped = true))
        assertEquals(null, PostLoginSetupState.decode(null, bootstrapped = false))
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupState.decode(null, bootstrapped = true))
    }

    @Test fun `reducer is forward only and Done is the only completion`() {
        assertEquals(PostLoginSetupState.ACCOUNT_CREATED, PostLoginSetupState.CREATING.advance())
        assertEquals(PostLoginSetupState.COLLECTIONS, PostLoginSetupState.ACCOUNT_CREATED.advance())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.INITIAL_SYNC.advance())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.READY.advance())
        assertEquals(PostLoginSetupState.COMPLETE, PostLoginSetupState.READY.done())
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, PostLoginSetupState.RECOVERY_REQUIRED.advance())
        assertFalse(PostLoginSetupState.READY.isComplete)
        assertTrue(PostLoginSetupState.COMPLETE.isComplete)
    }

    @Test fun `explicit lifecycle events remain forward only`() {
        assertEquals(PostLoginSetupState.PERMISSIONS, PostLoginSetupState.COLLECTIONS.afterCollections())
        assertEquals(PostLoginSetupState.INITIAL_SYNC,
            PostLoginSetupState.PERMISSIONS.continueWithCurrentIntegrations())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.INITIAL_SYNC.afterInitialSyncRequested())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.READY.afterInitialSyncRequested())
    }
}
