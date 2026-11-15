package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.VisibleForTesting
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
import io.silentsuite.sync.notes.NotesNetwork
import io.silentsuite.sync.notes.NotesNetworkPolicy
import io.silentsuite.sync.notes.edit.HeldReason
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
 * Why a screen shows the cached notes without the local changes. UNREADABLE: the account's pending store could not
 * be opened, listed or read. DISCARD_STOPPED: a discard of the whole store stopped in this process (the sign-out's
 * or the one in Settings, Unsynced Notes), so the store stays closed and what it still holds is for that discard to
 * finish. Either way the screen says so, never that there are no local changes.
 */
enum class PendingUnavailable { UNREADABLE, DISCARD_STOPPED }

/**
 * The notebook list, and how many local changes belong in the Unsynced text screen instead. [failed]
 * means the notebooks could not be read, though the local changes were, so they still count.
 * [pendingUnreadable] means the local changes could not be listed, and [discardStopped] that a discard of
 * them stopped: the list says so, never that there are none ([unsyncedText] is then 0 and counts nothing).
 */
data class NotebookOverview(
    val notebooks: List<NotebookRow>,
    val unsyncedText: Int,
    val failed: Boolean = false,
    val pendingUnreadable: Boolean = false,
    val discardStopped: Boolean = false,
)

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
     * The pending store's sequence when this was loaded, set whether or not an entry existed. For the
     * editor, which is to drop a load below its last saved version: that load read the store before the
     * save.
     */
    val observedSequence: Long = 0,
    /** Set when the local changes could not be laid over this note: it is the cached copy, and the viewer says why. */
    val pending: PendingUnavailable? = null,
)

/**
 * [unreadable] counts items the cache holds for this notebook that could not be decoded. [pending] is set when the
 * local changes could not be laid over the cached notes: the list shows them without, and says why.
 */
data class NotebookContents(
    val notebook: NotebookRow,
    val notes: List<NoteRow>,
    val unreadable: Int = 0,
    val pending: PendingUnavailable? = null,
)

/**
 * One row of the Unsynced text screen: local text the notebook list does not show, as one entry file.
 * [noteUid] is null when the file names no note. [version] is the entry's version as read, or null when
 * the file cannot be read; a discard is checked against it ([PendingNotesStore.discard]). [held] is the
 * reason for held text, or null for a change whose notebook is read-only, gone or not shown, and for a
 * file that cannot be read. [body] is null when the text cannot be read here; [title] is then null too.
 * [discardConfirmed]: the store's discard permit names this text, which the user confirmed for a discard of the
 * whole store that has not finished ([PendingNotesStore.Snapshot.discardConfirmed]); it is never sent.
 * [permitUnchecked]: the permit could not be read, so the store holds this text back without the user having named
 * it ([PendingNotesStore.Snapshot.permitUnreadable]). [mayStillSync]: a Notes run can still send this text
 * ([NotesOverlay.mayStillSync]). [digest] names the text shown ([PendingNotesStore.digestOf]), for a discard to
 * check. [damaged]: for a file that cannot be read, its whole-file checksum fails
 * ([PendingNotesStore.Read.Unreadable.damaged]).
 */
internal data class HeldTextRow(
    val file: String,
    val noteUid: String?,
    val notebookUid: String?,
    val notebookName: String?,
    val version: Long?,
    val held: HeldReason?,
    val title: String?,
    val body: String?,
    val discardConfirmed: Boolean = false,
    val mayStillSync: Boolean = false,
    val digest: String? = null,
    val damaged: Boolean = false,
    val permitUnchecked: Boolean = false,
) {
    /** Copy needs the text, decrypted here. */
    val canCopy: Boolean get() = body != null

    /**
     * Try again ([PendingNotesStore.release]) applies only to held text that no unfinished discard covers, and that
     * the permit does not hold back.
     */
    val canTryAgain: Boolean get() = held != null && version != null && !discardConfirmed && !permitUnchecked

    /**
     * One note's own file goes on its own only when the user can see what goes and no run will ever send it, the rule
     * the store enforces again under its lock ([PendingNotesStore.discard]): readable text that is held, or that the
     * permit names or holds back, or a file whose whole-file checksum fails. A change a run may send offers Copy only
     * until a run holds it; text that cannot be shown right now, a file that cannot be read for another reason, and
     * any other file go only with the whole store, in Settings.
     */
    val canDiscard: Boolean get() {
        val uid = noteUid ?: return false
        if (file != "$uid.note" || !PendingNotesStore.isNoteUid(uid)) return false
        return if (version == null) damaged else body != null && digest != null && (held != null || discardConfirmed || permitUnchecked)
    }
}

