package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
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
import io.silentsuite.sync.notes.edit.NoteMetaCodec
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.util.logging.Level

/** A notebook row as shown in the Notes screen; mirrors the dashboard's collection markers. */
data class NotebookRow(
    val uid: String,
    val name: String,
    val description: String,
    val color: Int?,
    val readOnly: Boolean,
    val shared: Boolean,
)

data class NoteRow(val uid: String, val title: String, val preview: String, val editedAt: Long?)

data class NoteContent(val uid: String, val title: String, val body: String, val editedAt: Long?)

/** [unreadable] counts items the cache holds for this notebook that could not be decoded. */
data class NotebookContents(val notebook: NotebookRow, val notes: List<NoteRow>, val unreadable: Int = 0)

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
    val unreadable: Map<String, Int> = emptyMap(),
)

@Volatile
internal var notesFixtureOverride: ((Context, Account, String) -> NotesRuntimeFixture?)? = null

/**
 * Reads notebooks and notes from the local Etebase cache. Everything here is offline: the session
 * is restored without a network call and the cache decrypts on read. Sync is the coordinator's job.
 */
internal object NotesLoader {
    fun notebooks(context: Context, account: Account, creationId: String): NotesLoad<List<NotebookRow>> {
        notesFixtureOverride?.let { fixture ->
            return fixture(context, account, creationId)?.let { NotesLoad.Loaded(it.notebooks) } ?: NotesLoad.Stale
        }
        return load(context, account, creationId) { cache, colMgr -> notebookRows(cache, colMgr) }
    }

    fun notebook(context: Context, account: Account, creationId: String, notebookUid: String): NotesLoad<NotebookContents> {
        notesFixtureOverride?.let { fixture ->
            val data = fixture(context, account, creationId) ?: return NotesLoad.Stale
            val row = data.notebooks.firstOrNull { it.uid == notebookUid } ?: return NotesLoad.Failed
            val notes = data.notes[notebookUid].orEmpty().map { NoteRow(it.uid, it.title, previewOf(it.body), it.editedAt) }
            return NotesLoad.Loaded(NotebookContents(row, sortNotes(notes), data.unreadable[notebookUid] ?: 0))
        }
        return load(context, account, creationId) { cache, colMgr ->
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
            NotebookContents(row, sortNotes(notes), unreadable.size)
        }
    }

    fun note(context: Context, account: Account, creationId: String, notebookUid: String, noteUid: String): NotesLoad<NoteContent> {
        notesFixtureOverride?.let { fixture ->
            val data = fixture(context, account, creationId) ?: return NotesLoad.Stale
            return data.notes[notebookUid]?.firstOrNull { it.uid == noteUid }?.let { NotesLoad.Loaded(it) } ?: NotesLoad.Failed
        }
        return load(context, account, creationId) { cache, colMgr ->
            val collection = cache.collectionGet(colMgr, notebookUid)
            val itemMgr = colMgr.getItemManager(collection.col)
            val cached = cache.itemGet(itemMgr, notebookUid, noteUid) ?: return@load null
            if (cached.item.isDeleted || !isMarkdownNote(cached.meta.itemType)) return@load null
            NoteContent(cached.item.uid, titleOf(cached.item.metaRaw), cached.content, cached.meta.mtime)
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

    private fun <T : Any> load(
        context: Context,
        account: Account,
        creationId: String,
        block: (EtebaseLocalCache, CollectionManager) -> T?,
    ): NotesLoad<T> {
        val appContext = context.applicationContext
        val manager = AccountManager.get(appContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return NotesLoad.Stale
        return try {
            // Settings, cache, and session are account-name keyed: revalidate around every read.
            val settings = AccountSettings(appContext, account)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            val cache = EtebaseLocalCache.getInstance(appContext, account.name)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            // Account.restore is offline; reading the cache never touches the network.
            val etebase = EtebaseLocalCache.getEtebase(appContext, HttpClient.sharedClient, settings)
            if (!exactGenerationStillCurrent()) return NotesLoad.Stale
            val value = synchronized(cache) {
                if (!exactGenerationStillCurrent()) null else block(cache, etebase.collectionManager)
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
            if (exactGenerationStillCurrent()) NotesLoad.Failed else NotesLoad.Stale
        }
    }
}
