package io.silentsuite.sync.utils

import android.accounts.Account
import android.accounts.AccountManager
import android.os.Handler
import android.os.Looper

object AndroidCompat {
    fun removeAccount(accountManager: AccountManager, account: Account) {
        accountManager.removeAccountExplicitly(account)
    }
    fun removeAccount(accountManager: AccountManager, account: Account, callback: (Boolean) -> Unit) {
        val confirmed = runCatching { accountManager.removeAccountExplicitly(account) }.getOrDefault(false)
        Handler(Looper.getMainLooper()).post { callback(confirmed) }
    }
}
