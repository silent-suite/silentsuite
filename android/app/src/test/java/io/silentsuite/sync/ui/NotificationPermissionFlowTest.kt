package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class NotificationPermissionFlowTest {
    @Test fun initialLaunchRequestsNotificationsBeforeOtherRuntimePermissions() {
        val flow = NotificationPermissionFlow()
        assertEquals(NotificationPermissionFlow.Action.LAUNCH_NOTIFICATION_REQUEST, flow.start(notificationRequestNeeded = true))
        assertEquals(NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS, flow.onNotificationResult())
    }

    @Test fun recreationWhileDialogIsPendingDoesNotStartAnotherPermissionFlow() {
        val flow = NotificationPermissionFlow(notificationRequestPending = true)
        assertEquals(NotificationPermissionFlow.Action.WAIT_FOR_NOTIFICATION_RESULT, flow.start(notificationRequestNeeded = true))
    }

    @Test fun recreatedResultContinuesExactlyOnce() {
        val flow = NotificationPermissionFlow(notificationRequestPending = true)
        assertEquals(NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS, flow.onNotificationResult())
        assertEquals(NotificationPermissionFlow.Action.NONE, flow.start(notificationRequestNeeded = false))
    }

    @Test fun denialNeverRepromptsAndStillContinues() {
        val flow = NotificationPermissionFlow(notificationRequestPending = true)
        assertEquals(NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS, flow.onNotificationResult())
        assertEquals(NotificationPermissionFlow.Action.NONE, flow.start(notificationRequestNeeded = false))
    }

    @Test fun api32AndGrantedPathsContinueWithoutARequest() {
        assertEquals(NotificationPermissionFlow.Action.CONTINUE_RUNTIME_PERMISSIONS,
            NotificationPermissionFlow().start(notificationRequestNeeded = false))
    }
}
