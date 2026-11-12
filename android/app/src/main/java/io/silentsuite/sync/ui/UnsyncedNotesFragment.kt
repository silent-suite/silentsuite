package io.silentsuite.sync.ui

import android.app.Application
import android.app.Dialog
import android.os.Bundle
import android.view.View
import androidx.annotation.StringRes
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.viewModels
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewModelScope
import androidx.preference.Preference
import androidx.preference.PreferenceCategory
import androidx.preference.PreferenceFragmentCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.HubRemoval
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Result
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Step
import io.silentsuite.sync.ui.UnsyncedNotesSignOutPolicy.Text
import io.silentsuite.sync.ui.settings.AppPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings, Unsynced Notes: one row per Notes store on this device that holds unsynced text, cannot be read, or has a
 * discard that did not finish, a present account's by its name and any other as not matched to an account, in
 * folder-name order. A row opens the confirmation for that one store ([UnsyncedNotesDiscardDialogFragment]), and the
 * result shows in a Snackbar. No row opens one while a confirmation runs, and the row of a store whose discard did not
 * finish opens none: it goes on only by Retry, the Snackbar's while the screen holds that result, else the row's own,
 * from the store's state, which outlives the screen ([UnsyncedNotesRow.stopped]). It works offline and without a
 * session: it reads the stores through [UnsyncedNotesStores], off the main thread, every time it resumes. The rows say
 * how many changes each store holds, that they could not be counted, that the store cannot be read right now, or that
 * its discard did not finish, never a count of zero, and a last row says when other Notes files could not be shown.
 *
 * Below them, read in the same load, the removal section ([NotesRemovalSection]): the accounts Android settings can't
 * remove right now, with what stands in the way. A tap on one checks again, and for files only the confirmation can
 * get past opens it ([NotesRemovalDialogFragment]); what that came to shows in a Snackbar, and the screen reads again.
 */
class UnsyncedNotesFragment : PreferenceFragmentCompat() {
    /** Kept across a rotation and cleared once the screen is left, so a result never shows on a later visit. */
    private val model: UnsyncedNotesViewModel by viewModels()

    /** The removal section's checks and its confirmation, which outlive the dialog ([NotesRemovalDialogFragment]). */
    private val removal: NotesRemovalViewModel by viewModels()

    /** The Snackbar with Retry of a discard that did not finish, while it shows. */
    private var retryBar: Snackbar? = null

