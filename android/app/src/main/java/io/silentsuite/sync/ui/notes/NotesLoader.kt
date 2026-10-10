package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
import com.etebase.client.ItemManager
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.notes.edit.PendingEntry
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.io.IOException
import java.util.logging.Level

/** A notebook row as shown in the Notes screen; mirrors the dashboard's collection markers. */
data class NotebookRow(
    val uid: String,
    val name: String,
    val description: String,
    val color: Int?,
    val readOnly: Boolean,
    val shared: Boolean,
    /** Local changes in this notebook waiting to be pushed. */
    val waiting: Int = 0,
)

/**
 * The notebook list, and how many local changes belong in the unsynced text screen instead. [failed]
 * means the notebooks could not be read, though the local changes were, so they still count.
 */
data class NotebookOverview(val notebooks: List<NotebookRow>, val unsyncedText: Int, val failed: Boolean = false)

data class NoteRow(
    val uid: String,
    val title: String,
    val preview: String,
    val editedAt: Long?,
    val sync: NoteSync = NoteSync.SYNCED,
)

data class NoteContent(
    val uid: String,
    val title: String,
    val body: String,
    val editedAt: Long?,
    val sync: NoteSync = NoteSync.SYNCED,
    /** The version of the pending entry this result reflects: its text, or its marker when held or unreadable. */
    val pendingVersion: Long? = null,
    /**
     * The pending store's sequence when this was loaded, set whether or not an entry existed. An editor
     * drops a load below its last saved version: the load read the store before that save.
     */
    val observedSequence: Long = 0,
)

/** [unreadable] counts items the cache holds for this notebook that could not be decoded. */
data class NotebookContents(val notebook: NotebookRow, val notes: List<NoteRow>, val unreadable: Int = 0)

/** Every private read reports whether the exact account generation still owns the result. */
sealed class NotesLoad<out T> {
    data class Loaded<T>(val value: T) : NotesLoad<T>()
    object Stale : NotesLoad<Nothing>()
    object Failed : NotesLoad<Nothing>()
}

/** Process-local presentation data used by runtime tests; never persisted. */
internal data class NotesRuntimeFixture(
    val notebooks: List<NotebookRow>,
    val notes: Map<String, List<NoteContent>>,
    val unsyncedText: Int = 0,
    val unreadable: Map<String, Int> = emptyMap(),
)

@Volatile
internal var notesFixtureOverride: ((Context, Account, String) -> NotesRuntimeFixture?)? = null

/**
 * Reads notebooks and notes from the local Etebase cache, with unpushed local changes from the pending
 * store laid over them ([NotesOverlay]). Everything here is offline: the session is restored without a
 * network call and the cache decrypts on read. Sync is the coordinator's job.
 */
internal object NotesLoader {
    fun notebooks(context: Context, account: Account, creationId: String): NotesLoad<NotebookOverview> {
        notesFixtureOverride?.let { fixture ->
            return fixture(context, account, creationId)?.let { NotesLoad.Loaded(NotebookOverview(it.notebooks, it.unsyncedText)) }
                ?: NotesLoad.Stale
        }
        // Headers are enough to count, so no blob is kept and nothing is decrypted for the list. When
        // anything after the store read fails, the local changes were still read, so the way to them
        // stays on screen (design 3.5): every change then counts as unsynced text.
        val onlyPending = { snapshot: PendingNotesStore.Snapshot ->
            NotesOverlay.notebooks(emptyList(), emptyList(), snapshot.headers,
                NotesOverlay.unreadableEntries(snapshot.unreadable, snapshot.headers), failed = true)
        }
        return load(context, account, creationId, { store -> store.snapshot { false } }, onlyPending) { cache, colMgr, snapshot ->
            val unreadableEntries = NotesOverlay.unreadableEntries(snapshot.unreadable, snapshot.headers)
            val rows = try {
                notebookRows(cache, colMgr)
            } catch (e: EtebaseException) {
                Logger.log.log(Level.WARNING, "Notebooks could not be read from the local cache", e)
                return@load onlyPending(snapshot)
            }
            // The notebooks as the runner sees them, from the cached collections without decoding their
            // metadata, so the list counts what the runner will actually do.
            val access = cache.collections(colMgr, withDeleted = true, type = Constants.ETEBASE_TYPE_NOTES)
                .map { NotesOverlay.NotebookAccess(it.uid, it.isDeleted, it.accessLevel == CollectionAccessLevel.ReadOnly) }
            NotesOverlay.notebooks(rows, access, snapshot.headers, unreadableEntries)
        }
    }

