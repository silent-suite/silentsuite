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
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.CalendarContract
import android.text.TextUtils
import androidx.appcompat.app.AppCompatDelegate
import androidx.lifecycle.lifecycleScope
import androidx.preference.EditTextPreference
import androidx.preference.ListPreference
import androidx.preference.Preference
import androidx.preference.PreferenceFragmentCompat
import androidx.preference.SwitchPreferenceCompat
import at.bitfire.cert4android.CustomCertManager
import at.bitfire.ical4android.TaskProvider.Companion.TASK_PROVIDERS
import com.google.android.material.snackbar.Snackbar
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.BuildConfig
import io.silentsuite.sync.InvalidAccountException
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.settings.AppPreferences
import io.silentsuite.sync.ui.settings.SettingsCategory
import io.silentsuite.sync.ui.setup.ExactAccountRouting
import io.silentsuite.sync.utils.HintManager
import io.silentsuite.sync.utils.LanguageUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import io.silentsuite.sync.ui.settings.ProxySettingsValidation

class AppSettingsActivity : BaseActivity() {
    var selectedAccount: Account? = null
        private set
    var selectedCreationId: String? = null
        private set
    var currentCategory: SettingsCategory = SettingsCategory.HOME
        private set
    private var hasExplicitAccountRoute: Boolean = false

    companion object {
        const val EXTRA_ACCOUNT = "account"
        const val EXTRA_CREATION_ID = "settings_account_creation_id"
        const val EXTRA_CATEGORY = "settings_category"
        private const val STATE_ACCOUNT = "state_account"
        private const val STATE_CREATION_ID = "state_creation_id"
        private const val STATE_EXPLICIT_ACCOUNT = "state_explicit_account"
        private const val STATE_CATEGORY = "state_category"

        fun newIntent(
            context: Context,
            account: Account?,
            category: SettingsCategory = SettingsCategory.HOME
        ): Intent = if (account == null)
            Intent(context, AppSettingsActivity::class.java).putExtra(EXTRA_CATEGORY, category.route)
        else newIntent(
            context, account,
            AccountManager.get(context).getUserData(account, AccountSettings.KEY_CREATION_ID),
            category)

        internal fun newIntent(
            context: Context,
            account: Account?,
            creationId: String?,
            category: SettingsCategory = SettingsCategory.HOME
        ): Intent = Intent(context, AppSettingsActivity::class.java).apply {
            account?.let { putExtra(EXTRA_ACCOUNT, it) }
            // Presence records an explicit route even when a malformed legacy caller supplied
            // a null account or generation; AppSettingsActivity must not fall back in that case.
            putExtra(EXTRA_CREATION_ID, creationId)
            putExtra(EXTRA_CATEGORY, category.route)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppPreferences(this) // complete migration before any screen or process consumer reads values
        val accountRoute = resolveAccount(savedInstanceState)
        selectedAccount = accountRoute.account
        selectedCreationId = accountRoute.creationId
        hasExplicitAccountRoute = accountRoute.explicit
        currentCategory = savedInstanceState?.getString(STATE_CATEGORY)?.let(SettingsCategory::fromRoute)
            ?: SettingsCategory.fromRoute(intent.getStringExtra(EXTRA_CATEGORY))

        supportFragmentManager.addOnBackStackChangedListener {
            val fragment = supportFragmentManager.findFragmentById(android.R.id.content)
            currentCategory = when (fragment) {
                is CategoryFragment -> fragment.category
                else -> SettingsCategory.HOME
            }
            updateTitle()
        }
        if (savedInstanceState == null)
            showCategory(currentCategory, addToBackStack = false)
        else
            updateTitle()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putParcelable(STATE_ACCOUNT, selectedAccount)
        outState.putString(STATE_CREATION_ID, selectedCreationId)
        outState.putBoolean(STATE_EXPLICIT_ACCOUNT, hasExplicitAccountRoute)
        outState.putString(STATE_CATEGORY, currentCategory.route)
        super.onSaveInstanceState(outState)
    }

    private data class AccountRoute(val account: Account?, val creationId: String?, val explicit: Boolean)

    private fun resolveAccount(savedInstanceState: Bundle?): AccountRoute {
        val manager = AccountManager.get(this)
        val restoredExplicit = savedInstanceState?.getBoolean(STATE_EXPLICIT_ACCOUNT, false) == true
        val intentExplicit = intent.hasExtra(EXTRA_ACCOUNT) || intent.hasExtra(EXTRA_CREATION_ID)
        if (restoredExplicit || intentExplicit) {
            val candidate = if (restoredExplicit)
                savedInstanceState?.getParcelable<Account>(STATE_ACCOUNT)
            else intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)
            val creationId = if (restoredExplicit)
                savedInstanceState?.getString(STATE_CREATION_ID)
            else intent.getStringExtra(EXTRA_CREATION_ID)
            val exact = ExactAccountRouting.validate(candidate, creationId, App.accountType, manager)
            return AccountRoute(exact, if (exact != null) creationId else null, true)
        }
        val active = ActiveAccountManager.getActiveAccount(this)
        val creationId = active?.let { manager.getUserData(it, AccountSettings.KEY_CREATION_ID) }
        val exact = ExactAccountRouting.validate(active, creationId, App.accountType, manager)
        return AccountRoute(exact, if (exact != null) creationId else null, false)
    }

