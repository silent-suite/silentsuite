package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.ui.ExactAccountIdentity
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Future
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.logging.Level

/**
 * In-app Notes sync job. Notes has no Android sync authority, so this object owns scheduling,
 * single-flight admission, cancellation, and change notification; [NotesSyncRunner] does the work
 * and reports into [io.silentsuite.sync.syncadapter.SyncStatusStore] as the NOTES service.
 *
 * Triggers: a manual sync, enabling the toggle, opening or refreshing the Notes screen, and a
 * piggyback run after a system-scheduled adapter sync. There is no separate background schedule.
 */
object NotesSyncCoordinator {
    interface Listener {
        fun onNotesSyncStateChanged(identity: ExactAccountIdentity)
    }

    private val policy = NotesSyncPolicy()
    private val lock = Any()
    private val slots = HashMap<ExactAccountIdentity, NotesSyncPolicy.Slot>()
    private val futures = HashMap<ExactAccountIdentity, Future<*>>()

    /**
     * The token of the run in progress for each identity. [cancel] removes it, so a run learns it
     * was cancelled even when its interrupt was consumed inside a network call.
     */
    private val runs = HashMap<ExactAccountIdentity, Any>()
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * One worker per account name, so a slow request for one account never delays another. Runs
     * for the same name keep the order they were submitted in, whatever their generation: they
     * share that name's cache directory. A worker's thread ends once it has been idle for
     * [WORKER_IDLE_SECONDS]. Guarded by [lock].
     */
    private val workers = HashMap<Pair<String, String>, ThreadPoolExecutor>()
    private const val WORKER_IDLE_SECONDS = 30L

    /** Test seam: replaces the network job; production leaves this null. */
    @VisibleForTesting
    @JvmField internal var runnerOverride: ((Context, Account, String, NotesSyncRunner.Request) -> Unit)? = null

    /**
     * @param forceRefresh list the collections from scratch rather than from the saved cursor, as
     * the adapters do after an invitation is accepted; kept through coalescing (see [NotesSyncPolicy]).
     */
    fun request(
        context: Context,
        account: Account,
        creationId: String,
        trigger: NotesSyncPolicy.Trigger,
        requestId: String? = null,
        forceRefresh: Boolean = false,
    ): NotesSyncPolicy.Decision {
        require(creationId.isNotBlank()) { "Notes sync needs the exact account generation" }
        val identity = ExactAccountIdentity(account.type, account.name, creationId)
        val decision: NotesSyncPolicy.Decision
        synchronized(lock) {
            val (next, decided) = policy.request(slots[identity] ?: NotesSyncPolicy.Slot(), trigger, requestId, forceRefresh)
            slots[identity] = next
            decision = decided
            if (decision == NotesSyncPolicy.Decision.START) submit(context.applicationContext, account, identity)
        }
        if (decision != NotesSyncPolicy.Decision.DROPPED) notify(identity)
        return decision
    }

    /** Called by the adapters after an uncorrelated sync; only runs when Notes is enabled. */
    fun piggybackAfterAdapterSync(context: Context, account: Account, creationId: String) {
        if (!AccountSettings.notesEnabled(AccountManager.get(context), account)) return
        request(context, account, creationId, NotesSyncPolicy.Trigger.PIGGYBACK, null)
    }

    fun isActive(identity: ExactAccountIdentity): Boolean = synchronized(lock) {
        slots[identity]?.state == NotesSyncPolicy.State.RUNNING
    }

    fun isPending(identity: ExactAccountIdentity): Boolean = synchronized(lock) {
        slots[identity]?.state == NotesSyncPolicy.State.PENDING
    }

    fun cancel(identity: ExactAccountIdentity) {
        val future: Future<*>?
        synchronized(lock) {
            future = futures.remove(identity)
            slots.remove(identity)
            runs.remove(identity)
        }
        future?.cancel(true)
        notify(identity)
    }

    /** Sign-out only knows the account row; stop every generation that shares its name. */
    fun cancelAccount(type: String, name: String) {
        val matching = synchronized(lock) { slots.keys.filter { it.type == type && it.name == name } }
        matching.forEach(::cancel)
    }

