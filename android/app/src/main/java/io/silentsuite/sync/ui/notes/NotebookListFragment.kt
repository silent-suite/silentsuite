package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.os.Bundle
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.ListView
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

    /** Last rendered rows; process-only observation point for runtime tests. */
    internal var renderedNotebooks: List<NotebookRow> = emptyList()
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
        setHasOptionsMenu(true)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_notebook_list, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val host = requireActivity() as NotesActivity
        host.title = getString(R.string.notes_title)
        swipe = view.findViewById<SwipeRefreshLayout>(R.id.notebooks_refresh).apply {
            setColorSchemeResources(R.color.semantic_primary, R.color.semantic_secondary_action, R.color.semantic_success, R.color.semantic_focus)
            setOnRefreshListener { requestSync() }
        }
        list = view.findViewById<ListView>(R.id.notebooks_list).apply {
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

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        renderSyncState()
        if (!NotesSyncCoordinator.isActive(identity)) reload()
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

    private fun renderSyncState() {
        val identity = host()?.identity() ?: return
        swipe?.isRefreshing = NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity)
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
            val result = withContext(Dispatchers.IO) { NotesLoader.notebooks(appContext, account, creationId) }
            val view = view ?: return@launch
            val current = host() ?: return@launch
            when (result) {
                is NotesLoad.Stale -> current.finish()
                is NotesLoad.Failed -> {
                    Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                    render(view, emptyList())
                }
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) render(view, result.value) else current.finish()
            }
        }
    }

    private fun render(view: View, rows: List<NotebookRow>) {
        renderedNotebooks = rows
        val adapter = AccountActivity.CollectionListAdapter(requireContext(), account)
        adapter.addAll(rows.map {
            AccountActivity.CollectionListItemInfo(it.uid, CollectionInfo.Type.NOTES, it.name, it.description,
                it.color, it.readOnly, isAdmin = !it.shared)
        })
        list?.adapter = adapter
        val empty = rows.isEmpty()
        view.findViewById<View>(R.id.notebooks_empty).visibility = if (empty) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.notebooks_refresh).visibility = if (empty) View.GONE else View.VISIBLE
        view.findViewById<View>(R.id.notebooks_hint).visibility = if (empty) View.GONE else View.VISIBLE
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"

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
