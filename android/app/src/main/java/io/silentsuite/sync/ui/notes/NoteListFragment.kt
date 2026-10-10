package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.content.Context
import android.os.Bundle
import android.os.Parcelable
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.lifecycleScope
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.ui.ExactAccountIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Notes of one notebook, newest edit first. Read-only in this version. */
class NoteListFragment : Fragment(), NotesSyncCoordinator.Listener {
    private lateinit var account: Account
    private lateinit var creationId: String
    private lateinit var notebookUid: String
    private var swipe: SwipeRefreshLayout? = null
    private var list: ListView? = null
    // One adapter per view, updated in place, so a reload after each sync keeps the scroll position.
    private var noteAdapter: NoteRowAdapter? = null
    // Scroll position to put back once rows arrive after returning from a note.
    private var listState: Parcelable? = null
    private var loaded = false
    private var everSynced = false
    private var loadJob: Job? = null

    internal var renderedNotes: List<NoteRow> = emptyList()
        private set

    /** What the empty list currently says, or null while rows show; observation point for runtime tests. */
    internal var renderedEmptyState: NotesEmptyState? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
        notebookUid = requireNotNull(requireArguments().getString(ARG_NOTEBOOK_UID))
        listState = savedInstanceState?.getParcelable(STATE_LIST)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_note_list, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        loaded = false
        val rowsAdapter = NoteRowAdapter(requireContext()).also { noteAdapter = it }
        list = view.findViewById<ListView>(R.id.notes_list).apply {
            adapter = rowsAdapter
            setOnItemClickListener { _, _, position, _ ->
                val note = renderedNotes.getOrNull(position) ?: return@setOnItemClickListener
                val host = host() ?: return@setOnItemClickListener
                if (!host.exactAccountStillCurrent()) { host.finish(); return@setOnItemClickListener }
                parentFragmentManager.commit {
                    replace(R.id.fragment_container, NoteViewFragment.newInstance(account, creationId, notebookUid, note.uid))
                    addToBackStack(NoteViewFragment::class.java.name)
                }
            }
        }
        swipe = view.findViewById<SwipeRefreshLayout>(R.id.notes_refresh_layout).apply {
            setColorSchemeResources(R.color.semantic_primary, R.color.semantic_secondary_action, R.color.semantic_success, R.color.semantic_focus)
            setOnRefreshListener {
                val host = host() ?: return@setOnRefreshListener
                if (!host.exactAccountStillCurrent()) { host.finish(); return@setOnRefreshListener }
                NotesSyncCoordinator.request(host.applicationContext, account, creationId, NotesSyncPolicy.Trigger.SCREEN)
                renderSyncState()
            }
            // The direct child is a FrameLayout holding the list and the empty text, so ask the
            // list itself whether it can still scroll up.
            setOnChildScrollUpCallback { _, _ -> list?.canScrollVertically(-1) == true }
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
        noteAdapter = null
        super.onDestroyView()
    }

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        swipe?.isRefreshing = syncing(identity)
        // A run that is not active reloads, and that result, with fresh sync evidence, decides the
        // empty text; rendering it now would flash "not synced" right after a first success.
        if (NotesSyncCoordinator.isActive(identity)) renderEmptyState() else reload()
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun syncing(identity: ExactAccountIdentity) =
        NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity)

    private fun renderSyncState() {
        val identity = host()?.identity() ?: return
        swipe?.isRefreshing = syncing(identity)
        renderEmptyState()
    }

    private fun reload() {
        val host = host() ?: return
        val appContext = host.applicationContext
        // A newer load replaces an older one, so an older result can never render last.
        loadJob?.cancel()
        loadJob = viewLifecycleOwner.lifecycleScope.launch {
            val (result, synced) = withContext(Dispatchers.IO) {
                NotesLoader.notebook(appContext, account, creationId, notebookUid) to NotesLoader.everSynced(appContext, account, creationId)
            }
            val view = view ?: return@launch
            val current = host() ?: return@launch
            everSynced = synced
            when (result) {
                is NotesLoad.Stale -> current.finish()
                is NotesLoad.Failed -> {
                    Toast.makeText(current, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                    // The view scope outlives onStop; never pop after the state was saved.
                    if (!parentFragmentManager.isStateSaved) parentFragmentManager.popBackStack()
                }
                is NotesLoad.Loaded -> if (current.exactAccountStillCurrent()) render(view, result.value) else current.finish()
            }
        }
    }

    private fun render(view: View, contents: NotebookContents) {
        renderedNotes = contents.notes
        loaded = true
        host()?.title = contents.notebook.name.ifBlank { getString(R.string.notes_untitled) }
        view.findViewById<TextView>(R.id.note_list_read_only).apply {
            text = getString(R.string.notes_read_only_hint)
            visibility = View.VISIBLE
        }
        noteAdapter?.apply {
            setNotifyOnChange(false)
            clear()
            addAll(contents.notes)
            notifyDataSetChanged()
        }
        if (contents.notes.isNotEmpty()) listState?.let { state ->
            list?.onRestoreInstanceState(state)
            listState = null
        }
        view.findViewById<TextView>(R.id.notes_unreadable).apply {
            text = resources.getQuantityString(R.plurals.notes_items_unreadable, contents.unreadable, contents.unreadable)
            visibility = if (contents.unreadable > 0) View.VISIBLE else View.GONE
        }
        renderEmptyState()
    }

    private fun renderEmptyState() {
        val view = view ?: return
        val identity = host()?.identity() ?: return
        val empty = loaded && renderedNotes.isEmpty()
        view.findViewById<View>(R.id.notes_empty).visibility = if (empty) View.VISIBLE else View.GONE
        if (!empty) {
            renderedEmptyState = null
            return
        }
        // A failed load leaves this screen, so only the sync states apply here.
        val state = NotesEmptyState.of(syncing(identity), loadFailed = false, everSynced)
        renderedEmptyState = state
        view.findViewById<TextView>(R.id.notes_empty).setText(when (state) {
            NotesEmptyState.SYNCING -> R.string.notes_syncing_notes
            NotesEmptyState.NOT_SYNCED -> R.string.notes_not_synced
            NotesEmptyState.FAILED -> R.string.notes_loading_failed
            NotesEmptyState.EMPTY -> R.string.notes_empty_notes
        })
    }

    private class NoteRowAdapter(context: Context) : ArrayAdapter<NoteRow>(context, R.layout.note_list_item) {
        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(context).inflate(R.layout.note_list_item, parent, false)
            val note = getItem(position)!!
            view.findViewById<TextView>(R.id.note_title).text = note.title.ifBlank { context.getString(R.string.notes_untitled) }
            val preview = view.findViewById<TextView>(R.id.note_preview)
            preview.text = note.preview
            preview.visibility = if (note.preview.isBlank()) View.GONE else View.VISIBLE
            val edited = view.findViewById<TextView>(R.id.note_edited)
            val editedAt = note.editedAt
            if (editedAt == null) {
                edited.visibility = View.GONE
            } else {
                edited.visibility = View.VISIBLE
                edited.text = context.getString(R.string.notes_edited, DateUtils.getRelativeTimeSpanString(
                    editedAt, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE))
            }
            val sync = view.findViewById<TextView>(R.id.note_sync)
            val syncText = syncLabel(context, note.sync)
            sync.text = syncText
            sync.visibility = if (syncText == null) View.GONE else View.VISIBLE
            return view
        }
    }

    companion object {
        /** The marker for a note with a local change, or null when it has none. */
        internal fun syncLabel(context: Context, sync: NoteSync): String? = when (sync) {
            NoteSync.SYNCED -> null
            NoteSync.WAITING -> context.getString(R.string.notes_not_synced_yet)
            NoteSync.LOCAL_UNREADABLE -> context.getString(R.string.notes_local_change_unreadable)
            NoteSync.HELD -> context.getString(R.string.notes_local_text_held)
        }

        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTEBOOK_UID = "notes.notebookUid"
        private const val STATE_LIST = "notes.noteList"

        fun newInstance(account: Account, creationId: String, notebookUid: String) = NoteListFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
                putString(ARG_NOTEBOOK_UID, notebookUid)
            }
        }
    }
}
