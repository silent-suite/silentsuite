package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LoginMaterial3ContractTest {
    private val choiceLayout = File("src/main/res/layout/account_choice_fragment.xml")
        .takeIf(File::exists)?.readText().orEmpty()
    private val credentialsLayout = File("src/main/res/layout/login_credentials_fragment.xml").readText()
    private val strings = File("src/main/res/values/strings.xml").readText()
    private val manifest = File("src/main/AndroidManifest.xml").readText()
    private val menu = File("src/main/res/menu/activity_login.xml").readText()
    private val credentialsFragment = File("src/main/java/io/silentsuite/sync/ui/setup/LoginCredentialsFragment.kt").readText()
    private val choiceFragment = File("src/main/java/io/silentsuite/sync/ui/setup/AccountChoiceFragment.kt")
        .takeIf(File::exists)?.readText().orEmpty()
    private val styles = File("src/main/res/values/styles.xml").readText()

    @Test
    fun loginActivityAndBothFocusedDestinationsUseMaterial3() {
        val loginActivity = manifest.substringAfter("android:name=\".ui.setup.LoginActivity\"")
            .substringBefore("</activity>")

        assertTrue(loginActivity.contains("android:theme=\"@style/AppTheme.Material3\""))
        assertTrue(menu.contains("android:icon=\"@drawable/ic_help_light\""))
        assertTrue(menu.contains("app:iconTint=\"@color/semantic_on_surface\""))
        assertTrue(choiceLayout.contains("android:id=\"@+id/account_choice_brand_mark\""))
        assertTrue(choiceLayout.contains("android:src=\"@drawable/ic_silentsuite_arrows\""))
        assertTrue(choiceLayout.contains("@style/TextAppearance.AppTheme.FirstRun.Title"))
        assertTrue(credentialsLayout.contains("@style/TextAppearance.AppTheme.FirstRun.Title"))
        assertTrue(styles.contains("<style name=\"TextAppearance.AppTheme.FirstRun.Title\""))
        assertTrue(styles.contains("<item name=\"android:textSize\">24sp</item>"))
        assertTrue(styles.contains("<style name=\"TextAppearance.AppTheme.FirstRun.Body\""))
        assertTrue(styles.contains("<item name=\"android:textSize\">16sp</item>"))
        assertEquals(3, Regex("@style/Widget.AppTheme.Material3.TextInputLayout").findAll(credentialsLayout).count())
        assertTrue(choiceLayout.contains("@style/Widget.AppTheme.Material3.Button"))
        assertTrue(credentialsLayout.contains("@style/Widget.AppTheme.Material3.Button"))
        assertTrue(styles.contains("Widget.Material3.TextInputLayout.OutlinedBox"))
    }

    @Test
    fun choiceAndCredentialsExposeOnlyTheirFocusedActionsAndCopy() {
        assertEquals(2, Regex("<com\\.google\\.android\\.material\\.button\\.MaterialButton").findAll(choiceLayout).count())
        assertTrue(choiceLayout.contains("android:text=\"@string/account_choice_sign_in\""))
        assertTrue(choiceLayout.contains("android:text=\"@string/login_signup_action\""))
        assertTrue(choiceLayout.contains("android:text=\"@string/account_choice_privacy\""))
        assertTrue(credentialsLayout.contains("android:text=\"@string/login_sign_in_and_connect\""))
        assertTrue(credentialsLayout.contains("android:text=\"@string/login_privacy_reassurance\""))
        assertFalse(credentialsLayout.contains("login_signup"))
        assertFalse(credentialsLayout.contains("create_account"))
        assertFalse(credentialsLayout.contains("login_android_apps"))
        assertFalse(choiceLayout.contains("user_name"))
        assertFalse(choiceLayout.contains("login_password"))
        assertFalse(choiceLayout.contains("forgot_password"))
        assertFalse(choiceLayout.contains("custom_server"))
        assertTrue(strings.contains("<string name=\"account_choice_title\">Sync privately with Android apps</string>"))
        assertTrue(strings.contains("<string name=\"account_choice_sign_in\">Sign in</string>"))
        assertTrue(strings.contains("<string name=\"account_choice_calendar\">Synced events appear in compatible calendar apps on this device.</string>"))
        assertTrue(strings.contains("<string name=\"account_choice_contacts\">Synced contacts appear in compatible contacts apps on this device.</string>"))
        assertTrue(strings.contains("<string name=\"account_choice_tasks\">Synced tasks appear in Tasks.org or OpenTasks when installed.</string>"))
        assertTrue(strings.contains("<string name=\"login_sign_in_and_connect\">Sign in and set up sync</string>"))
        assertTrue(strings.contains("<string name=\"login_privacy_reassurance\">Your encryption keys stay on this device.</string>"))
        assertTrue(strings.contains("<string name=\"login_forgot_password\">Forgot password?</string>"))
        assertTrue(strings.contains("<string name=\"login_toggle_advanced\">Use a custom server</string>"))
        assertTrue(strings.contains("<string name=\"login_existing_account_heading\">Existing account</string>"))
        assertTrue(strings.contains("<string name=\"login_signup_action\">Create an account on the web</string>"))
    }

    @Test
    fun stableCredentialIdsAndChoiceAccessibilityContractsRemain() {
        listOf(
            "user_name", "url_password", "login_password", "forgot_password",
            "show_advanced", "advanced_layout", "custom_server", "login_action_bar", "login",
            "login_existing_account_heading", "login_scroll"
        ).forEach { id -> assertTrue("Missing stable login ID: $id", credentialsLayout.contains("android:id=\"@+id/$id\"")) }
        listOf(
            "account_choice_scroll", "account_choice_heading", "account_choice_privacy",
            "account_choice_calendar", "account_choice_contacts", "account_choice_tasks",
            "account_choice_sign_in", "account_choice_create_account"
        ).forEach { id -> assertTrue("Missing account-choice ID: $id", choiceLayout.contains("android:id=\"@+id/$id\"")) }

        assertTrue(credentialsLayout.contains("android:autofillHints=\"emailAddress\""))
        assertTrue(credentialsLayout.contains("android:autofillHints=\"password\""))
        assertTrue(credentialsLayout.contains("android:saveEnabled=\"false\""))
        assertFalse(credentialsLayout.contains("android:fontFamily=\"monospace\""))
        assertTrue(credentialsLayout.contains("android:imeOptions=\"actionDone\""))
        assertTrue(credentialsFragment.contains("setOnEditorActionListener"))
        assertTrue(credentialsFragment.contains("EditorInfo.IME_ACTION_DONE"))
        assertTrue(credentialsFragment.contains("login.performClick()"))
        assertTrue(credentialsFragment.contains("KEY_ADVANCED_EXPANDED"))
        assertTrue(credentialsFragment.contains("applyLoginActionBarInsets"))
        assertFalse(credentialsFragment.contains("issueSignupCallbackUri"))
        assertTrue(choiceFragment.contains("ViewCompat.setAccessibilityHeading"))
        assertTrue(choiceFragment.contains("requestSignIn"))
        assertTrue(choiceFragment.contains("requestHostedSignup"))
        assertTrue(credentialsLayout.contains("<net.cachapa.expandablelayout.ExpandableLayout"))
    }
}
