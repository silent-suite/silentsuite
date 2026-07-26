package io.silentsuite.sync.ui.setup

import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Intent
import android.os.Bundle

/** Exact-once adapter from [AuthenticatorDeliveryState] to the Android authenticator binder. */
class AuthenticatorResponseController internal constructor(
    private var delivery: Delivery?,
    savedInstanceState: Bundle?
) {
    interface Delivery { fun continued(); fun result(result: Bundle); fun error(code: Int, message: String) }
    private class FrameworkDelivery(val response: AccountAuthenticatorResponse) : Delivery {
        override fun continued() = response.onRequestContinued()
        override fun result(result: Bundle) = response.onResult(result)
        override fun error(code: Int, message: String) = response.onError(code, message)
    }

    constructor(intent: Intent, savedInstanceState: Bundle?) : this(
        (savedInstanceState?.getParcelable<AccountAuthenticatorResponse>(KEY_RESPONSE)
            ?: intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE))?.let(::FrameworkDelivery),
        savedInstanceState
    )

    private var state = AuthenticatorDeliveryState.restore(
        AuthenticatorDeliveryState.Snapshot(
            savedInstanceState?.getString(KEY_ACCOUNT_NAME),
            savedInstanceState?.getString(KEY_ACCOUNT_TYPE),
            savedInstanceState?.getBoolean(KEY_DELIVERED, false) ?: false
        )
    )

    init {
        if (!state.delivered) delivery?.continued()
    }

    fun complete(account: Account) { state = state.complete(account.name, account.type) }

    /** Delivers the reducer action once. Subsequent calls are reducer no-ops. */
    fun finish() {
        val (terminal, action) = state.finish()
        state = terminal
        when (action) {
            AuthenticatorDeliveryState.Action.None -> Unit
            is AuthenticatorDeliveryState.Action.Result -> delivery?.result(Bundle(2).apply {
                putString(AccountManager.KEY_ACCOUNT_NAME, action.accountName)
                putString(AccountManager.KEY_ACCOUNT_TYPE, action.accountType)
            })
            AuthenticatorDeliveryState.Action.Cancel -> delivery?.error(
                AccountManager.ERROR_CODE_CANCELED, "Account addition canceled"
            )
        }
        if (action !is AuthenticatorDeliveryState.Action.None) delivery = null
    }

    fun onSaveInstanceState(outState: Bundle) {
        (delivery as? FrameworkDelivery)?.let { outState.putParcelable(KEY_RESPONSE, it.response) }
        val snapshot = state.snapshot()
        outState.putString(KEY_ACCOUNT_NAME, snapshot.accountName)
        outState.putString(KEY_ACCOUNT_TYPE, snapshot.accountType)
        outState.putBoolean(KEY_DELIVERED, snapshot.delivered)
    }

    val isCompleted: Boolean get() = state.accountName != null || state.delivered

    companion object {
        const val KEY_RESPONSE = "authenticator_response"
        const val KEY_ACCOUNT_NAME = "authenticator_account_name"
        const val KEY_ACCOUNT_TYPE = "authenticator_account_type"
        const val KEY_DELIVERED = "authenticator_delivered"

        /** Never creates a controller or replays staged success against an obsolete binder. */
        fun cancelObsolete(intent: Intent, saved: Bundle?) {
            val response = saved?.getParcelable<AccountAuthenticatorResponse>(KEY_RESPONSE)
                ?: intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE)
            response?.onError(AccountManager.ERROR_CODE_CANCELED, "Authenticator flow expired")
        }
    }
}
