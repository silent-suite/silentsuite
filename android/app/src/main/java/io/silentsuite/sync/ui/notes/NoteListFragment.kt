package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.content.Context
import android.os.Bundle
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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Notes of one notebook, newest edit first. Read-only in this version. */
class NoteListFragment : Fragment(), NotesSyncCoordinator.Listener {
    private lateinit var account: Account
    private lateinit var creationId: String
    private lateinit var notebookUid: String
    private var swipe: SwipeRefreshLayout? = null

    internal var renderedNotes: List<NoteRow> = emptyList()
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
        notebookUid = requireNotNull(requireArguments().getString(ARG_NOTEBOOK_UID))
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_note_list, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        swipe = view.findViewById<SwipeRefreshLayout>(R.id.notes_refresh_layout).apply {
            setColorSchemeResources(R.color.semantic_primary, R.color.semantic_secondary_action, R.color.semantic_success, R.color.semantic_focus)
            setOnRefreshListener {
                val host = host() ?: return@setOnRefreshListener
                if (!host.exactAccountStillCurrent()) { host.finish(); return@setOnRefreshListener }
                NotesSyncCoordinator.request(host.applicationContext, account, creationId, NotesSyncPolicy.Trigger.SCREEN)
                renderSyncState()
            }
        }
        view.findViewById<ListView>(R.id.notes_list).setOnItemClickListener { _, _, position, _ ->
            val note = renderedNotes.getOrNull(position) ?: return@setOnItemClickListener
            val host = host() ?: return@setOnItemClickListener
            if (!host.exactAccountStillCurrent()) { host.finish(); return@setOnItemClickListener }
            parentFragmentManager.commit {
                replace(R.id.fragment_container, NoteViewFragment.newInstance(account, creationId, notebookUid, note.uid))
                addToBackStack(NoteViewFragment::class.java.name)
            }
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

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        renderSyncState()
        if (!NotesSyncCoordinator.isActive(identity)) reload()
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun renderSyncState() {
        val identity = host()?.identity() ?: return
        swipe?.isRefreshing = NotesSyncCoordinator.isActive(identity) || NotesSyncCoordinator.isPending(identity)
    }

    private fun reload() {
        val host = host() ?: return
        val appContext = host.applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { NotesLoader.notebook(appContext, account, creationId, notebookUid) }
            val view = view ?: return@launch
            val current = host() ?: return@launch
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
        host()?.title = contents.notebook.name.ifBlank { getString(R.string.notes_untitled) }
        view.findViewById<TextView>(R.id.note_list_read_only).apply {
            text = getString(R.string.notes_read_only_hint)
            visibility = View.VISIBLE
        }
        view.findViewById<ListView>(R.id.notes_list).adapter = NoteRowAdapter(requireContext(), contents.notes)
        view.findViewById<View>(R.id.notes_empty).visibility = if (contents.notes.isEmpty()) View.VISIBLE else View.GONE
    }

    private class NoteRowAdapter(context: Context, notes: List<NoteRow>) : ArrayAdapter<NoteRow>(context, R.layout.note_list_item, notes) {
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
            return view
        }
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTEBOOK_UID = "notes.notebookUid"

        fun newInstance(account: Account, creationId: String, notebookUid: String) = NoteListFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
                putString(ARG_NOTEBOOK_UID, notebookUid)
            }
        }
    }
}
