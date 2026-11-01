package io.silentsuite.sync.ui.etebase

import androidx.annotation.StringRes
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.PendingNotesStore.NotebookDiscard
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.UnsyncedNotesSignOutPolicy

/**
 * What the notebook screens do when the user leaves or deletes a Notes notebook, decided from the pending store's
 * answers for that notebook alone. Pure, so the rules can be tested without a screen. They follow the maintainer's
 * answers on #709: the count of changes that have not synced comes first, with Sync now or Cancel, and going on without
 * syncing needs a separate confirmation that the unsynced text will be discarded (2026-10-03); that confirmation
 * discards only after the user's own leave or delete went through (2026-10-04); a count that fails counts as changes
 * that have not synced (2026-10-18); and while the store cannot be listed, nothing is called a discard, nothing is
 * deleted, and the user confirms again with the real count once the store can be counted (his second reply of
 * 2026-10-20).
 */
internal object NotebookLeaveOrDeletePolicy {
    enum class Kind { DELETE, LEAVE }

    /**
     * The dialogs: today's question for a delete with nothing unsynced, the count, the separate confirmation, the one
     * more question once the store changed after the server call, and a server call that failed.
     */
    enum class Step { PLAIN, COUNT, DISCARD, AGAIN, FAILED }

    enum class Answer { SYNC_NOW, GO_ON_WITHOUT_SYNCING, DISCARD, KEEP }

    /** How a leave or delete starts. */
    sealed class Start {
        /** Nothing unsynced: a delete asks today's question, and a leave goes on at once. */
        object Plain : Start()

        /** The count, for [shown]. */
        data class ShowCount(val shown: UnsyncedNotes) : Start()
    }

    /** What an answer to a dialog that showed [UnsyncedNotes] leads to. */
    sealed class Next {
        object SyncNotes : Next()

        /** The separate confirmation, for what the count showed. */
        data class ShowDiscard(val shown: UnsyncedNotes) : Next()

        /** [shown] was confirmed: the leave or delete goes on, and then the discard of what [shown] covers. */
        data class Proceed(val shown: UnsyncedNotes) : Next()

        /** The screen closes. */
        object Close : Next()

        /**
         * An answer from a dialog made in another app process, as one Android restores after the process ended, or
         * from one with no token: nothing goes on, and the notebook is counted again and asked again, in a dialog made
         * in this process.
         */
        object CountAgain : Next()
    }

    /** How a confirmed leave or delete ended ([NotebookLeaveOrDelete.remove], [NotebookLeaveOrDelete.again]). */
    sealed class Ended {
        /** The account's generation is gone, before the server call or after it. Nothing was discarded. */
        object AccountChanged : Ended()

        /** The notebook holds what the confirmation does not cover, before the server was called: [now]. */
        data class AskAgain(val now: UnsyncedNotes) : Ended()

        /** The server call went through, and the discard ended in [outcome]. */
        data class Removed(val outcome: NotebookDiscard) : Ended()

        /**
         * The server call went through, and the discard threw: [known] when none of the notebook's text can have gone,
         * which is never so for a store that a clear or a whole-store discard closed, since that may have deleted it.
         */
        data class DiscardFailed(val known: Boolean) : Ended()
    }

    /** What the screen does once a confirmed leave or delete [Ended]. */
    sealed class After {
        /** Nothing to say. */
        object Quiet : After()

        /** A message, the string resource [text]. */
        data class Say(@param:StringRes val text: Int) : After()

        /** The count again, for [now], before anything was done. */
        data class ShowCount(val now: UnsyncedNotes) : After()

        /** Once more, after the server call: the notebook's changes [now], to discard or keep. */
        data class AskAgainAfter(val now: UnsyncedNotes) : After()
    }

    /**
     * The answer that stands for a count that failed: one that could not be counted, never nothing, as the sign-out
     * count takes a count that throws.
     */
    val countFailed = UnsyncedNotes(0, 0, unreadable = true)

    /**
     * Whether a store that changed after the confirmation, once the server call went through, is asked about once
     * more with the real count, while the screen is up. The maintainer has not decided yet; false keeps it all for
     * the push step to hold, with no question.
     */
    internal val ASKS_ONCE_MORE_AFTER_A_CHANGE = true

