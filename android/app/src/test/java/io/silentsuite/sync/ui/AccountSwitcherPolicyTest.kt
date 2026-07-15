package io.silentsuite.sync.ui

import org.junit.Assert.*
import org.junit.Test

class AccountSwitcherPolicyTest {
    @Test fun `switcher expands for one account so add remains reachable`() {
        assertFalse(AccountSwitcherPolicy.canExpand(0))
        assertTrue(AccountSwitcherPolicy.canExpand(1))
        assertTrue(AccountSwitcherPolicy.canExpand(2))
    }

    @Test fun `replacement is deterministic exact and excludes removed generation`() {
        val removed = ExactAccountIdentity("type", "same", "old")
        val sameNameNew = ExactAccountIdentity("type", "same", "new")
        val alice = ExactAccountIdentity("type", "alice", "a")
        assertEquals(alice, AccountSwitcherPolicy.replacement(removed, listOf(sameNameNew, removed, alice)))
        assertEquals(sameNameNew, AccountSwitcherPolicy.replacement(removed, listOf(removed, sameNameNew)))
        assertNull(AccountSwitcherPolicy.replacement(removed, listOf(removed)))
    }

    @Test fun `active replacement preserves unrelated sibling and replaces only exact generation`() {
        val removed = ExactAccountIdentity("type", "target", "removed-generation")
        val sibling = ExactAccountIdentity("type", "sibling", "sibling-generation")
        assertEquals(ActiveAccountReplacementDecision.Preserve,
            ActiveAccountReplacementPolicy.decide(sibling.name, sibling.creationId, removed, sibling))
        assertEquals(ActiveAccountReplacementDecision.Preserve,
            ActiveAccountReplacementPolicy.decide(removed.name, "new-generation", removed, sibling))
        assertEquals(ActiveAccountReplacementDecision.Replace(sibling),
            ActiveAccountReplacementPolicy.decide(removed.name, removed.creationId, removed, sibling))
        assertEquals(ActiveAccountReplacementDecision.Replace(null),
            ActiveAccountReplacementPolicy.decide(removed.name, removed.creationId, removed, null))
    }
}
