package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.ContentResolver
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.os.PowerManager
import android.provider.CalendarContract
import android.provider.ContactsContract
import io.silentsuite.sync.App
import io.silentsuite.sync.syncadapter.SyncStatusStore

/**
 * Content-free scheduling report for support. It only reads state, prints fixed labels and
 * categories, and says "unknown" or "unavailable" instead of guessing.
 */
object SchedulingDiagnostics {
    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val MAX_COUNT = 99

    private class ServiceTarget(val label: String, val service: SyncStatusStore.Service, val authorities: List<Pair<String, String>>)

    private fun services() = listOf(
        ServiceTarget("Calendar", SyncStatusStore.Service.CALENDAR, listOf("provider" to CalendarContract.AUTHORITY)),
        ServiceTarget("Contacts", SyncStatusStore.Service.CONTACTS, listOf("provider" to App.addressBooksAuthority)),
        ServiceTarget("Tasks", SyncStatusStore.Service.TASKS, listOf(
            "OpenTasks" to "org.dmfs.tasks",
            "Tasks.org" to "org.tasks.opentasks"
        ))
    )

    @JvmStatic
    fun ageBucket(ageMillis: Long?): String = when {
        ageMillis == null || ageMillis < 0 -> "unknown"
        ageMillis < MINUTE -> "under_1m"
        ageMillis < 15 * MINUTE -> "1m_to_15m"
        ageMillis < HOUR -> "15m_to_1h"
        ageMillis < 6 * HOUR -> "1h_to_6h"
        ageMillis < 24 * HOUR -> "6h_to_24h"
        else -> "over_24h"
    }

    @JvmStatic
    fun standbyBucket(sdkInt: Int, bucket: Int?): String = when {
        sdkInt < 28 -> "unavailable"
        bucket == 5 -> "exempted"
        bucket == 10 -> "active"
        bucket == 20 -> "working_set"
        bucket == 30 -> "frequent"
        bucket == 40 -> "rare"
        bucket == 45 -> "restricted"
        else -> "unknown"
    }

    @JvmStatic
    fun report(context: Context): String {
        val appContext = context.applicationContext
        val now = System.currentTimeMillis()
        val out = StringBuilder("--- BEGIN SCHEDULING DIAGNOSTICS ---\n")
        appendPlatform(out, appContext)
        appendNetwork(out, appContext)
        appendAccounts(out, appContext, now)
        appendAddressBooks(out, appContext)
        out.append("\nNOTES\n")
            .append("Platform pending/active flags are device scheduler state; they are not matched to any recorded request.\n")
            .append("Ages are buckets relative to the device clock when this report was created.\n")
            .append("This report contains no account, server, collection or item details.\n")
            .append("--- END SCHEDULING DIAGNOSTICS ---\n")
        return out.toString()
    }

    private fun appendPlatform(out: StringBuilder, context: Context) {
        val power = service<PowerManager>(context, Context.POWER_SERVICE)
        val activity = service<ActivityManager>(context, Context.ACTIVITY_SERVICE)
        val packageId = context.packageName
        out.append("PLATFORM\n")
        out.append("Battery optimization exemption: ").append(flag {
            if (Build.VERSION.SDK_INT >= 23) power?.isIgnoringBatteryOptimizations(packageId) else null
        }).append("\n")
        out.append("Battery saver: ").append(flag { power?.isPowerSaveMode }).append("\n")
        out.append("Device idle: ").append(flag {
            if (Build.VERSION.SDK_INT >= 23) power?.isDeviceIdleMode else null
        }).append("\n")
        out.append("Background restricted: ").append(flag {
            if (Build.VERSION.SDK_INT >= 28) activity?.isBackgroundRestricted else null
        }).append("\n")
        out.append("Standby bucket: ").append(standbyBucket(Build.VERSION.SDK_INT, currentStandbyBucket(context))).append("\n")
        out.append("System-wide automatic sync: ").append(flag { ContentResolver.getMasterSyncAutomatically() }).append("\n")
    }

    private fun currentStandbyBucket(context: Context): Int? = try {
        if (Build.VERSION.SDK_INT >= 28)
            service<UsageStatsManager>(context, Context.USAGE_STATS_SERVICE)?.appStandbyBucket
        else
            null
    } catch (e: Exception) {
        null
    }

