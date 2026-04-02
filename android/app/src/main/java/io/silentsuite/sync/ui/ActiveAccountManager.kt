package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.App

object ActiveAccountManager {
    private const val PREFS = "active_account"
    private const val KEY_NAME = "account_name"

    fun getActiveAccount(context: Context): Account? {
        val accountManager = AccountManager.get(context)
        val accounts = accountManager.getAccountsByType(App.accountType)
        if (accounts.isEmpty()) return null
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val savedName = prefs.getString(KEY_NAME, null)
        return accounts.find { it.name == savedName } ?: accounts[0]
    }

    fun setActiveAccount(context: Context, account: Account) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_NAME, account.name).apply()
    }
}
