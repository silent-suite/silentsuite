package io.silentsuite.sync.notes.edit

import com.etebase.client.Collection
import com.etebase.client.CollectionAccessLevel
import com.etebase.client.CollectionManager
import com.etebase.client.Item
import com.etebase.client.ItemManager
import com.etebase.client.ItemMetadata
import com.etebase.client.exceptions.EtebaseException
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.NotePushPolicy.NotebookCheck
import io.silentsuite.sync.notes.edit.NotePushStep.Built
import io.silentsuite.sync.notes.edit.NotePushStep.Notebook
import io.silentsuite.sync.notes.edit.NotePushStep.ServerItem
import io.silentsuite.sync.syncadapter.SyncRunGuard
import java.io.IOException

/**
 * [NotePushStep.Remote] on the Etebase binding, for one run of one account.
 *
 * Every request makes [SyncRunGuard.check] first. Every Etebase cache write takes the cache monitor and,
 * inside it, goes through [SyncRunGuard.write], which takes the cache's write fence. The pending store is
 * only read here (the stored notebook copies), never while the cache monitor is held, so the pending
 * lock is never held together with either (design 3.1).
 *
 * Pending entries are decrypted through the notebook copy the store keeps (design 3.1), and through
 * the cached notebook only when there is no usable copy. Both use the notebook's key, so an item one of
 * them made reads the same through the other.
 */