    /**
     * Test seam: waits until every job submitted before this call has finished, cancelled ones
     * included (each worker runs its jobs in order). False if that took longer than [timeoutMillis].
     */
    @VisibleForTesting
    internal fun drainForTesting(timeoutMillis: Long): Boolean {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis)
        val markers = synchronized(lock) { workers.values.map { it.submit {} } }
        return markers.all { marker ->
            runCatching { marker.get(deadline - System.nanoTime(), TimeUnit.NANOSECONDS) }.isSuccess
        }
    }

    /** Process-only diagnostic for runtime tests; never used in production paths. */
    @VisibleForTesting
    internal fun snapshotForTesting(identity: ExactAccountIdentity): String = synchronized(lock) {
        val future = futures[identity]
        "slot=${slots[identity]} future=${future?.let { "cancelled=${it.isCancelled} done=${it.isDone}" }} slots=${slots.size}"
    }

    fun addListener(listener: Listener) {
        listeners.addIfAbsent(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    private fun submit(appContext: Context, account: Account, identity: ExactAccountIdentity) {
        val worker = workers.getOrPut(identity.type to identity.name) {
            ThreadPoolExecutor(1, 1, WORKER_IDLE_SECONDS, TimeUnit.SECONDS, LinkedBlockingQueue()) { runnable ->
                Thread(runnable, "silentsuite-notes-sync").apply { isDaemon = true }
            }.apply { allowCoreThreadTimeOut(true) }
        }
        futures[identity] = worker.submit { execute(appContext, account, identity) }
    }

    private fun execute(appContext: Context, account: Account, identity: ExactAccountIdentity) {
        val request: NotesSyncRunner.Request
        val token = Any()
        synchronized(lock) {
            val slot = slots[identity]
            // A cancellation between submission and start leaves nothing to run.
            if (slot == null || slot.state != NotesSyncPolicy.State.PENDING) return
            runs[identity] = token
            request = NotesSyncRunner.Request(slot.queuedRequestId, slot.manual, slot.forceRefresh) {
                synchronized(lock) { runs[identity] === token }
            }
            slots[identity] = policy.started(slot)
        }
        notify(identity)
        var listedCollections = false
        try {
            val override = runnerOverride
            listedCollections = if (override != null) {
                override(appContext, account, identity.creationId, request)
                true
            } else {
                NotesSyncRunner.run(appContext, account, identity.creationId, request)
            }
        } catch (e: Throwable) {
            // The runner records its own outcomes; anything escaping it must not kill the executor.
            Logger.log.log(Level.SEVERE, "Notes sync job failed unexpectedly", e)
        } finally {
            synchronized(lock) {
                if (runs[identity] === token) runs.remove(identity)
                val slot = slots[identity]
                // Only settle the slot this run owns. After cancel() removed it, a PENDING slot in
                // the map belongs to a newer request whose queued task must be left alone.
                if (slot != null && slot.state == NotesSyncPolicy.State.RUNNING) {
                    val (next, _) = policy.finished(slot, forcedRefreshOwed = request.forceRefresh && !listedCollections)
                    if (next.state == NotesSyncPolicy.State.IDLE) {
                        // An idle slot stays only to carry a forced refresh this run still owes.
                        if (next.forceRefresh) slots[identity] = next else slots.remove(identity)
                        futures.remove(identity)
                    } else {
                        slots[identity] = next
                        submit(appContext, account, identity)
                    }
                }
            }
            Thread.interrupted() // clear a cancellation flag before the worker thread is reused
            notify(identity)
        }
    }

    private fun notify(identity: ExactAccountIdentity) {
        if (listeners.isEmpty()) return
        mainHandler.post {
            listeners.forEach { listener ->
                try {
                    listener.onNotesSyncStateChanged(identity)
                } catch (e: Exception) {
                    Logger.log.log(Level.WARNING, "Notes sync listener failed", e)
                }
            }
        }
    }
}
