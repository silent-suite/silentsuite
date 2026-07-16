/*
* Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
* All rights reserved. This program and the accompanying materials
* are made available under the terms of the GNU Public License v3.0
* which accompanies this distribution, and is available at
* http://www.gnu.org/licenses/gpl.html
*/
package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.content.SyncResult
import android.os.Bundle
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.ical4android.InvalidCalendarException
import at.bitfire.vcard4android.ContactsStorageException
import com.etebase.client.*
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.HttpException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.*
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.model.*
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.*
import io.silentsuite.sync.ui.AccountsActivity
import io.silentsuite.sync.ui.DebugInfoActivity
import io.silentsuite.sync.ui.etebase.CollectionActivity
import io.silentsuite.sync.ui.settings.AppPreferences
import java.io.Closeable
import java.io.FileNotFoundException
import java.io.IOException
import java.util.*
import java.util.logging.Level
import javax.net.ssl.SSLHandshakeException

internal enum class DirectProviderAggregate { NONE, SUCCESS, FAILURE, CANCELLED }

/** Failure evidence dominates a later cancellation; cancellation dominates only evidence-free work. */
internal fun aggregateDirectProviderOutcome(
    current: DirectProviderAggregate,
    next: SyncManager.ProviderOutcome,
): DirectProviderAggregate = when {
    current == DirectProviderAggregate.FAILURE -> DirectProviderAggregate.FAILURE
    next == SyncManager.ProviderOutcome.FAILURE -> DirectProviderAggregate.FAILURE
    next == SyncManager.ProviderOutcome.CANCELLED -> DirectProviderAggregate.CANCELLED
    current == DirectProviderAggregate.CANCELLED -> DirectProviderAggregate.CANCELLED
    next == SyncManager.ProviderOutcome.SUCCESS -> DirectProviderAggregate.SUCCESS
    else -> current
}

