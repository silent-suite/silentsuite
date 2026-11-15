package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Dialog
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The account's Unsynced text (design 3.5): local text that no notebook row shows, which the notebook list
 * counts on its "Unsynced text (N)" row. Held text, changes whose notebook is read-only, gone or not shown, text
 * an unfinished discard covers, and files that cannot be read. Copy puts readable text on the clipboard, marked sensitive; Try again sends
 * held text back to sync and asks for one Notes run, as a user gesture; Discard deletes one note's entry after a
 * confirmation, and only if it is still the entry the confirmation showed. Every store call runs off the main
 * thread, and nothing here clears a store.
 */
class HeldTextFragment : Fragment(), NotesSyncCoordinator.Listener {
    private lateinit var account: Account
    private lateinit var creationId: String
    private var loadJob: Job? = null

    /** Why the local changes could not be shown, as last rendered; observation point for runtime tests. */
    internal var renderedPending: PendingUnavailable? = null
        private set

    /** The notice line as last shown, null when none shows; observation point for runtime tests. */
    internal var renderedNotice: String? = null
        private set

    /** Set while a Try again or a Discard runs, so a second tap starts nothing. */
    private var actionRunning = false

    /** The rows as last rendered, null before the first load; observation point for runtime tests. */
    internal var renderedRows: List<HeldTextRow>? = null
        private set

    /** The Discard confirmation the screen holds, an ended one included; observation point for runtime tests. */
    internal val discardConfirmation: DiscardConfirmation?
        get() = childFragmentManager.findFragmentByTag(DISCARD_TAG) as? DiscardConfirmation

    /** The Discard confirmation while it is open; observation point for runtime tests. */
    internal val discardDialog: androidx.appcompat.app.AlertDialog?
        get() = discardConfirmation?.dialog as? androidx.appcompat.app.AlertDialog

