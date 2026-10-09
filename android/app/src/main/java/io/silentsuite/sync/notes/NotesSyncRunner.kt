package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import com.etebase.client.Collection
import com.etebase.client.CollectionManager
import com.etebase.client.FetchOptions
import com.etebase.client.exceptions.ConnectionException
import com.etebase.client.exceptions.NotFoundException
import com.etebase.client.exceptions.PermissionDeniedException
import com.etebase.client.exceptions.TemporaryServerErrorException
import com.etebase.client.exceptions.UnauthorizedException
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.billing.BillingManager
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.edit.EtebasePushRemote
import io.silentsuite.sync.notes.edit.NotePushPolicy
import io.silentsuite.sync.notes.edit.NotePushStep
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.CollectionRefreshIncompleteException
import io.silentsuite.sync.syncadapter.PagedListingGuard
import io.silentsuite.sync.syncadapter.PagedListingStalledException
import io.silentsuite.sync.syncadapter.StaleSyncRunException
import io.silentsuite.sync.syncadapter.SyncRunGuard
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.syncConditionsAllow
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import java.io.IOException
import java.io.InterruptedIOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level

/**
 * One Notes sync run: refresh the account-wide collection list, push the changes waiting in the
 * account's pending store ([NotePushStep]), then pull every notebook's items into the local cache.
 * Every private read is guarded by the exact account generation, and the outcome is recorded into
 * [SyncStatusStore] under the NOTES service exactly like an adapter would.
 */
internal object NotesSyncRunner {
    /** Per exact account identity, what the push step remembers between runs (in memory only). */
    private val pushMemory = ConcurrentHashMap<String, NotePushStep.Memory>()

    /**
     * @property manual user-initiated runs ignore the Wi-Fi-only restriction, like manual adapter syncs,
     * and try every pending change, whatever its backoff.
     * @property forceRefresh list the collections from scratch, not from the saved cursor (after an
     * invitation is accepted), so a newly shared notebook is seen whatever ran before.
     * @property stillScheduled false once the coordinator cancelled this run (sign-out, Notes turned
     * off), whether or not the thread's interrupt survived the network call it was in.
     */
    data class Request(
        val requestId: String?,
        val manual: Boolean,
        val forceRefresh: Boolean = false,
        val stillScheduled: () -> Boolean = { true },
    )

    /**
     * Returns whether the collection list refresh completed, so a forced refresh that did not can
     * stay owed to the next run (see [NotesSyncPolicy.finished]).
     */
    fun run(context: Context, account: Account, creationId: String, request: Request): Boolean {
        val appContext = context.applicationContext
        val manager = AccountManager.get(appContext)
        fun exactGenerationStillCurrent() =
            ExactAccountRouting.validate(account, creationId, App.accountType, manager) != null
        if (!exactGenerationStillCurrent()) return false

        val store = SyncStatusStore(appContext)
        val identity = store.identity(account, creationId)
        val attemptId = UUID.randomUUID().toString()
        val admission = store.beginAttemptResult(identity, SyncStatusStore.Service.NOTES, attemptId,
            System.currentTimeMillis(), request.requestId)
        if (admission == SyncStatusStore.MutationResult.REJECTED) {
            Logger.log.info("Notes sync skipped: another request owns the lifecycle")
            return false
        }
        // Each of these ends the run. A cancellation's interrupt must not fail that last status
        // write: SharedPreferences gives up on a commit made from an interrupted thread, and the
        // store would record that as a storage fault. A cancel that lands after the run's last
        // check still lets it record the outcome of the work it finished.
        fun finishWithoutOutcome(): SyncStatusStore.MutationResult {
            Thread.interrupted()
            return store.finishWithoutOutcomeResult(identity, SyncStatusStore.Service.NOTES, attemptId)
        }
        fun recordFailure(category: SyncStatusStore.FailureCategory): SyncStatusStore.MutationResult {
            Thread.interrupted()
            return store.recordFailureResult(
                identity, SyncStatusStore.Service.NOTES, attemptId, request.requestId, category, System.currentTimeMillis())
        }
        fun recordSuccess(): SyncStatusStore.MutationResult {
            Thread.interrupted()
            return store.recordSuccessResult(
                identity, SyncStatusStore.Service.NOTES, attemptId, request.requestId, System.currentTimeMillis())
        }

        // Nothing is written after a network call once the run is cancelled (sign-out, Notes turned
        // off), Notes is off, or the exact account generation is gone: a same-name account that
        // replaced this one shares the cache directory, its cursors, and the discovery key.
        fun cancelled() = Thread.currentThread().isInterrupted || !request.stillScheduled()
        fun stillWanted() = !cancelled() && AccountSettings.notesEnabled(manager, account)
        val guard = SyncRunGuard(appContext, account, creationId, ::stillWanted)
        var listedCollections = false
        var push: NotePushStep.Result? = null
        try {
            if (!AccountSettings.notesEnabled(manager, account)) {
                Logger.log.info("Notes sync skipped: Notes is off for this account")
                finishWithoutOutcome()
                return false
            }
            if (!BillingManager.getInstance().isSyncAllowed(appContext, account)) {
                Logger.log.info("Notes sync skipped: subscription inactive")
                finishWithoutOutcome()
                return false
            }
            if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return false }
            val settings = AccountSettings(appContext, account)
            if (!request.manual && !syncConditionsAllow(appContext, settings)) {
                finishWithoutOutcome()
                return false
            }
            if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return false }

