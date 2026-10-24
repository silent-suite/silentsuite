package io.silentsuite.sync.ui

import androidx.annotation.StringRes
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.UnsyncedNotes

/**
 * What the sign-out screen does next, decided from the answer to a dialog and from what the caller
 * passes as the store's answer at that moment, and what it says when a sign-out stops. Pure, so the
 * rules can be tested without a screen: of the three answers only DISCARD, the answer to the separate
 * discard confirmation, gives [Next.ConfirmAndSignOut], and only for a dialog made in this app process.
 */
internal object UnsyncedNotesSignOutPolicy {
    enum class Step { COUNT, DISCARD }
    enum class Answer { SYNC_NOW, GO_ON_WITHOUT_SYNCING, DISCARD }

    sealed class Next {
        /** Nothing is unsynced: the plain sign-out question, with the words it had before. */
        object AskPlain : Next()
        /** Step 1: the count, with Sync now, Cancel, and going on without syncing. */
        data class ShowCount(val unsynced: UnsyncedNotes) : Next()
        /** Step 2: the separate discard confirmation, shown for [unsynced]. */
        data class ShowDiscard(val unsynced: UnsyncedNotes) : Next()
        object SyncNotes : Next()
        /** The DISCARD answer was accepted. [shown] is what its dialog showed: confirm that, then sign out. */
        data class ConfirmAndSignOut(val shown: UnsyncedNotes) : Next()
    }

    /** What a dialog says about the changes it was shown for. */
    sealed class Text {
        /** How many changes have not synced. */
        data class Counted(val count: Int) : Text()
        /** That the changes could not be counted. */
        object Uncounted : Text()
        /**
         * That the store could not be listed ([UnsyncedNotes.listed] false). A confirmation given for it deletes
         * nothing and is only an acknowledgement (the store's DiscardOutcome.Acknowledged), so its words never call
         * it a discard, never say that anything will be deleted or removed, and name no sign-out on a button. They
         * say that nothing will be deleted, that the account stays signed in, and that unsynced Notes text may
         * remain on this device and may no longer sync.
         */
        object Unlisted : Text()
    }

    /** The user asked to sign out: the count when [now] holds anything, else the plain question. */
    fun start(now: UnsyncedNotes): Next = if (now.anything) Next.ShowCount(now) else Next.AskPlain

    /**
     * The user answered [answer] in a dialog that showed [shown]. [now] is what the caller passes as
     * the store's answer at this moment. [fromThisProcess] is false for a dialog made in another app
     * process, as one Android restores after the process ended, or for one with no token: whatever the
     * answer, that gives [start] for [now], the count again or the plain question, and never a
     * confirmation, a sync or step 2. Otherwise SYNC_NOW gives [Next.SyncNotes]. GO_ON_WITHOUT_SYNCING
     * gives step 2 for [now], or the plain question when [now] holds nothing. DISCARD is accepted only
     * when [now] holds nothing, or when [UnsyncedNotes.covers] says that a confirmation for [shown]
     * still holds for [now]; see its limits there. Otherwise the count is shown again, for [now].
     */
    fun answered(answer: Answer, shown: UnsyncedNotes, now: UnsyncedNotes, fromThisProcess: Boolean): Next {
        if (!fromThisProcess) return start(now)
        return when (answer) {
            Answer.SYNC_NOW -> Next.SyncNotes
            Answer.GO_ON_WITHOUT_SYNCING -> if (now.anything) Next.ShowDiscard(now) else Next.AskPlain
            Answer.DISCARD ->
                if (!now.anything || shown.covers(now)) Next.ConfirmAndSignOut(shown) else Next.ShowCount(now)
        }
    }

    /**
     * What the dialogs say for [shown]: that the store could not be listed, whatever else the answer holds, since a
     * confirmation given for it deletes nothing; else the number of changes while they were counted, else that they
     * could not be counted. A count of zero is never shown: the dialogs are asked only for an answer that holds
     * anything, and one that holds no counted change could not be counted.
     */
    fun text(shown: UnsyncedNotes): Text = when {
        !shown.listed -> Text.Unlisted
        shown.unreadable || shown.count <= 0 -> Text.Uncounted
        else -> Text.Counted(shown.count)
    }

    /**
     * The words of the failure message with Retry for a sign-out that ended in [failed]: a removal that failed,
     * a clear of the Notes store that did not finish, or a cleanup that failed. When the store held changes the
     * user confirmed for discard and was cleared, or its clear stopped partway, the usual words, that the local
     * data were preserved, would be false. A clear that stopped with no confirmed changes, and a removal that
     * failed after a clear of none, say only that the account was kept: the store, or part of it, may be gone, and
     * a clear an earlier confirmed attempt stopped may have deleted changes the count no longer shows. Only a
     * removal that failed before any clear keeps the usual words. A store that could not be listed, where the
     * confirmation was taken as an acknowledgement, had nothing deleted: the words say that, and that unsynced text
     * may remain on this device and may no longer sync, and never call it a discard or say that changes may already
     * be deleted. While a discard that stopped in this process has not finished, the store takes no confirmation as
     * an acknowledgement (its DiscardOutcome.NotFinished), and the words are those of a clear that stopped.
     */
    @StringRes
    fun failureMessage(failed: CurrentAccountSignOutState): Int = when {
        failed is CurrentAccountSignOutState.CleanupFailed -> R.string.account_sign_out_cleanup_failed
        failed is CurrentAccountSignOutState.NotesClearFailed && failed.acknowledgement != null ->
            R.string.notes_sign_out_stopped_nothing_deleted
        failed is CurrentAccountSignOutState.NotesClearFailed && failed.notesDiscarded ->
            R.string.notes_sign_out_stopped
        failed is CurrentAccountSignOutState.NotesClearFailed -> R.string.notes_sign_out_stopped_kept
        failed is CurrentAccountSignOutState.RemovalFailed && failed.notesDiscarded -> R.string.notes_sign_out_stopped
        failed is CurrentAccountSignOutState.RemovalFailed && failed.notesCleared ->
            R.string.notes_sign_out_stopped_kept
        else -> R.string.account_sign_out_failed
    }
}
