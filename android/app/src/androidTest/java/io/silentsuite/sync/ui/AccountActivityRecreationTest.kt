package io.silentsuite.sync.ui

import android.Manifest
import android.accounts.Account
import android.accounts.AccountManager
import android.os.Build
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.App
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.utils.AndroidCompat
import io.silentsuite.sync.ui.setup.PostLoginSetupActivity

import io.silentsuite.sync.ui.setup.PostLoginSetupState
import java.net.URI
import org.junit.Assert.assertEquals
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

        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account)).use { scenario ->
                scenario.onActivity { assertTrue(it is AccountActivity) }
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
            }
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
        try {
            ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, account)).use { scenario ->
                scenario.onActivity { activity -> activity.findViewById<android.widget.Button>(io.silentsuite.sync.R.id.setup_done).performClick() }
                assertEquals(PostLoginSetupState.COMPLETE, AccountSettings.setupState(manager, account, true))
            }
        } finally {
            AndroidCompat.removeAccount(manager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }

}
