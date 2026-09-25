package io.silentsuite.sync.notes

/**
 * Pure single-flight policy for the in-app Notes sync job. One run per account at a time; adapters
 * finishing together collapse into one run; a user-initiated request that arrives while a run is
 * in progress queues exactly one follow-up run. No Android types, so the rules are unit-testable.
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
     */
    data class Slot(
        val state: State = State.IDLE,
        val rerun: Boolean = false,
        val queuedRequestId: String? = null,
        val manual: Boolean = false,
    )

    fun request(slot: Slot, trigger: Trigger, requestId: String?): Pair<Slot, Decision> {
        val userInitiated = trigger != Trigger.PIGGYBACK && trigger != Trigger.SCREEN_OPEN
        return when (slot.state) {
            State.IDLE -> Slot(State.PENDING, rerun = false, queuedRequestId = requestId, manual = userInitiated) to Decision.START
            State.PENDING -> slot.copy(
                queuedRequestId = requestId ?: slot.queuedRequestId,
                manual = slot.manual || userInitiated,
            ) to Decision.COALESCED
            State.RUNNING -> if (userInitiated) slot.copy(
                rerun = true,
                queuedRequestId = requestId ?: slot.queuedRequestId,
                manual = true,
            ) to Decision.COALESCED else slot to Decision.DROPPED
        }
    }

    /** The queued run starts; its request id and manual flag travel with the running slot. */
    fun started(slot: Slot): Slot {
        check(slot.state == State.PENDING) { "Only a pending Notes sync can start" }
        return slot.copy(state = State.RUNNING, rerun = false)
    }

    /** Returns the next slot and whether a follow-up run must be scheduled immediately. */
    fun finished(slot: Slot): Pair<Slot, Boolean> {
        if (slot.state != State.RUNNING) return Slot() to false
        return if (slot.rerun) Slot(State.PENDING, rerun = false, queuedRequestId = slot.queuedRequestId, manual = slot.manual) to true
        else Slot() to false
    }

    fun cancelled(): Slot = Slot()
}
