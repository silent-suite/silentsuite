package io.silentsuite.sync.ui.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
import com.etebase.client.ItemMetadata
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalCalendar
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

data class NotebookContents(val notebook: NotebookRow, val notes: List<NoteRow>)

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
            return NotesLoad.Loaded(NotebookContents(row, sortNotes(notes)))
        }
        return load(context, account, creationId) { cache, colMgr ->
            val row = notebookRows(cache, colMgr).firstOrNull { it.uid == notebookUid } ?: return@load null
            val collection = cache.collectionGet(colMgr, notebookUid)
            val itemMgr = colMgr.getItemManager(collection.col)
            // One note another app wrote in a shape this client cannot decode is left out, not
            // allowed to fail the whole notebook.
            val notes = cache.decodableItemList(itemMgr, notebookUid) { uid, error ->
                Logger.log.warning("Skipping a note that could not be decoded (uid $uid): ${error.message}")
            }
                .filter { isMarkdownNote(it.meta.itemType) }
                .map { NoteRow(it.item.uid, titleOf(it.meta), previewOf(it.content), it.meta.mtime) }
            NotebookContents(row, sortNotes(notes))
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
            NoteContent(cached.item.uid, titleOf(cached.meta), cached.content, cached.meta.mtime)
        }
    }

    /**
     * A note is an item with a missing or empty type; any other type, including one of only
     * spaces, is something else (isMarkdownNoteItem in packages/core/src/models/note.ts).
     */
    internal fun isMarkdownNote(itemType: String?): Boolean = itemType.isNullOrEmpty()

    internal fun titleOf(meta: ItemMetadata): String = meta.name?.trim().orEmpty()

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
        cache.decodableCollectionList(colMgr, Constants.ETEBASE_TYPE_NOTES) { uid, error ->
            Logger.log.warning("Skipping a notebook that could not be decoded (uid $uid): ${error.message}")
        }
            .map { cached ->
                val meta = cached.meta
                val metaColor = meta.color
                NotebookRow(
                    uid = cached.col.uid,
                    name = meta.name.orEmpty(),
                    description = meta.description.orEmpty(),
                    color = if (!metaColor.isNullOrBlank()) LocalCalendar.parseColor(metaColor) else null,
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
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            Logger.log.log(Level.WARNING, "Notes could not be read from the local cache", e)
            if (exactGenerationStillCurrent()) NotesLoad.Failed else NotesLoad.Stale
        }
    }
}
