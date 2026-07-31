package io.silentsuite.sync.ui.setup

import android.accounts.AccountManager
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FirstRunSignInRuntimeTest {
    @Test
    fun accountChoiceAndCredentialNavigationRemainExact() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertEquals("Add account", activity.title.toString())
                    activity.findViewById<View>(requiredId(activity, "account_choice_sign_in")).performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "LoginCredentialsFragment")
                    assertEquals("Sign in", activity.title.toString())
                    assertEquals(1, activity.supportFragmentManager.backStackEntryCount)
                    activity.onBackPressedDispatcher.onBackPressed()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertEquals("Add account", activity.title.toString())
                }
            }
        } finally {
            LoginActivity.controllerFactory = null
            SetupSecretHolder.clearProcessOnlySecrets()
        }
    }

    @Test
    fun signupReturnClaimsOnlyOwningFlowAndIsIdempotent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        val otherFlow = "other-${System.nanoTime()}"
        val otherToken = SignupContinuationRegistry.issue(otherFlow)
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    deliverNewIntent(
                        activity,
                        Intent(activity, LoginActivity::class.java)
                            .putExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN, otherToken)
                    )
                    assertTrue(SignupContinuationRegistry.isValid(otherToken))

                    val callback = activity.issueSignupCallbackUri()
                    val owningToken = requireNotNull(callback.getQueryParameter("continuation"))
                    val returned = Intent(activity, LoginActivity::class.java)
                        .putExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN, owningToken)
                    deliverNewIntent(activity, returned)
                    assertFalse(SignupContinuationRegistry.isValid(owningToken))
                    deliverNewIntent(activity, returned)
                    assertFalse(SignupContinuationRegistry.isValid(owningToken))
                    assertFalse(activity.intent.extras?.keySet().orEmpty().any {
                        it.contains("password", ignoreCase = true) ||
                            it.contains("credential", ignoreCase = true) ||
                            it.contains("session", ignoreCase = true)
                    })
                }
            }
        } finally {
            SignupContinuationRegistry.remove(otherFlow)
            LoginActivity.controllerFactory = null
            SetupSecretHolder.clearProcessOnlySecrets()
        }
    }

    @Test
    fun normalAuthenticatorAndLegacyRestorationUseSafeDestinations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        try {
            val normal = Intent(context, LoginActivity::class.java)
            val authenticator = Intent(context, LoginActivity::class.java)
                .putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, true)

            assertEquals(destinationFingerprint(normal), destinationFingerprint(authenticator))
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

    @Test
    fun accountEntryRemainsAccessibleAcrossConfigurations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        installNoOpAuthenticatorDelivery()
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                repeat(2) { pass ->
                    scenario.onActivity { activity ->
                        assertVisibleDestination(activity, "AccountChoiceFragment")
                        val root = activity.findViewById<ViewGroup>(android.R.id.content)
                        val heading = activity.findViewById<TextView>(requiredId(activity, "account_choice_heading"))
                        val signIn = activity.findViewById<TextView>(requiredId(activity, "account_choice_sign_in"))
                        val createAccount = activity.findViewById<TextView>(requiredId(activity, "account_choice_create_account"))
                        val density = activity.resources.displayMetrics.density
                        assertTrue(ViewCompat.isAccessibilityHeading(heading))
                        listOf(signIn, createAccount).forEach { action ->
                            assertTrue(action.isClickable)
                            assertTrue(action.minimumHeight >= (48 * density).toInt())
                            val bounds = Rect()
                            assertTrue(action.getGlobalVisibleRect(bounds))
                            assertTrue(bounds.height() > 0)
                        }
                        assertTrue(descendants(root).none {
                            it.id in setOf(
                                dynamicId(activity, "user_name"),
                                dynamicId(activity, "login_password"),
                                dynamicId(activity, "forgot_password"),
                                dynamicId(activity, "show_advanced"),
                            )
                        })
                    }
                    if (pass == 0) scenario.recreate()
                }
            }
        } finally {
            LoginActivity.controllerFactory = null
            SetupSecretHolder.clearProcessOnlySecrets()
        }
    }

    private fun destinationFingerprint(intent: Intent): List<String> {
        val snapshots = mutableListOf<List<String>>()
        ActivityScenario.launch<LoginActivity>(intent).use { scenario ->
            repeat(2) { pass ->
                scenario.onActivity { activity ->
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    snapshots += activity.supportFragmentManager.fragments.map {
                        it.javaClass.name
                    }
                }
                if (pass == 0) scenario.recreate()
            }
        }
        assertEquals(snapshots.first(), snapshots.last())
        return snapshots.first()
    }

    private fun assertVisibleDestination(activity: LoginActivity, simpleClassName: String) {
        val visible = activity.supportFragmentManager.fragments.filter { !it.isHidden && it.isAdded }
        assertEquals(
            "Expected exactly one visible $simpleClassName destination but saw ${visible.map { it.javaClass.name }}",
            1,
            visible.count { it.javaClass.simpleName == simpleClassName },
        )
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

    private fun deliverNewIntent(activity: LoginActivity, intent: Intent) {
        LoginActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply {
            isAccessible = true
            invoke(activity, intent)
        }
    }

    private fun requiredId(activity: LoginActivity, name: String): Int {
        val id = dynamicId(activity, name)
        assertTrue("Missing first-run view ID $name", id != 0)
        return id
    }

    private fun dynamicId(activity: LoginActivity, name: String): Int =
        activity.resources.getIdentifier(name, "id", activity.packageName)

    private fun descendants(view: View): Sequence<View> = sequence {
        yield(view)
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                yieldAll(descendants(view.getChildAt(index)))
            }
        }
    }
}
