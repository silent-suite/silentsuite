package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateUtils
import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.MenuProvider
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.notes.NoteEditorCore.Field
import io.silentsuite.sync.ui.notes.NoteEditorViewModel.Opened

/**
 * One note: the viewer, shown as plain text, which becomes the editor where the note can be edited
 * ([NoteEditing.offersEditor]). Markdown rendering is a later change. The editor's text and its store calls are in
 * [NoteEditorViewModel]; the fields keep no text in saved instance state. A new note opens with no note uid.
 */
class NoteViewFragment : Fragment(), NotesSyncCoordinator.Listener {
    private lateinit var account: Account
    private lateinit var creationId: String
    private lateinit var notebookUid: String
    private lateinit var model: NoteEditorViewModel

    /** The field the toolbar's Undo and Redo act on: the one that has, or last had, focus. */
    private var lastField = Field.BODY
    /** True while the screen itself sets a field's text, which is no edit. */
    private var applying = false
    private var menuState: Pair<Boolean, Boolean>? = null

    internal var renderedNote: NoteContent? = null
        private set

    /** Whether the editor shows, for runtime tests. */
    internal val editing: Boolean get() = model.opened is Opened.Editor

    internal val editorModel: NoteEditorViewModel get() = model

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val args = requireArguments()
        account = requireNotNull(args.getParcelable(ARG_ACCOUNT))
        creationId = requireNotNull(args.getString(ARG_CREATION_ID))
        notebookUid = requireNotNull(args.getString(ARG_NOTEBOOK_UID))
        model = ViewModelProvider(this, NoteEditorViewModel.Factory(requireActivity().application, account, creationId,
            notebookUid, args.getString(ARG_NOTE_UID)))[NoteEditorViewModel::class.java]
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View =
        inflater.inflate(R.layout.fragment_note_view, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        menuState = null
        // A long title wraps onto up to three lines instead of scrolling sideways; it stays one line of input, so
        // Enter still moves to the body.
        editText(view, Field.TITLE).apply {
            setHorizontallyScrolling(false)
            maxLines = 3
        }
        for (field in Field.values()) {
            val edit = editText(view, field)
            edit.addTextChangedListener(Recorder(field))
            edit.setOnFocusChangeListener { _, focused -> if (focused) { lastField = field; refreshMenu() } }
            edit.setOnKeyListener { _, keyCode, event -> shortcut(field, keyCode, event) }
        }
        view.findViewById<View>(R.id.note_copy).setOnClickListener { copy() }
        view.findViewById<View>(R.id.note_open_unsynced).setOnClickListener { openUnsynced() }
        requireActivity().addMenuProvider(toolbar, viewLifecycleOwner, Lifecycle.State.RESUMED)
        model.updates.observe(viewLifecycleOwner) { render() }
    }

    override fun onStart() {
        super.onStart()
        NotesSyncCoordinator.addListener(this)
        if (model.opened == null) model.open() else model.reload()
    }

    override fun onPause() {
        // The pending autosave runs now; the save itself finishes in a step that outlives this screen.
        model.save()
        super.onPause()
    }

    override fun onStop() {
        NotesSyncCoordinator.removeListener(this)
        super.onStop()
    }

    override fun onNotesSyncStateChanged(identity: ExactAccountIdentity) {
        if (identity != host()?.identity()) return
        if (!NotesSyncCoordinator.isActive(identity)) model.syncChanged()
    }

    private fun host(): NotesActivity? = activity as? NotesActivity

    private fun editText(view: View, field: Field): EditText =
        view.findViewById(if (field == Field.TITLE) R.id.note_title_edit else R.id.note_body_edit)

    private fun render() {
        val view = view ?: return
        val host = host() ?: return
        // The arguments carry the note uid only, so a screen made again after the process ended opens the note the
        // text was saved to: a new note's, or a conflict copy's.
        model.noteUid?.let { uid -> if (requireArguments().getString(ARG_NOTE_UID) != uid) requireArguments().putString(ARG_NOTE_UID, uid) }
        when (val opened = model.opened) {
            null -> return
            Opened.Stale -> { host.finish(); return }
            Opened.Failed -> {
                Toast.makeText(host, R.string.notes_loading_failed, Toast.LENGTH_LONG).show()
                // The view scope outlives onStop; never pop after the state was saved.
                if (!parentFragmentManager.isStateSaved) parentFragmentManager.popBackStack()
                return
            }
            is Opened.NoNewNote -> {
                Toast.makeText(host, R.string.notes_new_note_unavailable, Toast.LENGTH_LONG).show()
                if (!parentFragmentManager.isStateSaved) parentFragmentManager.popBackStack()
                return
            }
            is Opened.Viewer -> if (host.exactAccountStillCurrent()) renderViewer(view, opened.note) else host.finish()
            is Opened.Editor -> if (host.exactAccountStillCurrent()) renderEditor(view, opened.note) else host.finish()
        }
        refreshMenu()
    }

