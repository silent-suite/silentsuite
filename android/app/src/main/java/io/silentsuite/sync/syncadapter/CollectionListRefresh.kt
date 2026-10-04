package io.silentsuite.sync.syncadapter

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.FetchOptions
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.log.Logger
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.abs

/**
 * Account-wide collection list refresh shared by the sync adapters and the in-app Notes job.
 *
 * Every collection type lives behind one saved list cursor (stoken). A fetch with a narrower type
 * filter would advance that cursor and hide changes from the other services, so this is the only
 * place that lists collections against the saved cursor, and it always asks for every type in
 * [Constants.SYNCED_COLLECTION_TYPES]. When that type set grows (Notes joined discovery), the next
 * refresh lists everything without a cursor once, so collections created before the change are
 * not skipped.
 */
internal object CollectionListRefresh {
    /** Burst protection: adapters finishing together share one list fetch per account. */
    private const val CACHE_AGE_MILLIS = 5L * 1000L

    /**
     * How often one list page is asked for when collections keep being written here while its
     * answer is on the way. After that the refresh ends where it got to and the next one carries on.
     */
    private const val PAGE_ATTEMPTS = 3

    val collectionLastFetchMap = ConcurrentHashMap<String, Long>()

    /**
     * One lock per account generation, held for a whole refresh including its list requests, so
     * refreshes of that generation list one at a time and the later ones see the burst window and
     * the cursor the first left. Only this object takes it, always before the cache's monitor. The
     * cache's monitor is taken for each read and write but never across a list request, so a slow
     * listing keeps no other user of the account's cache waiting.
     */
    private val refreshLocks = ConcurrentHashMap<String, Any>()

    /** The saved cursor is only valid for the exact type set it was produced with. */
    internal val discoveryTypesKey: String = Constants.SYNCED_COLLECTION_TYPES.joinToString(",")

    /**
     * @param creationId the account generation this run belongs to, read together with [settings].
     * Every write after a list request goes through a [SyncRunGuard]: once that generation is gone,
     * or [stillWanted] turns false, nothing more is written and the run ends with
     * [StaleSyncRunException].
     */
    fun run(
        context: Context,
        account: Account,
        settings: AccountSettings,
        httpClient: OkHttpClient,
        forceRefresh: Boolean,
        creationId: String?,
        stillWanted: () -> Boolean = { true },
    ) {
        val guard = SyncRunGuard(context, account, creationId, stillWanted)
        val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
        // The burst window belongs to one account generation, so a same-name account that
        // replaced this one is never skipped because the old one listed a moment ago. Nor does it
        // wait for the old one's request: that run's writes are refused once its generation is gone.
        val fetchKey = "${account.name}\u0000${creationId.orEmpty()}"
        synchronized(refreshLocks.getOrPut(fetchKey) { Any() }) {
            val now = System.currentTimeMillis()
            val lastCollectionsFetch = collectionLastFetchMap[fetchKey] ?: 0
            if (!forceRefresh && abs(now - lastCollectionsFetch) <= CACHE_AGE_MILLIS) {
                return@synchronized
            }
            guard.check()

            val etebase = EtebaseLocalCache.getEtebase(context, httpClient, settings)
            val colMgr = etebase.collectionManager
            val manager = AccountManager.get(context)
            val discoveryChanged = AccountSettings.collectionListTypes(manager, account) != discoveryTypesKey
            if (discoveryChanged) {
                Logger.log.info("Collection discovery types changed; running a full collection list refresh")
            }
            // Post-invite acceptance must not depend on the previous collection-list cursor: a full
            // list refresh makes newly accepted shared collections visible even when an old stoken
            // would otherwise hide the membership change. The same applies when a new collection
            // type joins discovery.
            // Returns false when a page could not be written because collections kept being written
            // here; nothing of that page is cached then, and the cursor still points at it.
            fun listFrom(startStoken: String?): Boolean {
                var stoken = startStoken
                var done = false
                var attempts = 0
                while (!done) {
                    guard.check()
                    val writesBefore = etebaseLocalCache.collectionWrites()
                    val colList = colMgr.list(Constants.SYNCED_COLLECTION_TYPES, FetchOptions().stoken(stoken))
                    // A page is written only if this run is still current when its answer arrives,
                    // and only if no collection was written here since the page was asked for: the
                    // answer may have been built before that write was uploaded, and would put an
                    // older revision (or a collection deleted here) back. The page is asked for
                    // again instead; that answer is built after the upload the write followed.
                    var written = false
                    synchronized(etebaseLocalCache) {
                        guard.write(etebaseLocalCache) {
                            if (etebaseLocalCache.collectionWrites() != writesBefore) return@write
                            written = true
                            for (col in colList.data) {
                                etebaseLocalCache.collectionSet(colMgr, col)
                            }

                            for (col in colList.removedMemberships) {
                                etebaseLocalCache.collectionUnset(colMgr, col.uid())
                            }

                            colList.stoken?.let { etebaseLocalCache.saveStoken(it) }
                        }
                    }
                    if (!written) {
                        if (++attempts >= PAGE_ATTEMPTS) {
                            Logger.log.info("Collections kept changing locally during the collection list refresh; leaving the rest to the next refresh")
                            return false
                        }
                        continue
                    }
                    attempts = 0
                    stoken = colList.stoken
                    done = colList.isDone
                }
                return true
            }

            val savedStoken = synchronized(etebaseLocalCache) { etebaseLocalCache.loadStoken() }
            if (forceRefresh || discoveryChanged) {
                // A cursor-free listing has no "since" point and reports no removed memberships, so
                // apply everything pending under the old cursor first. Otherwise a collection this
                // account lost since the last listing would stay cached for good.
                // A replay that had to stop leaves the full listing, the discovery key and the
                // burst window to the next refresh, which starts from the same saved state.
                if (savedStoken != null && !listFrom(savedStoken)) return@synchronized
            }
            if (!listFrom(if (forceRefresh || discoveryChanged) null else savedStoken)) return@synchronized
            synchronized(etebaseLocalCache) {
                guard.write(etebaseLocalCache) {
                    if (discoveryChanged) AccountSettings.writeCollectionListTypes(manager, account, discoveryTypesKey)
                    collectionLastFetchMap[fetchKey] = now
                }
            }
        }
    }
}
