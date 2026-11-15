package io.silentsuite.sync.ui.notes

import android.app.Dialog
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.ProcessIncarnation

/**
 * The note screen's delete confirmation ([discard] false), and the separate confirmation that the note's unsynced text
 * is discarded ([discard] true; the maintainer's answer 4 on #709, 2026-10-04). Its answer goes to the [NoteViewFragment]
 * it is shown on, after a rotation or a recreation too.
 *
 * Its arguments carry what it showed ([NoteEditorViewModel.DeleteShown]: the note, its entry's version and a digest of
 * its text, or the revision of the item shown when there is no entry), which are checked against what is there before
 * anything is written, so a confirmation that outlived what it was opened for deletes nothing. They are the one place a version leaves memory on this screen, as for every confirmation
 * the store checks (the Unsynced text Discard keeps the same). They also carry the exact account it is for and the token
 * of the app process that made it ([ProcessIncarnation]): the screen sends an answer from a dialog Android restored in a
 * new process, or one for another account, to no store, reads the note again and asks again (the maintainer's answer
 * on #709, 2026-10-23).
 */
class NoteDeleteConfirmation : DialogFragment() {
    /** Set once the positive button was answered; the platform removes the dialog later, and an ended one is not open. */
    internal var ended = false
        private set

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val shown = NoteEditorViewModel.DeleteShown(requireNotNull(args.getString(ARG_NOTE)),
            if (args.containsKey(ARG_VERSION)) args.getLong(ARG_VERSION) else null,
            args.getString(ARG_DIGEST), args.getBoolean(ARG_NEVER_SYNCED), args.getString(ARG_REVISION))
        val discard = args.getBoolean(ARG_DISCARD)
        val identity = ExactAccountIdentity(args.getString(ARG_ACCOUNT_TYPE).orEmpty(), args.getString(ARG_ACCOUNT_NAME).orEmpty(),
            args.getString(ARG_CREATION_ID).orEmpty())
        // The app process that made the dialog; null for a dialog with none, which counts as another process.
        val shownIn = args.getString(ARG_PROCESS)
        val builder = MaterialAlertDialogBuilder(requireContext()).setNegativeButton(android.R.string.cancel, null)
        if (discard) {
            builder.setTitle(R.string.notes_delete_discard_title).setMessage(R.string.notes_delete_discard_text)
                .setPositiveButton(R.string.notes_delete_discard) { _, _ -> answered(shown, identity, shownIn, discard = true) }
        } else {
            builder.setTitle(R.string.notes_delete_title)
                .setMessage(if (shown.neverSynced) R.string.notes_delete_never_synced_text else R.string.notes_delete_text)
                .setPositiveButton(R.string.notes_delete) { _, _ -> answered(shown, identity, shownIn, discard = false) }
        }
        return builder.create()
    }

    private fun answered(shown: NoteEditorViewModel.DeleteShown, identity: ExactAccountIdentity, shownIn: String?, discard: Boolean) {
        ended = true
        (parentFragment as? NoteViewFragment)?.deleteConfirmed(shown, identity, shownIn, discard)
    }

    companion object {
        private const val ARG_NOTE = "notes.delete.note"
        private const val ARG_VERSION = "notes.delete.version"
        private const val ARG_DIGEST = "notes.delete.digest"
        private const val ARG_NEVER_SYNCED = "notes.delete.neverSynced"
        private const val ARG_REVISION = "notes.delete.revision"
        private const val ARG_DISCARD = "notes.delete.discard"
        private const val ARG_ACCOUNT_TYPE = "notes.delete.accountType"
        private const val ARG_ACCOUNT_NAME = "notes.delete.accountName"
        private const val ARG_CREATION_ID = "notes.delete.creationId"
        /** The app process that made the confirmation ([ProcessIncarnation]). Internal for the device case, which writes another. */
        internal const val ARG_PROCESS = "notes.delete.process"
        internal const val TAG = "notes.delete"

        internal fun newInstance(shown: NoteEditorViewModel.DeleteShown, discard: Boolean, identity: ExactAccountIdentity) =
            NoteDeleteConfirmation().apply {
                arguments = Bundle().apply {
                    putString(ARG_NOTE, shown.noteUid)
                    shown.version?.let { putLong(ARG_VERSION, it) }
                    putString(ARG_DIGEST, shown.digest)
                    putBoolean(ARG_NEVER_SYNCED, shown.neverSynced)
                    putString(ARG_REVISION, shown.revision)
                    putBoolean(ARG_DISCARD, discard)
                    putString(ARG_ACCOUNT_TYPE, identity.type)
                    putString(ARG_ACCOUNT_NAME, identity.name)
                    putString(ARG_CREATION_ID, identity.creationId)
                    putString(ARG_PROCESS, ProcessIncarnation.current())
                }
            }
    }
}
