package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import androidx.preference.PreferenceManager
import androidx.preference.SwitchPreferenceCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.syncadapter.SyncNotification
import io.silentsuite.sync.ui.settings.AppPreferences
import io.silentsuite.sync.ui.settings.MigrationCommitStage
import io.silentsuite.sync.ui.settings.SettingsCategory
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsRuntimeTest {
    @Test
    fun exactAccountSyncSettingAndCategorySurviveRecreationWithoutChangingSibling() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val first = Account("settings-first-${System.nanoTime()}@example.invalid", App.accountType)
        val second = Account("settings-second-${System.nanoTime()}@example.invalid", App.accountType)
        listOf(first, second).forEachIndexed { index, account ->
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "settings-$index"))
        }
        try {
            ActivityScenario.launch<AppSettingsActivity>(
                AppSettingsActivity.newIntent(context, second, "settings-1", SettingsCategory.SYNC)
            ).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(second, activity.selectedAccount)
                    assertEquals("settings-1", activity.selectedCreationId)
                    assertEquals(SettingsCategory.SYNC, activity.currentCategory)
                    activity.supportFragmentManager.executePendingTransactions()
                    val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content)
                        as AppSettingsActivity.CategoryFragment
                    fragment.findPreference<SwitchPreferenceCompat>("sync_wifi_only")!!.performClick()
                }
                assertFalse(AccountSettings(context, first).syncWifiOnly)
                assertTrue(AccountSettings(context, second).syncWifiOnly)
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals(second, activity.selectedAccount)
                    assertEquals("settings-1", activity.selectedCreationId)
                    assertEquals(SettingsCategory.SYNC, activity.currentCategory)
                }
            }
        } finally {
            removeAccountAndWait(manager, first)
            removeAccountAndWait(manager, second)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun staleNotificationAndLegacyRoutesRejectReaddedSameNameAcrossProcessStyleRelaunch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("settings-stale-${System.nanoTime()}@example.invalid", App.accountType)
        val oldGeneration = "settings-old"
        check(manager.addAccountExplicitly(account, null, Bundle().apply {
            putString(AccountSettings.KEY_CREATION_ID, oldGeneration)
        }))
        val currentAccount = manager.getAccountsByType(account.type).single { it == account }
        assertEquals(oldGeneration, manager.getUserData(currentAccount, AccountSettings.KEY_CREATION_ID))
        val directIntent = AppSettingsActivity.newIntent(context, currentAccount, oldGeneration, SettingsCategory.SYNC)
        val notificationIntent = SyncNotification.settingsIntent(context, Bundle().apply {
            putParcelable(Constants.KEY_ACCOUNT, currentAccount)
            putString(AppSettingsActivity.EXTRA_CREATION_ID, oldGeneration)
        })
        val legacyIntent = AccountSettingsActivity.redirectIntent(
            context,
            AccountSettingsActivity.newIntent(context, currentAccount, SettingsCategory.SYNC)
        )

        try {
            removeAccountAndWait(manager, account)
            check(manager.addAccountExplicitly(account, null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, "settings-new")
            }))
            val replacement = manager.getAccountsByType(account.type).single { it == account }
            assertEquals("settings-new", manager.getUserData(replacement, AccountSettings.KEY_CREATION_ID))

            listOf(directIntent, notificationIntent, legacyIntent).forEach { staleIntent ->
                ActivityScenario.launch<AppSettingsActivity>(Intent(staleIntent)).use { scenario ->
                    scenario.onActivity { activity ->
                        assertEquals(null, activity.selectedAccount)
                        assertEquals(null, activity.selectedCreationId)
                        assertEquals(SettingsCategory.SYNC, activity.currentCategory)
                    }
                }
                // A new Activity instance models framework relaunch from the durable Intent,
                // rather than same-process ActivityScenario.recreate().
                ActivityScenario.launch<AppSettingsActivity>(Intent(staleIntent)).use { relaunched ->
                    relaunched.onActivity { activity -> assertEquals(null, activity.selectedAccount) }
                }
            }
        } finally {
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun loggerNotificationRouteKeepsAdvancedExactGenerationAcrossRecreationAndRejectsReplacement() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("settings-logger-${System.nanoTime()}@example.invalid", App.accountType)
        val oldGeneration = "logger-old"
        check(manager.addAccountExplicitly(account, null, Bundle().apply {
            putString(AccountSettings.KEY_CREATION_ID, oldGeneration)
        }))
        val currentAccount = manager.getAccountsByType(account.type).single { it == account }
        assertEquals(oldGeneration, manager.getUserData(currentAccount, AccountSettings.KEY_CREATION_ID))
        check(ActiveAccountManager.setActiveAccount(context, currentAccount))
        val loggerIntent = Logger.notificationSettingsIntent(context)

        try {
            ActivityScenario.launch<AppSettingsActivity>(Intent(loggerIntent)).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(currentAccount, activity.selectedAccount)
                    assertEquals(oldGeneration, activity.selectedCreationId)
                    assertEquals(SettingsCategory.ADVANCED, activity.currentCategory)
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals(currentAccount, activity.selectedAccount)
                    assertEquals(oldGeneration, activity.selectedCreationId)
                    assertEquals(SettingsCategory.ADVANCED, activity.currentCategory)
                }
            }

            removeAccountAndWait(manager, account)
            val replacementGeneration = "logger-new"
            check(manager.addAccountExplicitly(account, null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, replacementGeneration)
            }))
            val replacement = manager.getAccountsByType(account.type).single { it == account }
            assertEquals(replacementGeneration, manager.getUserData(replacement, AccountSettings.KEY_CREATION_ID))

            ActivityScenario.launch<AppSettingsActivity>(Intent(loggerIntent)).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(null, activity.selectedAccount)
                    assertEquals(null, activity.selectedCreationId)
                    assertEquals(SettingsCategory.ADVANCED, activity.currentCategory)
                }
            }
        } finally {
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun retainedSettingsRejectSameNameReplacementBeforeAccountMutation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("settings-replacement-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(account, null, null))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "settings-generation-a"))
        var replacement: Account? = null
        try {
            ActivityScenario.launch<AppSettingsActivity>(
                AppSettingsActivity.newIntent(context, account, "settings-generation-a", SettingsCategory.SYNC)
            ).use { scenario ->
                scenario.onActivity { it.supportFragmentManager.executePendingTransactions() }
                removeAccountAndWait(manager, account)
                val replacementAccount = Account(account.name, account.type)
                replacement = replacementAccount
                check(manager.addAccountExplicitly(replacementAccount, null, Bundle().apply {
                    putString(AccountSettings.KEY_CREATION_ID, "settings-generation-b")
                    putString(AccountSettings.KEY_SETTINGS_VERSION, AccountSettings.CURRENT_VERSION.toString())
                }))
                scenario.onActivity { activity ->
                    val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content)
                        as AppSettingsActivity.CategoryFragment
                    val wifiOnly = fragment.findPreference<SwitchPreferenceCompat>("sync_wifi_only")!!
                    assertFalse(wifiOnly.callChangeListener(true))
                    assertTrue(activity.isFinishing)
                }
                assertFalse(AccountSettings(context, replacementAccount).syncWifiOnly)
            }
        } finally {
            removeAccountAndWait(manager, replacement ?: account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun proxyPortPreferenceAcceptsBoundsAndPreservesPriorValueOnInvalidInput() {
        withEmptyPreferenceStores { _, _ ->
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val preferences = AppPreferences(context)
            preferences.proxyPort = 8118

            ActivityScenario.launch<AppSettingsActivity>(
                AppSettingsActivity.newIntent(context, SettingsCategory.ADVANCED)
            ).use { scenario ->
                scenario.onActivity { activity ->
                    activity.supportFragmentManager.executePendingTransactions()
                    val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content)
                        as AppSettingsActivity.CategoryFragment
                    val portPreference = fragment.findPreference<androidx.preference.EditTextPreference>("proxy_port")!!

                    assertTrue(portPreference.callChangeListener("1"))
                    assertEquals(1, preferences.proxyPort)
                    assertTrue(portPreference.callChangeListener("65535"))
                    assertEquals(65535, preferences.proxyPort)
                    listOf("0", "65536", "-1", "", "not-a-port").forEach { invalid ->
                        assertFalse("Expected invalid proxy port: $invalid", portPreference.callChangeListener(invalid))
                        assertEquals(65535, preferences.proxyPort)
                        assertEquals("65535", portPreference.text)
                    }
                }
            }
        }
    }

    @Test
    fun twoStoreMigrationRerunsAfterDefaultAliasCommitFailure() {
        withEmptyPreferenceStores { app, defaults ->
            check(app.edit().putString("overrideProxyPort", "invalid").commit())
            check(defaults.edit().putString("proxy_port", "9050").putBoolean("log_to_file", true).commit())
            val stages = mutableListOf<MigrationCommitStage>()

            AppPreferences.migrate(
                InstrumentationRegistry.getInstrumentation().targetContext,
                app,
                defaults
            ) { stage, editor ->
                stages += stage
                if (stage == MigrationCommitStage.DEFAULT_ALIASES) false else editor.commit()
            }
            assertEquals(listOf(MigrationCommitStage.CANONICAL, MigrationCommitStage.DEFAULT_ALIASES), stages)
            assertEquals(9050, app.getInt(AppPreferences.KEY_PROXY_PORT, -1))
            assertTrue(defaults.contains("proxy_port"))
            assertFalse(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))

            AppPreferences.migrate(InstrumentationRegistry.getInstrumentation().targetContext, app, defaults)
            assertFalse(app.contains("overrideProxyPort"))
            assertFalse(defaults.contains("proxy_port"))
            assertFalse(defaults.contains("log_to_file"))
            assertTrue(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))
        }
    }

    @Test
    fun migrationRerunsAfterCanonicalStoreCommitFailureWithoutTouchingAliases() {
        withEmptyPreferenceStores { app, defaults ->
            check(app.edit().putBoolean("overrideProxy", true).commit())
            check(defaults.edit().putBoolean("override_proxy", false).commit())
            val stages = mutableListOf<MigrationCommitStage>()

            AppPreferences.migrate(
                InstrumentationRegistry.getInstrumentation().targetContext,
                app,
                defaults
            ) { stage, editor ->
                stages += stage
                if (stage == MigrationCommitStage.CANONICAL) false else editor.commit()
            }
            assertEquals(listOf(MigrationCommitStage.CANONICAL), stages)
            assertTrue(app.contains("overrideProxy"))
            assertTrue(defaults.contains("override_proxy"))
            assertFalse(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))

            AppPreferences.migrate(InstrumentationRegistry.getInstrumentation().targetContext, app, defaults)
            assertTrue(app.getBoolean(AppPreferences.KEY_OVERRIDE_PROXY, false))
            assertFalse(app.contains("overrideProxy"))
            assertFalse(defaults.contains("override_proxy"))
            assertTrue(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))
        }
    }

    @Test
    fun migrationMarkerFailureRerunsAndMarkerIsAlwaysLast() {
        withEmptyPreferenceStores { app, defaults ->
            check(app.edit().putBoolean("overrideProxy", true).commit())
            check(defaults.edit().putBoolean("override_proxy", false).commit())
            val stages = mutableListOf<MigrationCommitStage>()

            AppPreferences.migrate(
                InstrumentationRegistry.getInstrumentation().targetContext,
                app,
                defaults
            ) { stage, editor ->
                stages += stage
                if (stage == MigrationCommitStage.MARKER) false else editor.commit()
            }
            assertEquals(
                listOf(MigrationCommitStage.CANONICAL, MigrationCommitStage.DEFAULT_ALIASES, MigrationCommitStage.MARKER),
                stages
            )
            assertTrue(app.getBoolean(AppPreferences.KEY_OVERRIDE_PROXY, false))
            assertFalse(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))
            assertFalse(defaults.contains("override_proxy"))

            AppPreferences.migrate(InstrumentationRegistry.getInstrumentation().targetContext, app, defaults)
            assertTrue(app.getBoolean(AppPreferences.KEY_OVERRIDE_PROXY, false))
            assertTrue(app.getBoolean(AppPreferences.KEY_MIGRATION_COMPLETE, false))
        }
    }

    private fun withEmptyPreferenceStores(block: (SharedPreferences, SharedPreferences) -> Unit) {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.getSharedPreferences(AppPreferences.PREFERENCES_NAME, Context.MODE_PRIVATE)
        val defaults = PreferenceManager.getDefaultSharedPreferences(context)
        val originalApp = app.all.toMap()
        val originalDefaults = defaults.all.toMap()
        check(app.edit().clear().commit())
        check(defaults.edit().clear().commit())
        try {
            block(app, defaults)
        } finally {
            restorePreferences(app, originalApp)
            restorePreferences(defaults, originalDefaults)
        }
    }

    private fun removeAccountAndWait(manager: AccountManager, account: Account) {
        val finished = CountDownLatch(1)
        var removed = false
        AndroidCompat.removeAccount(manager, account) { result ->
            removed = result
            finished.countDown()
        }
        check(finished.await(10, TimeUnit.SECONDS) && removed)
        check(manager.getAccountsByType(account.type).none { it == account })
    }

    private fun restorePreferences(preferences: SharedPreferences, values: Map<String, *>) {
        val editor = preferences.edit().clear()
        values.forEach { (key, value) ->
            when (value) {
                is Boolean -> editor.putBoolean(key, value)
                is Int -> editor.putInt(key, value)
                is Long -> editor.putLong(key, value)
                is Float -> editor.putFloat(key, value)
                is String -> editor.putString(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") editor.putStringSet(key, value as Set<String>)
            }
        }
        check(editor.commit())
    }
}
