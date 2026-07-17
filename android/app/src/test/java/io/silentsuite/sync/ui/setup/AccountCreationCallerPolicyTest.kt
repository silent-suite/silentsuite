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
    @Test fun `failed durable quarantine is settings resolution not credentials retry`() {
        assertEquals(AccountCreationCallerPolicy.Disposition.ResolveInSettings,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.QUARANTINE_FAILED))
    }
    @Test fun `outcome matrix preserves exact recovery and only retries pre row outcomes`() {
        assertEquals(AccountCreationCallerPolicy.Disposition.ContinueToSetup,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.CREATED))
        assertEquals(AccountCreationCallerPolicy.Disposition.ContinueToSetup,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED))
        assertEquals(AccountCreationCallerPolicy.Disposition.ResolveInSettings,
            AccountCreationCallerPolicy.disposition(AccountCreationCoordinator.Result.QUARANTINED))
    }
}