    override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
        preferenceManager.sharedPreferencesName = AppPreferences.PREFERENCES_NAME
        preferenceScreen = preferenceManager.createPreferenceScreen(requireContext())
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        model.listing.observe(viewLifecycleOwner, ::showListing)
        model.result.observe(viewLifecycleOwner, ::showResult)
        removal.opened.observe(viewLifecycleOwner, ::showConfirmation)
        removal.result.observe(viewLifecycleOwner) { result ->
            if (result != null) {
                showRemoval(result.name?.let { getString(result.message, it) } ?: getString(result.message))
                removal.consume()
                model.load()
            }
        }
        removal.checked.observe(viewLifecycleOwner) { checked ->
            if (checked != null) {
                showRemoval(getString(checked.text, checked.name))
                removal.consumeChecked()
                model.load()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        removal.inFront = true
        model.load()
    }

    override fun onPause() {
        removal.inFront = false
        super.onPause()
    }

    override fun onDestroyView() {
        // The bar sits in the activity's content view, not in this screen's, so it would outlive the screen.
        retryBar?.dismiss()
        retryBar = null
        super.onDestroyView()
    }

    private fun showListing(listing: UnsyncedNotesListing) {
        val screen = preferenceScreen
        screen.removeAll()
        for (row in listing.rows) screen.addPreference(Preference(requireContext()).apply {
            key = KEY_ROW + row.directory
            title = row.owner?.name ?: getString(R.string.notes_store_unmatched)
            // A discard of this store that did not finish goes on only by a Retry: the Snackbar's while the screen
            // holds its result, else the row's own, from the store's state, which outlives the screen.
            val stopped = UnsyncedNotesDiscardPolicy.notFinished(row.directory, model.result.value)
            summary = if (stopped) {
                getString(R.string.notes_discard_not_finished)
            } else if (row.stopped && row.answer != null) {
                getString(R.string.notes_discard_not_finished_row)
            } else if (row.stopped) {
                getString(R.string.notes_discard_not_finished)
            } else when (val text = UnsyncedNotesDiscardPolicy.rowText(row.answer)) {
                is Text.Counted -> resources.getQuantityString(R.plurals.notes_store_unsynced, text.count, text.count)
                Text.Uncounted -> getString(R.string.notes_store_uncounted)
                Text.Unlisted -> getString(R.string.notes_store_unlisted)
            }
            isPersistent = false
            // A store whose read threw has nothing to confirm, and no Retry until it reads again, since the Retry's
            // discard counts first. When a discard of it stopped, its row still says that the discard did not finish.
            val answer = row.answer
            isEnabled = answer != null && !stopped
            if (answer != null) setOnPreferenceClickListener {
                // Asked again at the tap: the result can change before the rows are read again.
                if (UnsyncedNotesDiscardPolicy.rowOpens(row.directory, model.result.value, model.answering)) {
                    // A store whose discard stopped is never asked anew, and never for an acknowledgement: the screen
                    // may no longer hold the confirmation the user gave, and the store may have deleted already.
                    if (row.stopped) model.retryStopped(row.directory, row.owner?.name)
                    else ask(row.directory, row.owner?.name, answer)
                }
                true
            }
        })
        // Read with the stores, in the same load, so "Nothing to show" never sits beside a row of the section.
        val section = model.section.value
        when {
            listing.othersUnlisted -> addNote(KEY_OTHERS, R.string.notes_stores_others_unlisted)
            listing.unknownOthers -> addNote(KEY_OTHERS, R.string.notes_stores_others_unknown)
            listing.rows.isEmpty() && (section == null || section.empty) -> addNote(KEY_NONE, R.string.notes_stores_none)
        }
        if (section != null && !section.empty) addSection(section)
    }

    /**
     * The removal section, last: the accounts Android settings can't remove right now, each with what stands in the
     * way, or one row when the accounts can't be read, under a heading that claims no refusal, as the guard may still
     * allow a removal then. A tap checks again.
     */
    private fun addSection(section: NotesRemovalSection.Section) {
        val category = PreferenceCategory(requireContext()).apply {
            key = KEY_REMOVAL
            setTitle(if (section.accountsUnread) R.string.notes_removal_section_title_unread
                else R.string.notes_removal_section_title)
            isPersistent = false
        }
        preferenceScreen.addPreference(category)
        if (section.accountsUnread) category.addPreference(Preference(requireContext()).apply {
            key = KEY_REMOVAL_ACCOUNTS
            setTitle(R.string.notes_removal_section_accounts)
            isSingleLineTitle = false
            isPersistent = false
            setOnPreferenceClickListener {
                model.load()
                true
            }
        })
        for (row in section.rows) category.addPreference(Preference(requireContext()).apply {
            key = removalKey(row.name)
            title = row.name
            setSummary(NotesRemovalSection.summary(row.kind))
            isPersistent = false
            setOnPreferenceClickListener {
                removal.open(row.type, row.name)
                true
            }
        })
    }

    /** A new confirmation of the removal section, unless the screen's state is saved; it shows once. */
    private fun showConfirmation(shown: NotesRemovalAllowance.Shown?) {
        if (shown == null || childFragmentManager.isStateSaved) return
        NotesRemovalDialogFragment.newInstance(shown).show(childFragmentManager, NotesRemovalDialogFragment.TAG)
        removal.consumeOpened()
    }

    /**
     * What a removal or a check of the section came to, in up to four lines, since it starts with an account name. It
     * takes the place of a discard's Retry while the screen holds a discard that did not finish, so that Retry shows
     * again once this goes, unless another Snackbar took its place, which then does the same.
     */
    private fun showRemoval(text: String) {
        val view = view ?: return
        Snackbar.make(view, text, Snackbar.LENGTH_LONG).setTextMaxLines(4)
            .addCallback(object : Snackbar.Callback() {
                override fun onDismissed(bar: Snackbar?, event: Int) {
                    val held = model.result.value
                    if (event != Snackbar.Callback.DISMISS_EVENT_CONSECUTIVE && held is Result.NotFinished &&
                        this@UnsyncedNotesFragment.view === view) showResult(held)
                }
            })
            .show()
    }

    /** A last row with no action. */
    private fun addNote(key: String, @StringRes text: Int) {
        preferenceScreen.addPreference(Preference(requireContext()).apply {
            this.key = key
            setTitle(text)
            isSingleLineTitle = false
            isEnabled = false
            isPersistent = false
        })
    }

    /** Shows the confirmation of [shown] for one store, unless that store's dialog of that step shows already. */
    private fun ask(directory: String, label: String?, shown: UnsyncedNotes): Boolean {
        val tag = UnsyncedNotesDiscardDialogFragment.tag(UnsyncedNotesDiscardPolicy.step(shown), directory)
        if (childFragmentManager.isStateSaved) return false
        // A dialog of this store and step that has not ended is open already. One that has ended is still found until
        // the platform removes it, which can be after its result asked for this step again.
        val open = childFragmentManager.findFragmentByTag(tag) as? UnsyncedNotesDiscardDialogFragment
        if (open == null || open.ended) {
            UnsyncedNotesDiscardDialogFragment.newInstance(directory, label, shown).show(childFragmentManager, tag)
        }
        return true
    }

    private fun showResult(result: Result?) {
        retryBar?.dismiss()
        retryBar = null
        val view = view ?: return
        when (result) {
            null -> Unit
            is Result.Ask -> if (ask(result.directory, result.label, result.now)) model.consume()
            Result.Reload -> model.consume()
            // Kept until Retry is tapped, so a rotation shows it again.
            is Result.NotFinished -> retryBar =
                Snackbar.make(view, R.string.notes_discard_not_finished, Snackbar.LENGTH_INDEFINITE)
                    .setAction(R.string.retry) { model.retry(result) }
                    .also { it.show() }
            else -> {
                UnsyncedNotesDiscardPolicy.message(result)?.let { message ->
                    Snackbar.make(view, message, Snackbar.LENGTH_LONG).show()
                }
                model.consume()
            }
        }
    }

    companion object {
        private const val KEY_ROW = "unsynced_notes:"
        internal const val KEY_OTHERS = "unsynced_notes_others"
        internal const val KEY_NONE = "unsynced_notes_none"
        internal const val KEY_REMOVAL = "unsynced_notes_removal"
        internal const val KEY_REMOVAL_ACCOUNTS = "unsynced_notes_removal_accounts"
        private const val KEY_REMOVAL_ROW = "unsynced_notes_removal:"

        internal fun rowKey(directory: String) = KEY_ROW + directory

        internal fun removalKey(name: String) = KEY_REMOVAL_ROW + name

        /**
         * Reads the stores and the removal section off the main thread and shows the Settings hub's [row] only while
         * some store holds anything, cannot be read, or has a discard that did not finish, with how many changes there
         * are, or that not all of them could be counted; or, with no such store, while Android settings can't remove
         * an account now or the accounts can't be read ([UnsyncedNotesDiscardPolicy.hubRemoval]), saying which.
         * [fragment] calls it whenever it resumes, so a return from the screen shows what is there now.
         */
        internal fun refreshHubRow(fragment: Fragment, row: Preference) {
            val app = fragment.requireContext().applicationContext
            fragment.viewLifecycleOwner.lifecycleScope.launch {
                val (listing, removal) = withContext(Dispatchers.IO) {
                    UnsyncedNotesStores.read(app) to NotesRemovalSection.read(app)
                }
                if (!fragment.isAdded) return@launch
                val summary = UnsyncedNotesDiscardPolicy.hubSummary(listing)
                val removalOnly = UnsyncedNotesDiscardPolicy.hubRemoval(summary, removal)
                row.isVisible = summary != null || removalOnly != null
                row.summary = when (summary) {
                    null -> when (removalOnly) {
                        HubRemoval.REFUSED -> fragment.getString(R.string.settings_unsynced_notes_removal)
                        HubRemoval.ACCOUNTS_UNREAD -> fragment.getString(R.string.settings_unsynced_notes_accounts)
                        null -> null
                    }
                    is Text.Counted -> fragment.resources
                        .getQuantityString(R.plurals.settings_unsynced_notes_summary, summary.count, summary.count)
                    else -> fragment.getString(R.string.settings_unsynced_notes_uncounted)
                }
            }
        }
    }
}

/**
 * The confirmation for one store of [UnsyncedNotesFragment]. For a store that listed, a discard: how many changes go,
 * or that they could not be counted, with Discard and Cancel. For a store that could not be listed, an
 * acknowledgement, in words of its own: it never says discard, says that nothing is deleted, and that unsynced Notes
 * text may remain on this device and may no longer sync. The dialog keeps all of the answer it showed, and the token
 * of the app process that made it ([ProcessIncarnation]), in its arguments, and sends both with its one confirming
 * button, so the screen counts again and asks again for an answer from a dialog that Android restored in a new
 * process. Cancel, Back and a tap outside send nothing. Once it has sent its confirmation, it has [ended].
 */
class UnsyncedNotesDiscardDialogFragment : DialogFragment() {
    private val model: UnsyncedNotesViewModel by viewModels(ownerProducer = { requireParentFragment() })

