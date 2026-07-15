package io.silentsuite.sync.ui.setup

/** Pure AOSP-safe policy: a restored binder is valid only in the same app process. */
object AuthenticatorRestorePolicy {
    fun mustRestartNormally(restoredAuthenticator: Boolean, savedEpoch: String?, processEpoch: String): Boolean =
        restoredAuthenticator && savedEpoch != processEpoch
}