    /**
     * Whether a notebook is still left or deleted while the store cannot be listed, after a confirmation that deletes
     * and records nothing. The maintainer has not decided yet; false refuses it until the store can be read, and the
     * count's dialog then offers no way on.
     */
    internal val GOES_ON_WHILE_UNLISTED = true

    /** The count when [now] holds anything, else [Start.Plain]. */
    fun start(now: UnsyncedNotes): Start = if (now.anything) Start.ShowCount(now) else Start.Plain

    /**
     * The user answered [answer] in a dialog that showed [shown]. [fromThisProcess] is false for a dialog made in
     * another app process, as one Android restores after the process ended, or for one with no token: whatever the
     * answer, that gives [Next.CountAgain], and never Sync now, the separate confirmation, a leave or delete, a discard
     * or a close (the maintainer's answer on #709, 2026-10-23, for restored dialog answers). Sync now and Keep lose
     * nothing, so the maintainer can reverse that for them. Nothing is counted here: the count reads headers, so it
     * runs on IO, where [NotebookLeaveOrDelete.remove] counts again before the server call.
     */
    fun answered(answer: Answer, shown: UnsyncedNotes, fromThisProcess: Boolean): Next {
        if (!fromThisProcess) return Next.CountAgain
        return when (answer) {
            Answer.SYNC_NOW -> Next.SyncNotes
            Answer.GO_ON_WITHOUT_SYNCING -> Next.ShowDiscard(shown)
            Answer.DISCARD -> Next.Proceed(shown)
            Answer.KEEP -> Next.Close
        }
    }

    /** Whether the count's dialog for [shown] offers to go on without syncing ([GOES_ON_WHILE_UNLISTED]). */
    fun offersGoingOn(shown: UnsyncedNotes): Boolean = shown.listed || GOES_ON_WHILE_UNLISTED

    /** What the dialogs say for [shown], as the sign-out dialogs say it: never a count of zero. */
    fun text(shown: UnsyncedNotes): UnsyncedNotesSignOutPolicy.Text = UnsyncedNotesSignOutPolicy.text(shown)

    /**
     * What follows once a confirmed leave or delete [ended]. [askedAgain] is true for the answer to the one more
     * question, which is asked at most once. Whatever the discard kept stays for the push step to hold. A discard
     * of a notebook that could not be counted ([NotebookDiscard.Done.uncounted]) kept the files that could not be
     * placed, so it is never said to have deleted all of the notebook's changes, and one that deleted nothing says so.
     * A discard that may have deleted what it does not count ([NotebookDiscard.Partly.unsure]), and one that a closed
     * store refused ([Ended.DiscardFailed] that is not known), say that some changes may already be deleted, never that
     * nothing was.
     */
    fun after(ended: Ended, askedAgain: Boolean): After = when (ended) {
        Ended.AccountChanged -> After.Quiet
        is Ended.AskAgain -> After.ShowCount(ended.now)
        is Ended.DiscardFailed -> After.Say(
            if (ended.known) R.string.notes_notebook_nothing_deleted else R.string.notes_notebook_discard_unknown)
        is Ended.Removed -> when (val outcome = ended.outcome) {
            is NotebookDiscard.Done -> when {
                outcome.deleted == 0 && outcome.unreadable == 0 ->
                    if (outcome.uncounted) After.Say(R.string.notes_notebook_nothing_deleted) else After.Quiet
                outcome.unreadable == 0 && !outcome.uncounted -> After.Say(R.string.notes_notebook_discarded)
                outcome.deleted > 0 -> After.Say(R.string.notes_notebook_discarded_readable)
                else -> After.Say(R.string.notes_notebook_kept_unreadable)
            }
            is NotebookDiscard.Partly -> After.Say(when {
                outcome.unsure -> R.string.notes_notebook_discard_unknown
                outcome.deleted > 0 -> R.string.notes_notebook_kept_partly
                else -> R.string.notes_notebook_nothing_deleted
            })
            NotebookDiscard.NotListed -> After.Say(R.string.notes_notebook_nothing_deleted)
            is NotebookDiscard.Changed ->
                if (ASKS_ONCE_MORE_AFTER_A_CHANGE && !askedAgain && outcome.now.anything && outcome.now.listed) {
                    After.AskAgainAfter(outcome.now)
                } else {
                    After.Say(R.string.notes_notebook_kept_changed)
                }
        }
    }
}