    /**
     * Set once this dialog has sent its confirmation. Its window closes after that, and the platform removes the
     * dialog later still, so a result that shows this step again can find it; the screen does not count an ended
     * dialog as open. In memory only: a dialog brought back by a recreation starts unset, and holds its step until it
     * ends. Cancel, Back and a tap outside send nothing and leave it unset.
     */
    internal var ended = false
        private set

    override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
        val args = requireArguments()
        val directory = args.getString(ARG_DIRECTORY)!!
        val label = args.getString(ARG_LABEL)
        // The app process that made the dialog; null for a dialog with none, which counts as another process.
        val shownIn = args.getString(ARG_PROCESS)
        // All of the answer, the names it was counted from included: a confirmation covers only what it names.
        val shown = UnsyncedNotes(args.getInt(ARG_COUNT), args.getLong(ARG_SEQUENCE), args.getBoolean(ARG_UNREADABLE),
            args.getBoolean(ARG_LISTED), args.getStringArrayList(ARG_NAMES)!!.toSet())
        val name = label ?: getString(R.string.notes_store_unmatched_name)
        val text = UnsyncedNotesSignOutPolicy.text(shown)
        fun confirm() {
            ended = true
            model.answer(directory, label, shown, shownIn)
        }
        val builder = MaterialAlertDialogBuilder(requireContext())
            .setNegativeButton(android.R.string.cancel, null)
        return when (UnsyncedNotesDiscardPolicy.step(shown)) {
            Step.DISCARD -> builder
                .setTitle(R.string.notes_discard_title)
                .setMessage(if (text is Text.Counted) {
                    resources.getQuantityString(R.plurals.notes_discard_store_text, text.count, text.count, name)
                } else {
                    getString(R.string.notes_discard_store_uncounted, name)
                })
                .setPositiveButton(R.string.notes_discard) { _, _ -> confirm() }
                .create()
            Step.ACKNOWLEDGE -> builder
                .setTitle(R.string.notes_acknowledge_title)
                .setMessage(getString(R.string.notes_store_acknowledge_text, name))
                .setPositiveButton(R.string.notes_acknowledge_continue) { _, _ -> confirm() }
                .create()
        }
    }

