package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.app.Application
import android.content.Context
import androidx.annotation.VisibleForTesting
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.etebase.client.CollectionManager
import com.etebase.client.ItemManager
import com.etebase.client.ItemMetadata
import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.CollectionAccessLevel
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.NotesSyncPolicy
import io.silentsuite.sync.notes.edit.EtebasePushRemote
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.notes.edit.NotePushStep
import io.silentsuite.sync.notes.edit.PendingEntry
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.PendingNotesStore.SaveOutcome
import io.silentsuite.sync.ui.ProcessIncarnation
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * The note editor (design 3.2): its text ([core], on the main thread) and every call it makes to the pending store,
 * all inside `withContext(Dispatchers.IO)`. The store calls are [PendingNotesStore.forIdentity], [PendingNotesStore.observe]
 * (through [NotesLoader.note] and for the status line), [PendingNotesStore.editorOpened], the reads a save builds on
 * ([PendingNotesStore.read], [PendingNotesStore.landed], [PendingNotesStore.notebook]), [PendingNotesStore.saveLocal]
 * through the editor's handle, [PendingNotesStore.deleteNote] for the user's confirmed delete ([askDelete], [delete]),
 * [PendingNotesStore.moveNote] for the user's move to another notebook ([askMove], [move]), and
 * [PendingNotesStore.editorClosed]. Nothing here releases, discards, holds or sends.
 *
 * Opening, saving, deleting and closing run one at a time, as steps in a scope of the app's ([background]), not this
 * ViewModel's: closing the editor clears the ViewModel, and that must not stop its last save or the sync request after
 * it. A save that wrote the text asks for a Notes run ([NotesSyncPolicy.Trigger.SAVE], which follows the automatic
 * network setting) in the same step, about [SYNC_DELAY_MILLIS] after the last save, and at once when the editor
 * closes; a delete that recorded a pending delete asks at once. A leave the user starts while the text is not saved on
 * this device saves first, and asks before leaving without it ([requestLeave]).
 *
 * The blob is encrypted and its metadata merged before the store is called, and no store call is made while holding
 * the Etebase cache monitor. Versions and sequences stay in memory: none goes into saved state or a file.
 */
