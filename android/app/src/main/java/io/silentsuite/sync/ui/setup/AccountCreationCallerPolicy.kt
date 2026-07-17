package io.silentsuite.sync.ui.setup

/** Maps durable creation outcomes to UI behavior without deciding authenticator delivery. */
object AccountCreationCallerPolicy {
    enum class Disposition { ContinueToSetup, RetryCredentials, ResolveInSettings }
    fun disposition(result: AccountCreationCoordinator.Result): Disposition = when (result) {
        AccountCreationCoordinator.Result.CREATED,
        AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED -> Disposition.ContinueToSetup
        AccountCreationCoordinator.Result.EXISTS_OR_BUSY,
        AccountCreationCoordinator.Result.NOT_ADDED -> Disposition.RetryCredentials
        AccountCreationCoordinator.Result.QUARANTINED,
        AccountCreationCoordinator.Result.QUARANTINE_FAILED -> Disposition.ResolveInSettings
    }
}
