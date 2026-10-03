package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.os.Bundle
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import io.silentsuite.sync.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One note, shown as plain text. Markdown rendering is a later slice. */
class NoteViewFragment : Fragment() {
    private lateinit var account: Account
    private lateinit var creationId: String
    private lateinit var notebookUid: String
    private lateinit var noteUid: String

    internal var renderedNote: NoteContent? = null
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        account = requireNotNull(requireArguments().getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(requireArguments().getString(ARG_CREATION_ID))
        notebookUid = requireNotNull(requireArguments().getString(ARG_NOTEBOOK_UID))
        noteUid = requireNotNull(requireArguments().getString(ARG_NOTE_UID))
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_note_view, container, false)

    override fun onStart() {
        super.onStart()
        reload()
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun reload() {
        val host = host() ?: return
        val appContext = host.applicationContext
        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { NotesLoader.note(appContext, account, creationId, notebookUid, noteUid) }
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

    private fun render(view: View, note: NoteContent) {
        renderedNote = note
        val title = note.title.ifBlank { getString(R.string.notes_untitled) }
        host()?.title = title
        view.findViewById<TextView>(R.id.note_title).text = title
        val meta = view.findViewById<TextView>(R.id.note_meta)
        val editedAt = note.editedAt
        meta.text = listOfNotNull(
            editedAt?.let {
                getString(R.string.notes_edited, DateUtils.getRelativeTimeSpanString(
                    it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE))
            },
            getString(R.string.notes_read_only_hint),
        ).joinToString(". ")
        view.findViewById<TextView>(R.id.note_body).text = note.body
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTEBOOK_UID = "notes.notebookUid"
        private const val ARG_NOTE_UID = "notes.noteUid"

        fun newInstance(account: Account, creationId: String, notebookUid: String, noteUid: String) = NoteViewFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
                putString(ARG_NOTEBOOK_UID, notebookUid)
                putString(ARG_NOTE_UID, noteUid)
            }
        }
    }
}
