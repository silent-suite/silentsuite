package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.content.Context
import androidx.annotation.WorkerThread
import io.silentsuite.sync.notes.edit.PendingNotesStore.RemovalHold
import io.silentsuite.sync.ui.PendingNotesRemovalGuard

/**
 * Setup recovery's removal of an incomplete account ([RecoveryRemovalCoordinator.Seams.begin]). Android removes that row
 * with removeAccountExplicitly, which never asks the authenticator, so the guard for unsynced Notes is asked here
 * first: only its yes starts the removal. A no, or a check that throws, reports a removal that did not finish, which
 * the screen offers to try again; every attempt asks the guard again. The stores the guard checks take one removal
 * hold ([RemovalHold]), so no save lands in them before the removal: a no releases it at once, a yes once the removal
 * reports, whatever it reports.
 */
internal object GuardedRecoveryRemoval {
    /**
     * [allows] first, off the main thread, with the hold its store checks take; then [remove], which reports to
     * [callback] itself, or else [callback] with false, posted through [onMain].
     */
    @WorkerThread
    fun begin(
        allows: (RemovalHold) -> Boolean,
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
            remove { removed ->
                hold.release()
                callback(removed)
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
}