    /**
     * The note whose Discard was answered in a confirmation made in another app process: the next load asks again
     * for it, with the text it reads then, if that text can still be discarded. In memory only.
     */
    private var askAgainFor: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_held_text, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        host()?.title = getString(R.string.notes_held_title)
    }

    override fun onStart() {
        super.onStart()
        NotesSyncCoordinator.addListener(this)
        reload()
    }

    override fun onStop() {
        NotesSyncCoordinator.removeListener(this)
        super.onStop()
    }

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        // A run can hold text or send what Try again released: show what it left once it ends.
        if (!NotesSyncCoordinator.isActive(identity) && !NotesSyncCoordinator.isPending(identity)) reload()
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun reload() {
        val host = host() ?: return
        val appContext = host.applicationContext
        // A newer load replaces an older one, so an older result can never render last.
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { NotesLoader.heldText(appContext, account, creationId) }
            val view = view ?: return@launch
            val current = host() ?: return@launch
            when (result) {
                is NotesLoad.Stale -> current.finish()
                // The rows already shown stay, and nothing on them is acted on without a store check. The failure is
                // a line that stays until a load works, not a message repeated after every run.
                is NotesLoad.Failed -> showNotice(view, getString(R.string.notes_held_load_failed))
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) render(view, result.value) else current.finish()
            }
        }
    }

    private fun showNotice(view: View, notice: String?) {
        renderedNotice = notice
        view.findViewById<TextView>(R.id.held_pending).apply {
            text = notice
            visibility = if (notice == null) View.GONE else View.VISIBLE
        }
    }

    private fun render(view: View, held: HeldTexts) {
        renderedRows = held.rows
        renderedPending = held.pending
        // While the local changes cannot be read at all, nothing is listed, so the notebooks' state says nothing.
        view.findViewById<View>(R.id.held_notebooks_failed).visibility =
            if (held.notebooksFailed && held.pending == null) View.VISIBLE else View.GONE
        showNotice(view, when (held.pending) {
            null -> null
            PendingUnavailable.UNREADABLE -> getString(R.string.notes_held_pending_unreadable)
            PendingUnavailable.DISCARD_STOPPED -> getString(R.string.notes_held_pending_discard_stopped)
        })
        // Nothing to show is said only when the changes were read.
        view.findViewById<View>(R.id.held_empty).visibility =
            if (held.rows.isEmpty() && held.pending == null) View.VISIBLE else View.GONE
        // A release withdraws the store's discard permit for every note, so while any row is covered by it, Try
        // again would release those too: it is offered once that discard is finished or gone.
        val covered = held.rows.any { it.discardConfirmed || it.permitUnchecked }
        val container = view.findViewById<LinearLayout>(R.id.held_rows)
        container.removeAllViews()
        val inflater = LayoutInflater.from(view.context)
        for (row in held.rows) container.addView(card(inflater, container, row, offerTryAgain = !covered))
        askAgainFor?.let { uid ->
            askAgainFor = null
            held.rows.firstOrNull { it.noteUid == uid && it.canDiscard }?.let { confirmDiscard(it) }
        }
    }

    private fun card(inflater: LayoutInflater, parent: ViewGroup, row: HeldTextRow, offerTryAgain: Boolean): View {
        val card = inflater.inflate(R.layout.held_text_item, parent, false)
        card.findViewById<TextView>(R.id.held_title).text =
            HeldTextWording.title(row)?.let { getString(it) } ?: row.title?.ifBlank { null } ?: getString(R.string.notes_untitled)
        card.findViewById<TextView>(R.id.held_reason).text = reasonOf(row)
        card.findViewById<TextView>(R.id.held_body).apply {
            text = row.body ?: getString(R.string.notes_held_text_unavailable)
            visibility = if (row.version == null) View.GONE else View.VISIBLE
        }
        card.findViewById<View>(R.id.held_copy).apply {
            visibility = if (row.canCopy) View.VISIBLE else View.GONE
            setOnClickListener { copy(row) }
        }
        card.findViewById<View>(R.id.held_try_again).apply {
            visibility = if (row.canTryAgain && offerTryAgain) View.VISIBLE else View.GONE
            setOnClickListener { button -> tryAgain(row, button) }
        }
        card.findViewById<View>(R.id.held_discard).apply {
            visibility = if (row.canDiscard) View.VISIBLE else View.GONE
            setOnClickListener { confirmDiscard(row) }
        }
        return card
    }

    private fun reasonOf(row: HeldTextRow): String {
        val why = HeldTextWording.reason(row)?.let { getString(it) }
        val where = row.notebookName?.ifBlank { null }?.let { getString(R.string.notes_held_notebook, it) }
        return listOfNotNull(why, where).joinToString(" ")
    }

    private fun copy(row: HeldTextRow) {
        val context = context ?: return
        val body = row.body ?: return
        SensitiveClip.copy(context, getString(R.string.notes_held_clip_label), body)
        // Android 13 and later confirm a copy themselves.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, R.string.notes_held_copied, Toast.LENGTH_SHORT).show()
    }

    /**
     * Try again: releases the held text, and once the release took, asks for one Notes run in the same step off the
     * main thread, so the request is not lost when the screen goes away meanwhile. The button stays disabled until
     * the screen shows the result, so a second tap cannot release again and give a contradictory message.
     */
    private fun tryAgain(row: HeldTextRow, button: View) {
        val host = host() ?: return
        val uid = row.noteUid ?: return
        if (actionRunning) return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val appContext = host.applicationContext
        actionRunning = true
        button.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val outcome = withContext(Dispatchers.IO) {
                    withStore(appContext) { store ->
                        store.release(uid).also { released ->
                            // The user just asked to send it: a user gesture, so the run follows the Sync now network
                            // setting, as pull to refresh does. This is the screen's only request.
                            if (released) NotesSyncCoordinator.request(appContext, account, creationId, NotesSyncPolicy.Trigger.MANUAL)
                        }
                    }
                }
                val current = host() ?: return@launch
                when (outcome) {
                    StoreCall.Stale -> { current.finish(); return@launch }
                    StoreCall.Stopped -> Toast.makeText(current, R.string.notes_held_pending_discard_stopped, Toast.LENGTH_LONG).show()
                    StoreCall.StoreDiscarded -> Toast.makeText(current, R.string.notes_held_store_discarded, Toast.LENGTH_LONG).show()
                    StoreCall.Failed, StoreCall.Unsure -> Toast.makeText(current, R.string.notes_held_failed, Toast.LENGTH_LONG).show()
                    is StoreCall.Done -> Toast.makeText(current,
                        if (outcome.value) R.string.notes_held_try_again_done else R.string.notes_held_try_again_gone, Toast.LENGTH_LONG).show()
                }
                reload()
            } finally {
                actionRunning = false
                // A reload that works replaces the card; one that fails leaves this button, which works again.
                button.isEnabled = true
            }
        }
    }

    /**
     * Asks before a discard, in a dialog the platform brings back after a rotation or a recreation. It carries the
     * note, the version it showed and a digest of the text ([PendingNotesStore.digestOf]); the store checks both, and
     * that no run will send the text, under its lock ([PendingNotesStore.discard]), so a confirmation that outlived
     * the rows it was opened from still deletes only the text it showed. It also carries the token of the app process
     * that made it ([ProcessIncarnation]): an answer from a confirmation Android restored in a new process deletes
     * nothing, and the screen reads the text again and asks again (the maintainer's answer on #709, 2026-10-23).
     */
    private fun confirmDiscard(row: HeldTextRow) {
        val uid = row.noteUid ?: return
        if (actionRunning) return
        val open = childFragmentManager.findFragmentByTag(DISCARD_TAG) as? DiscardConfirmation
        if (open != null && !open.ended) return
        if (childFragmentManager.isStateSaved) return
        DiscardConfirmation().apply {
            arguments = Bundle().apply {
                putString(ARG_NOTE, uid)
                row.version?.let { putLong(ARG_VERSION, it) }
                row.digest?.let { putString(ARG_DIGEST, it) }
                putString(ARG_PROCESS, ProcessIncarnation.current())
            }
        }.show(childFragmentManager, DISCARD_TAG)
    }

    /** The Discard confirmation. Its answer goes to the screen it is shown on, after a recreation too. */
    class DiscardConfirmation : DialogFragment() {
        /** Set once Discard was answered; the platform removes the dialog later, and an ended one is not open. */
        internal var ended = false
            private set

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            val args = requireArguments()
            val uid = requireNotNull(args.getString(ARG_NOTE))
            val shown = if (args.containsKey(ARG_VERSION)) args.getLong(ARG_VERSION) else null
            val digest = args.getString(ARG_DIGEST)
            // The app process that made the dialog; null for a dialog with none, which counts as another process.
            val shownIn = args.getString(ARG_PROCESS)
            return MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.notes_held_discard_title)
                .setMessage(if (shown == null) R.string.notes_held_discard_unreadable_text else R.string.notes_held_discard_text)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.notes_discard) { _, _ ->
                    ended = true
                    (parentFragment as? HeldTextFragment)?.discardNote(uid, shown, digest, shownIn)
                }
                .create()
        }
    }

    private fun discardNote(uid: String, shown: Long?, digest: String?, shownIn: String?) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        // An answer from a confirmation made in another app process goes to no store: read again, then ask again.
        if (!ProcessIncarnation.isCurrent(shownIn)) { askAgainFor = uid; reload(); return }
        val appContext = host.applicationContext
        actionRunning = true
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val outcome = withContext(Dispatchers.IO) { withStore(appContext) { it.discard(uid, shown, digest) } }
                val current = host() ?: return@launch
                val message = when (outcome) {
                    StoreCall.Stale -> { current.finish(); return@launch }
                    StoreCall.Stopped -> R.string.notes_held_pending_discard_stopped
                    StoreCall.StoreDiscarded -> R.string.notes_held_store_discarded
                    // The removal went through, but whether it lasts a power loss could not be made sure of.
                    StoreCall.Unsure -> R.string.notes_held_discard_unsure
                    // The discard did not finish, for example a conflict copy whose original could not be removed.
                    StoreCall.Failed -> R.string.notes_held_discard_failed
                    is StoreCall.Done -> when (outcome.value) {
                        PendingNotesStore.NoteDiscard.Done -> R.string.notes_held_discarded
                        // Not there any more: sent, moved to a copy, or discarded with all unsynced Notes.
                        PendingNotesStore.NoteDiscard.Missing -> R.string.notes_held_discard_missing
                        // Newer text than the confirmation showed: it stays, and the screen shows it to be asked again.
                        is PendingNotesStore.NoteDiscard.Changed -> R.string.notes_held_discard_changed
                        // A run may send it now, for example after its notebook accepts writes again: it stays.
                        is PendingNotesStore.NoteDiscard.MaySync -> R.string.notes_held_discard_may_sync
                    }
                }
                Toast.makeText(current, message, Toast.LENGTH_LONG).show()
                reload()
            } finally {
                actionRunning = false
            }
        }
    }

    private sealed class StoreCall<out T> {
        data class Done<T>(val value: T) : StoreCall<T>()
        object Stale : StoreCall<Nothing>()
        object Failed : StoreCall<Nothing>()

        /** A discard of the whole store stopped and left it closed, while the account stays: the screen stays open. */
        object Stopped : StoreCall<Nothing>()

        /** A discard of the whole store finished first: the text this screen showed is gone, and the reload shows that. */
        object StoreDiscarded : StoreCall<Nothing>()

        /** A removal went through but could not be synced ([PendingNotesStore.RemovalNotSynced]). */
        object Unsure : StoreCall<Nothing>()
    }

    /**
     * [block] on this account generation's store, opened for this call only. Off the main thread. An account
     * generation that is gone closes the screen. A store a discard closed closes it only once the account is gone too:
     * a whole-store discard that stopped leaves the store closed while the account stays, and the screen then says so.
     */
    private fun <T> withStore(appContext: Context, block: (PendingNotesStore) -> T): StoreCall<T> {
        val manager = AccountManager.get(appContext)
        fun current() = ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!current()) return StoreCall.Stale
        var store: PendingNotesStore? = null
        return try {
            StoreCall.Done(block(PendingNotesStore.forIdentity(appContext, account.type, account.name, creationId).also { store = it }))
        } catch (_: PendingNotesStore.Cleared) {
            if (!current()) {
                StoreCall.Stale
            } else if (store?.clearStopped() == true) {
                StoreCall.Stopped
            } else {
                // A discard of the whole store finished: nothing is left here to act on.
                StoreCall.StoreDiscarded
            }
        } catch (_: PendingNotesStore.RemovalNotSynced) {
            if (current()) StoreCall.Unsure else StoreCall.Stale
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.warning("An Unsynced text action did not finish: ${e.javaClass.name}")
            if (current()) StoreCall.Failed else StoreCall.Stale
        }
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTE = "notes.held.discard.note"
        private const val ARG_VERSION = "notes.held.discard.version"
        private const val ARG_DIGEST = "notes.held.discard.digest"
        /** The app process that made the confirmation ([ProcessIncarnation]). Internal for the device case, which writes another. */
        internal const val ARG_PROCESS = "notes.held.discard.process"
        private const val DISCARD_TAG = "notes.held.discard"

        fun newInstance(account: Account, creationId: String) = HeldTextFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
            }
        }
    }
}