internal class NoteEditorViewModel(
    application: Application,
    private val account: Account,
    private val creationId: String,
    private val notebookUid: String,
    openedUid: String?,
) : AndroidViewModel(application) {
    private val app: Context get() = getApplication()

    /** The editor's text. Main thread only. */
    val core = NoteEditorCore()

    /** The note the editor's text belongs to now: the one opened, a new note once its first save made it, or a conflict copy. Main thread. */
    var noteUid: String? = openedUid
        private set

    /** What opening found, or null while it runs. Main thread. */
    var opened: Opened? = null
        private set

    /** The second part of the status line, from the last read of the note's entry. Main thread. */
    var syncLine: NoteEditing.SyncLine? = null
        private set

    /** Pinged on the main thread whenever anything above changed, for the screen to render. */
    val updates = MutableLiveData<Unit>()

    /** What only the steps touch, under [steps], off the main thread. */
    private val session = Session()
    private val steps = Mutex()
    private var autosave: Job? = null
    private var cleared = false
    /** Opening runs once: a second start while the first is still loading would show its text over typing. */
    private var openStarted = false
    /** This editor was opened for a new note, which its first save makes. */
    private val creating = openedUid == null

    sealed class Opened {
        /** The exact account generation is gone: the screen closes. */
        object Stale : Opened()
        object Failed : Opened()
        /** No editor over this note: the viewer shows [note]. */
        data class Viewer(val note: NoteContent) : Opened()
        /** A new note cannot be made here now ([NoteEditing.offersNewNote]). */
        data class NoNewNote(val offer: NewNoteOffer?) : Opened()
        /** The editor shows [core]'s text. [note] is the load it opened on, or null for a new note. */
        data class Editor(val note: NoteContent?) : Opened()
        /** The user deleted the note here ([delete]): nothing more is saved or loaded, and the screen closes. */
        object Deleted : Opened()
        /**
         * The user moved the note here ([move]) to note [noteUid] in notebook [notebookUid]: nothing more is saved or loaded,
         * and the screen opens the moved note in its place.
         */
        data class Moved(val noteUid: String, val notebookUid: String) : Opened()
    }

    /** Set on the main thread from a confirmed delete until its answer: the fields take no typing, and nothing is saved. */
    var deleting = false
        private set

    /** What a delete asks of the screen, for the screen to take once ([takeDeleteStep]). Main thread. */
    var deleteStep: DeleteStep? = null
        private set

    sealed class DeleteStep {
        /** Ask whether to delete [shown]; the separate discard follows when it has unsynced text. */
        data class Ask(val shown: DeleteShown) : DeleteStep()
        /** What the delete, or the read for it, came to. */
        data class Answered(val answer: DeleteAnswer) : DeleteStep()
    }

    /**
     * What a delete's confirmation shows and is checked against: the note, and the version and digest of its entry
     * ([PendingNotesStore.deleteNote] compares them), or, when it has none, [revision], the revision of the item the
     * editor showed (its landed record or the item it opened on), which [deleteOnIo] compares with the item it marks
     * deleted, so a load that brought another device's newer copy in meanwhile deletes nothing. [neverSynced] chooses
     * the wording only: the store decides again whether the note reached the server. A move's picker shows and checks the
     * same ([MoveStep.Ask]), since a move deletes the original.
     */
    data class DeleteShown(val noteUid: String, val version: Long?, val digest: String?, val neverSynced: Boolean,
                           val revision: String? = null) {
        /** Whether the note has text on this device that has not synced, whose discard the user confirms separately. */
        val unsynced: Boolean get() = version != null
    }

    enum class DeleteAnswer {
        /** A pending delete was written; a run sends it. */
        RECORDED,
        /** The note never reached the server and is gone from this device. */
        DROPPED,
        /** Removed from this device, but the removal may not last a power loss ([PendingNotesStore.RemovalNotSynced]). */
        UNSURE,
        /** A new note with nothing saved: nothing to delete, and the screen closes. */
        NOTHING_SAVED,
        /** The note was moved to another notebook on this device (another editor's move): nothing was deleted here. */
        MOVED_AWAY,
        /** Text typed or changed since the confirmation was prepared: nothing was deleted. */
        CHANGED,
        /** The editor has text that was not saved: nothing was deleted. */
        NOT_SAVED,
        HELD,
        UNREADABLE,
        DISCARD_UNFINISHED,
        REMOVAL_PENDING,
        FAILED,
        STALE,
    }

    /** The delete step for the screen to act on, once. Main thread. */
    fun takeDeleteStep(): DeleteStep? = deleteStep.also { deleteStep = null }

    private class Session {
        var store: PendingNotesStore? = null
        var handle: PendingNotesStore.EditorHandle? = null
        /** The item the editor opened on, for a save when the note has neither an entry nor a landed record. */
        var pinned: ByteArray? = null
        var pinnedUid: String? = null
        /** The note whose name the title field was loaded from. A save into a conflict copy keeps the copy's name. */
        var titleUid: String? = null
        /**
         * The revision of the note's landed record when the item was pinned. The pin is at least as new as that record
         * (a run writes the cache before it drops an entry), so a save builds on the landed record only once a newer
         * upload landed since.
         */
        var landedAtPin: String? = null
        var newNote = false
        var savedAny = false
        var request: Job? = null
        var closed = false
    }

    // ---- opening ----

    /** Opens the editor, or finds that the viewer stays. Runs once per ViewModel; later loads go through [reload]. */
    fun open() {
        if (opened != null || openStarted) return
        openStarted = true
        background.launch {
            steps.withLock {
                val uid = noteUid
                val opening = withContext(Dispatchers.IO) { if (uid == null) openNewNote() else openNote(uid) }
                withContext(Dispatchers.Main) { applyOpening(opening, first = true) }
                refreshStatusStep()
            }
        }
    }

    /**
     * A load for a clean editor, after a Notes run or when the screen comes back: the editor opens again on the note
     * as it is now, and takes it only while it is still clean and the load is not older than its last save; otherwise
     * nothing changes. A viewer loads again too.
     */
    fun reload() {
        if (cleared || gone()) return
        background.launch {
            steps.withLock {
                val shown = withContext(Dispatchers.Main) {
                    noteUid.takeIf { opened is Opened.Viewer || opened is Opened.Editor && core.mode == NoteEditorCore.Mode.EDITING && !core.dirty }
                }
                    ?: return@withLock refreshStatusStep()
                // A run may have given the editor's text a conflict copy since its last save: the handle names the note
                // the text is in now, so the editor opens on that note and never on the original's server text.
                val uid = withContext(Dispatchers.IO) { session.handle?.noteUid } ?: shown
                val opening = withContext(Dispatchers.IO) { openNote(uid) }
                withContext(Dispatchers.Main) {
                    noteUid = uid
                    applyOpening(opening, first = false)
                }
                refreshStatusStep()
            }
        }
    }

    private sealed class Opening {
        object Stale : Opening()
        object Failed : Opening()
        class Viewer(val note: NoteContent) : Opening()
        class NoNewNote(val offer: NewNoteOffer?) : Opening()
        object NewNote : Opening()
        class Editor(val note: NoteContent, val store: PendingNotesStore, val handle: PendingNotesStore.EditorHandle,
                     val pinned: ByteArray, val landedAtPin: String?, val title: String, val body: String) : Opening()
    }

    private fun openNewNote(): Opening = when (val load = NotesLoader.newNote(app, account, creationId, notebookUid)) {
        NotesLoad.Stale -> Opening.Stale
        NotesLoad.Failed -> Opening.NoNewNote(null)
        is NotesLoad.Loaded -> if (NoteEditing.offersNewNote(load.value)) Opening.NewNote else Opening.NoNewNote(load.value)
    }

    /**
     * Loads [uid] ([NotesLoader.note]) and, where the editor is offered, opens a handle with the load's entry version
     * as its base and pins the item the load showed: the entry, or the cached item when there is none. When the store
     * changed between the load and the handle (a push dropped the entry, say), the handle closes and the load runs
     * again, at most [OPEN_ATTEMPTS] times; after that the viewer shows the note this time.
     */
    private fun openNote(uid: String): Opening {
        var last: NoteContent? = null
        repeat(OPEN_ATTEMPTS) {
            val note = when (val load = NotesLoader.note(app, account, creationId, notebookUid, uid)) {
                NotesLoad.Stale -> return Opening.Stale
                NotesLoad.Failed -> return Opening.Failed
                is NotesLoad.Loaded -> load.value
            }
            last = note
            if (!NoteEditing.offersEditor(note)) return Opening.Viewer(note)
            try {
                val store = PendingNotesStore.forIdentity(app, account.type, account.name, creationId)
                val handle = store.editorOpened(uid, note.pendingVersion)
                val pinned = try {
                    pin(store, uid, note)
                } catch (e: Exception) {
                    store.editorClosed(handle)
                    throw e
                }
                if (!current()) {
                    store.editorClosed(handle)
                    return Opening.Stale
                }
                if (pinned != null) return Opening.Editor(note, store, handle, pinned.blob, pinned.landedAtPin, pinned.title, pinned.body)
                store.editorClosed(handle)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                // The class only: a binding's message can quote a decrypted value. No editor this time.
                Logger.log.warning("The note editor could not open: ${e.javaClass.name}")
                return Opening.Viewer(note)
            }
        }
        return last?.let { Opening.Viewer(it) } ?: Opening.Failed
    }

    private class Pinned(val blob: ByteArray, val landedAtPin: String?, val title: String, val body: String)

    /** The item [note] showed, or null when the store or the cache no longer has it as shown. */
    private fun pin(store: PendingNotesStore, uid: String, note: NoteContent): Pinned? {
        // Read before the cache, so a record that lands after it is newer than the pin.
        val landed = store.landed(uid)?.revision
        val read = store.read(uid)
        val shown = note.pendingVersion
        val blob = if (shown != null) {
            val entry = (read as? PendingNotesStore.Read.Present)?.entry ?: return null
            if (entry.version != shown || entry.state != PendingEntry.State.UPSERT || entry.notebookUid != notebookUid) return null
            entry.blob
        } else {
            if (read != PendingNotesStore.Read.Missing) return null
            cachedItem(uid) ?: return null
        }
        val itemMgr = notebook(store.notebook(notebookUid)).itemMgr
        val item = itemMgr.cacheLoad(blob)
        // The title as stored, untrimmed, so a save of the body alone writes the same name back.
        return Pinned(blob, landed, NoteMetaCodec.peek(item.metaRaw)?.name.orEmpty(), item.contentString)
    }

    private fun applyOpening(opening: Opening, first: Boolean) {
        // A load that waited behind a delete or a move opens nothing over it.
        if (cleared || gone()) {
            // The screen went away meanwhile: a handle this opened is closed by the close step, or here if that ran.
            if (opening is Opening.Editor) keep(opening)
            return
        }
        when (opening) {
            Opening.Stale -> opened = Opened.Stale
            Opening.Failed -> if (first) opened = Opened.Failed
            is Opening.NoNewNote -> opened = Opened.NoNewNote(opening.offer)
            Opening.NewNote -> {
                core.opened("", "")
                opened = Opened.Editor(null)
            }
            is Opening.Viewer -> if (first || !core.dirty) {
                if (!first) drop()
                opened = Opened.Viewer(opening.note)
            }
            // A viewer becomes the editor once the note can be edited again: Try again sent held text back, say.
            is Opening.Editor -> if (first || opened is Opened.Viewer && !core.dirty) {
                core.opened(opening.title, opening.body)
                keep(opening)
                opened = Opened.Editor(opening.note)
            } else if (core.offerLoad(opening.title, opening.body, opening.note.observedSequence)) {
                keep(opening)
                opened = Opened.Editor(opening.note)
            } else {
                closeLater(opening.store, opening.handle)
            }
        }
        updates.value = Unit
    }

    /** The session takes [opening]'s handle and item, and the handle it had closes. */
    private fun keep(opening: Opening.Editor) {
        if (session.closed) {
            closeLater(opening.store, opening.handle)
            return
        }
        val previous = session.store?.let { store -> session.handle?.let { store to it } }
        session.store = opening.store
        session.handle = opening.handle
        session.pinned = opening.pinned
        session.pinnedUid = opening.note.uid
        session.titleUid = opening.note.uid
        session.landedAtPin = opening.landedAtPin
        session.newNote = false
        previous?.let { (store, handle) -> if (handle !== opening.handle) closeLater(store, handle) }
    }

    /** The editor gave way to the viewer: its handle closes. */
    private fun drop() {
        val store = session.store ?: return
        val handle = session.handle ?: return
        session.handle = null
        session.store = null
        closeLater(store, handle)
    }

    private fun closeLater(store: PendingNotesStore, handle: PendingNotesStore.EditorHandle) {
        background.launch { withContext(Dispatchers.IO) { closeHandle(store, handle) } }
    }

    // ---- editing ----

    /** A change the user made in [field]; the autosave runs [AUTOSAVE_MILLIS] after typing stops. */
    fun edited(field: NoteEditorCore.Field, start: Int, removed: CharSequence, inserted: CharSequence, text: String) {
        core.edited(field, start, removed, inserted, text)
        scheduleAutosave()
    }

    fun undo(field: NoteEditorCore.Field): EditHistory.Applied? = core.undo(field)?.also { scheduleAutosave() }

    fun redo(field: NoteEditorCore.Field): EditHistory.Applied? = core.redo(field)?.also { scheduleAutosave() }

    private fun scheduleAutosave() {
        if (deleting || moving || gone()) return
        autosave?.cancel()
        autosave = viewModelScope.launch {
            delay(AUTOSAVE_MILLIS)
            save()
        }
        updates.value = Unit
    }

    /** Saves the text now, if there is any to save: the screen's onPause, and the autosave. */
    fun save() {
        autosave?.cancel()
        background.launch { steps.withLock { saveStep() } }
    }

    /**
     * One save, start to end: the draft from [core], the store call on IO through the editor's handle, the answer back
     * to [core], and for a save that wrote the text, the Notes run it asks for, in this same step.
     */
    private suspend fun saveStep() {
        val draft = withContext(Dispatchers.Main) { core.beginSave() } ?: return
        val (result, target) = withContext(Dispatchers.IO) { saveOnIo(draft) to session.handle?.noteUid }
        withContext(Dispatchers.Main) {
            core.finishSave(draft, result)
            if (target != null) noteUid = target
            if (result == SaveResult.Stale) opened = Opened.Stale
            if (!cleared) updates.value = Unit
        }
        if (result is SaveResult.Saved || result is SaveResult.SavedToHolding) {
            session.savedAny = true
            requestSync(SYNC_DELAY_MILLIS)
        }
        if (result is SaveResult.SavedToHolding) {
            // What was typed during that save joins the held text too; then the viewer, which points to it, takes over.
            if (withContext(Dispatchers.Main) { core.dirty }) return saveStep()
            val uid = withContext(Dispatchers.Main) { noteUid } ?: return
            val opening = withContext(Dispatchers.IO) { openNote(uid) }
            withContext(Dispatchers.Main) { applyOpening(opening, first = false) }
            return
        }
        refreshStatusStep()
    }

    private fun saveOnIo(draft: NoteEditorCore.Draft): SaveResult {
        if (!current()) return SaveResult.Stale
        return try {
            if (session.handle == null) {
                // Only a new note's first save makes a note; an editor that gave way to the viewer saves nothing.
                if (!creating || session.pinnedUid != null) return SaveResult.NotSaved
                startNewNote()
            }
            beforeSaveForTesting?.invoke()
            val result = SaveRun.run { attempt(draft) }
            if (!current()) SaveResult.Stale else result
        } catch (_: PendingNotesStore.Cleared) {
            SaveResult.Cleared
        } catch (_: InvalidAccountException) {
            SaveResult.Stale
        } catch (_: StaleGeneration) {
            SaveResult.Stale
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.warning("A note could not be saved on this device: ${e.javaClass.name}")
            SaveResult.NotSaved
        }
    }

    /** A new note's first save: the item is made here, and the editor's handle is opened on it with no base. */
    private fun startNewNote() {
        val store = PendingNotesStore.forIdentity(app, account.type, account.name, creationId)
        val itemMgr = notebook(null).itemMgr
        val item = itemMgr.create(ItemMetadata(), "")
        item.setMetaRaw(NoteMetaCodec.fresh(NoteEditing.UNTITLED, System.currentTimeMillis()).bytes)
        val pinned = itemMgr.cacheSaveWithContent(item)
        val handle = store.editorOpened(item.uid, null)
        session.store = store
        session.handle = handle
        session.pinned = pinned
        session.pinnedUid = item.uid
        session.titleUid = item.uid
        session.landedAtPin = null
        session.newNote = true
    }

    /**
     * One save of [draft] onto the note the handle names now. Its item is the note's entry when there is one (a run
     * may have rebased it), else its landed record (an upload of this editor's text that landed), else the item the
     * editor opened on; a conflict copy has an entry or a landed record of its own.
     */
    private fun attempt(draft: NoteEditorCore.Draft): Pair<SaveOutcome, Boolean> {
        val store = checkNotNull(session.store)
        val handle = checkNotNull(session.handle)
        val target = handle.noteUid
        val read = store.read(target)
        val base = when (read) {
            is PendingNotesStore.Read.Present -> {
                if (read.entry.notebookUid != notebookUid) throw IOException("the note's entry is in another notebook")
                read.entry.blob
            }
            // Never written over: the store answers so, and the text stays on screen.
            is PendingNotesStore.Read.Unreadable -> return SaveOutcome.Blocked to false
            PendingNotesStore.Read.Missing -> {
                val landed = store.landed(target)
                val pinned = session.pinned.takeIf { target == session.pinnedUid }
                // The landed record when an upload landed since the pin; otherwise the pin, which is at least as new.
                if (landed != null && (pinned == null || landed.revision != session.landedAtPin)) landed.blob
                else pinned ?: throw IOException("nothing to save the note onto")
            }
        }
        val access = notebook(store.notebook(notebookUid))
        val first = session.newNote && target == session.pinnedUid
        val built = build(access.itemMgr, base, draft, target, first)
        // The cache and the settings are read by account name: a same-name account must not get this save.
        if (!current()) throw StaleGeneration()
        val outcome = store.saveLocal(handle, target, notebookUid, built.revision, built.blob, isCreate = first,
            notebookCopy = if (read == PendingNotesStore.Read.Missing) access.copyToKeep else null)
        return outcome to built.metadataKept
    }

    private class Built(val revision: String, val blob: ByteArray, val metadataKept: Boolean)

    /** The exact account generation went away during a save: nothing was written. */
    private class StaleGeneration : IllegalStateException("the account generation is gone")

    /**
     * The item from [base] with the draft's text, and its name and time merged into its raw metadata
     * ([NoteEditing.metadataToWrite]), never through a typed setMeta. What was written must read back as
     * [EtebasePushRemote.requireReadBack] checks it; metadata that cannot be merged, or a merge that does not read
     * back, is kept as it was, with the new text. In a conflict copy the copy's own name stays, unless the user changed
     * the title since it was loaded.
     */
    private fun build(itemMgr: ItemManager, base: ByteArray, draft: NoteEditorCore.Draft, target: String, first: Boolean): Built {
        val item = itemMgr.cacheLoad(base)
        item.setContent(draft.body)
        val before = item.metaRaw
        val name = if (target == session.titleUid || draft.titleChanged) NoteEditing.nameToWrite(draft.title, first)
            else NoteMetaCodec.peek(before)?.name ?: draft.title
        val mtime = System.currentTimeMillis()
        val merged = NoteEditing.metadataToWrite(before, name, mtime)
        var kept = merged == null
        if (merged != null) {
            item.setMetaRaw(merged.bytes)
            try {
                EtebasePushRemote.requireReadBack(merged.name, mtime) { EtebasePushRemote.readBack(item.metaRaw) { item.meta.mtime } }
            } catch (_: NotePushStep.NotBuilt) {
                item.setMetaRaw(before)
                kept = true
            }
        }
        return Built(item.etag, itemMgr.cacheSaveWithContent(item), kept)
    }

    /** [writable]: the cached notebook is there and accepts writes ([NotePushPolicy.acceptsWrites]). */
    private class NotebookAccess(val itemMgr: ItemManager, val copyToKeep: ByteArray?, val writable: Boolean)

    /**
     * The notebook's item manager, from the copy the store keeps ([stored]) when it loads, else from the cached
     * notebook, which uses the same key; and a copy of the cached notebook for a note's first entry to keep, so held
     * text stays readable after the cache drops the notebook. The cache is read under its monitor, never with a store call.
     */
    private fun notebook(stored: ByteArray?, uid: String = notebookUid): NotebookAccess {
        val colMgr = collectionManager()
        val cache = EtebaseLocalCache.getInstance(app, account.name)
        val live = synchronized(cache) {
            try {
                cache.collectionGet(colMgr, uid).col
            } catch (e: EtebaseException) {
                Logger.log.warning("The cached notebook could not be read: ${e.javaClass.name}")
                null
            }
        }
        val loaded = stored?.let {
            try {
                colMgr.cacheLoad(it)
            } catch (e: EtebaseException) {
                Logger.log.warning("The stored copy of a notebook could not be loaded: ${e.javaClass.name}")
                null
            }
        }
        val col = loaded ?: live ?: throw IOException("no copy of the notebook to encrypt with")
        val writable = live != null && NotePushPolicy.acceptsWrites(live.isDeleted, live.accessLevel == CollectionAccessLevel.ReadOnly)
        return NotebookAccess(colMgr.getItemManager(col), live?.let { colMgr.cacheSave(it) }, writable)
    }

    /** The cached item [uid] as a blob, or null when the cache has no note there. */
    private fun cachedItem(uid: String): ByteArray? {
        val colMgr = collectionManager()
        val cache = EtebaseLocalCache.getInstance(app, account.name)
        return synchronized(cache) {
            val itemMgr = colMgr.getItemManager(cache.collectionGet(colMgr, notebookUid).col)
            cache.itemGet(itemMgr, notebookUid, uid)
                ?.takeIf { !it.item.isDeleted && NotesLoader.isMarkdownNote(it.meta.itemType) }
                ?.let { itemMgr.cacheSaveWithContent(it.item) }
        }
    }

    private fun collectionManager(): CollectionManager =
        EtebaseLocalCache.getEtebase(app, HttpClient.sharedClient, AccountSettings(app, account)).collectionManager

    private fun current(): Boolean =
        ExactAccountRouting.validate(account, creationId, App.accountType, AccountManager.get(app)) != null

    // ---- deleting ----

    /**
     * The user chose Delete. Everything typed is saved first, in this same step, so no text is on screen alone; then the
     * note's entry is read for the confirmation ([DeleteStep.Ask]), or the reason there is none ([DeleteStep.Answered]).
     */
    fun askDelete() {
        if (deleting || moving) return
        autosave?.cancel()
        background.launch {
            steps.withLock {
                // Asked again from a confirmation restored in a new process, the editor may still have been opening.
                if (withContext(Dispatchers.Main) { opened !is Opened.Editor || deleting || moving }) return@withLock
                saveStep()
                val mode = withContext(Dispatchers.Main) { if (core.dirty) null else core.mode }
                val step = when (mode) {
                    NoteEditorCore.Mode.EDITING -> withContext(Dispatchers.IO) { readDelete() }
                    NoteEditorCore.Mode.HELD -> DeleteStep.Answered(DeleteAnswer.HELD)
                    NoteEditorCore.Mode.STOPPED, null -> DeleteStep.Answered(DeleteAnswer.NOT_SAVED)
                }
                withContext(Dispatchers.Main) {
                    deleteStep = step
                    if (!cleared) updates.value = Unit
                }
            }
        }
    }

    /** What the confirmation shows: the note the handle names now, and its entry. Off the main thread. */
    private fun readDelete(): DeleteStep {
        if (!current()) return DeleteStep.Answered(DeleteAnswer.STALE)
        val store = session.store
        val handle = session.handle ?: return DeleteStep.Answered(DeleteAnswer.NOTHING_SAVED)
        if (store == null) return DeleteStep.Answered(DeleteAnswer.NOTHING_SAVED)
        return try {
            val uid = handle.noteUid
            when (val read = store.read(uid)) {
                is PendingNotesStore.Read.Present -> {
                    val entry = read.entry
                    when {
                        entry.notebookUid != notebookUid -> DeleteStep.Answered(DeleteAnswer.FAILED)
                        entry.state == PendingEntry.State.HELD -> DeleteStep.Answered(DeleteAnswer.HELD)
                        entry.state == PendingEntry.State.DELETE ->
                            DeleteStep.Answered(if (entry.move != null) DeleteAnswer.MOVED_AWAY else DeleteAnswer.RECORDED)
                        // The copy of moves that have not finished is not only on this device: its delete sends theirs.
                        else -> DeleteStep.Ask(DeleteShown(uid, entry.version, PendingNotesStore.digestOf(entry.blob),
                            neverSynced = entry.isCreate && entry.sent.isEmpty() && !store.hasWaitingMoves(uid)))
                    }
                }
                is PendingNotesStore.Read.Unreadable -> DeleteStep.Answered(DeleteAnswer.UNREADABLE)
                // A new note whose first save did not write, and that never landed: nothing of it is anywhere.
                PendingNotesStore.Read.Missing -> if (session.newNote && uid == session.pinnedUid && store.landed(uid) == null) {
                    DeleteStep.Answered(DeleteAnswer.NOTHING_SAVED)
                } else {
                    val base = baseWithoutEntry(store, uid) ?: return DeleteStep.Answered(DeleteAnswer.FAILED)
                    val shown = notebook(store.notebook(notebookUid)).itemMgr.cacheLoad(base).etag
                    DeleteStep.Ask(DeleteShown(uid, null, null, neverSynced = false, revision = shown))
                }
            }
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.warning("A note delete could not be prepared: ${e.javaClass.name}")
            DeleteStep.Answered(if (current()) DeleteAnswer.FAILED else DeleteAnswer.STALE)
        }
    }

    /**
     * The user confirmed the delete of [shown], and, separately, the discard of its unsynced text when it has some
     * ([discardConfirmed]). From here the fields take no typing ([deleting]). A delete that removed the note closes the
     * editor's handle, so nothing more is saved, and one that recorded a pending delete asks for a Notes run at once.
     */
    fun delete(shown: DeleteShown, discardConfirmed: Boolean) {
        if (deleting || moving || opened !is Opened.Editor) return
        deleting = true
        autosave?.cancel()
        updates.value = Unit
        background.launch {
            steps.withLock {
                // Typed after the confirmation was prepared, and so not covered by it: nothing is deleted.
                val answer = if (withContext(Dispatchers.Main) { core.dirty }) DeleteAnswer.CHANGED
                    else withContext(Dispatchers.IO) { deleteOnIo(shown, discardConfirmed) }
                val gone = answer == DeleteAnswer.RECORDED || answer == DeleteAnswer.DROPPED || answer == DeleteAnswer.UNSURE
                withContext(Dispatchers.Main) {
                    if (gone) {
                        opened = Opened.Deleted
                        drop()
                    } else if (answer == DeleteAnswer.STALE) {
                        opened = Opened.Stale
                    }
                    deleting = false
                    deleteStep = DeleteStep.Answered(answer)
                    if (!cleared) updates.value = Unit
                }
                // A delete that may not last a power loss is on disk until then, so a run is asked for it too.
                if (answer == DeleteAnswer.RECORDED || answer == DeleteAnswer.UNSURE) requestSync(0)
            }
        }
    }

    /**
     * The delete on IO: the note item the editor shows, marked deleted, goes to the store with what the confirmation
     * showed ([PendingNotesStore.deleteNote]), which checks it against what is there under its lock. The item is the
     * note's entry when there is one, else its landed record when an upload landed since the pin, else the pinned item:
     * the same choice a save makes ([attempt]), so its base is the revision the user saw.
     */
    private fun deleteOnIo(shown: DeleteShown, discardConfirmed: Boolean): DeleteAnswer {
        if (!current()) return DeleteAnswer.STALE
        val store = session.store ?: return DeleteAnswer.CHANGED
        val handle = session.handle ?: return DeleteAnswer.CHANGED
        return try {
            val target = handle.noteUid
            if (target != shown.noteUid) return DeleteAnswer.CHANGED
            val read = store.read(target)
            val base = when (read) {
                is PendingNotesStore.Read.Present -> {
                    if (read.entry.notebookUid != notebookUid || read.entry.state != PendingEntry.State.UPSERT) return DeleteAnswer.CHANGED
                    read.entry.blob
                }
                is PendingNotesStore.Read.Unreadable -> return DeleteAnswer.UNREADABLE
                PendingNotesStore.Read.Missing -> baseWithoutEntry(store, target) ?: return DeleteAnswer.CHANGED
            }
            val access = notebook(store.notebook(notebookUid))
            val item = access.itemMgr.cacheLoad(base)
            // With no entry, the item must be the revision the confirmation showed: a load since (a run that fetched
            // another device's change) may have moved the editor onto a newer copy the user never saw.
            if (read == PendingNotesStore.Read.Missing && (shown.revision == null || item.etag != shown.revision)) {
                return DeleteAnswer.CHANGED
            }
            // No text of the note goes into the deleted item, the unsynced text the user just discarded included.
            EtebasePushRemote.markDeleted(item, System.currentTimeMillis())
            val deleted = access.itemMgr.cacheSaveWithContent(item)
            // The cache and the settings are read by account name: a same-name account must not get this delete.
            if (!current()) return DeleteAnswer.STALE
            when (val outcome = store.deleteNote(target, notebookUid, shown.version, shown.digest, discardConfirmed, item.etag,
                deleted, notebookCopy = if (read == PendingNotesStore.Read.Missing) access.copyToKeep else null)) {
                PendingNotesStore.NoteDelete.Recorded, PendingNotesStore.NoteDelete.AlreadyDeleted -> DeleteAnswer.RECORDED
                PendingNotesStore.NoteDelete.Dropped -> DeleteAnswer.DROPPED
                is PendingNotesStore.NoteDelete.Changed, is PendingNotesStore.NoteDelete.NeedsDiscard -> DeleteAnswer.CHANGED
                PendingNotesStore.NoteDelete.RemovalPending -> DeleteAnswer.REMOVAL_PENDING
                is PendingNotesStore.NoteDelete.Refused -> when (outcome.reason) {
                    PendingNotesStore.DeleteRefusal.HELD -> DeleteAnswer.HELD
                    PendingNotesStore.DeleteRefusal.UNREADABLE -> DeleteAnswer.UNREADABLE
                    PendingNotesStore.DeleteRefusal.DISCARD_UNFINISHED -> DeleteAnswer.DISCARD_UNFINISHED
                    // Nothing was written: "could not be saved on this device, so nothing was deleted" is true for each.
                    PendingNotesStore.DeleteRefusal.UNFINISHED_ORIGINAL, PendingNotesStore.DeleteRefusal.TOO_LARGE,
                    PendingNotesStore.DeleteRefusal.MOVES_UNKNOWN -> DeleteAnswer.FAILED
                }
            }
        } catch (_: PendingNotesStore.RemovalNotSynced) {
            when {
                !current() -> DeleteAnswer.STALE
                // A replaced original removed before this copy's delete was written: the note and its text are still
                // there, and a later run sends them. Never "deleted" over that.
                entryStillThere(store, shown.noteUid) -> DeleteAnswer.FAILED
                else -> DeleteAnswer.UNSURE
            }
        } catch (_: InvalidAccountException) {
            DeleteAnswer.STALE
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // The class only: a binding's message can quote a decrypted value.
            Logger.log.warning("A note could not be deleted on this device: ${e.javaClass.name}")
            when {
                !current() -> DeleteAnswer.STALE
                // A write whose rename went through before its directory sync failed: the delete is there, but may not
                // last a power loss. Never "nothing was deleted" over a delete the next run will send.
                e is IOException && deleteIsThere(store, shown.noteUid) -> DeleteAnswer.UNSURE
                else -> DeleteAnswer.FAILED
            }
        }
    }

    /** Whether the note's entry is there and not a pending delete; a read that fails says no. */
    private fun entryStillThere(store: PendingNotesStore, uid: String): Boolean = try {
        (store.read(uid) as? PendingNotesStore.Read.Present)?.entry?.let { it.state != PendingEntry.State.DELETE } == true
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        false
    }

    /** Whether the note's entry is a pending delete now; a read that fails says no. */
    private fun deleteIsThere(store: PendingNotesStore, uid: String): Boolean = try {
        (store.read(uid) as? PendingNotesStore.Read.Present)?.entry?.state == PendingEntry.State.DELETE
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        false
    }

    /**
     * The item the editor shows for a note with no entry: its landed record when an upload landed since the pin, else the
     * item it opened on, the same choice a save makes ([attempt]); null when it has neither.
     */
    private fun baseWithoutEntry(store: PendingNotesStore, uid: String): ByteArray? {
        val landed = store.landed(uid)
        val pinned = session.pinned.takeIf { uid == session.pinnedUid }
        return if (landed != null && (pinned == null || landed.revision != session.landedAtPin)) landed.blob else pinned
    }

    // ---- moving ----

    /** Set on the main thread from a confirmed move until its answer: the fields take no typing, and nothing is saved. */
    var moving = false
        private set

    /** What a move asks of the screen, for the screen to take once ([takeMoveStep]). Main thread. */
    var moveStep: MoveStep? = null
        private set

    /**
     * A notebook a note can be moved to: one that accepts writes, other than the note's own, by its decoded name. [shared]:
     * another account owns it (this account is not its admin), as the notebook list marks it.
     */
    data class MoveTarget(val uid: String, val name: String, val shared: Boolean = false)

    /**
     * The notebooks the last picker offered, in memory only, so the picker's arguments hold uids and no decrypted name. A
     * picker restored in a new process finds none here and asks again. Main thread.
     */
    var moveTargets: List<MoveTarget> = emptyList()
        private set

    sealed class MoveStep {
        /** Ask where to move [shown], to one of [targets]. */
        data class Ask(val shown: DeleteShown, val targets: List<MoveTarget>) : MoveStep()
        /** What the move, or the read for it, came to. */
        data class Answered(val answer: MoveAnswer) : MoveStep()
    }

    enum class MoveAnswer {
        /** The copy was written there, and the original's delete recorded; a run sends both, the copy first. */
        MOVED,
        /** As [MOVED], but the last write may not last a power loss: the note may then show in both notebooks. */
        UNSURE,
        /** Nothing changed on this device. */
        NOT_MOVED,
        /** The move stopped halfway: the note stays, and a copy may also show in the other notebook. */
        MAYBE_BOTH,
        /** Text typed or changed since the picker was prepared: nothing was moved. */
        CHANGED,
        /** The editor has text that was not saved: nothing was moved. */
        NOT_SAVED,
        HELD,
        UNREADABLE,
        DISCARD_UNFINISHED,
        REMOVAL_PENDING,
        /** No other notebook accepts writes. */
        NO_TARGET,
        /** The notebook chosen no longer accepts writes. */
        TARGET_GONE,
        /** Another editor deleted the note on this device: nothing was moved. */
        DELETED,
        /** Another editor moved the note on this device already: nothing more was moved. */
        MOVED_AWAY,
        FAILED,
        STALE,
    }

    /** The move step for the screen to act on, once. Main thread. */
    fun takeMoveStep(): MoveStep? = moveStep.also { moveStep = null }

    /** Whether the user deleted or moved the note here: nothing more is saved or loaded. Main thread. */
    private fun gone(): Boolean = opened == Opened.Deleted || opened is Opened.Moved

    /**
     * The user chose Move. As for Delete ([askDelete]), everything typed is saved first, in this same step; then the note's
     * entry is read for the picker, with the notebooks it can go to ([MoveStep.Ask]), or the reason there is none.
     */
    fun askMove() {
        if (deleting || moving) return
        autosave?.cancel()
        background.launch {
            steps.withLock {
                if (withContext(Dispatchers.Main) { opened !is Opened.Editor || deleting || moving }) return@withLock
                saveStep()
                val mode = withContext(Dispatchers.Main) { if (core.dirty) null else core.mode }
                val step = when (mode) {
                    NoteEditorCore.Mode.EDITING -> withContext(Dispatchers.IO) { readMove() }
                    NoteEditorCore.Mode.HELD -> MoveStep.Answered(MoveAnswer.HELD)
                    NoteEditorCore.Mode.STOPPED, null -> MoveStep.Answered(MoveAnswer.NOT_SAVED)
                }
                withContext(Dispatchers.Main) {
                    if (step is MoveStep.Ask) moveTargets = step.targets
                    moveStep = step
                    if (!cleared) updates.value = Unit
                }
            }
        }
    }

    /** What the picker shows: what a delete's confirmation would, and the notebooks the note can go to. Off the main thread. */
    private fun readMove(): MoveStep {
        val shown = when (val step = readDelete()) {
            is DeleteStep.Ask -> step.shown
            is DeleteStep.Answered -> return MoveStep.Answered(when (step.answer) {
                DeleteAnswer.STALE -> MoveAnswer.STALE
                DeleteAnswer.HELD -> MoveAnswer.HELD
                DeleteAnswer.UNREADABLE -> MoveAnswer.UNREADABLE
                DeleteAnswer.NOTHING_SAVED -> MoveAnswer.NOT_SAVED
                // Another editor deleted or moved this note on this device already.
                DeleteAnswer.RECORDED -> MoveAnswer.DELETED
                DeleteAnswer.MOVED_AWAY -> MoveAnswer.MOVED_AWAY
                else -> MoveAnswer.FAILED
            })
        }
        return try {
            val targets = moveTargets()
            if (!current()) MoveStep.Answered(MoveAnswer.STALE)
            else if (targets.isEmpty()) MoveStep.Answered(MoveAnswer.NO_TARGET)
            else MoveStep.Ask(shown, targets)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.warning("The notebooks to move a note to could not be read: ${e.javaClass.name}")
            MoveStep.Answered(if (current()) MoveAnswer.FAILED else MoveAnswer.STALE)
        }
    }

    /** The cached notebooks that accept writes, other than this one, by name; one whose name cannot be decoded is left out. */
    private fun moveTargets(): List<MoveTarget> {
        val colMgr = collectionManager()
        val cache = EtebaseLocalCache.getInstance(app, account.name)
        val listed = synchronized(cache) {
            cache.decodableCollectionList(colMgr, Constants.ETEBASE_TYPE_NOTES) { _, error ->
                Logger.log.warning("Skipping a notebook that could not be decoded: ${error.javaClass.name}")
            }
        }
        return listed.filter {
            it.col.uid != notebookUid && NotePushPolicy.acceptsWrites(it.col.isDeleted, it.col.accessLevel == CollectionAccessLevel.ReadOnly)
        }.map { MoveTarget(it.col.uid, it.meta.name.orEmpty(), shared = it.col.accessLevel != CollectionAccessLevel.Admin) }
            .sortedBy { it.name.lowercase() }
    }

    /**
     * The user chose [target] in the picker that showed [shown]. From here the fields take no typing ([moving]). A move that
     * was recorded closes the editor's handle, so nothing more is saved, asks for a Notes run at once, and leaves the
     * screen to open the moved note ([Opened.Moved]).
     */
    fun move(shown: DeleteShown, target: MoveTarget) {
        if (deleting || moving || opened !is Opened.Editor) return
        moving = true
        autosave?.cancel()
        updates.value = Unit
        background.launch {
            steps.withLock {
                // Typed after the picker was prepared, and so not covered by it: nothing is moved.
                val (answer, copy) = if (withContext(Dispatchers.Main) { core.dirty }) MoveAnswer.CHANGED to null
                    else withContext(Dispatchers.IO) { moveOnIo(shown, target) }
                withContext(Dispatchers.Main) {
                    if (copy != null) {
                        opened = Opened.Moved(copy, target.uid)
                        drop()
                    } else if (answer == MoveAnswer.STALE) {
                        opened = Opened.Stale
                    }
                    moving = false
                    moveStep = MoveStep.Answered(answer)
                    if (!cleared) updates.value = Unit
                }
                if (copy != null) requestSync(0)
            }
        }
    }

    /**
     * The move on IO: the copy is a new note in [target] with the text and metadata of the item the editor shows, byte for
     * byte (the same item a delete marks: [deleteOnIo]); the original is that item marked deleted. Both go to the store
     * with what the picker showed ([PendingNotesStore.moveNote]), which checks it against what is there under its lock.
     * Returns the answer, and the copy's uid when the move was recorded.
     */
    private fun moveOnIo(shown: DeleteShown, target: MoveTarget): Pair<MoveAnswer, String?> {
        if (!current()) return MoveAnswer.STALE to null
        val store = session.store ?: return MoveAnswer.CHANGED to null
        val handle = session.handle ?: return MoveAnswer.CHANGED to null
        return try {
            val uid = handle.noteUid
            if (uid != shown.noteUid || target.uid == notebookUid) return MoveAnswer.CHANGED to null
            val read = store.read(uid)
            val base = when (read) {
                is PendingNotesStore.Read.Present -> {
                    if (read.entry.notebookUid != notebookUid || read.entry.state != PendingEntry.State.UPSERT) return MoveAnswer.CHANGED to null
                    read.entry.blob
                }
                is PendingNotesStore.Read.Unreadable -> return MoveAnswer.UNREADABLE to null
                PendingNotesStore.Read.Missing -> baseWithoutEntry(store, uid) ?: return MoveAnswer.CHANGED to null
            }
            val source = notebook(store.notebook(notebookUid))
            val item = source.itemMgr.cacheLoad(base)
            // With no entry, the item must be the revision the picker showed, as for a delete.
            if (read == PendingNotesStore.Read.Missing && (shown.revision == null || item.etag != shown.revision)) {
                return MoveAnswer.CHANGED to null
            }
            val into = notebook(store.notebook(target.uid), target.uid)
            if (!into.writable) return MoveAnswer.TARGET_GONE to null
            // A move is not an edit: the text and every metadata field, other clients' included, go across as they are.
            val content = item.content
            val meta = item.metaRaw
            val made = into.itemMgr.create(ItemMetadata(), content)
            if (meta != null && meta.isNotEmpty()) made.setMetaRaw(meta)
            if (!made.content.contentEquals(content) || (meta != null && meta.isNotEmpty() && !made.metaRaw.contentEquals(meta))) {
                Logger.log.warning("A moved note did not read back as written")
                return MoveAnswer.FAILED to null
            }
            val copy = PendingEntry(made.uid, target.uid, PendingEntry.State.UPSERT, version = 0L, revision = made.etag,
                isCreate = true, blob = into.itemMgr.cacheSaveWithContent(made))
            // No text of the note goes into the original's deleted item: it is in the copy.
            EtebasePushRemote.markDeleted(item, System.currentTimeMillis())
            val deleted = source.itemMgr.cacheSaveWithContent(item)
            // The cache and the settings are read by account name: a same-name account must not get this move.
            if (!current()) return MoveAnswer.STALE to null
            when (val outcome = store.moveNote(uid, notebookUid, shown.version, shown.digest, item.etag, deleted, copy,
                notebookCopy = if (read == PendingNotesStore.Read.Missing) source.copyToKeep else null,
                targetCopy = into.copyToKeep)) {
                is PendingNotesStore.NoteMove.Moved -> MoveAnswer.MOVED to outcome.copyUid
                is PendingNotesStore.NoteMove.Unsure -> MoveAnswer.UNSURE to outcome.copyUid
                PendingNotesStore.NoteMove.NotMoved -> MoveAnswer.NOT_MOVED to null
                PendingNotesStore.NoteMove.MaybeBoth -> MoveAnswer.MAYBE_BOTH to null
                is PendingNotesStore.NoteMove.Changed -> MoveAnswer.CHANGED to null
                PendingNotesStore.NoteMove.RemovalPending -> MoveAnswer.REMOVAL_PENDING to null
                is PendingNotesStore.NoteMove.Refused -> when (outcome.reason) {
                    PendingNotesStore.DeleteRefusal.HELD -> MoveAnswer.HELD
                    PendingNotesStore.DeleteRefusal.UNREADABLE -> MoveAnswer.UNREADABLE
                    PendingNotesStore.DeleteRefusal.DISCARD_UNFINISHED -> MoveAnswer.DISCARD_UNFINISHED
                    PendingNotesStore.DeleteRefusal.UNFINISHED_ORIGINAL, PendingNotesStore.DeleteRefusal.TOO_LARGE,
                    PendingNotesStore.DeleteRefusal.MOVES_UNKNOWN -> MoveAnswer.FAILED
                } to null
            }
        } catch (_: InvalidAccountException) {
            MoveAnswer.STALE to null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // The class only: a binding's message can quote a decrypted value. The store wrote nothing it did not answer for.
            Logger.log.warning("A note could not be moved on this device: ${e.javaClass.name}")
            (if (current()) MoveAnswer.FAILED else MoveAnswer.STALE) to null
        }
    }

    // ---- the sync request and the status line ----

    /** Asks for one automatic Notes run after [delayMillis], in place of any request still waiting. */
    private fun requestSync(delayMillis: Long) {
        session.request?.cancel()
        session.request = background.launch {
            delay(delayMillis)
            withContext(Dispatchers.IO) {
                if (current()) NotesSyncCoordinator.request(app, account, creationId, NotesSyncPolicy.Trigger.SAVE)
            }
        }
    }

    /** After a Notes run changed state: a clean editor loads again, and the status line reads the entry again. */
    fun syncChanged() = reload()

    private suspend fun refreshStatusStep() {
        val store = session.store
        val handle = session.handle
        val line = withContext(Dispatchers.IO) {
            if (store == null || handle == null) return@withContext null
            try {
                NoteEditing.syncLine(NoteEditing.Local.of(store.observe(handle.noteUid).read), NotesLoader.network(app, account))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Logger.log.warning("The note's sync state could not be read: ${e.javaClass.name}")
                null
            }
        }
        withContext(Dispatchers.Main) {
            syncLine = line
            if (!cleared) updates.value = Unit
        }
    }

    // ---- leaving ----

    /** Whether the editor shows text that is not saved on this device: a leave the user starts asks first ([requestLeave]). Main thread. */
    val unsaved: Boolean get() = opened is Opened.Editor && core.dirty

    /** True while a leave the user started runs its save. Main thread. */
    var leaveRunning = false
        private set

    /** A leave the user started may go ahead: the screen leaves once it can, then calls [leaveDone]. Main thread. */
    var leaveGo = false
        private set

    /**
     * Why a leave the user started asks first, while the screen asks it. Main thread, and in memory only: a question
     * Android brings back in a new app process finds none here, so none of its answers is taken.
     */
    var leavePrompt: LeavePrompt? = null
        private set

    /**
     * One question before leaving, over the text at [edits] ([NoteEditorCore.edits]) of the note [noteUid], null for a
     * new note whose first save has not started. [tryAgain]: another save may work. [reason]: the last save's answer, which
     * the question words. [newNote]: nothing of this new note was ever saved here ([NoteEditing.neverSaved]).
     */
    class LeavePrompt(val edits: Long, val noteUid: String?, val tryAgain: Boolean, val reason: SaveResult?, val newNote: Boolean)

    /**
     * [leavePrompt], when an answer from a dialog made in the app process [shownIn] over the note [shownNote] may be acted
     * on ([NoteEditing.leaveAnswerHolds]); null otherwise. Main thread.
     */
    fun leavePromptAnswered(shownIn: String?, shownNote: String?): LeavePrompt? = leavePrompt?.takeIf {
        NoteEditing.leaveAnswerHolds(ProcessIncarnation.isCurrent(shownIn), it.noteUid, it.edits, shownNote, noteUid, core.edits, unsaved)
    }

    /**
     * A leave the user started (Back or Up) while [unsaved]: the save runs first, in a step of the app's, and once more
     * when typing landed during it. Saved, or saved into held text: the screen leaves ([leaveGo]). Otherwise it stays and
     * asks ([leavePrompt]). Nothing starts while a leave runs or a question is open.
     */
    fun requestLeave() {
        if (cleared || leaveRunning || leavePrompt != null) return
        leaveRunning = true
        autosave?.cancel()
        updates.value = Unit
        background.launch {
            try {
                steps.withLock {
                    saveStep()
                    if (withContext(Dispatchers.Main) { core.dirty && core.lastResult is SaveResult.Saved }) saveStep()
                }
            } finally {
                withContext(NonCancellable + Dispatchers.Main) {
                    leaveRunning = false
                    if (!cleared) {
                        when (val leave = NoteEditing.leave(opened is Opened.Editor, core.dirty, core.mode, core.lastResult)) {
                            // For an account generation that is gone, the screen finishes instead.
                            NoteEditing.Leave.GO -> leaveGo = opened !is Opened.Stale
                            NoteEditing.Leave.ASK_TRY_AGAIN, NoteEditing.Leave.ASK ->
                                leavePrompt = LeavePrompt(core.edits, noteUid, leave == NoteEditing.Leave.ASK_TRY_AGAIN, core.lastResult,
                                    newNote = NoteEditing.neverSaved(creating, core.lastSavedVersion))
                        }
                        updates.value = Unit
                    }
                }
            }
        }
    }

    /** The screen left after [leaveGo]. Main thread. */
    fun leaveDone() {
        leaveGo = false
    }

    /** The question before leaving was put away: Cancel, Try again, Leave anyway, or a question that no longer holds. Main thread. */
    fun dropLeavePrompt() {
        leavePrompt = null
    }

    // ---- closing ----

    override fun onCleared() {
        cleared = true
        autosave?.cancel()
        // The last save, the handle's close, and the request a closing editor makes, in one step of the app's. A leave the
        // user started saved first and asked before leaving with text that is not saved ([requestLeave]); this is one more
        // try after Leave anyway, and the only one for a leave the user did not start (the screen finishing for the account).
        background.launch {
            steps.withLock {
                saveStep()
                if (session.closed) return@withLock
                session.closed = true
                // Closed even after a redirect that did not finish: no save follows, and a handle left open would keep
                // a landed copy of the note for every later push in this process.
                val store = session.store
                val handle = session.handle
                if (store != null && handle != null) withContext(Dispatchers.IO) { closeHandle(store, handle) }
                if (session.savedAny) requestSync(0)
            }
        }
        super.onCleared()
    }

    private fun closeHandle(store: PendingNotesStore, handle: PendingNotesStore.EditorHandle) {
        try {
            store.editorClosed(handle)
        } catch (e: Exception) {
            // Recovery drops a landed record no open editor needs.
            Logger.log.warning("A note editor could not close cleanly: ${e.javaClass.name}")
        }
    }

    class Factory(
        private val application: Application,
        private val account: Account,
        private val creationId: String,
        private val notebookUid: String,
        private val noteUid: String?,
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            NoteEditorViewModel(application, account, creationId, notebookUid, noteUid) as T
    }

    companion object {
        const val AUTOSAVE_MILLIS = 1_500L
        const val SYNC_DELAY_MILLIS = 10_000L
        const val OPEN_ATTEMPTS = 3

        /** The editor's steps outlive the screen: a last save and its sync request finish after the editor closed. */
        private val background = CoroutineScope(SupervisorJob() + Dispatchers.Default)

        /** Device tests only: runs in each save step on IO, before the store is called. */
        @VisibleForTesting
        @Volatile internal var beforeSaveForTesting: (() -> Unit)? = null
    }
}
