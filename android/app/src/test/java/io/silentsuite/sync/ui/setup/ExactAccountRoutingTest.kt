package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExactAccountRoutingTest {
    private val app = "io.silentsuite.sync"
    private val alice = ExactAccountRouting.Identity("alice", app, "creation-a")

    @Test fun `wrong type stale extra and removed account never route`() {
        assertNull(ExactAccountRouting.validate(alice.copy(type = "other"), app, listOf(alice)))
        assertNull(ExactAccountRouting.validate(alice, app, emptyList()))
        assertNull(ExactAccountRouting.validate(alice.copy(creationId = null), app, listOf(alice)))
    }

    @Test fun `removed and readded same name needs matching durable generation`() {
        val readded = alice.copy(creationId = "creation-b")
        assertNull(ExactAccountRouting.validate(alice, app, listOf(readded)))
        assertEquals(readded, ExactAccountRouting.validate(readded, app, listOf(readded)))
    }
}
