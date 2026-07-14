package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsAccountRoutePolicyTest {
    private val availableAccounts = setOf("active@example.com", "requested@example.com")

    @Test
    fun validExplicitRouteKeepsTheRequestedAccount() {
        assertEquals(
            "requested@example.com",
            resolveSettingsAccountName(
                hasExplicitRoute = true,
                requestedAccountName = "requested@example.com",
                availableAccountNames = availableAccounts,
                activeAccountName = "active@example.com",
            ),
        )
    }

    @Test
    fun staleExplicitRouteFailsClosedInsteadOfUsingActiveAccount() {
        assertNull(
            resolveSettingsAccountName(
                hasExplicitRoute = true,
                requestedAccountName = "removed@example.com",
                availableAccountNames = availableAccounts,
                activeAccountName = "active@example.com",
            ),
        )
    }

    @Test
    fun globalRouteUsesAnAvailableActiveAccount() {
        assertEquals(
            "active@example.com",
            resolveSettingsAccountName(
                hasExplicitRoute = false,
                requestedAccountName = null,
                availableAccountNames = availableAccounts,
                activeAccountName = "active@example.com",
            ),
        )
    }

    @Test
    fun globalRouteRejectsAStaleActiveAccount() {
        assertNull(
            resolveSettingsAccountName(
                hasExplicitRoute = false,
                requestedAccountName = null,
                availableAccountNames = availableAccounts,
                activeAccountName = "removed@example.com",
            ),
        )
    }
}
