package io.silentsuite.sync.utils

import android.accounts.Account
import android.accounts.AccountManager
import android.os.Handler
import android.os.Looper
import io.silentsuite.sync.App

object AndroidCompat {
    fun removeAccount(accountManager: AccountManager, account: Account) {
        if (account.type == App.accountType) AccountRowChanges.mainType.before()
        accountManager.removeAccountExplicitly(account)
    }
    fun removeAccount(accountManager: AccountManager, account: Account, callback: (Boolean) -> Unit) {
        if (account.type == App.accountType) AccountRowChanges.mainType.before()
        val confirmed = runCatching { accountManager.removeAccountExplicitly(account) }.getOrDefault(false)
        Handler(Looper.getMainLooper()).post { callback(confirmed) }
    }
}