    private fun renderViewer(view: View, note: NoteContent) {
        renderedNote = note
        val title = note.title.ifBlank { getString(R.string.notes_untitled) }
        host()?.title = title
        show(view, editor = false)
        view.findViewById<TextView>(R.id.note_title).text = title
        val editedAt = note.editedAt
        view.findViewById<TextView>(R.id.note_meta).text = listOfNotNull(
            editedAt?.let {
                getString(R.string.notes_edited, DateUtils.getRelativeTimeSpanString(
                    it, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_RELATIVE))
            },
            NoteListFragment.syncLabel(requireContext(), note.sync),
            NoteListFragment.pendingNotice(requireContext(), note.pending)?.removeSuffix("."),
        ).joinToString(". ")
        view.findViewById<TextView>(R.id.note_body).text = note.body
        banner(view, NoteListFragment.noEditingText(requireContext(), NoteEditing.noEditing(note.writable, note.discardUnfinished)))
        view.findViewById<View>(R.id.note_open_unsynced).visibility = if (note.sync == NoteSync.HELD) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.note_status).visibility = View.GONE
        view.findViewById<View>(R.id.note_copy).visibility = View.GONE
    }

    private fun renderEditor(view: View, note: NoteContent?) {
        renderedNote = note
        val core = model.core
        host()?.title = core.title.ifBlank { getString(if (note == null && model.noteUid == null) R.string.notes_new_note else R.string.notes_untitled) }
        show(view, editor = true)
        banner(view, null)
        for (field in Field.values()) {
            val edit = editText(view, field)
            val text = core.text(field)
            if (edit.text.toString() != text) set(edit, text, text.length)
            edit.isEnabled = core.mode == NoteEditorCore.Mode.EDITING
        }
        val result = core.lastResult
        val status = statusText(result, model.syncLine, savedBefore = note?.sync == NoteSync.WAITING)
        view.findViewById<TextView>(R.id.note_status).apply {
            // Set only when it changes, so the live region announces a change and not every save.
            if (text.toString() != status.orEmpty()) text = status
            visibility = if (status == null) View.GONE else View.VISIBLE
        }
        val notSaved = result == SaveResult.NotSaved || result == SaveResult.TooLarge || result == SaveResult.Unreadable ||
            core.mode == NoteEditorCore.Mode.STOPPED
        view.findViewById<View>(R.id.note_copy).visibility = if (notSaved) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.note_open_unsynced).visibility =
            if (result == SaveResult.HeldChanged || core.mode == NoteEditorCore.Mode.HELD) View.VISIBLE else View.GONE
    }

    /** The status line: why the text was not saved, or that it is saved on this device and then synced or why it waits. */
    private fun statusText(result: SaveResult?, line: NoteEditing.SyncLine?, savedBefore: Boolean): String? {
        val saved = when (result) {
            SaveResult.NotSaved -> return getString(R.string.notes_editor_not_saved)
            SaveResult.TooLarge -> return getString(R.string.notes_editor_too_large)
            SaveResult.Unreadable -> return getString(R.string.notes_editor_unreadable)
            SaveResult.HeldChanged -> return getString(R.string.notes_editor_held_changed)
            SaveResult.Cleared -> return getString(R.string.notes_editor_cleared)
            SaveResult.Stale -> return null
            is SaveResult.SavedToHolding -> return getString(R.string.notes_local_text_held)
            is SaveResult.Saved -> if (result.metadataKept) getString(R.string.notes_editor_saved_details_kept) else getString(R.string.notes_editor_saved)
            null -> if (savedBefore) getString(R.string.notes_editor_saved) else null
        }
        if (line == NoteEditing.SyncLine.SYNCED) return if (saved != null) getString(R.string.notes_editor_synced) else null
        saved ?: return null
        val reason = when (line) {
            NoteEditing.SyncLine.WAITING_FOR_WIFI_SYNC_NOW_SENDS -> getString(R.string.notes_editor_waiting_wifi_sync_now)
            NoteEditing.SyncLine.WAITING_FOR_WIFI -> getString(R.string.notes_editor_waiting_wifi)
            NoteEditing.SyncLine.BLOCKED_FOR_ACCOUNT -> getString(R.string.notes_editor_waiting_blocked)
            NoteEditing.SyncLine.LAST_TRY_FAILED -> getString(R.string.notes_editor_waiting_retry)
            NoteEditing.SyncLine.NONE, NoteEditing.SyncLine.SYNCED, null -> null
        }
        return if (reason == null) saved else "${saved.removeSuffix(".")}. $reason"
    }

    private fun show(view: View, editor: Boolean) {
        val viewer = if (editor) View.GONE else View.VISIBLE
        for (id in listOf(R.id.note_title, R.id.note_meta, R.id.note_body)) view.findViewById<View>(id).visibility = viewer
        for (field in Field.values()) editText(view, field).visibility = if (editor) View.VISIBLE else View.GONE
    }

    private fun banner(view: View, text: String?) {
        view.findViewById<TextView>(R.id.note_banner).apply {
            this.text = text
            visibility = if (text == null) View.GONE else View.VISIBLE
        }
    }

    private fun set(edit: EditText, text: String, cursor: Int) {
        applying = true
        try {
            edit.setText(text)
            edit.setSelection(cursor.coerceIn(0, text.length))
        } finally {
            applying = false
        }
    }

    /** Feeds the user's changes in one field to the editor; changes the screen makes itself are not edits. */
    private inner class Recorder(private val field: Field) : TextWatcher {
        private var removed: CharSequence = ""

        override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) {
            if (!applying) removed = s.subSequence(start, start + count).toString()
        }

        override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
            if (applying) return
            model.edited(field, start, removed, s.subSequence(start, start + count).toString(), s.toString())
            if (field == Field.TITLE) host()?.title = s.toString().ifBlank { getString(R.string.notes_untitled) }
            refreshMenu()
        }

        override fun afterTextChanged(s: Editable) = Unit
    }

    private fun undo(field: Field) = applyStep(field, model.undo(field))

    private fun redo(field: Field) = applyStep(field, model.redo(field))

    private fun applyStep(field: Field, applied: EditHistory.Applied?) {
        val view = view ?: return
        if (applied != null) set(editText(view, field), applied.text, applied.cursor)
        refreshMenu()
    }

    /** Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y on a hardware keyboard, in place of the field's own undo. */
    private fun shortcut(field: Field, keyCode: Int, event: KeyEvent): Boolean {
        if (!event.isCtrlPressed || (keyCode != KeyEvent.KEYCODE_Z && keyCode != KeyEvent.KEYCODE_Y)) return false
        if (event.action == KeyEvent.ACTION_DOWN && editingNow()) {
            if (keyCode == KeyEvent.KEYCODE_Y || event.isShiftPressed) redo(field) else undo(field)
        }
        return true
    }

    private fun editingNow() = model.opened is Opened.Editor && model.core.mode == NoteEditorCore.Mode.EDITING

    private fun refreshMenu() {
        val state = model.core.history(lastField).let { (editingNow() && it.canUndo) to (editingNow() && it.canRedo) }
        if (state == menuState) return
        menuState = state
        activity?.invalidateOptionsMenu()
    }

    private val toolbar = object : MenuProvider {
        override fun onCreateMenu(menu: Menu, menuInflater: MenuInflater) {
            menuInflater.inflate(R.menu.note_editor_actions, menu)
        }

        override fun onPrepareMenu(menu: Menu) {
            val editor = model.opened is Opened.Editor
            val history = model.core.history(lastField)
            menu.findItem(R.id.note_undo)?.apply {
                isVisible = editor
                isEnabled = editingNow() && history.canUndo
            }
            menu.findItem(R.id.note_redo)?.apply {
                isVisible = editor
                isEnabled = editingNow() && history.canRedo
            }
        }

        override fun onMenuItemSelected(menuItem: MenuItem): Boolean = when (menuItem.itemId) {
            R.id.note_undo -> { undo(lastField); true }
            R.id.note_redo -> { redo(lastField); true }
            else -> false
        }
    }

    private fun copy() {
        val context = context ?: return
        val core = model.core
        val text = listOf(core.title, core.body).filter { it.isNotEmpty() }.joinToString("\n\n")
        SensitiveClip.copy(context, getString(R.string.notes_held_clip_label), text)
        Toast.makeText(context, R.string.notes_held_copied, Toast.LENGTH_SHORT).show()
    }

    private fun openUnsynced() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        if (parentFragmentManager.isStateSaved) return
        parentFragmentManager.commit {
            replace(R.id.fragment_container, HeldTextFragment.newInstance(account, creationId))
            addToBackStack(HeldTextFragment::class.java.name)
        }
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTEBOOK_UID = "notes.notebookUid"
        private const val ARG_NOTE_UID = "notes.noteUid"

        /** The note [noteUid], or a new note in [notebookUid] when it is null. */
        fun newInstance(account: Account, creationId: String, notebookUid: String, noteUid: String?) = NoteViewFragment().apply {
            arguments = Bundle().apply {
                putParcelable(ARG_ACCOUNT, account)
                putString(ARG_CREATION_ID, creationId)
                putString(ARG_NOTEBOOK_UID, notebookUid)
                putString(ARG_NOTE_UID, noteUid)
            }
        }
    }
}
