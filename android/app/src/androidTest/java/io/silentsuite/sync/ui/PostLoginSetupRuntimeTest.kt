package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.resource.LocalAddressBook
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.syncadapter.syncRequestId
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity
import io.silentsuite.sync.ui.setup.PostLoginSyncConfigurator

import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupViewModel
import io.silentsuite.sync.ui.setup.PostLoginStartupChecks
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome
import io.silentsuite.sync.ui.setup.PostLoginSetupMigration
import io.silentsuite.sync.ui.setup.StartupDiagnosticReport
import io.silentsuite.sync.ui.setup.StartupDiagnosticReportDialog
import io.silentsuite.sync.utils.AndroidCompat
import at.bitfire.ical4android.TaskProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.lang.reflect.Modifier

@RunWith(AndroidJUnit4::class)
class PostLoginSetupRuntimeTest {
    @Test fun accountCreatedSyncConfigurationEnablesCoreAuthoritiesWithoutRecovery() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context)
        val account=Account("sync-${System.nanoTime()}@example.invalid",App.accountType); val id="sync-generation"
        val registry=AccountCreationRegistry.open(context)
        check(manager.addAccountExplicitly(account,null,null)); seedAccountCreated(manager, registry, account, id)
        val authorities=listOf(App.addressBooksAuthority, android.provider.CalendarContract.AUTHORITY)+TaskProvider.TASK_PROVIDERS.map { it.authority }
        try {
            authorities.forEach { authority -> ContentResolver.removePeriodicSync(account,authority,Bundle()); ContentResolver.setSyncAutomatically(account,authority,false); ContentResolver.setIsSyncable(account,authority,0) }
            org.junit.Assert.assertTrue(PostLoginSyncConfigurator.configure(context,account))
            listOf(App.addressBooksAuthority,android.provider.CalendarContract.AUTHORITY).forEach { authority ->
                org.junit.Assert.assertTrue(ContentResolver.getIsSyncable(account,authority)>0)
                org.junit.Assert.assertTrue(ContentResolver.getSyncAutomatically(account,authority))
            }
            assertEquals(PostLoginSetupState.ACCOUNT_CREATED,AccountSettings.setupState(manager,account,true))
        } finally { authorities.forEach { authority -> ContentResolver.removePeriodicSync(account,authority,Bundle()); ContentResolver.setSyncAutomatically(account,authority,false); ContentResolver.setIsSyncable(account,authority,0) }; registry.clearOwned(account.type,account.name,id); AndroidCompat.removeAccount(manager,account) }
    }
    @Test fun accountCreatedSyncFailureKeepsExactRowAndOffersContinueRetry() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context)
        val account=Account("sync-failure-${System.nanoTime()}@example.invalid",App.accountType); val id="sync-failure-generation"
        val registry=AccountCreationRegistry.open(context)
        check(manager.addAccountExplicitly(account,null,null)); seedAccountCreated(manager, registry, account, id)
        PostLoginSyncConfigurator.configureOverride={ _, _ -> false }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context,account,id)).use { scenario -> scenario.onActivity { activity ->
                if (Build.VERSION.SDK_INT >= 35) {
                    val systemBars = requireNotNull(ViewCompat.getRootWindowInsets(activity.window.decorView))
                        .getInsets(WindowInsetsCompat.Type.systemBars())
                    val actionBar = activity.findViewById<View>(R.id.setup_action_bar)
                    val location = IntArray(2)
                    actionBar.getLocationOnScreen(location)
                    assertTrue(
                        "Setup actions end under the navigation bar",
                        location[1] + actionBar.height <= activity.window.decorView.height - systemBars.bottom,
                    )
                }
                activity.findViewById<android.widget.Button>(R.id.setup_continue_limited).performClick()
                assertEquals(PostLoginSetupState.ACCOUNT_CREATED,AccountSettings.setupState(manager,account,true))
                assertEquals(id,manager.getUserData(account,AccountSettings.KEY_CREATION_ID))
                assertEquals("fake-session",manager.getUserData(account,AccountSettings.KEY_ETEBASE_SESSION))
                org.junit.Assert.assertTrue(activity.findViewById<android.widget.TextView>(R.id.setup_status).text.contains(activity.getString(R.string.post_login_setup_sync_retry)))
                org.junit.Assert.assertFalse(activity.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isShown)
            } }
        } finally { PostLoginSyncConfigurator.configureOverride=null; registry.clearOwned(account.type,account.name,id); AndroidCompat.removeAccount(manager,account) }
    }

    private fun seedAccountCreated(manager: AccountManager, registry: AccountCreationRegistry, account: Account, id: String) {
        check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,id))
        check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_URI,"https://example.invalid/"))
        check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_USERNAME,"test-user"))
        check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_SETTINGS_VERSION,AccountSettings.CURRENT_VERSION.toString()))
        check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_ETEBASE_SESSION,"fake-session"))
        check(AccountSettings.writeSetupState(manager,account,PostLoginSetupState.ACCOUNT_CREATED))
        check(registry.prepare(AccountCreationRegistry.Record(account.name,id,AccountCreationRegistry.Phase.CREATING,System.currentTimeMillis(),account.type)))
    }

    @Test fun generationMismatchShowsSettingsOnlyAcrossRecreation() {
        val c=InstrumentationRegistry.getInstrumentation().targetContext; val m=AccountManager.get(c); val a=Account("mismatch-${System.nanoTime()}@example.invalid",App.accountType); check(m.addAccountExplicitly(a,null,null)); check(AccountSettings.writeVerified(m,a,AccountSettings.KEY_CREATION_ID,"row")); check(AccountSettings.writeSetupState(m,a,PostLoginSetupState.PERMISSIONS)); val r=AccountCreationRegistry.open(c); check(r.prepare(AccountCreationRegistry.Record(a.name,"other",AccountCreationRegistry.Phase.RECOVERY_REQUIRED,System.currentTimeMillis(),a.type)))
        try { ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(c,a,"row")).use { s -> s.recreate(); s.onActivity { x -> val vm=androidx.lifecycle.ViewModelProvider(x)[PostLoginSetupViewModel::class.java]; org.junit.Assert.assertTrue(x.findViewById<android.widget.Button>(R.id.setup_resolve_ambiguity).isShown); org.junit.Assert.assertEquals(0,vm.inventoryInvocationCountForTest); org.junit.Assert.assertEquals(PostLoginSetupState.PERMISSIONS,AccountSettings.setupState(m,a,true)); org.junit.Assert.assertEquals("row",m.getUserData(a,AccountSettings.KEY_CREATION_ID)) } } } finally { r.clearOwned(a.type,a.name,"other"); AndroidCompat.removeAccount(m,a) }
    }
    @Test fun readOnlyLimitedTasksUseNormalContinueAndReachReady() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val account=Account("readonly-${System.nanoTime()}@example.invalid",App.accountType); check(manager.addAccountExplicitly(account,null,null)); check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,"readonly-id")); check(AccountSettings.writeSetupState(manager,account,PostLoginSetupState.PERMISSIONS))
        PostLoginSetupViewModel.inventoryOverride={ candidate -> if(candidate==account) PostLoginSetupViewModel.InventoryOutcome.Limited to setOf(io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS) else PostLoginSetupViewModel.InventoryOutcome.Recovery to emptySet() }
        try { ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context,account,"readonly-id")).use { scenario -> scenario.onActivity { a -> val model=androidx.lifecycle.ViewModelProvider(a)[PostLoginSetupViewModel::class.java]; org.junit.Assert.assertEquals(0,model.inventoryInvocationCountForTest); org.junit.Assert.assertEquals(emptySet<String>(),model.qualifyingCollectionTypes); org.junit.Assert.assertTrue(io.silentsuite.sync.Constants.ETEBASE_TYPE_TASKS in model.integrationCollectionTypes); a.findViewById<android.widget.Button>(R.id.setup_continue_limited).performClick() } }; assertEquals(PostLoginSetupState.READY,AccountSettings.setupState(manager,account,true)) }
        finally { PostLoginSetupViewModel.inventoryOverride=null; AndroidCompat.removeAccount(manager,account) }
    }
    @Test fun missingCreationIdShowsSettingsOnlyResolution() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context); val account=Account("missing-${System.nanoTime()}@example.invalid",App.accountType); check(manager.addAccountExplicitly(account,null,null)); check(AccountSettings.writeSetupState(manager,account,PostLoginSetupState.PERMISSIONS))
        try { ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context,account,null)).use { scenario -> InstrumentationRegistry.getInstrumentation().waitForIdleSync(); scenario.onActivity { a -> val model=androidx.lifecycle.ViewModelProvider(a)[PostLoginSetupViewModel::class.java]; org.junit.Assert.assertTrue(a.findViewById<android.widget.Button>(R.id.setup_resolve_ambiguity).isShown); org.junit.Assert.assertFalse(a.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isShown); org.junit.Assert.assertFalse(a.findViewById<android.widget.Button>(R.id.setup_continue_limited).isShown); org.junit.Assert.assertFalse(a.findViewById<android.widget.Button>(R.id.setup_skip_integrations).isShown); org.junit.Assert.assertEquals(0,model.inventoryInvocationCountForTest); org.junit.Assert.assertEquals(PostLoginSetupState.PERMISSIONS,AccountSettings.setupState(manager,account,true)); org.junit.Assert.assertEquals(null,manager.getUserData(account,AccountSettings.KEY_CREATION_ID)) } } }
        finally { AndroidCompat.removeAccount(manager,account) }
    }
    @Test fun pendingRecoveryRemovalSurvivesRecreationAndCleansExactOwner() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val target = Account("pending-${System.nanoTime()}@example.invalid", App.accountType)
        val sibling = Account("sibling-${System.nanoTime()}@example.invalid", App.accountType)
        val targetId = "pending-generation"
        check(manager.addAccountExplicitly(target, null, null)); check(manager.addAccountExplicitly(sibling, null, null))
        check(AccountSettings.writeVerified(manager, target, AccountSettings.KEY_CREATION_ID, targetId))
        check(AccountSettings.writeVerified(manager, sibling, AccountSettings.KEY_CREATION_ID, "sibling-generation"))
        check(AccountSettings.writeSetupState(manager, target, PostLoginSetupState.RECOVERY_REQUIRED))
        check(AccountSettings.writeSetupState(manager, sibling, PostLoginSetupState.COMPLETE))
        check(ActiveAccountManager.setActiveAccount(context, sibling))
        val registry = AccountCreationRegistry.open(context)
        check(registry.prepare(AccountCreationRegistry.Record(target.name, targetId, AccountCreationRegistry.Phase.RECOVERY_REQUIRED, System.currentTimeMillis(), target.type)))
        var beginCount = 0; var clearActiveCount = 0; var clearOwnedCount = 0; var rowAbsent = false
        var callback: ((Boolean) -> Unit)? = null
        PostLoginSetupViewModel.recoverySeamsFactory = { _, account, creationId ->
            object : io.silentsuite.sync.ui.setup.RecoveryRemovalCoordinator.Seams {
                override fun ownsExact() = account == target && creationId == targetId
                override fun begin(done: (Boolean) -> Unit) { beginCount++; callback = done }
                override fun rowAbsent() = rowAbsent
                override fun clearActive(): Boolean { clearActiveCount++; return account == target && creationId == targetId && ActiveAccountManager.getActiveAccount(context) == sibling }
                override fun clearOwned(): Boolean { clearOwnedCount++; return registry.clearOwned(target.type, target.name, targetId) && registry.get(target.type, target.name) == null }
            }
        }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, target, targetId)).use { scenario ->
                scenario.onActivity { it.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).performClick() }
                assertEquals(1, beginCount)
                scenario.onActivity { org.junit.Assert.assertFalse(it.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isEnabled) }
                scenario.recreate()
                assertEquals(1, beginCount)
                scenario.onActivity { org.junit.Assert.assertFalse(it.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isEnabled) }
                rowAbsent = true
                InstrumentationRegistry.getInstrumentation().runOnMainSync { callback!!.invoke(true) }
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            }
            assertEquals(1, clearActiveCount); assertEquals(1, clearOwnedCount)
            assertEquals(null, registry.get(target.type, target.name))
            assertEquals(sibling, ActiveAccountManager.getActiveAccount(context))
            org.junit.Assert.assertTrue(resumedActivity() is LoginActivity)
        } finally {
            PostLoginSetupViewModel.recoverySeamsFactory = null
            registry.clearOwned(target.type, target.name, targetId)
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }
    @Test fun permissionsRecoveryBlocksActionsAndLimitedSkipReachesReady() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext; val manager=AccountManager.get(context)
        val account=Account("outcome-${System.nanoTime()}@example.invalid",App.accountType)
        check(manager.addAccountExplicitly(account,null,null)); check(AccountSettings.writeVerified(manager,account,AccountSettings.KEY_CREATION_ID,"outcome-id")); check(AccountSettings.writeSetupState(manager,account,PostLoginSetupState.PERMISSIONS))
        PostLoginSetupViewModel.inventoryOverride={ candidate ->
            check(candidate==account)
            PostLoginSetupViewModel.InventoryOutcome.Recovery to emptySet()
        }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context,account,"outcome-id")).use { scenario ->
                scenario.onActivity { a ->
                    val model=androidx.lifecycle.ViewModelProvider(a)[PostLoginSetupViewModel::class.java]
                    model.setInventoryOutcomeForTest(PostLoginSetupViewModel.InventoryOutcome.Recovery)
                    a.findViewById<android.widget.Button>(R.id.setup_continue_limited).performClick(); a.findViewById<android.widget.Button>(R.id.setup_skip_integrations).performClick()
                    assertEquals(PostLoginSetupState.PERMISSIONS,AccountSettings.setupState(manager,account,true))
                    model.setInventoryOutcomeForTest(PostLoginSetupViewModel.InventoryOutcome.Limited)
                    a.findViewById<android.widget.Button>(R.id.setup_skip_integrations).performClick()
                }
            }
            assertEquals(PostLoginSetupState.READY,AccountSettings.setupState(manager,account,true)); org.junit.Assert.assertEquals("true",manager.getUserData(account,AccountSettings.KEY_LIMITED_INTEGRATIONS))
        } finally { PostLoginSetupViewModel.inventoryOverride=null; AndroidCompat.removeAccount(manager,account) }
    }
    @Test fun recoveryRemovalConfirmedRoutesCleanLoginAndPreservesSibling() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val target = Account("recover-${System.nanoTime()}@example.invalid", App.accountType)
        val sibling = Account("sibling-${System.nanoTime()}@example.invalid", App.accountType)
        val id = "recovery-generation"
        check(manager.addAccountExplicitly(target, null, null)); check(manager.addAccountExplicitly(sibling, null, null))
        check(AccountSettings.writeVerified(manager, target, AccountSettings.KEY_CREATION_ID, id))
        check(AccountSettings.writeVerified(manager, sibling, AccountSettings.KEY_CREATION_ID, "sibling-generation"))
        check(AccountSettings.writeSetupState(manager, target, PostLoginSetupState.RECOVERY_REQUIRED))
        check(AccountSettings.writeSetupState(manager, sibling, PostLoginSetupState.COMPLETE))
        check(ActiveAccountManager.setActiveAccount(context, sibling))
        val registry = AccountCreationRegistry.open(context)
        check(registry.prepare(AccountCreationRegistry.Record(target.name, id, AccountCreationRegistry.Phase.RECOVERY_REQUIRED, System.currentTimeMillis(), target.type)))
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, target, id)).use { scenario ->
                scenario.onActivity { activity ->
                    org.junit.Assert.assertTrue(activity.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isShown)
                    activity.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).performClick()
                }
                val deadline = android.os.SystemClock.uptimeMillis() + 5_000
                while (target in manager.getAccountsByType(target.type) && android.os.SystemClock.uptimeMillis() < deadline)
                    android.os.SystemClock.sleep(25)
            }
            org.junit.Assert.assertFalse(target in manager.getAccountsByType(target.type))
            assertEquals(sibling, ActiveAccountManager.getActiveAccount(context))
            assertEquals(null, registry.get(target.type, target.name))
            org.junit.Assert.assertTrue(resumedActivity() is LoginActivity)
        } finally {
            registry.clearOwned(target.type, target.name, id)
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling); ActiveAccountManager.clearActiveAccount(context)
        }
    }
    @Test fun noNetworkDashboardShellRoutesExactAccountAfterReadyDone() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val notificationPreferences = context.getSharedPreferences(
            "notification_permissions",
            android.content.Context.MODE_PRIVATE,
        )
        val notificationRequestMarker = if (
            notificationPreferences.contains("post_notifications_requested")
        ) {
            notificationPreferences.getBoolean("post_notifications_requested", false)
        } else {
            null
        }
        val manager = AccountManager.get(context)
        val target = Account("target-${System.nanoTime()}@example.invalid", App.accountType)
        val sibling = Account("sibling-${System.nanoTime()}@example.invalid", App.accountType)
        check(manager.addAccountExplicitly(target, null, null)); check(manager.addAccountExplicitly(sibling, null, null))
        AccountSettings.setUserData(manager, target, URI("https://example.invalid/"), target.name)
        AccountSettings.setUserData(manager, sibling, URI("https://example.invalid/"), sibling.name)
        check(AccountSettings.writeVerified(manager, target, AccountSettings.KEY_CREATION_ID, "target-generation"))
        check(AccountSettings.writeVerified(manager, sibling, AccountSettings.KEY_CREATION_ID, "sibling-generation"))
        check(AccountSettings.writeSetupState(manager, target, PostLoginSetupState.READY))
        check(AccountSettings.writeSetupState(manager, sibling, PostLoginSetupState.COMPLETE))
        check(ActiveAccountManager.setActiveAccount(context, sibling))
        val previousBootstrap=App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded=true
        AccountActivity.AccountInfoViewModel.accountLoaderOverride = { _, exact, creationId ->
            check(exact == target)
            check(creationId == "target-generation")
            AccountActivity.AccountInfo()
        }
        PostLoginSetupViewModel.inventoryOverride={ candidate ->
            check(candidate==target)
            PostLoginSetupViewModel.InventoryOutcome.Usable to emptySet()
        }
        val previousPermissionRequestOverride = AccountActivity.permissionRequestOverride
        var dashboardPermissionRequests = 0
        var scenario: ActivityScenario<AccountActivity>?=null
        val registryPreferences = context.getSharedPreferences(
            "account_creation_registry", android.content.Context.MODE_PRIVATE,
        )
        val previousRegistry = registryPreferences.getString("rows", null)
        fun restoreRegistry() {
            val editor = registryPreferences.edit()
            if (previousRegistry == null) editor.remove("rows") else editor.putString("rows", previousRegistry)
            check(editor.commit())
        }
        var dashboardMonitor: android.app.Instrumentation.ActivityMonitor? = null
        try {
            check(
                notificationPreferences.edit()
                    .putBoolean("post_notifications_requested", true)
                    .commit()
            )
            AccountActivity.permissionRequestOverride = { activity ->
                check(activity is AccountActivity)
                dashboardPermissionRequests += 1
            }
            // Exact incomplete launcher route must not fall back to the active sibling.
            scenario=ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, target, "target-generation"))
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val setup = resumedActivity() as PostLoginSetupActivity
            org.junit.Assert.assertTrue(setup.findViewById<android.widget.Button>(R.id.setup_done).isShown)
            InstrumentationRegistry.getInstrumentation().runOnMainSync { setup.recreate() }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            val recreated = resumedActivity() as PostLoginSetupActivity
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                recreated.findViewById<android.widget.Button>(R.id.setup_done).performClick()
            }
            val deadline=android.os.SystemClock.uptimeMillis()+5000
            var dashboard: AccountActivity?=null
            while (android.os.SystemClock.uptimeMillis()<deadline) {
                InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                InstrumentationRegistry.getInstrumentation().runOnMainSync {
                    dashboard = ActivityLifecycleMonitorRegistry.getInstance()
                        .getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<AccountActivity>()
                        .singleOrNull()
                        ?.takeIf { it.title.toString() == target.name }
                }
                if (AccountSettings.setupState(manager,target,true)==PostLoginSetupState.COMPLETE &&
                    ActiveAccountManager.getActiveAccount(context)==target && dashboard != null) {
                    break
                }
                android.os.SystemClock.sleep(25)
            }
            assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, target, true))
            assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling, true))
            assertEquals(target, ActiveAccountManager.getActiveAccount(context))
            val exactDashboard=requireNotNull(dashboard) { "Exact target dashboard did not resume before the deadline" }
            assertEquals(target.name, exactDashboard.title.toString())
            assertEquals(1, dashboardPermissionRequests)
            org.junit.Assert.assertTrue(exactDashboard.findViewById<android.view.View>(R.id.drawer_layout).isShown)

            // A real production bootstrap failure must not cycle back to the dashboard.
            // Block unexpected dashboard launches so the broken version fails boundedly.
            instrumentation.runOnMainSync { exactDashboard.finish() }
            check(registryPreferences.edit().putString("rows", "invalid-registry").commit())
            App.postLoginBootstrapSucceeded = io.silentsuite.sync.ui.setup.PostLoginSetupMigration.bootstrap(context)
            org.junit.Assert.assertFalse(App.postLoginBootstrapSucceeded)
            dashboardMonitor = instrumentation.addMonitor(AccountActivity::class.java.name, null, true)
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, target, "target-generation"),
            ).use { recovery ->
                repeat(2) {
                    recovery.onActivity { activity ->
                        assertEquals(
                            activity.getString(R.string.post_login_bootstrap_failed_title),
                            activity.findViewById<android.widget.TextView>(R.id.setup_title).text.toString(),
                        )
                        org.junit.Assert.assertTrue(activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory).isShown)
                        org.junit.Assert.assertFalse(activity.findViewById<android.widget.Button>(R.id.setup_remove_incomplete).isShown)
                        org.junit.Assert.assertFalse(activity.findViewById<android.widget.Button>(R.id.setup_done).isShown)
                        org.junit.Assert.assertFalse(activity.findViewById<View>(R.id.setup_stepper).isShown)
                    }
                    recovery.recreate()
                }
                assertEquals(0, requireNotNull(dashboardMonitor).hits)
                recovery.onActivity { activity ->
                    activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory).performClick()
                }
                val failureDeadline = android.os.SystemClock.uptimeMillis() + 5_000
                var retryFinished = false
                while (!retryFinished && android.os.SystemClock.uptimeMillis() < failureDeadline) {
                    recovery.onActivity { activity ->
                        retryFinished = activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory).isEnabled
                    }
                    if (!retryFinished) android.os.SystemClock.sleep(25)
                }
                org.junit.Assert.assertTrue("Failed startup retry did not settle", retryFinished)
                org.junit.Assert.assertFalse(App.postLoginBootstrapSucceeded)
                assertEquals(0, requireNotNull(dashboardMonitor).hits)
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, target, true))
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling, true))
                assertEquals("target-generation", manager.getUserData(target, AccountSettings.KEY_CREATION_ID))
                assertEquals("sibling-generation", manager.getUserData(sibling, AccountSettings.KEY_CREATION_ID))
                assertEquals(target, ActiveAccountManager.getActiveAccount(context))

                // Remove only the injected fixture fault. Retry must execute the real
                // bootstrap and return to the exact dashboard without resetting setup.
                restoreRegistry()
                instrumentation.removeMonitor(requireNotNull(dashboardMonitor))
                dashboardMonitor = null
                recovery.onActivity { activity ->
                    activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory).performClick()
                }
                val recoveryDeadline = android.os.SystemClock.uptimeMillis() + 5_000
                var recoveredDashboard: AccountActivity? = null
                while (recoveredDashboard == null && android.os.SystemClock.uptimeMillis() < recoveryDeadline) {
                    instrumentation.runOnMainSync {
                        recoveredDashboard = ActivityLifecycleMonitorRegistry.getInstance()
                            .getActivitiesInStage(Stage.RESUMED)
                            .filterIsInstance<AccountActivity>()
                            .singleOrNull()
                            ?.takeIf { it.title.toString() == target.name }
                    }
                    if (recoveredDashboard == null) android.os.SystemClock.sleep(25)
                }
                org.junit.Assert.assertTrue(App.postLoginBootstrapSucceeded)
                instrumentation.runOnMainSync {
                    val recovered = requireNotNull(recoveredDashboard) { "Startup retry did not restore the exact dashboard" }
                    org.junit.Assert.assertTrue(recovered.findViewById<View>(R.id.drawer_layout).isShown)
                    recovered.finish()
                }
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, target, true))
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling, true))
                assertEquals(target, ActiveAccountManager.getActiveAccount(context))
            }
        } finally {
            dashboardMonitor?.let(instrumentation::removeMonitor)
            restoreRegistry()
            runCatching { scenario?.close() }
            AccountActivity.permissionRequestOverride = previousPermissionRequestOverride
            AccountActivity.AccountInfoViewModel.accountLoaderOverride = null
            PostLoginSetupViewModel.inventoryOverride=null
            App.postLoginBootstrapSucceeded=previousBootstrap
            val notificationRestore = notificationPreferences.edit()
            if (notificationRequestMarker == null) {
                notificationRestore.remove("post_notifications_requested")
            } else {
                notificationRestore.putBoolean(
                    "post_notifications_requested",
                    notificationRequestMarker,
                )
            }
            val notificationRestored = notificationRestore.commit()
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling); ActiveAccountManager.clearActiveAccount(context)
            check(notificationRestored)
        }
    }

    @Test fun everyDurableSetupStateColdRendersApprovedPresentationWithoutRenderSideEffects() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val registry = AccountCreationRegistry.open(context)
        val approvedTitles = setOf(
            "Let's repair this setup",
            "Preparing Android sync…",
            "Android sync setup could not finish",
            "Preparing your encrypted collections…",
            "Collections could not be prepared",
            "Checking Android integrations…",
            "Show synced data in Android apps",
            "Starting your first sync…",
            "SilentSuite is ready",
            "Opening sync overview…",
        )
        val states = listOf(
            PostLoginSetupState.CREATING,
            PostLoginSetupState.ACCOUNT_CREATED,
            PostLoginSetupState.COLLECTIONS,
            PostLoginSetupState.PERMISSIONS,
            PostLoginSetupState.INITIAL_SYNC,
            PostLoginSetupState.READY,
            PostLoginSetupState.COMPLETE,
            PostLoginSetupState.RECOVERY_REQUIRED,
        )
        val accounts = mutableListOf<Account>()
        PostLoginSyncConfigurator.configureOverride = { _, _ -> false }
        PostLoginSetupViewModel.inventoryOverride = { account ->
            when (AccountSettings.setupState(manager, account, true)) {
                PostLoginSetupState.COLLECTIONS ->
                    PostLoginSetupViewModel.InventoryOutcome.Recovery to emptySet()
                else ->
                    PostLoginSetupViewModel.InventoryOutcome.Usable to emptySet()
            }
        }
        requestSyncDispatchOverride = { _, _, _ -> Unit }
        PostLoginSetupActivity.safeWorkPausedForTest = true
        try {
            states.forEachIndexed { index, state ->
                val account = Account("cold-$index-${System.nanoTime()}@example.invalid", App.accountType)
                val creationId = "cold-generation-$index"
                accounts += account
                check(manager.addAccountExplicitly(account, null, null))
                AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
                check(AccountSettings.writeSetupState(manager, account, state))
                if (state == PostLoginSetupState.CREATING || state == PostLoginSetupState.RECOVERY_REQUIRED) {
                    check(registry.prepare(AccountCreationRegistry.Record(
                        account.name,
                        creationId,
                        if (state == PostLoginSetupState.CREATING) {
                            AccountCreationRegistry.Phase.CREATING
                        } else {
                            AccountCreationRegistry.Phase.RECOVERY_REQUIRED
                        },
                        System.currentTimeMillis(),
                        account.type,
                    )))
                }

                ActivityScenario.launch<PostLoginSetupActivity>(
                    PostLoginSetupActivity.newIntent(context, account, creationId)
                ).use { scenario ->
                    scenario.onActivity { activity ->
                        listOf(
                            "setup_stepper",
                            "setup_step_connect_node",
                            "setup_step_prepare_node",
                            "setup_step_ready_node",
                            "setup_stage_connect",
                            "setup_stage_prepare",
                            "setup_stage_ready",
                            "setup_title",
                            "setup_body",
                        ).forEach { name ->
                            org.junit.Assert.assertNotEquals(
                                "Missing approved setup presentation view $name",
                                0,
                                activity.resources.getIdentifier(name, "id", activity.packageName),
                            )
                        }
                        val title = activity.findViewById<android.widget.TextView>(
                            activity.resources.getIdentifier("setup_title", "id", activity.packageName)
                        ).text.toString()
                        val body = activity.findViewById<android.widget.TextView>(
                            activity.resources.getIdentifier("setup_body", "id", activity.packageName)
                        ).text.toString()
                        org.junit.Assert.assertTrue("Unapproved setup title: $title", title in approvedTitles)
                        org.junit.Assert.assertFalse(states.any { body == it.name })
                        org.junit.Assert.assertFalse(body.startsWith("Setup:"))
                        org.junit.Assert.assertTrue(
                            activity.findViewById<View>(requiredViewId(activity, "setup_stepper"))
                                .contentDescription.toString().startsWith("Setup progress, step ")
                        )
                        if (index == 0) {
                            activity.configureSetupStepperForFontScale(2f)
                            val stepper = activity.findViewById<android.widget.LinearLayout>(
                                requiredViewId(activity, "setup_stepper")
                            )
                            assertEquals(android.widget.LinearLayout.VERTICAL, stepper.orientation)
                            val labels = listOf(
                                "setup_stage_connect",
                                "setup_stage_prepare",
                                "setup_stage_ready",
                            ).map { name ->
                                activity.findViewById<android.widget.TextView>(requiredViewId(activity, name))
                            }
                            labels.forEach { label ->
                                label.setTextSize(
                                    android.util.TypedValue.COMPLEX_UNIT_PX,
                                    label.textSize * 2f,
                                )
                                assertEquals(Int.MAX_VALUE, label.maxLines)
                                org.junit.Assert.assertNull(label.ellipsize)
                            }
                            val compactWidth =
                                (320 * activity.resources.displayMetrics.density).toInt()
                            stepper.measure(
                                View.MeasureSpec.makeMeasureSpec(
                                    compactWidth,
                                    View.MeasureSpec.EXACTLY,
                                ),
                                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                            )
                            stepper.layout(0, 0, compactWidth, stepper.measuredHeight)
                            labels.forEach { label ->
                                val textLayout = requireNotNull(label.layout)
                                repeat(textLayout.lineCount) { line ->
                                    assertEquals(0, textLayout.getEllipsisCount(line))
                                }
                            }
                        }
                    }
                }
                registry.clearOwned(account.type, account.name, creationId)
            }
        } finally {
            PostLoginSetupActivity.safeWorkPausedForTest = false
            PostLoginSyncConfigurator.configureOverride = null
            PostLoginSetupViewModel.inventoryOverride = null
            requestSyncDispatchOverride = null
            accounts.forEach { account ->
                manager.getUserData(account, AccountSettings.KEY_CREATION_ID)?.let {
                    registry.clearOwned(account.type, account.name, it)
                }
                AndroidCompat.removeAccount(manager, account)
            }
        }
    }

    @Test fun safeAutoAdvanceIsIdempotentAcrossRecreationAndStopsAtUserDecision() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("safe-auto-${System.nanoTime()}@example.invalid", App.accountType)
        val creationId = "safe-auto-generation"
        val registry = AccountCreationRegistry.open(context)
        var configureCalls = 0
        check(manager.addAccountExplicitly(account, null, null))
        seedAccountCreated(manager, registry, account, creationId)
        PostLoginSyncConfigurator.configureOverride = { candidateContext, candidate ->
            check(candidateContext.applicationContext == context.applicationContext)
            check(candidate == account)
            configureCalls++
            true
        }
        PostLoginSetupViewModel.inventoryOverride = { candidate ->
            check(candidate == account)
            PostLoginSetupViewModel.InventoryOutcome.Usable to setOf(
                Constants.ETEBASE_TYPE_CALENDAR,
                Constants.ETEBASE_TYPE_ADDRESS_BOOK,
            )
        }
        requestSyncDispatchOverride = { _, _, _ ->
            throw AssertionError("Safe auto-advance crossed the permission decision")
        }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, account, creationId)
            ).use { scenario ->
                waitForSetupState(manager, account, PostLoginSetupState.PERMISSIONS)
                scenario.recreate()
                scenario.recreate()
                assertEquals(PostLoginSetupState.PERMISSIONS, AccountSettings.setupState(manager, account, true))
                assertEquals(1, configureCalls)
                assertEquals(null, manager.getUserData(account, INITIAL_SYNC_REQUEST_ID_KEY))
                scenario.onActivity { activity ->
                    assertEquals(
                        "Show synced data in Android apps",
                        activity.findViewById<android.widget.TextView>(
                            requiredViewId(activity, "setup_title")
                        ).text.toString(),
                    )
                    assertTrue(activity.findViewById<View>(
                        requiredViewId(activity, "setup_integration_details")
                    ).isShown)
                    val recommendedApps = activity.findViewById<android.widget.TextView>(
                        requiredViewId(activity, "setup_recommended_apps")
                    )
                    assertEquals(
                        "For recommended local Android apps, see our docs.",
                        recommendedApps.text.toString(),
                    )
                    assertTrue(recommendedApps.isShown)
                    assertTrue(recommendedApps.isClickable)
                    assertTrue(
                        recommendedApps.minimumHeight >=
                            (48 * activity.resources.displayMetrics.density).toInt()
                    )
                    val completedNode = activity.findViewById<android.widget.TextView>(
                        requiredViewId(activity, "setup_step_connect_node")
                    )
                    org.junit.Assert.assertNull(completedNode.compoundDrawables[0])
                    org.junit.Assert.assertNull(completedNode.compoundDrawables[1])
                    org.junit.Assert.assertNotNull(completedNode.background)
                    assertEquals(
                        "Allow access and continue",
                        activity.findViewById<android.widget.Button>(
                            requiredViewId(activity, "setup_continue_limited")
                        ).text.toString(),
                    )
                }
            }
        } finally {
            requestSyncDispatchOverride = null
            PostLoginSetupViewModel.inventoryOverride = null
            PostLoginSyncConfigurator.configureOverride = null
            registry.clearOwned(account.type, account.name, creationId)
            AndroidCompat.removeAccount(manager, account)
        }
    }

    @Test fun permissionGrantDenialBlockedSkipAndNoTaskProviderRemainResumable() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val account = Account("permissions-${System.nanoTime()}@example.invalid", App.accountType)
        val creationId = "permissions-generation"
        check(manager.addAccountExplicitly(account, null, null))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, creationId))
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.PERMISSIONS))
        PostLoginSetupViewModel.inventoryOverride = { candidate ->
            check(candidate == account)
            PostLoginSetupViewModel.InventoryOutcome.Usable to setOf(
                Constants.ETEBASE_TYPE_CALENDAR,
                Constants.ETEBASE_TYPE_ADDRESS_BOOK,
                Constants.ETEBASE_TYPE_TASKS,
            )
        }
        requestSyncDispatchOverride = { _, _, _ -> Unit }
        try {
            installPermissionEvidenceOverride(Bundle().apply {
                putString("CALENDAR", "GRANTED")
                putString("CONTACTS", "DENIED_CAN_ASK_RETURNED")
                putString("TASKS", "UNKNOWN")
            })
            launchSetup(context, account, creationId) { activity ->
                assertEquals("Android access wasn't allowed", setupTitle(activity))
                assertEquals(PostLoginSetupState.PERMISSIONS, AccountSettings.setupState(manager, account, true))
            }

            installPermissionEvidenceOverride(Bundle().apply {
                putString("CALENDAR", "DENIED_BLOCKED_RETURNED")
                putString("CONTACTS", "GRANTED")
                putString("TASKS", "UNKNOWN")
            })
            launchSetup(context, account, creationId) { activity ->
                assertEquals("Allow access in Android settings", setupTitle(activity))
                assertEquals(
                    View.GONE,
                    activity.findViewById<View>(
                        requiredViewId(activity, "setup_continue_limited")
                    ).visibility,
                )
                assertTrue(activity.findViewById<View>(
                    requiredViewId(activity, "setup_resolve_ambiguity")
                ).isShown)
                assertTrue(activity.findViewById<View>(
                    requiredViewId(activity, "setup_skip_integrations")
                ).isShown)
            }

            installPermissionEvidenceOverride(Bundle().apply {
                putString("CALENDAR", "UNKNOWN_AFTER_LAUNCH_WITHOUT_RESULT")
                putString("CONTACTS", "GRANTED")
                putString("TASKS", "NEWLY_ELIGIBLE")
            })
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, account, creationId)
            ).use { scenario ->
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals("Show synced data in Android apps", setupTitle(activity))
                    org.junit.Assert.assertNotEquals("Allow access in Android settings", setupTitle(activity))
                }
            }

            installPermissionEvidenceOverride(Bundle().apply {
                putString("CALENDAR", "GRANTED")
                putString("CONTACTS", "DENIED_CAN_ASK_RETURNED")
                putBoolean("NO_TASK_PROVIDER", true)
            })
            launchSetup(context, account, creationId) { activity ->
                val allText = descendantText(activity.findViewById(android.R.id.content))
                org.junit.Assert.assertTrue(
                    allText.contains(
                        "Android has no built-in task provider. Install Tasks.org or OpenTasks later " +
                            "to sync tasks on this device."
                    )
                )
                findButton(activity, "Skip for now").performClick()
            }
            waitForSetupState(manager, account, PostLoginSetupState.READY)
            assertEquals("true", manager.getUserData(account, AccountSettings.KEY_LIMITED_INTEGRATIONS))
        } finally {
            runCatching { installPermissionEvidenceOverride(null) }
            requestSyncDispatchOverride = null
            PostLoginSetupViewModel.inventoryOverride = null
            AndroidCompat.removeAccount(manager, account)
        }
    }

    @Test fun initialSyncRequestIdSurvivesEveryCrashCutAndClearsAfterReady() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = AccountManager.get(context)
        val target = Account("initial-sync-${System.nanoTime()}@example.invalid", App.accountType)
        val sibling = Account("initial-sync-sibling-${System.nanoTime()}@example.invalid", App.accountType)
        val targetCreationId = "initial-sync-generation"
        val siblingCreationId = "initial-sync-sibling-generation"
        val requestId = "setup-request-${System.nanoTime()}"
        val siblingRequestId = "sibling-request-${System.nanoTime()}"
        val capturedRequestIds = mutableListOf<String>()
        check(manager.addAccountExplicitly(target, null, null))
        check(manager.addAccountExplicitly(sibling, null, null))
        check(AccountSettings.writeVerified(manager, target, AccountSettings.KEY_CREATION_ID, targetCreationId))
        check(AccountSettings.writeVerified(manager, sibling, AccountSettings.KEY_CREATION_ID, siblingCreationId))
        check(AccountSettings.writeSetupState(manager, target, PostLoginSetupState.INITIAL_SYNC))
        check(AccountSettings.writeSetupState(manager, sibling, PostLoginSetupState.COMPLETE))
        check(AccountSettings.writeVerified(manager, target, INITIAL_SYNC_REQUEST_ID_KEY, requestId))
        check(AccountSettings.writeVerified(manager, sibling, INITIAL_SYNC_REQUEST_ID_KEY, siblingRequestId))
        var failBetweenStatusCommitAndDispatch = true
        requestSyncDispatchOverride = { candidate, _, extras ->
            check(candidate == target)
            capturedRequestIds += requireNotNull(syncRequestId(extras))
            if (failBetweenStatusCommitAndDispatch) {
                failBetweenStatusCommitAndDispatch = false
                throw IllegalStateException("synthetic setup dispatch crash cut")
            }
        }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, target, targetCreationId)
            ).use { }
            assertEquals(PostLoginSetupState.INITIAL_SYNC, AccountSettings.setupState(manager, target, true))
            assertEquals(requestId, manager.getUserData(target, INITIAL_SYNC_REQUEST_ID_KEY))
            val store = SyncStatusStore(context)
            org.junit.Assert.assertTrue(
                listOf(SyncStatusStore.Service.CALENDAR, SyncStatusStore.Service.CONTACTS).any {
                    store.status(target, it).activeRequestId == requestId
                }
            )

            // Adapter terminal clearing is not the setup marker owner.
            check(store.clear(target))
            assertEquals(requestId, manager.getUserData(target, INITIAL_SYNC_REQUEST_ID_KEY))

            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, target, targetCreationId)
            ).use { scenario ->
                waitForSetupState(manager, target, PostLoginSetupState.READY)
                scenario.recreate()
            }
            assertEquals(null, manager.getUserData(target, INITIAL_SYNC_REQUEST_ID_KEY))
            assertEquals(siblingRequestId, manager.getUserData(sibling, INITIAL_SYNC_REQUEST_ID_KEY))
            org.junit.Assert.assertTrue(capturedRequestIds.isNotEmpty())
            assertEquals(setOf(requestId), capturedRequestIds.toSet())

            // A crash after READY read-back but before cleanup must only clean the inert marker.
            check(AccountSettings.writeVerified(manager, target, INITIAL_SYNC_REQUEST_ID_KEY, requestId))
            val dispatchesBeforeReadyCleanup = capturedRequestIds.size
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, target, targetCreationId)
            ).use { }
            assertEquals(null, manager.getUserData(target, INITIAL_SYNC_REQUEST_ID_KEY))
            assertEquals(dispatchesBeforeReadyCleanup, capturedRequestIds.size)
        } finally {
            requestSyncDispatchOverride = null
            AndroidCompat.removeAccount(manager, target)
            AndroidCompat.removeAccount(manager, sibling)
        }
    }

    @Test fun startupFailureRetryFeedbackAndDiagnosticReportStayExactAcrossRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = AccountManager.get(context)
        val target = Account("diagnostic-${System.nanoTime()}@example.invalid", App.accountType)
        val sibling = Account("diagnostic-sibling-${System.nanoTime()}@example.invalid", App.accountType)
        val targetId = "diagnostic-target-generation"
        val siblingId = "diagnostic-sibling-generation"
        check(manager.addAccountExplicitly(target, null, null)); check(manager.addAccountExplicitly(sibling, null, null))
        AccountSettings.setUserData(manager, target, URI("https://diagnostic.example.invalid/"), target.name)
        AccountSettings.setUserData(manager, sibling, URI("https://diagnostic.example.invalid/"), sibling.name)
        check(AccountSettings.writeVerified(manager, target, AccountSettings.KEY_CREATION_ID, targetId))
        check(AccountSettings.writeVerified(manager, sibling, AccountSettings.KEY_CREATION_ID, siblingId))
        check(AccountSettings.writeSetupState(manager, target, PostLoginSetupState.COMPLETE))
        check(AccountSettings.writeSetupState(manager, sibling, PostLoginSetupState.COMPLETE))
        val registryPreferences = context.getSharedPreferences(
            "account_creation_registry", android.content.Context.MODE_PRIVATE,
        )
        val previousRegistry = registryPreferences.getString("rows", null)
        fun restoreRegistry() {
            val editor = registryPreferences.edit()
            if (previousRegistry == null) editor.remove("rows") else editor.putString("rows", previousRegistry)
            check(editor.commit())
        }
        // Hostile unreadable ownership blob carrying identity-like content that must never leak.
        val hostileRegistry = "invalid-registry|${target.name}|$targetId|https://diagnostic.example.invalid/"
        val forbidden = listOf(target.name, sibling.name, targetId, siblingId, hostileRegistry, "example.invalid", "invalid-registry")
        val previousBootstrap = App.postLoginBootstrapSucceeded
        val retryEntered = java.util.concurrent.CountDownLatch(1)
        val releaseRetry = java.util.concurrent.CountDownLatch(1)
        val sharedIntents = mutableListOf<android.content.Intent>()
        var dashboardMonitor: android.app.Instrumentation.ActivityMonitor? = null
        try {
            check(registryPreferences.edit().putString("rows", hostileRegistry).commit())
            PostLoginStartupChecks.resetForTest()
            org.junit.Assert.assertFalse(PostLoginStartupChecks.runAtLaunch(context))
            org.junit.Assert.assertFalse(App.postLoginBootstrapSucceeded)
            assertEquals(
                PostLoginStartupOutcome(PostLoginStartupOutcome.Phase.REGISTRY_READ, PostLoginStartupOutcome.Reason.REGISTRY_UNREADABLE),
                PostLoginStartupChecks.snapshot().outcome,
            )
            dashboardMonitor = instrumentation.addMonitor(AccountActivity::class.java.name, null, true)
            ActivityScenario.launch<PostLoginSetupActivity>(
                PostLoginSetupActivity.newIntent(context, target, targetId),
            ).use { scenario ->
                scenario.onActivity { activity ->
                    val retry = activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory)
                    val report = activity.findViewById<android.widget.Button>(R.id.setup_view_diagnostic_report)
                    val status = activity.findViewById<android.widget.TextView>(R.id.setup_status)
                    assertTrue(retry.isShown)
                    assertTrue("Retry must be enabled before any tap", retry.isEnabled)
                    assertTrue(report.isShown); assertTrue(report.isEnabled)
                    org.junit.Assert.assertFalse(status.isShown)
                    assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, status.accessibilityLiveRegion)
                }
                PostLoginStartupChecks.beforeRetryBootstrapForTest = {
                    retryEntered.countDown()
                    check(releaseRetry.await(10, java.util.concurrent.TimeUnit.SECONDS))
                }
                scenario.onActivity { activity ->
                    val retry = activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory)
                    retry.performClick(); retry.performClick()
                }
                check(retryEntered.await(5, java.util.concurrent.TimeUnit.SECONDS))
                scenario.recreate()
                scenario.onActivity { activity ->
                    val retry = activity.findViewById<android.widget.Button>(R.id.setup_retry_inventory)
                    val status = activity.findViewById<android.widget.TextView>(R.id.setup_status)
                    org.junit.Assert.assertFalse(retry.isEnabled)
                    assertTrue(status.isShown)
                    assertEquals(activity.getString(R.string.post_login_bootstrap_retry_running), status.text.toString())
                    // A duplicate tap after recreation must not start an overlapping bootstrap.
                    retry.performClick()
                    val report = activity.findViewById<android.widget.Button>(R.id.setup_view_diagnostic_report)
                    assertTrue(report.isEnabled)
                    report.performClick()
                }
                instrumentation.waitForIdleSync()
                val inFlightReport = reportText(scenario)
                assertTrue(inFlightReport.contains("retry_in_flight: yes\n"))
                assertReportAllowlisted(inFlightReport, forbidden)
                releaseRetry.countDown()
                val settleDeadline = android.os.SystemClock.uptimeMillis() + 5_000
                var settled = false
                while (!settled && android.os.SystemClock.uptimeMillis() < settleDeadline) {
                    scenario.onActivity { settled = it.findViewById<android.widget.Button>(R.id.setup_retry_inventory).isEnabled }
                    if (!settled) android.os.SystemClock.sleep(25)
                }
                assertTrue("Failed startup retry did not settle", settled)
                PostLoginStartupChecks.beforeRetryBootstrapForTest = null
                val failed = PostLoginStartupChecks.snapshot()
                assertEquals(1, failed.retryAttempts)
                assertEquals(PostLoginStartupOutcome.Source.RETRY, failed.source)
                assertEquals(PostLoginStartupOutcome.Reason.REGISTRY_UNREADABLE, failed.outcome?.reason)
                org.junit.Assert.assertFalse(App.postLoginBootstrapSucceeded)
                // The open preview keeps its frozen in-flight snapshot.
                assertEquals(inFlightReport, reportText(scenario))
                scenario.onActivity { activity ->
                    val status = activity.findViewById<android.widget.TextView>(R.id.setup_status)
                    assertTrue(status.isShown)
                    assertEquals(activity.getString(R.string.post_login_bootstrap_retry_failed), status.text.toString())
                    reportFragment(activity).dismissNow()
                    activity.findViewById<android.widget.Button>(R.id.setup_view_diagnostic_report).performClick()
                }
                // Fail closed: unreadable ownership is never erased, quarantined or bypassed.
                assertEquals(hostileRegistry, registryPreferences.getString("rows", null))
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, target, true))
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling, true))
                assertEquals(targetId, manager.getUserData(target, AccountSettings.KEY_CREATION_ID))
                assertEquals(siblingId, manager.getUserData(sibling, AccountSettings.KEY_CREATION_ID))
                assertEquals(0, requireNotNull(dashboardMonitor).hits)

                instrumentation.waitForIdleSync()
                val settledReport = reportText(scenario)
                assertReportAllowlisted(settledReport, forbidden)
                listOf(
                    "schema_version: 2",
                    "startup_outcome: FAILED", "startup_phase: REGISTRY_READ", "startup_reason: REGISTRY_UNREADABLE",
                    "exception_category: NONE", "last_check: RETRY", "retry_attempts_this_process: 1",
                    "retry_in_flight: no",
                    // The unreadable registry fails before any row is classified or session parsed.
                    "rows_classified: 0", "session_parses: 0",
                ).forEach { assertTrue("Missing report line $it", settledReport.contains("$it\n")) }
                assertRecordedBucket(settledReport)
                assertRecordedBucket(inFlightReport)

                StartupDiagnosticReportDialog.shareStarterForTest = { sharedIntents += it }
                scenario.onActivity { activity ->
                    val dialog = reportDialog(activity)
                    dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
                    dialog.getButton(android.content.DialogInterface.BUTTON_NEUTRAL).performClick()
                    assertTrue(dialog.isShowing)
                    val clipboard = activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    assertEquals(settledReport, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
                    assertEquals(
                        activity.getString(R.string.startup_report_copied),
                        requireNotNull(dialog.findViewById<android.widget.TextView>(R.id.startup_report_feedback)).text.toString(),
                    )
                }
                val chooser = sharedIntents.single()
                assertEquals(android.content.Intent.ACTION_CHOOSER, chooser.action)
                val send = requireNotNull(chooser.getParcelableExtra<android.content.Intent>(android.content.Intent.EXTRA_INTENT))
                assertEquals(android.content.Intent.ACTION_SEND, send.action)
                assertEquals("text/plain", send.type)
                assertEquals(settledReport, send.getStringExtra(android.content.Intent.EXTRA_TEXT))
                org.junit.Assert.assertFalse(send.hasExtra(android.content.Intent.EXTRA_STREAM))

                StartupDiagnosticReportDialog.shareStarterForTest = { throw android.content.ActivityNotFoundException() }
                scenario.onActivity { activity ->
                    val dialog = reportDialog(activity)
                    dialog.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
                    assertTrue(dialog.isShowing)
                    assertEquals(
                        activity.getString(R.string.startup_report_share_unavailable),
                        requireNotNull(dialog.findViewById<android.widget.TextView>(R.id.startup_report_feedback)).text.toString(),
                    )
                }
                scenario.recreate()
                instrumentation.waitForIdleSync()
                assertEquals(settledReport, reportText(scenario))
                assertEquals(1, sharedIntents.size)

                // Removing only the injected fault lets the same retry run the real bootstrap
                // and route to the exact dashboard without resetting setup.
                scenario.onActivity { reportFragment(it).dismissNow() }
                restoreRegistry()
                scenario.onActivity { it.findViewById<android.widget.Button>(R.id.setup_retry_inventory).performClick() }
                val recoveryDeadline = android.os.SystemClock.uptimeMillis() + 5_000
                while (requireNotNull(dashboardMonitor).hits == 0 && android.os.SystemClock.uptimeMillis() < recoveryDeadline) {
                    android.os.SystemClock.sleep(25)
                }
                assertEquals(1, requireNotNull(dashboardMonitor).hits)
                assertTrue(App.postLoginBootstrapSucceeded)
                val recovered = PostLoginStartupChecks.snapshot()
                assertEquals(PostLoginStartupOutcome.SUCCEEDED, recovered.outcome)
                assertEquals(PostLoginStartupOutcome.Source.RETRY, recovered.source)
                assertEquals(2, recovered.retryAttempts)
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, target, true))
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, sibling, true))
                assertEquals(targetId, manager.getUserData(target, AccountSettings.KEY_CREATION_ID))
                assertEquals(siblingId, manager.getUserData(sibling, AccountSettings.KEY_CREATION_ID))
            }
        } finally {
            releaseRetry.countDown()
            PostLoginStartupChecks.beforeRetryBootstrapForTest = null
            StartupDiagnosticReportDialog.shareStarterForTest = null
            dashboardMonitor?.let(instrumentation::removeMonitor)
            restoreRegistry()
            App.postLoginBootstrapSucceeded = previousBootstrap
            PostLoginStartupChecks.resetForTest()
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling)
        }
    }

    /**
     * Synthetic existing-install upgrade shape only (no real identity, server or session). This is
     * not timing evidence: an unparsable session fails fast, so no duration is asserted.
     */
    @Test fun existingInstallFixtureBootstrapsAndPreservesOwnershipGates() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = AccountManager.get(context)
        val nonce = System.nanoTime()
        val username = "existing-install-$nonce@example.invalid"
        val uri = "https://existing-install.example.invalid/"
        val session = "synthetic-unparsable-session-$nonce"
        val account = Account(username, App.accountType)
        val child = Account("existing-install-child-$nonce@example.invalid", App.addressBookAccountType)
        val legacyRow = Bundle().apply {
            putString(AccountSettings.KEY_SETTINGS_VERSION, "1")
            putString(AccountSettings.KEY_USERNAME, username)
            putString(AccountSettings.KEY_URI, uri)
            putString(AccountSettings.KEY_ETEBASE_SESSION, session)
        }
        // Legacy child row: main-account name/type and URL, but no child creation ID or main identity.
        val legacyChild = Bundle().apply {
            putString(LocalAddressBook.USER_DATA_MAIN_ACCOUNT_NAME, account.name)
            putString(LocalAddressBook.USER_DATA_MAIN_ACCOUNT_TYPE, account.type)
            putString(LocalAddressBook.USER_DATA_URL, "https://existing-install.example.invalid/address-book")
        }
        val migrationPreferences = context.getSharedPreferences("post_login_setup_migration", android.content.Context.MODE_PRIVATE)
        val previousMarker = migrationPreferences.takeIf { it.contains("version") }?.getInt("version", 0)
        val statusPreferences = context.getSharedPreferences("sync_status_v1", android.content.Context.MODE_PRIVATE)
        val previousBootstrap = App.postLoginBootstrapSucceeded
        val seededStatusKeys = mutableListOf<String>()
        var setupMonitor: android.app.Instrumentation.ActivityMonitor? = null
        try {
            check(manager.addAccountExplicitly(account, null, legacyRow))
            check(manager.addAccountExplicitly(child, null, legacyChild))
            // Keep the platform from syncing the synthetic rows while bootstrap and assertions observe them.
            (listOf(App.addressBooksAuthority, android.provider.CalendarContract.AUTHORITY) +
                TaskProvider.TASK_PROVIDERS.map { it.authority }).forEach { authority ->
                ContentResolver.removePeriodicSync(account, authority, Bundle())
                ContentResolver.setSyncAutomatically(account, authority, false)
                ContentResolver.setIsSyncable(account, authority, 0)
            }
            ContentResolver.removePeriodicSync(child, android.provider.ContactsContract.AUTHORITY, Bundle())
            ContentResolver.setSyncAutomatically(child, android.provider.ContactsContract.AUTHORITY, false)
            ContentResolver.setIsSyncable(child, android.provider.ContactsContract.AUTHORITY, 0)
            // Pre-bootstrap generation: the store hashes the absent creation ID, as legacy builds did.
            val legacyIdentity = SyncStatusStore(context).identity(account)
            val recordKey = "status.${legacyIdentity.storageKey}.CONTACTS"
            val faultKey = "fault.$recordKey"
            val v1Record = "1|10||||;"
            val v1Fault = "1|11|STORAGE"
            seededStatusKeys += listOf(recordKey, faultKey)
            check(statusPreferences.edit().putString(recordKey, v1Record).putString(faultKey, v1Fault).commit())
            check(migrationPreferences.edit().remove("version").commit())
            val childBefore = childUserData(manager, child)
            assertEquals(null, manager.getUserData(child, LocalAddressBook.USER_DATA_CREATION_ID))
            assertEquals(null, manager.getUserData(child, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY))
            PostLoginStartupChecks.resetForTest()

            val succeeded = PostLoginStartupChecks.runAtLaunch(context)
            // The Boolean is only a summary; the typed snapshot is the evidence.
            val snapshot = PostLoginStartupChecks.snapshot()
            assertEquals(PostLoginStartupOutcome.SUCCEEDED, snapshot.outcome)
            assertEquals(PostLoginStartupOutcome.Source.LAUNCH, snapshot.source)
            assertEquals(snapshot.outcome?.succeeded, succeeded)
            assertEquals(succeeded, App.postLoginBootstrapSucceeded)
            org.junit.Assert.assertNotEquals(PostLoginStartupChecks.BootstrapElapsedBucket.NOT_RECORDED, snapshot.bootstrapElapsedBucket)
            assertTrue(snapshot.rowsClassified in 1..99)
            assertTrue(snapshot.sessionParses in 1..99)

            val creationId = manager.getUserData(account, AccountSettings.KEY_CREATION_ID)
            assertTrue("Legacy row did not receive a creation ID", !creationId.isNullOrBlank())
            assertEquals(PostLoginSetupState.RECOVERY_REQUIRED.name,
                manager.getUserData(account, AccountSettings.KEY_POST_LOGIN_SETUP_STATE))
            assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, AccountSettings.setupState(manager, account, true))
            assertTrue(PostLoginSetupMigration.isBootstrapped(context))
            // Recovery classification never rewrites legacy credentials or the child row.
            assertEquals("1", manager.getUserData(account, AccountSettings.KEY_SETTINGS_VERSION))
            assertEquals(session, manager.getUserData(account, AccountSettings.KEY_ETEBASE_SESSION))
            assertEquals(childBefore, childUserData(manager, child))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertTrue(child in manager.getAccountsByType(App.addressBookAccountType))

            // v1-only Contacts evidence for the pre-bootstrap generation stays fail-closed and untouched.
            val legacyStatus = SyncStatusStore(context).status(legacyIdentity, SyncStatusStore.Service.CONTACTS)
            assertTrue(legacyStatus.structuralStorageFailure)
            assertEquals(SyncStatusStore.FailureCategory.STORAGE, legacyStatus.lastFailureCategory)
            assertEquals(v1Record, statusPreferences.getString(recordKey, null))
            assertEquals(v1Fault, statusPreferences.getString(faultKey, null))

            // The launcher never opens the dashboard for a recovery row.
            setupMonitor = instrumentation.addMonitor(PostLoginSetupActivity::class.java.name, null, true)
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account, creationId)).use { scenario ->
                instrumentation.waitForIdleSync()
                assertEquals(1, requireNotNull(setupMonitor).hits)
                assertEquals(androidx.lifecycle.Lifecycle.State.DESTROYED, scenario.state)
            }
            assertEquals(PostLoginSetupState.RECOVERY_REQUIRED, AccountSettings.setupState(manager, account, true))
            assertEquals(creationId, manager.getUserData(account, AccountSettings.KEY_CREATION_ID))
            assertTrue(account in manager.getAccountsByType(App.accountType))
            assertTrue(child in manager.getAccountsByType(App.addressBookAccountType))

            val report = StartupDiagnosticReport.capture(context, uiRetryInFlight = false)
            assertReportAllowlisted(report, listOf(username, uri, session, "example.invalid", requireNotNull(creationId),
                legacyIdentity.storageKey))
            assertTrue(report.contains("schema_version: 2\n"))
            assertTrue(report.contains("startup_outcome: SUCCEEDED\n"))
            assertRecordedBucket(report)
        } finally {
            setupMonitor?.let(instrumentation::removeMonitor)
            if (seededStatusKeys.isNotEmpty()) {
                val editor = statusPreferences.edit()
                seededStatusKeys.forEach { editor.remove(it) }
                check(editor.commit())
            }
            val markerEditor = migrationPreferences.edit()
            if (previousMarker == null) markerEditor.remove("version") else markerEditor.putInt("version", previousMarker)
            check(markerEditor.commit())
            App.postLoginBootstrapSucceeded = previousBootstrap
            PostLoginStartupChecks.resetForTest()
            AndroidCompat.removeAccount(manager, child)
            AndroidCompat.removeAccount(manager, account)
        }
    }

    private fun childUserData(manager: AccountManager, child: Account): List<String?> = listOf(
        LocalAddressBook.USER_DATA_MAIN_ACCOUNT_NAME, LocalAddressBook.USER_DATA_MAIN_ACCOUNT_TYPE,
        LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY, LocalAddressBook.USER_DATA_URL,
        LocalAddressBook.USER_DATA_CREATION_ID, LocalAddressBook.USER_DATA_READ_ONLY,
    ).map { manager.getUserData(child, it) }

    private fun assertRecordedBucket(report: String) {
        val bucket = report.lines().single { it.startsWith("bootstrap_elapsed_bucket: ") }.substringAfter(": ")
        val recorded = PostLoginStartupChecks.BootstrapElapsedBucket.values()
            .filter { it != PostLoginStartupChecks.BootstrapElapsedBucket.NOT_RECORDED }
            .map { it.reportValue }
        assertTrue("Bootstrap elapsed bucket was not recorded", bucket in recorded)
    }

    private fun reportFragment(activity: PostLoginSetupActivity): androidx.fragment.app.DialogFragment =
        requireNotNull(
            activity.supportFragmentManager.findFragmentByTag(StartupDiagnosticReportDialog.TAG)
        ) { "Startup diagnostic report preview is not open" } as androidx.fragment.app.DialogFragment

    private fun reportDialog(activity: PostLoginSetupActivity): androidx.appcompat.app.AlertDialog =
        reportFragment(activity).requireDialog() as androidx.appcompat.app.AlertDialog

    private fun reportText(scenario: ActivityScenario<PostLoginSetupActivity>): String {
        var text: String? = null
        scenario.onActivity { activity ->
            text = requireNotNull(
                reportDialog(activity).findViewById<android.widget.TextView>(R.id.startup_report_text)
            ).text.toString()
        }
        return requireNotNull(text)
    }

    private fun assertReportAllowlisted(report: String, forbidden: List<String>) {
        val lines = report.removeSuffix("\n").split("\n")
        assertEquals("SilentSuite startup diagnostic report", lines.first())
        assertEquals(
            listOf(
                "schema_version", "app_version", "app_version_code", "android_sdk", "startup_outcome",
                "startup_phase", "startup_reason", "exception_category", "last_check",
                "retry_attempts_this_process", "retry_in_flight", "bootstrap_elapsed_bucket",
                "rows_classified", "session_parses", "migration_marker_present",
            ),
            lines.drop(1).map { it.substringBefore(": ") },
        )
        val shape = Regex("[a-z_]+: [A-Za-z0-9._+-]+")
        lines.drop(1).forEach { assertTrue("Report line outside allowlist shape", shape.matches(it)) }
        val deviceIdentifiers = listOfNotNull(Build.MODEL, Build.DEVICE, Build.MANUFACTURER, Build.FINGERPRINT, Build.DISPLAY)
            .filter { it.length >= 6 }
        (forbidden + deviceIdentifiers).forEachIndexed { index, value ->
            org.junit.Assert.assertFalse("Report contains forbidden value #$index", report.contains(value))
        }
    }

    private fun launchSetup(
        context: android.content.Context,
        account: Account,
        creationId: String,
        assertion: (PostLoginSetupActivity) -> Unit,
    ) {
        ActivityScenario.launch<PostLoginSetupActivity>(
            PostLoginSetupActivity.newIntent(context, account, creationId)
        ).use { scenario -> scenario.onActivity { assertion(it) } }
    }

    private fun installPermissionEvidenceOverride(evidence: Bundle?) {
        val method = PostLoginSetupViewModel::class.java.declaredMethods.firstOrNull {
            it.name == "installPermissionEvidenceOverrideForTest" &&
                it.parameterTypes.contentEquals(arrayOf(Bundle::class.java))
        }
        if (method != null && Modifier.isStatic(method.modifiers)) {
            method.isAccessible = true
            method.invoke(null, evidence)
            return
        }
        val companionField = PostLoginSetupViewModel::class.java.getDeclaredField("Companion")
        companionField.isAccessible = true
        val companion = companionField.get(null)
        val companionMethod = companion.javaClass.getDeclaredMethod(
            "installPermissionEvidenceOverrideForTest",
            Bundle::class.java,
        )
        companionMethod.isAccessible = true
        companionMethod.invoke(companion, evidence)
    }

    private fun setupTitle(activity: PostLoginSetupActivity): String =
        activity.findViewById<android.widget.TextView>(requiredViewId(activity, "setup_title"))
            .text.toString()

    private fun requiredViewId(activity: android.app.Activity, name: String): Int {
        val id = activity.resources.getIdentifier(name, "id", activity.packageName)
        org.junit.Assert.assertNotEquals("Missing setup view $name", 0, id)
        return id
    }

    private fun findButton(activity: android.app.Activity, text: String): android.widget.Button =
        descendants(activity.findViewById(android.R.id.content))
            .filterIsInstance<android.widget.Button>()
            .single { it.text.toString() == text }

    private fun descendantText(root: android.view.View): String =
        descendants(root).filterIsInstance<android.widget.TextView>()
            .joinToString("\n") { it.text.toString() }

    private fun descendants(view: android.view.View): Sequence<android.view.View> = sequence {
        yield(view)
        if (view is android.view.ViewGroup) {
            for (index in 0 until view.childCount) yieldAll(descendants(view.getChildAt(index)))
        }
    }

    private fun waitForSetupState(
        manager: AccountManager,
        account: Account,
        expected: PostLoginSetupState,
    ) {
        val deadline = android.os.SystemClock.uptimeMillis() + 5_000
        while (android.os.SystemClock.uptimeMillis() < deadline) {
            if (AccountSettings.setupState(manager, account, true) == expected) return
            android.os.SystemClock.sleep(25)
        }
        assertEquals(expected, AccountSettings.setupState(manager, account, true))
    }

    private fun resumedActivityOrNull(): android.app.Activity? {
        var current: android.app.Activity? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            current = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).singleOrNull()
        }
        return current
    }
    private fun resumedActivity(): android.app.Activity {
        val deadline=android.os.SystemClock.uptimeMillis()+5000
        while (android.os.SystemClock.uptimeMillis()<deadline) {
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            resumedActivityOrNull()?.let { return it }
            android.os.SystemClock.sleep(25)
        }
        throw IllegalStateException("No single resumed Activity before the deadline")
    }

    private companion object {
        const val INITIAL_SYNC_REQUEST_ID_KEY = "post_login_initial_sync_request_id_v1"
    }
}
