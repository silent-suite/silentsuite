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
import io.silentsuite.sync.notes.edit.HeldReason
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.ui.ExactAccountIdentity
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

    /** The rows as last rendered, null before the first load; observation point for runtime tests. */
    internal var renderedRows: List<HeldTextRow>? = null
        private set

    /** The Discard confirmation while it is open; observation point for runtime tests. */
    internal val discardDialog: androidx.appcompat.app.AlertDialog?
        get() = (childFragmentManager.findFragmentByTag(DISCARD_TAG) as? DiscardConfirmation)?.dialog as? androidx.appcompat.app.AlertDialog

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
                // The rows already shown stay; nothing on them is acted on without a store check.
                is NotesLoad.Failed -> Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) render(view, result.value) else current.finish()
            }
        }
    }

    private fun render(view: View, held: HeldTexts) {
        renderedRows = held.rows
        renderedPending = held.pending
        view.findViewById<View>(R.id.held_notebooks_failed).visibility = if (held.notebooksFailed) View.VISIBLE else View.GONE
        view.findViewById<TextView>(R.id.held_pending).apply {
            val notice = NoteListFragment.pendingNotice(view.context, held.pending)
            text = notice
            visibility = if (notice == null) View.GONE else View.VISIBLE
        }
        // Nothing to show is said only when the changes were read.
        view.findViewById<View>(R.id.held_empty).visibility =
            if (held.rows.isEmpty() && held.pending == null) View.VISIBLE else View.GONE
        val container = view.findViewById<LinearLayout>(R.id.held_rows)
        container.removeAllViews()
        val inflater = LayoutInflater.from(view.context)
        for (row in held.rows) container.addView(card(inflater, container, row))
    }

    private fun card(inflater: LayoutInflater, parent: ViewGroup, row: HeldTextRow): View {
        val card = inflater.inflate(R.layout.held_text_item, parent, false)
        val readable = row.body != null
        card.findViewById<TextView>(R.id.held_title).text = when {
            row.version == null -> getString(R.string.notes_held_unreadable)
            else -> row.title?.ifBlank { null } ?: getString(R.string.notes_untitled)
        }
        card.findViewById<TextView>(R.id.held_reason).text = reasonOf(row)
        card.findViewById<TextView>(R.id.held_body).apply {
            text = row.body ?: getString(R.string.notes_held_text_unavailable)
            visibility = if (row.version == null) View.GONE else View.VISIBLE
        }
        card.findViewById<View>(R.id.held_copy).apply {
            visibility = if (readable) View.VISIBLE else View.GONE
            setOnClickListener { copy(row) }
        }
        card.findViewById<View>(R.id.held_try_again).apply {
            visibility = if (row.canTryAgain) View.VISIBLE else View.GONE
            setOnClickListener { tryAgain(row) }
        }
        card.findViewById<View>(R.id.held_discard).apply {
            visibility = if (row.canDiscard) View.VISIBLE else View.GONE
            setOnClickListener { confirmDiscard(row) }
        }
        return card
    }

    private fun reasonOf(row: HeldTextRow): String {
        val why = when {
            row.version == null && !row.canDiscard -> getString(R.string.notes_held_unreadable_whole_store)
            row.version == null -> null
            row.discardConfirmed -> getString(R.string.notes_held_discard_confirmed)
            row.mayStillSync -> getString(if (row.body != null) R.string.notes_held_may_still_sync else R.string.notes_held_may_still_sync_unreadable)
            row.held == null -> getString(R.string.notes_held_not_writable)
            else -> getString(reasonText(row.held))
        }
        val where = row.notebookName?.ifBlank { null }?.let { getString(R.string.notes_held_notebook, it) }
        return listOfNotNull(why, where).joinToString(" ")
    }

    private fun reasonText(reason: HeldReason): Int = when (reason) {
        HeldReason.READ_ONLY -> R.string.notes_held_reason_read_only
        HeldReason.LOST_ACCESS -> R.string.notes_held_reason_lost_access
        HeldReason.NOTEBOOK_DELETED -> R.string.notes_held_reason_notebook_deleted
        HeldReason.REJECTED -> R.string.notes_held_reason_rejected
        HeldReason.REPEATED_CONFLICT -> R.string.notes_held_reason_repeated_conflict
        HeldReason.UNREADABLE_METADATA -> R.string.notes_held_reason_unreadable_metadata
        HeldReason.READ_BACK_FAILED -> R.string.notes_held_reason_read_back_failed
        HeldReason.NOT_BUILT -> R.string.notes_held_reason_not_built
    }

    private fun copy(row: HeldTextRow) {
        val context = context ?: return
        val body = row.body ?: return
        SensitiveClip.copy(context, getString(R.string.notes_held_clip_label), body)
        // Android 13 and later confirm a copy themselves.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) Toast.makeText(context, R.string.notes_held_copied, Toast.LENGTH_SHORT).show()
    }

    private fun tryAgain(row: HeldTextRow) {
        val host = host() ?: return
        val uid = row.noteUid ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val appContext = host.applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) { withStore(appContext) { it.release(uid) } }
            val current = host() ?: return@launch
            when (outcome) {
                StoreCall.Stale -> { current.finish(); return@launch }
                StoreCall.Stopped -> Toast.makeText(current, R.string.notes_pending_discard_stopped, Toast.LENGTH_LONG).show()
                StoreCall.StoreDiscarded -> Toast.makeText(current, R.string.notes_held_store_discarded, Toast.LENGTH_LONG).show()
                StoreCall.Failed -> Toast.makeText(current, R.string.notes_held_failed, Toast.LENGTH_LONG).show()
                is StoreCall.Done -> if (outcome.value) {
                    if (!current.exactAccountStillCurrent()) { current.finish(); return@launch }
                    // The user just asked to send it: a user gesture, so the run follows the Sync now network
                    // setting, as pull to refresh does. This is the screen's only request.
                    NotesSyncCoordinator.request(appContext, account, creationId, NotesSyncPolicy.Trigger.MANUAL)
                    Toast.makeText(current, R.string.notes_held_try_again_done, Toast.LENGTH_LONG).show()
                } else {
                    Toast.makeText(current, R.string.notes_held_try_again_gone, Toast.LENGTH_LONG).show()
                }
            }
            reload()
        }
    }

    /**
     * Asks before a discard, in a dialog the platform brings back after a rotation or a recreation. It carries the
     * note and the version it showed, and the discard is checked against that version ([PendingNotesStore.discard]),
     * so a confirmation that outlived the rows it was opened from still deletes only the text it showed.
     */
    private fun confirmDiscard(row: HeldTextRow) {
        val uid = row.noteUid ?: return
        val open = childFragmentManager.findFragmentByTag(DISCARD_TAG) as? DiscardConfirmation
        if (open != null && !open.ended) return
        if (childFragmentManager.isStateSaved) return
        DiscardConfirmation().apply {
            arguments = Bundle().apply {
                putString(ARG_NOTE, uid)
                row.version?.let { putLong(ARG_VERSION, it) }
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
            return MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.notes_held_discard_title)
                .setMessage(if (shown == null) R.string.notes_held_discard_unreadable_text else R.string.notes_held_discard_text)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.notes_discard) { _, _ ->
                    ended = true
                    (parentFragment as? HeldTextFragment)?.discardNote(uid, shown)
                }
                .create()
        }
    }

    private fun discardNote(uid: String, shown: Long?) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val appContext = host.applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) {
                // The confirmation can outlive the rows it was opened from (it survives a recreation), and a notebook
                // can accept writes again meanwhile: text a run may now send is not discarded. A newer version of the
                // text is the store's own check (Changed below).
                when (val now = NotesLoader.heldText(appContext, account, creationId)) {
                    NotesLoad.Stale -> StoreCall.Stale
                    NotesLoad.Failed -> StoreCall.Failed
                    is NotesLoad.Loaded -> {
                        val row = now.value.rows.firstOrNull { it.noteUid == uid }
                        when {
                            row?.canDiscard == true -> withStore(appContext) { it.discard(uid, shown) }
                            row != null -> null
                            // Not listed any more: sent, moved to a copy, or now waiting on its notebook's row, where a
                            // run sends it. Only the first two are gone; text that is still there is not discarded.
                            else -> when (val read = withStore(appContext) { it.read(uid) }) {
                                is StoreCall.Done ->
                                    if (read.value == PendingNotesStore.Read.Missing) StoreCall.Done(PendingNotesStore.NoteDiscard.Missing) else null
                                StoreCall.Stale -> StoreCall.Stale
                                StoreCall.Failed -> StoreCall.Failed
                                StoreCall.Stopped -> StoreCall.Stopped
                                StoreCall.StoreDiscarded -> StoreCall.StoreDiscarded
                            }
                        }
                    }
                }
            }
            val current = host() ?: return@launch
            when (outcome) {
                null -> Toast.makeText(current, R.string.notes_held_discard_not_offered, Toast.LENGTH_LONG).show()
                StoreCall.Stale -> { current.finish(); return@launch }
                StoreCall.Stopped -> Toast.makeText(current, R.string.notes_pending_discard_stopped, Toast.LENGTH_LONG).show()
                StoreCall.StoreDiscarded -> Toast.makeText(current, R.string.notes_held_store_discarded, Toast.LENGTH_LONG).show()
                // The discard did not finish, for example a conflict copy whose original could not be removed. The
                // text is still here; the reload shows what is left.
                StoreCall.Failed -> Toast.makeText(current, R.string.notes_held_discard_failed, Toast.LENGTH_LONG).show()
                is StoreCall.Done -> when (outcome.value) {
                    PendingNotesStore.NoteDiscard.Done ->
                        Toast.makeText(current, R.string.notes_held_discarded, Toast.LENGTH_SHORT).show()
                    // Gone before the tap: sent by a run, or moved to a conflict copy. Nothing was deleted here.
                    PendingNotesStore.NoteDiscard.Missing ->
                        Toast.makeText(current, R.string.notes_held_discard_missing, Toast.LENGTH_LONG).show()
                    // Newer text than the confirmation showed: it stays, and the screen shows it to be asked again.
                    is PendingNotesStore.NoteDiscard.Changed ->
                        Toast.makeText(current, R.string.notes_held_discard_changed, Toast.LENGTH_LONG).show()
                    // A run may send it now: it stays.
                    is PendingNotesStore.NoteDiscard.MaySync ->
                        Toast.makeText(current, R.string.notes_held_discard_not_offered, Toast.LENGTH_LONG).show()
                }
            }
            reload()
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
        private const val DISCARD_TAG = "notes.held.discard"

        fun newInstance(account: Account, creationId: String) = HeldTextFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
            }
        }
    }
}
