package io.silentsuite.sync.ui.notes

import io.silentsuite.sync.notes.NotesNetworkPolicy
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import java.io.IOException

/**
 * The note editor's rules that need no Android: when it opens, what its status line says, how a save's answer
 * changes it, and which metadata a save writes. The screen and its store calls are [NoteViewFragment] and
 * [NoteEditorViewModel].
 */
internal object NoteEditing {
    /** Stored on the server and read by every client, so in English, like the web's own "Untitled". */
    const val UNTITLED = "Untitled"

    /**
     * Whether the viewer may become an editor for [note]: the note's local text is waiting or there is none, both read
     * here ([NoteSync.SYNCED] or [NoteSync.WAITING] with [NoteContent.pending] unset), the notebook accepts writes, and
     * no discard of the whole store is unfinished, since any save releases what such a discard holds back. Held text,
     * text in a read-only or gone notebook, text a stopped discard covers and text that cannot be read are never edited.
     * The caller checks that the exact account generation is current and has Notes on.
     */
    fun offersEditor(note: NoteContent): Boolean =
        note.writable && !note.discardUnfinished && note.pending == null && (note.sync == NoteSync.SYNCED || note.sync == NoteSync.WAITING)

    /** Whether a notebook offers New note: the same rule for a note that is not there yet. */
    fun offersNewNote(offer: NewNoteOffer): Boolean = offer.writable && !offer.discardUnfinished && offer.pending == null

    /** Why a screen offers no editing, for its banner, or null when it has nothing to say. */
    enum class NoEditing { READ_ONLY, DISCARD_UNFINISHED }

    fun noEditing(writable: Boolean, discardUnfinished: Boolean): NoEditing? = when {
        !writable -> NoEditing.READ_ONLY
        discardUnfinished -> NoEditing.DISCARD_UNFINISHED
        else -> null
    }

    /** The note's local change as the status line sees it. */
    sealed class Local {
        /** No entry: what was saved here has synced. */
        object None : Local()
        data class Waiting(val failures: Int) : Local()
        /** Held, or an entry that cannot be read: the line says nothing more than the save's own answer. */
        object Other : Local()

        companion object {
            fun of(read: PendingNotesStore.Read): Local = when (read) {
                PendingNotesStore.Read.Missing -> None
                is PendingNotesStore.Read.Present ->
                    if (read.entry.state == io.silentsuite.sync.notes.edit.PendingEntry.State.UPSERT) Waiting(read.entry.failureCount) else Other
                is PendingNotesStore.Read.Unreadable -> Other
            }
        }
    }

    /** The second part of the status line, after "Saved on this device". */
    enum class SyncLine {
        /** Nothing to add: the text is saved here and nothing known keeps the next automatic run from sending it. */
        NONE,
        SYNCED,
        /** The automatic setting or the account's Wi-Fi switch waits for Wi-Fi, and Sync now would send it. */
        WAITING_FOR_WIFI_SYNC_NOW_SENDS,
        /** The same, and Sync now waits for Wi-Fi too. */
        WAITING_FOR_WIFI,
        /** A network name saved with the account's Wi-Fi switch refuses every automatic run (#971). */
        BLOCKED_FOR_ACCOUNT,
        /** The last try failed, and the backoff will try again. */
        LAST_TRY_FAILED,
    }

    /**
     * What the status line adds for [local], given the account's network rules and the network the platform reports
     * ([network], null when they could not be read). The network reasons come first, as they decide when a run may go;
     * the save trigger is automatic, so the automatic rules decide ([NotesNetworkPolicy.decide]).
     */
    fun syncLine(local: Local, network: NotesNetworkState?): SyncLine {
        val waiting = when (local) {
            Local.None -> return SyncLine.SYNCED
            Local.Other -> return SyncLine.NONE
            is Local.Waiting -> local
        }
        if (network != null) {
            val automatic = NotesNetworkPolicy.decide(explicit = false, network.settings, network.account, network.reading)
            if (NotesNetworkPolicy.Blocker.ACCOUNT_NETWORK_NAME in automatic.blockers) return SyncLine.BLOCKED_FOR_ACCOUNT
            if (!automatic.run) {
                return if (NotesNetworkPolicy.decide(explicit = true, network.settings, network.account, network.reading).run) {
                    SyncLine.WAITING_FOR_WIFI_SYNC_NOW_SENDS
                } else {
                    SyncLine.WAITING_FOR_WIFI
                }
            }
        }
        return if (waiting.failures > 0) SyncLine.LAST_TRY_FAILED else SyncLine.NONE
    }

