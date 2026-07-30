package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentResolver
import android.os.Bundle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.R
import io.silentsuite.sync.syncadapter.SyncStatusStore
import io.silentsuite.sync.syncadapter.requestSyncDispatchOverride
import io.silentsuite.sync.syncadapter.syncRequestId
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity
import io.silentsuite.sync.ui.setup.PostLoginSyncConfigurator

import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupViewModel
import io.silentsuite.sync.utils.AndroidCompat
import at.bitfire.ical4android.TaskProvider
import org.junit.Assert.assertEquals
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
        var scenario: ActivityScenario<AccountActivity>?=null
        try {
            check(
                notificationPreferences.edit()
                    .putBoolean("post_notifications_requested", true)
                    .commit()
            )
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
            org.junit.Assert.assertTrue(exactDashboard.findViewById<android.view.View>(R.id.drawer_layout).isShown)
        } finally {
            runCatching { scenario?.close() }
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
            check(notificationRestore.commit())
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling); ActiveAccountManager.clearActiveAccount(context)
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
            "Connect to Android apps",
            "Starting your first sync…",
            "You're ready",
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
                        "Connect to Android apps",
                        activity.findViewById<android.widget.TextView>(
                            requiredViewId(activity, "setup_title")
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
                    assertEquals("Connect to Android apps", setupTitle(activity))
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
