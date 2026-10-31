package io.silentsuite.sync.ui

import android.app.Application
import android.app.Dialog
import android.content.DialogInterface
import android.os.Bundle
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.NotesRemovalOffer.Outcome
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * The confirmation that removes an account whose Notes files cannot be checked: "Remove {name} from this device?", the
 * words for what stands in the way, and "Remove account" and Cancel. Its arguments carry the confirmation's id alone;
 * the name and the reason are read from the allowance, in memory, so a confirmation restored after the process ended
 * confirms nothing and says only that it has ended. Cancel, Back and a tap outside end it; its dismissal alone does
 * not, since that can come from a configuration change. Nothing opens it yet.
 */
class NotesRemovalDialogFragment : DialogFragment() {
    private val model: NotesRemovalViewModel by viewModels(ownerProducer = { requireParentFragment() })

    private val shownId get() = requireArguments().getString(ARG_SHOWN)!!

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val id = shownId
        val builder = MaterialAlertDialogBuilder(requireContext())
        val shown = NotesRemovalAllowance.process.shown(id)
            ?: return builder.setMessage(R.string.notes_remove_uncheckable_ended)
                .setPositiveButton(android.R.string.ok, null)
                .create()
        val name = shown.key.name
        return builder
            .setTitle(getString(R.string.notes_remove_uncheckable_title, name))
            .setMessage(getString(NotesRemovalOffer.text(shown.reason), name))
            .setNegativeButton(android.R.string.cancel) { _, _ -> model.cancel(id) }
            .setPositiveButton(R.string.notes_remove_uncheckable_confirm) { _, _ -> model.confirm(id) }
            .create()
    }

    override fun onCancel(dialog: DialogInterface) {
        super.onCancel(dialog)
        model.cancel(shownId)
    }

    companion object {
        private const val ARG_SHOWN = "notesRemoval.shown"

        internal fun newInstance(shown: String) = NotesRemovalDialogFragment().apply {
            arguments = Bundle(1).apply { putString(ARG_SHOWN, shown) }
        }
    }
}

/**
 * The confirmation's steps for [NotesRemovalDialogFragment], scoped to the screen that shows it, so its result outlives
 * the dialog: the tap runs off the main thread, and the result waits until the screen has shown it.
 */
internal class NotesRemovalViewModel(app: Application) : AndroidViewModel(app) {
    /** What a tap came to, for the row named [name]. */
    data class Result(val outcome: Outcome, val name: String)

    private val mutableResult = MutableLiveData<Result?>()
    val result: LiveData<Result?> = mutableResult

    /**
     * The confirmation whose tap runs: set by [confirm], and cleared once its result is set, so a second tap on it, as
     * from a double tap before the dialog goes, does nothing. On the main thread only.
     */
    private var confirming: String? = null

    /** The tap on "Remove account" of the confirmation [id]. */
    fun confirm(id: String) {
        val tapped = NotesRemovalAllowance.process.now()
        if (confirming == id) return
        val key = NotesRemovalAllowance.process.shown(id)?.key
        if (key == null) {
            mutableResult.value = Result(Outcome.CHANGED, "")
            return
        }
        confirming = id
        val offer = NotesRemovalOffer.onDevice(getApplication())
        fun done(outcome: Outcome) {
            viewModelScope.launch {
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

    /** The confirmation [id] was canceled. */
    fun cancel(id: String) = NotesRemovalAllowance.process.cancel(id)

    /** The screen has shown the result. */
    fun consume() {
        mutableResult.value = null
    }
}
