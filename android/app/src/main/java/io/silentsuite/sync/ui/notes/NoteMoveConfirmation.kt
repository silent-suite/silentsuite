package io.silentsuite.sync.ui.notes

import android.app.Dialog
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.ProcessIncarnation

/**
 * The note screen's Move picker: the notebooks the note can go to, by name; choosing one moves the note there, as the
 * web's notebook picker does. Its answer goes to the [NoteViewFragment] it is shown on, after a rotation or a recreation
 * too.
 *
 * Its arguments carry what the screen showed ([NoteEditorViewModel.DeleteShown], since a move deletes the original),
 * checked against what is there before anything is written, so a picker that outlived what it was opened for moves
 * nothing. They also carry the exact account it is for and the token of the app process that made it
 * ([ProcessIncarnation]): the screen sends an answer from a picker Android restored in a new process, or one for another
 * account, to no store, reads the note again and asks again (the maintainer's answer on #709, 2026-10-23).
 *
 * The notebooks go in the arguments by uid only: their decrypted names, which other accounts can set and of any length,
 * stay in the screen's memory ([NoteEditorViewModel.moveTargets]), as the notebook dialogs keep names out of theirs. A
 * picker whose names are not in memory any more (restored in a new process) shows none and offers to choose again.
 */
class NoteMoveConfirmation : DialogFragment() {
    /** Set once a notebook was chosen; the platform removes the dialog later, and an ended one is not open. */
    internal var ended = false
        private set

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val shown = NoteEditorViewModel.DeleteShown(requireNotNull(args.getString(ARG_NOTE)),
            if (args.containsKey(ARG_VERSION)) args.getLong(ARG_VERSION) else null,
            args.getString(ARG_DIGEST), args.getBoolean(ARG_NEVER_SYNCED), args.getString(ARG_REVISION))
        val uids = args.getStringArray(ARG_TARGET_UIDS).orEmpty()
        val known = (parentFragment as? NoteViewFragment)?.moveTargets().orEmpty().associateBy { it.uid }
        val targets = uids.mapNotNull { known[it] }
        val identity = ExactAccountIdentity(args.getString(ARG_ACCOUNT_TYPE).orEmpty(), args.getString(ARG_ACCOUNT_NAME).orEmpty(),
            args.getString(ARG_CREATION_ID).orEmpty())
        // The app process that made the picker; null for a picker with none, which counts as another process.
        val shownIn = args.getString(ARG_PROCESS)
        val builder = MaterialAlertDialogBuilder(requireContext()).setTitle(R.string.notes_move_title)
            .setNegativeButton(android.R.string.cancel, null)
        if (uids.isEmpty() || targets.size != uids.size) {
            // The names are not in memory any more: nothing to choose from here, so the user is asked again.
            return builder.setMessage(R.string.notes_move_ask_again)
                .setPositiveButton(R.string.notes_move_note) { _, _ -> again() }
                .create()
        }
        val labels = targets.map { target ->
            movePickerLabel(target, getString(R.string.notes_untitled)) { getString(R.string.notes_move_shared, it) }
        }.toTypedArray()
        return builder.setItems(labels) { _, which -> answered(shown, targets[which], identity, shownIn) }.create()
    }

    private fun again() {
        ended = true
        (parentFragment as? NoteViewFragment)?.moveAskedAgain()
    }

    private fun answered(shown: NoteEditorViewModel.DeleteShown, target: NoteEditorViewModel.MoveTarget,
                         identity: ExactAccountIdentity, shownIn: String?) {
        ended = true
        (parentFragment as? NoteViewFragment)?.moveConfirmed(shown, target, identity, shownIn)
    }

    companion object {
        private const val ARG_NOTE = "notes.move.note"
        private const val ARG_VERSION = "notes.move.version"
        private const val ARG_DIGEST = "notes.move.digest"
        private const val ARG_NEVER_SYNCED = "notes.move.neverSynced"
        private const val ARG_REVISION = "notes.move.revision"
        private const val ARG_TARGET_UIDS = "notes.move.targetUids"
        private const val ARG_ACCOUNT_TYPE = "notes.move.accountType"
        private const val ARG_ACCOUNT_NAME = "notes.move.accountName"
        private const val ARG_CREATION_ID = "notes.move.creationId"
        /** The app process that made the picker ([ProcessIncarnation]). Internal for the device case, which writes another. */
        internal const val ARG_PROCESS = "notes.move.process"
        internal const val TAG = "notes.move"

        internal fun newInstance(shown: NoteEditorViewModel.DeleteShown, targets: List<NoteEditorViewModel.MoveTarget>,
                                 identity: ExactAccountIdentity) =
            NoteMoveConfirmation().apply {
                arguments = Bundle().apply {
                    putString(ARG_NOTE, shown.noteUid)
                    shown.version?.let { putLong(ARG_VERSION, it) }
                    putString(ARG_DIGEST, shown.digest)
                    putBoolean(ARG_NEVER_SYNCED, shown.neverSynced)
                    putString(ARG_REVISION, shown.revision)
                    putStringArray(ARG_TARGET_UIDS, targets.map { it.uid }.toTypedArray())
                    putString(ARG_ACCOUNT_TYPE, identity.type)
                    putString(ARG_ACCOUNT_NAME, identity.name)
                    putString(ARG_CREATION_ID, identity.creationId)
                    putString(ARG_PROCESS, ProcessIncarnation.current())
                }
            }
    }
}

/**
 * The picker's line for [target]: its name as one line ([pickerName]), [untitled] for a name that is blank then, and for a
 * notebook another account shares, [shared] of that name, whose mark goes before the name (notes_move_shared). A name
 * another account set cannot then reorder the mark or push it out of view, so a shared notebook never looks private.
 */
internal fun movePickerLabel(target: NoteEditorViewModel.MoveTarget, untitled: String, shared: (String) -> String): String {
    val name = pickerName(target.name).ifBlank { untitled }
    return if (target.shared) shared(name) else name
}

/** Unicode's Bidi_Control characters: the marks, embeddings, overrides and isolates that reorder the text around them. */
private val BIDI_CONTROLS: Set<Int> = setOf(0x061C, 0x200E, 0x200F) + (0x202A..0x202E) + (0x2066..0x2069)

/** Line feed, vertical tab, form feed, carriage return, next line, and the line and paragraph separators. */
private val LINE_BREAKS: Set<Int> = setOf(0x0A, 0x0B, 0x0C, 0x0D, 0x85, 0x2028, 0x2029)

/** [name] with every bidirectional control taken out and each run of line breaks made one space, trimmed. */
internal fun pickerName(name: String): String {
    val line = StringBuilder(name.length)
    var lineBreak = false
    for (c in name) {
        when (c.code) {
            in BIDI_CONTROLS -> Unit
            in LINE_BREAKS -> lineBreak = true
            else -> {
                if (lineBreak && line.isNotEmpty()) line.append(' ')
                lineBreak = false
                line.append(c)
            }
        }
    }
    return line.toString().trim()
}
