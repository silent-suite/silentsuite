package io.silentsuite.sync.ui.setup

/**
 * Framework-free result reducer.  It is deliberately the source of truth for the
 * authenticator protocol; Android [android.accounts.Account] and [android.os.Bundle]
 * are converted only by AuthenticatorResponseController at its edges.
 */
data class AuthenticatorDeliveryState(
    val accountName: String? = null,
    val accountType: String? = null,
    val delivered: Boolean = false
) {
    data class Snapshot(val accountName: String?, val accountType: String?, val delivered: Boolean)
    sealed class Action {
        object None : Action()
        data class Result(val accountName: String, val accountType: String) : Action()
        object Cancel : Action()
    }

    /** A terminal or already-staged state cannot be changed by a second completion. */
    fun complete(name: String, type: String): AuthenticatorDeliveryState =
        if (delivered || accountName != null || name.isBlank() || type.isBlank()) this
        else copy(accountName = name, accountType = type)

    /** Returns the one framework delivery to make, and the immutable terminal state. */
    fun finish(): Pair<AuthenticatorDeliveryState, Action> {
        if (delivered) return this to Action.None
        val terminal = copy(delivered = true)
        return if (accountName != null && accountType != null)
            terminal to Action.Result(accountName, accountType)
        else terminal to Action.Cancel
    }

    fun snapshot() = Snapshot(accountName, accountType, delivered)

    companion object {
        fun restore(snapshot: Snapshot) = AuthenticatorDeliveryState(
            snapshot.accountName,
            snapshot.accountType,
            snapshot.delivered
        )
    }
}
