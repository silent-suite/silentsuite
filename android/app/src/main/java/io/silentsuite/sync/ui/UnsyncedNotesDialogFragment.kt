package io.silentsuite.sync.ui

import android.app.Dialog
import android.content.DialogInterface
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.UnsyncedNotes

/**
 * The two dialogs the account screen shows before a sign-out while Notes changes have not synced.
 * Step 1 shows how many changes have not synced, or that they could not be counted, with Sync now,
 * Cancel and a third action to go on without syncing. Step 2 asks for the separate confirmation of
 * the discard. For a store that could not be listed, where a confirmation deletes nothing and is only
 * an acknowledgement, both steps have words of their own ([UnsyncedNotesSignOutPolicy.Text.Unlisted]):
 * none of them calls it a discard or says that anything will be deleted, and no button names a sign-out.
 * The dialog keeps the exact account generation, all of the answer it showed, the names that answer
 * was counted from included, and the token of the app process that made it ([ProcessIncarnation]) in
 * its arguments, and sends them with every answer, so the screen can turn away an answer for another
 * account, and count again and ask again for one from a dialog that Android restored in a new
 * process. It decides nothing itself: an answer goes to the account screen that hosts it, and so do
 * Cancel and a canceled dialog ([onCancel]). Once it has sent either, it has [ended].
 */
