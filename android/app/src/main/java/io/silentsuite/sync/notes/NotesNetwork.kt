package io.silentsuite.sync.notes

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import androidx.annotation.VisibleForTesting
import io.silentsuite.sync.AccountSettings

/** The device's network as a Notes run sees it, and the network rule decided for one account (design 3.6). */
internal object NotesNetwork {
    /**
     * Test seam: stands in for the platform calls of [read] and for nothing else; production leaves
     * this null. It is told whether the Wi-Fi name was asked for, so a test sees what [verdict] asks.
     */
    @VisibleForTesting
    @JvmField internal var readingOverride: ((withWifiName: Boolean) -> NotesNetworkPolicy.Reading)? = null

    /**
     * The network as the account's own Wi-Fi switch reads it (syncConditionsAllow in
     * syncadapter/SyncAdapterService.kt): the active network, connected and of type Wi-Fi, with the
     * same calls on every API level from 21. No active network reads as NONE. That is not the same as
     * "no connection": the platform can report none under some VPNs while the device is online.
     *
     * The Wi-Fi name is read only when [withWifiName] is set and the reading is Wi-Fi. A name the
     * platform withholds arrives as its unknown-name value and never matches, in the adapters' rule and
     * here alike. Two cases differ from the adapters: with no Wi-Fi info object their log line throws,
     * and a failed call to the Wi-Fi service is not caught there. Here both read as no name, which is a
     * refusal when the account has a name set.
     *
     * The connectivity call itself is not guarded. The adapters do not guard it either, but they make
     * it only with the switch on and for a sync that is not manual. Here it is made for every run, also
     * one that no setting can refuse. If it throws, the run ends as an unknown failure, unless it was
     * canceled, and nothing is sent.
     */
    @Suppress("DEPRECATION")
    fun read(context: Context, withWifiName: Boolean): NotesNetworkPolicy.Reading {
        readingOverride?.let { return it(withWifiName) }
        val info = (context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager)?.activeNetworkInfo
        val connection = NotesNetworkPolicy.connectionOf(present = info != null, connected = info?.isConnected == true,
            wifi = info?.type == ConnectivityManager.TYPE_WIFI)
        val name = if (withWifiName && connection == NotesNetworkPolicy.Connection.WIFI) {
            try {
                (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)?.connectionInfo?.ssid
            } catch (e: RuntimeException) {
                null
            }
        } else null
        return NotesNetworkPolicy.Reading(connection, name)
    }

    /**
     * Whether a run for [account] may use the network it is on. Reads account data and the network:
     * call off the main thread. The Wi-Fi name is asked for only when it can decide something: for a
     * run nobody started, on an account whose Wi-Fi-only switch is on and names a network.
     */
    fun verdict(context: Context, manager: AccountManager, account: Account, accountSettings: AccountSettings,
                explicit: Boolean): NotesNetworkPolicy.Verdict {
        val rule = NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)
        val reading = read(context, withWifiName = !explicit && rule.wifiOnly && rule.networkName != null)
        return NotesNetworkPolicy.decide(explicit, AccountSettings.notesNetworkSettings(manager, account), rule, reading)
    }
}
