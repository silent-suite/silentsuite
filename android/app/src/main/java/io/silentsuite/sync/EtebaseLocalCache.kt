package io.silentsuite.sync

import android.content.Context
import com.etebase.client.*
import com.etebase.client.Collection
import com.etebase.client.exceptions.EtebaseException
import com.etebase.client.exceptions.UrlParseException
import io.silentsuite.sync.log.Logger
import okhttp3.OkHttpClient
import java.io.File
import java.util.*

class EtebaseLocalCache private constructor(context: Context, username: String) {
    // Issue #119: log the resolved filesDir + username before the JNI FileSystemCache.create
    // call. Native errors here don't propagate as EtebaseException, so without this breadcrumb
    // a mangled username (e.g. one containing '@' or '.') is invisible from logcat alone.
    private val fsCache: FileSystemCache = run {
        val filesDirPath = context.filesDir.absolutePath
        Logger.log.info("FileSystemCache.create filesDir=$filesDirPath username=$username")
        FileSystemCache.create(filesDirPath, username)
    }
    private val filesDir: File = File(context.filesDir, username)
    private val colsDir: File = File(filesDir, "cols")

    private fun getCollectionItemsDir(colUid: String): File {
        val colsDir = File(filesDir, "cols")
        val colDir = File(colsDir, colUid)
        return File(colDir, "items")
    }

    private fun clearUserCache() {
        fsCache.clearUserCache()
    }

    fun saveStoken(stoken: String) {
        fsCache.saveStoken(stoken)
    }

    fun loadStoken(): String? {
        return fsCache.loadStoken()
    }

    fun collectionSaveStoken(colUid: String, stoken: String) {
        fsCache.collectionSaveStoken(colUid, stoken)
    }

    fun collectionLoadStoken(colUid: String): String? {
        return fsCache.collectionLoadStoken(colUid)
    }

    fun collectionList(colMgr: CollectionManager, withDeleted: Boolean = false): List<CachedCollection> {
        return fsCache._unstable_collectionList(colMgr).filter {
            withDeleted || !it.isDeleted
        }.map{
            CachedCollection(it, it.meta, it.collectionType)
        }
    }

    fun collectionGet(colMgr: CollectionManager, colUid: String): CachedCollection {
        return fsCache.collectionGet(colMgr, colUid).let {
            CachedCollection(it, it.meta, it.collectionType)
        }
    }

    fun collectionSet(colMgr: CollectionManager, collection: Collection) {
        fsCache.collectionSet(colMgr, collection)
    }

    fun collectionUnset(colMgr: CollectionManager, colUid: String) {
        try {
            fsCache.collectionUnset(colMgr, colUid)
        } catch (e: UrlParseException) {
            // Ignore, as it just means the file doesn't exist
        }
    }

    fun itemList(itemMgr: ItemManager, colUid: String, withDeleted: Boolean = false): List<CachedItem> {
        return fsCache._unstable_itemList(itemMgr, colUid).filter {
            withDeleted || !it.isDeleted
        }.map {
            CachedItem(it, it.meta, it.contentString)
        }
    }

    fun itemGet(itemMgr: ItemManager, colUid: String, itemUid: String): CachedItem? {
        // Need the try because the inner call doesn't return null on missing, but an error
        val ret = try {
            fsCache.itemGet(itemMgr, colUid, itemUid)
        } catch (e: EtebaseException) {
            return null
        }
        return ret.let {
            CachedItem(it, it.meta, it.contentString)
        }
    }

    fun itemSet(itemMgr: ItemManager, colUid: String, item: Item) {
        fsCache.itemSet(itemMgr, colUid, item)
    }

    fun itemUnset(itemMgr: ItemManager, colUid: String, itemUid: String) {
        fsCache.itemUnset(itemMgr, colUid, itemUid)
    }

    companion object {
        private val localCacheCache: HashMap<String, EtebaseLocalCache> = HashMap()

        fun getInstance(context: Context, username: String): EtebaseLocalCache {
            synchronized(localCacheCache) {
                val cached = localCacheCache.get(username)
                if (cached != null) {
                    return cached
                } else {
                    val ret = EtebaseLocalCache(context, username)
                    localCacheCache.set(username, ret)
                    return ret
                }
            }
        }

        fun clearUserCache(context: Context, username: String) {
            val localCache = getInstance(context, username)
            localCache.clearUserCache()
            localCacheCache.remove(username)
        }

        // FIXME: If we ever cache this we need to cache bust on changePassword
        fun getEtebase(
            context: Context,
            httpClient: OkHttpClient,
            settings: AccountSettings,
            sessionOverride: String? = null,
        ): Account {
            val client = Client.create(httpClient, settings.uri?.toString())
            // On first login AccountManager.setUserData hasn't always landed by the time
            // the next activity reads it back, so accept an in-memory override from the
            // caller and fall back to the persisted value only if one wasn't supplied.
            val session = sessionOverride
                ?: settings.etebaseSession
                ?: run {
                    // Issue #119: distinguish "userData not yet flushed" (sessionOverride was
                    // not provided AND persisted session is missing) from "session genuinely
                    // missing." Logging the userData keys also surfaces partial-state account
                    // collisions where the Android account row exists but setUserData hasn't
                    // landed yet.
                    // AccountSettings's key constants are private; keep this list in sync with
                    // AccountSettings.companion. Logging only the *names* of keys present (not
                    // values) avoids leaking session tokens or URIs into the log file.
                    val accountManager = android.accounts.AccountManager.get(context)
                    val userDataKeys = listOf(
                        "version",
                        "uri",
                        "user_name",
                        "etebase_session",
                    ).filter { accountManager.getUserData(settings.account, it) != null }
                    Logger.log.severe(
                        "Etebase session is null: account=${settings.account.name} " +
                                "sessionOverrideProvided=${sessionOverride != null} " +
                                "userDataKeys=$userDataKeys"
                    )
                    throw IllegalStateException("Etebase session is null for account ${settings.account.name}")
                }
            return Account.restore(client, session, null)
        }
    }
}

data class CachedCollection(val col: Collection, val meta: ItemMetadata, val collectionType: String)

data class CachedItem(val item: Item, val meta: ItemMetadata, val content: String)