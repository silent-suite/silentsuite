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
            val before = settledSchedulingEvidence { schedulingEvidence(context, manager, account, store) }
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
                val before = settledSchedulingEvidence(::evidence)
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
                val before = settledSchedulingEvidence(::evidence)
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

    /** Waits out the app's own asynchronous account bookkeeping before a read-only comparison. */
    private fun settledSchedulingEvidence(read: () -> List<Any?>): List<Any?> {
        var previous = read()
        repeat(20) {
            Thread.sleep(250)
            val current = read()
            if (current == previous) return current
            previous = current
        }
        return previous
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
