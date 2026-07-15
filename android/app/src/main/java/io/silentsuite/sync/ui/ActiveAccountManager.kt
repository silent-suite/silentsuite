package io.silentsuite.sync.ui

import android.accounts.Account
import android.accounts.AccountManager
import android.content.Context
import io.silentsuite.sync.App
import io.silentsuite.sync.AccountSettings

object ActiveAccountManager {
    private const val PREFS = "active_account"
    private const val KEY_NAME = "account_name"
    private const val KEY_CREATION_ID = "creation_id"

    fun getActiveAccount(context: Context): Account? {
        val accountManager = AccountManager.get(context)
        val accounts = accountManager.getAccountsByType(App.accountType)
        if (accounts.isEmpty()) return null
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val savedName = prefs.getString(KEY_NAME, null)
        val savedCreationId = prefs.getString(KEY_CREATION_ID, null)
        val eligible = accounts.mapNotNull { account ->
            accountManager.getUserData(account, AccountSettings.KEY_CREATION_ID)
                ?.takeIf { it.isNotBlank() }?.let { ActiveAccountRoutingPolicy.Candidate(account.name, it) to account }
        }
        val selected = ActiveAccountRoutingPolicy.select(savedName, savedCreationId, eligible.map { it.first })
        val account = eligible.firstOrNull { it.first == selected }?.second
        if (account != null && savedName == account.name && savedCreationId == null && !setActiveAccount(context, account))
            return null
        return account
    }

    fun setActiveAccount(context: Context, account: Account): Boolean {
        val manager = AccountManager.get(context)
        if (account.type != App.accountType || account !in manager.getAccountsByType(App.accountType)) return false
        val creationId = manager.getUserData(account, AccountSettings.KEY_CREATION_ID) ?: return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.edit().putString(KEY_NAME, account.name).putString(KEY_CREATION_ID, creationId).commit() &&
            prefs.getString(KEY_NAME, null) == account.name && prefs.getString(KEY_CREATION_ID, null) == creationId
    }

    fun clearActiveAccount(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY_NAME).remove(KEY_CREATION_ID).commit()
    }
    fun clearIfActive(context: Context, expectedName: String, expectedGeneration: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_NAME, null) != expectedName || prefs.getString(KEY_CREATION_ID, null) != expectedGeneration) return true
        return prefs.edit().remove(KEY_NAME).remove(KEY_CREATION_ID).commit() &&
            prefs.getString(KEY_NAME, null) == null && prefs.getString(KEY_CREATION_ID, null) == null
    }
}
