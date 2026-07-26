package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PostLoginSetupStateTest {
    @Test fun `codec accepts supported states and rejects unknown`() {
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.decode("READY", bootstrapped = true))
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

    @Test fun `initial sync is requested before the non blocking ready transition`() {
        assertEquals(PostLoginSetupState.PERMISSIONS, PostLoginSetupState.COLLECTIONS.afterCollections())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.INITIAL_SYNC.afterInitialSyncRequested())
        assertEquals(PostLoginSetupState.READY, PostLoginSetupState.READY.afterInitialSyncRequested())
    }
}
