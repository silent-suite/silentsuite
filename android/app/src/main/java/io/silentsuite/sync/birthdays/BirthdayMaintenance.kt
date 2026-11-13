package io.silentsuite.sync.birthdays

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.content.Context
import android.os.Bundle
import android.provider.CalendarContract
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.CollectionListRefresh
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.putSyncMainIdentity
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import okhttp3.OkHttpClient
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Whether one Birthdays maintenance run may use the main account row it re-selected (plan amendment G2 §2.1). */
internal enum class BirthdayOwnership { PROCEED, NO_ACCOUNT, NO_GENERATION, NO_ADMISSION, STALE_RUN }

/**
 * The ownership decision (G2 §2.1, J1), pure: whether a run may use the row it re-selected. The checks run
 * in order: no listed row, a missing or blank creation generation, no admitted identity, and only then the
 * identity [identityOf] gives for that generation (asked once, with the generation as read), which must
 * equal the admitted one.
 */
internal fun birthdayOwnership(
    rowPresent: Boolean,
    creationId: String?,
    admitted: SyncStatusStore.MainIdentity?,
    identityOf: (String) -> SyncStatusStore.MainIdentity,
): BirthdayOwnership {
    if (!rowPresent) return BirthdayOwnership.NO_ACCOUNT
    if (creationId == null || creationId.isBlank()) return BirthdayOwnership.NO_GENERATION
    if (admitted == null) return BirthdayOwnership.NO_ADMISSION
    return if (identityOf(creationId) == admitted) BirthdayOwnership.PROCEED else BirthdayOwnership.STALE_RUN
}

/**
 * One Birthdays maintenance run for a main account, after an address-book refresh or sync (G2 §2.1). The
 * row is re-selected now and its own generation must resolve to the identity the run was admitted for;
 * otherwise nothing runs. Legacy rows without a generation are left alone. While it runs, the engine asks
 * the gate before every request: the exact generation must still be the listed row's, and the thread must
 * not be interrupted. A request already handed to the SDK is not called back. Its result, and any failure to
 * start it, never changes the calling sync's outcome; only the trigger, an outcome or an exception class is
 * logged.
 */
internal object BirthdayMaintenance {
    /** The run of one main account in progress in this process, and whether one more pass was asked for meanwhile. */
    private class Slot {
        var pending = false
        var pendingAdmitted: SyncStatusStore.MainIdentity? = null
        var pendingTrigger = ""
    }

    /** Guards [slots]; [freed] is signalled whenever a slot is released, for an explicit turn waiting for its account. */
    private val lock = ReentrantLock()
    private val freed = lock.newCondition()
    private val slots = HashMap<Pair<String, String>, Slot>()

    /**
     * One run at a time per main account in this process (plan2 §2 step 10), shared with [turn]. A trigger that
     * arrives while a maintenance run or a turn of the same account is in progress only asks for one more pass, with
     * its own admitted identity, and returns at once; the running caller then runs exactly one more pass for all such
     * triggers before it finishes. Every pass is [runOnce], with its own ownership and gate checks. An interrupted
     * caller starts no further pass. The slot is released in the same locked step that finds nothing pending, so a
     * trigger is never coalesced into a run that has already decided to stop. Nothing runs while the account has the
     * experimental Birthdays calendar turned off ([optedIn]).
     */
    fun run(context: Context, main: Account, admitted: SyncStatusStore.MainIdentity?, trigger: String) {
        if (!optedIn(context, main)) {
            Logger.log.info("Birthdays after the $trigger skipped (off)")
            return
        }
        val key = main.type to main.name
        val mine = Slot()
        lock.withLock {
            val running = slots[key]
            if (running != null) {
                running.pending = true
                running.pendingAdmitted = admitted
                running.pendingTrigger = trigger
                Logger.log.info("Birthdays after the $trigger coalesced into the running pass")
                return
            }
            slots[key] = mine
        }
        try {
            var next: Pair<SyncStatusStore.MainIdentity?, String>? = admitted to trigger
            while (next != null) {
                runOnce(context, main, next.first, next.second)
                next = releaseOrNext(key, mine)
            }
        } finally {
            // Normal exits already released the slot in releaseOrNext; this releases it only after an abnormal end
            // (an Error), and never removes a later run's slot.
            release(key, mine)
        }
    }

