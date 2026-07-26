package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class PostLoginBootstrapCoordinatorTest {
    @Test fun `marker is committed only after classification and reconciliation succeed`() {
        val events = mutableListOf<String>()
        assertEquals(false, PostLoginBootstrapCoordinator.run({ events += "classify"; true }, { events += "reconcile"; false }, { events += "marker"; true }))
        assertEquals(listOf("classify", "reconcile"), events)
        events.clear()
        assertEquals(true, PostLoginBootstrapCoordinator.run({ events += "classify"; true }, { events += "reconcile"; true }, { events += "marker"; true }))
        assertEquals(listOf("classify", "reconcile", "marker"), events)
    }
}
