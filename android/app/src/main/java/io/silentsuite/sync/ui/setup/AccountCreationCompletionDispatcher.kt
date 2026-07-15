package io.silentsuite.sync.ui.setup

/** Plain caller-level dispatch after an exact durable account-id readback. */
class AccountCreationCompletionDispatcher(private val seams: Seams) {
    enum class Kind { Setup, Dashboard, Retry }
    interface Seams { fun stageExact(name: String, type: String, id: String): Boolean; fun openSetup(); fun openDashboard(); fun finish() }
    fun dispatch(kind: Kind, name: String, type: String, id: String): Boolean {
        if (kind == Kind.Retry || !seams.stageExact(name, type, id)) return false
        if (kind == Kind.Setup) seams.openSetup() else seams.openDashboard()
        seams.finish()
        return true
    }
}