    /**
     * In one locked step: the identity and trigger of the one more pass asked for while [mine] ran, or null after
     * releasing the slot when nothing is pending or the thread is interrupted (that follow-up is then not started).
     */
    private fun releaseOrNext(key: Pair<String, String>, mine: Slot): Pair<SyncStatusStore.MainIdentity?, String>? {
        lock.withLock {
            if (!mine.pending) {
                release(key, mine)
                return null
            }
            if (Thread.currentThread().isInterrupted) {
                Logger.log.info("Birthdays follow-up after the ${mine.pendingTrigger} not started (stopped)")
                release(key, mine)
                return null
            }
            mine.pending = false
            return mine.pendingAdmitted to mine.pendingTrigger
        }
    }

    /**
     * Whether [main] has the experimental Birthdays calendar turned on (AccountSettings.birthdaysEnabled). Absent is
     * off, and any failure to read it, including getting the account manager, is off.
     */
    private fun optedIn(context: Context, main: Account): Boolean = try {
        AccountSettings.birthdaysEnabled(AccountManager.get(context), main)
    } catch (e: Exception) {
        false
    }

    /** Releases the slot of [key] if it is still [mine], and wakes any turn waiting for it. */
    private fun release(key: Pair<String, String>, mine: Slot) {
        lock.withLock {
            if (slots[key] === mine) {
                slots.remove(key)
                freed.signalAll()
            }
        }
    }

    private fun runOnce(context: Context, main: Account, admitted: SyncStatusStore.MainIdentity?, trigger: String) {
        try {
            val manager = AccountManager.get(context)
            val row = manager.getAccountsByType(App.accountType).singleOrNull { it.name == main.name && it.type == main.type }
            val creationId = row?.let { manager.getUserData(it, AccountSettings.KEY_CREATION_ID) }?.takeIf { it.isNotBlank() }
            val ownership = birthdayOwnership(row != null, creationId, admitted) { SyncStatusStore(context).identity(checkNotNull(row), it) }
            if (ownership != BirthdayOwnership.PROCEED || row == null || creationId == null) {
                Logger.log.info("Birthdays after the $trigger skipped (${ownership.name.lowercase()})")
                return
            }
            val gate = {
                ExactAccountRouting.validate(row, creationId, App.accountType, manager) != null &&
                    !Thread.currentThread().isInterrupted
            }
            if (!gate()) {
                Logger.log.info("Birthdays after the $trigger skipped (stopped)")
                return
            }
            withOwnedSession(context, row) { settings, _, etebase ->
                val result = BirthdayReconciler.reconcile(etebase, settings.username(), gate)
                Logger.log.info("Birthdays after the $trigger: ${result.status} ${result.reason ?: ""}")
                if (result.written.isNotEmpty() && gate()) requestCalendarSyncAfterWrites(context, row, "after the $trigger")
            }
        } catch (e: Exception) {
            Logger.log.warning("Birthdays after the $trigger did not run (${e.javaClass.simpleName})")
        }
    }

