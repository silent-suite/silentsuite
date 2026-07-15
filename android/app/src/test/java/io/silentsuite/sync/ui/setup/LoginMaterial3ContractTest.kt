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
    private val fragment = File("src/main/java/io/silentsuite/sync/ui/setup/LoginCredentialsFragment.kt").readText()

    @Test
    fun loginActivityAndCombinedCredentialsSurfaceUseMaterial3() {
        val loginActivity = manifest.substringAfter("android:name=\".ui.setup.LoginActivity\"")
            .substringBefore("</activity>")

        assertTrue(loginActivity.contains("android:theme=\"@style/AppTheme.Material3\""))
        assertTrue(layout.contains("@style/TextAppearance.AppTheme.Material3.Title"))
        assertTrue(layout.contains("@style/TextAppearance.AppTheme.Material3.Body"))
        assertEquals(3, Regex("@style/Widget.AppTheme.Material3.TextInputLayout").findAll(layout).count())
        assertTrue(layout.contains("@style/Widget.AppTheme.Material3.Button"))
    }

    @Test
    fun surfaceHasOneClearCombinedSignInActionAndCompactSupportingCopy() {
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_title\""))
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_supporting_copy\""))
        assertTrue(layout.contains("android:text=\"@string/login_privacy_reassurance\""))
        assertEquals(1, Regex("<com\\.google\\.android\\.material\\.button\\.MaterialButton").findAll(layout).count())
        assertTrue(layout.contains("android:text=\"@string/login_sign_in_and_connect\""))
        assertTrue(strings.contains("<string name=\"login_sign_in_and_connect\">Sign in and connect</string>"))
        assertTrue(strings.contains("<string name=\"login_forgot_password\">Forgot password?</string>"))
        assertTrue(strings.contains("<string name=\"login_toggle_advanced\">Custom server</string>"))
        assertTrue(strings.contains("<string name=\"login_signup_prompt\">Don\\'t have an account? Sign up</string>"))
        assertFalse(layout.contains("@string/login_bridge_sync"))
        assertFalse(layout.contains("@string/login_bridge_encrypted"))
    }

    @Test
    fun stableBehavioralIdsAndSecretAndDisclosureContractsRemain() {
        listOf(
            "user_name", "url_password", "login_password", "forgot_password", "create_account",
            "show_advanced", "advanced_layout", "custom_server", "login_action_bar", "login"
        ).forEach { id -> assertTrue("Missing stable login ID: $id", layout.contains("android:id=\"@+id/$id\"")) }

        assertTrue(layout.contains("android:autofillHints=\"emailAddress\""))
        assertTrue(layout.contains("android:autofillHints=\"password\""))
        assertTrue(layout.contains("android:saveEnabled=\"false\""))
        assertTrue(layout.contains("android:imeOptions=\"actionDone\""))
        assertTrue(fragment.contains("setOnEditorActionListener"))
        assertTrue(fragment.contains("EditorInfo.IME_ACTION_DONE"))
        assertTrue(fragment.contains("login.performClick()"))
        assertTrue(fragment.contains("KEY_ADVANCED_EXPANDED"))
        assertTrue(fragment.contains("applyLoginActionBarInsets"))
        assertTrue(layout.contains("<net.cachapa.expandablelayout.ExpandableLayout"))
    }
}
