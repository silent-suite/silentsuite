package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.Collection
import com.etebase.client.CollectionManager
import com.etebase.client.FetchOptions
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.syncConditionsAllow
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.util.UUID
import java.util.logging.Level

/**
 * One Notes sync run: refresh the account-wide collection list, then pull every notebook's items
 * into the local cache. Read-only in this slice (no push), so a read-only notebook needs no
 * special handling here. Every private read is guarded by the exact account generation, and the
 * outcome is recorded into [SyncStatusStore] under the NOTES service exactly like an adapter would.
 */
internal object NotesSyncRunner {
    /** @property manual user-initiated runs ignore the Wi-Fi-only restriction, like manual adapter syncs. */
    data class Request(val requestId: String?, val manual: Boolean)

    fun run(context: Context, account: Account, creationId: String, request: Request) {
        val appContext = context.applicationContext
        val manager = AccountManager.get(appContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return

        val store = SyncStatusStore(appContext)
        val identity = store.identity(account, creationId)
        val attemptId = UUID.randomUUID().toString()
        val admission = store.beginAttemptResult(identity, SyncStatusStore.Service.NOTES, attemptId,
            System.currentTimeMillis(), request.requestId)
        if (admission == SyncStatusStore.MutationResult.REJECTED) {
            Logger.log.info("Notes sync skipped: another request owns the lifecycle")
            return
        }
        fun finishWithoutOutcome() = store.finishWithoutOutcomeResult(identity, SyncStatusStore.Service.NOTES, attemptId)
        fun recordFailure(category: SyncStatusStore.FailureCategory) = store.recordFailureResult(
            identity, SyncStatusStore.Service.NOTES, attemptId, request.requestId, category, System.currentTimeMillis())
        fun recordSuccess() = store.recordSuccessResult(
            identity, SyncStatusStore.Service.NOTES, attemptId, request.requestId, System.currentTimeMillis())

        try {
            if (!AccountSettings.notesEnabled(manager, account)) {
                Logger.log.info("Notes sync skipped: Notes is off for this account")
                finishWithoutOutcome()
                return
            }
            if (!BillingManager.getInstance().isSyncAllowed(appContext, account)) {
                Logger.log.info("Notes sync skipped: subscription inactive")
                finishWithoutOutcome()
                return
            }
            if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return }
            val settings = AccountSettings(appContext, account)
            if (!request.manual && !syncConditionsAllow(appContext, settings)) {
                finishWithoutOutcome()
                return
            }
            if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return }

            HttpClient.Builder(appContext, settings).setForeground(false).build().use { httpClient ->
                CollectionListRefresh.run(appContext, account, settings, httpClient.okHttpClient, forceRefresh = false)
                if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return }

                val cache = EtebaseLocalCache.getInstance(appContext, account.name)
                val etebase = EtebaseLocalCache.getEtebase(appContext, httpClient.okHttpClient, settings)
                val colMgr = etebase.collectionManager
                // The fetch needs only each notebook's uid and cursor, so notebook metadata is never
                // decoded here: one notebook another app wrote in a shape this client cannot decode
                // must not stop the others from syncing.
                val notebooks = synchronized(cache) {
                    cache.collections(colMgr, type = Constants.ETEBASE_TYPE_NOTES)
                }
                for (notebook in notebooks) {
                    if (Thread.interrupted()) throw InterruptedException()
                    if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return }
                    fetchNotebookItems(cache, colMgr, notebook)
                }
            }
            if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return }
            recordSuccess()
        } catch (e: InterruptedException) {
            Logger.log.info("Notes sync cancelled")
            finishWithoutOutcome()
        } catch (e: UnauthorizedException) {
            Logger.log.log(Level.WARNING, "Notes sync could not authenticate", e)
            recordFailure(SyncStatusStore.FailureCategory.AUTHENTICATION)
        } catch (e: TemporaryServerErrorException) {
            Logger.log.log(Level.WARNING, "Notes sync hit a temporary server error", e)
            recordFailure(SyncStatusStore.FailureCategory.NETWORK)
        } catch (e: ConnectionException) {
            Logger.log.log(Level.WARNING, "Notes sync could not reach the server", e)
            recordFailure(SyncStatusStore.FailureCategory.NETWORK)
        } catch (e: Exception) {
            if (Thread.currentThread().isInterrupted) {
                Logger.log.info("Notes sync cancelled")
                finishWithoutOutcome()
            } else {
                Logger.log.log(Level.SEVERE, "Notes sync failed", e)
                recordFailure(SyncStatusStore.FailureCategory.UNKNOWN)
            }
        } catch (e: Error) {
            // An OutOfMemoryError from decrypting a large notebook page must still close the
            // attempt, or the dashboard shows Notes as syncing until the interruption window expires.
            Logger.log.log(Level.SEVERE, "Notes sync failed with an error", e)
            recordFailure(SyncStatusStore.FailureCategory.UNKNOWN)
        }
    }

    /**
     * Mirrors the adapters' item fetch: skip when the notebook's cursor is unchanged, else page until
     * done. The cached copy is compared by revision only and never decoded, so a note whose metadata
     * this client cannot decode cannot fail the page and pin the cursor.
     */
    private fun fetchNotebookItems(cache: EtebaseLocalCache, colMgr: CollectionManager, notebook: Collection) {
        val colUid = notebook.uid
        val itemMgr = colMgr.getItemManager(notebook)
        var stoken = synchronized(cache) { cache.collectionLoadStoken(colUid) }
        if (notebook.stoken == stoken) {
            Logger.log.fine("Notebook unchanged; skipping item fetch")
            return
        }
        do {
            if (Thread.interrupted()) throw InterruptedException()
            val itemList = itemMgr.list(FetchOptions().stoken(stoken))
            synchronized(cache) {
                for (item in itemList.data) {
                    if (cache.itemEtag(itemMgr, colUid, item.uid) != item.etag) {
                        cache.itemSet(itemMgr, colUid, item)
                    }
                }
                itemList.stoken?.let { cache.collectionSaveStoken(colUid, it) }
            }
            stoken = itemList.stoken
        } while (!itemList.isDone)
    }
}
