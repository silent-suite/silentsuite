package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.os.Bundle
import android.os.Parcelable
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import io.silentsuite.sync.R
import io.silentsuite.sync.model.CollectionInfo
import io.silentsuite.sync.notes.NoteDeleteNotices
import io.silentsuite.sync.notes.NotesNetworkPolicy
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.Constants
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Notebooks of the exact account. Tap opens the notes; touch and hold manages the notebook. */
class NotebookListFragment : Fragment(), NotesSyncCoordinator.Listener {
    private lateinit var account: Account
    private lateinit var creationId: String
    private var swipe: SwipeRefreshLayout? = null
    private var list: ListView? = null
    // One adapter per view, updated in place, so a reload after each sync keeps the scroll position.
    private var notebookAdapter: AccountActivity.CollectionListAdapter? = null
    // Scroll position to put back once rows arrive after returning to this screen.
    private var listState: Parcelable? = null
    // What the network line is decided on, from the last load that passed the account check.
    private var network: NotesNetworkState? = null
    private var loaded = false
    private var lastLoadFailed = false
    private var everSynced = false
    private var loadJob: Job? = null

    /** Last rendered rows; process-only observation point for runtime tests. */
    internal var renderedNotebooks: List<NotebookRow> = emptyList()
        private set

    /** What the empty list currently says, or null while rows show; observation point for runtime tests. */
    internal var renderedEmptyState: NotesEmptyState? = null
        private set

    /** What the Unsynced text row counts as last rendered; observation point for runtime tests. */
    internal var renderedUnsyncedText: Int = 0
        private set

    /** The notice about deletes that were not done, as last rendered, empty while none shows; observation point for runtime tests. */
    internal var renderedDeleteNotice: Map<NotePushPolicy.DeleteNotDone, Int> = emptyMap()
        private set

    /** Whether the Unsynced text row last said the local changes could not be read; observation point for runtime tests. */
    internal var renderedPendingUnreadable: Boolean = false
        private set

    /** Whether the Unsynced text row last said a discard of the local changes did not finish; observation point for runtime tests. */
    internal var renderedDiscardStopped: Boolean = false
        private set