    internal fun showCategory(category: SettingsCategory, addToBackStack: Boolean = true) {
        currentCategory = category
        val fragment = if (category == SettingsCategory.HOME) HomeFragment() else CategoryFragment.newInstance(category)
        supportFragmentManager.beginTransaction().replace(android.R.id.content, fragment).apply {
            if (addToBackStack) addToBackStack(category.route)
        }.commit()
        updateTitle()
    }

    private fun updateTitle() {
        title = getString(when (currentCategory) {
            SettingsCategory.HOME -> R.string.app_settings
            SettingsCategory.ACCOUNT -> R.string.settings_category_account
            SettingsCategory.SYNC -> R.string.settings_category_sync
            SettingsCategory.NOTIFICATIONS -> R.string.settings_category_notifications
            SettingsCategory.APPEARANCE -> R.string.settings_category_appearance
            SettingsCategory.PRIVACY_SECURITY -> R.string.settings_category_privacy_security
            SettingsCategory.HELP -> R.string.settings_category_help
            SettingsCategory.ADVANCED -> R.string.settings_category_advanced
        })
    }

    class HomeFragment : PreferenceFragmentCompat() {
        override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
            preferenceManager.sharedPreferencesName = AppPreferences.PREFERENCES_NAME
            setPreferencesFromResource(R.xml.settings_home, rootKey)
            val activity = requireActivity() as AppSettingsActivity
            activity.selectedAccount?.let { account ->
                findPreference<Preference>("settings_category_account")?.summary = account.name
            }
            val routes = mapOf(
                "settings_category_account" to SettingsCategory.ACCOUNT,
                "settings_category_sync" to SettingsCategory.SYNC,
                "settings_category_notifications" to SettingsCategory.NOTIFICATIONS,
                "settings_category_appearance" to SettingsCategory.APPEARANCE,
                "settings_category_privacy_security" to SettingsCategory.PRIVACY_SECURITY,
                "settings_category_help" to SettingsCategory.HELP
            )
            routes.forEach { (key, category) ->
                findPreference<Preference>(key)?.setOnPreferenceClickListener {
                    activity.showCategory(category)
                    true
                }
            }
        }
    }

    class CategoryFragment : PreferenceFragmentCompat() {
        val category: SettingsCategory
            get() = SettingsCategory.fromRoute(requireArguments().getString(ARG_CATEGORY))
        private val host: AppSettingsActivity get() = requireActivity() as AppSettingsActivity
        private val selectedAccount: Account get() = host.selectedAccount
            ?: throw IllegalStateException("An account is required for ${category.route} settings")
        private lateinit var appPreferences: AppPreferences

        override fun onCreatePreferences(savedInstanceState: Bundle?, rootKey: String?) {
            preferenceManager.sharedPreferencesName = AppPreferences.PREFERENCES_NAME
            appPreferences = AppPreferences(requireContext())
            setPreferencesFromResource(when (category) {
                SettingsCategory.ACCOUNT -> R.xml.settings_account
                SettingsCategory.SYNC -> R.xml.settings_sync
                SettingsCategory.NOTIFICATIONS -> R.xml.settings_notifications
                SettingsCategory.APPEARANCE -> R.xml.settings_appearance
                SettingsCategory.PRIVACY_SECURITY -> R.xml.settings_privacy_security
                SettingsCategory.HELP -> R.xml.settings_help
                SettingsCategory.ADVANCED -> R.xml.settings_advanced
                SettingsCategory.HOME -> error("Home uses HomeFragment")
            }, rootKey)
            when (category) {
                SettingsCategory.ACCOUNT -> setupAccount()
                SettingsCategory.SYNC -> setupSync()
                SettingsCategory.NOTIFICATIONS -> setupNotifications()
                SettingsCategory.APPEARANCE -> setupAppearance()
                SettingsCategory.PRIVACY_SECURITY -> setupPrivacySecurity()
                SettingsCategory.HELP -> setupHelp()
                SettingsCategory.ADVANCED -> setupAdvanced()
                SettingsCategory.HOME -> Unit
            }
        }

        private inline fun <reified T : Preference> requirePreference(key: String): T =
            findPreference<T>(key) ?: error("Required preference '$key' is missing from ${category.route}")

        private fun accountSettings(): AccountSettings? = try {
            AccountSettings(requireContext(), selectedAccount)
        } catch (_: InvalidAccountException) {
            null
        }

        private fun setupAccount() {
            val account = host.selectedAccount
            requirePreference<Preference>("account_identity").summary =
                account?.name ?: getString(R.string.settings_account_not_available)
            requirePreference<Preference>("manage_account").apply {
                isEnabled = account != null
                setOnPreferenceClickListener {
                    startActivity(AccountActivity.newIntent(requireContext(), account!!))
                    true
                }
            }
        }

        private fun setupSync() {
            val settings = host.selectedAccount?.let { accountSettings() }
            val interval = requirePreference<ListPreference>("sync_interval")
            if (settings == null) {
                interval.isEnabled = false
                interval.setSummary(R.string.settings_sync_summary_not_available)
            } else {
                settings.getSyncInterval(CalendarContract.AUTHORITY)?.let { current ->
                    interval.value = current.toString()
                    updateIntervalSummary(interval, current)
                    interval.setOnPreferenceChangeListener { _, newValue ->
                        val seconds = (newValue as String).toLong()
                        settings.setSyncInterval(App.addressBooksAuthority, seconds)
                        settings.setSyncInterval(CalendarContract.AUTHORITY, seconds)
                        TASK_PROVIDERS.forEach { settings.setSyncInterval(it.authority, seconds) }
                        updateIntervalSummary(interval, seconds)
                        true
                    }
                } ?: run {
                    interval.isEnabled = false
                    interval.setSummary(R.string.settings_sync_summary_not_available)
                }
            }

            requirePreference<SwitchPreferenceCompat>("sync_wifi_only").apply {
                isEnabled = settings != null
                if (settings != null) {
                    isChecked = settings.syncWifiOnly
                    setOnPreferenceChangeListener { _, value ->
                        settings.setSyncWiFiOnly(value as Boolean)
                        true
                    }
                }
            }
            requirePreference<EditTextPreference>("sync_wifi_only_ssid").apply {
                isEnabled = settings != null
                if (settings != null) {
                    text = settings.syncWifiOnlySSID
                    updateSsidSummary(this, settings.syncWifiOnlySSID)
                    setOnPreferenceChangeListener { _, value ->
                        val ssid = (value as String).takeUnless { TextUtils.isEmpty(it) }
                        settings.syncWifiOnlySSID = ssid
                        updateSsidSummary(this, ssid)
                        true
                    }
                }
            }
            requirePreference<SwitchPreferenceCompat>("prefer_tasksorg").apply {
                isChecked = appPreferences.preferTasksOrg
                setOnPreferenceChangeListener { _, value ->
                    appPreferences.preferTasksOrg = value as Boolean
                    Snackbar.make(requireView(), R.string.app_settings_prefer_tasksorg_snack, Snackbar.LENGTH_LONG).show()
                    true
                }
            }
        }

        private fun updateIntervalSummary(preference: ListPreference, seconds: Long) {
            if (seconds == AccountSettings.SYNC_INTERVAL_MANUALLY)
                preference.setSummary(R.string.settings_sync_summary_manually)
            else
                preference.summary = getString(R.string.settings_sync_summary_periodically, preference.entry)
        }

        private fun updateSsidSummary(preference: EditTextPreference, ssid: String?) {
            if (ssid == null) preference.setSummary(R.string.settings_sync_wifi_only_ssid_off)
            else preference.summary = getString(R.string.settings_sync_wifi_only_ssid_on, ssid)
        }

        private fun setupNotifications() {
            requirePreference<Preference>("notification_settings").apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    setOnPreferenceClickListener {
                        startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                            putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, requireContext().packageName)
                        })
                        true
                    }
                } else isVisible = false
            }
            requirePreference<SwitchPreferenceCompat>("show_change_notification").apply {
                isChecked = appPreferences.showChangeNotification
                setOnPreferenceChangeListener { _, value ->
                    appPreferences.showChangeNotification = value as Boolean
                    true
                }
            }
        }

        private fun setupAppearance() {
            requirePreference<ListPreference>("theme_mode").apply {
                value = appPreferences.themeMode.toString()
                summary = localizedThemeSummary(appPreferences.themeMode)
                setOnPreferenceChangeListener { _, value ->
                    val mode = (value as String).toInt()
                    appPreferences.themeMode = mode
                    summary = localizedThemeSummary(mode)
                    AppCompatDelegate.setDefaultNightMode(mode)
                    true
                }
            }
            requirePreference<Preference>("reset_hints").setOnPreferenceClickListener {
                HintManager.resetHints(requireContext())
                Snackbar.make(requireView(), R.string.app_settings_reset_hints_success, Snackbar.LENGTH_LONG).show()
                true
            }
        }

        private fun localizedThemeSummary(mode: Int): String = getString(when (mode) {
            AppCompatDelegate.MODE_NIGHT_NO -> R.string.settings_theme_light
            AppCompatDelegate.MODE_NIGHT_YES -> R.string.settings_theme_dark
            else -> R.string.settings_theme_system
        })

        private fun setupPrivacySecurity() {
            requirePreference<Preference>("password").apply {
                isEnabled = host.selectedAccount != null
                if (!isEnabled) setSummary(R.string.settings_sync_summary_not_available)
                setOnPreferenceClickListener {
                    startActivity(ChangeEncryptionPasswordActivity.newIntent(requireContext(), selectedAccount))
                    true
                }
            }
        }

        private fun setupHelp() {
            requirePreference<Preference>("settings_category_advanced").setOnPreferenceClickListener {
                host.showCategory(SettingsCategory.ADVANCED)
                true
            }
        }

        private fun setupAdvanced() {
            requirePreference<SwitchPreferenceCompat>("override_proxy").apply {
                isChecked = appPreferences.overrideProxy
                setOnPreferenceChangeListener { _, value ->
                    appPreferences.overrideProxy = value as Boolean
                    true
                }
            }
            requirePreference<EditTextPreference>("proxy_host").apply {
                text = appPreferences.proxyHost
                summary = appPreferences.proxyHost
                setOnPreferenceChangeListener { _, value ->
                    val host = value as String
                    if (!ProxySettingsValidation.isValidHost(host)) {
                        Snackbar.make(requireView(), R.string.settings_invalid_proxy_host, Snackbar.LENGTH_LONG).show()
                        return@setOnPreferenceChangeListener false
                    }
                    appPreferences.proxyHost = host
                    summary = host
                    true
                }
            }
            requirePreference<EditTextPreference>("proxy_port").apply {
                text = appPreferences.proxyPort.toString()
                summary = appPreferences.proxyPort.toString()
                setOnPreferenceChangeListener { _, value ->
                    val port = ProxySettingsValidation.parsePort(value as String)
                    if (port == null) {
                        Snackbar.make(requireView(), R.string.settings_invalid_proxy_port, Snackbar.LENGTH_LONG).show()
                        return@setOnPreferenceChangeListener false
                    }
                    appPreferences.proxyPort = port
                    text = port.toString()
                    summary = port.toString()
                    true
                }
            }
            requirePreference<SwitchPreferenceCompat>("distrust_system_certs").apply {
                isChecked = appPreferences.distrustSystemCertificates
                setOnPreferenceChangeListener { _, value ->
                    appPreferences.distrustSystemCertificates = value as Boolean
                    true
                }
            }
            requirePreference<Preference>("reset_certificates").apply {
                isVisible = BuildConfig.customCerts
                setOnPreferenceClickListener {
                    if (CustomCertManager.resetCertificates(requireActivity()))
                        Snackbar.make(requireView(), R.string.app_settings_reset_certificates_success, Snackbar.LENGTH_LONG).show()
                    true
                }
            }
            requirePreference<SwitchPreferenceCompat>("log_to_file").apply {
                isChecked = appPreferences.logToFile
                setOnPreferenceChangeListener { _, value -> appPreferences.logToFile = value as Boolean; true }
            }
            requirePreference<SwitchPreferenceCompat>("log_verbose").apply {
                isChecked = appPreferences.verboseLogging
                setOnPreferenceChangeListener { _, value -> appPreferences.verboseLogging = value as Boolean; true }
            }
            requirePreference<Preference>("show_debug_info").setOnPreferenceClickListener {
                startActivity(DebugInfoActivity.newIntent(requireContext(), AppSettingsActivity::class.java.name))
                true
            }
            initLanguagePreference()
        }

        private fun initLanguagePreference() {
            val preference = requirePreference<ListPreference>("select_language")
            lifecycleScope.launch {
                val locales = withContext(Dispatchers.IO) { LanguageUtils.getAppLanguages(requireContext()) }
                preference.entries = locales.displayNames
                preference.entryValues = locales.localeData
                preference.value = appPreferences.forcedLanguage
                preference.setOnPreferenceChangeListener { current, value ->
                    if (value.toString() == (current as ListPreference).value) return@setOnPreferenceChangeListener true
                    appPreferences.forcedLanguage = value.toString()
                    LanguageUtils.setLanguage(requireContext(), value.toString())
                    startActivity(Intent(requireContext(), AccountsActivity::class.java).apply {
                        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                    false
                }
            }
        }

        companion object {
            private const val ARG_CATEGORY = "category"
            fun newInstance(category: SettingsCategory) = CategoryFragment().apply {
                arguments = Bundle().apply { putString(ARG_CATEGORY, category.route) }
            }
        }
    }
}
