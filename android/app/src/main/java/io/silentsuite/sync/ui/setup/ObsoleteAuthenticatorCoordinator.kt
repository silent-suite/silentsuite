package io.silentsuite.sync.ui.setup

/** Injectable ordering seam: obsolete binder cancellation happens before controller creation. */
class ObsoleteAuthenticatorCoordinator(private val seams: Seams) {
    interface Seams { fun cancel(); fun clearSecrets(); fun launchNormalOnce() }
    fun handle() { seams.cancel(); seams.clearSecrets(); seams.launchNormalOnce() }
}
