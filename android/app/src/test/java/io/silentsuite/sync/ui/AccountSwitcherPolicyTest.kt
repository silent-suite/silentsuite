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

    @Test fun `colliding account row hashes probe to stable unique ids`() {
        val first = ExactAccountIdentity("type", "Aa", "generation")
        val second = ExactAccountIdentity("type", "BB", "generation")
        assertEquals(first.hashCode(), second.hashCode())

        val forward = AccountActivity.accountRowViewIds(listOf(first, second))
        val reversed = AccountActivity.accountRowViewIds(listOf(second, first))
        assertEquals(forward, reversed)
        assertEquals(2, forward.values.toSet().size)
        assertEquals(AccountActivity.accountRowViewId(first), forward.getValue(first))
        assertEquals(AccountActivity.accountRowViewId(first) + 1, forward.getValue(second))
    }
}
