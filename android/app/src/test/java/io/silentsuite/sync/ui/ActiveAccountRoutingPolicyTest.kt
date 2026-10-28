package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveAccountRoutingPolicyTest {
    private val alice = ActiveAccountRoutingPolicy.Candidate("alice", "a")
    private val bob = ActiveAccountRoutingPolicy.Candidate("bob", "b")
    @Test fun `selects only unambiguous eligible row and rejects stale saved generation`() {
        assertNull(ActiveAccountRoutingPolicy.select(null, null, false, emptyList()))
        assertEquals(alice, ActiveAccountRoutingPolicy.select(null, null, false, listOf(alice)))
        assertNull(ActiveAccountRoutingPolicy.select(null, null, false, listOf(alice, ActiveAccountRoutingPolicy.Candidate("bob", "b"))))
        assertNull(ActiveAccountRoutingPolicy.select("alice", "old", true, listOf(alice)))
        assertEquals(alice, ActiveAccountRoutingPolicy.select("alice", null, true, listOf(alice)))
    }

    @Test fun `saved name absent from every row selects the sole eligible sibling`() {
        assertTrue(ActiveAccountRoutingPolicy.savedNameAbsent("carol", "c", false))
        assertEquals(bob, ActiveAccountRoutingPolicy.select("carol", "c", false, listOf(bob)))
    }

    @Test fun `saved name absent with several eligible siblings selects nothing`() {
        assertNull(ActiveAccountRoutingPolicy.select("carol", "c", false, listOf(alice, bob)))
    }

    @Test fun `saved name absent with no eligible row selects nothing`() {
        assertNull(ActiveAccountRoutingPolicy.select("carol", "c", false, emptyList()))
    }

    @Test fun `same-name row with another generation is never adopted`() {
        val replacement = ActiveAccountRoutingPolicy.Candidate("carol", "c2")
        assertFalse(ActiveAccountRoutingPolicy.savedNameAbsent("carol", "c", true))
        assertNull(ActiveAccountRoutingPolicy.select("carol", "c", true, listOf(replacement)))
        assertNull(ActiveAccountRoutingPolicy.select("carol", "c", true, listOf(replacement, bob)))
    }

    @Test fun `generationless same-name row still blocks the sole sibling`() {
        // The raw row named carol has no generation, so it is not eligible but is present.
        assertFalse(ActiveAccountRoutingPolicy.savedNameAbsent("carol", "c", true))
        assertNull(ActiveAccountRoutingPolicy.select("carol", "c", true, listOf(bob)))
    }

    @Test fun `malformed saved identity without a name selects nothing`() {
        assertFalse(ActiveAccountRoutingPolicy.savedNameAbsent(null, "c", false))
        assertNull(ActiveAccountRoutingPolicy.select(null, "c", false, listOf(bob)))
    }

    @Test fun `legacy name-only saved account keeps its name-match behavior`() {
        assertFalse(ActiveAccountRoutingPolicy.savedNameAbsent("carol", null, false))
        assertNull(ActiveAccountRoutingPolicy.select("carol", null, false, listOf(bob)))
        assertEquals(bob, ActiveAccountRoutingPolicy.select("bob", null, true, listOf(alice, bob)))
    }
}