    /** The sentences of the network line as last rendered, empty while no line shows; observation point for runtime tests. */
    internal var renderedNetworkNotice: List<NotesNetworkPolicy.NoticePart> = emptyList()
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
        listState = savedInstanceState?.getParcelable(STATE_LIST)
        setHasOptionsMenu(true)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_notebook_list, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val host = requireActivity() as NotesActivity
        host.title = getString(R.string.notes_title)
        loaded = false
        val rowsAdapter = AccountActivity.CollectionListAdapter(requireContext(), account).also { notebookAdapter = it }
        list = view.findViewById<ListView>(R.id.notebooks_list).apply {
            adapter = rowsAdapter
            setOnItemClickListener { _, _, position, _ ->
                val row = renderedNotebooks.getOrNull(position) ?: return@setOnItemClickListener
                if (!host.exactAccountStillCurrent()) { host.finish(); return@setOnItemClickListener }
                parentFragmentManager.commit {
                    replace(R.id.fragment_container, NoteListFragment.newInstance(account, creationId, row.uid))
                    addToBackStack(NoteListFragment::class.java.name)
                }
            }
            setOnItemLongClickListener { _, _, position, _ ->
                val row = renderedNotebooks.getOrNull(position) ?: return@setOnItemLongClickListener false
                openNotebookSettings(row.uid)
                true
            }
        }
        swipe = view.findViewById<SwipeRefreshLayout>(R.id.notebooks_refresh).apply {
            setColorSchemeResources(R.color.semantic_primary, R.color.semantic_secondary_action, R.color.semantic_success, R.color.semantic_focus)
            setOnRefreshListener { requestSync() }
            // The direct child is a FrameLayout holding the list and the empty state, so ask the
            // list itself whether it can still scroll up.
            setOnChildScrollUpCallback { _, _ -> list?.canScrollVertically(-1) == true }
        }
        view.findViewById<View>(R.id.notebooks_create).setOnClickListener { createNotebook() }
        view.findViewById<View>(R.id.notebooks_unsynced).setOnClickListener { openUnsyncedNotes() }
        // Takes away what the notice showed, in the next load's off-thread step.
        view.findViewById<View>(R.id.notebooks_delete_notice_dismiss).setOnClickListener {
            renderedDeleteNotice.takeIf { it.isNotEmpty() }?.let { reload(dismiss = it) }
        }
    }

    override fun onStart() {
        super.onStart()
        NotesSyncCoordinator.addListener(this)
        reload()
        renderSyncState()
    }

    override fun onStop() {
        NotesSyncCoordinator.removeListener(this)
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        // A position still waiting for rows wins over the live list, which is empty until they arrive.
        (listState ?: list?.onSaveInstanceState())?.let { outState.putParcelable(STATE_LIST, it) }
    }

    override fun onDestroyView() {
        // Only a view that goes away needs its position kept; while it lives, updating the adapter
        // in place already keeps it.
        if (listState == null && loaded) list?.let { listState = it.onSaveInstanceState() }
        list = null
        swipe = null
        notebookAdapter = null
        super.onDestroyView()
    }

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        swipe?.isRefreshing = syncing(identity)
        // A run that is not active reloads, and that result, with fresh sync evidence, decides the
        // empty text; rendering it now would flash "not synced" right after a first success.
        if (NotesSyncCoordinator.isActive(identity)) renderEmptyState() else reload()
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        super.onCreateOptionsMenu(menu, inflater)
        inflater.inflate(R.menu.notes_notebooks_actions, menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.notes_refresh -> { requestSync(); true }
        R.id.create_notebook -> { createNotebook(); true }
        else -> super.onOptionsItemSelected(item)
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun requestSync() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        NotesSyncCoordinator.request(host.applicationContext, account, creationId, NotesSyncPolicy.Trigger.SCREEN)
        renderSyncState()
    }

    private fun syncing(identity: ExactAccountIdentity) =
        NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity)

    private fun renderSyncState() {
        val identity = host()?.identity() ?: return
        swipe?.isRefreshing = syncing(identity)
        renderEmptyState()
    }

    private fun createNotebook() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val intent = CollectionActivity.newCreateCollectionIntent(host, account, creationId, Constants.ETEBASE_TYPE_NOTES)
        notebookRouteLauncherOverride?.invoke(intent) ?: startActivity(intent)
    }

    /** The account's Unsynced text: the local text the notebook rows do not show. */
    private fun openUnsyncedNotes() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        parentFragmentManager.commit {
            replace(R.id.fragment_container, HeldTextFragment.newInstance(account, creationId))
            addToBackStack(HeldTextFragment::class.java.name)
        }
    }

    private fun openNotebookSettings(uid: String) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val intent = CollectionActivity.newIntent(host, account, creationId, uid)
        notebookRouteLauncherOverride?.invoke(intent) ?: startActivity(intent)
    }

    /** One load's reads, made off the main thread. */
    private class ListLoad(
        val rows: NotesLoad<NotebookOverview>,
        val synced: Boolean,
        val seen: NotesNetworkState?,
        val deleteNotice: Map<NotePushPolicy.DeleteNotDone, Int>?,
    )

    /** Loads the list; [dismiss] is the delete notice the user dismissed, taken away first ([NoteDeleteNotices.dismiss]). */
    private fun reload(dismiss: Map<NotePushPolicy.DeleteNotDone, Int>? = null) {
        val host = host() ?: return
        val appContext = host.applicationContext
        // A newer load replaces an older one, so an older result can never render last.
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            val load = withContext(Dispatchers.IO) {
                val rows = NotesLoader.notebooks(appContext, account, creationId)
                // The network settings are read by account name, so only after a load that found the
                // exact generation. The delete notice is keyed by the exact generation, and read after that too.
                val notices = NoteDeleteNotices.of(appContext)
                val identity = ExactAccountIdentity(account.type, account.name, creationId)
                ListLoad(rows, NotesLoader.everSynced(appContext, account, creationId),
                    if (rows is NotesLoad.Loaded) NotesLoader.network(appContext, account) else null,
                    if (rows is NotesLoad.Loaded) notices.run { dismiss?.let { dismiss(identity, it) }; read(identity) } else null)
            }
            val result = load.rows
            val synced = load.synced
            val seen = load.seen
            view ?: return@launch
            val current = host() ?: return@launch
            everSynced = synced
            when (result) {
                is NotesLoad.Stale -> current.finish()
                is NotesLoad.Failed -> {
                    // A failure repeats on every sync notification until it clears; say it once.
                    if (!lastLoadFailed) Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                    lastLoadFailed = true
                    // Nothing was read this time; keep the rows and the last known way to unsynced text.
                    render(NotebookOverview(renderedNotebooks, renderedUnsyncedText, pendingUnreadable = renderedPendingUnreadable,
                        discardStopped = renderedDiscardStopped))
                }
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) {
                    // The network was read by account name, so it is kept only here, for the generation
                    // checked on the line above. A failed load renders with what the last load kept.
                    network = seen
                    // The notebooks could not be read but the local changes were (design 3.5): still a
                    // failure to report once, and the rows already shown stay.
                    val overview = result.value
                    if (overview.failed && !lastLoadFailed) {
                        Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                    }
                    lastLoadFailed = overview.failed
                    render(if (overview.failed) NotesOverlay.keptAfterFailure(renderedNotebooks, overview) else overview)
                    load.deleteNotice?.let(::renderDeleteNotice)
                } else current.finish()
            }
        }
    }

    private fun render(overview: NotebookOverview) {
        val rows = overview.notebooks
        renderedNotebooks = rows
        renderedUnsyncedText = overview.unsyncedText
        renderedPendingUnreadable = overview.pendingUnreadable
        renderedDiscardStopped = overview.discardStopped
        loaded = true
        notebookAdapter?.apply {
            setNotifyOnChange(false)
            clear()
            addAll(rows.map {
                AccountActivity.CollectionListItemInfo(it.uid, CollectionInfo.Type.NOTES, it.name, describe(it),
                    it.color, it.readOnly, isAdmin = !it.shared)
            })
            notifyDataSetChanged()
        }
        if (rows.isNotEmpty()) listState?.let { state ->
            list?.onRestoreInstanceState(state)
            listState = null
        }
        // Held text and changes whose notebook is gone or read-only are counted here, so they stay
        // findable even with no notebook left. A store that could not be read, or whose discard stopped, says
        // so here, never that there is nothing. The row opens the account's Unsynced text.
        view?.findViewById<TextView>(R.id.notebooks_unsynced)?.apply {
            text = when {
                overview.discardStopped -> getString(R.string.notes_unsynced_discard_stopped)
                overview.pendingUnreadable -> getString(R.string.notes_unsynced_unreadable)
                else -> getString(R.string.notes_unsynced_text, overview.unsyncedText)
            }
            visibility = if (overview.unsyncedText > 0 || overview.pendingUnreadable || overview.discardStopped) View.VISIBLE else View.GONE
        }
        renderNetworkNotice(rows.sumOf { it.waiting })
        renderEmptyState()
    }

    /**
     * Notes the user deleted that a Notes run did not delete, and notes the user moved whose move a run did not finish,
     * one sentence per reason, until the user dismisses them.
     * A load that could not read the list keeps the notice as it was.
     */
    private fun renderDeleteNotice(notice: Map<NotePushPolicy.DeleteNotDone, Int>) {
        renderedDeleteNotice = notice
        val view = view ?: return
        view.findViewById<TextView>(R.id.notebooks_delete_notice_text).text = notice.entries.joinToString(" ") { (reason, n) ->
            resources.getQuantityString(when (reason) {
                NotePushPolicy.DeleteNotDone.CHANGED_ELSEWHERE -> R.plurals.notes_deletes_not_done_changed
                NotePushPolicy.DeleteNotDone.READ_ONLY -> R.plurals.notes_deletes_not_done_read_only
                NotePushPolicy.DeleteNotDone.REJECTED -> R.plurals.notes_deletes_not_done_rejected
                NotePushPolicy.DeleteNotDone.NOT_BUILT -> R.plurals.notes_deletes_not_done_not_built
                NotePushPolicy.DeleteNotDone.MOVED_CHANGED_ELSEWHERE -> R.plurals.notes_moves_not_done_changed
                NotePushPolicy.DeleteNotDone.MOVED_ORIGINAL_KEPT -> R.plurals.notes_moves_not_done_kept
                NotePushPolicy.DeleteNotDone.MOVE_NOT_DONE -> R.plurals.notes_moves_not_done
                NotePushPolicy.DeleteNotDone.MOVED_COPY_DELETED -> R.plurals.notes_moves_not_done_copy_deleted
                NotePushPolicy.DeleteNotDone.MOVE_NOT_DONE_DELETE_SENT -> R.plurals.notes_moves_not_done_delete_sent
                NotePushPolicy.DeleteNotDone.MOVED_ORIGINAL_KEPT_DELETE_SENT -> R.plurals.notes_moves_not_done_kept_delete_sent
                NotePushPolicy.DeleteNotDone.MOVE_NOT_DONE_TEXT_HELD -> R.plurals.notes_moves_not_done_text_held
                NotePushPolicy.DeleteNotDone.MOVE_NOT_DONE_TEXT_HELD_DELETE_SENT -> R.plurals.notes_moves_not_done_text_held_delete_sent
            }, n, n)
        }
        view.findViewById<View>(R.id.notebooks_delete_notice).visibility = if (notice.isEmpty()) View.GONE else View.VISIBLE
    }

    /**
     * The notebook's description, after its count of waiting changes when there are any. The count goes
     * first because the row shows at most two lines of description.
     */
    private fun describe(row: NotebookRow): String {
        if (row.waiting == 0) return row.description
        val waiting = resources.getQuantityString(R.plurals.notes_waiting_changes, row.waiting, row.waiting)
        return if (row.description.isBlank()) waiting else "$waiting\n${row.description}"
    }

    /**
     * The line that says Notes do not sync by themselves on the network the device reports, and
     * what pulling down would do (answer 5 of 2026-10-12 on #709). It is decided again on every
     * reload and at no other time: nothing here listens for network changes, so it can be out of
     * date while the screen stays open. Without a reading there is no line. [waiting] is the sum of
     * the rows' counts, so it leaves out what the Unsynced text row counts.
     */
    private fun renderNetworkNotice(waiting: Int) {
        val parts = network?.let { NotesNetworkPolicy.notice(waiting, it.settings, it.account, it.reading) }.orEmpty()
        renderedNetworkNotice = parts
        val line = view?.findViewById<TextView>(R.id.notebooks_network_notice) ?: return
        line.visibility = if (parts.isEmpty()) View.GONE else View.VISIBLE
        line.text = parts.joinToString(" ") { noticeText(it, waiting) }
    }

    private fun noticeText(part: NotesNetworkPolicy.NoticePart, waiting: Int): String = when (part) {
        NotesNetworkPolicy.NoticePart.CHANGES_WAITING ->
            resources.getQuantityString(R.plurals.notes_network_changes_waiting, waiting, waiting)
        NotesNetworkPolicy.NoticePart.MAY_BE_OUT_OF_DATE -> getString(R.string.notes_network_may_be_out_of_date)
        NotesNetworkPolicy.NoticePart.NOTES_SETTING -> getString(R.string.notes_network_notes_setting)
        NotesNetworkPolicy.NoticePart.ACCOUNT_WIFI_ONLY -> getString(R.string.notes_network_account_wifi_only)
        NotesNetworkPolicy.NoticePart.NO_WIFI_REPORTED -> getString(R.string.notes_network_no_wifi_reported)
        NotesNetworkPolicy.NoticePart.ACCOUNT_NETWORK_NAME -> getString(R.string.notes_network_account_network_name)
        NotesNetworkPolicy.NoticePart.TRY_NOW -> getString(R.string.notes_network_try_now)
        NotesNetworkPolicy.NoticePart.SYNC_NOW_NEEDS_WIFI -> getString(R.string.notes_network_sync_now_needs_wifi)
    }

    private fun renderEmptyState() {
        val view = view ?: return
        val identity = host()?.identity() ?: return
        val empty = loaded && renderedNotebooks.isEmpty()
        view.findViewById<View>(R.id.notebooks_hint).visibility = if (renderedNotebooks.isEmpty()) View.GONE else View.VISIBLE
        view.findViewById<View>(R.id.notebooks_empty).visibility = if (empty) View.VISIBLE else View.GONE
        if (!empty) {
            renderedEmptyState = null
            return
        }
        val state = NotesEmptyState.of(syncing(identity), lastLoadFailed, everSynced)
        renderedEmptyState = state
        view.findViewById<TextView>(R.id.notebooks_empty_text).setText(when (state) {
            NotesEmptyState.SYNCING -> R.string.notes_syncing_notebooks
            NotesEmptyState.NOT_SYNCED -> R.string.notes_not_synced
            NotesEmptyState.FAILED -> R.string.notes_loading_failed
            NotesEmptyState.EMPTY -> R.string.notes_empty_notebooks
        })
        // Offer to create a notebook only once a sync has shown there really are none.
        view.findViewById<View>(R.id.notebooks_create).visibility =
            if (state == NotesEmptyState.EMPTY) View.VISIBLE else View.GONE
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val STATE_LIST = "notes.notebookList"

        /** No-network instrumentation seam for notebook routes; production leaves this null. */
        @Volatile internal var notebookRouteLauncherOverride: ((android.content.Intent) -> Unit)? = null

        fun newInstance(account: Account, creationId: String) = NotebookListFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
            }
        }
    }
}
