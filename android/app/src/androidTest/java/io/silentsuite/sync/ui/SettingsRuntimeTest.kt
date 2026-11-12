package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.app.Notification
import android.app.NotificationManager
import android.content.ContentResolver
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.CalendarContract
import android.service.notification.StatusBarNotification
import android.system.Os
import android.system.OsConstants
import android.widget.TextView
import androidx.annotation.StringRes
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.view.menu.MenuBuilder
import androidx.core.app.NotificationManagerCompat
import androidx.fragment.app.DialogFragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.preference.Preference
import androidx.preference.PreferenceCategory
import androidx.preference.PreferenceManager
import androidx.preference.SwitchPreferenceCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import at.bitfire.ical4android.TaskProvider
import com.google.android.material.snackbar.Snackbar
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.HttpClient
import io.silentsuite.sync.R
import io.silentsuite.sync.log.Logger
import io.silentsuite.sync.notes.MainThreadStoreProbe
import io.silentsuite.sync.notes.NotesSyncCoordinator
import io.silentsuite.sync.notes.edit.NotesFolderListings.Folder
import io.silentsuite.sync.notes.edit.PendingNotesDiscardPermits
import io.silentsuite.sync.notes.edit.PendingNotesStore
import io.silentsuite.sync.notes.edit.UnsyncedNotes
import io.silentsuite.sync.syncadapter.SyncNotification
import io.silentsuite.sync.ui.UnsyncedNotesDiscardPolicy.Step
import io.silentsuite.sync.ui.settings.AppPreferences
import io.silentsuite.sync.ui.settings.MigrationCommitStage
import io.silentsuite.sync.ui.settings.SettingsCategory
import io.silentsuite.sync.ui.setup.AuthenticatorResponseController
import io.silentsuite.sync.ui.setup.GuardedRecoveryRemoval
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.setup.LoginFlowOwnerRegistry
import io.silentsuite.sync.ui.setup.SetupSecretHolder
import io.silentsuite.sync.ui.setup.SignupContinuationRegistry
import io.silentsuite.sync.utils.AccountRowChanges
import io.silentsuite.sync.utils.AndroidCompat
import io.silentsuite.sync.utils.NotificationUtils
import java.io.File
import java.io.IOException
import java.net.URI
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Preference key of the approved Settings → Recover deleted contacts entry. */
private const val RECOVER_DELETED_CONTACTS_KEY = "recover_deleted_contacts"

