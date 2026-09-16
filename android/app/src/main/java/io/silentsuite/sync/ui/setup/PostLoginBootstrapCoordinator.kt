package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Phase
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Reason

/** Enforces the only legal durable ordering for post-login bootstrap admission. */
object PostLoginBootstrapCoordinator {
    fun run(classifyRows: () -> Boolean, reconcilePending: () -> Boolean, commitMarker: () -> Boolean): Boolean =
        classifyRows() && reconcilePending() && commitMarker()

    /**
     * Same ordering as [run]. Each step returns [Reason.NONE] or its allowlisted failure reason;
     * the first failure stops admission and the marker is never committed after a failure.
     */
    fun evaluate(
        classifyRows: () -> Reason,
        reconcilePending: () -> Reason,
        commitMarker: () -> Reason,
    ): PostLoginStartupOutcome {
        var phase = Phase.CLASSIFY_ROWS
        return try {
            val steps = listOf(
                Phase.CLASSIFY_ROWS to classifyRows,
                Phase.RECONCILE_PENDING to reconcilePending,
                Phase.MARKER_COMMIT to commitMarker,
            )
            for ((stepPhase, step) in steps) {
                phase = stepPhase
                val reason = step()
                if (reason != Reason.NONE) return PostLoginStartupOutcome.failed(stepPhase, reason)
            }
            PostLoginStartupOutcome.SUCCEEDED
        } catch (error: Exception) {
            PostLoginStartupOutcome.exception(phase, error)
        }
    }
}