    companion object {
        private const val ARG_DIRECTORY = "unsyncedNotes.directory"
        private const val ARG_LABEL = "unsyncedNotes.label"
        private const val ARG_COUNT = "unsyncedNotes.count"
        private const val ARG_SEQUENCE = "unsyncedNotes.sequence"
        private const val ARG_UNREADABLE = "unsyncedNotes.unreadable"
        private const val ARG_LISTED = "unsyncedNotes.listed"
        private const val ARG_NAMES = "unsyncedNotes.names"
        /**
         * The app process that made the dialog ([ProcessIncarnation]). Internal for the device case, which writes
         * another.
         */
        internal const val ARG_PROCESS = "unsyncedNotes.process"

        /**
         * One tag per store and step. The screen looks the tag up before it shows a step for a store, and shows none
         * while it finds one that has not [UnsyncedNotesDiscardDialogFragment.ended], so a dialog for one store never
         * stands in for another store's.
         */
        internal fun tag(step: Step, directory: String) = "unsynced-notes-store-" + step.name + ":" + directory

        internal fun newInstance(directory: String, label: String?, shown: UnsyncedNotes) =
            UnsyncedNotesDiscardDialogFragment().apply {
                arguments = Bundle(8).apply {
                    putString(ARG_DIRECTORY, directory)
                    putString(ARG_LABEL, label)
                    putInt(ARG_COUNT, shown.count)
                    putLong(ARG_SEQUENCE, shown.sequence)
                    putBoolean(ARG_UNREADABLE, shown.unreadable)
                    putBoolean(ARG_LISTED, shown.listed)
                    putStringArrayList(ARG_NAMES, ArrayList(shown.names.sorted()))
                    putString(ARG_PROCESS, ProcessIncarnation.current())
                }
            }
    }
}

