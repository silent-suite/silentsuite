package io.silentsuite.sync.ui.setup

/** Enforces the only legal durable ordering for post-login bootstrap admission. */
object PostLoginBootstrapCoordinator {
    fun run(classifyRows: () -> Boolean, reconcilePending: () -> Boolean, commitMarker: () -> Boolean): Boolean =
        classifyRows() && reconcilePending() && commitMarker()
}
