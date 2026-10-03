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
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.ui.AccountActivity
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.Constants
import kotlinx.coroutines.Dispatchers
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
    private var loaded = false
    private var lastLoadFailed = false
    private var everSynced = false

    /** Last rendered rows; process-only observation point for runtime tests. */
    internal var renderedNotebooks: List<NotebookRow> = emptyList()
        private set

    /** What the empty list currently says, or null while rows show; observation point for runtime tests. */
    internal var renderedEmptyState: NotesEmptyState? = null
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

    private fun openNotebookSettings(uid: String) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        val intent = CollectionActivity.newIntent(host, account, creationId, uid)
        notebookRouteLauncherOverride?.invoke(intent) ?: startActivity(intent)
    }

    private fun reload() {
        val host = host() ?: return
        val appContext = host.applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            val (result, synced) = withContext(Dispatchers.IO) {
                NotesLoader.notebooks(appContext, account, creationId) to NotesLoader.everSynced(appContext, account, creationId)
            }
            view ?: return@launch
            val current = host() ?: return@launch
            everSynced = synced
            when (result) {
                is NotesLoad.Stale -> current.finish()
                is NotesLoad.Failed -> {
                    // A failure repeats on every sync notification until it clears; say it once.
                    if (!lastLoadFailed) Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                    lastLoadFailed = true
                    // Keep whatever was already shown rather than blanking the list.
                    render(renderedNotebooks)
                }
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) {
                    lastLoadFailed = false
                    render(result.value)
                } else current.finish()
            }
        }
    }

    private fun render(rows: List<NotebookRow>) {
        renderedNotebooks = rows
        loaded = true
        notebookAdapter?.apply {
            setNotifyOnChange(false)
            clear()
            addAll(rows.map {
                AccountActivity.CollectionListItemInfo(it.uid, CollectionInfo.Type.NOTES, it.name, it.description,
                    it.color, it.readOnly, isAdmin = !it.shared)
            })
            notifyDataSetChanged()
        }
        if (rows.isNotEmpty()) listState?.let { state ->
            list?.onRestoreInstanceState(state)
            listState = null
        }
        renderEmptyState()
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
