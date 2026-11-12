package io.silentsuite.sync.ui

import android.app.Application
import android.app.Dialog
import android.content.DialogInterface
import android.os.Bundle
import androidx.annotation.StringRes
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.NotesRemovalOffer.Opened
import io.silentsuite.sync.ui.NotesRemovalOffer.Outcome
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Cause
import io.silentsuite.sync.ui.PendingNotesRemovalGuard.Verdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The confirmation that removes an account whose Notes files cannot be checked: "Remove {name} from this device?", the
 * words for what stands in the way, and "Remove account" and Cancel. Its arguments carry the confirmation's id, the
 * row's type and name, the reason, and the token of the app process that made it ([ProcessIncarnation]); the
 * confirmation itself lives in the allowance, in memory. Restored by Android in a new process, it shows the same words,
 * and its "Remove account" checks again and offers a new confirmation (the maintainer's answer on #709, 2026-10-23),
 * never a removal; in the same process, once it has ended, it says only that. Cancel, Back and a tap outside end it;
 * its dismissal alone does not, since that can come from a configuration change. The removal section of Unsynced
 * Notes opens it ([NotesRemovalViewModel.open]).
 */
class NotesRemovalDialogFragment : DialogFragment() {
    private val model: NotesRemovalViewModel by viewModels(ownerProducer = { requireParentFragment() })

    private val shownId get() = requireArguments().getString(ARG_SHOWN)!!

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val id = shownId
        val type = args.getString(ARG_TYPE)!!
        val name = args.getString(ARG_NAME)!!
        val reason = reasonOf(args.getStringArrayList(ARG_REASON))
        val builder = MaterialAlertDialogBuilder(requireContext())
        val step = restore(ProcessIncarnation.isCurrent(args.getString(ARG_PROCESS)),
            NotesRemovalAllowance.process.shown(id) != null, reason != null)
        if (step == Restore.ENDED || reason == null) {
            return builder.setMessage(R.string.notes_remove_uncheckable_ended)
                .setPositiveButton(android.R.string.ok, null)
                .create()
        }
        return builder
            .setTitle(getString(R.string.notes_remove_uncheckable_title, name))
            .setMessage(getString(NotesRemovalOffer.text(reason), name))
            .setNegativeButton(android.R.string.cancel) { _, _ -> model.cancel(id) }
            .setPositiveButton(R.string.notes_remove_uncheckable_confirm) { _, _ ->
                if (step == Restore.SHOWN) model.confirm(id) else model.open(type, name)
            }
            .create()
    }

    override fun onCancel(dialog: DialogInterface) {
        super.onCancel(dialog)
        model.cancel(shownId)
    }

    /**
     * What a dialog shows once it is made, whether new or restored: [SHOWN], the confirmation it was made for, which
     * shows in this process; [ANOTHER_PROCESS], one restored in a new process, whose button checks again; [ENDED],
     * one of this process that has ended, or whose reason does not read.
     */
    internal enum class Restore { SHOWN, ANOTHER_PROCESS, ENDED }

    companion object {
        private const val ARG_SHOWN = "notesRemoval.shown"
        private const val ARG_TYPE = "notesRemoval.type"
        private const val ARG_NAME = "notesRemoval.name"
        private const val ARG_REASON = "notesRemoval.reason"
        /** The app process that made the dialog ([ProcessIncarnation]). Internal for the device case. */
        internal const val ARG_PROCESS = "notesRemoval.process"

        /** One confirmation shows at a time. */
        internal const val TAG = "notes-removal"

        /**
         * [Restore] for a dialog made in this process or not ([thisProcess]), whose confirmation shows ([showing]) and
         * whose reason reads ([readable]).
         */
        internal fun restore(thisProcess: Boolean, showing: Boolean, readable: Boolean): Restore = when {
            !readable -> Restore.ENDED
            !thisProcess -> Restore.ANOTHER_PROCESS
            showing -> Restore.SHOWN
            else -> Restore.ENDED
        }

        /** The reason from a dialog's arguments, or null when it does not read as one this build knows. */
        internal fun reasonOf(names: List<String>?): Set<Cause>? = try {
            names?.map(Cause::valueOf)?.toSet()?.takeIf { reason ->
                Verdict.entries.any { it.eligible && it.reason == reason }
            }
        } catch (e: IllegalArgumentException) {
            null
        }

        internal fun newInstance(shown: NotesRemovalAllowance.Shown) = NotesRemovalDialogFragment().apply {
            arguments = Bundle(5).apply {
                putString(ARG_SHOWN, shown.id)
                putString(ARG_TYPE, shown.key.type)
                putString(ARG_NAME, shown.key.name)
                putStringArrayList(ARG_REASON, ArrayList(shown.reason.map { it.name }.sorted()))
                putString(ARG_PROCESS, ProcessIncarnation.current())
            }
        }
    }
}

/**
 * The confirmation's steps for [NotesRemovalDialogFragment] and the taps on the removal section of Unsynced Notes,
 * scoped to that screen, so their results outlive the dialog: the work runs off the main thread, and each result
 * waits until the screen has shown it.
 */