/**
 * What the Unsynced text screen shows. [notebooksFailed]: the notebooks could not be read, so every change is here.
 * [pending]: the local changes could not be read at all, and the screen says why.
 */
internal data class HeldTexts(
    val rows: List<HeldTextRow>,
    val notebooksFailed: Boolean = false,
    val pending: PendingUnavailable? = null,
)

/** Every private read reports whether the exact account generation still owns the result. */
sealed class NotesLoad<out T> {
    data class Loaded<T>(val value: T) : NotesLoad<T>()
    object Stale : NotesLoad<Nothing>()
    object Failed : NotesLoad<Nothing>()
}

/**
 * What the notebook list's network line is decided on: the account's two Notes network settings,
 * the account's own Wi-Fi rule, and one reading of the network the device reports. Not a data class
 * on purpose: the account rule holds the saved network name, and nothing should print it.
 */
internal class NotesNetworkState(
    val settings: NotesNetworkPolicy.Settings,
    val account: NotesNetworkPolicy.AccountRule,
    val reading: NotesNetworkPolicy.Reading,
)

/** Process-local presentation data used by runtime tests; never persisted. */
internal data class NotesRuntimeFixture(
    val notebooks: List<NotebookRow>,
    val notes: Map<String, List<NoteContent>>,
    val unsyncedText: Int = 0,
    val unreadable: Map<String, Int> = emptyMap(),
    val held: List<HeldTextRow> = emptyList(),
)

@Volatile
internal var notesFixtureOverride: ((Context, Account, String) -> NotesRuntimeFixture?)? = null

/** Device tests only: runs in each load after the local changes were read and before the cache is, with no lock held. */
@VisibleForTesting
internal var afterLocalChangesReadForTesting: (() -> Unit)? = null

/**
 * Reads notebooks and notes from the local Etebase cache, with unpushed local changes from the pending
 * store laid over them ([NotesOverlay]). Everything here is offline: the session is restored without a
 * network call and the cache decrypts on read. Sync is the coordinator's job. Every function reads
 * storage: call off the main thread.
 */
