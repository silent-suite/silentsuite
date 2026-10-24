package io.silentsuite.sync.ui

import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.UnsyncedNotes

/** Non-secret identity used to keep account destructive work exact and framework-independent. */
data class ExactAccountIdentity(val type: String, val name: String, val creationId: String)

data class CurrentAccountSignOutSnapshot(
    val main: ExactAccountIdentity,
    val children: List<Pair<String, String>>,
    val eligibleSiblings: List<ExactAccountIdentity>
)

data class ActiveAccountReconciliation(val succeeded: Boolean, val active: ExactAccountIdentity?)

sealed class CurrentAccountSignOutState {
    object Idle : CurrentAccountSignOutState()
    object Removing : CurrentAccountSignOutState()
    object CleaningUp : CurrentAccountSignOutState()
    /**
     * The account was not removed. With [notesCleared], the attempt had cleared the account's pending Notes store
     * before it asked for the removal. With [notesDiscarded], which is set only together with it, that store held
     * unsynced changes the user confirmed.
     */
    data class RemovalFailed(
        val errorId: Long,
        val notesDiscarded: Boolean = false,
        val notesCleared: Boolean = false,
    ) : CurrentAccountSignOutState()
    /**
     * The sign-out did not go ahead: the account's pending Notes store holds unsynced changes that no discard
     * confirmation covers, such as a change saved after it. Nothing was removed or cleared. It is not a failure,
     * and the view model does not count it as a started sign-out.
     */
    object Refused : CurrentAccountSignOutState()
    /**
     * Clearing the account's pending Notes store failed, stopped partway or deleted nothing, so the account was
     * not removed. Another confirmed sign-out can finish the clear. With [notesDiscarded], the store held unsynced
     * changes the user confirmed, as for [RemovalFailed], and a clear may have removed part of them: this one
     * stopped or threw, which can happen while it deletes, or an earlier one in this process stopped and the store
     * cannot be listed now ([PendingNotesStore.DiscardOutcome.NotFinished]). A permit that could not be recorded
     * deleted nothing ([PendingNotesStore.DiscardOutcome.PermitNotRecorded]), so [notesDiscarded] is false then.
     *
     * With [acknowledgement], the store's directory could not be listed, so nothing in it was deleted and the
     * user's confirmation was taken only as an acknowledgement, never as a discard
     * ([PendingNotesStore.DiscardOutcome.Acknowledged]); it says whether that was recorded. [notesDiscarded] is
     * then false. Unsynced Notes text may remain on this device and may no longer sync. Once the store can be
     * counted, a sign-out asks again with the real count before anything is deleted.
     */
    data class NotesClearFailed(
        val errorId: Long,
        val notesDiscarded: Boolean = false,
        val acknowledgement: Acknowledgement? = null,
    ) : CurrentAccountSignOutState() {
        /** What became of a confirmation given for a store that could not be listed. */
        enum class Acknowledgement {
            /** Recorded for this store ([PendingNotesStore.DiscardOutcome.Acknowledged]). */
            RECORDED,
            /** Not recorded ([PendingNotesStore.DiscardOutcome.AcknowledgementNotRecorded]). */
            NOT_RECORDED,
        }
    }
    data class CleanupFailed(val errorId: Long) : CurrentAccountSignOutState()
    data class Complete(val replacement: ExactAccountIdentity?) : CurrentAccountSignOutState()
}

