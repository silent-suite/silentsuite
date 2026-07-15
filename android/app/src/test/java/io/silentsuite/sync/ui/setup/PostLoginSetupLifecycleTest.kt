package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginSetupLifecycleTest {
    @Test fun `permissions are contextual and a limited choice remains resumable`() {
        assertEquals(PostLoginSetupState.INITIAL_SYNC,
            PostLoginSetupState.PERMISSIONS.continueWithCurrentIntegrations())
        assertEquals(PostLoginSetupState.COLLECTIONS,
            PostLoginSetupState.COLLECTIONS.continueWithCurrentIntegrations())
    }

    @Test fun `recovery never advances to completion`() {
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED,
            PostLoginSetupState.RECOVERY_REQUIRED.advance())
        assertEquals(PostLoginSetupState.RECOVERY_REQUIRED,
            PostLoginSetupState.RECOVERY_REQUIRED.done())
    }
}