internal object NotesLoader {
    fun notebooks(context: Context, account: Account, creationId: String): NotesLoad<NotebookOverview> {
        notesFixtureOverride?.let { fixture ->
            return fixture(context, account, creationId)?.let { NotesLoad.Loaded(NotebookOverview(it.notebooks, it.unsyncedText)) }
                ?: NotesLoad.Stale
        }
        // Headers are enough to count, so no blob is kept and nothing is decrypted for the list. A store
        // that cannot be read, or whose discard stopped, is read as such, never as empty: the list then
        // says so (load). When anything after the store read fails, the local changes were still read, so
        // the way to them stays on screen (design 3.5): every change then counts as unsynced text.
        fun overview(rows: List<NotebookRow>, access: List<NotesOverlay.NotebookAccess>,
                     pending: Pending<PendingNotesStore.Snapshot>, failed: Boolean) = when (pending) {
            is Pending.Read -> pending.value.let { snapshot ->
                NotesOverlay.notebooks(rows, access, snapshot.headers,
                    NotesOverlay.unreadableEntries(snapshot.unreadable, snapshot.headers), failed,
                    confirmed = snapshot.discardConfirmed, otherUnreadable = NotesOverlay.unreadableOthers(snapshot.unreadable).size)
            }
            Pending.Unreadable -> NotebookOverview(rows, 0, failed, pendingUnreadable = true)
            Pending.DiscardStopped -> NotebookOverview(rows, 0, failed, discardStopped = true)
            Pending.Cleared -> NotebookOverview(rows, 0, failed)
        }
        val onlyPending = { pending: Pending<PendingNotesStore.Snapshot> -> overview(emptyList(), emptyList(), pending, failed = true) }
        return load(context, account, creationId, { store -> store.snapshot { false } }, onlyPending) { cache, colMgr, pending ->
            val rows = try {
                notebookRows(cache, colMgr)
            } catch (e: EtebaseException) {
                Logger.log.log(Level.WARNING, "Notebooks could not be read from the local cache", e)
                return@load onlyPending(pending)
            }
            overview(rows, access(cache, colMgr), pending, failed = false)
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
            val hasEdits = snapshot.entries.isNotEmpty()
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
            // Without the local changes, the cached notes show as they are, and the list says why.
            val read = (pending as? Pending.Read)?.value
                ?: return@load NotebookContents(row, sortNotes(notes), unreadable.size, pending.unavailable())
            val source by lazy { notebookSource(colMgr, read.notebookCopy, collection.col, notebookUid) }
            NotesOverlay.notebook(row, isWritable(collection.col), notes, unreadable, read.snapshot.headers,
                NotesOverlay.unreadableEntries(read.snapshot.unreadable, read.snapshot.headers),
                confirmed = read.snapshot.discardConfirmed) { header ->
                read.snapshot.entries[header.noteUid]?.let { decrypt(source, it, keepBody = false) }
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
            // Without the local changes, the cached copy shows, and the viewer says why.
            val read = (pending as? Pending.Read)?.value ?: return@load cached?.copy(pending = pending.unavailable())
            NotesOverlay.note(noteUid, notebookUid, cached, read.observed.read, read.observed.sequence, isWritable(collection.col),
                confirmed = read.observed.discardConfirmed) { entry ->
                decrypt(notebookSource(colMgr, read.notebookCopy, collection.col, notebookUid), entry, keepBody = true)
            }
        }
    }

    /**
     * What the Unsynced text screen shows: every local change the notebook list counts there ([NotesOverlay.unsynced]),
     * with its text where it can be read. Held text is read whole in the first store read; a change whose notebook
     * turns out not to accept writes is read after the cache, one entry at a time, so the other entries' blobs are
     * never held. Text is decrypted through the notebook copy the store keeps, with the cached notebook as the
     * stand-in, and the account's local keys: no network and no request.
     */
    fun heldText(context: Context, account: Account, creationId: String): NotesLoad<HeldTexts> {
        notesFixtureOverride?.let { fixture ->
            return fixture(context, account, creationId)?.let { NotesLoad.Loaded(HeldTexts(it.held)) } ?: NotesLoad.Stale
        }
        val readPending = { store: PendingNotesStore -> store to store.snapshot { it.state == PendingEntry.State.HELD } }
        // With no notebook read, every change is listed. [colMgr] is there when only the notebooks failed, so the
        // text can still be decrypted through the stored notebook copies.
        fun allChanges(pending: Pending<Pair<PendingNotesStore, PendingNotesStore.Snapshot>>, colMgr: CollectionManager?) =
            when (pending) {
                is Pending.Read -> pending.value.let { (store, snapshot) ->
                    HeldPlan(store, snapshot, NotesOverlay.unsynced(emptyList(), emptyList(), snapshot.headers, snapshot.discardConfirmed),
                        emptyMap(), emptyMap(), colMgr, failed = true)
                }
                else -> HeldPlan(null, null, emptyList(), emptyMap(), emptyMap(), null, failed = true, pending = pending.unavailable())
            }
        val onlyPending = { pending: Pending<Pair<PendingNotesStore, PendingNotesStore.Snapshot>> -> allChanges(pending, null) }
        val plan = load(context, account, creationId, readPending, onlyPending) { cache, colMgr, pending ->
            val (store, snapshot) = (pending as? Pending.Read)?.value
                ?: return@load HeldPlan(null, null, emptyList(), emptyMap(), emptyMap(), null, pending = pending.unavailable())
            val rows = try {
                notebookRows(cache, colMgr)
            } catch (e: EtebaseException) {
                Logger.log.log(Level.WARNING, "Notebooks could not be read from the local cache", e)
                return@load allChanges(pending, colMgr)
            }
            val access = access(cache, colMgr)
            val headers = NotesOverlay.unsynced(rows, access, snapshot.headers, snapshot.discardConfirmed)
            val live = HashMap<String, Collection>()
            for (uid in headers.mapTo(HashSet()) { it.notebookUid }) {
                if (access.none { it.uid == uid }) continue
                try {
                    live[uid] = cache.collectionGet(colMgr, uid).col
                } catch (e: EtebaseException) {
                    Logger.log.warning("A cached notebook could not be read: ${e.javaClass.name}")
                }
            }
            val writable = access.filter { NotePushPolicy.acceptsWrites(it.deleted, it.readOnly) }.mapTo(HashSet()) { it.uid }
            HeldPlan(store, snapshot, headers, rows.associate { it.uid to it.name }, live, colMgr, writable = writable)
        }
        return when (plan) {
            NotesLoad.Stale -> NotesLoad.Stale
            NotesLoad.Failed -> NotesLoad.Failed
            // The rest reads the store again and decrypts, outside the cache monitor. A store that a discard
            // closed meanwhile, or that cannot be read now, is said to be so, as in load().
            is NotesLoad.Loaded -> guarded(context, account, creationId) {
                val held = plan.value
                try {
                    heldRows(held)
                } catch (_: PendingNotesStore.Cleared) {
                    HeldTexts(emptyList(), held.failed, if (held.store?.clearStopped() == true) PendingUnavailable.DISCARD_STOPPED else null)
                } catch (e: IOException) {
                    Logger.log.warning("Local Notes changes could not be read: ${e.javaClass.name}")
                    HeldTexts(emptyList(), held.failed, PendingUnavailable.UNREADABLE)
                }
            }
        }
    }

    /** Whether a Notes sync has ever succeeded for this account generation. Reads storage: call off the main thread. */
    fun everSynced(context: Context, account: Account, creationId: String): Boolean {
        val store = SyncStatusStore(context.applicationContext)
        return store.status(store.identity(account, creationId), SyncStatusStore.Service.NOTES).lastSuccessAt != null
    }

    /**
     * What the notebook list's network line is decided on (NotesNetworkPolicy.notice), or null when
     * the account row is gone or the platform's answer could not be read; the list then shows no
     * line. Reads account data and asks the platform which network it reports: call off the main
     * thread. It sends nothing. The account data is read by account name, so the caller keeps the
     * result only for the exact account generation it has checked itself. The Wi-Fi name is never
     * read, as in a run (NotesNetwork.read).
     */
    fun network(context: Context, account: Account): NotesNetworkState? = try {
        val appContext = context.applicationContext
        val accountSettings = AccountSettings(appContext, account)
        val rule = NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)
        NotesNetworkState(AccountSettings.notesNetworkSettings(AccountManager.get(appContext), account), rule,
            NotesNetwork.read(appContext))
    } catch (_: InvalidAccountException) {
        // The account row is gone. The load made with this reading ends as stale.
        null
    } catch (e: RuntimeException) {
        // The class only: a platform message could name a network.
        Logger.log.warning("The network could not be read for the notebook list: ${e.javaClass.name}")
        null
    }

