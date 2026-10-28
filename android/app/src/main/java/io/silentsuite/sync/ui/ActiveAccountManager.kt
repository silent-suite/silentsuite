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
    @JvmField internal var afterExactSetCommitForTest: (() -> Unit)? = null

    fun getActiveAccount(context: Context): Account? =
        getActiveIdentity(context)?.let { Account(it.name, it.type) }

    /** The selected account with the generation captured at selection; callers must not re-read it. */
    fun getActiveIdentity(context: Context): ExactAccountIdentity? {
        val accountManager = AccountManager.get(context)
        val accounts = accountManager.getAccountsByType(App.accountType)
        if (accounts.isEmpty()) return null
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val savedName = prefs.getString(KEY_NAME, null)
        val savedCreationId = prefs.getString(KEY_CREATION_ID, null)
        // Raw membership, before generation filtering: a same-name row with any generation, or none, is present.
        val savedNamePresent = accounts.any { it.name == savedName }
        val eligible = accounts.mapNotNull { account ->
            accountManager.getUserData(account, AccountSettings.KEY_CREATION_ID)
                ?.takeIf { it.isNotBlank() }?.let { ActiveAccountRoutingPolicy.Candidate(account.name, it) }
        }
        val selected = ActiveAccountRoutingPolicy.select(savedName, savedCreationId, savedNamePresent, eligible)
            ?: return null
        val identity = ExactAccountIdentity(App.accountType, selected.name, selected.creationId)
        if (ActiveAccountRoutingPolicy.savedNameAbsent(savedName, savedCreationId, savedNamePresent)) {
            val saved = ExactAccountIdentity(App.accountType, requireNotNull(savedName), requireNotNull(savedCreationId))
            return identity.takeIf { replaceAbsentSaved(context, saved, identity) }
        }
        if (savedName == identity.name && savedCreationId == null && !setActiveAccount(context, identity))
            return null
        return identity
    }

    /**
     * Moves the preference from [saved], whose name has no row any more, to the selected [chosen] generation.
     * A concurrent writer's value is kept, and a [chosen] row replaced after the commit is never adopted:
     * only the identity this attempt wrote is cleared then.
     */
    private fun replaceAbsentSaved(context: Context, saved: ExactAccountIdentity, chosen: ExactAccountIdentity): Boolean {
        if (!replaceIfActive(context, saved, chosen)) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_NAME, null) != chosen.name || prefs.getString(KEY_CREATION_ID, null) != chosen.creationId)
            return false

        afterExactSetCommitForTest?.invoke()
        val manager = AccountManager.get(context)
        val account = Account(chosen.name, chosen.type)
        val stillExact = account in manager.getAccountsByType(App.accountType) &&
            manager.getUserData(account, AccountSettings.KEY_CREATION_ID) == chosen.creationId
        if (!stillExact) {
            clearIfActive(context, chosen.name, chosen.creationId)
            return false
        }
        return true
    }

    fun setActiveAccount(context: Context, account: Account): Boolean {
        val manager = AccountManager.get(context)
        if (account.type != App.accountType || account !in manager.getAccountsByType(App.accountType)) return false
        val creationId = manager.getUserData(account, AccountSettings.KEY_CREATION_ID) ?: return false
        return setActiveAccount(context, ExactAccountIdentity(account.type, account.name, creationId))
    }

    fun setActiveAccount(context: Context, identity: ExactAccountIdentity): Boolean {
        val manager = AccountManager.get(context)
        val account = Account(identity.name, identity.type)
        if (identity.type != App.accountType || account !in manager.getAccountsByType(App.accountType) ||
            manager.getUserData(account, AccountSettings.KEY_CREATION_ID) != identity.creationId) return false
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val written = prefs.edit().putString(KEY_NAME, identity.name)
            .putString(KEY_CREATION_ID, identity.creationId).commit() &&
            prefs.getString(KEY_NAME, null) == identity.name &&
            prefs.getString(KEY_CREATION_ID, null) == identity.creationId
        if (!written) return false

        afterExactSetCommitForTest?.invoke()
        val stillExact = account in manager.getAccountsByType(App.accountType) &&
            manager.getUserData(account, AccountSettings.KEY_CREATION_ID) == identity.creationId
        if (!stillExact) {
            clearIfActive(context, identity.name, identity.creationId)
            return false
        }
        return true
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

    /** Replace only the exact active generation; a concurrently selected sibling is preserved. */
    fun replaceIfActive(
        context: Context,
        expected: ExactAccountIdentity,
        replacement: ExactAccountIdentity?
    ): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val decision = ActiveAccountReplacementPolicy.decide(
            prefs.getString(KEY_NAME, null), prefs.getString(KEY_CREATION_ID, null), expected, replacement)
        if (decision is ActiveAccountReplacementDecision.Preserve) return true
        val chosen = (decision as ActiveAccountReplacementDecision.Replace).identity
        if (chosen != null) {
            val account = Account(chosen.name, chosen.type)
            val manager = AccountManager.get(context)
            if (chosen.type != App.accountType || account !in manager.getAccountsByType(chosen.type) ||
                manager.getUserData(account, AccountSettings.KEY_CREATION_ID) != chosen.creationId) return false
        }
        val edit = prefs.edit()
        if (chosen == null) edit.remove(KEY_NAME).remove(KEY_CREATION_ID)
        else edit.putString(KEY_NAME, chosen.name).putString(KEY_CREATION_ID, chosen.creationId)
        if (!edit.commit()) return false
        return prefs.getString(KEY_NAME, null) == chosen?.name &&
            prefs.getString(KEY_CREATION_ID, null) == chosen?.creationId
    }
}
