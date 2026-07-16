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
import android.content.Context
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

    companion object {
        const val EXTRA_ACCOUNT = "account"
        const val EXTRA_CREATION_ID = "account_creation_id"

        fun newIntent(context: Context, account: Account?, creationId: String? = null): Intent =
            Intent(context, AppSettingsActivity::class.java).apply {
                account?.let {
                    require(!creationId.isNullOrBlank()) { "Account settings routes require a creation ID" }
                    putExtra(EXTRA_ACCOUNT, it)
                    putExtra(EXTRA_CREATION_ID, creationId)
                }
            }
    }

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
        private var accountCreationId: String? = null
        private var accountSettings: AccountSettings? = null

        /** Re-check retained identity at each account-settings write boundary. */
        private fun mutateExactAccount(mutation: () -> Unit): Boolean {
            val retainedAccount = account
            val retainedCreationId = accountCreationId
            if (retainedAccount == null || retainedCreationId.isNullOrBlank() ||
                io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
                    retainedAccount, retainedCreationId, App.accountType, AccountManager.get(requireContext())
                ) == null) {
                requireActivity().finish()
                return false
            }
            mutation()
            return true
        }

        private inline fun <reified T : Preference> requirePreference(key: String): T =
            findPreference<T>(key)
                ?: throw IllegalStateException("Required preference '$key' is missing from settings_app")

        override fun onCreate(savedInstanceState: Bundle?) {
            settings = requireContext().getSharedPreferences("app_settings", android.content.Context.MODE_PRIVATE)

            // Prefer the caller's exact account. Global settings entry points have no account
            // context and intentionally fall back to the active account.
            val accountManager = AccountManager.get(requireContext())
            val requestedAccount = requireActivity().intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
            val requestedCreationId = requireActivity().intent.getStringExtra(EXTRA_CREATION_ID)
            account = if (requestedAccount != null) {
                requestedAccount.takeIf { requested ->
                    requestedCreationId != null && io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
                        requested, requestedCreationId, App.accountType, accountManager
                    ) != null
                }
            } else {
                ActiveAccountManager.getActiveAccount(requireContext())
            }
            accountCreationId = if (requestedAccount != null) requestedCreationId else account?.let {
                accountManager.getUserData(it, AccountSettings.KEY_CREATION_ID)?.takeIf(String::isNotBlank)
            }
            if (account != null) {
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
            val prefEncryptionPassword = requirePreference<Preference>("password")
            if (account != null && !accountCreationId.isNullOrBlank()) {
                prefEncryptionPassword.onPreferenceClickListener = Preference.OnPreferenceClickListener { _ ->
                    val manager = AccountManager.get(requireContext())
                    val creationId = requireNotNull(accountCreationId)
                    if (io.silentsuite.sync.ui.setup.ExactAccountRouting.validate(
                            account, creationId, App.accountType, manager) == null) {
                        requireActivity().finish()
                    } else {
                        startActivity(ChangeEncryptionPasswordActivity.newIntent(requireActivity(), account!!, creationId))
                    }
                    true
                }
            } else {
                prefEncryptionPassword.isEnabled = false
                prefEncryptionPassword.summary = getString(R.string.settings_sync_summary_not_available)
            }

            // --- Theme ---
            val prefTheme = requirePreference<ListPreference>("theme_mode")
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
            requirePreference<Preference>("notification_settings").apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    onPreferenceClickListener = Preference.OnPreferenceClickListener {
                        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                            putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, requireContext().packageName)
                        })
                        false
                    }
                else
                    isVisible = false
            }

            prefResetHints = requirePreference<Preference>("reset_hints")

            val prefChangeNotification = requirePreference<SwitchPreferenceCompat>("show_change_notification")
            prefChangeNotification.isChecked = requireContext().defaultSharedPreferences.getBoolean(App.CHANGE_NOTIFICATION, true)

            // --- Sync: Prefer Tasks.org ---
            prefPreferTasksOrg = requirePreference<SwitchPreferenceCompat>("prefer_tasksorg")
            prefPreferTasksOrg.isChecked = requireContext().defaultSharedPreferences.getBoolean(App.PREFER_TASKSORG, false)
            prefPreferTasksOrg.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                requireContext().defaultSharedPreferences.edit().putBoolean(App.PREFER_TASKSORG, newValue as Boolean).apply()
                Snackbar.make(requireView(), getString(R.string.app_settings_prefer_tasksorg_snack), Snackbar.LENGTH_LONG).show()
                true
            }

            // --- Connection: Proxy ---
            prefOverrideProxy = requirePreference<SwitchPreferenceCompat>("override_proxy")
            prefOverrideProxy.isChecked = settings.getBoolean(App.OVERRIDE_PROXY, false)
            prefOverrideProxy.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                settings.edit().putBoolean(App.OVERRIDE_PROXY, newValue as Boolean).apply()
                true
            }

            prefProxyHost = requirePreference<EditTextPreference>("proxy_host")
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

            prefProxyPort = requirePreference<EditTextPreference>("proxy_port")
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
            prefDistrustSystemCerts = requirePreference<SwitchPreferenceCompat>("distrust_system_certs")
            prefDistrustSystemCerts.isChecked = settings.getBoolean(App.DISTRUST_SYSTEM_CERTIFICATES, false)

            requirePreference<Preference>("reset_certificates").apply {
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
            val prefSync = requirePreference<ListPreference>("sync_interval")
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
                        if (!mutateExactAccount { acctSettings.setSyncInterval(App.addressBooksAuthority, newInterval) })
                            return@OnPreferenceChangeListener false
                        if (!mutateExactAccount { acctSettings.setSyncInterval(CalendarContract.AUTHORITY, newInterval) })
                            return@OnPreferenceChangeListener false
                        TASK_PROVIDERS.forEach {
                            if (!mutateExactAccount { acctSettings.setSyncInterval(it.authority, newInterval) })
                                return@OnPreferenceChangeListener false
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
            val prefWifiOnly = requirePreference<SwitchPreferenceCompat>("sync_wifi_only")
            if (acctSettings != null) {
                prefWifiOnly.isChecked = acctSettings.syncWifiOnly
                prefWifiOnly.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, wifiOnly ->
                    mutateExactAccount { acctSettings.setSyncWiFiOnly(wifiOnly as Boolean) }
                }
            } else {
                prefWifiOnly.isEnabled = false
            }

            // WiFi SSID
            val prefWifiOnlySSID = requirePreference<EditTextPreference>("sync_wifi_only_ssid")
            if (acctSettings != null) {
                val onlySSID = acctSettings.syncWifiOnlySSID
                prefWifiOnlySSID.text = onlySSID
                if (onlySSID != null)
                    prefWifiOnlySSID.summary = getString(R.string.settings_sync_wifi_only_ssid_on, onlySSID)
                else
                    prefWifiOnlySSID.setSummary(R.string.settings_sync_wifi_only_ssid_off)
                prefWifiOnlySSID.onPreferenceChangeListener = Preference.OnPreferenceChangeListener { _, newValue ->
                    val ssid = newValue as String
                    if (!mutateExactAccount {
                            acctSettings.syncWifiOnlySSID = if (!TextUtils.isEmpty(ssid)) ssid else null
                        }) return@OnPreferenceChangeListener false
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
            val listPreference = requirePreference<ListPreference>("select_language")
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

                    val intent = Intent(requireContext(), AccountsActivity::class.java)
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