    /** What the notebook screen read under the pending lock, with the stored notebook copy. */
    private class PendingRead(val snapshot: PendingNotesStore.Snapshot, val notebookCopy: ByteArray?)

    /** What the viewer read under the pending lock, with the stored notebook copy. */
    private class ObservedRead(val observed: PendingNotesStore.Observed, val notebookCopy: ByteArray?)

    /**
     * What the Unsynced text screen read in its first two steps: [colMgr] is null when no session could be restored;
     * [store] and [snapshot] are null when the local changes could not be read, and [pending] says why.
     */
    private class HeldPlan(
        val store: PendingNotesStore?,
        val snapshot: PendingNotesStore.Snapshot?,
        val headers: List<PendingNotesStore.EntryHeader>,
        val names: Map<String, String>,
        val live: Map<String, Collection>,
        val colMgr: CollectionManager?,
        val failed: Boolean = false,
        val pending: PendingUnavailable? = null,
        /** The notebooks that accept writes, or null when they are not known (the notebooks could not be read). */
        val writable: Set<String>? = null,
    )

    /**
     * What a load read of the account's local changes ([load]). [Read]: what readPending returned. [Unreadable]: the
     * store could not be opened, listed or read. [DiscardStopped]: a discard of the whole store stopped in this
     * process, so the store stays closed ([PendingNotesStore.clearStopped]). [Cleared]: a discard of the whole store
     * finished, so nothing is left to show.
     */
    private sealed class Pending<out P> {
        class Read<P>(val value: P) : Pending<P>()
        object Unreadable : Pending<Nothing>()
        object DiscardStopped : Pending<Nothing>()
        object Cleared : Pending<Nothing>()

