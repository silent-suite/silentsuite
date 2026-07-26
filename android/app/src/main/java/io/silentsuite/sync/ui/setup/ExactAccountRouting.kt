package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountManager
import io.silentsuite.sync.AccountSettings

/** Name-only identity is unsafe: account type and current AccountManager membership are required. */
object ExactAccountRouting {
    /** creationId distinguishes a removed/re-added same-name Android account. */
    data class Identity(val name: String, val type: String, val creationId: String?)
    fun validate(candidate: Identity?, appType: String, current: Collection<Identity>): Identity? =
        candidate?.takeIf { it.type == appType && !it.creationId.isNullOrBlank() && it in current }

    fun validate(candidate: Account?, expectedCreationId: String?, appType: String, manager: AccountManager): Account? {
        val current = manager.getAccountsByType(appType)
        val identity = candidate?.let { Identity(it.name, it.type, expectedCreationId) }
        val identities = current.map { Identity(it.name, it.type, manager.getUserData(it, AccountSettings.KEY_CREATION_ID)) }
        return validate(identity, appType, identities)?.let { candidate }
    }
}
