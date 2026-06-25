package io.silentsuite.screenshots

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.ContentResolver
import android.provider.CalendarContract
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
import io.silentsuite.sync.Constants
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.ui.setup.BaseConfigurationFinder
import io.silentsuite.sync.ui.setup.LoginCredentials

/**
 * Deterministic account setup for store screenshot instrumentation.
 *
 * This runs only from androidTest. It avoids brittle keyboard/UIAutomator login
 * entry by using the same Etebase configuration finder and AccountSettings path
 * as the normal login flow.
 */
object ScreenshotAccountProvisioner {
    @JvmStatic
    fun ensureAccount(context: Context, email: String?, password: String?): Boolean {
        if (email.isNullOrBlank() || password.isNullOrBlank()) {
            return false
        }

        val accountManager = AccountManager.get(context)
        val existing = accountManager.getAccountsByType(App.accountType).firstOrNull { it.name == email }
        if (existing != null) {
            ActiveAccountManager.setActiveAccount(context, existing)
            return true
        }

        val config = BaseConfigurationFinder(context, LoginCredentials(null, email, password)).findInitialConfiguration()
        if (config.isFailed || config.etebaseSession.isNullOrBlank()) {
            return false
        }

        val account = Account(config.userName, App.accountType)
        if (!accountManager.addAccountExplicitly(account, null, null)) {
            return false
        }

        AccountSettings.setUserData(accountManager, account, config.url, config.userName)
        val settings = AccountSettings(context, account)
        settings.etebaseSession = config.etebaseSession
        settings.setSyncInterval(App.addressBooksAuthority, Constants.DEFAULT_SYNC_INTERVAL.toLong())
        settings.setSyncInterval(CalendarContract.AUTHORITY, Constants.DEFAULT_SYNC_INTERVAL.toLong())
        ContentResolver.setIsSyncable(account, App.addressBooksAuthority, 1)
        ContentResolver.setIsSyncable(account, CalendarContract.AUTHORITY, 1)
        ActiveAccountManager.setActiveAccount(context, account)
        return true
    }
}