        /** What the screen says about local changes it could not lay over the cache; null when there are none. */
        fun unavailable(): PendingUnavailable? = when (this) {
            is Read -> null
            Unreadable -> PendingUnavailable.UNREADABLE
            DiscardStopped -> PendingUnavailable.DISCARD_STOPPED
            Cleared -> null
        }
    }

    /** The notebooks as the runner sees them, from the cached collections without decoding their metadata. */
    private fun access(cache: EtebaseLocalCache, colMgr: CollectionManager): List<NotesOverlay.NotebookAccess> =
        cache.collections(colMgr, withDeleted = true, type = Constants.ETEBASE_TYPE_NOTES)
            .map { NotesOverlay.NotebookAccess(it.uid, it.isDeleted, it.accessLevel == CollectionAccessLevel.ReadOnly) }

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
     * same key, stands in when the copy is missing or cannot be loaded. Null when neither is there.
     */
    private fun notebookSource(colMgr: CollectionManager, copy: ByteArray?, live: Collection?, notebookUid: String): ItemManager? {
        val loaded = copy?.let {
            try {
                colMgr.cacheLoad(it)
            } catch (e: EtebaseException) {
                Logger.log.warning("The stored copy of a notebook could not be loaded: ${e.javaClass.name}")
                null
            }
        }
        if (copy == null) Logger.log.warning("No stored copy of a notebook with pending notes; using the cached one")
        return (loaded ?: live)?.let { colMgr.getItemManager(it) }
    }

    /** One pending edit, decrypted; null when it cannot be read. The body is kept only for the viewer and the Unsynced text screen. */
    private fun decrypt(itemMgr: ItemManager?, entry: PendingEntry, keepBody: Boolean): NotesOverlay.Decrypted? = try {
        itemMgr?.let {
            val item = it.cacheLoad(entry.blob)
            val meta = item.meta
            val content = item.contentString
            NotesOverlay.Decrypted(titleOf(item.metaRaw), previewOf(content), if (keepBody) content else null, meta.mtime)
        }
    } catch (e: EtebaseException) {
        Logger.log.warning("A pending note could not be read: ${e.javaClass.name}")
        null
    }

