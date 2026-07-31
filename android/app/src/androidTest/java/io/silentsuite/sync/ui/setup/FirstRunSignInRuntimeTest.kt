package io.silentsuite.sync.ui.setup

import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageView
import android.widget.TextView
import android.widget.ScrollView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.view.ViewCompat
import io.silentsuite.sync.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FirstRunSignInRuntimeTest {
    @Test
    fun combinedSignInKeepsPrimaryActionReachableAndSecretsOutOfSavedState() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    val root = activity.findViewById<ViewGroup>(android.R.id.content)
                    val brandMark = activity.findViewById<ImageView>(requiredId(activity, "login_brand_mark"))
                    val title = findText(root, "Set up SilentSuite")
                    val support = findText(
                        root,
                        "Sign in with an existing account, or create a new account on the web."
                    )
                    val privacy = findText(
                        root,
                        "Your encryption keys stay on this device."
                    )
                    findText(root, "Synced events appear in Android Calendar.")
                    findText(root, "Synced contacts appear in Android Contacts.")
                    findText(root, "Synced tasks appear in Tasks.org or OpenTasks when installed.")
                    val email = activity.findViewById<EditText>(R.id.user_name)
                    val password = activity.findViewById<EditText>(R.id.login_password)
                    val primary = activity.findViewById<TextView>(R.id.login)
                    val existingHeading = activity.findViewById<TextView>(R.id.login_existing_account_heading)
                    val existingBody = activity.findViewById<TextView>(R.id.login_existing_account_body)
                    val signupHeading = activity.findViewById<TextView>(R.id.login_signup_heading)
                    val signupBody = activity.findViewById<TextView>(R.id.login_signup_body)
                    val signupSection = activity.findViewById<ViewGroup>(R.id.login_signup_section)
                    val loginScroll = activity.findViewById<ScrollView>(R.id.login_scroll)
                    val createAccount = activity.findViewById<TextView>(R.id.create_account)
                    val customServerDisclosure = activity.findViewById<TextView>(R.id.show_advanced)
                    val actionBar = activity.findViewById<ViewGroup>(R.id.login_action_bar)
                    val density = activity.resources.displayMetrics.density
                    val scaledDensity = activity.resources.displayMetrics.scaledDensity

                    assertTrue(brandMark.drawable != null)
                    assertTrue(maxOf(brandMark.width, brandMark.minimumWidth) >= (44 * density).toInt())
                    assertTrue(maxOf(brandMark.height, brandMark.minimumHeight) >= (44 * density).toInt())
                    assertEquals(24f, title.textSize / scaledDensity, 0.25f)
                    listOf(
                        support, privacy, existingHeading, existingBody, signupHeading, signupBody,
                        email, password,
                    ).forEach {
                        assertEquals(16f, it.textSize / scaledDensity, 0.25f)
                    }
                    assertEquals("Already have a SilentSuite account?", existingHeading.text.toString())
                    assertEquals(
                        "Enter the email address and password for your existing account.",
                        existingBody.text.toString(),
                    )
                    assertEquals("New to SilentSuite?", signupHeading.text.toString())
                    assertTrue(ViewCompat.isAccessibilityHeading(existingHeading))
                    assertTrue(ViewCompat.isAccessibilityHeading(signupHeading))
                    assertEquals(
                        "We’ll open the SilentSuite website. After you create your account, " +
                            "you’ll return to this app to finish setup.",
                        signupBody.text.toString(),
                    )
                    assertNotEquals(Typeface.MONOSPACE, password.typeface)
                    assertEquals("Sign in and set up sync", primary.text.toString())
                    assertTrue(primary.minimumHeight >= (48 * density).toInt())
                    assertEquals(actionBar, primary.parent)
                    assertTrue(isDescendantOf(signupSection, loginScroll))
                    val signupBounds = Rect()
                    assertTrue(signupSection.getGlobalVisibleRect(signupBounds))
                    assertTrue(signupBounds.height() > 0)
                    assertEquals("Create an account on the web", createAccount.text.toString())
                    assertTrue(createAccount.minimumHeight >= (48 * density).toInt())
                    assertTrue(createAccount.isClickable)
                    assertTrue(customServerDisclosure.compoundDrawablesRelative[2] != null)
                    assertEquals(0, activity.findViewById<View>(R.id.advanced_layout).height)

                    email.setText("first-run-${System.nanoTime()}@example.invalid")
                    password.setText("process-only-fixture")
                    password.requestFocus()
                    (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
                        .showSoftInput(password, InputMethodManager.SHOW_IMPLICIT)
                    assertTrue(primary.isShown)
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    assertEquals("", activity.findViewById<EditText>(R.id.login_password).text.toString())
                    assertFalse(activity.intent.extras?.keySet().orEmpty().any {
                        it.contains("password", ignoreCase = true) ||
                            it.contains("credential", ignoreCase = true) ||
                            it.contains("session", ignoreCase = true)
                    })
                }
            }
        } finally {
            LoginActivity.controllerFactory = null
            SetupSecretHolder.clearProcessOnlySecrets()
        }
    }

    @Test
    fun normalAndAuthenticatorModesUseOneCombinedCredentialSurfaceAcrossRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        try {
            val normal = Intent(context, LoginActivity::class.java)
            val authenticator = Intent(context, LoginActivity::class.java)
                .putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, true)

            assertEquals(surfaceFingerprint(normal), surfaceFingerprint(authenticator))
            assertFalse(normal.hasExtra("password"))
            assertFalse(authenticator.extras?.keySet().orEmpty().any {
                it.contains("password", ignoreCase = true) ||
                    it.contains("credential", ignoreCase = true) ||
                    it.contains("session", ignoreCase = true)
            })
        } finally {
            LoginActivity.controllerFactory = null
            SetupSecretHolder.clearProcessOnlySecrets()
        }
    }

    private fun surfaceFingerprint(intent: Intent): List<String> {
        val stableIds = listOf(
            R.id.user_name,
            R.id.url_password,
            R.id.login_password,
            R.id.login_existing_account_heading,
            R.id.login_existing_account_body,
            R.id.forgot_password,
            R.id.create_account,
            R.id.login_signup_section,
            R.id.login_signup_heading,
            R.id.login_signup_body,
            R.id.login_scroll,
            R.id.show_advanced,
            R.id.advanced_layout,
            R.id.custom_server,
            R.id.login_action_bar,
            R.id.login,
        )
        val snapshots = mutableListOf<List<String>>()
        ActivityScenario.launch<LoginActivity>(intent).use { scenario ->
            repeat(2) { pass ->
                scenario.onActivity { activity ->
                    assertEquals(
                        1,
                        activity.supportFragmentManager.fragments
                            .filterIsInstance<LoginCredentialsFragment>().size
                    )
                    snapshots += stableIds.map { id ->
                        val view = activity.findViewById<View>(id)
                        "${activity.resources.getResourceEntryName(view.id)}:${view.javaClass.simpleName}"
                    }
                    val root = activity.findViewById<ViewGroup>(android.R.id.content)
                    findText(root, "Set up SilentSuite")
                    findText(
                        root,
                        "Sign in with an existing account, or create a new account on the web."
                    )
                    findText(root, "Sign in and set up sync")
                    findText(root, "Forgot password?")
                    findText(root, "Already have a SilentSuite account?")
                    findText(root, "Enter the email address and password for your existing account.")
                    findText(root, "New to SilentSuite?")
                    findText(
                        root,
                        "We’ll open the SilentSuite website. After you create your account, " +
                            "you’ll return to this app to finish setup."
                    )
                    findText(root, "Create an account on the web")
                    findText(root, "Use a custom server")
                }
                if (pass == 0) scenario.recreate()
            }
        }
        assertEquals(snapshots.first(), snapshots.last())
        return snapshots.first()
    }

    private fun installNoOpAuthenticatorDelivery() {
        LoginActivity.controllerFactory = { _, _ ->
            AuthenticatorResponseController(object : AuthenticatorResponseController.Delivery {
                override fun continued() = Unit
                override fun result(result: Bundle) = Unit
                override fun error(code: Int, message: String) = Unit
            }, null)
        }
    }

    private fun requiredId(activity: LoginActivity, name: String): Int {
        val id = activity.resources.getIdentifier(name, "id", activity.packageName)
        assertTrue("Missing first-run view ID $name", id != 0)
        return id
    }

    private fun findText(root: View, expected: String): TextView {
        val match = descendants(root).filterIsInstance<TextView>()
            .singleOrNull { it.text.toString() == expected }
        return requireNotNull(match) { "Missing exact first-run copy: $expected" }
    }

    private fun descendants(view: View): Sequence<View> = sequence {
        yield(view)
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                yieldAll(descendants(view.getChildAt(index)))
            }
        }
    }

    private fun isDescendantOf(view: View, ancestor: View): Boolean {
        var parent = view.parent
        while (parent is View) {
            if (parent === ancestor) return true
            parent = parent.parent
        }
        return false
    }
}