    /**
     * One Birthdays turn-on ([on]) or turn-off from the dashboard (plan3 §3), for exactly the main account
     * [main] at the generation [creationId] the caller holds; [stillWanted] is the caller's own ownership
     * check. The gate is that check, the exact generation still being the listed row's, and an uninterrupted
     * thread: nothing runs unless it holds, and the engine asks it before every request (C1-C5). After a
     * run that wrote something, while the gate still holds, this account's collection cache is refreshed for
     * that generation so the dashboard can show the result. The refresh is forced: the run changed calendars
     * through its own SDK reads and writes, so a recent refresh of this generation no longer describes the
     * server, and its burst window must not skip this one. A forced refresh records its full-refresh
     * obligation before any request, so one that fails or stops leaves it for the next refresh; it changes
     * nothing about the run. A run that wrote then asks for one calendar sync of this account while the gate
     * still holds. Returns the run's result, or null when it did not run. Never throws; logs only an outcome
     * or an exception class.
     *
     * The turn shares [run]'s one slot per main account in this process (plan2 §2 step 10). It is never coalesced
     * or dropped: it waits until the slot is free and checks its gate only after taking it. An interrupt while it
     * waits returns null without taking the slot. Maintenance triggers that arrive while it runs ask for one more
     * pass, which runs as [runOnce] before the turn returns; the turn still returns its own result. While the account
     * has the experimental Birthdays calendar turned off ([optedIn]), it returns null at once.
     */
    fun turn(context: Context, main: Account, creationId: String, on: Boolean, stillWanted: () -> Boolean): BirthdayReconciler.RunResult? {
        val action = if (on) "turn-on" else "turn-off"
        if (!optedIn(context, main)) {
            Logger.log.info("Birthdays $action skipped (off)")
            return null
        }
        val key = main.type to main.name
        val mine = Slot()
        try {
            lock.withLock {
                while (slots[key] != null) freed.await()
                slots[key] = mine
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            Logger.log.info("Birthdays $action skipped (stopped)")
            return null
        }
        try {
            val result = turnOnce(context, main, creationId, on, action, stillWanted)
            var next = releaseOrNext(key, mine)
            while (next != null) {
                runOnce(context, main, next.first, next.second)
                next = releaseOrNext(key, mine)
            }
            return result
        } finally {
            // Normal exits already released the slot in releaseOrNext; this releases it only after an abnormal end.
            release(key, mine)
        }
    }

    /** The turn's own engine run, cache refresh and calendar sync request, while the caller holds the account's slot. */
    private fun turnOnce(context: Context, main: Account, creationId: String, on: Boolean, action: String,
        stillWanted: () -> Boolean): BirthdayReconciler.RunResult? {
        return try {
            val manager = AccountManager.get(context)
            val gate = {
                stillWanted() && ExactAccountRouting.validate(main, creationId, App.accountType, manager) != null &&
                    !Thread.currentThread().isInterrupted
            }
            if (!gate()) {
                Logger.log.info("Birthdays $action skipped (stopped)")
                return null
            }
            withOwnedSession(context, main) { settings, httpClient, etebase ->
                val result = if (on) BirthdayReconciler.enable(etebase, settings.username(), gate)
                    else BirthdayReconciler.disable(etebase, settings.username(), gate)
                Logger.log.info("Birthdays $action: ${result.status} ${result.reason ?: ""}")
                if (result.written.isNotEmpty() && gate()) {
                    try {
                        CollectionListRefresh.run(context, main, settings, httpClient, true, creationId, gate)
                    } catch (e: Exception) {
                        Logger.log.info("Birthdays $action cache refresh deferred (${e.javaClass.simpleName})")
                    }
                }
                if (result.written.isNotEmpty() && gate()) requestCalendarSyncAfterWrites(context, main, action)
                result
            }
        } catch (e: Exception) {
            Logger.log.warning("Birthdays $action did not run (${e.javaClass.simpleName})")
            null
        }
    }

    /** This account's settings, a background transport and its Etebase session from the stored session, for [block] only. */
    private inline fun <T> withOwnedSession(context: Context, row: Account,
        block: (AccountSettings, OkHttpClient, com.etebase.client.Account) -> T): T {
        val settings = AccountSettings(context, row)
        return HttpClient.Builder(context, settings).setForeground(false).build().use { httpClient ->
            val etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
            block(settings, httpClient.okHttpClient, etebase)
        }
    }

    /**
     * Asks for one manual sync of the calendar authority alone for [account] after a run wrote (plan2 §3), bound to
     * the account's current identity so a replaced account skips it. Contacts are not requested: a contacts sync
     * triggers Birthdays again. No request id and no dashboard state. A failure to ask changes nothing about the run.
     */
    private fun requestCalendarSyncAfterWrites(context: Context, account: Account, label: String) {
        try {
            val extras = Bundle()
            extras.putBoolean(ContentResolver.SYNC_EXTRAS_MANUAL, true)
            extras.putBoolean(ContentResolver.SYNC_EXTRAS_EXPEDITED, true)
            putSyncMainIdentity(extras, SyncStatusStore(context).identity(account))
            requestSyncDispatchOverride?.invoke(account, CalendarContract.AUTHORITY, extras)
                ?: ContentResolver.requestSync(account, CalendarContract.AUTHORITY, extras)
        } catch (e: Exception) {
            Logger.log.info("Birthdays $label: calendar sync not requested (${e.javaClass.simpleName})")
        }
    }
}