    /** The Unsynced text rows from [plan]: store reads and decryption, never under the cache monitor. */
    private fun heldRows(plan: HeldPlan): HeldTexts {
        val store = plan.store
        val snapshot = plan.snapshot
        if (store == null || snapshot == null) return HeldTexts(emptyList(), plan.failed, plan.pending)
        val copies = HashMap<String, ByteArray?>()
        val rows = ArrayList<HeldTextRow>()
        for (header in plan.headers) {
            val entry = snapshot.entries[header.noteUid] ?: when (val read = store.read(header.noteUid)) {
                is PendingNotesStore.Read.Present -> read.entry
                is PendingNotesStore.Read.Unreadable -> {
                    rows += HeldTextRow(read.file, header.noteUid, read.notebookUid ?: header.notebookUid,
                        plan.names[header.notebookUid], null, null, null, null, damaged = read.damaged)
                    continue
                }
                // Gone since the listing: nothing to show.
                PendingNotesStore.Read.Missing -> continue
            }
            val text = plan.colMgr?.let { colMgr ->
                val copy = copies.getOrPut(entry.notebookUid) { notebookCopy(store, entry.notebookUid) }
                decrypt(notebookSource(colMgr, copy, plan.live[entry.notebookUid], entry.notebookUid), entry, keepBody = true)
            }
            // A save between the snapshot and this read withdrew the permit and wrote a new version: the snapshot's
            // confirmation holds only for the version it saw.
            val confirmed = entry.noteUid in snapshot.discardConfirmed && entry.version == header.version
            rows += HeldTextRow("${entry.noteUid}.note", entry.noteUid, entry.notebookUid, plan.names[entry.notebookUid],
                entry.version, entry.held?.reason, text?.title, text?.body,
                discardConfirmed = confirmed && !snapshot.permitUnreadable,
                mayStillSync = NotesOverlay.mayStillSync(entry.state, entry.noteUid, entry.notebookUid, plan.writable,
                    if (confirmed) setOf(entry.noteUid) else emptySet()),
                digest = PendingNotesStore.digestOf(entry.blob),
                permitUnchecked = confirmed && snapshot.permitUnreadable)
        }
        // Entry files that cannot be read, one row per note as the list counts them ([NotesOverlay.unreadableEntries]).
        // The row names the note's own file when that is one of them, since only that file can go on its own.
        val notebooks = NotesOverlay.unreadableEntries(snapshot.unreadable, snapshot.headers)
        for ((uid, notebookUid) in notebooks) {
            val files = snapshot.unreadable.map { it.file }.filter { NotesOverlay.entryUid(it) == uid }
            val file = files.firstOrNull { it == "$uid.note" } ?: files.first()
            val damaged = snapshot.unreadable.any { it.file == file && it.damaged }
            rows += HeldTextRow(file, uid, notebookUid, notebookUid?.let { plan.names[it] }, null, null, null, null, damaged = damaged)
        }
        // Other files that cannot be read name no note: one row each, which only the whole store's discard can clear.
        for (file in NotesOverlay.unreadableOthers(snapshot.unreadable)) {
            rows += HeldTextRow(file, null, null, null, null, null, null, null)
        }
        return HeldTexts(rows.sortedBy { it.file }, plan.failed)
    }

    /**
     * A note is an item with a missing or empty type; any other type, including one of only
     * spaces, is something else (isMarkdownNoteItem in packages/core/src/models/note.ts).
     */
    internal fun isMarkdownNote(itemType: String?): Boolean = itemType.isNullOrEmpty()