class UnsyncedNotesDialogFragment : DialogFragment() {
    /**
     * Set once this dialog has sent an answer or reported its end. Its window closes after that, or has closed
     * already for Back and a tap outside, and the platform removes the dialog later still, so an answer that shows
     * this step again can find it; the screen does not count an ended dialog as open. In memory only: a dialog
     * brought back by a recreation starts unset, and holds its step until it ends.
     */
    internal var ended = false
        private set

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val identity = ExactAccountIdentity(args.getString(ARG_TYPE)!!, args.getString(ARG_NAME)!!,
            args.getString(ARG_CREATION_ID)!!)
        // The app process that made the dialog; null for a dialog with none, which counts as another process.
        val shownIn = args.getString(ARG_PROCESS)
        // All of the answer, the names it was counted from included: a confirmation covers only what it names.
        val shown = UnsyncedNotes(args.getInt(ARG_COUNT), args.getLong(ARG_SEQUENCE), args.getBoolean(ARG_UNREADABLE),
            args.getBoolean(ARG_LISTED), args.getStringArrayList(ARG_NAMES)!!.toSet())
        fun send(answer: UnsyncedNotesSignOutPolicy.Answer) {
            ended = true
            (activity as? AccountActivity)?.onUnsyncedNotesAnswer(identity, answer, shown, shownIn)
        }
        fun closedWithoutSignOut() {
            ended = true
            (activity as? AccountActivity)?.onSignOutDialogClosedWithoutSignOut()
        }
        val text = UnsyncedNotesSignOutPolicy.text(shown)
        // A store that could not be listed: a confirmation deletes nothing, so no word of a discard is used for it.
        val unlisted = text == UnsyncedNotesSignOutPolicy.Text.Unlisted
        val goOn = if (unlisted) R.string.notes_continue_without_syncing else R.string.notes_sign_out_without_syncing
        val confirmTitle = if (unlisted) R.string.notes_acknowledge_title else R.string.notes_discard_title
        val confirm = if (unlisted) R.string.notes_acknowledge_continue else R.string.notes_discard_and_sign_out
        val builder = MaterialAlertDialogBuilder(requireContext())
        return when (UnsyncedNotesSignOutPolicy.Step.valueOf(args.getString(ARG_STEP)!!)) {
            UnsyncedNotesSignOutPolicy.Step.COUNT -> builder
                .setTitle(R.string.notes_sign_out_unsynced_title)
                .setMessage(when (text) {
                    is UnsyncedNotesSignOutPolicy.Text.Counted ->
                        resources.getQuantityString(R.plurals.notes_sign_out_unsynced, text.count, text.count)
                    UnsyncedNotesSignOutPolicy.Text.Uncounted -> getString(R.string.notes_sign_out_unsynced_unreadable)
                    UnsyncedNotesSignOutPolicy.Text.Unlisted -> getString(R.string.notes_sign_out_unsynced_unlisted)
                })
                .setNegativeButton(android.R.string.cancel) { _, _ -> closedWithoutSignOut() }
                .setNeutralButton(goOn) { _, _ ->
                    send(UnsyncedNotesSignOutPolicy.Answer.GO_ON_WITHOUT_SYNCING)
                }
                .setPositiveButton(R.string.account_synchronize_now) { _, _ ->
                    send(UnsyncedNotesSignOutPolicy.Answer.SYNC_NOW)
                }
                .create()
            UnsyncedNotesSignOutPolicy.Step.DISCARD -> builder
                .setTitle(confirmTitle)
                .setMessage(when (text) {
                    is UnsyncedNotesSignOutPolicy.Text.Counted ->
                        resources.getQuantityString(R.plurals.notes_discard_text, text.count, text.count)
                    UnsyncedNotesSignOutPolicy.Text.Uncounted -> getString(R.string.notes_discard_unreadable)
                    UnsyncedNotesSignOutPolicy.Text.Unlisted -> getString(R.string.notes_acknowledge_text)
                })
                .setNegativeButton(android.R.string.cancel) { _, _ -> closedWithoutSignOut() }
                .setPositiveButton(confirm) { _, _ ->
                    send(UnsyncedNotesSignOutPolicy.Answer.DISCARD)
                }
                .create()
        }
    }

    /**
     * The dialog was canceled: it ends without an answer, and the account screen that hosts it is told. The
     * platform cancels a dialog for Back and for a tap outside it.
     */
    override fun onCancel(dialog: DialogInterface) {
        super.onCancel(dialog)
        ended = true
        (activity as? AccountActivity)?.onSignOutDialogClosedWithoutSignOut()
    }

    companion object {
        private const val ARG_TYPE = "unsyncedNotes.type"
        private const val ARG_NAME = "unsyncedNotes.name"
        private const val ARG_CREATION_ID = "unsyncedNotes.creationId"
        private const val ARG_COUNT = "unsyncedNotes.count"
        private const val ARG_SEQUENCE = "unsyncedNotes.sequence"
        private const val ARG_UNREADABLE = "unsyncedNotes.unreadable"
        private const val ARG_LISTED = "unsyncedNotes.listed"
        private const val ARG_NAMES = "unsyncedNotes.names"
        private const val ARG_STEP = "unsyncedNotes.step"
        /**
         * The app process that made the dialog ([ProcessIncarnation]). Internal for the device case, which writes
         * another.
         */
        internal const val ARG_PROCESS = "unsyncedNotes.process"

        /**
         * One tag per step. The screen looks the tag up before it shows a step and shows none while it finds one that
         * has not [ended].
         */
        internal fun tag(step: UnsyncedNotesSignOutPolicy.Step) = "unsynced-notes-" + step.name

        internal fun newInstance(
            identity: ExactAccountIdentity,
            step: UnsyncedNotesSignOutPolicy.Step,
            shown: UnsyncedNotes,
        ) = UnsyncedNotesDialogFragment().apply {
            arguments = Bundle(10).apply {
                putString(ARG_TYPE, identity.type)
                putString(ARG_NAME, identity.name)
                putString(ARG_CREATION_ID, identity.creationId)
                putInt(ARG_COUNT, shown.count)
                putLong(ARG_SEQUENCE, shown.sequence)
                putBoolean(ARG_UNREADABLE, shown.unreadable)
                putBoolean(ARG_LISTED, shown.listed)
                putStringArrayList(ARG_NAMES, ArrayList(shown.names.sorted()))
                putString(ARG_STEP, step.name)
                putString(ARG_PROCESS, ProcessIncarnation.current())
            }
        }
    }
}
