/*
 * Copyright © 2013 – 2015 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.annotation.SuppressLint
import android.app.Application
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import at.bitfire.ical4android.TaskProvider.ProviderName
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.*
import io.silentsuite.sync.Constants.KEY_ACCOUNT
import io.silentsuite.sync.resource.LocalAddressBook
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class DebugInfoActivity : BaseActivity() {

    internal lateinit var tvReport: TextView
    internal lateinit var report: String

    internal var reportFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContentView(R.layout.activity_debug_info)
        tvReport = findViewById(R.id.text_report)

        val model = ViewModelProvider(this).get(ReportViewModel::class.java)
        model.reportData.observe(this) { data ->
            if (data != null) {
                report = data
                tvReport.text = report
            }
        }
        if (savedInstanceState == null) {
            model.generateReport(intent.extras)
        }
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_debug_info, menu)
        return true
    }


    fun onShare(item: MenuItem) {
        val sendIntent = Intent().apply {
            action = Intent.ACTION_SEND
            putExtra(Intent.EXTRA_TEXT, report)
            type = "text/plain"
        }
        startActivity(Intent.createChooser(sendIntent, "Share debug info"))
    }


    internal class ReportViewModel(application: Application) : AndroidViewModel(application) {
        val reportData = MutableLiveData<String>()

        fun generateReport(extras: Bundle?) {
            viewModelScope.launch {
                val result = withContext(Dispatchers.IO) {
                    if (extras?.getBoolean(KEY_SCHEDULING_ONLY) == true) SchedulingDiagnostics.report(getApplication<Application>()) else buildReport(extras)
                }
                reportData.value = result
            }
        }

        @SuppressLint("MissingPermission")
        private fun buildReport(extras: Bundle?): String {
            var throwable: Throwable? = null
            var logs: String? = null
            var account: Account? = null
            var phase: String? = null

            if (extras != null) {
                throwable = extras.getSerializable(KEY_THROWABLE) as Throwable?
                logs = extras.getString(KEY_LOGS)
                account = extras.getParcelable(KEY_ACCOUNT)
                phase = if (extras.containsKey(KEY_PHASE)) getApplication<Application>().getString(extras.getInt(KEY_PHASE)) else null
            }

            val context = getApplication<Application>()
            val report = StringBuilder("--- BEGIN DEBUG INFO ---\n")

            // begin with most specific information

            if (phase != null)
                report.append("SYNCHRONIZATION INFO\nSynchronization phase: ").append(phase).append("\n")
            if (account != null)
                report.append("Account: [redacted]\n")

            if (throwable is com.etebase.client.exceptions.HttpException) {
                report.append("\nHTTP ERROR:\n").append(throwable.javaClass.name).append("\n")
            }

            if (throwable != null)
                report.append("\nEXCEPTION:\n")
                        .append(exceptionClassChain(throwable)).append("\n")

            if (logs != null)
                report.append("\nLOGS:\n[redacted from shared debug report]\n")

            report.append("\nSOFTWARE INFORMATION\n" + "SilentSuite version: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(")\n")

            report.append("CONFIGURATION\n")
            // power saving
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
            if (powerManager != null)
                report.append("Battery optimization exemption: ")
                        .append(if (powerManager.isIgnoringBatteryOptimizations(BuildConfig.APPLICATION_ID)) "yes" else "no")
                        .append("\n")
            // permissions
            for (permission in arrayOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS, Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR) + ProviderName.OpenTasks.permissions + ProviderName.TasksOrg.permissions)
                report.append(permission).append(" permission: ")
                        .append(if (ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED) "granted" else "denied")
                        .append("\n")
            // system-wide sync settings
            report.append("System-wide synchronization: ")
                    .append(if (ContentResolver.getMasterSyncAutomatically()) "automatically" else "manually")
                    .append("\n")
            // main accounts
            val accountManager = AccountManager.get(context)
            for ((idx, acct) in accountManager.getAccountsByType(context.getString(R.string.account_type)).withIndex())
                try {
                    val settings = AccountSettings(context, acct)
                    report.append("Account #").append(idx + 1).append("\n" + "  Address book sync. interval: ").append(syncStatus(settings, App.addressBooksAuthority)).append("\n" + "  Calendar     sync. interval: ").append(syncStatus(settings, CalendarContract.AUTHORITY)).append("\n" + "  OpenTasks    sync. interval: ").append(syncStatus(settings, ProviderName.OpenTasks.authority)).append("\n" + "  Tasks.org    sync. interval: ").append(syncStatus(settings, ProviderName.TasksOrg.authority)).append("\n" + "  WiFi only: ").append(settings.syncWifiOnly)
                    if (settings.syncWifiOnlySSID != null)
                        report.append(", SSID configured: yes")
                    report.append("\n  [CardDAV] Contact group method: ").append(settings.groupMethod)
                            .append("\n           Manage calendar colors: ").append(settings.manageCalendarColors)
                            .append("\n")
                } catch (e: InvalidAccountException) {
                    report.append("Account #").append(idx + 1).append(" is invalid (unsupported settings version) or does not exist\n")
                }

            // address book accounts
            for ((idx, acct) in accountManager.getAccountsByType(App.addressBookAccountType).withIndex())
                try {
                    val addressBook = LocalAddressBook(context, acct, null)
                    report.append("Address book account #").append(idx + 1).append("\n" + "  Main account: [redacted]\n" + "  URL configured: ").append(addressBook.url != null).append("\n" + "  Sync automatically: ").append(ContentResolver.getSyncAutomatically(acct, ContactsContract.AUTHORITY)).append("\n")
                } catch (e: ContactsStorageException) {
                    report.append("Address book account #").append(idx + 1).append(" is invalid\n")
                }

            report.append("\n")

            // Settings DB dump removed — settings migrated to SharedPreferences
            report.append("\n")

            // Legacy Requery database dump removed

            report.append("SYSTEM INFORMATION\n" + "Android version: ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append(")\n\n")

            report.append("--- END DEBUG INFO ---\n")
            return report.toString()
        }

        private fun syncStatus(settings: AccountSettings, authority: String): String {
            val interval = settings.getSyncInterval(authority)
            return if (interval != null)
                if (interval == AccountSettings.SYNC_INTERVAL_MANUALLY) "manually" else (interval / 60).toString() + " min"
            else
                "—"
        }
    }

    companion object {
        val KEY_THROWABLE = "throwable"
        val KEY_LOGS = "logs"
        val KEY_PHASE = "phase"

        val KEY_SCHEDULING_ONLY = "schedulingOnly"

        fun newSchedulingIntent(context: Context?): Intent =
                Intent(context, DebugInfoActivity::class.java).putExtra(KEY_SCHEDULING_ONLY, true)

        fun newIntent(context: Context?): Intent = Intent(context, DebugInfoActivity::class.java)
    }

}

/**
 * Exception class names only, outermost first, joined by "Caused by:". Messages and stack frames
 * stay out of the shareable report. The visited set stops on a cause cycle.
 */
internal fun exceptionClassChain(throwable: Throwable): String {
    val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
    val names = mutableListOf<String>()
    var current: Throwable? = throwable
    while (current != null && seen.add(current)) {
        names += current.javaClass.name
        current = current.cause
    }
    return names.joinToString("\nCaused by: ")
}