    /**
     * A note's title from its raw metadata bytes through [NoteMetaCodec.peek], not the binding's typed
     * name. This is the rule the push step reads a name back with (EtebasePushRemote), and it is close
     * to how the web reads one (NoteMetaCodec). The typed decoder also takes a name under an integer
     * or binary key, next to a key the web reads as the name, stored as binary data, or from input
     * that is not exactly one map (trailing bytes, an array read by position); the device comparison
     * in androidTest NoteMetaBindingComparison records these rows. peek trusts none of them.
     * Blank, which the screens show as "Untitled", when the bytes are not one map or give no name this
     * app can trust.
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

    /**
     * [block] for the exact account generation, with the same checks and failures as [load], for a step that
     * reads the store again after the cache.
     */
    private fun <T : Any> guarded(context: Context, account: Account, creationId: String, block: () -> T): NotesLoad<T> {
        val manager = AccountManager.get(context.applicationContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return NotesLoad.Stale
        return try {
            val value = block()
            if (exactGenerationStillCurrent()) NotesLoad.Loaded(value) else NotesLoad.Stale
        } catch (e: OutOfMemoryError) {
            Logger.log.log(Level.WARNING, "Notes were too large to read", e)
            if (exactGenerationStillCurrent()) NotesLoad.Failed else NotesLoad.Stale
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.log(Level.WARNING, "Local Notes changes could not be read", e)
            if (exactGenerationStillCurrent()) NotesLoad.Failed else NotesLoad.Stale
        }
    }

    /**
     * Reads the account's local changes once, as [load] does: [readPending] on the store, opened for this load
     * only. A store that cannot be opened, listed or read is [Pending.Unreadable]. A store a discard closed is
     * [Pending.DiscardStopped] while that discard stopped, and [Pending.Cleared] once one finished. The account
     * generation is checked by the caller, so a store cleared by a sign-out whose account is gone still reads as
     * stale there.
     */
    private fun <P> readLocalChanges(
        appContext: Context,
        account: Account,
        creationId: String,
        readPending: (PendingNotesStore) -> P,
    ): Pair<PendingNotesStore?, Pending<P>> {
        val store = try {
            PendingNotesStore.forIdentity(appContext, account.type, account.name, creationId)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.warning("The local Notes changes could not be opened: ${e.javaClass.name}")
            return null to Pending.Unreadable
        }
        return store to try {
            Pending.Read(readPending(store))
        } catch (_: PendingNotesStore.Cleared) {
            if (store.clearStopped()) Pending.DiscardStopped else Pending.Cleared
        } catch (e: IOException) {
            Logger.log.warning("The local Notes changes could not be read: ${e.javaClass.name}")
            Pending.Unreadable
        }
    }

    /**
     * Reads the pending store, then the cache. [whenCacheFails], when given, turns what the store read
     * into a result if anything after it fails (the session, the cache, or [block] throwing), so a screen
     * that can still show the local changes does not report plain failure. Local changes that could not be
     * read, or that a stopped discard holds, never fail or close the screen while the account generation is
     * current: [block] gets [Pending] and shows the cached notes with the reason. A whole-store discard that
     * closes the store while this load reads the cache makes it read again, once, so discarded text is not shown.
     */
    private fun <P, T : Any> load(
        context: Context,
        account: Account,
        creationId: String,
        readPending: (PendingNotesStore) -> P,
        whenCacheFails: ((Pending<P>) -> T)? = null,
        again: Boolean = true,
        block: (EtebaseLocalCache, CollectionManager, Pending<P>) -> T?,
    ): NotesLoad<T> {
        val appContext = context.applicationContext
        val manager = AccountManager.get(appContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return NotesLoad.Stale
        var pending: Pending<P>? = null
        var opened: PendingNotesStore? = null
        // Memory only, under the store lock: a discard that closed the store after it was read. Checked once the
        // cache was read, and also when that failed, so a screen never shows text that was just discarded.
        fun discardedSinceRead() = again && pending is Pending.Read && opened?.let { it.clearStopped() || it.clearedInFull() } == true
        return try {
            // The pending store is read first: before the session and the cache, so what it holds can
            // still be shown if they fail, and never while holding the cache monitor or the cache's write
            // fence (the pending lock is never held together with either). It is opened for this load
            // only; no instance is kept between loads. This order is safe only because of a rule on the
            // runner: before any store change that lets a note fall back to the cache (dropping an entry
            // after a push, the drop after a conflict that found the upload had landed, removing an
            // original for a conflict copy, holding text for a repeated conflict or because the note
            // could not be built), it writes the server item it holds, deleted ones included, into the
            // cache under the cache monitor and, inside it, through the run's SyncRunGuard.write (which
            // takes the write fence), without holding the pending lock, and keeps the entry if that write
            // fails or is refused because the run is no longer current. A load then sees either the entry
            // or a cache at least as new, so a change that just landed can show as waiting until the next
            // reload, but older server text, or a note deleted elsewhere, never comes back in its place.
            val (store, read) = readLocalChanges(appContext, account, creationId, readPending)
            pending = read
            opened = store
            afterLocalChangesReadForTesting?.invoke()
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
            if (discardedSinceRead()) return load(context, account, creationId, readPending, whenCacheFails, again = false, block)
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
                discardedSinceRead() -> load(context, account, creationId, readPending, whenCacheFails, again = false, block)
                read != null && whenCacheFails != null -> NotesLoad.Loaded(whenCacheFails(read))
                else -> NotesLoad.Failed
            }
        }
    }
}
