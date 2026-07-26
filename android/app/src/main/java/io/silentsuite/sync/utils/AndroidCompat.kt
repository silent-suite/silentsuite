package io.silentsuite.sync.utils

import android.accounts.Account
import android.accounts.AccountManager
import android.os.Build
import android.os.Handler
import android.os.Looper

object AndroidCompat {
    fun removeAccount(accountManager: AccountManager, account: Account) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            accountManager.removeAccountExplicitly(account)
        } else {
            accountManager.removeAccount(account, null, null)
        }
    }
    fun removeAccount(accountManager: AccountManager, account: Account, callback: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            val confirmed = runCatching { accountManager.removeAccountExplicitly(account) }.getOrDefault(false)
            Handler(Looper.getMainLooper()).post { callback(confirmed) }
        } else {
            accountManager.removeAccount(account, android.accounts.AccountManagerCallback<Boolean> { future ->
                callback(runCatching { future.result }.getOrDefault(false))
            }, Handler(Looper.getMainLooper()))
        }
    }
}
