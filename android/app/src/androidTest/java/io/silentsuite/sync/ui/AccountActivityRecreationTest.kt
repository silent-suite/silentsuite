package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.App
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.AccountUpdateService
import io.silentsuite.sync.utils.AndroidCompat
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity

import io.silentsuite.sync.ui.setup.PostLoginSetupState
import io.silentsuite.sync.ui.setup.PostLoginSetupViewModel
import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountActivityRecreationTest {
    @Test
    fun recreationKeepsTheExactAccountRouteAndDeliversModelStateToTheRecreatedUi() {
        // Keeper assigns the shared desugared runtime to the target debug APK; androidTest
        // deliberately contains no j$ classes, so it cannot shadow the target's L8 runtime.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account("recreation-${System.nanoTime()}@example.invalid", App.accountType)
        val accountManager = AccountManager.get(context)
        accountManager.addAccountExplicitly(account, null, null)
        AccountSettings.setUserData(accountManager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeVerified(accountManager, account, AccountSettings.KEY_CREATION_ID, "test-generation"))
        check(AccountSettings.writeSetupState(accountManager, account, PostLoginSetupState.COMPLETE))
        val previousBootstrap = App.postLoginBootstrapSucceeded
        App.postLoginBootstrapSucceeded = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val uiAutomation = InstrumentationRegistry.getInstrumentation().uiAutomation
            val permissions = mutableListOf(
                Manifest.permission.READ_CALENDAR,
                Manifest.permission.WRITE_CALENDAR,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.WRITE_CONTACTS
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                permissions += Manifest.permission.POST_NOTIFICATIONS
            permissions.forEach { permission ->
                uiAutomation.executeShellCommand("pm grant ${context.packageName} $permission").close()
            }
        }

        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val baselineClients = accountUpdateServiceClients(context)
        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account, "test-generation")).use { scenario ->
                scenario.onActivity { assertTrue(it is AccountActivity) }
                assertEquals("The dashboard model holds exactly one service binding",
                    baselineClients + 1, accountUpdateServiceClients(context))
                scenario.recreate()
                var delivered = false
                for (attempt in 0 until 50) {
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    scenario.onActivity { recreated ->
                        delivered = recreated.hasDeliveredAccountInfo
                    }
                    if (delivered)
                        break
                    SystemClock.sleep(100)
                }
                scenario.onActivity { recreated ->
                    assertEquals(account.name, recreated.title.toString())
                    assertEquals(account, ActiveAccountManager.getActiveAccount(context))
                    assertTrue("The recreated Activity must receive a model delivery and update its UI", recreated.hasDeliveredAccountInfo)
                }
                assertEquals("Recreation keeps the model's binding and never binds again",
                    baselineClients + 1, accountUpdateServiceClients(context))
            }
            assertEquals("Finishing the dashboard releases the model's service binding",
                baselineClients, awaitAccountUpdateServiceClients(context, baselineClients))

            // A model cleared before its connection arrives still releases the binding.
            val earlyStore = ViewModelStore()
            lateinit var earlyModel: AccountActivity.AccountInfoViewModel
            instrumentation.runOnMainSync {
                earlyModel = ViewModelProvider(earlyStore, ViewModelProvider.NewInstanceFactory())
                    .get(AccountActivity.AccountInfoViewModel::class.java)
                earlyModel.initialize(context, account, "test-generation")
                assertFalse(earlyModel.serviceConnectedForTesting)
                earlyStore.clear()
            }
            assertEquals("Clearing before the connection releases the binding",
                baselineClients, awaitAccountUpdateServiceClients(context, baselineClients))
            assertUnbindingAgainIsRefused(context, earlyModel)

            // A connection that drops before the model is cleared still releases the binding.
            val droppedStore = ViewModelStore()
            lateinit var droppedModel: AccountActivity.AccountInfoViewModel
            instrumentation.runOnMainSync {
                droppedModel = ViewModelProvider(droppedStore, ViewModelProvider.NewInstanceFactory())
                    .get(AccountActivity.AccountInfoViewModel::class.java)
                droppedModel.initialize(context, account, "test-generation")
            }
            var connected = false
            for (attempt in 0 until 50) {
                instrumentation.runOnMainSync { connected = droppedModel.serviceConnectedForTesting }
                if (connected)
                    break
                SystemClock.sleep(100)
            }
            assertTrue("The model's service connection must arrive", connected)
            instrumentation.runOnMainSync {
                droppedModel.onServiceDisconnected(ComponentName(context, AccountUpdateService::class.java))
                assertFalse(droppedModel.serviceConnectedForTesting)
                droppedStore.clear()
            }
            assertEquals("Clearing after a dropped connection releases the binding",
                baselineClients, awaitAccountUpdateServiceClients(context, baselineClients))
            assertUnbindingAgainIsRefused(context, droppedModel)
        } finally {
            App.postLoginBootstrapSucceeded = previousBootstrap
            AndroidCompat.removeAccount(accountManager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun readyDoneCompletesOnlyTheExactGeneratedAccount() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account("setup-${System.nanoTime()}@example.invalid", App.accountType)
        val manager = AccountManager.get(context)
        check(manager.addAccountExplicitly(account, null, null))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "setup-generation"))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.READY))
        PostLoginSetupViewModel.inventoryOverride={ candidate ->
            check(candidate==account)
            PostLoginSetupViewModel.InventoryOutcome.Usable to emptySet()
        }
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, account, "setup-generation")).use { scenario ->
                scenario.onActivity { activity -> activity.findViewById<android.widget.Button>(io.silentsuite.sync.R.id.setup_done).performClick() }
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, account, true))
            }
        } finally {
            PostLoginSetupViewModel.inventoryOverride=null
            AndroidCompat.removeAccount(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    @Test
    fun replacementGenerationCannotCompleteThePreviouslyValidatedSetupRoute() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account("setup-replaced-${System.nanoTime()}@example.invalid", App.accountType)
        val manager = AccountManager.get(context)
        check(manager.addAccountExplicitly(account, null, null))
        check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "generation-a"))
        AccountSettings.setUserData(manager, account, URI("https://example.invalid/"), account.name)
        check(AccountSettings.writeSetupState(manager, account, PostLoginSetupState.READY))
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, account, "generation-a")).use { scenario ->
                check(AccountSettings.writeVerified(manager, account, AccountSettings.KEY_CREATION_ID, "generation-b"))
                scenario.onActivity { it.findViewById<android.widget.Button>(io.silentsuite.sync.R.id.setup_done).performClick() }
                assertEquals(PostLoginSetupState.READY, AccountSettings.setupState(manager, account, true))
            }
        } finally {
            AndroidCompat.removeAccount(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

    /** Bound clients of this app's AccountUpdateService; no running entry means none. */
    @Suppress("DEPRECATION")
    private fun accountUpdateServiceClients(context: Context): Int =
        context.getSystemService(ActivityManager::class.java)
            .getRunningServices(Int.MAX_VALUE)
            .filter { it.service.packageName == context.packageName &&
                it.service.className == AccountUpdateService::class.java.name }
            .sumOf { it.clientCount }

    /** Waits a bounded time for teardown to reach [expected], returning the last count. */
    private fun awaitAccountUpdateServiceClients(context: Context, expected: Int): Int {
        var clients = accountUpdateServiceClients(context)
        for (attempt in 0 until 50) {
            if (clients == expected)
                break
            SystemClock.sleep(100)
            clients = accountUpdateServiceClients(context)
        }
        return clients
    }

    /** onCleared unbound exactly once: a further unbind finds no registration. */
    private fun assertUnbindingAgainIsRefused(context: Context, model: AccountActivity.AccountInfoViewModel) {
        var refused = false
        try {
            context.applicationContext.unbindService(model)
        } catch (e: IllegalArgumentException) {
            refused = true
        }
        assertTrue("The cleared model's binding must already be released", refused)
    }
}