    fun notebook(context: Context, account: Account, creationId: String, notebookUid: String): NotesLoad<NotebookContents> {
        notesFixtureOverride?.let { fixture ->
            val data = fixture(context, account, creationId) ?: return NotesLoad.Stale
            val row = data.notebooks.firstOrNull { it.uid == notebookUid } ?: return NotesLoad.Failed
            val notes = data.notes[notebookUid].orEmpty().map { NoteRow(it.uid, it.title, previewOf(it.body), it.editedAt, it.sync) }
            return NotesLoad.Loaded(NotebookContents(row, sortNotes(notes), data.unreadable[notebookUid] ?: 0))
        }
        // One snapshot under the pending lock. This notebook's changes are read whole, so one whose blob
        // is damaged is marked here instead of counting by its header alone; only edits are decrypted.
        val readPending = { store: PendingNotesStore ->
            val snapshot = store.snapshot { it.notebookUid == notebookUid && it.state != PendingEntry.State.HELD }
            val hasEdits = snapshot.entries.values.any { it.state == PendingEntry.State.UPSERT }
            PendingRead(snapshot, if (hasEdits) notebookCopy(store, notebookUid) else null)
        }
        return load(context, account, creationId, readPending) { cache, colMgr, pending ->
            val row = notebookRows(cache, colMgr).firstOrNull { it.uid == notebookUid } ?: return@load null
            val collection = cache.collectionGet(colMgr, notebookUid)
            val itemMgr = colMgr.getItemManager(collection.col)
            // One item another app wrote in a shape this client cannot decode is counted and left
            // out, not allowed to fail the whole notebook.
            val unreadable = HashSet<String>()
            val notes = cache.decodableItemList(itemMgr, notebookUid) { uid, error ->
                // The binding's message can quote a decrypted value; log only the exception class.
                Logger.log.warning("Skipping a note that could not be decoded: ${error.javaClass.name}")
                unreadable += uid
            }
                .filter { isMarkdownNote(it.meta.itemType) }
                .mapNotNull { cached ->
                    // The title comes from the raw bytes. Like any other read of one item, a failure is that item's alone.
                    val title = try {
                        titleOf(cached.item.metaRaw)
                    } catch (e: EtebaseException) {
                        Logger.log.warning("Skipping a note whose metadata could not be read: ${e.javaClass.name}")
                        unreadable += cached.item.uid
                        return@mapNotNull null
                    }
                    NoteRow(cached.item.uid, title, previewOf(cached.content), cached.meta.mtime)
                }
            val source by lazy { notebookSource(colMgr, pending.notebookCopy, collection.col, notebookUid) }
            NotesOverlay.notebook(row, notes, unreadable, pending.snapshot.headers,
                NotesOverlay.unreadableEntries(pending.snapshot.unreadable, pending.snapshot.headers)) { header ->
                pending.snapshot.entries[header.noteUid]?.let { decrypt(source, it, keepBody = false) }
            }
        }
    }

    fun note(context: Context, account: Account, creationId: String, notebookUid: String, noteUid: String): NotesLoad<NoteContent> {
        notesFixtureOverride?.let { fixture ->
            val data = fixture(context, account, creationId) ?: return NotesLoad.Stale
            return data.notes[notebookUid]?.firstOrNull { it.uid == noteUid }?.let { NotesLoad.Loaded(it) } ?: NotesLoad.Failed
        }
        val readPending = { store: PendingNotesStore ->
            val observed = store.observe(noteUid)
            val needsCopy = (observed.read as? PendingNotesStore.Read.Present)?.entry?.state == PendingEntry.State.UPSERT
            ObservedRead(observed, if (needsCopy) notebookCopy(store, notebookUid) else null)
        }
        return load(context, account, creationId, readPending) { cache, colMgr, pending ->
            val collection = cache.collectionGet(colMgr, notebookUid)
            val itemMgr = colMgr.getItemManager(collection.col)
            // Isolated like the list: a server copy that cannot be decoded must not hide a pending edit.
            val cached = try {
                cache.itemGet(itemMgr, notebookUid, noteUid)
                    ?.takeIf { !it.item.isDeleted && isMarkdownNote(it.meta.itemType) }
                    ?.let { NoteContent(it.item.uid, titleOf(it.item.metaRaw), it.content, it.meta.mtime) }
            } catch (e: EtebaseException) {
                Logger.log.warning("Skipping a note that could not be decoded: ${e.javaClass.name}")
                null
            }
            NotesOverlay.note(noteUid, notebookUid, cached, pending.observed.read, pending.observed.sequence, isWritable(collection.col)) { entry ->
                decrypt(notebookSource(colMgr, pending.notebookCopy, collection.col, notebookUid), entry, keepBody = true)
            }
        }
    }