abstract class SyncManager<T: LocalResource<*>>
constructor(protected val context: Context, protected val account: Account, protected val settings: AccountSettings, protected val extras: Bundle, protected val authority: String, protected val syncResult: SyncResult, journalUid: String, protected val serviceType: CollectionInfo.Type, accountName: String): Closeable {

    private val accountCreationId = AccountManager.get(context)
        .getUserData(account, AccountSettings.KEY_CREATION_ID)
        ?.takeIf { it.isNotBlank() }

    protected val notificationManager: SyncNotification
    protected var localCollection: LocalCollection<T>? = null

    protected var httpClient: HttpClient

    protected val etebaseLocalCache: EtebaseLocalCache
    protected val etebase: com.etebase.client.Account
    protected val colMgr: CollectionManager
    protected val itemMgr: ItemManager
    protected val cachedCollection: CachedCollection

    // Sync counters
    private var syncItemsTotal = 0
    private var syncItemsDeleted = 0
    private var syncItemsChanged = 0

    private var numDiscarded = 0

    /**
     * remote CTag. We update it when we fetch/push and save when everything works.
     */
    private var remoteCTag: String? = null

    /**
     * Dirty and deleted resources. We need to save them so we safely ignore ones that were added after we started.
     */
    private var localDeleted: List<T>? = null
    protected var localDirty: List<T> = LinkedList()

    protected abstract val syncErrorTitle: String

    protected abstract val syncSuccessfullyTitle: String

    init {
        // create HttpClient with given logger
        httpClient = HttpClient.Builder(context, settings).setForeground(false).build()

        etebaseLocalCache = EtebaseLocalCache.getInstance(context, accountName)
        etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
        colMgr = etebase.collectionManager
        synchronized(etebaseLocalCache) {
            cachedCollection = etebaseLocalCache.collectionGet(colMgr, journalUid)!!
        }
        itemMgr = colMgr.getItemManager(cachedCollection.col)

        // dismiss previous error notifications
        notificationManager = SyncNotification(context, journalUid, notificationId())
        notificationManager.cancel()
    }

    protected abstract fun notificationId(): Int

    override fun close() {
        httpClient.close()
    }

    @TargetApi(21)
    enum class ProviderOutcome { SUCCESS, SKIPPED, FAILURE, CANCELLED }

    fun performSync(): ProviderOutcome {
        syncItemsTotal = 0
        syncItemsDeleted = 0
        syncItemsChanged = 0

        var syncPhase = R.string.sync_phase_prepare
        try {
            Logger.log.info("Sync phase: " + context.getString(syncPhase))
            if (!prepare()) {
                Logger.log.info("No reason to synchronize, aborting")
                return ProviderOutcome.SKIPPED
            }

            if (Thread.interrupted())
                throw InterruptedException()
            syncPhase = R.string.sync_phase_prepare_fetch
            Logger.log.info("Sync phase: " + context.getString(syncPhase))
            prepareFetch()

            var itemList: ItemListResponse?
            var stoken = synchronized(etebaseLocalCache) {
                etebaseLocalCache.collectionLoadStoken(cachedCollection.col.uid)
            }
            // Push local changes
            var chunkPushItems: List<Item>
            do {
                if (Thread.interrupted())
                    throw InterruptedException()
                syncPhase = R.string.sync_phase_prepare_local
                Logger.log.info("Sync phase: " + context.getString(syncPhase))
                prepareLocal()

                /* Create push items out of local changes. */
                if (Thread.interrupted())
                    throw InterruptedException()
                syncPhase = R.string.sync_phase_create_local_entries
                Logger.log.info("Sync phase: " + context.getString(syncPhase))
                chunkPushItems = createPushItems()

                if (Thread.interrupted())
                    throw InterruptedException()
                syncPhase = R.string.sync_phase_push_entries
                Logger.log.info("Sync phase: " + context.getString(syncPhase))
                pushItems(chunkPushItems)
            } while (chunkPushItems.size == MAX_PUSH)

            do {
                if (Thread.interrupted())
                    throw InterruptedException()
                syncPhase = R.string.sync_phase_fetch_entries
                Logger.log.info("Sync phase: " + context.getString(syncPhase))
                itemList = fetchItems(stoken)
                if (itemList == null) {
                    break
                }

                if (Thread.interrupted())
                    throw InterruptedException()
                syncPhase = R.string.sync_phase_apply_remote_entries
                Logger.log.info("Sync phase: " + context.getString(syncPhase))
                applyRemoteItems(itemList)

                stoken = itemList.stoken
                if (stoken != null) {
                    synchronized(etebaseLocalCache) {
                        etebaseLocalCache.collectionSaveStoken(cachedCollection.col.uid, stoken)
                    }
                }
            } while (!itemList!!.isDone)

            /* Cleanup and finalize changes */
            if (Thread.interrupted())
                throw InterruptedException()
            syncPhase = R.string.sync_phase_post_processing
            Logger.log.info("Sync phase: " + context.getString(syncPhase))
            postProcess()

            if (numDiscarded > 0) {
                notifyDiscardedChange()
            }
            notifyUserOnSync()

            Logger.log.info("Finished sync")
            return ProviderOutcome.SUCCESS
        } catch (e: SSLHandshakeException) {
            syncResult.stats.numIoExceptions++

            notificationManager.setThrowable(e)
            notificationManager.setAccount(account, accountCreationId)
            notificationManager.notify(syncErrorTitle, context.getString(syncPhase))
            return ProviderOutcome.FAILURE
        } catch (e: FileNotFoundException) {
            notificationManager.setThrowable(e)
            notificationManager.setAccount(account, accountCreationId)
            notificationManager.notify(syncErrorTitle, context.getString(syncPhase))
            return ProviderOutcome.FAILURE
        } catch (e: IOException) {
            Logger.log.log(Level.WARNING, "I/O exception during sync, trying again later", e)
            syncResult.stats.numIoExceptions++
            return ProviderOutcome.FAILURE
        } catch (e: TemporaryServerErrorException) {
            syncResult.stats.numIoExceptions++
            syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
            return ProviderOutcome.FAILURE
        } catch (e: ConnectionException) {
            syncResult.stats.numIoExceptions++
            syncResult.delayUntil = Constants.DEFAULT_RETRY_DELAY
            return ProviderOutcome.FAILURE
        } catch (e: InterruptedException) {
            // Restart sync if interrupted
            syncResult.fullSyncRequested = true
            return ProviderOutcome.CANCELLED
        } catch (e: Exception) {
            if (e is UnauthorizedException) {
                syncResult.stats.numAuthExceptions++
            } else if (e is HttpException) {
                syncResult.stats.numParseExceptions++
            } else if (e is CalendarStorageException || e is ContactsStorageException) {
                syncResult.databaseError = true
            } else {
                syncResult.stats.numParseExceptions++
            }

            notificationManager.setThrowable(e)

            val detailsIntent = notificationManager.detailsIntent
            notificationManager.setAccount(account, accountCreationId)
            if (e !is UnauthorizedException) {
                detailsIntent.putExtra(DebugInfoActivity.KEY_AUTHORITY, authority)
                detailsIntent.putExtra(DebugInfoActivity.KEY_PHASE, syncPhase)
            }

            notificationManager.notify(syncErrorTitle, context.getString(syncPhase))
            return ProviderOutcome.FAILURE
        } catch (e: OutOfMemoryError) {
            syncResult.stats.numParseExceptions++
            notificationManager.setThrowable(e)
            notificationManager.setAccount(account, accountCreationId)
            notificationManager.notify(syncErrorTitle, context.getString(syncPhase))
            return ProviderOutcome.FAILURE
        }
    }

    private fun notifyUserOnSync() {
        val changeNotification = AppPreferences(context).showChangeNotification

        if (!changeNotification || (syncItemsTotal == 0)) {
            return
        }

        val notificationHelper = SyncNotification(context,
                System.currentTimeMillis().toString(), notificationId())
        val resources = context.resources
        val creationId = accountCreationId ?: return
        val intent = CollectionActivity.newIntent(context, account, creationId, cachedCollection.col.uid)
        notificationHelper.notify(syncSuccessfullyTitle,
                String.format(context.getString(R.string.sync_successfully_modified),
                        resources.getQuantityString(R.plurals.sync_successfully,
                                syncItemsTotal, syncItemsTotal)),
                String.format(context.getString(R.string.sync_successfully_modified_full),
                        resources.getQuantityString(R.plurals.sync_successfully,
                                syncItemsChanged, syncItemsChanged),
                        resources.getQuantityString(R.plurals.sync_successfully,
                                syncItemsDeleted, syncItemsDeleted)),
                intent)
    }

    /**
     * Prepares synchronization (for instance, allocates necessary resources).
     *
     * @return whether actual synchronization is required / can be made. true = synchronization
     * shall be continued, false = synchronization can be skipped
     */
    @Throws(ContactsStorageException::class, CalendarStorageException::class)
    protected open fun prepare(): Boolean {
        return true
    }

    protected abstract fun processItem(item: Item)

    private fun persistItem(item: Item) {
        synchronized(etebaseLocalCache) {
            val cached = etebaseLocalCache.itemGet(itemMgr, cachedCollection.col.uid, item.uid)
            if (cached?.item?.etag != item.etag) {
                syncItemsTotal++

                if (item.isDeleted) {
                    syncItemsDeleted++
                } else {
                    syncItemsChanged++
                }
                etebaseLocalCache.itemSet(itemMgr, cachedCollection.col.uid, item)
            }
        }
    }

    @Throws(IOException::class, ContactsStorageException::class, CalendarStorageException::class)
    protected fun prepareFetch() {
        remoteCTag = cachedCollection.col.stoken
    }

    private fun fetchItems(stoken: String?): ItemListResponse? {
        if (remoteCTag != stoken) {
            val ret = itemMgr.list(FetchOptions().stoken(stoken))
            Logger.log.info("Fetched items. Done=${ret.isDone}")
            return ret
        } else {
            Logger.log.info("Skipping fetch because local sync token is unchanged")
            return null
        }
    }

    private fun applyRemoteItems(itemList: ItemListResponse) {
        val items = itemList.data
        // Process new vcards from server
        val size = items.size
        var i = 0

        for (item in items) {
            if (Thread.interrupted()) {
                throw InterruptedException()
            }
            i++
            Logger.log.info("Processing remote resource (${i}/${size}) deleted=${item.isDeleted}")

            processItem(item)
            persistItem(item)
        }
    }

    private fun pushItems(chunkPushItems_: List<Item>) {
        var chunkPushItems = chunkPushItems_
        // upload dirty contacts
        var pushed = 0
        try {
            if (!chunkPushItems.isEmpty()) {
                val items = chunkPushItems
                itemMgr.batch(items.toTypedArray())

                // Persist the items
                synchronized(etebaseLocalCache) {
                    val colUid = cachedCollection.col.uid

                    for (item in items) {
                        etebaseLocalCache.itemSet(itemMgr, colUid, item)
                    }
                }

                pushed += items.size
            }
        } finally {
            // FIXME: A bit fragile, we assume the order in createPushItems
            var remaining = pushed
            for (local in localDeleted!!) {
                if (remaining <= 0) break
                remaining--
                local.delete()
            }
            val deletedCount = pushed - remaining
            if (deletedCount > 0) {
                localDeleted = localDeleted?.drop(deletedCount)
                chunkPushItems = chunkPushItems.drop(deletedCount)
            }

            val dirtyStart = remaining
            var i = 0
            for (local in localDirty) {
                if (remaining <= 0) break
                remaining--
                Logger.log.info("Uploaded local ${resourceType(local)} resource")
                local.clearDirty(chunkPushItems[i].etag)
                i++
            }
            val dirtyCount = dirtyStart - remaining
            if (dirtyCount > 0) {
                localDirty = localDirty.drop(dirtyCount)
                chunkPushItems = chunkPushItems.drop(dirtyCount)
            }

            if (remaining > 0) {
                Logger.log.severe("Unprocessed localentries left, this should never happen!")
            }
        }
    }

    private fun itemUpdateMtime(item: Item) {
        val meta = item.meta
        meta.setMtime(System.currentTimeMillis())
        item.meta = meta
    }

    private fun prepareLocalItemForUpload(colUid: String, local: T): Item {
        val cacheItem = if (local.fileName != null) etebaseLocalCache.itemGet(itemMgr, colUid, local.fileName!!) else null
        val item: Item
        if (cacheItem != null) {
            item = cacheItem.item
            itemUpdateMtime(item)
        } else {
            val uid = local.uuid ?: UUID.randomUUID().toString()
            val meta = ItemMetadata()
            meta.name = uid
            meta.mtime = System.currentTimeMillis()
            item = itemMgr.create(meta, "")

            local.prepareForUpload(item.uid, uid)
        }

        try {
            item.setContent(local.content)
        } catch (e: Exception) {
            Logger.log.warning("Failed creating local ${resourceType(local)} resource")
            throw e
        }

        return item
    }

    private fun createPushItems(): List<Item> {
        val ret = LinkedList<Item>()
        val colUid = cachedCollection.col.uid

        synchronized(etebaseLocalCache) {
            for (local in localDeleted!!) {
                val item = prepareLocalItemForUpload(colUid, local)
                item.delete()

                ret.add(item)

                if (ret.size == MAX_PUSH) {
                    return ret
                }
            }
        }

        synchronized(etebaseLocalCache) {
            for (local in localDirty) {
                val item = prepareLocalItemForUpload(colUid, local)

                ret.add(item)

                if (ret.size == MAX_PUSH) {
                    return ret
                }
            }
        }

        return ret
    }

    /**
     */
    @Throws(CalendarStorageException::class, ContactsStorageException::class, FileNotFoundException::class)
    protected open fun prepareLocal() {
        localDeleted = processLocallyDeleted()
        localDirty = localCollection!!.findDirty(MAX_PUSH)
        // This is done after fetching the local dirty so all the ones we are using will be prepared
        prepareDirty()
    }


    /**
     * Delete unpublished locally deleted, and return the rest.
     * Checks Thread.interrupted() before each request to allow quick sync cancellation.
     */
    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    private fun processLocallyDeleted(): List<T> {
        val localList = localCollection!!.findDeleted()
        val ret = ArrayList<T>(localList.size)

        val readOnly = cachedCollection.col.accessLevel == CollectionAccessLevel.ReadOnly
        if (readOnly) {
            for (local in localList) {
                Logger.log.info("Restoring locally deleted ${resourceType(local)} resource on a read only collection")
                local.resetDeleted()
                numDiscarded++
            }
        } else {
            for (local in localList) {
                if (Thread.interrupted())
                    return ret

                if (local.uuid != null)
                    Logger.log.info("Local ${resourceType(local)} resource has been deleted -> deleting from server")

                ret.add(local)

                syncResult.stats.numDeletes++
            }
        }

        return ret
    }

    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    protected open fun prepareDirty() {
        val readOnly = cachedCollection.col.accessLevel == CollectionAccessLevel.ReadOnly
        if (readOnly) {
            for (local in localDirty) {
                Logger.log.info("Restoring locally modified ${resourceType(local)} resource on a read only collection")
                if (local.uuid == null) {
                    // If it was only local, delete.
                    local.delete()
                } else {
                    // Reapply the authoritative cached remote content in this same
                    // sync so discarded local edits (e.g. a native star toggle on a
                    // read-only collection) are visibly reverted, then clear dirty.
                    local.clearDirty(restoreLocalFromRemote(local))
                }
                numDiscarded++
            }

            localDirty = LinkedList()
        }
    }

    /**
     * Reapply authoritative cached remote content over a locally-modified
     * resource on a read-only collection, so a discarded local edit is visibly
     * reverted within the same sync (no server write occurs). Default: no-op;
     * resource-specific managers may override to rewrite provider fields.
     */
    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    protected open fun restoreLocalFromRemote(local: T): String? = null

    /**
     * For post-processing of entries, for instance assigning groups.
     */
    @Throws(CalendarStorageException::class, ContactsStorageException::class)
    protected open fun postProcess() {
    }

    private fun notifyDiscardedChange() {
        val notification = SyncNotification(context, "discarded_${cachedCollection.col.uid}", notificationId())
        val meta = cachedCollection.meta
        val displayName = meta.name ?: cachedCollection.col.uid
        val intent = Intent(context, AccountsActivity::class.java)
        notification.notify(context.getString(R.string.sync_journal_readonly, displayName), context.getString(R.string.sync_journal_readonly_message, numDiscarded), null, intent, R.drawable.ic_error_light)
    }

    private fun resourceType(local: T) = when (local) {
        is LocalContact -> "contact"
        is LocalEvent -> "event"
        is LocalGroup -> "group"
        is LocalTask -> "task"
        else -> "local"
    }

    companion object {
        private val MAX_FETCH = 50
        private val MAX_PUSH = 30
    }
}
