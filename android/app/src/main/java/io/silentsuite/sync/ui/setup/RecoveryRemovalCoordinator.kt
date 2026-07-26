package io.silentsuite.sync.ui.setup

/** Pure async removal gate; platform adapter reports callback completion separately. */
class RecoveryRemovalCoordinator(private val seams: Seams, private val onStateChanged: (State) -> Unit = {}) {
    interface Seams { fun ownsExact(): Boolean; fun begin(callback: (Boolean) -> Unit); fun rowAbsent(): Boolean; fun clearOwned(): Boolean; fun clearActive(): Boolean }
    enum class State { Idle, Pending, Failed, Removed }
    var state = State.Idle; private set
    init { onStateChanged(state) }
    private fun transition(next: State) { state = next; onStateChanged(next) }
    fun remove() {
        if (state == State.Pending) return
        if (!seams.ownsExact()) { transition(State.Failed); return }
        if (seams.rowAbsent()) {
            cleanup()
            return
        }
        transition(State.Pending)
        seams.begin { success ->
            // Keep the registry proof until active preference cleanup succeeds; retries after
            // confirmed removal perform cleanup without issuing another AccountManager remove.
            if (success && seams.rowAbsent()) cleanup() else transition(State.Failed)
        }
    }
    private fun cleanup() {
        // Active preference is cleared first. The owned registry remains durable proof until
        // both cleanups have committed, so a process restart can retry without another remove.
        transition(if (seams.clearActive() && seams.clearOwned()) State.Removed else State.Failed)
    }
}