    /** Whether a Notes sync has ever succeeded for this account generation. Reads storage: call off the main thread. */
    fun everSynced(context: Context, account: Account, creationId: String): Boolean {
        val store = SyncStatusStore(context.applicationContext)
        return store.status(store.identity(account, creationId), SyncStatusStore.Service.NOTES).lastSuccessAt != null
    }

    /** What the notebook screen read under the pending lock, with the stored notebook copy. */
    private class PendingRead(val snapshot: PendingNotesStore.Snapshot, val notebookCopy: ByteArray?)

    /** What the viewer read under the pending lock, with the stored notebook copy. */
    private class ObservedRead(val observed: PendingNotesStore.Observed, val notebookCopy: ByteArray?)

    /** The same rule as the lists and the runner: a deleted notebook is gone, and a read-only one shows only the server version. */
    private fun isWritable(col: Collection): Boolean =
        NotePushPolicy.acceptsWrites(col.isDeleted, col.accessLevel == CollectionAccessLevel.ReadOnly)

    private fun notebookCopy(store: PendingNotesStore, notebookUid: String): ByteArray? = try {
        store.notebook(notebookUid)
    } catch (e: IOException) {
        Logger.log.warning("The stored copy of a notebook could not be read: ${e.javaClass.name}")
        null
    }

    /**
     * The notebook pending edits are decrypted through: the copy the store keeps (design 3.1), so the
     * text stays readable after the Etebase cache drops the notebook. The live collection, which uses the
     * same key, stands in when the copy is missing or cannot be loaded; on these paths it is always there.
     */
    private fun notebookSource(colMgr: CollectionManager, copy: ByteArray?, live: Collection, notebookUid: String): ItemManager {
        val loaded = copy?.let {
            try {
                colMgr.cacheLoad(it)
            } catch (e: EtebaseException) {
                Logger.log.warning("The stored copy of a notebook could not be loaded: ${e.javaClass.name}")
                null
            }
        }
        if (copy == null) Logger.log.warning("No stored copy of a notebook with pending notes; using the cached one")
        return colMgr.getItemManager(loaded ?: live)
    }

    /** One pending edit, decrypted; null when it cannot be read. The body is kept only for the viewer. */
    private fun decrypt(itemMgr: ItemManager, entry: PendingEntry, keepBody: Boolean): NotesOverlay.Decrypted? = try {
        val item = itemMgr.cacheLoad(entry.blob)
        val meta = item.meta
        val content = item.contentString
        NotesOverlay.Decrypted(titleOf(item.metaRaw), previewOf(content), if (keepBody) content else null, meta.mtime)
    } catch (e: EtebaseException) {
        Logger.log.warning("A pending note could not be read: ${e.javaClass.name}")
        null
    }

    /**
     * A note is an item with a missing or empty type; any other type, including one of only
     * spaces, is something else (isMarkdownNoteItem in packages/core/src/models/note.ts).
     */
    internal fun isMarkdownNote(itemType: String?): Boolean = itemType.isNullOrEmpty()

    /**
     * A note's title from its raw metadata bytes, never through the binding's typed string: by the
     * platform source Android 5.0 and 5.1 do not decode characters above U+FFFF there, and a debuggable
     * build on 5.0 aborted (design decision 5). Blank, which the screens show as "Untitled", when the
     * bytes are not one map or give no name this app can trust (missing, nil, repeated, under a key
     * another client reads as the name, not a string, or not UTF-8).
     */
    internal fun titleOf(metaRaw: ByteArray?): String = NoteMetaCodec.peek(metaRaw)?.name?.trim().orEmpty()

