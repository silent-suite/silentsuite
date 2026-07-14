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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val uiAutomation = InstrumentationRegistry.getInstrumentation().uiAutomation
            listOf(
                Manifest.permission.READ_CALENDAR,
                Manifest.permission.WRITE_CALENDAR,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.WRITE_CONTACTS
            ).forEach { permission ->
                uiAutomation.executeShellCommand("pm grant ${context.packageName} $permission").close()
            }
        }

        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account)).use { scenario ->
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
            AndroidCompat.removeAccount(accountManager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }
}
