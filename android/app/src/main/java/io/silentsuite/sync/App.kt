/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync

import android.accounts.AccountManager
import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Application
import android.content.*
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Build
import android.os.StrictMode
import android.provider.CalendarContract
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import at.bitfire.ical4android.AndroidCalendar
import at.bitfire.ical4android.CalendarStorageException
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import at.bitfire.vcard4android.ContactsStorageException
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.resource.LocalCalendar
import io.silentsuite.sync.ui.AccountsActivity
import io.silentsuite.sync.utils.HintManager
import io.silentsuite.sync.utils.LanguageUtils
import io.silentsuite.sync.utils.NotificationUtils
import io.silentsuite.sync.utils.TaskProviderHandling
// TODO(Phase2): Add Sentry crash reporting to replace removed ACRA
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.*


class App : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @SuppressLint("HardwareIds")
    override fun onCreate() {
        super.onCreate()
        reinitLogger()
        StrictMode.enableDefaults()
        initPrefVersion()

        NotificationUtils.createChannels(this)

        appName = getString(R.string.app_name)
        accountType = getString(R.string.account_type)
        addressBookAccountType = getString(R.string.account_type_address_book)
        addressBooksAuthority = getString(R.string.address_books_authority)

        loadLanguage()

        // don't block UI for some background checks
        applicationScope.launch(Dispatchers.IO) {
            // watch installed/removed apps
            val tasksFilter = IntentFilter()
            tasksFilter.addAction(Intent.ACTION_PACKAGE_ADDED)
            tasksFilter.addAction(Intent.ACTION_PACKAGE_FULLY_REMOVED)
            tasksFilter.addDataScheme("package")
            registerReceiver(PackageChangedReceiver(), tasksFilter)

            TASK_PROVIDERS.forEach {
                // check whether a tasks app is currently installed
                TaskProviderHandling.updateTaskSync(this@App, it)
            }
        }
    }

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // TODO(Phase2): Initialize Sentry crash reporting here
    }

    private fun loadLanguage() {
        val prefs = getSharedPreferences("app_settings", Context.MODE_PRIVATE)
        val lang = prefs.getString(App.FORCE_LANGUAGE, null)
        if (lang != null && lang != DEFAULT_LANGUAGE) {
            LanguageUtils.setLanguage(this, lang)
        }
    }

    fun reinitLogger() {
        Logger.initialize(this)
    }

    /** Init the preferences version of the app.
     * This is used to initialise the first version if not already set.  */
    private fun initPrefVersion() {
        val prefs = getSharedPreferences("app", Context.MODE_PRIVATE)
        if (prefs.getInt(PREF_VERSION, 0) == 0) {
            prefs.edit().putInt(PREF_VERSION, BuildConfig.VERSION_CODE).apply()
        }
    }

    private fun update(fromVersion: Int) {
        Logger.log.info("Updating from version " + fromVersion + " to " + BuildConfig.VERSION_CODE)

        if (fromVersion < 7) {
            /* Fix all of the etags to be non-null */
            val am = AccountManager.get(this)
            for (account in am.getAccountsByType(App.accountType)) {
                try {
                    // Generate account settings to make sure account is migrated.
                    AccountSettings(this, account)

                    val calendarProvider = this.contentResolver.acquireContentProviderClient(CalendarContract.CONTENT_URI)
                            ?: continue
                    try {
                        val calendars = AndroidCalendar.find(account, calendarProvider,
                                LocalCalendar.Factory, null, null)
                        for (calendar in calendars) {
                            calendar.fixEtags()
                        }
                    } finally {
                        calendarProvider.release()
                    }
                } catch (e: CalendarStorageException) {
                    e.printStackTrace()
                } catch (e: InvalidAccountException) {
                    e.printStackTrace()
                }

            }

            for (account in am.getAccountsByType(App.addressBookAccountType)) {
                val contactsProvider = this.contentResolver.acquireContentProviderClient(ContactsContract.Contacts.CONTENT_URI)
                        ?: continue
                try {
                    val addressBook = LocalAddressBook(this, account, contactsProvider)
                    addressBook.fixEtags()
                } catch (e: ContactsStorageException) {
                    e.printStackTrace()
                } finally {
                    contactsProvider.release()
                }

            }
        }

        if (fromVersion < 10) {
            HintManager.setHintSeen(this, AccountsActivity.HINT_ACCOUNT_ADD, true)
        }
    }

    class AppUpdatedReceiver : BroadcastReceiver() {

        @SuppressLint("UnsafeProtectedBroadcastReceiver,MissingPermission")
        override fun onReceive(context: Context, intent: Intent) {
            Logger.log.info("SilentSuite was updated, checking for app version")

            val app = context.applicationContext as App
            val prefs = app.getSharedPreferences("app", Context.MODE_PRIVATE)
            val fromVersion = prefs.getInt(PREF_VERSION, 1)
            app.update(fromVersion)
            prefs.edit().putInt(PREF_VERSION, BuildConfig.VERSION_CODE).apply()
        }

    }

    companion object {
        val DISTRUST_SYSTEM_CERTIFICATES = "distrustSystemCerts"
        val LOG_TO_EXTERNAL_STORAGE = "logToExternalStorage"
        val OVERRIDE_PROXY = "overrideProxy"
        val OVERRIDE_PROXY_HOST = "overrideProxyHost"
        val OVERRIDE_PROXY_PORT = "overrideProxyPort"
        val PREFER_TASKSORG = "preferTasksOrg"
        val FORCE_LANGUAGE = "forceLanguage"
        val CHANGE_NOTIFICATION = "show_change_notification"

        val OVERRIDE_PROXY_HOST_DEFAULT = "localhost"
        val OVERRIDE_PROXY_PORT_DEFAULT = 8118

        val DEFAULT_LANGUAGE = "default"
        var sDefaultLocacle = Locale.getDefault()

        var appName: String = "SilentSuite"

        lateinit var accountType: String
            private set
        lateinit var addressBookAccountType: String
            private set
        lateinit var addressBooksAuthority: String
            private set

        @TargetApi(Build.VERSION_CODES.LOLLIPOP)
        fun getLauncherBitmap(context: Context): Bitmap? {
            var bitmapLogo: Bitmap? = null
            val drawableLogo = ContextCompat.getDrawable(context, R.mipmap.ic_launcher)

            if (drawableLogo is BitmapDrawable)
                bitmapLogo = drawableLogo.bitmap
            return bitmapLogo
        }

        // update from previous account settings

        private val PREF_VERSION = "version"
    }
}
