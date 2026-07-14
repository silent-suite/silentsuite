package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.App
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.utils.AndroidCompat
import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AccountActivityRecreationTest {
    @Test
    fun recreationKeepsTheExactAccountRoute() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val account = Account("recreation-${System.nanoTime()}@example.invalid", App.accountType)
        val accountManager = AccountManager.get(context)
        accountManager.addAccountExplicitly(account, null, null)
        AccountSettings.setUserData(accountManager, account, URI("https://example.invalid/"), account.name)

        try {
            ActivityScenario.launch<AccountActivity>(AccountActivity.newIntent(context, account)).use { scenario ->
                scenario.recreate()
                scenario.onActivity { recreated ->
                    assertEquals(account.name, recreated.title.toString())
                    assertEquals(account, ActiveAccountManager.getActiveAccount(context))
                }
            }
        } finally {
            AndroidCompat.removeAccount(accountManager, account)
            ActiveAccountManager.clearActiveAccount(context)
        }
    }
}
