package io.silentsuite.sync.ui.webapp

import io.silentsuite.sync.ui.webapp.WebAppRequestPolicy.Origin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebAppAccountBindingTest {
    private val type = "io.silentsuite.android"

    @Test
    fun oneAccountRowAlwaysGetsTheSameProfile() {
        val name = WebAppAccountBinding.profileName(type, "ada@example.org", "creation-1")!!
        assertEquals(name, WebAppAccountBinding.profileName(type, "ada@example.org", "creation-1"))
        assertTrue(Regex("webapp-[0-9a-f]{32}").matches(name))
    }

    @Test
    fun anotherAccountOrARecreatedAccountGetsAnotherProfile() {
        val first = WebAppAccountBinding.profileName(type, "ada@example.org", "creation-1")
        assertNotEquals(first, WebAppAccountBinding.profileName(type, "bob@example.org", "creation-1"))
        // Removed and added again under the same name: a new creation ID.
        assertNotEquals(first, WebAppAccountBinding.profileName(type, "ada@example.org", "creation-2"))
        assertNotEquals(first, WebAppAccountBinding.profileName("other.type", "ada@example.org", "creation-1"))
        // Parts cannot be shifted into one another.
        assertNotEquals(
            WebAppAccountBinding.profileName(type, "ab", "c"),
            WebAppAccountBinding.profileName(type, "a", "bc"),
        )
    }

    @Test
    fun anAccountWithoutACreationIdCannotBeBound() {
        assertNull(WebAppAccountBinding.profileName(type, "ada@example.org", null))
        assertNull(WebAppAccountBinding.profileName(type, "ada@example.org", " "))
        assertNull(WebAppAccountBinding.profileName(type, "", "creation-1"))
    }

    @Test
    fun onlyProfilesOfUnregisteredAccountsAreStale() {
        val all = listOf("Default", "webapp-aaa", "webapp-bbb", "webapp-gone", "someone-elses")
        // Both registered accounts keep their profiles, whichever one a launch is for.
        assertEquals(listOf("webapp-gone"), WebAppAccountBinding.staleProfiles(all, setOf("webapp-aaa", "webapp-bbb")))
        // No account left: every profile of this feature goes, foreign ones stay.
        assertEquals(listOf("webapp-aaa", "webapp-bbb", "webapp-gone"), WebAppAccountBinding.staleProfiles(all, emptySet()))
    }

    @Test
    fun onlyAccountsOnTheHostedServiceQualify() {
        val hosted = Origin("https", "server.silentsuite.io", 443)
        val builtIn = "https://server.silentsuite.io/"
        assertTrue(WebAppAccountBinding.isHostedAccount("https://server.silentsuite.io/", builtIn, hosted))
        assertTrue(WebAppAccountBinding.isHostedAccount("https://server.silentsuite.io", builtIn, hosted))
        // No stored server: the app's built-in one decides.
        assertTrue(WebAppAccountBinding.isHostedAccount(null, builtIn, hosted))
        assertFalse(WebAppAccountBinding.isHostedAccount(null, "http://localserver:8080/", hosted))
        assertFalse(WebAppAccountBinding.isHostedAccount("https://sync.example.org/", builtIn, hosted))
        assertFalse(WebAppAccountBinding.isHostedAccount("http://server.silentsuite.io/", builtIn, hosted))
        assertFalse(WebAppAccountBinding.isHostedAccount("https://server.silentsuite.io:8443/", builtIn, hosted))
        assertFalse(WebAppAccountBinding.isHostedAccount("not a url", builtIn, hosted))
        // Another server behind a path on the hosted address is not the hosted service.
        assertFalse(WebAppAccountBinding.isHostedAccount("https://server.silentsuite.io/other/", builtIn, hosted))
    }
}