/**
 * Ordered sign-out policy. The snapshot is retained for cleanup-only retry after the main row is
 * absent; a retry can therefore never broaden ownership or issue the main removal twice.
 *
 * Before anything is canceled, the account's unsynced Notes changes are counted: they must be nothing,
 * or the user's discard confirmation must cover them ([UnsyncedNotes.covers]), or the attempt is refused.
 * After the syncs are canceled and before the account is removed, the pending Notes store is cleared
 * under its own lock, the lock every save takes, and it counts itself again there, so a change saved
 * since the count refuses the attempt too. Only a clear shown finished lets the removal go ahead. A clear
 * that fails or stops keeps the account, so another confirmed sign-out can finish it, and so does one that
 * deletes nothing because the store cannot be listed, where the confirmation is only an acknowledgement.
 * A refused attempt and one whose clear failed keep no snapshot.
 *
 * Every call that reaches the pending Notes store, and the request for the removal, runs off the main thread,
 * through [offMain]: the count, one step that clears the store and, only once the clear is shown finished,
 * asks for the removal, with nothing in between, and the reopening of a cleared store. The state, the refusal,
 * the cancels, the removal's answer and cleanup stay on the main thread. While a step is in flight, [begin]
 * starts nothing, and an attempt past its count runs to its end.
 * Internal, since its seams speak of the pending Notes store's own types.
 */
