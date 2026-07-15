package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class AccountCreationCallerPolicyTest {
    @Test fun `exists or busy preserves live authenticator flow for credentials retry`() {
        assertEquals(AccountCreationCallerPolicy.Disposition.RetryCredentials,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.EXISTS_OR_BUSY))
    }
    @Test fun `false add is also retryable and never cancellation`() {
        assertEquals(AccountCreationCallerPolicy.Disposition.RetryCredentials,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.NOT_ADDED))
    }
}
