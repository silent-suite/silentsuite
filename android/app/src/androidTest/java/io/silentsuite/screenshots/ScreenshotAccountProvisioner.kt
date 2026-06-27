package io.silentsuite.screenshots

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import android.content.ContentResolver
import android.provider.CalendarContract
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.App
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
            throw IllegalStateException("Screenshot account credentials missing")
        }

        val accountManager = AccountManager.get(context)
        val existing = accountManager.getAccountsByType(App.accountType).firstOrNull { it.name == email }
        if (existing != null) {
            ActiveAccountManager.setActiveAccount(context, existing)
            return true
        }

        val config = BaseConfigurationFinder(context, LoginCredentials(null, email, password)).findInitialConfiguration()
        if (config.isFailed || config.etebaseSession.isNullOrBlank()) {
            throw IllegalStateException("Screenshot Etebase login/config failed: " + (config.error?.javaClass?.name ?: "empty session"))
        }

        val account = Account(config.userName, App.accountType)
        if (!accountManager.addAccountExplicitly(account, null, null)) {
            throw IllegalStateException("Screenshot Android account creation failed")
        }

        AccountSettings.setUserData(accountManager, account, config.url, config.userName)
        val settings = AccountSettings(context, account)
        settings.etebaseSession = config.etebaseSession
        // Store screenshots exercise the UI and Etebase account session, not Android's
        // background sync adapters. Keep background sync disabled during instrumentation
        // so calendar/contact sync cannot crash or race the capture flow.
        ContentResolver.setIsSyncable(account, App.addressBooksAuthority, 0)
        ContentResolver.setIsSyncable(account, CalendarContract.AUTHORITY, 0)
        ContentResolver.setSyncAutomatically(account, App.addressBooksAuthority, false)
        ContentResolver.setSyncAutomatically(account, CalendarContract.AUTHORITY, false)
        ActiveAccountManager.setActiveAccount(context, account)
        return true
    }
}