    private fun appendNetwork(out: StringBuilder, context: Context) {
        val connectivity = service<ConnectivityManager>(context, Context.CONNECTIVITY_SERVICE)
        var sampled = false
        val capabilities: NetworkCapabilities? = try {
            if (Build.VERSION.SDK_INT >= 23 && connectivity != null) {
                val network = connectivity.activeNetwork
                sampled = true
                if (network != null) connectivity.getNetworkCapabilities(network) else null
            } else
                null
        } catch (e: Exception) {
            sampled = false
            null
        }
        out.append("\nNETWORK\n")
        out.append("Active network: ").append(when {
            Build.VERSION.SDK_INT < 23 || connectivity == null -> "unavailable"
            !sampled -> "unknown"
            capabilities != null -> "yes"
            else -> "no"
        }).append("\n")
        out.append("Validated: ").append(flag {
            if (Build.VERSION.SDK_INT >= 23) capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) else null
        }).append("\n")
        out.append("Metered: ").append(flag { connectivity?.isActiveNetworkMetered }).append("\n")
        out.append("VPN: ").append(flag { capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) }).append("\n")
        out.append("Wi-Fi: ").append(flag { capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) }).append("\n")
        out.append("Cellular: ").append(flag { capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) }).append("\n")
        out.append("Data Saver: ").append(try {
            if (Build.VERSION.SDK_INT >= 24 && connectivity != null)
                when (connectivity.restrictBackgroundStatus) {
                    ConnectivityManager.RESTRICT_BACKGROUND_STATUS_DISABLED -> "off"
                    ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "on_app_exempted"
                    ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "on"
                    else -> "unknown"
                }
            else
                "unavailable"
        } catch (e: Exception) {
            "unknown"
        }).append("\n")
    }

    private fun appendAccounts(out: StringBuilder, context: Context, now: Long) {
        out.append("\nMAIN ACCOUNTS\n")
        val accounts = accountsOfType(context, App.accountType)
        if (accounts == null) {
            out.append("Count: unknown\n")
            return
        }
        out.append("Count: ").append(count(accounts.size)).append("\n")
        val store = try {
            SyncStatusStore(context)
        } catch (e: Exception) {
            null
        }
        for ((index, account) in accounts.take(MAX_COUNT).withIndex()) {
            out.append("Account #").append(index + 1)
            val sample = if (store != null) sampleAccount(context, store, account, now) else null
            if (sample == null)
                out.append(": changed or unavailable while sampling; sample dropped\n")
            else
                out.append("\n").append(sample)
        }
    }

    /** Returns null unless the same account generation was present before and after sampling. */
    private fun sampleAccount(context: Context, store: SyncStatusStore, account: Account, now: Long): String? = try {
        val before = store.identity(account)
        val sample = StringBuilder()
        for (target in services()) {
            sample.append("  ").append(target.label).append("\n")
            for ((label, authority) in target.authorities)
                sample.append("    platform (").append(label).append("): syncable=").append(syncable(account, authority))
                    .append(" automatic=").append(flag { ContentResolver.getSyncAutomatically(account, authority) })
                    .append(" pending=").append(flag { ContentResolver.isSyncPending(account, authority) })
                    .append(" active=").append(flag { ContentResolver.isSyncActive(account, authority) })
                    .append("\n")
            appendRecorded(sample, store.status(before, target.service), now)
        }
        val present = accountsOfType(context, App.accountType)?.contains(account) == true
        if (present && store.identity(account) == before) sample.toString() else null
    } catch (e: Exception) {
        null
    }

    private fun appendRecorded(out: StringBuilder, status: SyncStatusStore.Status, now: Long) {
        out.append("    recorded request: ").append(if (status.activeRequestId != null) "open" else "none")
            .append(" age=").append(age(status.requestedAt, now)).append("\n")
        out.append("    recorded attempt: ").append(if (status.activeAttemptId != null) "open" else "none")
            .append(" age=").append(age(status.attemptStartedAt, now))
            .append(" for open request=").append(when {
                status.activeAttemptId == null || status.attemptRequestId == null || status.activeRequestId == null -> "unknown"
                status.attemptRequestId == status.activeRequestId -> "yes"
                else -> "no"
            }).append("\n")
        out.append("    last result: ").append(when (status.lastTerminalResult) {
            SyncStatusStore.TerminalResult.SUCCESS -> "success"
            SyncStatusStore.TerminalResult.FAILURE -> "failure"
            null -> "none"
        }).append(" age=").append(age(status.lastTerminalAt, now)).append("\n")
        out.append("    last success age=").append(age(status.lastSuccessAt, now))
            .append(" last failure age=").append(age(status.lastFailureAt, now))
            .append(" category=").append(failureCategory(status.lastFailureCategory)).append("\n")
        out.append("    incomplete=").append(if (status.latestGenerationIncomplete) "yes" else "no")
            .append(" pending children=").append(count(status.pendingChildren))
            .append(" storage=").append(if (status.structuralStorageFailure) "unknown" else "readable").append("\n")
    }

    private fun appendAddressBooks(out: StringBuilder, context: Context) {
        out.append("\nADDRESS BOOK ACCOUNTS (whole device, not associated with a main account)\n")
        val accounts = accountsOfType(context, App.addressBookAccountType)
        if (accounts == null) {
            out.append("Count: unknown\n")
            return
        }
        out.append("Count: ").append(count(accounts.size)).append("\n")
        val authority = ContactsContract.AUTHORITY
        for ((label, read) in listOf<Pair<String, (Account) -> Boolean>>(
            "Automatic" to { account -> ContentResolver.getSyncAutomatically(account, authority) },
            "Pending" to { account -> ContentResolver.isSyncPending(account, authority) },
            "Active" to { account -> ContentResolver.isSyncActive(account, authority) }
        )) {
            var yes = 0
            var no = 0
            var unknown = 0
            for (account in accounts)
                when (flag { read(account) }) {
                    "yes" -> yes++
                    "no" -> no++
                    else -> unknown++
                }
            out.append(label).append(": yes=").append(count(yes)).append(" no=").append(count(no))
                .append(" unknown=").append(count(unknown)).append("\n")
        }
    }

    private fun accountsOfType(context: Context, type: String): List<Account>? = try {
        AccountManager.get(context).getAccountsByType(type).toList()
    } catch (e: Exception) {
        null
    }

    private fun syncable(account: Account, authority: String): String = try {
        val value = ContentResolver.getIsSyncable(account, authority)
        when {
            value > 0 -> "yes"
            value == 0 -> "no"
            else -> "unknown"
        }
    } catch (e: Exception) {
        "unknown"
    }

    private fun age(timestamp: Long?, now: Long): String = when {
        timestamp == null -> "none"
        timestamp <= 0 || now <= 0 || timestamp > now -> "unknown"
        else -> ageBucket(now - timestamp)
    }

    private fun count(value: Int): String = when {
        value < 0 -> "unknown"
        value > MAX_COUNT -> "over_$MAX_COUNT"
        else -> value.toString()
    }

    private fun failureCategory(category: SyncStatusStore.FailureCategory?): String = when (category) {
        null -> "none"
        SyncStatusStore.FailureCategory.NETWORK -> "network"
        SyncStatusStore.FailureCategory.AUTHENTICATION -> "authentication"
        SyncStatusStore.FailureCategory.PERMISSION -> "permission"
        SyncStatusStore.FailureCategory.PROVIDER -> "provider"
        SyncStatusStore.FailureCategory.STORAGE -> "storage"
        SyncStatusStore.FailureCategory.CONFIGURATION -> "configuration"
        SyncStatusStore.FailureCategory.SETUP_REQUIRED -> "setup_required"
        SyncStatusStore.FailureCategory.PARENT_REFRESH -> "parent_refresh"
        SyncStatusStore.FailureCategory.CHILD_REMOVED -> "child_removed"
        SyncStatusStore.FailureCategory.UNKNOWN -> "unknown"
        SyncStatusStore.FailureCategory.INTERRUPTED -> "interrupted"
    }

    private inline fun <reified T> service(context: Context, id: String): T? = try {
        context.getSystemService(id) as? T
    } catch (e: Exception) {
        null
    }

    private inline fun flag(read: () -> Boolean?): String = try {
        when (read()) {
            true -> "yes"
            false -> "no"
            null -> "unavailable"
        }
    } catch (e: Exception) {
        "unknown"
    }
}