/**
 * The stores [UnsyncedNotesFragment] shows, and the result of the last confirmation until the screen has shown it.
 * Every store call runs off the main thread. While a confirmation runs, the screen opens no other, and another one
 * that comes is ignored. When the model is cleared while one runs, the store still finishes it, and only its result is
 * dropped. An answer from a dialog made in another app process goes to no store: the store is read again instead.
 */
internal class UnsyncedNotesViewModel(app: Application) : AndroidViewModel(app) {
    private val mutableListing = MutableLiveData<UnsyncedNotesListing>()
    val listing: LiveData<UnsyncedNotesListing> = mutableListing

    /** The removal section, read in the same load as [listing] and set just before it, so both show together. */
    private val mutableSection = MutableLiveData<NotesRemovalSection.Section>()
    val section: LiveData<NotesRemovalSection.Section> = mutableSection
    private val mutableResult = MutableLiveData<Result?>()
    val result: LiveData<Result?> = mutableResult

    /** How many reads were started; only the last one started is shown. */
    private var loads = 0

    /**
     * Whether a confirmation runs: set by [discard] and [countAgain], and cleared once its result is set. On the main
     * thread only.
     */
    var answering = false
        private set

    fun load() {
        val load = ++loads
        viewModelScope.launch {
            val (read, section) = withContext(Dispatchers.IO) {
                UnsyncedNotesStores.read(getApplication()) to NotesRemovalSection.read(getApplication())
            }
            if (load == loads) {
                mutableSection.value = section
                mutableListing.value = read
            }
        }
    }

    /**
     * The user confirmed [shown] for the store in [directory], in a dialog made in the app process [shownIn]
     * ([ProcessIncarnation]). Only an answer from this process goes to the store. One from a dialog that Android
     * restored in a new process, or from one with no token, is counted again ([countAgain]): nothing is discarded or
     * recorded for it.
     */
    fun answer(directory: String, label: String?, shown: UnsyncedNotes, shownIn: String?) {
        if (ProcessIncarnation.isCurrent(shownIn)) discard(directory, label, shown, retry = false)
        else countAgain(directory)
    }

    /** [shown] goes to the store in [directory]; [retry] after a discard that did not finish. */
    private fun discard(directory: String, label: String?, shown: UnsyncedNotes, retry: Boolean) {
        if (answering) return
        answering = true
        mutableResult.value = null
        viewModelScope.launch {
            try {
                mutableResult.value = withContext(Dispatchers.IO) {
                    UnsyncedNotesStores.discard(getApplication(), directory, label, shown, retry)
                }
            } finally {
                answering = false
            }
            load()
        }
    }

    /**
     * Retry sends the confirmation the user gave again; the store counts again and refuses what it does not cover. It
     * needs no token: the confirmation lives only in this model, which a new process does not have.
     */
    fun retry(notFinished: Result.NotFinished) =
        discard(notFinished.directory, notFinished.label, notFinished.shown, retry = true)

    /**
     * The Retry of a row whose store's discard stopped ([UnsyncedNotesRow.stopped]), when the screen no longer holds
     * the confirmation the user gave. It sends an answer of nothing, which covers nothing that holds anything: the
     * store finishes only a discard that left no unsynced text, and the dialog shows again for any text left. It goes
     * on only while that discard has not finished ([UnsyncedNotesStores.discard]).
     */
    fun retryStopped(directory: String, label: String?) =
        discard(directory, label, UnsyncedNotes.NOTHING, retry = true)

    /**
     * An answer from a dialog made in another app process: the store in [directory] is read again, and
     * [UnsyncedNotesDiscardPolicy.restored] says what follows, the dialog again or only a new read of the stores.
     */
    private fun countAgain(directory: String) {
        if (answering) return
        answering = true
        mutableResult.value = null
        viewModelScope.launch {
            try {
                val now = withContext(Dispatchers.IO) { UnsyncedNotesStores.reread(getApplication(), directory) }
                mutableResult.value = UnsyncedNotesDiscardPolicy.restored(now)
            } finally {
                answering = false
            }
            load()
        }
    }

    /** The screen has shown the result. */
    fun consume() {
        mutableResult.value = null
    }
}