internal class CurrentAccountSignOutCoordinator(
    private val seams: Seams,
    private val offMain: OffMain = OffMain.INLINE,
    private val onStateChanged: (CurrentAccountSignOutState) -> Unit = {}
) {
    /**
     * Where the coordinator's store steps run. [run] runs work off the main thread and hands its result to
     * then on the main thread; [onMain] runs a block on the main thread. [INLINE] runs both at once on the
     * caller's thread: the unit tests use it, and so do callers that are not on the main thread.
     */
    interface OffMain {
        fun <T> run(work: () -> T, then: (T) -> Unit)
        fun onMain(block: () -> Unit)

        companion object {
            val INLINE = object : OffMain {
                override fun <T> run(work: () -> T, then: (T) -> Unit) = then(work())
                override fun onMain(block: () -> Unit) = block()
            }
        }
    }

    interface Seams {
        fun snapshot(): CurrentAccountSignOutSnapshot?
        fun cancelSync(identity: Pair<String, String>)
        /** Asked off the main thread. [callback] may come on any thread; the coordinator takes it on the main one. */
        fun removeMain(main: ExactAccountIdentity, callback: (Boolean) -> Unit)
        fun mainGenerationAbsent(main: ExactAccountIdentity): Boolean
        fun clearCache(main: ExactAccountIdentity): Boolean
        fun clearStatus(main: ExactAccountIdentity): Boolean
        fun reconcileActive(main: ExactAccountIdentity, replacement: ExactAccountIdentity?): ActiveAccountReconciliation
        fun removeAndVerifyChildren(snapshot: CurrentAccountSignOutSnapshot, callback: (Boolean) -> Unit)
        /** What the pending Notes store of [main] holds that has not synced: what removing the account would lose. */
        fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes
        /**
         * Clears the pending Notes store of exactly [main] under its lock ([PendingNotesStore.discardStore]).
         * [confirmed] is the answer the user confirmed the discard for, or null. The store counts itself again
         * first and deletes nothing while it holds anything [confirmed] does not cover.
         */
        fun discardPendingNotes(main: ExactAccountIdentity, confirmed: UnsyncedNotes?): PendingNotesStore.DiscardOutcome
        /**
         * The store of [main] was cleared and the account then stayed: the cleared instance is dropped
         * ([PendingNotesStore.unregister]), so the account's Notes open a new one.
         */
        fun reopenPendingNotes(main: ExactAccountIdentity)
        /** Monotonic platform-listener observation; production defaults to no invalidation. */
        fun hasObservedMainGenerationInvalidation(): Boolean = false
        fun close() = Unit
    }

    var state: CurrentAccountSignOutState = CurrentAccountSignOutState.Idle
        private set
    private var snapshot: CurrentAccountSignOutSnapshot? = null
    private var mainRemovalConfirmed = false
    private var nextErrorId = 1L

    /** Steps handed to [offMain] whose result has not come back. [begin] starts nothing while one is in flight. */
    private var stepsInFlight = 0

    /**
     * Whether the attempt under way has taken the removal's answer, or the failure of its request. The answer
     * and the end of the step that asked for it come back separately, in either order. The end of the step
     * counts only when the request threw and no answer came first; after that, or after an answer, nothing
     * more is taken.
     */
    private var removalAnswered = false

    /**
     * The user's separate confirmation that unsynced Notes changes may be discarded: the account it was given
     * for, and the answer it was given for. Only the last one is kept. The next attempt takes it for itself, and
     * every end of an attempt withdraws one given while it ran, so each sign-out is confirmed again. It is kept
     * in memory only, so a new coordinator, as after a restart, asks again.
     */
    private var confirmation: Pair<ExactAccountIdentity, UnsyncedNotes>? = null

    init { onStateChanged(state) }

    fun begin() {
        if (stepsInFlight > 0 || state is CurrentAccountSignOutState.Removing ||
            state is CurrentAccountSignOutState.CleaningUp ||
            state is CurrentAccountSignOutState.Complete) return
        val given = confirmation.also { confirmation = null }

        val captured = snapshot ?: runCatching { seams.snapshot() }.getOrNull()?.also { snapshot = it }
        if (captured == null) {
            failRemoval()
            return
        }
        if (mainRemovalConfirmed || state is CurrentAccountSignOutState.CleanupFailed) {
            cleanup(captured)
            return
        }
        val confirmed = given?.takeIf { it.first == captured.main }?.second
        if (runCatching { seams.mainGenerationAbsent(captured.main) }.getOrDefault(false)) {
            mainRemovalConfirmed = true
            // The account is gone already, so there is no removal to clear the store before and nothing to
            // refuse. The store goes only when it holds nothing unsynced or the confirmation covers what it
            // holds; any other stays on disk without an account. Cleanup goes on whatever the answer. The
            // attempt is cleaning up from before the clear, so nothing else starts while it runs.
            transition(CurrentAccountSignOutState.CleaningUp)
            step({ runCatching { seams.discardPendingNotes(captured.main, confirmed) } }) { cleanup(captured) }
            return
        }

        // The gate, before anything is canceled. A count that throws is an answer that could not be counted,
        // never nothing, and a confirmation given for that answer covers it.
        step({ unsyncedNotes(captured.main) }) { now -> counted(captured, confirmed, now) }
    }

    /** The gate's answer [now], back on the main thread: the refusal, or the cancels and the clear. */
    private fun counted(captured: CurrentAccountSignOutSnapshot, confirmed: UnsyncedNotes?, now: UnsyncedNotes) {
        if (now.anything && confirmed?.covers(now) != true) {
            refuse()
            return
        }

        transition(CurrentAccountSignOutState.Removing)
        try {
            seams.cancelSync(captured.main.type to captured.main.name)
            captured.children.forEach(seams::cancelSync)
        } catch (_: Exception) {
            failRemoval()
            return
        }
        removalAnswered = false
        // Cleared before the removal, under the store's own lock, and the removal asked for in the same step,
        // so nothing comes between them. Only a clear shown finished (Done) lets the removal be asked for; one
        // that fails, stops or deletes nothing keeps the account. The step gives back the clear's outcome and
        // whether the removal's request threw.
        step({
            val outcome = runCatching { seams.discardPendingNotes(captured.main, confirmed) }.getOrNull()
            var removalThrew = false
            if (outcome == PendingNotesStore.DiscardOutcome.Done) {
                try {
                    seams.removeMain(captured.main) { removed ->
                        offMain.onMain { answerRemoval(captured, removed, now.anything) }
                    }
                } catch (_: Exception) {
                    removalThrew = true
                }
            }
            outcome to removalThrew
        }) { (outcome, removalThrew) -> cleared(captured, outcome, removalThrew, now.anything) }
    }

    /**
     * The clear's [outcome], back on the main thread. After a clear shown finished, the removal was asked for
     * in the same step, and its answer may come before this or after it ([answerRemoval]); here the attempt
     * fails only when the request threw and no answer came first. [notesDiscarded]: the store held unsynced
     * changes the user confirmed.
     */
    private fun cleared(
        captured: CurrentAccountSignOutSnapshot,
        outcome: PendingNotesStore.DiscardOutcome?,
        removalThrew: Boolean,
        notesDiscarded: Boolean,
    ) {
        when (outcome) {
            PendingNotesStore.DiscardOutcome.Done -> if (removalThrew && !removalAnswered &&
                state is CurrentAccountSignOutState.Removing) {
                removalAnswered = true
                failRemovalAfterClear(captured.main, notesDiscarded)
            }
            // A change saved since the gate counted, or more than was confirmed: nothing was cleared.
            is PendingNotesStore.DiscardOutcome.Changed -> refuse()
            // The store could not be listed: nothing was deleted, and the confirmation is only an acknowledgement.
            PendingNotesStore.DiscardOutcome.Acknowledged ->
                failNotesClear(false, CurrentAccountSignOutState.NotesClearFailed.Acknowledgement.RECORDED)
            PendingNotesStore.DiscardOutcome.AcknowledgementNotRecorded ->
                failNotesClear(false, CurrentAccountSignOutState.NotesClearFailed.Acknowledgement.NOT_RECORDED)
            // The permit could not be recorded, so nothing was deleted.
            PendingNotesStore.DiscardOutcome.PermitNotRecorded -> failNotesClear(false)
            // A clear that stopped, or threw, which can happen while it deletes, may have removed part of the store.
            else -> failNotesClear(notesDiscarded)
        }
    }

    /**
     * The removal's answer, on the main thread. It counts only while the attempt removes, and only when nothing
     * was taken before it: no other answer, and no failed request ([removalAnswered]).
     */
    private fun answerRemoval(captured: CurrentAccountSignOutSnapshot, removed: Boolean, notesDiscarded: Boolean) {
        if (removalAnswered || state !is CurrentAccountSignOutState.Removing) return
        removalAnswered = true
        if (removed && runCatching { seams.mainGenerationAbsent(captured.main) }.getOrDefault(false)) {
            mainRemovalConfirmed = true
            cleanup(captured)
        } else failRemovalAfterClear(captured.main, notesDiscarded)
    }

    /** Runs [work] through [offMain], then [then] with its result on the main thread; in flight until then. */
    private fun <T> step(work: () -> T, then: (T) -> Unit) {
        stepsInFlight++
        offMain.run(work) { result ->
            stepsInFlight--
            then(result)
        }
    }

    private fun cleanup(captured: CurrentAccountSignOutSnapshot) {
        // An account found gone already is cleaning up from before its clear.
        if (state !is CurrentAccountSignOutState.CleaningUp) transition(CurrentAccountSignOutState.CleaningUp)
        val replacement = AccountSwitcherPolicy.replacement(captured.main, captured.eligibleSiblings)
        val essentialCleanup = runCatching {
            if (!seams.clearCache(captured.main) || !seams.clearStatus(captured.main)) null
            else seams.reconcileActive(captured.main, replacement)
        }.getOrNull()
        if (essentialCleanup?.succeeded != true) {
            failCleanup()
            return
        }
        try {
            seams.removeAndVerifyChildren(captured) { success ->
                if (state !is CurrentAccountSignOutState.CleaningUp) return@removeAndVerifyChildren
                if (success) {
                    transition(CurrentAccountSignOutState.Complete(essentialCleanup.active))
                    close()
                } else failCleanup()
            }
        } catch (_: Exception) {
            failCleanup()
        }
    }

    private fun failRemoval() = transition(CurrentAccountSignOutState.RemovalFailed(nextErrorId++))
    private fun failCleanup() = transition(CurrentAccountSignOutState.CleanupFailed(nextErrorId++))

    /**
     * Not a failure: this attempt removed nothing, so nothing is kept for the next one. The snapshot is dropped,
     * also one kept from an earlier attempt whose removal failed, and the next attempt takes a new one.
     */
    private fun refuse() {
        snapshot = null
        transition(CurrentAccountSignOutState.Refused)
    }

    /**
     * The clear failed or stopped, or deleted nothing. The account stays, and the next attempt starts over with a
     * new snapshot. [notesDiscarded]: the store held unsynced changes the user confirmed. [acknowledgement]: the
     * store could not be listed, as [CurrentAccountSignOutState.NotesClearFailed] says.
     */
    private fun failNotesClear(
        notesDiscarded: Boolean,
        acknowledgement: CurrentAccountSignOutState.NotesClearFailed.Acknowledgement? = null,
    ) {
        snapshot = null
        transition(CurrentAccountSignOutState.NotesClearFailed(nextErrorId++, notesDiscarded, acknowledgement))
    }

    /**
     * The store was cleared and the removal then failed, so the account stays and its cleared store instance is
     * dropped, for its Notes to keep working. The state says that the store was cleared, so the message never says
     * that local data were preserved. [notesDiscarded]: the store held unsynced changes the user confirmed. The
     * store is reopened off the main thread, and the attempt stays removing until that ends.
     */
    private fun failRemovalAfterClear(main: ExactAccountIdentity, notesDiscarded: Boolean) {
        step({ runCatching { seams.reopenPendingNotes(main) } }) {
            transition(CurrentAccountSignOutState.RemovalFailed(nextErrorId++, notesDiscarded, notesCleared = true))
        }
    }

    private fun transition(next: CurrentAccountSignOutState) {
        state = next
        // Every end of an attempt withdraws a discard confirmation given while it ran, before the end is
        // reported, so none is left standing for a later attempt.
        if (next !is CurrentAccountSignOutState.Idle && next !is CurrentAccountSignOutState.Removing &&
            next !is CurrentAccountSignOutState.CleaningUp) confirmation = null
        onStateChanged(next)
    }

    fun close() { runCatching { seams.close() } }

    fun isMainGenerationPresent(main: ExactAccountIdentity) =
        !runCatching { seams.mainGenerationAbsent(main) }.getOrDefault(true)

    /**
     * The seam's answer. When the seam throws, the answer is that the changes could not be counted, never nothing.
     * It reads the store, so it is asked off the main thread, and it touches no state of the coordinator.
     */
    fun unsyncedNotes(main: ExactAccountIdentity): UnsyncedNotes =
        runCatching { seams.unsyncedNotes(main) }.getOrDefault(UnsyncedNotes(0, 0, unreadable = true))

    /**
     * The user's separate confirmation that the unsynced Notes changes of [main] may be discarded, given for
     * [shown], the answer the dialog showed. The next attempt takes it; it covers what the store holds then only
     * as [UnsyncedNotes.covers] says.
     */
    fun confirmNotesDiscard(main: ExactAccountIdentity, shown: UnsyncedNotes) {
        confirmation = main to shown
    }

    /**
     * Takes a refusal back to idle and reports that. In any other state it does nothing. Made for the screen to
     * call when it has taken note of a refusal.
     */
    fun acknowledgeRefusal() {
        if (state is CurrentAccountSignOutState.Refused) transition(CurrentAccountSignOutState.Idle)
    }

    fun hasObservedMainGenerationInvalidation() =
        runCatching { seams.hasObservedMainGenerationInvalidation() }.getOrDefault(true)
}

object AccountSwitcherPolicy {
    fun ordered(accounts: List<ExactAccountIdentity>): List<ExactAccountIdentity> =
        accounts.distinct().sortedWith(compareBy<ExactAccountIdentity>({ it.name }, { it.creationId }, { it.type }))

    fun replacement(removed: ExactAccountIdentity, eligible: List<ExactAccountIdentity>): ExactAccountIdentity? =
        ordered(eligible).firstOrNull { it != removed }

    fun canExpand(accountCount: Int) = accountCount >= 1
}

sealed class ActiveAccountReplacementDecision {
    object Preserve : ActiveAccountReplacementDecision()
    data class Replace(val identity: ExactAccountIdentity?) : ActiveAccountReplacementDecision()
}

object ActiveAccountReplacementPolicy {
    fun decide(savedName: String?, savedGeneration: String?, expected: ExactAccountIdentity,
               replacement: ExactAccountIdentity?): ActiveAccountReplacementDecision =
        if (savedName == expected.name && savedGeneration == expected.creationId)
            ActiveAccountReplacementDecision.Replace(replacement)
        else ActiveAccountReplacementDecision.Preserve
}