    /**
     * The metadata a save writes when [name] and [mtime] go onto an item whose metadata is [raw]: the raw merge, which
     * keeps every other field byte for byte, or a fresh map where there is no metadata at all. Null when the metadata
     * is not empty and cannot be merged (a repeated or aliased key, or not one map): the save keeps it as it is, with
     * the new text, and says the note's details cannot be updated here. A plain push sends that metadata unchanged; after
     * a 409 the push step's rebase holds a change whose metadata gives no readable name
     * ([io.silentsuite.sync.notes.edit.EtebasePushRemote.pendingNameAndMtime]). Never the typed metadata, which keeps
     * only the fields the typed decoder knows.
     */
    fun metadataToWrite(raw: ByteArray?, name: String, mtime: Long): NoteMetaCodec.Merge.Merged? =
        when (val merge = NoteMetaCodec.merge(raw, name, mtime)) {
            is NoteMetaCodec.Merge.Merged -> merge
            is NoteMetaCodec.Merge.Refused -> null
            is NoteMetaCodec.Merge.NotAMap -> if (raw == null || raw.isEmpty()) NoteMetaCodec.fresh(name, mtime) else null
        }

    /** The name a save writes: the title as typed, except that a new note with a blank title is made as "Untitled". */
    fun nameToWrite(title: String, newNote: Boolean): String = if (newNote && title.isBlank()) UNTITLED else title

    /** What a leave the user started needs, once the save it runs first has answered. */
    enum class Leave {
        /** Nothing on screen is unsaved here: the screen leaves. */
        GO,

        /** Text on screen is not saved on this device, and another save may work: the screen asks, with Try again. */
        ASK_TRY_AGAIN,

        /** Text on screen is not saved on this device, and a save would get the same answer: the screen asks, without Try again. */
        ASK,
    }

    /**
     * What leaving needs while the screen shows the editor ([editor]) with text a save has not written ([dirty]), after
     * the editor's last answer [last]. A refusal (too large, an entry that cannot be read, an account removal check that
     * holds the store) and an editor that saves nothing more ([NoteEditorCore.Mode.STOPPED]) get no Try again; a failure,
     * or typing during a save, does.
     */
    fun leave(editor: Boolean, dirty: Boolean, mode: NoteEditorCore.Mode, last: SaveResult?): Leave = when {
        !editor || !dirty -> Leave.GO
        mode == NoteEditorCore.Mode.STOPPED -> Leave.ASK
        last == SaveResult.TooLarge || last == SaveResult.Unreadable || last == SaveResult.RemovalPending -> Leave.ASK
        else -> Leave.ASK_TRY_AGAIN
    }

    /**
     * Whether nothing of the editor's note was ever saved on this device: a new note ([creating]) that no save of this
     * editor wrote ([NoteEditorCore.lastSavedVersion] still 0). Never decided by the note uid, which a new note's first
     * save sets before its write, and keeps when that write fails.
     */
    fun neverSaved(creating: Boolean, lastSavedVersion: Long): Boolean = creating && lastSavedVersion == 0L

    /**
     * Whether an answer to the question before leaving may be acted on: the question was made in this app process
     * ([madeHere]); it was asked over the note [askedNote] at the edit count [askedEdits], and the dialog shows the note
     * [shownNote]; and the editor's text still belongs to that note ([note]), has not changed since ([edits]) and is
     * still not saved on this device ([unsaved]). A new note whose first save has not started has no uid (null).
     */
    fun leaveAnswerHolds(madeHere: Boolean, askedNote: String?, askedEdits: Long, shownNote: String?,
                         note: String?, edits: Long, unsaved: Boolean): Boolean =
        madeHere && unsaved && askedNote == note && shownNote == note && askedEdits == edits
}