            val outcome = HttpClient.Builder(appContext, settings).setForeground(false).build().use { httpClient ->
                CollectionListRefresh.run(appContext, account, settings, httpClient.okHttpClient, request.forceRefresh,
                    creationId, ::stillWanted)
                listedCollections = true
                if (!exactGenerationStillCurrent()) { finishWithoutOutcome(); return true }

                val cache = EtebaseLocalCache.getInstance(appContext, account.name)
                val etebase = EtebaseLocalCache.getEtebase(appContext, httpClient.okHttpClient, settings)
                val colMgr = etebase.collectionManager
                // Pushed before the fetch, as the adapters push before they fetch (design 3.3).
                push = try {
                    pushPending(appContext, account, creationId, request, cache, colMgr, guard)
                } catch (e: IOException) {
                    // The store could not be read at the start of the step: a storage failure, and the
                    // fetch still runs (design 3.3). A cancelled call is no failure.
                    if (e is InterruptedIOException || cancelled()) throw e
                    Logger.log.warning("The pending notes store could not be read: ${e.javaClass.name}")
                    unreadableStore()
                }
                if (push?.ended == NotePushStep.Ended.NEEDS_AUTHENTICATION) {
                    // There is no session renewal (answer 3 on #709): a 401 on a push ends the run with
                    // the authentication failure, as a 401 on any other request does (design 3.3).
                    if (cancelled() || !guard.mayWrite()) finishWithoutOutcome()
                    else recordFailure(SyncStatusStore.FailureCategory.AUTHENTICATION)
                    return true
                }
                // The fetch needs only each notebook's uid and cursor, so notebook metadata is never
                // decoded here: one notebook another app wrote in a shape this client cannot decode
                // must not stop the others from syncing.
                val notebooks = synchronized(cache) {
                    cache.collections(colMgr, type = Constants.ETEBASE_TYPE_NOTES)
                }
                fetchEachNotebook(notebooks, guard::mayWrite) { notebook ->
                    fetchNotebookItems(cache, colMgr, notebook, guard)
                }
            }
            if (outcome == NotebooksOutcome.STALE || !guard.mayWrite()) { finishWithoutOutcome(); return true }
            runFailure(push, outcome)?.let { recordFailure(it) } ?: recordSuccess()
        } catch (e: CollectionRefreshIncompleteException) {
            // No push, item fetch or success follows an unfinished list. Returning false also keeps
            // this run's forced refresh owed in the coordinator's existing single-flight policy.
            Logger.log.info("Notes sync deferred: collection refresh is incomplete")
            finishWithoutOutcome()
        } catch (e: InterruptedException) {
            Logger.log.info("Notes sync cancelled")
            finishWithoutOutcome()
        } catch (e: StaleSyncRunException) {
            Logger.log.info("Notes sync stopped: cancelled, Notes turned off, or the account replaced while a request was in flight")
            finishWithoutOutcome()
        } catch (e: InvalidAccountException) {
            // The account row went away between the generation check and the settings read.
            Logger.log.info("Notes sync stopped: the account was removed")
            finishWithoutOutcome()
        } catch (e: Exception) {
            when {
                // A cancellation can surface as any exception, a broken connection included, and
                // can consume the thread's interrupt on the way: it is never recorded as a failure.
                cancelled() -> {
                    Logger.log.info("Notes sync cancelled")
                    finishWithoutOutcome()
                }
                e is UnauthorizedException -> {
                    Logger.log.log(Level.WARNING, "Notes sync could not authenticate", e)
                    recordFailure(SyncStatusStore.FailureCategory.AUTHENTICATION)
                }
                e is TemporaryServerErrorException -> {
                    Logger.log.log(Level.WARNING, "Notes sync hit a temporary server error", e)
                    recordFailure(SyncStatusStore.FailureCategory.NETWORK)
                }
                e is ConnectionException -> {
                    Logger.log.log(Level.WARNING, "Notes sync could not reach the server", e)
                    recordFailure(SyncStatusStore.FailureCategory.NETWORK)
                }
                else -> {
                    Logger.log.log(Level.SEVERE, "Notes sync failed", e)
                    recordFailure(SyncStatusStore.FailureCategory.UNKNOWN)
                }
            }
        } catch (e: Error) {
            // An OutOfMemoryError from decrypting a large notebook page must still close the
            // attempt, or the dashboard shows Notes as syncing until the interruption window expires.
            Logger.log.log(Level.SEVERE, "Notes sync failed with an error", e)
            recordFailure(SyncStatusStore.FailureCategory.UNKNOWN)
        }
        return listedCollections
    }

    /**
     * The push step (design 3.3): the changes waiting in the account's pending store are sent, one note
     * per request, before the fetch. Null when the store holds no entry and nothing unreadable, in which
     * case no request is made.
     */
    private fun pushPending(
        context: Context,
        account: Account,
        creationId: String,
        request: Request,
        cache: EtebaseLocalCache,
        colMgr: CollectionManager,
        guard: SyncRunGuard,
    ): NotePushStep.Result? {
        val store = PendingNotesStore.forIdentity(context, account.type, account.name, creationId)
        val waiting = store.snapshot { false }
        if (waiting.headers.isEmpty() && waiting.unreadable.isEmpty()) {
            // A copy whose last entry went outside a run (a note never sent and then deleted, held text
            // discarded), or whose removal failed before, goes here. Nothing is written when there is none.
            pruneNotebookCopies(store)
            return null
        }
        refreshNotebookCopies(store, cache, colMgr, guard, waiting.headers.mapTo(HashSet()) { it.notebookUid })
        val memory = pushMemory.getOrPut(listOf(account.type, account.name, creationId).joinToString("\u0000")) { NotePushStep.Memory() }
        val result = NotePushStep(store, EtebasePushRemote(cache, colMgr, store, guard), memory,
            userInitiated = request.manual, mayWrite = guard::mayWrite).pass()
        pruneNotebookCopies(store)
        // Counts only: no title, notebook name or text is ever logged.
        Logger.log.info("Notes push ${result.ended}: pushed ${result.pushed}, held ${result.held}, " +
            "deletes dropped ${result.droppedDeletes}, conflicts ${result.conflicts.values.sum()}, " +
            "failure ${result.failure}, carried ${result.carriedFailure}")
        return result
    }

    private fun pruneNotebookCopies(store: PendingNotesStore) {
        try {
            store.pruneNotebooks()
        } catch (e: IOException) {
            Logger.log.warning("Notebook copies no pending note needs could not be removed: ${e.javaClass.name}")
        }
    }

    /** What a run records when the pending store cannot be read at the start of its push step. */
    internal fun unreadableStore() = NotePushStep.Result(NotePushStep.Ended.STOPPED, pushed = 0, held = 0,
        conflicts = emptyMap(), failure = NotePushPolicy.FailureKind.LOCAL, carriedFailure = null)

    /**
     * Design 3.1: each pending note is decrypted through a copy of its notebook that the store keeps,
     * so its text stays readable after the Etebase cache drops the notebook. The copy is refreshed here,
     * after the collection refresh and never inside it, from the notebook as this run cached it, and
     * never from a notebook seen as deleted. A copy that cannot be written stays as it was.
     */
    private fun refreshNotebookCopies(
        store: PendingNotesStore,
        cache: EtebaseLocalCache,
        colMgr: CollectionManager,
        guard: SyncRunGuard,
        notebookUids: Set<String>,
    ) {
        // Read under the cache monitor and written under the pending lock, never both at once.
        val copies = synchronized(cache) {
            cache.collections(colMgr, type = Constants.ETEBASE_TYPE_NOTES)
                .filter { it.uid in notebookUids }
                .map { it.uid to colMgr.cacheSave(it) }
        }
        for ((uid, copy) in copies) {
            guard.check()
            try {
                store.putNotebook(uid, copy)
            } catch (e: IOException) {
                Logger.log.warning("A notebook copy for pending notes could not be refreshed: ${e.javaClass.name}")
            }
        }
    }

    /**
     * The failure a run records, or null for success (design 3.3 and 3.8): the push step's own failure
     * first, then a notebook that could not be fetched, then a failure carried from an entry that was
     * skipped in backoff, so a run never records success over an entry that is stuck.
     */
    internal fun runFailure(push: NotePushStep.Result?, fetched: NotebooksOutcome): SyncStatusStore.FailureCategory? {
        push?.failure?.let { return pushFailureCategory(it.name) }
        if (fetched == NotebooksOutcome.SOME_FAILED) return SyncStatusStore.FailureCategory.UNKNOWN
        return push?.carriedFailure?.let(::pushFailureCategory)
    }

    /**
     * A push failure as a status category, from the [NotePushPolicy.FailureKind] name entries record.
     * A 403 or 404 the notebook fetch did not confirm, a rejection, and a name this build does not know
     * are UNKNOWN, never PERMISSION, which means an Android permission the dashboard offers to grant.
     */
    internal fun pushFailureCategory(kind: String): SyncStatusStore.FailureCategory = when (kind) {
        NotePushPolicy.FailureKind.TRANSIENT.name -> SyncStatusStore.FailureCategory.NETWORK
        NotePushPolicy.FailureKind.AUTHENTICATION.name -> SyncStatusStore.FailureCategory.AUTHENTICATION
        // The pending store or the Etebase cache, or a pending change this device could not read. A
        // change that cannot be built for its upload is held, not failed.
        NotePushPolicy.FailureKind.LOCAL.name -> SyncStatusStore.FailureCategory.STORAGE
        else -> SyncStatusStore.FailureCategory.UNKNOWN
    }

    /** What one notebook's failed fetch means for the rest of the run. */
    internal enum class NotebookFailure {
        /**
         * Credentials, connectivity, an unavailable server, or a permission denial: every other
         * notebook would fail the same way. The server answers a read with 403 only for the whole
         * account (for example a user no longer in the LDAP directory), never for one notebook.
         */
        ABORT_RUN,

        /** The notebook was deleted or unshared after the list refresh (the server answers 404); the next refresh drops it. */
        LOST_ACCESS,

        /** A problem with this notebook alone: the others still sync, and the run is recorded as failed. */
        NOTEBOOK_FAILED,
    }

    internal fun notebookFailure(e: Exception): NotebookFailure = when (e) {
        // One notebook's listing could not finish; the server still answers, so the others go on.
        is PagedListingStalledException -> NotebookFailure.NOTEBOOK_FAILED
        is UnauthorizedException, is PermissionDeniedException, is ConnectionException,
        is TemporaryServerErrorException -> NotebookFailure.ABORT_RUN
        is NotFoundException -> NotebookFailure.LOST_ACCESS
        else -> NotebookFailure.NOTEBOOK_FAILED
    }

    internal enum class NotebooksOutcome { ALL_FETCHED, SOME_FAILED, STALE }

    /**
     * Fetches each notebook in turn so one notebook cannot stop the others: only failures that
     * would hit every notebook, and cancellation, end the run by propagating. STALE means the exact
     * account generation went away between notebooks.
     */
    internal fun <T> fetchEachNotebook(notebooks: List<T>, stillCurrent: () -> Boolean, fetch: (T) -> Unit): NotebooksOutcome {
        var failed = 0
        for (notebook in notebooks) {
            if (Thread.interrupted()) throw InterruptedException()
            if (!stillCurrent()) return NotebooksOutcome.STALE
            try {
                fetch(notebook)
            } catch (e: InterruptedException) {
                throw e
            } catch (e: StaleSyncRunException) {
                // The run itself is over, not this notebook.
                throw e
            } catch (e: Exception) {
                when (notebookFailure(e)) {
                    NotebookFailure.ABORT_RUN -> throw e
                    NotebookFailure.LOST_ACCESS ->
                        Logger.log.info("Skipping a notebook this account can no longer read: ${e.javaClass.name}")
                    NotebookFailure.NOTEBOOK_FAILED -> {
                        // A cancellation can surface as any exception; let the run record it as one.
                        if (Thread.currentThread().isInterrupted) throw e
                        Logger.log.log(Level.WARNING, "A notebook could not be synced; continuing with the others", e)
                        failed++
                    }
                }
            }
        }
        return if (failed > 0) NotebooksOutcome.SOME_FAILED else NotebooksOutcome.ALL_FETCHED
    }

    /**
     * Mirrors the adapters' item fetch: skip when the notebook's cursor is unchanged, else page until
     * done. The cached copy is compared by revision only and never decoded, so a note whose metadata
     * this client cannot decode cannot fail the page and pin the cursor. A page and its cursor are
     * written only if [guard] still allows it when the page arrives.
     */
    private fun fetchNotebookItems(cache: EtebaseLocalCache, colMgr: CollectionManager, notebook: Collection, guard: SyncRunGuard) {
        val colUid = notebook.uid
        val itemMgr = colMgr.getItemManager(notebook)
        var stoken = synchronized(cache) { cache.collectionLoadStoken(colUid) }
        if (notebook.stoken == stoken) {
            Logger.log.fine("Notebook unchanged; skipping item fetch")
            return
        }
        val paging = PagedListingGuard("notebook item", stoken, PagedListingGuard.MAX_ITEM_PAGES)
        do {
            if (Thread.interrupted()) throw InterruptedException()
            guard.check()
            val itemList = itemMgr.list(FetchOptions().stoken(stoken))
            synchronized(cache) {
                guard.write(cache) {
                    for (item in itemList.data) {
                        if (cache.itemEtag(itemMgr, colUid, item.uid) != item.etag) {
                            cache.itemSet(itemMgr, colUid, item)
                        }
                    }
                    itemList.stoken?.let { cache.collectionSaveStoken(colUid, it) }
                }
            }
            stoken = itemList.stoken
            paging.pageApplied(stoken, itemList.isDone)
        } while (!itemList.isDone)
    }
}