    /** First meaningful line of the Markdown body, without list or heading markers. */
    internal fun previewOf(body: String): String {
        val line = body.lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() } ?: return ""
        return line
            .trimStart('#', '>', '-', '*', ' ')
            .replace(Regex("^\\d+\\.\\s+"), "")
            .take(140)
    }

    internal fun sortNotes(notes: List<NoteRow>): List<NoteRow> =
        notes.sortedWith(compareByDescending<NoteRow> { it.editedAt ?: Long.MIN_VALUE }.thenBy { it.title.lowercase() })

    private fun notebookRows(cache: EtebaseLocalCache, colMgr: CollectionManager): List<NotebookRow> =
        cache.decodableCollectionList(colMgr, Constants.ETEBASE_TYPE_NOTES) { _, error ->
            // The binding's message can quote a decrypted value; log only the exception class.
            Logger.log.warning("Skipping a notebook that could not be decoded: ${error.javaClass.name}")
        }
            .map { cached ->
                val meta = cached.meta
                NotebookRow(
                    uid = cached.col.uid,
                    name = meta.name.orEmpty(),
                    description = meta.description.orEmpty(),
                    color = LocalCalendar.parseColorOrNull(meta.color),
                    readOnly = cached.col.accessLevel == CollectionAccessLevel.ReadOnly,
                    shared = cached.col.accessLevel != CollectionAccessLevel.Admin,
                )
            }
            .sortedBy { it.name.lowercase() }

    /** What was read from the pending store, kept apart from null so a null result still counts as read. */
    private class PendingValue<P>(val value: P)

    /**
     * Reads the pending store, then the cache. [whenCacheFails], when given, turns what the store read
     * into a result if anything after it fails (the session, the cache, or [block] throwing), so a screen
     * that can still show the local changes does not report plain failure.
     */
    private fun <P, T : Any> load(
        context: Context,
        account: Account,
        creationId: String,
        readPending: (PendingNotesStore) -> P,
        whenCacheFails: ((P) -> T)? = null,
        block: (EtebaseLocalCache, CollectionManager, P) -> T?,
    ): NotesLoad<T> {
        val appContext = context.applicationContext
        val manager = AccountManager.get(appContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return NotesLoad.Stale
        var pending: PendingValue<P>? = null
        return try {
            // The pending store is read first: before the session and the cache, so what it holds can
            // still be shown if they fail, and never while holding the cache monitor or the cache's write
            // fence (the pending lock is never held together with either). This order is safe only
            // because of a rule on the runner: before any store change that lets a note fall back to the
            // cache (dropping an entry after a push, the conflict drops, removing an original for a
            // conflict copy, holding text for a repeated conflict or because the note could not be built),
            // it writes the server item it holds, deleted ones included, into the cache
            // under the cache monitor and, inside it, through the run's SyncRunGuard.write (which takes
            // the write fence), without holding the pending lock, and keeps the entry if that write
            // fails or is refused because the run is no longer current. A load then sees either the
            // entry or a cache at least as new, so a change that just landed can show as waiting until
            // the next reload, but older server text, or a note deleted here, never comes back in its
            // place.
            val read = readPending(PendingNotesStore.forIdentity(appContext, account.type, account.name, creationId))
            pending = PendingValue(read)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            // Settings, cache, and session are account-name keyed: revalidate around every read.
            val settings = AccountSettings(appContext, account)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            val cache = EtebaseLocalCache.getInstance(appContext, account.name)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            // Account.restore is offline; reading the cache never touches the network.
            val etebase = EtebaseLocalCache.getEtebase(appContext, HttpClient.sharedClient, settings)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            val value = synchronized(cache) {
                if (!exactGenerationStillCurrent()) null else block(cache, etebase.collectionManager, read)
            }
            when {
                !exactGenerationStillCurrent() -> NotesLoad.Stale
                value == null -> NotesLoad.Failed
                else -> NotesLoad.Loaded(value)
            }
        } catch (_: InvalidAccountException) {
            // The row vanished between the generation check and the settings read: stale, not an error.
            NotesLoad.Stale
        } catch (e: OutOfMemoryError) {
            // Very large notes: fail this screen, as the Notes runner does, rather than the app.
            Logger.log.log(Level.WARNING, "Notes were too large to read", e)
            if (exactGenerationStillCurrent()) NotesLoad.Failed else NotesLoad.Stale
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.log(Level.WARNING, "Notes could not be read from the local cache", e)
            val read = pending
            when {
                !exactGenerationStillCurrent() -> NotesLoad.Stale
                read != null && whenCacheFails != null -> NotesLoad.Loaded(whenCacheFails(read.value))
                else -> NotesLoad.Failed
            }
        }
    }
}
