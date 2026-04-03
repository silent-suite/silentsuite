/*
 * Copyright © 2013 – 2016 Ricki Hirner (bitfire web engineering).
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the GNU Public License v3.0
 * which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/gpl.html
 */

package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.provider.CalendarContract
import android.text.TextUtils
import androidx.preference.*
import at.bitfire.cert4android.CustomCertManager
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import io.silentsuite.sync.*
import io.silentsuite.sync.R
import io.silentsuite.sync.utils.HintManager
import io.silentsuite.sync.utils.LanguageUtils
import androidx.appcompat.app.AppCompatDelegate
import com.google.android.material.snackbar.Snackbar
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import io.silentsuite.sync.utils.defaultSharedPreferences
import java.net.URI
import java.net.URISyntaxException

class AppSettingsActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                    .replace(android.R.id.content, SettingsFragment())
                    .commit()
        }
    }


    class SettingsFragment : PreferenceFragmentCompat() {
        internal lateinit var settings: SharedPreferences

        internal lateinit var prefPreferTasksOrg: SwitchPreferenceCompat

        internal lateinit var prefResetHints: Preference
        internal lateinit var prefOverrideProxy: SwitchPreferenceCompat
        internal lateinit var prefDistrustSystemCerts: SwitchPreferenceCompat

        internal lateinit var prefProxyHost: EditTextPreference
        internal lateinit var prefProxyPort: EditTextPreference

        private var account: Account? = null
        private var accountSettings: AccountSettings? = null

        override fun onCreate(savedInstanceState: Bundle?) {
            settings = requireContext().getSharedPreferences("app_settings", android.content.Context.MODE_PRIVATE)

            // Find the SilentSuite account (single-account model)
            val accountManager = AccountManager.get(requireContext())
            val accounts = accountManager.getAccountsByType(App.accountType)
            if (accounts.isNotEmpty()) {
                account = accounts[0]
                try {
                    accountSettings = AccountSettings(requireContext(), account!!)
                } catch (e: InvalidAccountException) {
                    // Account invalid, sync settings won't be available
                }
            }

            super.onCreate(savedInstanceState)
        }

        override fun onCreatePreferences(bundle: Bundle?, s: String?) {
            addPreferencesFromResource(R.xml.settings_app)

            // --- Sync settings (from account) ---
            setupSyncSettings()

            // --- Encryption / Change password ---
            val prefEncryptionPassword = findPreference("password")
            if (account != null) {
                prefEncryptionPassword.onPreferenceClickListener = Preference.OnPreferenceClickListener { _ ->
                    startActivity(ChangeEncryptionPasswordActivity.newIntent(requireActivity(), account!!))
                    true
                }
            } else {
                prefEncryptionPassword.isEnabled = false
                prefEncryptionPassword.summary = getString(R.string.settings_sync_summary_not_available)
            }

            // --- Theme ---
            val prefTheme = findPreference("theme_mode") as ListPreference
            val currentMode = settings.getInt("theme_mode", AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)
            prefTheme.value = currentMode.toString()
            prefTheme.summary = when (currentMode) {
                AppCompatDelegate.MODE_NIGHT_NO -> "Light"
                AppCompatDelegate.MODE_NIGHT_YES -> "Dark"
                else -> "System default"
            }
            prefTheme.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                val mode = (newValue as String).toInt()
                settings.edit().putInt("theme_mode", mode).apply()
                prefTheme.summary = when (mode) {
                    AppCompatDelegate.MODE_NIGHT_NO -> "Light"
                    AppCompatDelegate.MODE_NIGHT_YES -> "Dark"
                    else -> "System default"
                }
                AppCompatDelegate.setDefaultNightMode(mode)
                true
            }

            // --- UI settings ---
            findPreference("notification_settings").apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    onPreferenceClickListener = Preference.OnPreferenceClickListener {
                        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                            putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                        })
                        false
                    }
                else
                    isVisible = false
            }

            prefResetHints = findPreference("reset_hints")

            val prefChangeNotification = findPreference("show_change_notification") as SwitchPreferenceCompat
            prefChangeNotification.isChecked = requireContext().defaultSharedPreferences.getBoolean(App.CHANGE_NOTIFICATION, true)

            // --- Sync: Prefer Tasks.org ---
            prefPreferTasksOrg = findPreference("prefer_tasksorg") as SwitchPreferenceCompat
            prefPreferTasksOrg.isChecked = requireContext().defaultSharedPreferences.getBoolean(App.PREFER_TASKSORG, false)
            prefPreferTasksOrg.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                requireContext().defaultSharedPreferences.edit().putBoolean(App.PREFER_TASKSORG, newValue as Boolean).apply()
                Snackbar.make(requireView(), getString(R.string.app_settings_prefer_tasksorg_snack), Snackbar.LENGTH_LONG).show()
                true
            }

            // --- Connection: Proxy ---
            prefOverrideProxy = findPreference("override_proxy") as SwitchPreferenceCompat
            prefOverrideProxy.isChecked = settings.getBoolean(App.OVERRIDE_PROXY, false)
            prefOverrideProxy.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                settings.edit().putBoolean(App.OVERRIDE_PROXY, newValue as Boolean).apply()
                true
            }

            prefProxyHost = findPreference("proxy_host") as EditTextPreference
            val proxyHost = settings.getString(App.OVERRIDE_PROXY_HOST, App.OVERRIDE_PROXY_HOST_DEFAULT)
            prefProxyHost.text = proxyHost
            prefProxyHost.summary = proxyHost
            prefProxyHost.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                val host = newValue as String
                try {
                    URI(null, host, null, null)
                } catch (e: URISyntaxException) {
                    Snackbar.make(requireView(), e.localizedMessage, Snackbar.LENGTH_LONG).show()
                    return@OnPreferenceChangeListener false
                }

                settings.edit().putString(App.OVERRIDE_PROXY_HOST, host).apply()
                prefProxyHost.summary = host
                true
            }

            prefProxyPort = findPreference("proxy_port") as EditTextPreference
            val proxyPort = settings.getString(App.OVERRIDE_PROXY_PORT, App.OVERRIDE_PROXY_PORT_DEFAULT.toString()) ?: App.OVERRIDE_PROXY_PORT_DEFAULT.toString()
            prefProxyPort.text = proxyPort
            prefProxyPort.summary = proxyPort
            prefProxyPort.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                var port: Int
                try {
                    port = Integer.parseInt(newValue as String)
                } catch (e: NumberFormatException) {
                    port = App.OVERRIDE_PROXY_PORT_DEFAULT
                }

                settings.edit().putInt(App.OVERRIDE_PROXY_PORT, port).apply()
                prefProxyPort.text = port.toString()
                prefProxyPort.summary = port.toString()
                true
            }

            // --- Security ---
            prefDistrustSystemCerts = findPreference("distrust_system_certs") as SwitchPreferenceCompat
            prefDistrustSystemCerts.isChecked = settings.getBoolean(App.DISTRUST_SYSTEM_CERTIFICATES, false)

            findPreference("reset_certificates").apply {
                isVisible = BuildConfig.customCerts
                isEnabled = true
                onPreferenceClickListener = Preference.OnPreferenceClickListener {
                    resetCertificates()
                    false
                }
            }

            // --- Debug ---
            initSelectLanguageList()
        }

        private fun setupSyncSettings() {
            val acctSettings = accountSettings

            // Sync interval
            val prefSync = findPreference("sync_interval") as ListPreference
            if (acctSettings != null) {
                val syncInterval = acctSettings.getSyncInterval(CalendarContract.AUTHORITY)
                if (syncInterval != null) {
                    prefSync.value = syncInterval.toString()
                    if (syncInterval == AccountSettings.SYNC_INTERVAL_MANUALLY)
                        prefSync.setSummary(R.string.settings_sync_summary_manually)
                    else
                        prefSync.summary = getString(R.string.settings_sync_summary_periodically, prefSync.entry)
                    prefSync.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                        val newInterval = java.lang.Long.parseLong(newValue as String)
                        acctSettings.setSyncInterval(App.addressBooksAuthority, newInterval)
                        acctSettings.setSyncInterval(CalendarContract.AUTHORITY, newInterval)
                        TASK_PROVIDERS.forEach {
                            acctSettings.setSyncInterval(it.authority, newInterval)
                        }
                        // Update the summary
                        if (newInterval == AccountSettings.SYNC_INTERVAL_MANUALLY)
                            prefSync.setSummary(R.string.settings_sync_summary_manually)
                        else
                            prefSync.summary = getString(R.string.settings_sync_summary_periodically, prefSync.entry)
                        true
                    }
                } else {
                    prefSync.isEnabled = false
                    prefSync.setSummary(R.string.settings_sync_summary_not_available)
                }
            } else {
                prefSync.isEnabled = false
                prefSync.setSummary(R.string.settings_sync_summary_not_available)
            }

            // WiFi only
            val prefWifiOnly = findPreference("sync_wifi_only") as SwitchPreferenceCompat
            if (acctSettings != null) {
                prefWifiOnly.isChecked = acctSettings.syncWifiOnly
                prefWifiOnly.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, wifiOnly ->
                    acctSettings.setSyncWiFiOnly(wifiOnly as Boolean)
                    true
                }
            } else {
                prefWifiOnly.isEnabled = false
            }

            // WiFi SSID
            val prefWifiOnlySSID = findPreference("sync_wifi_only_ssid") as EditTextPreference
            if (acctSettings != null) {
                val onlySSID = acctSettings.syncWifiOnlySSID
                prefWifiOnlySSID.text = onlySSID
                if (onlySSID != null)
                    prefWifiOnlySSID.summary = getString(R.string.settings_sync_wifi_only_ssid_on, onlySSID)
                else
                    prefWifiOnlySSID.setSummary(R.string.settings_sync_wifi_only_ssid_off)
                prefWifiOnlySSID.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                    val ssid = newValue as String
                    acctSettings.syncWifiOnlySSID = if (!TextUtils.isEmpty(ssid)) ssid else null
                    if (!TextUtils.isEmpty(ssid))
                        prefWifiOnlySSID.summary = getString(R.string.settings_sync_wifi_only_ssid_on, ssid)
                    else
                        prefWifiOnlySSID.setSummary(R.string.settings_sync_wifi_only_ssid_off)
                    true
                }
            } else {
                prefWifiOnlySSID.isEnabled = false
            }
        }

        private fun initSelectLanguageList() {
            val listPreference = findPreference("select_language") as ListPreference
            lifecycleScope.launch {
                val locales = withContext(Dispatchers.IO) {
                    LanguageUtils.getAppLanguages(requireContext())
                }
                listPreference.entries = locales.displayNames
                listPreference.entryValues = locales.localeData

                listPreference.value = settings.getString(App.FORCE_LANGUAGE,
                        App.DEFAULT_LANGUAGE)
                listPreference.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { preference, newValue ->
                    val value = newValue.toString()
                    if (value == (preference as ListPreference).value) return@OnPreferenceChangeListener true

                    LanguageUtils.setLanguage(requireContext(), value)

                    settings.edit().putString(App.FORCE_LANGUAGE, newValue.toString()).apply()

                    val intent = Intent(context, AccountsActivity::class.java)
                    intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    false
                }
            }
        }

        override fun onPreferenceTreeClick(preference: Preference): Boolean {
            if (preference === prefResetHints)
                resetHints()
            else if (preference === prefDistrustSystemCerts)
                setDistrustSystemCerts(preference.isChecked)
            else
                return false
            return true
        }

        private fun resetHints() {
            HintManager.resetHints(requireContext())
            Snackbar.make(requireView(), R.string.app_settings_reset_hints_success, Snackbar.LENGTH_LONG).show()
        }

        private fun setDistrustSystemCerts(distrust: Boolean) {
            settings.edit().putBoolean(App.DISTRUST_SYSTEM_CERTIFICATES, distrust).apply()
        }

        private fun resetCertificates() {
            if (CustomCertManager.resetCertificates(requireActivity()))
                Snackbar.make(requireView(), getString(R.string.app_settings_reset_certificates_success), Snackbar.LENGTH_LONG).show()
        }

    }
}
