package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity

import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.ui.setup.AccountCreationRegistry
import io.silentsuite.sync.ui.setup.LoginActivity
import io.silentsuite.sync.ui.setup.PostLoginSetupViewModel
import io.silentsuite.sync.utils.AndroidCompat
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI

@RunWith(AndroidJUnit4::class)
class PostLoginSetupRuntimeTest {
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
        val context = InstrumentationRegistry.getInstrumentation().targetContext
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
        PostLoginSetupViewModel.inventoryOverride={ candidate ->
            check(candidate==target)
            PostLoginSetupViewModel.InventoryOutcome.Usable to emptySet()
        }
        var scenario: ActivityScenario<AccountActivity>?=null
        try {
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
                val resumed=resumedActivityOrNull()
                if (AccountSettings.setupState(manager,target,true)==PostLoginSetupState.COMPLETE &&
                    ActiveAccountManager.getActiveAccount(context)==target && resumed is AccountActivity &&
                    resumed.title.toString()==target.name) {
                    dashboard=resumed
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
            PostLoginSetupViewModel.inventoryOverride=null
            App.postLoginBootstrapSucceeded=previousBootstrap
            AndroidCompat.removeAccount(manager, target); AndroidCompat.removeAccount(manager, sibling); ActiveAccountManager.clearActiveAccount(context)
        }
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
}
