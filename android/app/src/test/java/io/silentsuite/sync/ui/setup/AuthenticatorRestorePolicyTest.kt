package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthenticatorRestorePolicyTest {
    @Test fun `same epoch preserves rotation but missing or changed epoch restarts obsolete authenticator`() {
        assertFalse(AuthenticatorRestorePolicy.mustRestartNormally(true, "process-a", "process-a"))
        assertTrue(AuthenticatorRestorePolicy.mustRestartNormally(true, null, "process-b"))
        assertTrue(AuthenticatorRestorePolicy.mustRestartNormally(true, "process-a", "process-b"))
        assertFalse(AuthenticatorRestorePolicy.mustRestartNormally(false, null, "process-b"))
    }
}
