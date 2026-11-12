package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.net.ConnectivityManager
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.AccountSettings

/** The device's network as a Notes run sees it, and the network rule decided for one account (design 3.6). */
internal object NotesNetwork {
    /** Test seam: stands in for the platform call of [read] and for nothing else; production leaves this null. */
    @VisibleForTesting
    @JvmField internal var readingOverride: (() -> NotesNetworkPolicy.Reading)? = null

    /**
     * The network as the account's own Wi-Fi switch reads it (syncConditionsAllow in
     * syncadapter/SyncAdapterService.kt): the active network, connected and of type Wi-Fi, with the
     * same calls on every API level from 29. No active network reads as NONE. That is not the same as
     * "no connection": the platform can report none under some VPNs while the device is online.
     *
     * The Wi-Fi name is never read. The manifest asks for no location permission, so from API 29
     * Android gives this app no Wi-Fi names, and a saved network name refuses without one (#971).
     *
     * The connectivity call itself is not guarded. The adapters do not guard it either, but they make
     * it only with the switch on and for a sync that is not manual. Here it is made for every run but
     * an automatic one a saved network name refuses (#971), also for one that no setting can refuse.
     * If it throws, the run ends as an unknown failure, unless it was canceled, and nothing is sent.
     */
    @Suppress("DEPRECATION")
    fun read(context: Context): NotesNetworkPolicy.Reading {
        readingOverride?.let { return it() }
        val info = (context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.activeNetworkInfo
        return NotesNetworkPolicy.Reading(NotesNetworkPolicy.connectionOf(present = info != null,
            connected = info?.isConnected == true, wifi = info?.type == ConnectivityManager.TYPE_WIFI))
    }

    /**
     * Whether a run for [account] may use the network it is on. Reads account data, and the network
     * unless a saved network name has refused the run already: call off the main thread.
     */
    fun verdict(context: Context, manager: AccountManager, account: Account, accountSettings: AccountSettings,
                explicit: Boolean): NotesNetworkPolicy.Verdict {
        val rule = NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)
        NotesNetworkPolicy.refusedUnread(explicit, rule)?.let { return it }
        return NotesNetworkPolicy.decide(explicit, AccountSettings.notesNetworkSettings(manager, account), rule, read(context))
    }
}
