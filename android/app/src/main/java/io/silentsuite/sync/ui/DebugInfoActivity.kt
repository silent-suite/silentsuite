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
import android.app.LoaderManager
import android.content.*
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.text.TextUtils
import android.view.Menu
import android.view.MenuItem
import android.widget.TextView
import androidx.core.content.ContextCompat
import at.bitfire.ical4android.TaskProvider.ProviderName
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.*
import io.silentsuite.sync.Constants.KEY_ACCOUNT
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalAddressBook
// TODO(Phase2): Replace ACRA with Sentry for crash reporting
import org.apache.commons.lang3.exception.ExceptionUtils
import org.apache.commons.lang3.text.WordUtils
import java.io.File
import java.util.logging.Level

class DebugInfoActivity : BaseActivity(), LoaderManager.LoaderCallbacks<String> {

    internal lateinit var tvReport: TextView
    internal lateinit var report: String

    internal var reportFile: File? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContentView(R.layout.activity_debug_info)
        tvReport = findViewById(R.id.text_report)

        loaderManager.initLoader(0, intent.extras, this)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.activity_debug_info, menu)
        return true
    }


    fun onShare(item: MenuItem) {
        // TODO(Phase2): Replace with Sentry crash reporting
        // For now, share debug info via intent
        val sendIntent = Intent().apply {
            action = Intent.ACTION_SEND
            putExtra(Intent.EXTRA_TEXT, report)
            type = "text/plain"
        }
        startActivity(Intent.createChooser(sendIntent, "Share debug info"))
    }

    override fun onCreateLoader(id: Int, args: Bundle?): Loader<String> {
        return ReportLoader(this, args)
    }

    override fun onLoadFinished(loader: Loader<String>, data: String?) {
        if (data != null) {
            report = data
            tvReport.setText(report)
        }
    }

    override fun onLoaderReset(loader: Loader<String>) {}


    internal class ReportLoader(context: Context, val extras: Bundle?) : AsyncTaskLoader<String>(context) {

        override fun onStartLoading() {
            forceLoad()
        }

        @SuppressLint("MissingPermission")
        override fun loadInBackground(): String {
            var throwable: Throwable? = null
            var caller: String? = null
            var logs: String? = null
            var authority: String? = null
            var account: Account? = null
            var phase: String? = null

            if (extras != null) {
                throwable = extras.getSerializable(KEY_THROWABLE) as Throwable?
                caller = extras.getString(KEY_CALLER)
                logs = extras.getString(KEY_LOGS)
                account = extras.getParcelable(KEY_ACCOUNT)
                authority = extras.getString(KEY_AUTHORITY)
                phase = if (extras.containsKey(KEY_PHASE)) context.getString(extras.getInt(KEY_PHASE)) else null
            }

            val report = StringBuilder("--- BEGIN DEBUG INFO ---\n")

            // begin with most specific information

            if (phase != null)
                report.append("SYNCHRONIZATION INFO\nSynchronization phase: ").append(phase).append("\n")
            if (account != null)
                report.append("Account name: ").append(account.name).append("\n")
            if (authority != null)
                report.append("Authority: ").append(authority).append("\n")
            if (caller != null)
                report.append("Debug activity source: ").append(caller).append("\n")

            if (throwable is com.etebase.client.exceptions.HttpException) {
                report.append("\nHTTP ERROR:\n").append(throwable.localizedMessage).append("\n")
            }

            if (throwable != null)
                report.append("\nEXCEPTION:\n")
                        .append(ExceptionUtils.getStackTrace(throwable))

            if (logs != null)
                report.append("\nLOGS:\n").append(logs).append("\n")

            val context = context

            try {
                val pm = context.packageManager
                var installedFrom = pm.getInstallerPackageName(BuildConfig.APPLICATION_ID)
                if (TextUtils.isEmpty(installedFrom))
                    installedFrom = "APK (directly)"
                report.append("\nSOFTWARE INFORMATION\n" + "SilentSuite version: ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.VERSION_CODE).append(") ").append("\n")
                        .append("Installed from: ").append(installedFrom).append("\n")
            } catch (ex: Exception) {
                Logger.log.log(Level.SEVERE, "Couldn't get software information", ex)
            }

            report.append("CONFIGURATION\n")
            // power saving
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
            if (powerManager != null && Build.VERSION.SDK_INT >= 23)
                report.append("Power saving disabled: ")
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
            for (acct in accountManager.getAccountsByType(context.getString(R.string.account_type)))
                try {
                    val settings = AccountSettings(context, acct)
                    report.append("Account: ").append(acct.name).append("\n" + "  Address book sync. interval: ").append(syncStatus(settings, App.addressBooksAuthority)).append("\n" + "  Calendar     sync. interval: ").append(syncStatus(settings, CalendarContract.AUTHORITY)).append("\n" + "  OpenTasks    sync. interval: ").append(syncStatus(settings, ProviderName.OpenTasks.authority)).append("\n" + "  Tasks.org    sync. interval: ").append(syncStatus(settings, ProviderName.TasksOrg.authority)).append("\n" + "  WiFi only: ").append(settings.syncWifiOnly)
                    if (settings.syncWifiOnlySSID != null)
                        report.append(", SSID: ").append(settings.syncWifiOnlySSID)
                    report.append("\n  [CardDAV] Contact group method: ").append(settings.groupMethod)
                            .append("\n           Manage calendar colors: ").append(settings.manageCalendarColors)
                            .append("\n")
                } catch (e: InvalidAccountException) {
                    report.append(acct).append(" is invalid (unsupported settings version) or does not exist\n")
                }

            // address book accounts
            for (acct in accountManager.getAccountsByType(App.addressBookAccountType))
                try {
                    val addressBook = LocalAddressBook(context, acct, null)
                    report.append("Address book account: ").append(acct.name).append("\n" + "  Main account: ").append(addressBook.mainAccount).append("\n" + "  URL: ").append(addressBook.url).append("\n" + "  Sync automatically: ").append(ContentResolver.getSyncAutomatically(acct, ContactsContract.AUTHORITY)).append("\n")
                } catch (e: ContactsStorageException) {
                    report.append(acct).append(" is invalid: ").append(e.message).append("\n")
                }

            report.append("\n")

            // Settings DB dump removed — settings migrated to SharedPreferences
            report.append("\n")

            // Legacy Requery database dump removed

            try {
                report.append(
                        "SYSTEM INFORMATION\n" + "Android version: ").append(Build.VERSION.RELEASE).append(" (").append(Build.DISPLAY).append(")\n" + "Device: ").append(WordUtils.capitalize(Build.MANUFACTURER)).append(" ").append(Build.MODEL).append(" (").append(Build.DEVICE).append(")\n\n"
                )
            } catch (ex: Exception) {
                Logger.log.log(Level.SEVERE, "Couldn't get system details", ex)
            }

            report.append("--- END DEBUG INFO ---\n")
            return report.toString()
        }

        protected fun syncStatus(settings: AccountSettings, authority: String): String {
            val interval = settings.getSyncInterval(authority)
            return if (interval != null)
                if (interval == AccountSettings.SYNC_INTERVAL_MANUALLY) "manually" else (interval / 60).toString() + " min"
            else
                "—"
        }
    }

    companion object {
        val KEY_CALLER = "caller"
        val KEY_THROWABLE = "throwable"
        val KEY_LOGS = "logs"
        val KEY_AUTHORITY = "authority"
        val KEY_PHASE = "phase"

        fun newIntent(context: Context?, caller: String): Intent {
            val intent = Intent(context, DebugInfoActivity::class.java)
            intent.putExtra(KEY_CALLER, caller)
            return intent
        }
    }

}
