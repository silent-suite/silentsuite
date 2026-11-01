package io.silentsuite.sync.ui.etebase

import android.app.Dialog
import android.content.Context
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.activityViewModels
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.CachedCollection
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.UnsyncedNotesSignOutPolicy.Text
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Answer
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Kind
import io.silentsuite.sync.ui.etebase.NotebookLeaveOrDeletePolicy.Step

/**
 * The dialogs a notebook screen shows when the user leaves or deletes a Notes notebook ([NotebookLeaveOrDeletePolicy]).
 * The count of changes that have not synced comes with Sync now (positive), Cancel, and going on without syncing; the
 * separate confirmation with Cancel and the discard; the one more question after the server call with Discard and Keep,
 * which cannot be canceled. For a store that could not be listed, where going on deletes nothing, the dialogs have
 * words of their own, and none of them calls it a discard.
 *
 * The dialog keeps the notebook's exact identity, all of the answer it showed, the names that answer was counted from
 * included, and the token of the app process that made it ([ProcessIncarnation]) in its arguments, and sends them with
 * every answer to the screen that shows it, which turns away an answer for another notebook, and counts again and asks
 * again for one from a dialog that Android restored in a new process. It decides nothing itself. Cancel, Back and a
 * tap outside end the dialog with nothing started, so they send nothing. Once it has sent an answer, it has [ended].
 * The notebook's name is read from the screen's collection, and follows it once it has loaded, never kept in the
 * arguments.
 */
class NotebookLeaveOrDeleteDialogFragment : DialogFragment() {
    private val collectionModel: CollectionViewModel by activityViewModels()