/** The token of an app process that is not this one, for a removal confirmation restored as in a new process. */
private const val ANOTHER_PROCESS = "another-process"

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
    fun recoverDeletedContactsEntryOpensExactAccountDestinationAndRejectsStaleRoute() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val active = Account("settings-recovery-active-${System.nanoTime()}@example.invalid", App.accountType)
        val selected = Account("settings-recovery-selected-${System.nanoTime()}@example.invalid", App.accountType)
        val selectedGeneration = "recovery-selected"
        listOf(active to "recovery-active", selected to selectedGeneration).forEach { (account, generation) ->
            check(manager.addAccountExplicitly(account, null, null))
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
        }
        // A different active account proves the stale explicit route below does not fall back to it.
        check(ActiveAccountManager.setActiveAccount(context, active))
        val exactIntent = AppSettingsActivity.newIntent(context, selected, selectedGeneration)
        fun shown(activity: AppSettingsActivity) =
            activity.supportFragmentManager.findFragmentById(android.R.id.content)
        fun recoveryEntry(activity: AppSettingsActivity): Preference? {
            activity.supportFragmentManager.executePendingTransactions()
            val home = shown(activity) as AppSettingsActivity.HomeFragment
            return home.findPreference(RECOVER_DELETED_CONTACTS_KEY)
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val listed = java.util.Collections.synchronizedList(mutableListOf<Pair<Account, String>>())
        AppSettingsActivity.recoveryAddressBooksOverride = { _, account, creationId ->
            listed += account to creationId
            listOf(RecoveryAddressBook("recovery-book-a", "Recovery book A"),
                RecoveryAddressBook("recovery-book-b", "Recovery book B"))
        }
        val collectionClass = io.silentsuite.sync.ui.etebase.CollectionActivity::class.java.name
        var started: Intent? = null
        // Inspecting a started intent needs API 26; older lanes can only count the blocked launch.
        val launches = if (android.os.Build.VERSION.SDK_INT >= 26)
            object : android.app.Instrumentation.ActivityMonitor() {
                override fun onStartActivity(intent: Intent): android.app.Instrumentation.ActivityResult? {
                    if (intent.component?.className != collectionClass) return null
                    started = intent
                    return android.app.Instrumentation.ActivityResult(0, null)
                }
            }
        else android.app.Instrumentation.ActivityMonitor(collectionClass, null, true)
        fun awaitBook(scenario: ActivityScenario<AppSettingsActivity>, uid: String, owner: Account = selected): Preference {
            var found: Preference? = null
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (found == null && System.nanoTime() < deadline) {
                scenario.onActivity { activity ->
                    activity.supportFragmentManager.executePendingTransactions()
                    found = (shown(activity) as? androidx.preference.PreferenceFragmentCompat)
                        ?.findPreference(recoveryAddressBookKey(owner, uid))
                }
                if (found == null) Thread.sleep(50)
            }
            assertNotNull("Recovery picker must list address book $uid of ${owner.name}", found)
            return found!!
        }

        try {
            instrumentation.addMonitor(launches)
            ActivityScenario.launch<AppSettingsActivity>(Intent(exactIntent)).use { scenario ->
                var destination: Class<*>? = null
                scenario.onActivity { activity ->
                    val entry = recoveryEntry(activity)
                    assertNotNull("Settings home must offer Recover deleted contacts", entry)
                    assertTrue(entry!!.isEnabled)
                    entry.performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    val opened = shown(activity)
                    assertNotNull(opened)
                    assertFalse(opened is AppSettingsActivity.HomeFragment)
                    assertFalse(activity.isFinishing)
                    assertEquals(selected, activity.selectedAccount)
                    assertEquals(selectedGeneration, activity.selectedCreationId)
                    destination = opened!!.javaClass
                }
                // The picker lists the routed account's address books only, never the active account's.
                awaitBook(scenario, "recovery-book-a")
                val book = awaitBook(scenario, "recovery-book-b")
                assertEquals(setOf(selected to selectedGeneration), listed.toSet())
                scenario.onActivity { activity ->
                    val picker = shown(activity) as androidx.preference.PreferenceFragmentCompat
                    assertEquals(null, picker.findPreference<Preference>(recoveryAddressBookKey(active, "recovery-book-a")))
                    assertEquals(null, picker.findPreference<Preference>(RECOVERY_NONE_KEY))
                    book.performClick()
                }
                instrumentation.waitForIdleSync()
                assertEquals(1, launches.hits)
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    val intent = started!!
                    // Only identifiers are routed: no address-book name or contact content.
                    assertEquals(setOf(
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_ACCOUNT,
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_CREATION_ID,
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_COLLECTION_UID,
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_RECOVER_DELETED_CONTACTS
                    ), intent.extras!!.keySet())
                    assertEquals(selected, intent.getParcelableExtra<Account>(
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_ACCOUNT))
                    assertEquals(selectedGeneration, intent.getStringExtra(
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_CREATION_ID))
                    assertEquals("recovery-book-b", intent.getStringExtra(
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_COLLECTION_UID))
                    assertTrue(intent.getBooleanExtra(
                        io.silentsuite.sync.ui.etebase.CollectionActivity.EXTRA_RECOVER_DELETED_CONTACTS, false))
                }
                scenario.recreate()
                awaitBook(scenario, "recovery-book-b")
                scenario.onActivity { activity ->
                    assertEquals(selected, activity.selectedAccount)
                    assertEquals(selectedGeneration, activity.selectedCreationId)
                    assertEquals(destination, shown(activity)?.javaClass)
                    assertTrue(activity.supportFragmentManager.popBackStackImmediate())
                    assertTrue(shown(activity) is AppSettingsActivity.HomeFragment)
                    assertEquals(SettingsCategory.HOME, activity.currentCategory)
                }

                // A picker left open across a same-name replacement opens nothing for the new generation.
                scenario.onActivity { activity -> recoveryEntry(activity)!!.performClick() }
                val stalePick = awaitBook(scenario, "recovery-book-a")
                removeAccountAndWait(manager, selected)
                check(manager.addAccountExplicitly(selected, null, Bundle().apply {
                    putString(AccountSettings.KEY_CREATION_ID, "recovery-replacement")
                }))
                scenario.onActivity { activity ->
                    stalePick.performClick()
                    assertTrue(activity.isFinishing)
                }
                instrumentation.waitForIdleSync()
                assertEquals(1, launches.hits)
            }

            ActivityScenario.launch<AppSettingsActivity>(Intent(exactIntent)).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(null, activity.selectedAccount)
                    val entry = recoveryEntry(activity)
                    assertNotNull(entry)
                    assertFalse(entry!!.isEnabled)
                    entry.performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertTrue(shown(activity) is AppSettingsActivity.HomeFragment)
                }
            }

            // Global Settings offers every current account, each under its own heading and with its
            // current generation, and lists them again after recreation.
            listed.clear()
            ActivityScenario.launch<AppSettingsActivity>(AppSettingsActivity.newIntent(context)).use { scenario ->
                scenario.onActivity { activity ->
                    val entry = recoveryEntry(activity)
                    assertTrue(entry!!.isEnabled)
                    entry.performClick()
                }
                repeat(2) { pass ->
                    if (pass == 1) scenario.recreate()
                    listOf(active, selected).forEach { owner -> awaitBook(scenario, "recovery-book-a", owner) }
                    scenario.onActivity { activity ->
                        val picker = shown(activity) as androidx.preference.PreferenceFragmentCompat
                        listOf(active, selected).forEach { owner ->
                            val heading = picker.findPreference<Preference>(recoveryAddressBookKey(owner, "recovery-book-b"))!!.parent
                            assertTrue(heading is androidx.preference.PreferenceCategory)
                            assertEquals(owner.name, heading!!.title.toString())
                        }
                    }
                }
                assertTrue(listed.containsAll(listOf(active to "recovery-active", selected to "recovery-replacement")))
                assertFalse(listed.any { it == selected to selectedGeneration })
            }
        } finally {
            instrumentation.removeMonitor(launches)
            AppSettingsActivity.recoveryAddressBooksOverride = null
            listOf(active, selected).forEach { account ->
                if (manager.getAccountsByType(account.type).any { it == account })
                    removeAccountAndWait(manager, account)
            }
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

    @Test
    fun schedulingDiagnosticsFromAdvancedSettingsAreBoundedContentFreeAndReadOnly() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = AccountManager.get(context)
        val account = Account("scheduling-marker-${System.nanoTime()}@example.invalid", App.accountType)
        val creationId = "scheduling-marker-generation"
        val requestId = java.util.UUID.randomUUID().toString()
        val monitor = android.app.Instrumentation.ActivityMonitor(DebugInfoActivity::class.java.name, null, false)
        var chooserIntent: Intent? = null
        // Inspecting a started intent needs API 26; older lanes can only count the blocked chooser.
        val chooser = if (android.os.Build.VERSION.SDK_INT >= 26)
            object : android.app.Instrumentation.ActivityMonitor() {
                override fun onStartActivity(intent: Intent): android.app.Instrumentation.ActivityResult? {
                    if (intent.action != Intent.ACTION_CHOOSER) return null
                    chooserIntent = intent
                    return android.app.Instrumentation.ActivityResult(0, null)
                }
            }
        else
            android.app.Instrumentation.ActivityMonitor(
                android.content.IntentFilter(Intent.ACTION_CHOOSER),
                android.app.Instrumentation.ActivityResult(0, null),
                true
            )
        check(manager.addAccountExplicitly(account, null, null))
        try {
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
            instrumentation.addMonitor(monitor)
            val store = io.silentsuite.sync.syncadapter.SyncStatusStore(context)
            check(store.recordRequested(
                account,
                setOf(io.silentsuite.sync.syncadapter.SyncStatusStore.Service.CALENDAR),
                requestId,
                System.currentTimeMillis() - 5 * 60_000L
            ))
            val before = settledSchedulingEvidence(account) { schedulingEvidence(context, manager, account, store) }
            var shown = ""
            var shared = ""
            var opened = false
            for (category in SettingsCategory.values()) {
                if (opened) break
                ActivityScenario.launch<AppSettingsActivity>(AppSettingsActivity.newIntent(context, category)).use { scenario ->
                    scenario.onActivity { activity ->
                        activity.supportFragmentManager.executePendingTransactions()
                        val fragment = activity.supportFragmentManager.findFragmentById(android.R.id.content)
                            as? AppSettingsActivity.CategoryFragment
                        val preference = fragment?.findPreference<androidx.preference.Preference>("show_scheduling_diagnostics")
                        if (preference != null) {
                            preference.performClick()
                            opened = true
                        }
                    }
                    if (opened) {
                        val debugInfo = monitor.waitForActivityWithTimeout(10_000) as DebugInfoActivity
                        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                        while (System.nanoTime() < deadline && !shown.contains("--- END SCHEDULING DIAGNOSTICS ---")) {
                            Thread.sleep(100)
                            instrumentation.runOnMainSync {
                                runCatching { shown = debugInfo.tvReport.text.toString() }
                            }
                        }
                        assertTrue(shown.contains("--- END SCHEDULING DIAGNOSTICS ---"))
                        instrumentation.addMonitor(chooser)
                        try {
                            instrumentation.runOnMainSync {
                                debugInfo.onShare(android.widget.PopupMenu(debugInfo, debugInfo.tvReport).menu.add("share"))
                            }
                            if (android.os.Build.VERSION.SDK_INT >= 26) {
                                val send = chooserIntent!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
                                assertEquals(Intent.ACTION_SEND, send.action)
                                assertEquals("text/plain", send.type)
                                assertEquals(setOf(Intent.EXTRA_TEXT), send.extras!!.keySet())
                                assertEquals(null, send.data)
                                assertEquals(null, send.clipData)
                                shared = send.getStringExtra(Intent.EXTRA_TEXT)!!
                            } else {
                                assertEquals(1, chooser.hits)
                                shared = shown
                            }
                        } finally {
                            instrumentation.removeMonitor(chooser)
                            instrumentation.runOnMainSync { debugInfo.finish() }
                        }
                    }
                }
            }

            assertTrue(opened)
            assertEquals(shown, shared)
            assertSchedulingReportIsContentFree(shared, creationId, requestId)
            assertTrue(shared.contains("Battery optimization exemption: "))
            assertTrue(shared.contains("\nNETWORK\n"))
            assertTrue(shared.contains("\nMAIN ACCOUNTS\n"))
            assertTrue(shared.contains("Account #1"))
            assertTrue(shared.contains("recorded request: open age=1m_to_15m"))
            assertTrue(shared.contains("not associated with a main account"))
            assertEquals(before, schedulingEvidence(context, manager, account, store))
        } finally {
            instrumentation.removeMonitor(monitor)
            removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun schedulingDiagnosticsSurviveAccountReplacementAndUnavailableServices() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("scheduling-marker-${System.nanoTime()}@example.invalid", App.accountType)
        val requestId = java.util.UUID.randomUUID().toString()
        val app = context.getSharedPreferences(AppPreferences.PREFERENCES_NAME, Context.MODE_PRIVATE)
        val defaults = PreferenceManager.getDefaultSharedPreferences(context)
        check(manager.addAccountExplicitly(account, null, Bundle().apply {
            putString(AccountSettings.KEY_CREATION_ID, "scheduling-marker-old")
        }))
        try {
            val store = io.silentsuite.sync.syncadapter.SyncStatusStore(context)
            check(store.recordRequested(
                account,
                setOf(
                    io.silentsuite.sync.syncadapter.SyncStatusStore.Service.CONTACTS,
                    io.silentsuite.sync.syncadapter.SyncStatusStore.Service.TASKS
                ),
                requestId,
                System.currentTimeMillis() - 5 * 60_000L
            ))
            fun evidence() = schedulingEvidence(context, manager, account, store) +
                listOf(app.all.toMap(), defaults.all.toMap())
            fun readOnlyReport(): String {
                val before = settledSchedulingEvidence(account, ::evidence)
                val report = SchedulingDiagnostics.report(context)
                assertEquals(before, evidence())
                assertSchedulingReportIsContentFree(report, requestId, "scheduling-marker-old", "scheduling-marker-new")
                return report
            }

            assertTrue(readOnlyReport().contains("recorded request: open age=1m_to_15m"))

            removeAccountAndWait(manager, account)
            assertSchedulingReportIsContentFree(SchedulingDiagnostics.report(context), requestId)

            check(manager.addAccountExplicitly(account, null, Bundle().apply {
                putString(AccountSettings.KEY_CREATION_ID, "scheduling-marker-new")
            }))
            assertTrue(readOnlyReport().contains("Account #1"))

            val standby = "Standby bucket: " + if (android.os.Build.VERSION.SDK_INT >= 28) "unknown" else "unavailable"
            listOf<(String) -> Any?>(
                { null },
                { throw SecurityException("scheduling-marker-denied") }
            ).forEach { systemService ->
                val restricted = object : android.content.ContextWrapper(context) {
                    override fun getApplicationContext(): Context = this
                    override fun getSystemService(name: String): Any? = systemService(name)
                }
                val before = settledSchedulingEvidence(account, ::evidence)
                val report = SchedulingDiagnostics.report(restricted)
                assertEquals(before, evidence())
                assertSchedulingReportIsContentFree(report, requestId)
                listOf(
                    "Battery optimization exemption: unavailable", "Battery saver: unavailable",
                    "Background restricted: unavailable", standby, "Active network: unavailable",
                    "Validated: unavailable", "Metered: unavailable", "VPN: unavailable",
                    "Data Saver: unavailable", "\nMAIN ACCOUNTS\nCount: unknown\n"
                ).forEach { assertTrue(it, report.contains(it)) }
                assertFalse(report.contains("Account #"))
            }
        } finally {
            if (manager.getAccountsByType(account.type).any { it == account })
                removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * Settings, Unsynced Notes from the sign-in screen's menu, with no account and no session: two stores whose account
     * is gone. One is discarded after Cancel and Back changed nothing and across a recreation of its open dialog, its
     * permit on disk before the first file goes. A dialog that Android restores in a new app process discards nothing,
     * and the orphan's finished instance stays closed. The other cannot be listed: it is offered only an
     * acknowledgement, which deletes nothing, and once it lists, a discard with its real count. A third store's folder
     * is then replaced by a link to it: it too is offered only an acknowledgement, under the link's own name, and
     * nothing behind the link changes. Every request is refused and counted, and so is every Notes run.
     */
    @Test
    fun unsyncedNotesFromSignInAreDiscardedOfflineAndAnUnlistableStoreIsOnlyAcknowledged() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val notes = UnsyncedNotesOnDevice(context)
        val a = notes.orphanFolder()
        val b = notes.orphanFolder()
        val c = notes.orphanFolder()
        notes.assertClean(a, b, c)
        val monitor = android.app.Instrumentation.ActivityMonitor(AppSettingsActivity::class.java.name, null, false)
        val unmatched = context.getString(R.string.notes_store_unmatched)
        val one = context.resources.getQuantityString(R.plurals.notes_store_unsynced, 1, 1)
        val unlisted = context.getString(R.string.notes_store_unlisted)
        val done = context.getString(R.string.notes_discard_done)
        try {
            notes.isolate()
            notes.save(PendingNotesStore.forDirectory(context, a), "n1")
            notes.save(PendingNotesStore.forDirectory(context, b), "n1")
            val filesA = notes.filesOf(a)
            val filesB = notes.filesOf(b)
            // From here on the screen opens every store first, through forDirectory, as after a restart.
            PendingNotesStore.resetForTesting()
            notes.probe.listing = { d -> if (d.name == b) null else d.listFiles() }
            LoginActivity.controllerFactory = { _, _ ->
                AuthenticatorResponseController(object : AuthenticatorResponseController.Delivery {
                    override fun continued() = Unit
                    override fun result(result: Bundle) = Unit
                    override fun error(code: Int, message: String) = Unit
                }, null)
            }
            instrumentation.addMonitor(monitor)
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { login ->
                try {
                    // 1. The sign-in menu opens Settings with no account, and the screen as its root.
                    login.onActivity { activity ->
                        val menu = MenuBuilder(activity)
                        assertTrue(activity.onCreateOptionsMenu(menu))
                        val item = requireNotNull(menu.findItem(UnsyncedNotesEntry.ITEM_ID)) { "the menu item" }
                        assertEquals(context.getString(R.string.settings_unsynced_notes), item.title.toString())
                        assertTrue(activity.onOptionsItemSelected(item))
                    }
                    val opened = monitor.waitForActivityWithTimeout(10_000) as AppSettingsActivity
                    assertTrue(opened.intent.getBooleanExtra(AppSettingsActivity.EXTRA_UNSYNCED_NOTES, false))
                    assertFalse(opened.intent.hasExtra(AppSettingsActivity.EXTRA_ACCOUNT))
                    assertFalse(opened.intent.hasExtra(AppSettingsActivity.EXTRA_CREATION_ID))
                    var settings = notes.resumedSettings(null)
                    assertSame(opened, settings)
                    instrumentation.runOnMainSync {
                        val fragments = settings.supportFragmentManager
                        assertTrue(fragments.findFragmentById(android.R.id.content) is UnsyncedNotesFragment)
                        assertEquals(0, fragments.backStackEntryCount)
                        assertEquals(context.getString(R.string.settings_unsynced_notes), settings.title.toString())
                    }

                    // 2. Both stores, matched to no account: A counted, B that cannot be read right now.
                    notes.awaitRows(settings, listOf(a, b).sorted().map {
                        val summary = if (it == a) one else unlisted
                        UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.rowKey(it), unmatched, summary)
                    })

                    // 3. Cancel, and Back, change nothing: neither starts a confirmation, which would show at once on
                    // the main thread, and the files and permits stay.
                    notes.tapRow(settings, a)
                    notes.tap(settings, Step.DISCARD, a, DialogInterface.BUTTON_NEGATIVE)
                    notes.awaitNoDialog(settings)
                    assertEquals("Cancel", false to null, notes.confirmationOf(settings))
                    notes.tapRow(settings, a)
                    notes.back(settings, Step.DISCARD, a)
                    notes.awaitNoDialog(settings)
                    assertEquals("Back", false to null, notes.confirmationOf(settings))
                    notes.assertFiles("Cancel and Back", a, filesA)
                    notes.assertFiles("Cancel and Back", b, filesB)
                    assertFalse(notes.permits().any { it == "$a.permit" || it == "$b.permit" })

                    // 4. A's Discard, across a recreation of its open dialog: the permit, then the files.
                    notes.tapRow(settings, a)
                    val message = context.resources.getQuantityString(R.plurals.notes_discard_store_text, 1, 1,
                        context.getString(R.string.notes_store_unmatched_name))
                    assertEquals(message, notes.texts(settings, Step.DISCARD, a).message)
                    instrumentation.runOnMainSync { settings.recreate() }
                    settings = notes.resumedSettings(settings)
                    val discard = notes.texts(settings, Step.DISCARD, a)
                    assertEquals(message, discard.message)
                    assertEquals(context.getString(R.string.notes_discard), discard.positive)
                    // A dialog that Android restores in a new app process has another process's token, or none: its
                    // Discard deletes and records nothing, and the dialog shows again, made in this process.
                    for (token in listOf("another-process", null)) {
                        val (had, restored) = notes.restoredFromAnotherProcess(settings, Step.DISCARD, a, token)
                        settings = restored
                        assertEquals("made in this process", ProcessIncarnation.current(), had)
                        assertEquals("token $token", message, notes.texts(settings, Step.DISCARD, a).message)
                        notes.tap(settings, Step.DISCARD, a, DialogInterface.BUTTON_POSITIVE)
                        notes.awaitOneFromThisProcess(settings, Step.DISCARD, a)
                        assertNull("token $token: nothing was removed", notes.atFirstRemoval(a))
                        assertFalse("token $token: no permit", "$a.permit" in notes.permits())
                        notes.assertFiles("token $token", a, filesA)
                    }
                    notes.tap(settings, Step.DISCARD, a, DialogInterface.BUTTON_POSITIVE)
                    notes.awaitSnackbar(settings, done)
                    assertTrue("the permit was on disk at the first removal: ${notes.atFirstRemoval(a)}",
                        "$a.permit" in notes.atFirstRemoval(a).orEmpty())
                    assertFalse(a in notes.stores())
                    assertFalse("$a.permit" in notes.permits())
                    // A has no present account, so its finished instance stays closed: a late save is refused and
                    // does not bring the folder back.
                    val kept = PendingNotesStore.forDirectory(context, a)
                    assertTrue(kept.clearedInFull())
                    val late = runCatching { notes.save(kept, "n2") }.exceptionOrNull()
                    assertTrue("$late", late is PendingNotesStore.Cleared)
                    assertFalse(a in notes.stores())

                    // 5. B, which cannot be listed: an acknowledgement, never called a discard, deletes nothing.
                    notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.rowKey(b),
                        unmatched, unlisted)))
                    notes.tapRow(settings, b)
                    val acknowledgement = notes.texts(settings, Step.ACKNOWLEDGE, b)
                    assertEquals(context.getString(R.string.notes_acknowledge_title), acknowledgement.title)
                    assertEquals(context.getString(R.string.notes_acknowledge_continue), acknowledgement.positive)
                    assertTrue("$acknowledgement",
                        acknowledgement.all.none { it.contains("discard", ignoreCase = true) })
                    notes.tap(settings, Step.ACKNOWLEDGE, b, DialogInterface.BUTTON_POSITIVE)
                    notes.awaitSnackbar(settings, context.getString(R.string.notes_acknowledged))
                    notes.assertFiles("the acknowledgement", b, filesB)
                    assertTrue("$b.acknowledgement" in notes.permits())
                    assertFalse("$b.permit" in notes.permits())
                    val opener = PendingNotesStore.forDirectory(context, b)
                    assertFalse(opener.unsynced().listed)
                    assertTrue("held, and bound to B through the screen's opener", opener.acknowledged())

                    // 6. Once B lists, its count withdraws the acknowledgement, and B is a discard with its real count.
                    notes.probe.listing = null
                    instrumentation.runOnMainSync { settings.recreate() }
                    settings = notes.resumedSettings(settings)
                    notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.rowKey(b),
                        unmatched, one)))
                    assertFalse("$b.acknowledgement" in notes.permits())
                    notes.tapRow(settings, b)
                    assertEquals(message, notes.texts(settings, Step.DISCARD, b).message)
                    notes.tap(settings, Step.DISCARD, b, DialogInterface.BUTTON_POSITIVE)
                    notes.awaitSnackbar(settings, done)
                    assertFalse(b in notes.stores())
                    notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.KEY_NONE,
                        context.getString(R.string.notes_stores_none), null, enabled = false)))

                    // 7. A store folder that is a link is never followed. C's folder, holding a change, is moved aside
                    // and a link to it takes its place: its row says it cannot be read right now, it is offered only
                    // the acknowledgement, recorded under the link's own name, and nothing behind the link changes.
                    notes.save(PendingNotesStore.forDirectory(context, c), "n1")
                    val link = notes.storeDir(c)
                    val aside = File(context.noBackupFilesDir, "notes-link-target-${System.nanoTime()}")
                    assertTrue(link.renameTo(aside))
                    val heldAside = notes.filesIn(aside)
                    try {
                        Os.symlink(aside.path, link.path)
                        instrumentation.runOnMainSync { settings.recreate() }
                        settings = notes.resumedSettings(settings)
                        notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.rowKey(c),
                            unmatched, unlisted)))
                        notes.tapRow(settings, c)
                        assertEquals(acknowledgement, notes.texts(settings, Step.ACKNOWLEDGE, c))
                        assertFalse("no discard step", notes.shows(settings, Step.DISCARD, c))
                        notes.tap(settings, Step.ACKNOWLEDGE, c, DialogInterface.BUTTON_POSITIVE)
                        notes.awaitSnackbar(settings, context.getString(R.string.notes_acknowledged))
                        assertTrue("$c.acknowledgement" in notes.permits())
                        assertFalse("$c.permit" in notes.permits())
                        assertTrue("the link is still there", OsConstants.S_ISLNK(Os.lstat(link.path).st_mode))
                        assertEquals(aside.path, Os.readlink(link.path))
                        notes.assertFilesIn("behind the link", aside, heldAside)
                    } finally {
                        // The folder comes back, so restore() clears it as it clears the others.
                        if (runCatching { OsConstants.S_ISLNK(Os.lstat(link.path).st_mode) }.getOrDefault(false)) {
                            Os.remove(link.path)
                        }
                        aside.renameTo(link)
                    }
                    notes.assertFiles("C's folder, back", c, heldAside)

                    // 8. Back once leaves Settings for the sign-in screen.
                    val last = settings
                    instrumentation.runOnMainSync { last.onBackPressedDispatcher.onBackPressed() }
                    notes.await("Settings closed") { last.isDestroyed }
                    assertEquals(Lifecycle.State.RESUMED, login.state)
                } finally {
                    notes.finishSettings()
                }
            }
            assertEquals("no request", 0, notes.requests.get())
            assertEquals("no Notes run", 0, notes.runs.get())
            notes.probe.assertNoneOnMain()
        } finally {
            instrumentation.removeMonitor(monitor)
            LoginActivity.controllerFactory = null
            notes.restore(a, b, c)
            LoginFlowOwnerRegistry.resetForTests()
            SignupContinuationRegistry.resetForTests()
            SetupSecretHolder.resetForTests()
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * The Settings hub row and the screen for a present account's store, with no session, while notes-pending cannot
     * be listed: the store is still found by its path. Its discard deletes the files but cannot show the folder gone,
     * so it is not finished: Retry is offered and stays not finished, and the store's row opens nothing meanwhile; a
     * check of the removal section shows its own Snackbar, after which the Retry shows again.
     * Once the screen is left, the row still says the discard did not finish, from the store's state, and is the
     * Retry; once the folder above lists, the store counts nothing, the row and the hub row stay, and the row's Retry
     * finishes under the same permit, and the account's store takes saves again in a new instance.
     */
    @Test
    fun unsyncedNotesOfAPresentAccountStayReachableWhenTheStoreFolderCannotBeListed() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = AccountManager.get(context)
        val notes = UnsyncedNotesOnDevice(context)
        val account = Account("settings-unsynced-${System.nanoTime()}@example.invalid", App.accountType)
        val generation = "unsynced-${UUID.randomUUID()}"
        val folder =
            PendingNotesStore.identityDir(context.noBackupFilesDir, account.type, account.name, generation).name
        notes.assertClean(folder)
        val row = UnsyncedNotesFragment.rowKey(folder)
        val two = context.resources.getQuantityString(R.plurals.notes_store_unsynced, 2, 2)
        val stopped = UnsyncedNotesOnDevice.Row(row, account.name,
            context.getString(R.string.notes_discard_not_finished), enabled = false)
        val retryRow = UnsyncedNotesOnDevice.Row(row, account.name,
            context.getString(R.string.notes_discard_not_finished_row))
        val others = UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.KEY_OTHERS,
            context.getString(R.string.notes_stores_others_unlisted), null, enabled = false)
        val uncounted = context.getString(R.string.settings_unsynced_notes_uncounted)
        var added = false
        try {
            notes.isolate()
            check(manager.addAccountExplicitly(account, null, null))
            added = true
            // No adapter sync may start for it: a task sync would build a client.
            notes.silence(account)
            AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
            check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
            val store = PendingNotesStore.forIdentity(context, account.type, account.name, generation)
            notes.save(store, "n1", "n2")
            PendingNotesStore.resetForTesting()

            ActivityScenario.launch<AppSettingsActivity>(AppSettingsActivity.newIntent(context)).use { scenario ->
                // 1. The hub row counts both.
                notes.awaitHubSummary(context.resources.getQuantityString(R.plurals.settings_unsynced_notes_summary,
                    2, 2))
                // 2. With notes-pending unlistable, the hub says that not all of them could be counted.
                notes.probe.listing = { d -> if (d.name == "notes-pending") null else d.listFiles() }
                scenario.moveToState(Lifecycle.State.STARTED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                notes.awaitHubSummary(context.getString(R.string.settings_unsynced_notes_uncounted))

                // 3. The screen: the account's store by its name, found by its path, and the others row, no action.
                scenario.onActivity { activity ->
                    val home = activity.supportFragmentManager.findFragmentById(android.R.id.content)
                        as AppSettingsActivity.HomeFragment
                    home.findPreference<Preference>(AppSettingsActivity.HomeFragment.UNSYNCED_NOTES_KEY)!!
                        .performClick()
                }
                val settings = notes.resumedSettings(null)
                notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(row, account.name, two), others))

                // 4. Discard: every file goes, but the folder cannot be shown gone, so the discard is not finished.
                notes.tapRow(settings, folder)
                notes.tap(settings, Step.DISCARD, folder, DialogInterface.BUTTON_POSITIVE)
                val first = notes.awaitRetryBar(settings, null)
                assertTrue("the permit was on disk at the first removal: ${notes.atFirstRemoval(folder)}",
                    "$folder.permit" in notes.atFirstRemoval(folder).orEmpty())
                // The store now cannot be read, but its row says the discard did not finish and opens nothing, also
                // when tapped: only Retry goes on, never an acknowledgement after "may already be deleted".
                notes.awaitRows(settings, listOf(stopped, others))
                notes.tapRow(settings, folder)
                notes.awaitNoDialog(settings)
                val (runs, held) = notes.confirmationOf(settings)
                assertTrue("still not finished: $runs, $held",
                    !runs && held is UnsyncedNotesDiscardPolicy.Result.NotFinished)
                assertSame("the same Retry still shows", first, notes.awaitRetryBar(settings, null))

                // 5. Retry while notes-pending still cannot be listed: not finished again, and nothing else changes.
                notes.tapRetry(settings)
                val second = notes.awaitRetryBar(settings, first)
                assertTrue("$folder.permit" in notes.permits())
                notes.awaitRows(settings, listOf(stopped, others))

                // 5b. A check of the removal section shows its own Snackbar in the Retry's place; once that goes, the
                // Retry shows again, as it is the discard's only one on this screen. The check runs through the
                // screen's model, as a row's tap does: the guard allows this account now that its files went, so the
                // section has no row for it.
                notes.checkRemoval(settings, account.type, account.name)
                notes.awaitSnackbar(settings, context.getString(R.string.notes_removal_allowed, account.name))
                notes.awaitRetryBar(settings, second)
                assertTrue("still not finished: ${notes.confirmationOf(settings)}",
                    notes.confirmationOf(settings).second is UnsyncedNotesDiscardPolicy.Result.NotFinished)
                notes.awaitRows(settings, listOf(stopped, others))

                // 6. Leaving the screen takes its result and the bar away, yet the store's state keeps the row: it says
                // the discard did not finish and is the Retry. Tapped while notes-pending still cannot be listed, it is
                // not finished again, and is never an acknowledgement.
                notes.leaveAndReopen(settings, uncounted)
                notes.awaitRows(settings, listOf(retryRow, others))
                assertEquals("a new screen holds no result", false to null, notes.confirmationOf(settings))
                notes.tapRow(settings, folder)
                notes.awaitRetryBar(settings, null)
                notes.awaitNoDialog(settings)
                assertEquals(false to UnsyncedNotesDiscardPolicy.Result.NotFinished(folder, account.name,
                    UnsyncedNotes.NOTHING), notes.confirmationOf(settings))
                notes.awaitRows(settings, listOf(stopped, others))
                assertTrue("$folder.permit" in notes.permits())

                // 7. Once notes-pending lists, the closed instance counts nothing, yet the row and the hub row stay
                // once the screen is left again, and the row's Retry finishes under the same permit.
                notes.probe.listing = null
                assertFalse("the folder itself went", folder in notes.stores())
                assertTrue("$folder.permit" in notes.permits())
                val closed = PendingNotesStore.forIdentity(context, account.type, account.name, generation)
                assertEquals(UnsyncedNotes.NOTHING, closed.unsynced())
                assertTrue(closed.clearStopped())
                notes.leaveAndReopen(settings, uncounted)
                notes.awaitRows(settings, listOf(retryRow))
                notes.tapRow(settings, folder)
                notes.awaitSnackbar(settings, context.getString(R.string.notes_discard_done))
                assertFalse("$folder.permit" in notes.permits())
                notes.awaitRows(settings, listOf(UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.KEY_NONE,
                    context.getString(R.string.notes_stores_none), null, enabled = false)))
                val next = PendingNotesStore.forIdentity(context, account.type, account.name, generation)
                assertNotSame(closed, next)
                assertTrue(next.saveLocal("n3", "b1", "r1", ByteArray(1), isCreate = false)
                    is PendingNotesStore.SaveOutcome.Saved)
            }
            assertEquals("no request", 0, notes.requests.get())
            assertEquals("no Notes run", 0, notes.runs.get())
            notes.probe.assertNoneOnMain()
        } finally {
            notes.restore(folder)
            if (added) removeAccountAndWait(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * Removals through Android's asking path, as Android settings makes them, so the authenticator answers. A clean
     * account goes. One whose own store holds a draft stays, with its files and the row count, setup recovery would not
     * remove it either, Unsynced Notes lists it, and the refusal notification names nothing of it. Once the draft is
     * discarded as Unsynced Notes does, it goes, and so does the notification.
     */
    @Test
    fun removingAnAccountThroughAndroidIsRefusedWhileItsStoreHoldsADraftAndAllowedOnceTheDraftIsDiscarded() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val notes = UnsyncedNotesOnDevice(context)
        val clean = Account("settings-removal-clean-${System.nanoTime()}@example.invalid", App.accountType)
        val account = Account("settings-removal-${System.nanoTime()}@example.invalid", App.accountType)
        val generation = "removal-${UUID.randomUUID()}"
        val folder =
            PendingNotesStore.identityDir(context.noBackupFilesDir, account.type, account.name, generation).name
        notes.assertClean(folder)
        val added = ArrayList<Account>()
        try {
            notes.isolate()
            allowRefusalNotices(context)
            // 1. A clean account, with a readable id and no store, goes, and nothing is posted.
            added += clean
            addWithId(notes, manager, clean, "removal-clean-${UUID.randomUUID()}")
            val before = AccountRowChanges.mainType.count()
            assertTrue(removeThroughAndroid(manager, clean))
            assertFalse(clean in manager.getAccountsByType(App.accountType))
            assertTrue("the answer moved the row count", AccountRowChanges.mainType.count() > before)
            assertNull(refusalNotice(context))

            // 2. A draft in the account's own store: refused, and nothing changes.
            added += account
            addWithId(notes, manager, account, generation)
            notes.save(PendingNotesStore.forIdentity(context, account.type, account.name, generation), "n1")
            PendingNotesStore.resetForTesting()
            val files = notes.filesOf(folder)
            val rows = AccountRowChanges.mainType.count()
            assertFalse("setup recovery would not remove it", recoveryAllows(context, account))
            assertFalse(removeThroughAndroid(manager, account))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertEquals("a refusal moves no row count", rows, AccountRowChanges.mainType.count())
            notes.assertFiles("after the refusal", folder, files)
            assertRefusalNotice(context, R.string.notes_removal_refused_store, account)
            assertEquals(listOf(NotesRemovalSection.Row(account.type, account.name, NotesRemovalNotice.Kind.STORE)),
                NotesRemovalSection.read(context).rows)

            // 3. Discarded as Unsynced Notes does, it goes, and the notification with it.
            val shown = PendingNotesStore.forIdentity(context, account.type, account.name, generation).unsynced()
            assertSame(UnsyncedNotesDiscardPolicy.Result.Done,
                UnsyncedNotesStores.discard(context, folder, account.name, shown, retry = false))
            // Setup recovery's yes holds the store's saves back until its removal reports; nothing is written.
            val recovery = PendingNotesStore.RemovalHold()
            try {
                assertTrue(GuardedRecoveryRemoval.allowsOnDevice(context, account, recovery))
                assertSame(PendingNotesStore.SaveOutcome.RemovalPending, PendingNotesStore.forIdentity(context,
                    account.type, account.name, generation).saveLocal("n3", "b1", "r1", "early".toByteArray(),
                    isCreate = true))
            } finally {
                recovery.release()
            }
            assertTrue(removeThroughAndroid(manager, account))
            assertFalse(account in manager.getAccountsByType(App.accountType))
            // The yes held the store's saves back, in this process, so none could land before the row went.
            assertSame(PendingNotesStore.SaveOutcome.RemovalPending, PendingNotesStore.forIdentity(context,
                account.type, account.name, generation).saveLocal("n2", "b1", "r1", "late".toByteArray(),
                isCreate = true))
            awaitNoRefusalNotice(context)
            assertEquals(NotesRemovalSection.Section(emptyList(), accountsUnread = false),
                NotesRemovalSection.read(context))
            assertEquals("no request", 0, notes.requests.get())
            assertEquals("no Notes run", 0, notes.runs.get())
            notes.probe.assertNoneOnMain()
        } finally {
            notes.restore(folder)
            for (left in added) {
                if (left in manager.getAccountsByType(App.accountType)) removeAccountAndWait(manager, left)
            }
            NotesRemovalNotice.clear(context)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * A store that cannot be listed: a removal through Android is refused while nothing acknowledges it, and once the
     * user acknowledges the store as Unsynced Notes does, the account goes. The acknowledgement deletes nothing: the
     * store's files stay as they were.
     */
    @Test
    fun removingAnAccountThroughAndroidWhoseStoreCannotBeListedIsRefusedUntilTheStoreIsAcknowledged() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val notes = UnsyncedNotesOnDevice(context)
        val account = Account("settings-removal-unlisted-${System.nanoTime()}@example.invalid", App.accountType)
        val generation = "removal-${UUID.randomUUID()}"
        val folder =
            PendingNotesStore.identityDir(context.noBackupFilesDir, account.type, account.name, generation).name
        notes.assertClean(folder)
        var added = false
        try {
            notes.isolate()
            allowRefusalNotices(context)
            added = true
            addWithId(notes, manager, account, generation)
            notes.save(PendingNotesStore.forIdentity(context, account.type, account.name, generation), "n1")
            PendingNotesStore.resetForTesting()
            val files = notes.filesOf(folder)
            notes.probe.listing = { d -> if (d.name == folder) null else d.listFiles() }

            // 1. Refused, and Unsynced Notes lists it.
            assertFalse(removeThroughAndroid(manager, account))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertRefusalNotice(context, R.string.notes_removal_refused_store, account)
            assertEquals(listOf(NotesRemovalSection.Row(account.type, account.name, NotesRemovalNotice.Kind.STORE)),
                NotesRemovalSection.read(context).rows)

            // 2. Acknowledged as Unsynced Notes does, it goes, and the store's files stay.
            val shown = PendingNotesStore.forIdentity(context, account.type, account.name, generation).unsynced()
            assertEquals(Step.ACKNOWLEDGE, UnsyncedNotesDiscardPolicy.step(shown))
            assertSame(UnsyncedNotesDiscardPolicy.Result.Acknowledged,
                UnsyncedNotesStores.discard(context, folder, account.name, shown, retry = false))
            assertTrue(removeThroughAndroid(manager, account))
            assertFalse(account in manager.getAccountsByType(App.accountType))
            awaitNoRefusalNotice(context)
            notes.assertFiles("the acknowledgement deleted nothing", folder, files)
            assertEquals("no request", 0, notes.requests.get())
            assertEquals("no Notes run", 0, notes.runs.get())
            notes.probe.assertNoneOnMain()
        } finally {
            notes.restore(folder)
            if (added && account in manager.getAccountsByType(App.accountType)) removeAccountAndWait(manager, account)
            NotesRemovalNotice.clear(context)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * A row with no creation id while notes-pending cannot be listed: Android's removal is refused until the
     * confirmation's tap, which removes it through the same answer, once. The same name added again is refused, and a
     * row replaced between the tap and Android's answer stays.
     */
    @Test
    fun theConfirmationRemovesAnIdLessRowUnderAnUnreadableNotesPendingOnceAndASameNameReAddIsRefused() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val notes = UnsyncedNotesOnDevice(context)
        val account = Account("settings-removal-idless-${System.nanoTime()}@example.invalid", App.accountType)
        notes.assertClean()
        try {
            notes.isolate()
            allowRefusalNotices(context)
            addIdLess(context, notes, manager, account)

            // 1. Without a confirmation, refused: the notification says only the confirmation lets it through.
            assertFalse(removeThroughAndroid(manager, account))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertRefusalNotice(context, R.string.notes_removal_refused_confirm, account)
            assertEquals(listOf(NotesRemovalSection.Row(account.type, account.name, NotesRemovalNotice.Kind.CONFIRM)),
                NotesRemovalSection.read(context).rows)

            // 2. The confirmation's tap removes it, through the authenticator's answer.
            val offer = NotesRemovalOffer.onDevice(context)
            val shown = checkNotNull(offer.show(account.type, account.name)) { "no confirmation was offered" }
            assertEquals(setOf(PendingNotesRemovalGuard.Cause.PENDING_UNLISTED), shown.reason)
            assertEquals(NotesRemovalOffer.Outcome.REMOVED, confirmed(offer, account, shown.id))
            assertFalse(account in manager.getAccountsByType(App.accountType))
            awaitNoRefusalNotice(context)

            // 3. Once: the same name added again is refused.
            check(manager.addAccountExplicitly(account, null, null))
            notes.silence(account)
            assertFalse(removeThroughAndroid(manager, account))
            assertTrue(account in manager.getAccountsByType(App.accountType))

            // 4. A row replaced between the tap and Android's answer stays: the row count moved in between. Asked
            // without the confirmation's screen, the refusal posts the notification.
            NotesRemovalNotice.clear(context)
            awaitNoRefusalNotice(context)
            val again = checkNotNull(offer.show(account.type, account.name)) { "no second confirmation" }
            NotesRemovalOffer.afterMintForTesting = {
                removeAccountAndWait(manager, account)
                check(manager.addAccountExplicitly(account, null, null))
            }
            assertEquals(NotesRemovalOffer.Outcome.RETRY, confirmed(offer, account, again.id))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertRefusalNotice(context, R.string.notes_removal_refused_confirm, account)

            // 5. While a removal the confirmation asked for is under way, a refusal of that row, here one through
            // Android settings, waits for its outcome: no notification, and the mark has the refusal's words to post
            // if the user has left the screen when the outcome comes, if the outcome can't say whether the account
            // was removed, or if the screen goes first.
            NotesRemovalNotice.clear(context)
            awaitNoRefusalNotice(context)
            val marked = NotesRemovalAnswer.askInApp(account.type, account.name)
            var withheld: NotesRemovalNotice.Kind? = null
            try {
                assertFalse(removeThroughAndroid(manager, account))
                assertNull(refusalNotice(context))
            } finally {
                withheld = marked.left()
            }
            assertEquals(NotesRemovalNotice.Kind.CONFIRM, withheld)
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertEquals("no request", 0, notes.requests.get())
            notes.probe.assertNoneOnMain()
        } finally {
            NotesRemovalOffer.afterMintForTesting = null
            NotesRemovalAllowance.process.resetForTesting()
            notes.restore()
            if (account in manager.getAccountsByType(App.accountType)) removeAccountAndWait(manager, account)
            NotesRemovalNotice.clear(context)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * Unsynced Notes lists an account Android settings cannot remove now, and the row's tap checks again and opens the
     * confirmation. Restored as in a new app process, the confirmation says the same, and its "Remove account" checks
     * again and offers a new confirmation, never a removal. That one's tap removes the account, and the section goes.
     */
    @Test
    fun unsyncedNotesListsAnAccountAndroidCannotRemoveAndAConfirmationRestoredInAnotherProcessAsksAgain() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val notes = UnsyncedNotesOnDevice(context)
        val account = Account("settings-removal-section-${System.nanoTime()}@example.invalid", App.accountType)
        val row = UnsyncedNotesOnDevice.Row(UnsyncedNotesFragment.removalKey(account.name), account.name,
            context.getString(R.string.notes_removal_section_confirm))
        val title = context.getString(R.string.notes_remove_uncheckable_title, account.name)
        notes.assertClean()
        try {
            notes.isolate()
            addIdLess(context, notes, manager, account)
            ActivityScenario.launch<AppSettingsActivity>(AppSettingsActivity.newUnsyncedNotesIntent(context)).use {
                // 1. The section lists the account, and its tap opens the confirmation.
                val settings = notes.resumedSettings(null)
                notes.awaitSection(settings, listOf(row))
                notes.tapSectionRow(settings, account.name)
                notes.awaitRemovalDialog(settings, title) { ProcessIncarnation.isCurrent(it) }

                // 2. Restored as in another process: the same words, and its button offers a new confirmation.
                val restored = notes.removalRestoredFromAnotherProcess(settings)
                val old = notes.awaitRemovalDialog(restored, title) { it == ANOTHER_PROCESS }
                notes.tapRemovalDialog(old)
                val next = notes.awaitRemovalDialog(restored, title) { ProcessIncarnation.isCurrent(it) }
                assertNotSame(old, next)
                assertTrue("no removal yet", account in manager.getAccountsByType(App.accountType))

                // 3. Its tap removes the account, and the section goes.
                notes.tapRemovalDialog(next)
                notes.awaitSnackbar(restored, context.getString(
                    NotesRemovalOffer.message(NotesRemovalOffer.Outcome.REMOVED), account.name))
                notes.await("the account removed") { account !in manager.getAccountsByType(App.accountType) }
                notes.awaitSection(restored, null)
            }
            assertEquals("no request", 0, notes.requests.get())
            assertEquals("no Notes run", 0, notes.runs.get())
            notes.probe.assertNoneOnMain()
        } finally {
            notes.finishSettings()
            NotesRemovalAllowance.process.resetForTesting()
            notes.restore()
            if (account in manager.getAccountsByType(App.accountType)) removeAccountAndWait(manager, account)
            NotesRemovalNotice.clear(context)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /**
     * The confirmation's fingerprint on this device: Os.stat of notes-pending follows a link, and Os.lstat of each name
     * of an unknown kind does not, works on a dangling link, and gives the errno for a name that is gone. A link of the
     * same name to another folder gives another fingerprint.
     */
    @Test
    fun theRemovalFingerprintStatsTheFolderThroughALinkAndLstatsEachNameOfAnUnknownKindItself() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = File(context.cacheDir, "fingerprint-${UUID.randomUUID()}")
        val links = ArrayList<File>()
        try {
            val noBackup = File(root, "no_backup")
            val pending = File(noBackup, PendingNotesStore.PENDING)
            val target = File(root, "target")
            val other = File(root, "other")
            check(pending.mkdirs() && target.mkdirs() && other.mkdirs())
            check(File(pending, "zz-folder").mkdir())
            val link = File(pending, "zz-link").also { links += it }
            Os.symlink(target.path, link.path)
            val dangling = File(pending, "zz-dangling").also { links += it }
            Os.symlink(File(root, "missing").path, dangling.path)
            val names = listOf("zz-dangling", "zz-folder", "zz-gone", "zz-link")
            val decision = PendingNotesRemovalGuard.Decision(PendingNotesRemovalGuard.Verdict.UNKNOWN_KIND_ONLY, null,
                names)

            val first = NotesRemovalOffer.fingerprintIn(noBackup, decision)
            val folder = first.stats[Folder.PENDING] as NotesRemovalAllowance.FolderStat.Stat
            assertTrue(OsConstants.S_ISDIR(folder.mode))
            assertEquals(Os.stat(pending.path).st_ino, folder.inode)
            assertEquals(names, first.names)
            fun entry(fingerprint: NotesRemovalAllowance.Fingerprint, name: String) =
                fingerprint.entries[name] as? NotesRemovalAllowance.FolderStat.Stat
                    ?: throw AssertionError("$name: ${fingerprint.entries[name]}")
            assertTrue(OsConstants.S_ISLNK(entry(first, "zz-link").mode))
            assertEquals(Os.lstat(link.path).st_ino, entry(first, "zz-link").inode)
            assertNotEquals(Os.stat(target.path).st_ino, entry(first, "zz-link").inode)
            assertTrue(OsConstants.S_ISLNK(entry(first, "zz-dangling").mode))
            assertTrue(OsConstants.S_ISDIR(entry(first, "zz-folder").mode))
            assertEquals(NotesRemovalAllowance.FolderStat.Failed(OsConstants.ENOENT), first.entries["zz-gone"])

            // A link of the same name to another folder, made before the old one goes, so it has another inode.
            val swap = File(pending, "zz-swap").also { links += it }
            Os.symlink(other.path, swap.path)
            Os.rename(swap.path, link.path)
            val second = NotesRemovalOffer.fingerprintIn(noBackup, decision)
            assertNotEquals(entry(first, "zz-link").inode, entry(second, "zz-link").inode)
            assertNotEquals(first, second)

            // notes-pending itself a link: stat follows it to the folder.
            val linkedNoBackup = File(root, "linked")
            val real = File(root, "real")
            check(linkedNoBackup.mkdirs() && real.mkdirs())
            val pendingLink = File(linkedNoBackup, PendingNotesStore.PENDING).also { links += it }
            Os.symlink(real.path, pendingLink.path)
            val linked = NotesRemovalOffer.fingerprintIn(linkedNoBackup,
                PendingNotesRemovalGuard.Decision(PendingNotesRemovalGuard.Verdict.ROOT_UNLISTABLE_ONLY, null))
            val followed = linked.stats[Folder.PENDING] as NotesRemovalAllowance.FolderStat.Stat
            assertTrue(OsConstants.S_ISDIR(followed.mode))
            assertEquals(Os.stat(real.path).st_ino, followed.inode)
        } finally {
            // Links first: deleteRecursively follows them.
            for (link in links) runCatching { Os.remove(link.path) }
            root.deleteRecursively()
        }
    }

    /** A row with a readable creation id and no adapter sync, as the Unsynced Notes cases add one. */
    private fun addWithId(notes: UnsyncedNotesOnDevice, manager: AccountManager, account: Account, generation: String) {
        check(manager.addAccountExplicitly(account, null, null))
        notes.silence(account)
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, generation))
    }

    /**
     * A row with no creation id while notes-pending is there and cannot be listed: the guard's one eligible case for a
     * row that nothing else names. notes-pending is made before anything is shown, since that changes no_backup.
     */
    private fun addIdLess(context: Context, notes: UnsyncedNotesOnDevice, manager: AccountManager, account: Account) {
        ActiveAccountManager.clearActiveAccount(context)
        File(context.noBackupFilesDir, PendingNotesStore.PENDING).mkdirs()
        check(manager.addAccountExplicitly(account, null, null))
        notes.silence(account)
        notes.probe.listing = { d -> if (d.name == PendingNotesStore.PENDING) null else d.listFiles() }
        PendingNotesStore.resetForTesting()
    }

    /** Setup recovery's question, with its hold released at once, since the removal here goes through Android. */
    private fun recoveryAllows(context: Context, account: Account): Boolean {
        val hold = PendingNotesStore.RemovalHold()
        return try {
            GuardedRecoveryRemoval.allowsOnDevice(context, account, hold)
        } finally {
            hold.release()
        }
    }

    /**
     * A removal through Android's asking path, so the authenticator answers, as for Android settings; cleanups go
     * through AndroidCompat, which the authenticator never sees. Off the main thread only.
     */
    private fun removeThroughAndroid(manager: AccountManager, account: Account): Boolean =
        manager.removeAccount(account, null, null, null).getResult(20, TimeUnit.SECONDS)
            .getBoolean(AccountManager.KEY_BOOLEAN_RESULT)

    /** The confirmation [id]'s tap, and what it came to. */
    private fun confirmed(offer: NotesRemovalOffer, account: Account, id: String): NotesRemovalOffer.Outcome {
        val outcomes = LinkedBlockingQueue<NotesRemovalOffer.Outcome>()
        offer.confirm(account.type, account.name, id) { outcomes.put(it) }
        return outcomes.poll(20, TimeUnit.SECONDS) ?: throw AssertionError("the confirmation came to nothing")
    }

    /** The notification permission granted where it is a runtime one, and no refusal notification left. */
    private fun allowRefusalNotices(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = InstrumentationRegistry.getInstrumentation().uiAutomation
                .executeShellCommand("pm grant ${context.packageName} ${Manifest.permission.POST_NOTIFICATIONS}")
            ParcelFileDescriptor.AutoCloseInputStream(granted).use { it.readBytes() }
        }
        assertTrue("notifications are allowed", NotificationManagerCompat.from(context).areNotificationsEnabled())
        NotesRemovalNotice.clear(context)
        awaitNoRefusalNotice(context)
    }

    private fun refusalNotice(context: Context): StatusBarNotification? =
        context.getSystemService(NotificationManager::class.java).activeNotifications
            .singleOrNull { it.id == Constants.NOTIFICATION_NOTES_REMOVAL_REFUSED }

    /** The refusal notification, once it is posted, for at most 5 s. */
    private fun awaitRefusalNotice(context: Context): StatusBarNotification {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (true) {
            refusalNotice(context)?.let { return it }
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("no refusal notification")
            SystemClock.sleep(50)
        }
    }

    private fun awaitNoRefusalNotice(context: Context) {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (refusalNotice(context) != null) {
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("the refusal notification stayed")
            SystemClock.sleep(50)
        }
    }

    /**
     * The refusal notification says [text] and nothing of [account], with one text for the lock screen too, and its tap
     * opens the app.
     */
    private fun assertRefusalNotice(context: Context, @StringRes text: Int, account: Account) {
        val posted = awaitRefusalNotice(context).notification
        assertEquals(NotificationUtils.CHANNEL_GENERAL, posted.channelId)
        assertEquals(Notification.VISIBILITY_PUBLIC, posted.visibility)
        assertNull("no other text for the lock screen", posted.publicVersion)
        assertTrue("it goes once tapped", posted.flags and Notification.FLAG_AUTO_CANCEL != 0)
        assertEquals(context.packageName, posted.contentIntent?.creatorPackage)
        assertEquals(context.getString(R.string.notes_removal_refused_title),
            posted.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals(context.getString(text), posted.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        @Suppress("DEPRECATION")
        val said = posted.extras.keySet().mapNotNull { posted.extras.get(it)?.toString() }
        assertTrue("$said", said.none { it.contains(account.name) })
    }

    private fun schedulingEvidence(
        context: Context,
        manager: AccountManager,
        account: Account,
        store: io.silentsuite.sync.syncadapter.SyncStatusStore
    ): List<Any?> = listOf(
        context.getSharedPreferences("sync_status_v1", Context.MODE_PRIVATE).all.toMap(),
        manager.getAccountsByType(account.type).firstOrNull { it == account }
            ?.let { manager.getUserData(it, AccountSettings.KEY_CREATION_ID) },
        io.silentsuite.sync.syncadapter.SyncStatusStore.Service.values().map { store.status(account, it) },
        listOf(android.provider.CalendarContract.AUTHORITY, App.addressBooksAuthority).map {
            android.content.ContentResolver.getSyncAutomatically(account, it) to
                android.content.ContentResolver.getIsSyncable(account, it)
        }
    )

    /** Native always-syncable initialization must finish before a read-only comparison. */
    private fun settledSchedulingEvidence(account: Account, read: () -> List<Any?>): List<Any?> {
        val authorities = listOf(android.provider.CalendarContract.AUTHORITY, App.addressBooksAuthority)
        var previous = read()
        repeat(20) {
            Thread.sleep(250)
            val initialized = authorities.all { android.content.ContentResolver.getIsSyncable(account, it) >= 0 }
            val current = read()
            if (initialized && current == previous) return current
            previous = current
        }
        throw AssertionError("Scheduling fixture initialization or bookkeeping did not settle")
    }

    private fun assertSchedulingReportIsContentFree(report: String, vararg markers: String) {
        assertTrue(report.startsWith("--- BEGIN SCHEDULING DIAGNOSTICS ---\n"))
        assertTrue(report.endsWith("--- END SCHEDULING DIAGNOSTICS ---\n"))
        (markers.toList() + listOf(
            "scheduling-marker", "example.invalid", "@", "Exception", "DEBUG INFO",
            "SOFTWARE INFORMATION", "SYSTEM INFORMATION", "Android version", "Device:", "permission:"
        )).forEach { assertFalse(it, report.contains(it)) }
        // Build.UNKNOWN ("unknown") is the platform placeholder for an unset field, e.g. MANUFACTURER on the
        // API 21 emulator. It identifies nothing and is also one of the report's fixed category values.
        listOf(android.os.Build.MODEL, android.os.Build.DEVICE, android.os.Build.DISPLAY, android.os.Build.MANUFACTURER)
            .filter { it.length >= 4 && !it.equals(android.os.Build.UNKNOWN, ignoreCase = true) }
            .forEach { assertFalse(it, report.contains(it, ignoreCase = true)) }
        assertFalse(Regex("[0-9]{5,}").containsMatchIn(report))
        assertFalse(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-").containsMatchIn(report))
        val line = Regex("[A-Za-z0-9 #:=_.,;()/-]*")
        report.lines().forEach { assertTrue(it.length <= 160 && line.matches(it)) }
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

/**
 * What the Unsynced Notes cases of [SettingsRuntimeTest] share: the app's own no_backup folder, the store and Notes job
 * seams, set by [isolate] and reset by [restore], and the screen, read and tapped on the main thread. Files are
 * checked by listing, never with File.exists(). The store seams are the [probe]'s, and only record: they run on the IO
 * thread inside a store call, which rethrows anything, so an assertion there would end the app process.
 */
private class UnsyncedNotesOnDevice(private val context: Context) {
    data class Row(val key: String, val title: String?, val summary: String?, val enabled: Boolean = true)

    data class Texts(val title: String?, val message: String?, val positive: String?, val negative: String?) {
        val all: List<String> get() = listOfNotNull(title, message, positive, negative)
    }

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val noBackup = context.noBackupFilesDir
    private val pending = File(noBackup, "notes-pending")
    private val discards = File(noBackup, PendingNotesDiscardPermits.ROOT)
    private val authorities =
        TaskProvider.TASK_PROVIDERS.map { it.authority } + listOf(CalendarContract.AUTHORITY, App.addressBooksAuthority)
    private val retryBar = UnsyncedNotesFragment::class.java.getDeclaredField("retryBar").apply { isAccessible = true }
    private var previousMasterSync = true

    /** Requests any client of the app made, each refused; and Notes runs, each replaced by nothing. */
    val requests = AtomicInteger()
    val runs = AtomicInteger()

    /**
     * Every store listing and removal, and which ran on the main thread. A case that needs a listing to fail sets it
     * here ([MainThreadStoreProbe.listing]), never on the store, and ends with [MainThreadStoreProbe.assertNoneOnMain].
     */
    val probe = MainThreadStoreProbe()

    /** What notes-discard listed at the first removal of a file in each store folder, by folder. */
    private val firstRemovals = HashMap<String, Set<String>?>()

    /** A store folder of an account that is gone, by a name no other run uses. */
    fun orphanFolder(): String {
        val id = UUID.randomUUID().toString()
        return PendingNotesStore.identityDir(noBackup, App.accountType, "gone-$id", id).name
    }

    /**
     * Fails, naming what it found, while any store or unknown name is in notes-pending, any record of [folders] is in
     * notes-discard, or any account of the app is present. Other records in notes-discard are left from other classes.
     */
    fun assertClean(vararg folders: String) {
        val found = PendingNotesStore.storeDirectories(context)
        assertTrue("stores left on this device: ${found.stores}, a name of another kind: ${found.unknown}",
            found.stores.isEmpty() && !found.unknown)
        val records = permits().filter { name -> folders.any { name == "$it.permit" || name == "$it.acknowledgement" } }
        assertTrue("records left for this case's stores: $records", records.isEmpty())
        val accounts = AccountManager.get(context).getAccountsByType(App.accountType).map { it.name }
        assertTrue("accounts left on this device: $accounts", accounts.isEmpty())
    }

    /**
     * The startup sweep of this process over, master sync off, every request refused and counted, every Notes run
     * counted, the [probe] installed, and the first removals noted.
     */
    fun isolate() {
        runBlocking { NotesStartupSweep.startup?.join() }
        previousMasterSync = ContentResolver.getMasterSyncAutomatically()
        ContentResolver.setMasterSyncAutomatically(false)
        HttpClient.testInterceptor = object : okhttp3.Interceptor {
            override fun intercept(chain: okhttp3.Interceptor.Chain): okhttp3.Response {
                requests.incrementAndGet()
                throw IOException("the Unsynced Notes cases make no request")
            }
        }
        NotesSyncCoordinator.runnerOverride = { _, _, _, _ -> runs.incrementAndGet() }
        probe.removal = { file ->
            val folder = file.parentFile?.name
            if (folder != null) synchronized(firstRemovals) {
                if (folder !in firstRemovals) firstRemovals[folder] = discards.list()?.toSet()
            }
        }
        probe.install()
    }

    /** No adapter sync is scheduled or started for [account]. */
    fun silence(account: Account) {
        for (authority in authorities) ContentResolver.setIsSyncable(account, authority, 0)
    }

    fun save(store: PendingNotesStore, vararg uids: String) {
        for (uid in uids) {
            val saved = store.saveLocal(uid, "b1", "r1", ByteArray(8) { it.toByte() }, isCreate = false,
                notebookCopy = ByteArray(4))
            check(saved is PendingNotesStore.SaveOutcome.Saved) { "$uid: $saved" }
        }
    }

    fun atFirstRemoval(folder: String): Set<String>? = synchronized(firstRemovals) { firstRemovals[folder] }

    /** The names in [dir], from listings that must work: of [dir], or of the folder above when it shows [dir] gone. */
    private fun namesIn(dir: File): Set<String> {
        val above = dir.parentFile!!.list() ?: throw AssertionError("${dir.parentFile!!.name} could not be listed")
        if (dir.name !in above) return emptySet()
        return (dir.list() ?: throw AssertionError("${dir.name} could not be listed")).toSet()
    }

    fun stores() = namesIn(pending)

    fun permits() = namesIn(discards)

    /** The store folder [folder] in notes-pending. */
    fun storeDir(folder: String) = File(pending, folder)

    /** Every file of the store in [folder], by name, read without the store. */
    fun filesOf(folder: String): Map<String, ByteArray> = filesIn(storeDir(folder))

    /** Every file in [dir], by name, read without the store. */
    fun filesIn(dir: File): Map<String, ByteArray> {
        val names = dir.list() ?: throw AssertionError("${dir.name} could not be listed")
        return names.associateWith { File(dir, it).readBytes() }
    }

    fun assertFiles(what: String, folder: String, expected: Map<String, ByteArray>) =
        assertFilesIn(what, storeDir(folder), expected)

    fun assertFilesIn(what: String, dir: File, expected: Map<String, ByteArray>) {
        val actual = filesIn(dir)
        assertEquals(what, expected.keys, actual.keys)
        for ((name, bytes) in expected) assertArrayEquals("$what: $name", bytes, actual.getValue(name))
    }

    /** [read] on the main thread every 50 ms until it gives a value, for at most 10 s. */
    fun <T : Any> awaitValue(what: String, read: () -> T?): T {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (true) {
            var value: T? = null
            instrumentation.runOnMainSync {
                value = try {
                    read()
                } catch (e: RuntimeException) {
                    null
                }
            }
            value?.let { return it }
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            SystemClock.sleep(50)
        }
    }

    fun await(what: String, condition: () -> Boolean) {
        awaitValue(what) { true.takeIf { condition() } }
    }

    /** The one resumed Settings screen, on the main thread. */
    private fun resumedSettingsNow(): AppSettingsActivity? =
        ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
            .filterIsInstance<AppSettingsActivity>().singleOrNull()

    /** The one resumed Settings screen, once it is not [other]. */
    fun resumedSettings(other: AppSettingsActivity?): AppSettingsActivity =
        awaitValue("a resumed Settings screen") { resumedSettingsNow()?.takeIf { it !== other } }

    /** The Settings hub row reads [text], and shows. */
    fun awaitHubSummary(text: String) = await("the hub row to read \"$text\"") {
        val home = resumedSettingsNow()?.supportFragmentManager?.findFragmentById(android.R.id.content)
            as? AppSettingsActivity.HomeFragment
        val row = home?.findPreference<Preference>(AppSettingsActivity.HomeFragment.UNSYNCED_NOTES_KEY)
        row != null && row.isVisible && row.summary?.toString() == text
    }

    private fun screenOf(settings: AppSettingsActivity): UnsyncedNotesFragment? {
        settings.supportFragmentManager.executePendingTransactions()
        return settings.supportFragmentManager.findFragmentById(android.R.id.content) as? UnsyncedNotesFragment
    }

    private fun rowsOf(settings: AppSettingsActivity): List<Row>? {
        val screen = screenOf(settings)?.preferenceScreen ?: return null
        return (0 until screen.preferenceCount).map { screen.getPreference(it) }
            .filter { it.key != UnsyncedNotesFragment.KEY_REMOVAL }
            .map { Row(it.key, it.title?.toString(), it.summary?.toString(), it.isEnabled) }
    }

    /** The screen shows exactly [expected], in order. */
    fun awaitRows(settings: AppSettingsActivity, expected: List<Row>) {
        var shown: List<Row>? = null
        try {
            awaitValue("rows") { rowsOf(settings).also { shown = it }?.takeIf { it == expected } }
        } catch (e: AssertionError) {
            throw AssertionError("expected the rows $expected, shown $shown")
        }
    }

    fun tapRow(settings: AppSettingsActivity, folder: String) {
        instrumentation.runOnMainSync {
            screenOf(settings)!!.findPreference<Preference>(UnsyncedNotesFragment.rowKey(folder))!!.performClick()
        }
        instrumentation.waitForIdleSync()
    }

    /** The dialog of [step] for the store in [folder], while it shows. */
    fun dialogOf(settings: AppSettingsActivity, step: Step, folder: String): AlertDialog? {
        val screen = screenOf(settings) ?: return null
        screen.childFragmentManager.executePendingTransactions()
        val shown = screen.childFragmentManager.findFragmentByTag(UnsyncedNotesDiscardDialogFragment.tag(step, folder))
        return ((shown as? DialogFragment)?.dialog as? AlertDialog)?.takeIf { it.isShowing }
    }

    /** Whether the dialog of [step] for the store in [folder] shows now, read on the main thread. */
    fun shows(settings: AppSettingsActivity, step: Step, folder: String): Boolean {
        var shown = false
        instrumentation.runOnMainSync { shown = dialogOf(settings, step, folder) != null }
        return shown
    }

    /** What the dialog of [step] for the store in [folder] says, once it shows. */
    fun texts(settings: AppSettingsActivity, step: Step, folder: String): Texts =
        awaitValue("the ${step.name} dialog") {
            dialogOf(settings, step, folder)?.let { dialog ->
                Texts(dialog.findViewById<TextView>(androidx.appcompat.R.id.alertTitle)?.text?.toString(),
                    dialog.findViewById<TextView>(android.R.id.message)?.text?.toString(),
                    dialog.getButton(DialogInterface.BUTTON_POSITIVE)?.text?.toString(),
                    dialog.getButton(DialogInterface.BUTTON_NEGATIVE)?.text?.toString())
            }
        }

    /** Taps [button] of that dialog once it shows. The dialog posts its listener, so this waits for idle. */
    fun tap(settings: AppSettingsActivity, step: Step, folder: String, button: Int) {
        texts(settings, step, folder)
        instrumentation.runOnMainSync { dialogOf(settings, step, folder)!!.getButton(button).performClick() }
        instrumentation.waitForIdleSync()
    }

    /** Back on that dialog once it shows: the dialog's own handling, which cancels it. */
    fun back(settings: AppSettingsActivity, step: Step, folder: String) {
        texts(settings, step, folder)
        instrumentation.runOnMainSync { dialogOf(settings, step, folder)!!.onBackPressed() }
        instrumentation.waitForIdleSync()
    }

    /** The screen shows no dialog, for any store. */
    fun awaitNoDialog(settings: AppSettingsActivity) = await("no dialog") {
        val screen = screenOf(settings)
        screen?.childFragmentManager?.executePendingTransactions()
        screen != null && screen.childFragmentManager.fragments
            .filterIsInstance<UnsyncedNotesDiscardDialogFragment>().none { it.dialog?.isShowing == true }
    }

    /** The dialogs of [step] for the store in [folder] the screen holds, ended ones included; on the main thread. */
    private fun dialogsOf(settings: AppSettingsActivity, step: Step, folder: String):
        List<UnsyncedNotesDiscardDialogFragment> {
        val screen = screenOf(settings) ?: return emptyList()
        screen.childFragmentManager.executePendingTransactions()
        return screen.childFragmentManager.fragments.filterIsInstance<UnsyncedNotesDiscardDialogFragment>()
            .filter { it.tag == UnsyncedNotesDiscardDialogFragment.tag(step, folder) }
    }

    /**
     * What a new app process changes for the open dialog of [step] for the store in [folder]: its token is not this
     * process's ([token]), or it has none (null, a dialog from before the token). The arguments are edited before the
     * screen is created again, so the dialog comes back from them. Gives the token the dialog had, and the new screen.
     * Read and edited on the main thread, and checked here.
     */
    fun restoredFromAnotherProcess(settings: AppSettingsActivity, step: Step, folder: String, token: String?):
        Pair<String?, AppSettingsActivity> {
        var open = 0
        var had: String? = null
        instrumentation.runOnMainSync {
            val dialogs = dialogsOf(settings, step, folder).filter { !it.ended }
            open = dialogs.size
            dialogs.singleOrNull()?.arguments?.let { args ->
                had = args.getString(UnsyncedNotesDiscardDialogFragment.ARG_PROCESS)
                if (token == null) args.remove(UnsyncedNotesDiscardDialogFragment.ARG_PROCESS)
                else args.putString(UnsyncedNotesDiscardDialogFragment.ARG_PROCESS, token)
            }
        }
        assertEquals("one open $step dialog", 1, open)
        instrumentation.runOnMainSync { settings.recreate() }
        return had to resumedSettings(settings)
    }

    /**
     * Waits until the screen holds exactly one dialog of [step] for the store in [folder], ended ones included: one
     * that shows, has not ended, and was made in this process.
     */
    fun awaitOneFromThisProcess(settings: AppSettingsActivity, step: Step, folder: String) =
        await("one $step dialog, made in this process") {
            val dialogs = dialogsOf(settings, step, folder)
            val one = dialogs.singleOrNull()
            one != null && !one.ended && one.dialog?.isShowing == true &&
                one.arguments?.getString(UnsyncedNotesDiscardDialogFragment.ARG_PROCESS) == ProcessIncarnation.current()
        }

    /**
     * Back from the screen to the Settings hub, which clears the screen's view model and the result it holds; then,
     * once the hub row reads [hub], its tap opens the screen again.
     */
    fun leaveAndReopen(settings: AppSettingsActivity, hub: String) {
        instrumentation.runOnMainSync { settings.onBackPressedDispatcher.onBackPressed() }
        await("the screen closed") { screenOf(settings) == null }
        awaitHubSummary(hub)
        var tapped = false
        instrumentation.runOnMainSync {
            val home = settings.supportFragmentManager.findFragmentById(android.R.id.content)
                as? AppSettingsActivity.HomeFragment
            home?.findPreference<Preference>(AppSettingsActivity.HomeFragment.UNSYNCED_NOTES_KEY)?.let {
                it.performClick()
                tapped = true
            }
        }
        assertTrue("the hub row was tapped", tapped)
        await("the screen") { screenOf(settings) != null }
    }

    /**
     * Whether the screen runs a confirmation, and the result it holds, read on the main thread, where a confirmation
     * sets both as it starts. Read right after a tap, so it shows whether that tap started one, before a confirmation
     * on the IO thread could change any file.
     */
    fun confirmationOf(settings: AppSettingsActivity): Pair<Boolean, UnsyncedNotesDiscardPolicy.Result?> {
        var state: Pair<Boolean, UnsyncedNotesDiscardPolicy.Result?>? = null
        instrumentation.runOnMainSync {
            state = screenOf(settings)?.let { screen ->
                val model = ViewModelProvider(screen)[UnsyncedNotesViewModel::class.java]
                model.answering to model.result.value
            }
        }
        return requireNotNull(state) { "no Unsynced Notes screen" }
    }

    fun awaitSnackbar(settings: AppSettingsActivity, text: String) = await("the Snackbar \"$text\"") {
        settings.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)?.text?.toString() == text
    }

    /** The screen's Snackbar with Retry, once it is not [previous]: indefinite, with the words of a discard. */
    fun awaitRetryBar(settings: AppSettingsActivity, previous: Snackbar?): Snackbar = awaitValue("a Retry") {
        val bar = screenOf(settings)?.let { retryBar.get(it) as Snackbar? }
        bar?.takeIf {
            it !== previous && it.isShown && it.duration == Snackbar.LENGTH_INDEFINITE &&
                settings.findViewById<TextView>(com.google.android.material.R.id.snackbar_text)?.text?.toString() ==
                context.getString(R.string.notes_discard_not_finished) &&
                settings.findViewById<TextView>(com.google.android.material.R.id.snackbar_action)?.text?.toString() ==
                context.getString(R.string.retry)
        }
    }

    fun tapRetry(settings: AppSettingsActivity) {
        instrumentation.runOnMainSync {
            settings.findViewById<TextView>(com.google.android.material.R.id.snackbar_action)!!.performClick()
        }
        instrumentation.waitForIdleSync()
    }

    /** The rows of the removal section, or null while it does not show. */
    private fun sectionOf(settings: AppSettingsActivity): List<Row>? {
        val section = screenOf(settings)?.findPreference<PreferenceCategory>(UnsyncedNotesFragment.KEY_REMOVAL)
            ?: return null
        return (0 until section.preferenceCount).map { section.getPreference(it) }
            .map { Row(it.key, it.title?.toString(), it.summary?.toString(), it.isEnabled) }
    }

    /** The removal section shows exactly [expected], in order; null: it does not show. */
    fun awaitSection(settings: AppSettingsActivity, expected: List<Row>?) {
        var shown: List<Row>? = null
        try {
            await("the removal section") { sectionOf(settings).also { shown = it } == expected }
        } catch (e: AssertionError) {
            throw AssertionError("expected the removal section $expected, shown $shown")
        }
    }

    /**
     * The removal section's check of [name], through the screen's model, as a tap on its row or on the button of a
     * confirmation restored in another process runs it ([NotesRemovalViewModel.open]).
     */
    fun checkRemoval(settings: AppSettingsActivity, type: String, name: String) {
        instrumentation.runOnMainSync {
            ViewModelProvider(screenOf(settings)!!)[NotesRemovalViewModel::class.java].open(type, name)
        }
        instrumentation.waitForIdleSync()
    }

    fun tapSectionRow(settings: AppSettingsActivity, name: String) {
        instrumentation.runOnMainSync {
            screenOf(settings)!!.findPreference<Preference>(UnsyncedNotesFragment.removalKey(name))!!.performClick()
        }
        instrumentation.waitForIdleSync()
    }

    /**
     * The one removal confirmation that shows, once it has [title] and the token of the process that made it passes
     * [process].
     */
    fun awaitRemovalDialog(settings: AppSettingsActivity, title: String, process: (String?) -> Boolean):
        NotesRemovalDialogFragment = awaitValue("the removal confirmation \"$title\"") {
        val screen = screenOf(settings)
        screen?.childFragmentManager?.executePendingTransactions()
        screen?.childFragmentManager?.fragments?.filterIsInstance<NotesRemovalDialogFragment>()
            ?.filter { (it.dialog as? AlertDialog)?.isShowing == true }?.singleOrNull()
            ?.takeIf {
                process(it.arguments?.getString(NotesRemovalDialogFragment.ARG_PROCESS)) &&
                    (it.dialog as AlertDialog).findViewById<TextView>(androidx.appcompat.R.id.alertTitle)?.text
                        ?.toString() == title
            }
    }

    /** "Remove account" on [dialog]. The dialog posts its listener, so this waits for idle. */
    fun tapRemovalDialog(dialog: NotesRemovalDialogFragment) {
        instrumentation.runOnMainSync {
            (dialog.dialog as AlertDialog).getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        }
        instrumentation.waitForIdleSync()
    }

    /**
     * The open removal confirmation as Android restores it in a new app process: its token is another process's, set
     * in its arguments before the screen is created again. Gives the new screen.
     */
    fun removalRestoredFromAnotherProcess(settings: AppSettingsActivity): AppSettingsActivity {
        var open = 0
        instrumentation.runOnMainSync {
            val dialogs = screenOf(settings)!!.childFragmentManager.fragments
                .filterIsInstance<NotesRemovalDialogFragment>()
            open = dialogs.size
            dialogs.singleOrNull()?.requireArguments()?.putString(NotesRemovalDialogFragment.ARG_PROCESS,
                ANOTHER_PROCESS)
        }
        assertEquals("one removal confirmation", 1, open)
        instrumentation.runOnMainSync { settings.recreate() }
        return resumedSettings(settings)
    }

    /** Finishes every Settings screen still open, and waits until each is destroyed, at most 5 s. */
    fun finishSettings() {
        val open = ArrayList<AppSettingsActivity>()
        instrumentation.runOnMainSync {
            for (stage in Stage.values()) {
                ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage)
                    .filterIsInstance<AppSettingsActivity>().forEach { open += it }
            }
            open.forEach { it.finish() }
        }
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (open.any { !it.isDestroyed } && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(25)
    }

    /**
     * Resets every seam and master sync, then clears the stores in [folders] (clearAll is for test teardown only),
     * deletes their permits and acknowledgements, and checks by listing that nothing of theirs is left.
     */
    fun restore(vararg folders: String) {
        probe.uninstall()
        HttpClient.testInterceptor = null
        NotesSyncCoordinator.runnerOverride = null
        ContentResolver.setMasterSyncAutomatically(previousMasterSync)
        val problems = ArrayList<Throwable>()
        for (folder in folders) {
            runCatching { PendingNotesStore.forDirectory(context, folder).clearAll() }
                .exceptionOrNull()?.let(problems::add)
            for (record in listOf("$folder.permit", "$folder.acknowledgement")) File(discards, record).delete()
        }
        runCatching {
            val left = stores().filter { it in folders } +
                permits().filter { name -> folders.any { name == "$it.permit" || name == "$it.acknowledgement" } }
            check(left.isEmpty()) { "left behind: $left" }
        }.exceptionOrNull()?.let(problems::add)
        problems.firstOrNull()?.let { throw it }
    }
}
