package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Test

class RecoveryRemovalCoordinatorTest {
    private class Fake : RecoveryRemovalCoordinator.Seams {
        var owned = true; var absent = false; var active = true; var registry = true; var begins = 0
        var callback: ((Boolean) -> Unit)? = null
        override fun ownsExact() = owned
        override fun begin(callback: (Boolean) -> Unit) { begins++; this.callback = callback }
        override fun rowAbsent() = absent
        override fun clearOwned() = registry
        override fun clearActive() = active
    }
    private fun coordinator(fake: Fake, states: MutableList<RecoveryRemovalCoordinator.State> = mutableListOf()) =
        RecoveryRemovalCoordinator(fake) { states += it }

    @Test fun `delayed callback remains pending and duplicate tap does not remove twice`() {
        val f = Fake(); val c = coordinator(f)
        c.remove(); c.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Pending, c.state); assertEquals(1, f.begins)
    }
    @Test fun `confirmed absence clears active then registry and removes`() {
        val f = Fake(); val c = coordinator(f); c.remove(); f.absent = true; f.callback!!(true)
        assertEquals(RecoveryRemovalCoordinator.State.Removed, c.state)
    }
    @Test fun `false callback or still present are recoverable failures`() {
        val falseResult = Fake(); val a = coordinator(falseResult); a.remove(); falseResult.callback!!(false)
        assertEquals(RecoveryRemovalCoordinator.State.Failed, a.state)
        val present = Fake(); val b = coordinator(present); b.remove(); present.callback!!(true)
        assertEquals(RecoveryRemovalCoordinator.State.Failed, b.state)
    }
    @Test fun `already absent retries cleanup without platform removal`() {
        val f = Fake().apply { absent = true }; val c = coordinator(f); c.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Removed, c.state); assertEquals(0, f.begins)
    }
    @Test fun `active or registry cleanup failure retains owner and retry succeeds`() {
        val active = Fake().apply { absent = true; this.active = false }; val a = coordinator(active); a.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Failed, a.state); active.active = true; a.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Removed, a.state)
        val registry = Fake().apply { absent = true; this.registry = false }; val b = coordinator(registry); b.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Failed, b.state); registry.registry = true; b.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Removed, b.state)
    }
    @Test fun `stale ownership performs no removal and sibling active is untouched`() {
        val f = Fake().apply { owned = false }; val c = coordinator(f); c.remove()
        assertEquals(RecoveryRemovalCoordinator.State.Failed, c.state); assertEquals(0, f.begins)
    }
}