internal class EtebasePushRemote(
    private val cache: EtebaseLocalCache,
    private val colMgr: CollectionManager,
    private val store: PendingNotesStore,
    private val guard: SyncRunGuard,
    private val now: () -> Long = System::currentTimeMillis,
) : NotePushStep.Remote {

    /** The notebooks as the cache holds them after this run's refresh, deleted ones included; read once. */
    private val cached: MutableMap<String, Collection> by lazy {
        synchronized(cache) {
            cache.collections(colMgr, withDeleted = true, type = Constants.ETEBASE_TYPE_NOTES).associateByTo(HashMap()) { it.uid }
        }
    }

    private val managers = HashMap<String, ItemManager>()

    override fun notebook(notebookUid: String): Notebook {
        val col = cached[notebookUid] ?: return Notebook.MISSING
        return when {
            col.isDeleted -> Notebook.DELETED
            col.accessLevel == CollectionAccessLevel.ReadOnly -> Notebook.READ_ONLY
            else -> Notebook.WRITABLE
        }
    }

    override fun upload(entry: PendingEntry): ServerItem {
        val itemMgr = manager(entry.notebookUid)
        val item = itemMgr.cacheLoad(entry.blob)
        guard.check()
        // One note per call and never a sync token: the binding reports a stale token as the same
        // conflict as a wrong etag, and the etag check is what keeps a newer server copy (design 3.3).
        itemMgr.transaction(arrayOf(item))
        return serverItem(itemMgr, item)
    }

    override fun fetch(entry: PendingEntry): ServerItem {
        val itemMgr = manager(entry.notebookUid)
        guard.check()
        val item = itemMgr.fetch(entry.noteUid)
        // The conflict step can drop the entry on this copy without decrypting it (our own upload, and
        // both delete rows), so it has to be this note, and its revision has to name what it holds.
        // Anything else is the entry's failure, and nothing is resolved without the real copy.
        check(item.uid == entry.noteUid && item.verify()) { "the server answered with another note, or one that does not verify" }
        return serverItem(itemMgr, item)
    }

    override fun fetchNotebook(notebookUid: String): NotebookCheck.Found {
        guard.check()
        val col = colMgr.fetch(notebookUid)
        // Its answer holds or releases every change waiting in the notebook, so it has to be this notebook.
        check(col.uid == notebookUid && col.collectionType == Constants.ETEBASE_TYPE_NOTES) { "the server answered with another collection" }
        return NotebookCheck.Found(readOnly = col.accessLevel == CollectionAccessLevel.ReadOnly, deleted = col.isDeleted)
    }

    override fun cache(entry: PendingEntry, item: ServerItem) {
        val itemMgr = manager(entry.notebookUid)
        val handle = item.handle as? Item ?: itemMgr.cacheLoad(item.blob)
        synchronized(cache) {
            guard.write(cache) { cache.itemSet(itemMgr, entry.notebookUid, handle) }
        }
    }

    override fun unsetNotebook(notebookUid: String) {
        synchronized(cache) {
            guard.write(cache) { cache.collectionUnset(colMgr, notebookUid) }
        }
        cached.remove(notebookUid)
    }

    /**
     * The server copy with the entry's change on top: its deletion, or its text with its name and mtime
     * merged into the server copy's metadata, so fields another client wrote there are kept. The result
     * keeps the server copy's revision as its base, so its push names the copy it was built on.
     */
    override fun rebase(entry: PendingEntry, onto: ServerItem): Built {
        val itemMgr = manager(entry.notebookUid)
        val target = itemMgr.cacheLoad(onto.blob)
        when (entry.state) {
            PendingEntry.State.DELETE -> target.delete()
            PendingEntry.State.UPSERT -> {
                val local = itemMgr.cacheLoad(entry.blob)
                val (name, mtime) = nameAndMtime(local)
                target.setContent(local.content)
                writeNameAndMtime(target, name, mtime)
            }
            PendingEntry.State.HELD -> error("held text is never rebased")
        }
        return Built(target.etag, itemMgr.cacheSaveWithContent(target))
    }

    /**
     * A new note in the entry's notebook with the entry's text and fresh metadata (name and mtime only,
     * as the web's move writes), dated now so it shows at the top of every list (design 3.4).
     */
    override fun newNote(entry: PendingEntry, conflictedCopy: Boolean): PendingEntry {
        val itemMgr = manager(entry.notebookUid)
        val local = itemMgr.cacheLoad(entry.blob)
        val (name, _) = nameAndMtime(local)
        // Stored on the server and read by every client, so in English like the web's own "Untitled".
        val title = if (conflictedCopy) NotePushPolicy.conflictCopyTitle(name, UNTITLED, CONFLICTED_COPY) else name
        val note = itemMgr.create(ItemMetadata(), local.content)
        val mtime = now()
        val fresh = NoteMetaCodec.fresh(title, mtime)
        note.setMetaRaw(fresh.bytes)
        checkReadsBack(note, fresh.name, mtime)
        return PendingEntry(note.uid, entry.notebookUid, PendingEntry.State.UPSERT, version = 0L, revision = note.etag,
            isCreate = true, blob = itemMgr.cacheSaveWithContent(note))
    }

    private fun serverItem(itemMgr: ItemManager, item: Item) =
        ServerItem(item.etag, item.isDeleted, itemMgr.cacheSaveWithContent(item), item)

    /** The notebook's item manager, from the stored copy when there is a usable one, else from the cache. */
    private fun manager(notebookUid: String): ItemManager = managers.getOrPut(notebookUid) {
        val copy = try {
            store.notebook(notebookUid)?.let { colMgr.cacheLoad(it) }
        } catch (e: IOException) {
            Logger.log.warning("The stored copy of a notebook could not be read: ${e.javaClass.name}")
            null
        } catch (e: EtebaseException) {
            Logger.log.warning("The stored copy of a notebook could not be loaded: ${e.javaClass.name}")
            null
        }
        val col = copy ?: cached[notebookUid] ?: throw IllegalStateException("no copy of the notebook to decrypt with")
        colMgr.getItemManager(col)
    }

    /** The name and mtime of a pending edit, read the way the merge reads them, else through the typed decoder. */
    private fun nameAndMtime(item: Item): Pair<String, Long> {
        val peek = NoteMetaCodec.peek(item.metaRaw)
        peek?.name?.let { return it to (peek.mtime ?: now()) }
        val typed = item.meta
        return typed.name.orEmpty() to (typed.mtime ?: now())
    }

    /**
     * Merges [name] and [mtime] into [item]'s metadata (design 3.2). A map another client wrote with a
     * repeated or aliased key is refused rather than guessed, which fails this entry and keeps its text;
     * metadata that is not one map is replaced by typed metadata with the fields the typed decoder read.
     */
    private fun writeNameAndMtime(item: Item, name: String, mtime: Long) {
        when (val merged = NoteMetaCodec.merge(item.metaRaw, name, mtime)) {
            is NoteMetaCodec.Merge.Merged -> {
                item.setMetaRaw(merged.bytes)
                checkReadsBack(item, merged.name, mtime)
            }
            is NoteMetaCodec.Merge.Refused -> throw IllegalStateException("note metadata names ${merged.key} ambiguously (${merged.why})")
            is NoteMetaCodec.Merge.NotAMap -> {
                Logger.log.warning("Note metadata was not one map; writing typed metadata instead")
                val old = try { item.meta } catch (e: EtebaseException) { null }
                val written = NoteMetaCodec.wellFormed(name)
                item.meta = ItemMetadata().apply {
                    old?.itemType?.let { itemType = it }
                    old?.description?.let { description = it }
                    old?.color?.let { color = it }
                    this.name = written
                    this.mtime = mtime
                }
                checkReadsBack(item, written, mtime)
            }
        }
    }

    /** What every client's typed decoder reads back must be what was written, or nothing is uploaded. */
    private fun checkReadsBack(item: Item, name: String, mtime: Long) {
        val meta = item.meta
        check(meta.name == name && meta.mtime == mtime) { "note metadata did not read back as written" }
    }

    private companion object {
        const val UNTITLED = "Untitled"
        const val CONFLICTED_COPY = "(conflicted copy)"
    }
}
