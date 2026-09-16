package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.ExceptionCategory
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Phase
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Reason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test fun `outcome names the first failing phase and never commits the marker after it`() {
        val events = mutableListOf<String>()
        fun evaluate(classify: Reason, reconcile: Reason, marker: Reason) = PostLoginBootstrapCoordinator.evaluate(
            { events += "classify"; classify }, { events += "reconcile"; reconcile }, { events += "marker"; marker })

        assertEquals(PostLoginStartupOutcome(Phase.CLASSIFY_ROWS, Reason.CLASSIFY_CREATION_ID_WRITE_FAILED),
            evaluate(Reason.CLASSIFY_CREATION_ID_WRITE_FAILED, Reason.NONE, Reason.NONE))
        assertEquals(listOf("classify"), events)
        events.clear()
        assertEquals(PostLoginStartupOutcome(Phase.RECONCILE_PENDING, Reason.RECONCILE_ACTIVATE_FAILED),
            evaluate(Reason.NONE, Reason.RECONCILE_ACTIVATE_FAILED, Reason.NONE))
        assertEquals(listOf("classify", "reconcile"), events)
        events.clear()
        val marker = evaluate(Reason.NONE, Reason.NONE, Reason.MARKER_READBACK_FAILED)
        assertEquals(PostLoginStartupOutcome(Phase.MARKER_COMMIT, Reason.MARKER_READBACK_FAILED), marker)
        assertFalse(marker.succeeded)
        events.clear()
        val success = evaluate(Reason.NONE, Reason.NONE, Reason.NONE)
        assertEquals(PostLoginStartupOutcome.SUCCEEDED, success)
        assertTrue(success.succeeded)
        assertEquals(listOf("classify", "reconcile", "marker"), events)
    }

    @Test fun `exceptions become a coarse category at the active phase without their message`() {
        val outcome = PostLoginBootstrapCoordinator.evaluate(
            { Reason.NONE },
            { throw SecurityException("alice@example.invalid https://server.example.invalid/ creation-id") },
            { throw AssertionError("marker must not run") },
        )
        assertEquals(PostLoginStartupOutcome(Phase.RECONCILE_PENDING, Reason.EXCEPTION, ExceptionCategory.SECURITY), outcome)
        assertFalse(outcome.toString().contains("alice"))
        assertFalse(outcome.toString().contains("example"))
        assertEquals(ExceptionCategory.ILLEGAL_STATE, PostLoginStartupOutcome.categorize(IllegalStateException("x")))
        assertEquals(ExceptionCategory.ILLEGAL_ARGUMENT, PostLoginStartupOutcome.categorize(NumberFormatException("x")))
        assertEquals(ExceptionCategory.OTHER, PostLoginStartupOutcome.categorize(UnsupportedOperationException("x")))
    }
}
