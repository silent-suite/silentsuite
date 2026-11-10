package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import androidx.annotation.WorkerThread
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import io.silentsuite.sync.ui.PendingNotesRemovalGuard

/**
 * Setup recovery's removal of an incomplete account ([RecoveryRemovalCoordinator.Seams.begin]). Android removes that row
 * with removeAccountExplicitly, which never asks the authenticator, so the guard for unsynced Notes is asked here
 * first: only its yes starts the removal. A no, or a check that throws, reports a removal that did not finish, which
 * the screen offers to try again; every attempt asks the guard again. The stores the guard checks take one removal
 * hold ([RemovalHold]), so no save lands in them before the removal: a no releases it at once, a yes once the removal
 * reports, whatever it reports.
 *
 * The screen checks that it owns the account's generation before the work leaves the main thread. Another removal and
 * a sign-in with the same name can replace the row in between, so the generation is checked again here, after the
 * guard and right before the removal, under the lock a row's creation takes ([AccountCreationRegistry.ROW_LOCK]): no
 * sign-in in this process adds a row between that check and the removal.
 */
internal object GuardedRecoveryRemoval {
    /** Runs after the guard's yes and before the generation is checked again; debug builds only. */
    @Volatile internal var afterGuardForTest: (() -> Unit)? = null

    /**
     * [allows] first, off the main thread, with the hold its store checks take; then, under the row lock, [exact]
     * and [remove], which reports to [callback] itself. A no from either check, or a check that throws, reports false
     * to [callback] through [onMain].
     */
    @WorkerThread
    fun begin(
        allows: (RemovalHold) -> Boolean,
        exact: () -> Boolean,
        remove: ((Boolean) -> Unit) -> Unit,
        onMain: (() -> Unit) -> Unit,
        callback: (Boolean) -> Unit,
    ) {
        val hold = RemovalHold()
        val allowed = try {
            allows(hold)
        } catch (t: Throwable) {
            false
        }
        if (!allowed) {
            hold.release()
            onMain { callback(false) }
            return
        }
        try {
            afterGuardForTest?.also { check(BuildConfig.DEBUG) }?.invoke()
            synchronized(AccountCreationRegistry.ROW_LOCK) {
                val same = try {
                    exact()
                } catch (t: Throwable) {
                    false
                }
                if (!same) {
                    hold.release()
                    onMain { callback(false) }
                    return
                }
                remove { removed ->
                    hold.release()
                    callback(removed)
                }
            }
        } catch (t: Throwable) {
            hold.release()
            throw t
        }
    }

    /** The guard's yes for [account] on this device, with nothing to confirm; each store checked takes [hold]. */
    @WorkerThread
    fun allowsOnDevice(context: Context, account: Account, hold: RemovalHold): Boolean =
        PendingNotesRemovalGuard.allows(context, account, hold)

    /** Whether [account]'s row on this device is still the generation [creationId] that recovery owns. */
    @WorkerThread
    fun exactOnDevice(context: Context, account: Account, creationId: String): Boolean {
        val manager = AccountManager.get(context)
        val owned = AccountCreationRegistry.owns(AccountCreationRegistry.open(context).get(account.type, account.name),
            creationId)
        val present = account in manager.getAccountsByType(account.type)
        return sameGeneration(owned, present,
            if (present) manager.getUserData(account, AccountSettings.KEY_CREATION_ID) else null, creationId)
    }

    /**
     * The row is recovery's own when the registry still names [creationId] for it, and the row carries that creation
     * id or none: creation writes the id right after adding the row, so a row it stopped before that write has none,
     * while a sign-in that replaces the row first takes the registry for its own id. An absent row has nothing to
     * remove.
     */
    internal fun sameGeneration(registryOwns: Boolean, rowPresent: Boolean, rowCreationId: String?,
        creationId: String): Boolean =
        registryOwns && rowPresent && (rowCreationId.isNullOrBlank() || rowCreationId == creationId)
}
