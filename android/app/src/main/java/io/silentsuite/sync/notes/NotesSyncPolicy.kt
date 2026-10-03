package io.silentsuite.sync.notes

/**
 * Pure single-flight policy for the in-app Notes sync job. One run per account at a time; adapters
 * finishing together collapse into one run; a user-initiated request that arrives while a run is
 * in progress queues exactly one follow-up run. A forced collection refresh (after an invitation is
 * accepted) survives every coalescing step, so which job runs first never decides whether a newly
 * shared notebook is seen. No Android types, so the rules are unit-testable.
 */
class NotesSyncPolicy {
    /**
     * MANUAL, TOGGLE, and SCREEN are explicit user gestures (Sync now, enabling Notes, pull to
     * refresh) and bypass the Wi-Fi-only restriction like a manual adapter sync. SCREEN_OPEN and
     * PIGGYBACK are automatic and honor it.
     */
    enum class Trigger { MANUAL, TOGGLE, SCREEN, SCREEN_OPEN, PIGGYBACK }
    enum class State { IDLE, PENDING, RUNNING }
    enum class Decision { START, COALESCED, DROPPED }

    /**
     * @property queuedRequestId the durable request the next run must attribute itself to; a
     * later user request replaces an earlier one so the newest request evidence is closed.
     * @property manual whether the queued run is user-initiated (skips the Wi-Fi-only restriction).
     * @property forceRefresh whether the queued run must list the collections from scratch rather
     * than from the saved cursor, as the adapters do after an invitation is accepted. While a run
     * is in progress it belongs to the follow-up run only; the running one took its own at start.
     */
    data class Slot(
        val state: State = State.IDLE,
        val rerun: Boolean = false,
        val queuedRequestId: String? = null,
        val manual: Boolean = false,
        val forceRefresh: Boolean = false,
    )

    fun request(slot: Slot, trigger: Trigger, requestId: String?, forceRefresh: Boolean = false): Pair<Slot, Decision> {
        val userInitiated = trigger != Trigger.PIGGYBACK && trigger != Trigger.SCREEN_OPEN
        return when (slot.state) {
            // An idle slot can still owe a forced refresh that an earlier run did not complete.
            State.IDLE -> Slot(State.PENDING, rerun = false, queuedRequestId = requestId, manual = userInitiated,
                forceRefresh = slot.forceRefresh || forceRefresh) to Decision.START
            State.PENDING -> slot.copy(
                queuedRequestId = requestId ?: slot.queuedRequestId,
                manual = slot.manual || userInitiated,
                forceRefresh = slot.forceRefresh || forceRefresh,
            ) to Decision.COALESCED
            State.RUNNING -> when {
                userInitiated -> slot.copy(
                    rerun = true,
                    queuedRequestId = requestId ?: slot.queuedRequestId,
                    manual = true,
                    forceRefresh = slot.forceRefresh || forceRefresh,
                ) to Decision.COALESCED
                // The running run may already be past its collection refresh, so a forced refresh
                // is never dropped, even from an automatic trigger: it queues the follow-up run.
                // Unless a user request queued that follow-up already, it is automatic: it neither
                // reuses the running run's request id nor skips the Wi-Fi-only restriction.
                forceRefresh -> slot.copy(
                    rerun = true,
                    queuedRequestId = if (slot.rerun) slot.queuedRequestId else requestId,
                    manual = slot.rerun && slot.manual,
                    forceRefresh = true,
                ) to Decision.COALESCED
                else -> slot to Decision.DROPPED
            }
        }
    }

    /**
     * The queued run starts. Its request id and manual flag stay with the running slot; its forced
     * refresh does not, so the slot can collect one for a follow-up run that is still to come.
     * Callers take the run's parameters from the pending slot before calling this.
     */
    fun started(slot: Slot): Slot {
        check(slot.state == State.PENDING) { "Only a pending Notes sync can start" }
        return slot.copy(state = State.RUNNING, rerun = false, forceRefresh = false)
    }

    /**
     * Returns the next slot and whether a follow-up run must be scheduled immediately.
     * [forcedRefreshOwed] is true when the run that finished was forced but did not complete its
     * collection listing (it failed, or stopped early): the force then carries to the next run, as
     * an idle slot that keeps it if nothing is queued yet.
     */
    fun finished(slot: Slot, forcedRefreshOwed: Boolean = false): Pair<Slot, Boolean> {
        if (slot.state != State.RUNNING) return Slot() to false
        val force = slot.forceRefresh || forcedRefreshOwed
        return if (slot.rerun) Slot(State.PENDING, rerun = false, queuedRequestId = slot.queuedRequestId, manual = slot.manual,
            forceRefresh = force) to true
        else Slot(forceRefresh = force) to false
    }

    fun cancelled(): Slot = Slot()
}
