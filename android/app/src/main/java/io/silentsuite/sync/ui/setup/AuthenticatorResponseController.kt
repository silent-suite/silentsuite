package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Intent
import android.os.Bundle

/**
 * Implements the result side of AccountAuthenticatorActivity without imposing that
 * superclass on LoginActivity. It retains only the framework response and result state.
 */
class AuthenticatorResponseController(intent: Intent, savedInstanceState: Bundle?) {
    private var response: AccountAuthenticatorResponse? =
        savedInstanceState?.getParcelable<AccountAuthenticatorResponse>(KEY_RESPONSE)
            ?: intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE)
    private var result: Bundle? = savedInstanceState?.getBundle(KEY_RESULT)
    private var completed = savedInstanceState?.getBoolean(KEY_COMPLETED, false) ?: false
    private var delivered = savedInstanceState?.getBoolean(KEY_DELIVERED, false) ?: false

    init {
        if (!delivered)
            response?.onRequestContinued()
    }

    fun complete(account: Account) {
        if (completed || delivered) return
        completed = true
        result = Bundle(2).apply {
            putString(AccountManager.KEY_ACCOUNT_NAME, account.name)
            putString(AccountManager.KEY_ACCOUNT_TYPE, account.type)
        }
    }

    /** Delivers the pending account result, or the framework cancellation, exactly once. */
    fun finish() {
        if (delivered) return
        if (result != null)
            response?.onResult(requireNotNull(result))
        else
            response?.onError(AccountManager.ERROR_CODE_CANCELED, "Account addition canceled")
        response = null
        completed = true
        delivered = true
    }

    fun onSaveInstanceState(outState: Bundle) {
        outState.putParcelable(KEY_RESPONSE, response)
        outState.putBundle(KEY_RESULT, result)
        outState.putBoolean(KEY_COMPLETED, completed)
        outState.putBoolean(KEY_DELIVERED, delivered)
    }

    val isCompleted: Boolean
        get() = completed

    private companion object {
        const val KEY_RESPONSE = "authenticator_response"
        const val KEY_RESULT = "authenticator_result"
        const val KEY_COMPLETED = "authenticator_completed"
        const val KEY_DELIVERED = "authenticator_delivered"
    }
}