/** What one editor save came to, after any redirect to a conflict copy ([SaveRun]). */
internal sealed class SaveResult {
    /** Saved on this device as [version]. [metadataKept]: the note's metadata could not be merged and was kept as it is. */
    data class Saved(val version: Long, val metadataKept: Boolean = false) : SaveResult()
    /** The text joined held text as [version]: the editor becomes the viewer, which points to Unsynced text. */
    data class SavedToHolding(val version: Long) : SaveResult()
    /** Held text that is not this editor's is there; nothing was written. */
    object HeldChanged : SaveResult()
    /** The note's entry on this device cannot be read; nothing was written. */
    object Unreadable : SaveResult()
    object TooLarge : SaveResult()
    /** Nothing was written for now: an I/O failure, or no item to save onto. */
    object NotSaved : SaveResult()
    /**
     * A check for a sign-out or removal of the account holds the store ([SaveOutcome.RemovalPending]): nothing was
     * written, and a save gets the same answer until the check is over.
     */
    object RemovalPending : SaveResult()
    /** A discard of the whole store closed it; nothing was written, and nothing will be. */
    object Cleared : SaveResult()
    /** The note was deleted and the delete waits to be sent; nothing was written, and nothing will be. */
    object Deleted : SaveResult()
    /** The note was moved to another notebook on this device ([SaveOutcome.MovedAway]); nothing was written, and nothing will be. */
    object MovedAway : SaveResult()
    /** The exact account generation is gone: the screen closes. */
    object Stale : SaveResult()
}

/**
 * One editor save through the store's answer: [attempt] builds the draft for the note the editor's handle names now and
 * saves it ([PendingNotesStore.saveLocal]), giving the store's answer and whether the metadata was kept as it was. A
 * conflict copy may have taken the text over ([SaveOutcome.Moved]): the handle then names the copy, so the next attempt
 * goes there, and never to the original. A copy can be replaced in turn, so this goes on, at most [MAX_ATTEMPTS] times.
 */
internal object SaveRun {
    const val MAX_ATTEMPTS = 4

    fun run(attempt: () -> Pair<SaveOutcome, Boolean>): SaveResult {
        repeat(MAX_ATTEMPTS) {
            val (outcome, metadataKept) = try {
                attempt()
            } catch (_: PendingNotesStore.Cleared) {
                return SaveResult.Cleared
            } catch (_: IOException) {
                return SaveResult.NotSaved
            }
            when (outcome) {
                is SaveOutcome.Moved -> Unit
                is SaveOutcome.Saved -> return SaveResult.Saved(outcome.version, metadataKept)
                is SaveOutcome.SavedToHolding -> return SaveResult.SavedToHolding(outcome.version)
                SaveOutcome.HeldChanged -> return SaveResult.HeldChanged
                SaveOutcome.Blocked -> return SaveResult.Unreadable
                SaveOutcome.TooLarge -> return SaveResult.TooLarge
                SaveOutcome.RemovalPending -> return SaveResult.RemovalPending
                SaveOutcome.Deleted -> return SaveResult.Deleted
                SaveOutcome.MovedAway -> return SaveResult.MovedAway
            }
        }
        // Moved every time: the text is not saved yet, and the next save tries again.
        return SaveResult.NotSaved
    }
}

/**
 * The editor's text and what it knows about saving it, in memory only and on one thread (the main one). Versions and
 * sequences here are compared only within this process, so none of them is ever kept in saved state or a file.
 */
internal class NoteEditorCore(private val clock: () -> Long = System::currentTimeMillis) {
    enum class Field { TITLE, BODY }

    /** What the editor does now. */
    enum class Mode {
        EDITING,

        /** The text joined held text: the screen shows the viewer, which points to Unsynced text. */
        HELD,

        /** Nothing more can be saved from here (held text that is not this editor's, or a discarded store): Copy keeps it. */
        STOPPED,
    }

    /** One save's text and the edit it covers. [titleChanged]: the title differs from the one last loaded. */
    class Draft(val edit: Long, val title: String, val body: String, val titleChanged: Boolean = false)

