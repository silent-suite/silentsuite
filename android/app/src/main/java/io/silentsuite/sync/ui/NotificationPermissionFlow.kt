package io.silentsuite.sync.ui

/**
 * Saved-state controller for the ordered startup permission sequence.  The pending bit is owned
 * by AccountActivity's ActivityResultRegistry registration; it is deliberately distinct from the
 * permanent "asked" preference, which prevents notification-permission nagging after denial.
 */
internal class NotificationPermissionFlow(
    var notificationRequestPending: Boolean = false,
    var runtimePermissionFlowStarted: Boolean = false
) {
    enum class Action { LAUNCH_NOTIFICATION_REQUEST, WAIT_FOR_NOTIFICATION_RESULT, CONTINUE_RUNTIME_PERMISSIONS, NONE }

    fun start(notificationRequestNeeded: Boolean): Action = when {
        notificationRequestPending -> Action.WAIT_FOR_NOTIFICATION_RESULT
        notificationRequestNeeded -> {
            notificationRequestPending = true
            Action.LAUNCH_NOTIFICATION_REQUEST
        }
        else -> continueRuntimePermissions()
    }

    fun onNotificationResult(): Action {
        notificationRequestPending = false
        return continueRuntimePermissions()
    }

    private fun continueRuntimePermissions(): Action =
        if (runtimePermissionFlowStarted) Action.NONE else {
            runtimePermissionFlowStarted = true
            Action.CONTINUE_RUNTIME_PERMISSIONS
        }
}
