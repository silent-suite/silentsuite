package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActiveAccountRoutingPolicyTest {
    private val alice = ActiveAccountRoutingPolicy.Candidate("alice", "a")
    @Test fun `selects only unambiguous eligible row and rejects stale saved generation`() {
        assertNull(ActiveAccountRoutingPolicy.select(null, null, emptyList()))
        assertEquals(alice, ActiveAccountRoutingPolicy.select(null, null, listOf(alice)))
        assertNull(ActiveAccountRoutingPolicy.select(null, null, listOf(alice, ActiveAccountRoutingPolicy.Candidate("bob", "b"))))
        assertNull(ActiveAccountRoutingPolicy.select("alice", "old", listOf(alice)))
        assertEquals(alice, ActiveAccountRoutingPolicy.select("alice", null, listOf(alice)))
    }
}
