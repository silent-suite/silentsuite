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

    val collectionLastFetchMap = ConcurrentHashMap<String, Long>()

    /** The saved cursor is only valid for the exact type set it was produced with. */
    internal val discoveryTypesKey: String = Constants.SYNCED_COLLECTION_TYPES.joinToString(",")

    fun run(
        context: Context,
        account: Account,
        settings: AccountSettings,
        httpClient: OkHttpClient,
        forceRefresh: Boolean,
    ) {
        val etebaseLocalCache = EtebaseLocalCache.getInstance(context, account.name)
        synchronized(etebaseLocalCache) {
            val now = System.currentTimeMillis()
            val lastCollectionsFetch = collectionLastFetchMap[account.name] ?: 0
            if (!forceRefresh && abs(now - lastCollectionsFetch) <= CACHE_AGE_MILLIS) {
                return@synchronized
            }

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
            fun listFrom(startStoken: String?) {
                var stoken = startStoken
                var done = false
                while (!done) {
                    val colList = colMgr.list(Constants.SYNCED_COLLECTION_TYPES, FetchOptions().stoken(stoken))
                    for (col in colList.data) {
                        etebaseLocalCache.collectionSet(colMgr, col)
                    }

                    for (col in colList.removedMemberships) {
                        etebaseLocalCache.collectionUnset(colMgr, col.uid())
                    }

                    stoken = colList.stoken
                    done = colList.isDone
                    if (stoken != null) {
                        etebaseLocalCache.saveStoken(stoken)
                    }
                }
            }

            if (discoveryChanged && !forceRefresh) {
                // A cursor-free listing has no "since" point and reports no removed memberships, so
                // apply everything pending under the old cursor first.
                etebaseLocalCache.loadStoken()?.let { listFrom(it) }
            }
            var stoken = if (forceRefresh || discoveryChanged) null else etebaseLocalCache.loadStoken()
            listFrom(stoken)
            if (discoveryChanged) {
                AccountSettings.writeCollectionListTypes(manager, account, discoveryTypesKey)
            }
            collectionLastFetchMap[account.name] = now
        }
    }
}
