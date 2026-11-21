package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.app.Dialog
import android.content.DialogInterface
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
import androidx.activity.OnBackPressedCallback
import androidx.core.view.MenuProvider
import androidx.fragment.app.DialogFragment
import androidx.fragment.app.Fragment
import androidx.fragment.app.commit
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import io.silentsuite.sync.R
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.ui.ExactAccountIdentity
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.notes.NoteEditorCore.Field
import io.silentsuite.sync.ui.notes.NoteEditorViewModel.Opened

/**
 * One note: the viewer, shown as plain text, which becomes the editor where the note can be edited
 * ([NoteEditing.offersEditor]). Markdown rendering is a later change. The editor's text and its store calls are in
 * [NoteEditorViewModel]; the fields keep no text in saved instance state. A new note opens with no note uid. Back and Up
 * while the editor's text is not saved on this device save first, and ask before leaving without it ([guardLeave]).
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
    private var menuState: List<Boolean>? = null

    internal var renderedNote: NoteContent? = null
        private set

    /** What the screen last said about a delete; observation point for runtime tests. */
    internal var renderedDeleteMessage: String? = null
        private set

    /** The delete confirmation the screen holds, an ended one included; observation point for runtime tests. */
    internal val deleteConfirmation: NoteDeleteConfirmation?
        get() = childFragmentManager.findFragmentByTag(NoteDeleteConfirmation.TAG) as? NoteDeleteConfirmation

    /** What the screen last said about a move; observation point for runtime tests. */
    internal var renderedMoveMessage: String? = null
        private set

    /** The Move picker the screen holds, an ended one included; observation point for runtime tests. */
    internal val moveConfirmation: NoteMoveConfirmation?
        get() = childFragmentManager.findFragmentByTag(NoteMoveConfirmation.TAG) as? NoteMoveConfirmation

    /** Set once this screen gave way to the moved note, so it does so once. */
    private var leftForMove = false

    /** Whether the editor shows, for runtime tests. */
    internal val editing: Boolean get() = model.opened is Opened.Editor

    internal val editorModel: NoteEditorViewModel get() = model

    /** The question before leaving the screen holds, an ended one included; observation point for runtime tests. */
    internal val leaveConfirmation: LeaveConfirmation?
        get() = childFragmentManager.findFragmentByTag(LEAVE_TAG) as? LeaveConfirmation

    /** The question before leaving while it is open; observation point for runtime tests. */
    internal val leaveDialog: androidx.appcompat.app.AlertDialog?
        get() = leaveConfirmation?.takeIf { !it.ended }?.dialog as? androidx.appcompat.app.AlertDialog

    /** Back while the editor's text is not saved on this device, or while a leave runs or asks: on only then. */
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() {
            if (guardLeave()) return
            // Nothing to ask any more: Back goes on as it would have.
            isEnabled = false
            activity?.onBackPressedDispatcher?.onBackPressed()
        }
    }

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
        requireActivity().onBackPressedDispatcher.addCallback(viewLifecycleOwner, back)
        model.updates.observe(viewLifecycleOwner) { render() }
    }

    override fun onStart() {
        super.onStart()
        NotesSyncCoordinator.addListener(this)
        if (model.opened == null) model.open() else model.reload()
    }

    override fun onResume() {
        super.onResume()
        // A leave whose save answered while the screen's state was saved goes on now.
        settleLeave()
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
            Opened.Deleted -> {
                (model.takeDeleteStep() as? NoteEditorViewModel.DeleteStep.Answered)?.let { deleteAnswered(it.answer) }
                if (!parentFragmentManager.isStateSaved) parentFragmentManager.popBackStack()
                return
            }
            is Opened.Moved -> {
                (model.takeMoveStep() as? NoteEditorViewModel.MoveStep.Answered)?.let { moveAnswered(it) }
                openMoved(opened)
                return
            }
            is Opened.Viewer -> if (host.exactAccountStillCurrent()) renderViewer(view, opened.note) else host.finish()
            is Opened.Editor -> if (host.exactAccountStillCurrent()) renderEditor(view, opened.note) else host.finish()
        }
        refreshMenu()
        // A confirmation is shown only while the screen can still take one; otherwise the step waits for the next render.
        if (!childFragmentManager.isStateSaved) {
            when (val step = model.takeDeleteStep()) {
                is NoteEditorViewModel.DeleteStep.Ask -> confirmDelete(step.shown, discard = false)
                is NoteEditorViewModel.DeleteStep.Answered -> deleteAnswered(step.answer)
                null -> Unit
            }
            when (val step = model.takeMoveStep()) {
                is NoteEditorViewModel.MoveStep.Ask -> confirmMove(step)
                is NoteEditorViewModel.MoveStep.Answered -> moveAnswered(step)
                null -> Unit
            }
        }
        settleLeave()
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
            // No typing while a confirmed delete or move runs: text typed then would not be covered by the confirmation.
            edit.isEnabled = core.mode == NoteEditorCore.Mode.EDITING && !model.deleting && !model.moving
        }
        val result = core.lastResult
        val status = statusText(result, model.syncLine, savedBefore = note?.sync == NoteSync.WAITING)
        view.findViewById<TextView>(R.id.note_status).apply {
            // Set only when it changes, so the live region announces a change and not every save.
            if (text.toString() != status.orEmpty()) text = status
            visibility = if (status == null) View.GONE else View.VISIBLE
        }
        val notSaved = result == SaveResult.NotSaved || result == SaveResult.RemovalPending || result == SaveResult.TooLarge ||
            result == SaveResult.Unreadable || core.mode == NoteEditorCore.Mode.STOPPED
        view.findViewById<View>(R.id.note_copy).visibility = if (notSaved) View.VISIBLE else View.GONE
        view.findViewById<View>(R.id.note_open_unsynced).visibility =
            if (result == SaveResult.HeldChanged || core.mode == NoteEditorCore.Mode.HELD) View.VISIBLE else View.GONE
    }

    /** The status line: why the text was not saved, or that it is saved on this device and then synced or why it waits. */
    private fun statusText(result: SaveResult?, line: NoteEditing.SyncLine?, savedBefore: Boolean): String? {
        val saved = when (result) {
            SaveResult.NotSaved -> return getString(R.string.notes_editor_not_saved)
            SaveResult.RemovalPending -> return getString(R.string.notes_editor_removal_pending)
            SaveResult.TooLarge -> return getString(R.string.notes_editor_too_large)
            SaveResult.Unreadable -> return getString(R.string.notes_editor_unreadable)
            SaveResult.HeldChanged -> return getString(R.string.notes_editor_held_changed)
            SaveResult.Cleared -> return getString(R.string.notes_editor_cleared)
            SaveResult.Deleted -> return getString(R.string.notes_editor_deleted)
            SaveResult.MovedAway -> return getString(R.string.notes_editor_moved)
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

    /** The toolbar is prepared again when Undo, Redo, Delete or Move changes: a new note gets both once its first save made it. */
    private fun refreshMenu() {
        val history = model.core.history(lastField)
        val state = listOf(editingNow() && history.canUndo, editingNow() && history.canRedo,
            model.noteUid != null && editingNow() && !model.deleting && !model.moving)
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
            // Only where the note can be edited, and once it exists: a new note's first save makes it.
            menu.findItem(R.id.note_delete)?.apply {
                isVisible = editor && model.noteUid != null
                isEnabled = editingNow() && !model.deleting && !model.moving
            }
            menu.findItem(R.id.note_move)?.apply {
                isVisible = editor && model.noteUid != null
                isEnabled = editingNow() && !model.deleting && !model.moving
            }
        }

        override fun onMenuItemSelected(menuItem: MenuItem): Boolean = when (menuItem.itemId) {
            R.id.note_undo -> { undo(lastField); true }
            R.id.note_redo -> { redo(lastField); true }
            R.id.note_delete -> { askDelete(); true }
            R.id.note_move -> { askMove(); true }
            else -> false
        }
    }

    // ---- deleting ----

    private fun askDelete() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        model.askDelete()
    }

    /**
     * Asks before a delete, in a dialog the platform brings back after a rotation or a recreation: first whether to
     * delete the note, then, for a note with unsynced text, separately whether to discard that text ([discard]). Each
     * carries what it showed ([NoteEditorViewModel.DeleteShown]), which the store checks under its lock, the exact
     * account it is for, and the token of the app process that made it ([ProcessIncarnation]): an answer from a dialog
     * Android restored in a new process, or one for another account, deletes nothing, and the screen reads the note
     * again and asks again (the maintainer's answer on #709, 2026-10-23).
     */
    private fun confirmDelete(shown: NoteEditorViewModel.DeleteShown, discard: Boolean) {
        if (childFragmentManager.isStateSaved) return
        val open = deleteConfirmation
        if (open != null && !open.ended) return
        NoteDeleteConfirmation.newInstance(shown, discard, ExactAccountIdentity(account.type, account.name, creationId))
            .show(childFragmentManager, NoteDeleteConfirmation.TAG)
    }

    /**
     * An answer to a delete confirmation. One made in another app process, or for another account, goes to no store: the
     * note is read again and the user asked again, where the editor still offers Delete (a note that opens read-only now
     * is not asked about). A delete of a note with unsynced text asks for the discard first.
     */
    internal fun deleteConfirmed(shown: NoteEditorViewModel.DeleteShown, identity: ExactAccountIdentity, shownIn: String?, discard: Boolean) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        if (!ProcessIncarnation.isCurrent(shownIn) || identity != ExactAccountIdentity(account.type, account.name, creationId)) {
            model.askDelete()
            return
        }
        if (shown.unsynced && !discard) confirmDelete(shown, discard = true) else model.delete(shown, discardConfirmed = discard)
    }

    /** What the screen says once a delete, or the read for it, has answered. */
    private fun deleteAnswered(answer: NoteEditorViewModel.DeleteAnswer) {
        val host = host() ?: return
        val message = when (answer) {
            NoteEditorViewModel.DeleteAnswer.STALE -> { host.finish(); return }
            // Nothing of a new note was saved anywhere: the screen just closes.
            NoteEditorViewModel.DeleteAnswer.NOTHING_SAVED -> {
                if (!parentFragmentManager.isStateSaved) parentFragmentManager.popBackStack()
                return
            }
            NoteEditorViewModel.DeleteAnswer.RECORDED -> R.string.notes_delete_recorded
            NoteEditorViewModel.DeleteAnswer.MOVED_AWAY -> R.string.notes_delete_moved_away
            NoteEditorViewModel.DeleteAnswer.DROPPED -> R.string.notes_delete_dropped
            NoteEditorViewModel.DeleteAnswer.UNSURE -> R.string.notes_delete_unsure
            NoteEditorViewModel.DeleteAnswer.CHANGED -> R.string.notes_delete_changed
            NoteEditorViewModel.DeleteAnswer.NOT_SAVED -> R.string.notes_delete_not_saved
            NoteEditorViewModel.DeleteAnswer.HELD -> R.string.notes_delete_held
            NoteEditorViewModel.DeleteAnswer.UNREADABLE -> R.string.notes_delete_unreadable
            NoteEditorViewModel.DeleteAnswer.DISCARD_UNFINISHED -> R.string.notes_delete_discard_unfinished
            NoteEditorViewModel.DeleteAnswer.REMOVAL_PENDING -> R.string.notes_delete_removal_pending
            NoteEditorViewModel.DeleteAnswer.FAILED -> R.string.notes_delete_failed
        }
        renderedDeleteMessage = getString(message)
        Toast.makeText(host, message, Toast.LENGTH_LONG).show()
        // The note as it is now, for a clean editor: what changed since the confirmation was prepared.
        if (answer == NoteEditorViewModel.DeleteAnswer.CHANGED) model.reload()
    }

    // ---- moving ----

    private fun askMove() {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        model.askMove()
    }

    /**
     * Shows the Move picker, in a dialog the platform brings back after a rotation or a recreation. It carries what it
     * showed, the exact account it is for and the token of the app process that made it, as Delete's confirmation does.
     */
    private fun confirmMove(step: NoteEditorViewModel.MoveStep.Ask) {
        if (childFragmentManager.isStateSaved) return
        val open = moveConfirmation
        if (open != null && !open.ended) return
        NoteMoveConfirmation.newInstance(step.shown, step.targets, ExactAccountIdentity(account.type, account.name, creationId))
            .show(childFragmentManager, NoteMoveConfirmation.TAG)
    }

    /**
     * A notebook chosen in the Move picker. One chosen in another app process, or for another account, goes to no store:
     * the note is read again and the user asked again, where the editor still offers Move.
     */
    internal fun moveConfirmed(shown: NoteEditorViewModel.DeleteShown, target: NoteEditorViewModel.MoveTarget,
                               identity: ExactAccountIdentity, shownIn: String?) {
        val host = host() ?: return
        if (!host.exactAccountStillCurrent()) { host.finish(); return }
        if (!ProcessIncarnation.isCurrent(shownIn) || identity != ExactAccountIdentity(account.type, account.name, creationId)) {
            model.askMove()
            return
        }
        model.move(shown, target)
    }

    /** A picker restored without its notebooks asked to choose again. */
    internal fun moveAskedAgain() = askMove()

    /** The notebooks the open picker offers, by uid, from memory; empty in a new process ([NoteEditorViewModel.moveTargets]). */
    internal fun moveTargets(): List<NoteEditorViewModel.MoveTarget> = model.moveTargets

    /** What the screen says once a move, or the read for it, has answered. */
    private fun moveAnswered(step: NoteEditorViewModel.MoveStep.Answered) {
        val host = host() ?: return
        // No notebook name: a toast can be drawn outside the app. The screen opens the moved note in its notebook instead.
        val message = when (step.answer) {
            NoteEditorViewModel.MoveAnswer.STALE -> { host.finish(); return }
            NoteEditorViewModel.MoveAnswer.MOVED -> getString(R.string.notes_move_recorded)
            NoteEditorViewModel.MoveAnswer.UNSURE -> getString(R.string.notes_move_unsure)
            NoteEditorViewModel.MoveAnswer.NOT_MOVED -> getString(R.string.notes_move_failed)
            NoteEditorViewModel.MoveAnswer.MAYBE_BOTH -> getString(R.string.notes_move_maybe_both)
            NoteEditorViewModel.MoveAnswer.CHANGED -> getString(R.string.notes_move_changed)
            NoteEditorViewModel.MoveAnswer.NOT_SAVED -> getString(R.string.notes_move_not_saved)
            NoteEditorViewModel.MoveAnswer.HELD -> getString(R.string.notes_move_held)
            NoteEditorViewModel.MoveAnswer.UNREADABLE -> getString(R.string.notes_move_unreadable)
            NoteEditorViewModel.MoveAnswer.DISCARD_UNFINISHED -> getString(R.string.notes_move_discard_unfinished)
            NoteEditorViewModel.MoveAnswer.REMOVAL_PENDING -> getString(R.string.notes_move_removal_pending)
            NoteEditorViewModel.MoveAnswer.NO_TARGET -> getString(R.string.notes_move_no_target)
            NoteEditorViewModel.MoveAnswer.TARGET_GONE -> getString(R.string.notes_move_target_gone)
            NoteEditorViewModel.MoveAnswer.DELETED -> getString(R.string.notes_move_deleted)
            NoteEditorViewModel.MoveAnswer.MOVED_AWAY -> getString(R.string.notes_move_moved_away)
            NoteEditorViewModel.MoveAnswer.FAILED -> getString(R.string.notes_move_failed)
        }
        renderedMoveMessage = message
        Toast.makeText(host, message, Toast.LENGTH_LONG).show()
        // The note as it is now, for a clean editor: what changed since the picker was prepared.
        if (step.answer == NoteEditorViewModel.MoveAnswer.CHANGED) model.reload()
    }

    /** Gives way to the moved note in its new notebook, as the web's selection follows a moved note. Never after the state was saved. */
    private fun openMoved(moved: Opened.Moved) {
        if (leftForMove || parentFragmentManager.isStateSaved) return
        leftForMove = true
        parentFragmentManager.popBackStack()
        parentFragmentManager.commit {
            replace(R.id.fragment_container, newInstance(account, creationId, moved.notebookUid, moved.noteUid))
            addToBackStack(NoteViewFragment::class.java.name)
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

    // ---- leaving ----

    /**
     * Back or Up, which the user started: true when this screen takes the leave over, because the editor's text is not
     * saved on this device, or a leave already runs or asks. The save runs first; the screen then leaves, or stays and
     * asks ([settleLeave]). A leave the user did not start (the activity finishing for the account) never comes here.
     */
    internal fun guardLeave(): Boolean {
        if (!model.unsaved && !model.leaveRunning && model.leavePrompt == null) return false
        model.requestLeave()
        settleLeave()
        return true
    }

    /**
     * Acts on a leave the user started, once its save answered: leaves, or shows the question before leaving. A question
     * made in another app process, or one the editor no longer asks, goes away first.
     */
    private fun settleLeave() {
        back.isEnabled = model.unsaved || model.leaveRunning || model.leavePrompt != null
        leaveConfirmation?.takeIf { !it.ended }?.let { open ->
            if (!ProcessIncarnation.isCurrent(open.shownIn) || model.leavePrompt == null) open.end()
        }
        if (model.leaveGo) {
            // The leave waits while the state is saved, and goes on once the screen is back ([onResume]).
            if (parentFragmentManager.isStateSaved) return
            model.leaveDone()
            leave()
            return
        }
        val prompt = model.leavePrompt ?: return
        if (leaveConfirmation?.ended == false || childFragmentManager.isStateSaved) return
        LeaveConfirmation().apply {
            arguments = Bundle().apply {
                putString(ARG_PROCESS, ProcessIncarnation.current())
                putString(ARG_LEAVE_NOTE, prompt.noteUid)
                putBoolean(ARG_LEAVE_TRY_AGAIN, prompt.tryAgain)
                putString(ARG_LEAVE_MESSAGE, leaveMessage(prompt))
            }
        }.show(childFragmentManager, LEAVE_TAG)
    }

    /** Leaves the screen as Back or Up would have: this screen is the top of the back stack while the editor shows. */
    private fun leave() {
        back.isEnabled = false
        parentFragmentManager.popBackStack()
    }

    /**
     * What the question before leaving says: that the text is not saved on this device and why, and that it may not be
     * kept after leaving. Never that it is lost: a write that failed after its file was written can still be kept, and the
     * closing editor saves once more.
     */
    private fun leaveMessage(prompt: NoteEditorViewModel.LeavePrompt): String {
        val why = getString(when (prompt.reason) {
            SaveResult.TooLarge -> R.string.notes_editor_leave_why_too_large
            SaveResult.Unreadable -> R.string.notes_editor_leave_why_unreadable
            SaveResult.HeldChanged -> R.string.notes_editor_leave_why_held_changed
            SaveResult.Cleared -> R.string.notes_editor_leave_why_cleared
            SaveResult.RemovalPending -> R.string.notes_editor_leave_why_removal
            SaveResult.Deleted -> R.string.notes_editor_leave_why_deleted
            SaveResult.MovedAway -> R.string.notes_editor_leave_why_moved
            else -> R.string.notes_editor_leave_why_failed
        })
        return getString(if (prompt.newNote) R.string.notes_editor_leave_new_note else R.string.notes_editor_leave_changes, why)
    }

    internal enum class LeaveAnswer { COPY, TRY_AGAIN, LEAVE, CANCEL }

    /**
     * An answer to the question before leaving. Cancel only puts it away. Any other answer is taken only from a question
     * made in this app process, for the note and the text it was asked over ([NoteEditorViewModel.leavePromptAnswered]),
     * while the exact account generation is current; otherwise nothing it answered is done, and the screen asks again
     * while the text is not saved. True when the question stays open, as it does after Copy.
     */
    internal fun leaveAnswered(answer: LeaveAnswer, shownIn: String?, shownNote: String?): Boolean {
        val host = host() ?: return false
        if (!host.exactAccountStillCurrent()) { host.finish(); return false }
        if (answer == LeaveAnswer.CANCEL) {
            model.dropLeavePrompt()
            settleLeave()
            return false
        }
        if (model.leavePromptAnswered(shownIn, shownNote) == null) {
            model.dropLeavePrompt()
            if (model.unsaved) model.requestLeave()
            settleLeave()
            return false
        }
        when (answer) {
            LeaveAnswer.COPY -> {
                copy()
                return true
            }
            LeaveAnswer.TRY_AGAIN -> {
                model.dropLeavePrompt()
                model.requestLeave()
            }
            LeaveAnswer.LEAVE -> {
                // Never left after the state was saved: the question goes, nothing changes, and the user can leave again.
                if (parentFragmentManager.isStateSaved) {
                    model.dropLeavePrompt()
                } else {
                    // The screen's onPause and the closing step still save once more.
                    model.dropLeavePrompt()
                    leave()
                    return false
                }
            }
            LeaveAnswer.CANCEL -> Unit
        }
        settleLeave()
        return false
    }

    /**
     * The question before leaving with text that is not saved on this device, in a dialog the platform brings back after
     * a rotation or a recreation. It carries the token of the app process that made it ([ProcessIncarnation]) and the note
     * uid; its answers go to the screen it is shown on, which checks both, and the text, before acting. Copy keeps it
     * open, so the user can still leave or try again with the text on the clipboard.
     */
    class LeaveConfirmation : DialogFragment() {
        /** Set once answered or put away; the platform removes the dialog later, and an ended one is not open. */
        internal var ended = false
            private set

        /** The app process that made the question; null, a question with none, counts as another process. */
        internal val shownIn: String? get() = arguments?.getString(ARG_PROCESS)

        override fun onCreateDialog(savedInstanceState: Bundle?): Dialog {
            val args = requireArguments()
            val builder = MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.notes_editor_leave_title)
                .setMessage(args.getString(ARG_LEAVE_MESSAGE))
                .setNeutralButton(R.string.notes_held_copy, null)
                .setNegativeButton(R.string.notes_editor_leave_anyway) { _, _ -> answer(LeaveAnswer.LEAVE) }
            if (args.getBoolean(ARG_LEAVE_TRY_AGAIN)) {
                builder.setPositiveButton(R.string.notes_held_try_again) { _, _ -> answer(LeaveAnswer.TRY_AGAIN) }
            } else {
                // A save would get the same answer again: no Try again.
                builder.setPositiveButton(android.R.string.cancel) { _, _ -> answer(LeaveAnswer.CANCEL) }
            }
            return builder.create().apply {
                setOnShowListener {
                    getButton(DialogInterface.BUTTON_NEUTRAL).setOnClickListener { if (!answer(LeaveAnswer.COPY)) dismiss() }
                }
            }
        }

        override fun onCancel(dialog: DialogInterface) {
            answer(LeaveAnswer.CANCEL)
            super.onCancel(dialog)
        }

        /** Puts the question away without an answer. */
        internal fun end() {
            ended = true
            dismissAllowingStateLoss()
        }

        /** True when the question stays open. */
        private fun answer(answer: LeaveAnswer): Boolean {
            if (ended) return false
            val stays = (parentFragment as? NoteViewFragment)?.leaveAnswered(answer, shownIn, arguments?.getString(ARG_LEAVE_NOTE)) == true
            if (!stays) ended = true
            return stays
        }
    }

    companion object {
        private const val ARG_ACCOUNT = "notes.account"
        private const val ARG_CREATION_ID = "notes.creationId"
        private const val ARG_NOTEBOOK_UID = "notes.notebookUid"
        private const val ARG_NOTE_UID = "notes.noteUid"
        /** The app process that made the question before leaving ([ProcessIncarnation]). Internal for the device case, which writes another. */
        internal const val ARG_PROCESS = "notes.leave.process"
        private const val ARG_LEAVE_NOTE = "notes.leave.note"
        private const val ARG_LEAVE_TRY_AGAIN = "notes.leave.tryAgain"
        private const val ARG_LEAVE_MESSAGE = "notes.leave.message"
        private const val LEAVE_TAG = "notes.leave"

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