    /**
     * Set once this dialog has sent an answer. Its window closes after that, and the platform removes the dialog later
     * still, so an answer that shows this step again, as one counted again for a dialog made in another process, can
     * find it; [show] does not count an ended dialog as open. In memory only: a dialog brought back by a recreation
     * starts unset, and holds its step until it ends. Cancel, Back and a tap outside send nothing and leave it unset.
     */
    internal var ended = false
        private set

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val identity = CollectionLifecycleIdentity.from(args)
        val kind = Kind.valueOf(args.getString(ARG_KIND)!!)
        val step = Step.valueOf(args.getString(ARG_STEP)!!)
        // The app process that made the dialog; null for a dialog with none, which counts as another process.
        val shownIn = args.getString(ARG_PROCESS)
        // All of the answer, the names it was counted from included: a confirmation covers only what it names.
        val shown = UnsyncedNotes(args.getInt(ARG_COUNT), args.getLong(ARG_SEQUENCE), args.getBoolean(ARG_UNREADABLE),
            args.getBoolean(ARG_LISTED), args.getStringArrayList(ARG_NAMES)!!.toSet())
        fun send(answer: Answer) {
            ended = true
            val notebook = identity ?: return
            when (val host = parentFragment) {
                is EditCollectionFragment -> host.onNotebookAnswer(notebook, step, answer, shown, shownIn)
                is CollectionMembersFragment -> host.onNotebookAnswer(notebook, step, answer, shown, shownIn)
            }
        }
        val delete = kind == Kind.DELETE
        val text = NotebookLeaveOrDeletePolicy.text(shown)
        // A store that could not be listed: going on deletes nothing, so no word of a discard is used for it.
        val unlisted = text == Text.Unlisted
        val builder = MaterialAlertDialogBuilder(requireContext())
        return when (step) {
            Step.PLAIN -> builder
                .setTitle(R.string.delete_collection_confirm_title)
                .setMessage(plainWarning(collectionModel.value))
                .setPositiveButton(android.R.string.yes) { _, _ -> send(Answer.DISCARD) }
                .setNegativeButton(android.R.string.no, null)
                .create()
                // Restored after the process ended, the dialog can show before the collection has loaded: the
                // notebook's name follows once it has.
                .also { dialog -> collectionModel.observe(this) { dialog.setMessage(plainWarning(it)) } }
            Step.COUNT -> builder
                .setTitle(if (text is Text.Counted) R.string.notes_notebook_unsynced_title
                    else R.string.notes_notebook_maybe_unsynced_title)
                .setMessage(when (text) {
                    is Text.Counted -> resources.getQuantityString(if (delete) R.plurals.notes_notebook_unsynced_delete
                        else R.plurals.notes_notebook_unsynced_leave, text.count, text.count)
                    Text.Uncounted -> getString(R.string.notes_notebook_unsynced_uncounted)
                    Text.Unlisted -> getString(R.string.notes_notebook_unsynced_unlisted)
                })
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.account_synchronize_now) { _, _ -> send(Answer.SYNC_NOW) }
                .also {
                    if (NotebookLeaveOrDeletePolicy.offersGoingOn(shown)) it.setNeutralButton(when {
                        unlisted -> R.string.notes_continue_without_syncing
                        delete -> R.string.notes_notebook_delete_without_syncing
                        else -> R.string.notes_notebook_leave_without_syncing
                    }) { _, _ -> send(Answer.GO_ON_WITHOUT_SYNCING) }
                }
                .create()
            Step.DISCARD -> builder
                .setTitle(when {
                    !unlisted -> R.string.notes_discard_title
                    delete -> R.string.notes_notebook_acknowledge_title_delete
                    else -> R.string.notes_notebook_acknowledge_title_leave
                })
                .setMessage(when (text) {
                    is Text.Counted -> resources.getQuantityString(if (delete) R.plurals.notes_notebook_discard_delete
                        else R.plurals.notes_notebook_discard_leave, text.count, text.count)
                    Text.Uncounted -> getString(if (delete) R.string.notes_notebook_discard_uncounted_delete
                        else R.string.notes_notebook_discard_uncounted_leave)
                    Text.Unlisted -> getString(if (delete) R.string.notes_notebook_acknowledge_delete
                        else R.string.notes_notebook_acknowledge_leave)
                })
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(when {
                    unlisted -> R.string.notes_acknowledge_continue
                    delete -> R.string.notes_notebook_discard_and_delete
                    else -> R.string.notes_notebook_discard_and_leave
                }) { _, _ -> send(Answer.DISCARD) }
                .create()
            Step.AGAIN -> {
                // The notebook is gone already, and the screen behind holds it as it was: only an answer closes it.
                isCancelable = false
                builder
                    .setTitle(R.string.notes_discard_title)
                    .setMessage(when (text) {
                        is Text.Counted -> resources.getQuantityString(if (delete) R.plurals.notes_notebook_again_delete
                            else R.plurals.notes_notebook_again_leave, text.count, text.count)
                        // Asked only for a store that listed.
                        Text.Uncounted, Text.Unlisted -> getString(
                            if (delete) R.string.notes_notebook_again_uncounted_delete
                            else R.string.notes_notebook_again_uncounted_leave)
                    })
                    .setNegativeButton(R.string.notes_notebook_keep) { _, _ -> send(Answer.KEEP) }
                    .setPositiveButton(R.string.notes_notebook_discard) { _, _ -> send(Answer.DISCARD) }
                    .create()
            }
            Step.FAILED -> builder
                .setIcon(R.drawable.ic_info_dark)
                .setTitle(R.string.exception)
                .setMessage(failure(requireContext(), args.getString(ARG_FAILURE), args.getBoolean(ARG_KEPT),
                    args.getBoolean(ARG_STOPPED)))
                .setPositiveButton(android.R.string.yes, null)
                .create()
        }
    }

    /** Today's warning, with the name of [collection], or without a name while it has not loaded. */
    private fun plainWarning(collection: CachedCollection?): String = collection?.meta?.name
        ?.let { getString(R.string.delete_collection_confirm_warning, it) }
        ?: getString(R.string.notes_notebook_delete_confirm_unnamed)

    companion object {
        private const val ARG_KIND = "notebookLeaveOrDelete.kind"
        private const val ARG_STEP = "notebookLeaveOrDelete.step"
        private const val ARG_COUNT = "notebookLeaveOrDelete.count"
        private const val ARG_SEQUENCE = "notebookLeaveOrDelete.sequence"
        private const val ARG_UNREADABLE = "notebookLeaveOrDelete.unreadable"
        private const val ARG_LISTED = "notebookLeaveOrDelete.listed"
        private const val ARG_NAMES = "notebookLeaveOrDelete.names"
        private const val ARG_FAILURE = "notebookLeaveOrDelete.failure"
        private const val ARG_KEPT = "notebookLeaveOrDelete.kept"
        private const val ARG_STOPPED = "notebookLeaveOrDelete.stopped"

        /** The app process that made the dialog ([ProcessIncarnation]). */
        private const val ARG_PROCESS = "notebookLeaveOrDelete.process"

        /** One tag per kind and step. */
        internal fun tag(kind: Kind, step: Step) = "notebook-" + kind.name + "-" + step.name

        /** The words of a server call that failed: its error's message, and the line [line] adds, if any. */
        internal fun failure(context: Context, message: String?, kept: Boolean, stopped: Boolean): String =
            listOfNotNull(message?.takeIf { it.isNotBlank() }, line(context, kept, stopped)).joinToString("\n\n")

        /**
         * What a server call that failed adds when [kept], after a confirmation of changes to discard: that this
         * attempt deleted no Notes text, or, while a clear or a discard of the store that got as far as deleting has
         * stopped in this process ([stopped]), that the discard did not finish and some changes may already be
         * deleted.
         */
        private fun line(context: Context, kept: Boolean, stopped: Boolean): String? = when {
            !kept -> null
            stopped -> context.getString(R.string.notes_discard_not_finished)
            else -> context.getString(R.string.notes_notebook_failed_kept)
        }

        /**
         * Shows [step] of a notebook's [kind] in [host]'s child fragment manager, with this process's token; every
         * dialog of the flow is shown here. A dialog of that step that shows already and has not [ended] is kept.
         * While the host is not added or its state is saved, where a show would throw, the step is dropped and the user
         * taps again: false then.
         */
        internal fun show(
            host: Fragment,
            identity: CollectionLifecycleIdentity,
            kind: Kind,
            step: Step,
            shown: UnsyncedNotes,
            failure: String? = null,
            kept: Boolean = false,
            stopped: Boolean = false,
        ): Boolean {
            if (!host.isAdded || host.childFragmentManager.isStateSaved) return false
            val tag = tag(kind, step)
            // One that has ended is on its way out, and its step is shown again.
            val open = host.childFragmentManager.findFragmentByTag(tag) as? NotebookLeaveOrDeleteDialogFragment
            if (open != null && !open.ended) return true
            NotebookLeaveOrDeleteDialogFragment().apply {
                arguments = identity.toBundle().apply {
                    putString(ARG_KIND, kind.name)
                    putString(ARG_STEP, step.name)
                    putInt(ARG_COUNT, shown.count)
                    putLong(ARG_SEQUENCE, shown.sequence)
                    putBoolean(ARG_UNREADABLE, shown.unreadable)
                    putBoolean(ARG_LISTED, shown.listed)
                    putStringArrayList(ARG_NAMES, ArrayList(shown.names.sorted()))
                    putString(ARG_FAILURE, failure)
                    putBoolean(ARG_KEPT, kept)
                    putBoolean(ARG_STOPPED, stopped)
                    putString(ARG_PROCESS, ProcessIncarnation.current())
                }
            }.show(host.childFragmentManager, tag)
            return true
        }

        /**
         * A server call that failed: the error dialog while [host] can show one, else a message with the same words
         * through [context]'s application context. [kept] and [stopped] add the line [line] gives, which the message
         * says first, since it shows two lines at most.
         */
        internal fun failed(
            host: Fragment,
            context: Context,
            identity: CollectionLifecycleIdentity,
            kind: Kind,
            message: String?,
            kept: Boolean,
            stopped: Boolean,
        ) {
            if (show(host, identity, kind, Step.FAILED, UnsyncedNotes.NOTHING, message, kept, stopped)) return
            NotebookLeaveOrDelete.postResult(context, listOfNotNull(line(context, kept, stopped),
                context.getString(R.string.exception), message?.takeIf { it.isNotBlank() }).joinToString("\n"))
        }
    }
}