internal class NotesRemovalViewModel(app: Application) : AndroidViewModel(app) {
    /**
     * What a tap came to, for the row named [name]; null for a tap on a confirmation that had ended, which names no
     * row.
     */
    data class Result(val outcome: Outcome, val name: String?) {
        /**
         * What the screen says: without a name, that this attempt didn't remove the account because the confirmation
         * had ended, as the tap stopped before any removal; else the outcome's message.
         */
        @get:StringRes
        val message: Int get() = if (name == null) R.string.notes_remove_uncheckable_ended_tap
            else NotesRemovalOffer.message(outcome)
    }

    /** What a check of the row named [name] came to when it offers no confirmation, as [text]. */
    data class Checked(@get:StringRes val text: Int, val name: String)

    private val mutableResult = MutableLiveData<Result?>()
    val result: LiveData<Result?> = mutableResult

    private val mutableChecked = MutableLiveData<Checked?>()
    val checked: LiveData<Checked?> = mutableChecked

    /** A new confirmation for the screen to show. */
    private val mutableOpened = MutableLiveData<NotesRemovalAllowance.Shown?>()
    val opened: LiveData<NotesRemovalAllowance.Shown?> = mutableOpened

    /**
     * The confirmation whose tap runs: set by [confirm], and cleared once its result is set, so a second tap on it, as
     * from a double tap before the dialog goes, does nothing. On the main thread only.
     */
    private var confirming: String? = null

    /** Whether a check runs ([open]); another tap waits for it. On the main thread only. */
    private var opening = false

    /**
     * The removals this screen's taps asked for whose outcome hasn't come ([NotesRemovalAnswer.askInApp]): a no Android
     * gives for that row meanwhile waits for the outcome, and is posted if the user has left the screen by then
     * ([inFront]), if the outcome can't say whether the account was removed, or if the screen goes first
     * ([onCleared]). On the main thread only.
     */
    private val asking = mutableSetOf<NotesRemovalAnswer.Asking>()

    /**
     * Whether the screen is in front of the user, resumed: it sets this in onResume and clears it in onPause, which
     * comes first on Home, Back, Recents and the power button. On the main thread only.
     */
    var inFront = false

    /** The tap on "Remove account" of the confirmation [id]. */
    fun confirm(id: String) {
        val tapped = NotesRemovalAllowance.process.now()
        if (confirming == id) return
        val key = NotesRemovalAllowance.process.shown(id)?.key
        if (key == null) {
            mutableResult.value = Result(Outcome.CHANGED, null)
            return
        }
        confirming = id
        val marked = NotesRemovalAnswer.askInApp(key.type, key.name)
        asking += marked
        val offer = NotesRemovalOffer.onDevice(getApplication())
        fun done(outcome: Outcome) {
            // On the main thread, as onCleared runs, so one of the two ends the mark. A screen in front of the user
            // says the outcome, with any no the mark took. Once the user has left it, the outcome may never be seen
            // there, and an UNKNOWN one doesn't say whether the account stayed, so that no is posted now.
            viewModelScope.launch {
                asking -= marked
                if (inFront && outcome != Outcome.UNKNOWN) marked.done() else marked.left()?.let { post(it) }
                if (confirming == id) confirming = null
                mutableResult.value = Result(outcome, key.name)
            }
        }
        viewModelScope.launch(Dispatchers.IO) {
            try {
                offer.confirm(key.type, key.name, id, tapped, ::done)
            } catch (e: Exception) {
                done(Outcome.RETRY)
            }
        }
    }

    /**
     * A tap on the row of [type] named [name] in the removal section, or on "Remove account" of a confirmation that
     * Android restored in a new process: SilentSuite checks again ([NotesRemovalOffer.open]) and offers a new
     * confirmation, or says what the check came to.
     */
    fun open(type: String, name: String) {
        if (opening) return
        opening = true
        val offer = NotesRemovalOffer.onDevice(getApplication())
        viewModelScope.launch {
            val opened = try {
                withContext(Dispatchers.IO) { offer.open(type, name) }
            } catch (e: Exception) {
                Opened.Refused(NotesRemovalNotice.Kind.UNCHECKED)
            } finally {
                opening = false
            }
            when (opened) {
                is Opened.Confirm -> mutableOpened.value = opened.shown
                else -> mutableChecked.value = Checked(said(opened), name)
            }
        }
    }

    /** The confirmation [id] was canceled. */
    fun cancel(id: String) = NotesRemovalAllowance.process.cancel(id)

    /** The screen goes: a no that one of its removals took before the outcome came is posted now. */
    override fun onCleared() {
        for (marked in asking) marked.left()?.let { post(it) }
        asking.clear()
    }

    /** The refusal notification in the words of [kind]; one that can't be posted changes nothing. */
    private fun post(kind: NotesRemovalNotice.Kind) {
        try {
            NotesRemovalNotice.post(getApplication(), kind)
        } catch (ignored: Exception) {
        }
    }

    /** The screen has shown the result. */
    fun consume() {
        mutableResult.value = null
    }

    /** The screen has shown what the check came to. */
    fun consumeChecked() {
        mutableChecked.value = null
    }

    /** The screen has shown the new confirmation. */
    fun consumeOpened() {
        mutableOpened.value = null
    }

    companion object {
        /** What the screen says when a check offers no confirmation. */
        @StringRes
        fun said(opened: Opened): Int = when (opened) {
            Opened.Gone -> R.string.notes_removal_gone
            Opened.Allowed -> R.string.notes_removal_allowed
            is Opened.Refused, is Opened.Confirm -> R.string.notes_removal_still_refused
        }
    }
}