    var title: String = ""
        private set
    var body: String = ""
        private set
    var mode: Mode = Mode.EDITING
        private set

    /** The last save's answer that the status line words, or null before the first save. */
    var lastResult: SaveResult? = null
        private set

    /** The highest version a save of this editor wrote: a load that read the store before it is dropped. */
    var lastSavedVersion: Long = 0
        private set

    private val histories = mapOf(Field.TITLE to EditHistory(), Field.BODY to EditHistory())
    private var loadedTitle = ""
    private var edit = 0L
    private var savedEdit = 0L

    /** Whether there is text a save has not written yet. */
    val dirty: Boolean get() = edit != savedEdit

    /** How many changes the user made here: a question about leaving holds for the text it was asked over only while this stays. */
    val edits: Long get() = edit

    fun history(field: Field): EditHistory = histories.getValue(field)

    fun text(field: Field): String = if (field == Field.TITLE) title else body

    /** Shows [title] and [body] as opened, with no history and nothing to save, for editing. */
    fun opened(title: String, body: String) {
        this.title = title
        this.body = body
        loadedTitle = title
        histories.values.forEach { it.clear() }
        savedEdit = edit
        mode = Mode.EDITING
        lastResult = null
    }

    /** The user replaced [removed] at [start] with [inserted] in [field], which now reads [text]. */
    fun edited(field: Field, start: Int, removed: CharSequence, inserted: CharSequence, text: String) {
        if (mode != Mode.EDITING) return
        history(field).record(start, removed, inserted, clock())
        set(field, text)
        edit++
    }

    /** Undo in [field]: an edit like any other, so the next autosave writes it. */
    fun undo(field: Field): EditHistory.Applied? = apply(field) { history(field).undo(text(field)) }

    fun redo(field: Field): EditHistory.Applied? = apply(field) { history(field).redo(text(field)) }

    private fun apply(field: Field, step: () -> EditHistory.Applied?): EditHistory.Applied? {
        if (mode != Mode.EDITING) return null
        val applied = step() ?: return null
        set(field, applied.text)
        edit++
        return applied
    }

    /**
     * A load of the note, for a clean editor to show: false, and nothing changes, while there is text to save, or when
     * the load read the store before this editor's last save ([observedSequence] below [lastSavedVersion]). Text that
     * differs from what is shown is another version, so both histories are cleared; the same text keeps them.
     */
    fun offerLoad(title: String, body: String, observedSequence: Long): Boolean {
        if (dirty || mode != Mode.EDITING || observedSequence < lastSavedVersion) return false
        if (title != this.title || body != this.body) {
            this.title = title
            this.body = body
            histories.values.forEach { it.clear() }
        }
        loadedTitle = title
        return true
    }

    /**
     * The text to save now, or null when there is none or nothing more is saved from here. After a save joined held
     * text ([Mode.HELD]), what was typed during that save is still saved: it joins the held text as well.
     */
    fun beginSave(): Draft? = if (!dirty || mode == Mode.STOPPED) null else Draft(edit, title, body, title != loadedTitle)

    /**
     * What a save of [draft] came to. Only a save that wrote the text clears the mark of unsaved text, and only up to
     * the edit it covers, so typing during the save is saved next. Every other answer keeps the text on screen.
     */
    fun finishSave(draft: Draft, result: SaveResult) {
        lastResult = result
        when (result) {
            is SaveResult.Saved -> written(draft, result.version)
            is SaveResult.SavedToHolding -> {
                written(draft, result.version)
                mode = Mode.HELD
            }
            SaveResult.HeldChanged, SaveResult.Cleared, SaveResult.Deleted, SaveResult.MovedAway -> mode = Mode.STOPPED
            SaveResult.Unreadable, SaveResult.TooLarge, SaveResult.NotSaved, SaveResult.RemovalPending, SaveResult.Stale -> Unit
        }
    }

    private fun written(draft: Draft, version: Long) {
        if (draft.edit > savedEdit) savedEdit = draft.edit
        if (version > lastSavedVersion) lastSavedVersion = version
    }

    private fun set(field: Field, text: String) {
        if (field == Field.TITLE) title = text else body = text
    }
}
