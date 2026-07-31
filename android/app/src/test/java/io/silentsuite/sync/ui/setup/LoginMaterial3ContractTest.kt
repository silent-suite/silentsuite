package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LoginMaterial3ContractTest {
    private val layout = File("src/main/res/layout/login_credentials_fragment.xml").readText()
    private val strings = File("src/main/res/values/strings.xml").readText()
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val menu = File("src/main/res/menu/activity_login.xml").readText()
    private val fragment = File("src/main/java/io/silentsuite/sync/ui/setup/LoginCredentialsFragment.kt").readText()
    private val styles = File("src/main/res/values/styles.xml").readText()

    @Test
    fun loginActivityAndCombinedCredentialsSurfaceUseMaterial3() {
        val loginActivity = manifest.substringAfter("android:name=\".ui.setup.LoginActivity\"")
            .substringBefore("</activity>")

        assertTrue(loginActivity.contains("android:theme=\"@style/AppTheme.Material3\""))
        assertTrue(menu.contains("android:icon=\"@drawable/ic_help_light\""))
        assertTrue(menu.contains("app:iconTint=\"@color/semantic_on_surface\""))
        assertTrue(layout.contains("android:id=\"@+id/login_brand_mark\""))
        assertTrue(layout.contains("android:src=\"@drawable/ic_silentsuite_arrows\""))
        assertTrue(layout.contains("@style/TextAppearance.AppTheme.FirstRun.Title"))
        assertEquals(10, Regex("@style/TextAppearance.AppTheme.FirstRun.Body").findAll(layout).count())
        assertTrue(styles.contains("<style name=\"TextAppearance.AppTheme.FirstRun.Title\""))
        assertTrue(styles.contains("<item name=\"android:textSize\">24sp</item>"))
        assertTrue(styles.contains("<style name=\"TextAppearance.AppTheme.FirstRun.Body\""))
        assertTrue(styles.contains("<item name=\"android:textSize\">16sp</item>"))
        assertEquals(3, Regex("@style/Widget.AppTheme.Material3.TextInputLayout").findAll(layout).count())
        assertTrue(layout.contains("@style/Widget.AppTheme.Material3.Button"))
    }

    @Test
    fun surfaceClearlySeparatesExistingAccountSignInFromWebsiteSignup() {
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_title\""))
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_supporting_copy\""))
        assertTrue(layout.contains("android:text=\"@string/login_privacy_reassurance\""))
        assertEquals(2, Regex("<com\\.google\\.android\\.material\\.button\\.MaterialButton").findAll(layout).count())
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_and_connect\""))
        assertTrue(layout.indexOf("android:id=\"@+id/login_signup_section\"") < layout.indexOf("android:id=\"@+id/login_existing_account_heading\""))
        assertTrue(layout.indexOf("android:id=\"@+id/login_existing_account_heading\"") < layout.indexOf("android:id=\"@+id/user_name\""))
        assertTrue(layout.indexOf("android:id=\"@+id/login_signup_section\"") < layout.indexOf("android:id=\"@+id/login_action_bar\""))
        assertTrue(strings.contains("<string name=\"login_sign_in_title\">Set up SilentSuite</string>"))
        assertTrue(strings.contains("<string name=\"login_sign_in_supporting_copy\">Sign in with an existing account, or create a new account on the web.</string>"))
        assertTrue(strings.contains("<string name=\"login_sign_in_and_connect\">Sign in and set up sync</string>"))
        assertTrue(strings.contains("<string name=\"login_android_apps_heading\">Works with Android apps</string>"))
        assertTrue(strings.contains("<string name=\"login_calendar_outcome\">Synced events appear in Android Calendar.</string>"))
        assertTrue(strings.contains("<string name=\"login_contacts_outcome\">Synced contacts appear in Android Contacts.</string>"))
        assertTrue(strings.contains("<string name=\"login_tasks_outcome\">Synced tasks appear in Tasks.org or OpenTasks when installed.</string>"))
        assertTrue(strings.contains("<string name=\"login_privacy_reassurance\">Your encryption keys stay on this device.</string>"))
        assertTrue(strings.contains("<string name=\"login_forgot_password\">Forgot password?</string>"))
        assertTrue(strings.contains("<string name=\"login_toggle_advanced\">Use a custom server</string>"))
        assertTrue(strings.contains("<string name=\"login_existing_account_heading\">Already have a SilentSuite account?</string>"))
        assertTrue(strings.contains("<string name=\"login_existing_account_body\">Enter the email address and password for your existing account.</string>"))
        assertTrue(strings.contains("<string name=\"login_signup_heading\">New to SilentSuite?</string>"))
        assertTrue(strings.contains("<string name=\"login_signup_body\">We’ll open the SilentSuite website. After you create your account, you’ll return to this app to finish setup.</string>"))
        assertTrue(strings.contains("<string name=\"login_signup_action\">Create an account on the web</string>"))
        assertFalse(layout.contains("@string/login_bridge_sync"))
        assertFalse(layout.contains("@string/login_bridge_encrypted"))
    }

    @Test
    fun stableBehavioralIdsAndSecretAndDisclosureContractsRemain() {
        listOf(
            "user_name", "url_password", "login_password", "forgot_password", "create_account",
            "show_advanced", "advanced_layout", "custom_server", "login_action_bar", "login",
            "login_existing_account_heading", "login_existing_account_body", "login_signup_section",
            "login_signup_heading", "login_signup_body", "login_scroll"
        ).forEach { id -> assertTrue("Missing stable login ID: $id", layout.contains("android:id=\"@+id/$id\"")) }

        assertTrue(layout.contains("android:autofillHints=\"emailAddress\""))
        assertTrue(layout.contains("android:autofillHints=\"password\""))
        assertTrue(layout.contains("android:saveEnabled=\"false\""))
        assertFalse(layout.contains("android:fontFamily=\"monospace\""))
        assertTrue(layout.contains("android:imeOptions=\"actionDone\""))
        assertTrue(fragment.contains("setOnEditorActionListener"))
        assertTrue(fragment.contains("EditorInfo.IME_ACTION_DONE"))
        assertTrue(fragment.contains("login.performClick()"))
        assertTrue(fragment.contains("KEY_ADVANCED_EXPANDED"))
        assertTrue(fragment.contains("applyLoginActionBarInsets"))
        assertTrue(layout.contains("<net.cachapa.expandablelayout.ExpandableLayout"))
    }
}
