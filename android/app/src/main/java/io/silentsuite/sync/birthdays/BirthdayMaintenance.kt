package io.silentsuite.sync.birthdays

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.EtebaseLocalCache
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.ui.setup.ExactAccountRouting

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
    fun run(context: Context, main: Account, admitted: SyncStatusStore.MainIdentity?, trigger: String) {
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
            val settings = AccountSettings(context, row)
            HttpClient.Builder(context, settings).setForeground(false).build().use { httpClient ->
                val etebase = EtebaseLocalCache.getEtebase(context, httpClient.okHttpClient, settings)
                val result = BirthdayReconciler.reconcile(etebase, settings.username(), gate)
                Logger.log.info("Birthdays after the $trigger: ${result.status} ${result.reason ?: ""}")
            }
        } catch (e: Exception) {
            Logger.log.warning("Birthdays after the $trigger did not run (${e.javaClass.simpleName})")
        }
    }
}
