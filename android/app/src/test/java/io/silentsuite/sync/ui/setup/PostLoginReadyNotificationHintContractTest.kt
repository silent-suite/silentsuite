package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The sync overview asks for notification permission right after setup. The "Ready" step must
 * say why first, and only while that request is still going to happen.
 */
class PostLoginReadyNotificationHintContractTest {
    private val main = File("src/main")

    @Test
    fun readyStepExplainsTheNotificationRequest() {
        val strings = File(main, "res/values/strings.xml").readText()
        val layout = File(main, "res/layout/activity_post_login_setup.xml").readText()
        val activity = File(main, "java/io/silentsuite/sync/ui/setup/PostLoginSetupActivity.kt").readText()

        assertTrue(strings.contains(
            "<string name=\"post_login_ready_notifications\">Allow notifications so SilentSuite " +
                "can tell you when sync needs attention.</string>"
        ))
        val hint = layout.substringAfter("android:id=\"@+id/setup_notification_hint\"").substringBefore("/>")
        assertTrue(hint.contains("android:text=\"@string/post_login_ready_notifications\""))
        assertTrue(hint.contains("android:visibility=\"gone\""))
        assertTrue(Regex(
            """R\.id\.setup_notification_hint\)\.visibility = visible\(\s*current == PostLoginSetupState\.READY && """ +
                """NotificationUtils\.shouldRequestPermission\(this\)\s*\)"""
        ).containsMatchIn(activity))
    }
}
