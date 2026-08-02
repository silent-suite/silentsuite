package io.silentsuite.sync.ui.setup

import androidx.test.ext.junit.runners.AndroidJUnit4
import android.accounts.Account
import android.accounts.AccountManager
import android.os.Bundle
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import io.silentsuite.sync.App
import io.silentsuite.sync.AccountSettings
import io.silentsuite.sync.R
import io.silentsuite.sync.ui.ActiveAccountManager
import io.silentsuite.sync.utils.AndroidCompat
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runtime policy coverage; dead binder delivery is intentionally not claimed. */
@RunWith(AndroidJUnit4::class)
class AuthenticatorLifecycleRuntimeTest {
    @Test fun cleanInstallBootstrapPublishesMarkerAfterReconciliation() {
        val targetContext = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().targetContext
        val prefs = targetContext.getSharedPreferences("post_login_setup_migration", android.content.Context.MODE_PRIVATE)
        val hadMarker = prefs.contains("version")
        val previousMarker = prefs.getInt("version", 0)
        val previousBootstrapSucceeded = App.postLoginBootstrapSucceeded
        try {
            val accounts = android.accounts.AccountManager.get(targetContext).getAccountsByType(App.accountType)
            assertTrue("Fresh runtime environment unexpectedly contains SilentSuite accounts", accounts.isEmpty())
            prefs.edit().remove("version").commit()

            assertTrue(PostLoginSetupMigration.bootstrap(targetContext))
            assertTrue(PostLoginSetupMigration.isBootstrapped(targetContext))
        } finally {
            val editor = prefs.edit()
            if (hadMarker) editor.putInt("version", previousMarker) else editor.remove("version")
            editor.commit()
            App.postLoginBootstrapSucceeded = previousBootstrapSucceeded
        }
    }

    @Test fun recoverableCreationFailureRestoresCredentialsWithoutFinishingOrCancelling() {
        class Fake : AuthenticatorResponseController.Delivery {
            var continued = 0; var errors = 0; var results = 0
            override fun continued() { continued++ }
            override fun result(result: Bundle) { results++ }
            override fun error(code: Int, message: String) { errors++ }
        }
        val delivery = Fake()
        LoginActivity.controllerFactory = { _, _ -> AuthenticatorResponseController(delivery, null) }
        try {
            val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
            val targetContext = instrumentation.targetContext
            val loginIntent = Intent(targetContext, LoginActivity::class.java)
            assertEquals(targetContext.packageName, loginIntent.component?.packageName)
            ActivityScenario.launch<LoginActivity>(loginIntent).use { scenario ->
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    activity.findViewById<android.view.View>(R.id.account_choice_sign_in).performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    activity.findViewById<android.view.View>(R.id.show_advanced).performClick()
                    activity.findViewById<android.widget.EditText>(R.id.custom_server)
                        .setText("https://custom.example.invalid/")
                    activity.supportFragmentManager.beginTransaction()
                        .replace(
                            android.R.id.content,
                            CreateAccountFragment(),
                            LoginActivity.CREATE_ACCOUNT_TAG,
                        )
                        .addToBackStack(LoginActivity.CREDENTIALS_TO_CREATOR_BACK_STACK)
                        .commit()
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    activity.supportFragmentManager.executePendingTransactions()
                    org.junit.Assert.assertFalse(activity.isFinishing)
                    val dismissedCreator = activity.supportFragmentManager
                        .findFragmentByTag(LoginActivity.CREATE_ACCOUNT_TAG) as CreateAccountFragment
                    org.junit.Assert.assertFalse(dismissedCreator.isAdded)
                    org.junit.Assert.assertFalse(dismissedCreator.dialog?.isShowing == true)
                    org.junit.Assert.assertNull(
                        activity.supportFragmentManager.findFragmentByTag("account_creation_retry_error"),
                    )
                    activity.onBackPressedDispatcher.onBackPressed()
                    activity.supportFragmentManager.executePendingTransactions()
                    org.junit.Assert.assertNull(
                        activity.supportFragmentManager.findFragmentByTag(LoginActivity.CREATE_ACCOUNT_TAG),
                    )
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    val credentials = activity.supportFragmentManager
                        .findFragmentById(android.R.id.content) as LoginCredentialsFragment
                    val guard = LoginCredentialsFragment::class.java.getDeclaredField("submissionInProgress")
                    guard.isAccessible = true
                    org.junit.Assert.assertFalse(guard.getBoolean(credentials))
                    val expanded = LoginCredentialsFragment::class.java.getDeclaredField("advancedExpanded")
                    expanded.isAccessible = true
                    org.junit.Assert.assertTrue(expanded.getBoolean(credentials))
                    assertEquals(
                        "Custom server settings, expanded",
                        activity.findViewById<android.view.View>(R.id.show_advanced).contentDescription,
                    )
                    assertEquals(
                        "https://custom.example.invalid/",
                        activity.findViewById<android.widget.EditText>(R.id.custom_server).text.toString(),
                    )
                    activity.findViewById<android.widget.EditText>(R.id.user_name)
                        .setText("restore@example.invalid")
                    activity.findViewById<android.widget.EditText>(R.id.login_password)
                        .setText("process-only-fixture")
                    val validate = LoginCredentialsFragment::class.java
                        .getDeclaredMethod("validateLoginData")
                    validate.isAccessible = true
                    val restored = validate.invoke(credentials) as LoginCredentials
                    assertEquals(URI("https://custom.example.invalid/"), restored.uri)
                    org.junit.Assert.assertFalse(activity.isFinishing)
                    org.junit.Assert.assertEquals(1, delivery.continued)
                    org.junit.Assert.assertEquals(0, delivery.errors)
                }
            }
            creatorGenerationReplacementRoutesToSettingsResolution()
            existingGenerationRoutesToSettingsResolution(injectUnexpectedFailure = false)
            existingGenerationRoutesToSettingsResolution(injectUnexpectedFailure = true)
            assertEquals(0, delivery.results)
        } finally { LoginActivity.controllerFactory = null }
    }

    private fun creatorGenerationReplacementRoutesToSettingsResolution() {
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = android.accounts.AccountManager.get(context)
        val account = Account("creator-race-${System.nanoTime()}@example.invalid", App.accountType)
        val replacementGeneration = "creator-race-replacement"
        val registry = AccountCreationRegistry.open(context)
        val previousBootstrap = App.postLoginBootstrapSucceeded
        val monitor = instrumentation.addMonitor(PostLoginSetupActivity::class.java.name, null, false)
        var launched: android.app.Activity? = null
        var ownedGeneration: String? = null
        try {
            App.postLoginBootstrapSucceeded = true
            assertTrue(PostLoginSetupMigration.bootstrap(context))
            val pendingConfiguration = BaseConfigurationFinder.Configuration(
                URI("https://example.invalid/"),
                account.name,
                "opaque-test-session",
                null,
            )
            ActiveAccountManager.afterExactSetCommitForTest = {
                check(AccountSettings.writeVerified(
                    manager,
                    account,
                    AccountSettings.KEY_CREATION_ID,
                    replacementGeneration,
                ))
            }
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    val lease = requireNotNull(activity.setupLease())
                    assertTrue(SetupSecretHolder.setPendingConfiguration(lease, pendingConfiguration))
                    activity.supportFragmentManager.beginTransaction()
                        .replace(
                            android.R.id.content,
                            CreateAccountFragment.newInstance(SetupSecretHolder.reference(lease)),
                            LoginActivity.CREATE_ACCOUNT_TAG,
                        )
                        .addToBackStack(LoginActivity.CREDENTIALS_TO_CREATOR_BACK_STACK)
                        .commit()
                }
                launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                val resolution = requireNotNull(launched) {
                    "generation mismatch did not route to PostLoginSetupActivity"
                }
                try {
                    instrumentation.waitForIdleSync()
                    ownedGeneration = registry.get(account.type, account.name)?.creationId
                    org.junit.Assert.assertNotNull(ownedGeneration)
                    org.junit.Assert.assertNotEquals(replacementGeneration, ownedGeneration)
                    assertEquals(
                        replacementGeneration,
                        manager.getUserData(account, AccountSettings.KEY_CREATION_ID),
                    )
                    assertNoPersistedActiveIdentity(context)
                    assertEquals(account, ActiveAccountManager.getActiveAccount(context))
                    var renderedTitle = ""
                    instrumentation.runOnMainSync {
                        renderedTitle = resolution
                            .findViewById<android.widget.TextView>(R.id.setup_title)
                            .text.toString()
                    }
                    assertEquals(
                        context.getString(R.string.post_login_ambiguous_title),
                        renderedTitle,
                    )
                } finally {
                    finishAndAwaitDestroyed(
                        instrumentation,
                        resolution,
                        "generation-mismatch resolution did not finish before login cleanup",
                    )
                }
            }
        } finally {
            ActiveAccountManager.afterExactSetCommitForTest = null
            launched?.finish()
            instrumentation.removeMonitor(monitor)
            SetupSecretHolder.resetForTests()
            ownedGeneration?.let { registry.clearOwned(account.type, account.name, it) }
            if (account in manager.getAccountsByType(account.type)) {
                val removed = CountDownLatch(1)
                var removalSucceeded = false
                AndroidCompat.removeAccount(manager, account) { success ->
                    removalSucceeded = success
                    removed.countDown()
                }
                assertTrue("creator-race account removal timed out", removed.await(10, TimeUnit.SECONDS))
                assertTrue("creator-race account removal failed", removalSucceeded)
                assertFalse(account in manager.getAccountsByType(account.type))
            }
            ActiveAccountManager.clearActiveAccount(context)
            App.postLoginBootstrapSucceeded = previousBootstrap
        }
    }

    private fun existingGenerationRoutesToSettingsResolution(injectUnexpectedFailure: Boolean) {
        val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = android.accounts.AccountManager.get(context)
        val account = Account(
            "creator-existing-${injectUnexpectedFailure}-${System.nanoTime()}@example.invalid",
            App.accountType,
        )
        val existingGeneration = "creator-existing-generation"
        val registry = AccountCreationRegistry.open(context)
        val previousBootstrap = App.postLoginBootstrapSucceeded
        val monitor = instrumentation.addMonitor(PostLoginSetupActivity::class.java.name, null, false)
        var launched: android.app.Activity? = null
        try {
            App.postLoginBootstrapSucceeded = true
            assertTrue(PostLoginSetupMigration.isBootstrapped(context))
            assertTrue(manager.addAccountExplicitly(account, null, null))
            assertTrue(AccountSettings.writeVerified(
                manager,
                account,
                AccountSettings.KEY_CREATION_ID,
                existingGeneration,
            ))
            assertTrue(AccountSettings.writeSetupState(
                manager,
                account,
                PostLoginSetupState.ACCOUNT_CREATED,
            ))
            assertTrue(registry.prepare(AccountCreationRegistry.Record(
                account.name,
                existingGeneration,
                AccountCreationRegistry.Phase.CREATING,
                System.currentTimeMillis(),
                account.type,
            )))
            val pendingConfiguration = BaseConfigurationFinder.Configuration(
                URI("https://example.invalid/"),
                account.name,
                "opaque-test-session",
                null,
            )
            if (injectUnexpectedFailure) {
                CreateAccountFragment.afterCreationIdIssuedForTest = {
                    throw IllegalStateException("injected creator failure")
                }
            }
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    val lease = requireNotNull(activity.setupLease())
                    assertTrue(SetupSecretHolder.setPendingConfiguration(lease, pendingConfiguration))
                    activity.supportFragmentManager.beginTransaction()
                        .replace(
                            android.R.id.content,
                            CreateAccountFragment.newInstance(SetupSecretHolder.reference(lease)),
                            LoginActivity.CREATE_ACCOUNT_TAG,
                        )
                        .addToBackStack(LoginActivity.CREDENTIALS_TO_CREATOR_BACK_STACK)
                        .commit()
                }
                launched = instrumentation.waitForMonitorWithTimeout(monitor, 10_000)
                val resolution = requireNotNull(launched) {
                    "existing generation did not route to PostLoginSetupActivity"
                }
                try {
                    instrumentation.waitForIdleSync()
                    assertEquals(
                        existingGeneration,
                        manager.getUserData(account, AccountSettings.KEY_CREATION_ID),
                    )
                    assertEquals(
                        existingGeneration,
                        registry.get(account.type, account.name)?.creationId,
                    )
                    assertNoPersistedActiveIdentity(context)
                    assertEquals(account, ActiveAccountManager.getActiveAccount(context))
                    var renderedTitle = ""
                    instrumentation.runOnMainSync {
                        renderedTitle = resolution
                            .findViewById<android.widget.TextView>(R.id.setup_title)
                            .text.toString()
                    }
                    assertEquals(context.getString(R.string.post_login_ambiguous_title), renderedTitle)
                } finally {
                    finishAndAwaitDestroyed(
                        instrumentation,
                        resolution,
                        "existing-generation resolution did not finish before login cleanup",
                    )
                }
            }
        } finally {
            CreateAccountFragment.afterCreationIdIssuedForTest = null
            launched?.finish()
            instrumentation.removeMonitor(monitor)
            SetupSecretHolder.resetForTests()
            registry.clearOwned(account.type, account.name, existingGeneration)
            if (account in manager.getAccountsByType(account.type)) {
                val removed = CountDownLatch(1)
                var removalSucceeded = false
                AndroidCompat.removeAccount(manager, account) { success ->
                    removalSucceeded = success
                    removed.countDown()
                }
                assertTrue("existing-generation account removal timed out", removed.await(10, TimeUnit.SECONDS))
                assertTrue("existing-generation account removal failed", removalSucceeded)
                assertFalse(account in manager.getAccountsByType(account.type))
            }
            ActiveAccountManager.clearActiveAccount(context)
            App.postLoginBootstrapSucceeded = previousBootstrap
        }
    }

    private fun finishAndAwaitDestroyed(
        instrumentation: android.app.Instrumentation,
        activity: android.app.Activity,
        failureMessage: String,
    ) {
        instrumentation.runOnMainSync { activity.finish() }
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
        while (!activity.isDestroyed && android.os.SystemClock.elapsedRealtime() < deadline) {
            android.os.SystemClock.sleep(25L)
        }
        assertTrue(failureMessage, activity.isDestroyed)
    }

    private fun assertNoPersistedActiveIdentity(context: android.content.Context) {
        val prefs = context.getSharedPreferences("active_account", android.content.Context.MODE_PRIVATE)
        org.junit.Assert.assertNull(prefs.getString("account_name", null))
        org.junit.Assert.assertNull(prefs.getString("creation_id", null))
    }

    @Test fun staleLoginActivityRestorationUsesObsoletePathBeforeController() {
        var cancel=0; var clear=0; var launch=0; var controllers=0
        val stale=Bundle().apply { putString("authenticator_process_epoch","stale"); putString(AuthenticatorResponseController.KEY_ACCOUNT_NAME,"staged") }
        LoginActivity.obsoleteSeamsFactory={ _,_,_ -> object:ObsoleteAuthenticatorCoordinator.Seams { override fun cancel(){cancel++}; override fun clearSecrets(){clear++}; override fun launchNormalOnce(){launch++} } }
        LoginActivity.controllerFactory={ _,_ -> controllers++; AuthenticatorResponseController(object:AuthenticatorResponseController.Delivery { override fun continued(){}; override fun result(result:Bundle){}; override fun error(code:Int,message:String){} },null) }
        StaleLoginHarnessActivity.restored=stale
        try { val instrumentation=androidx.test.platform.app.InstrumentationRegistry.getInstrumentation(); val testContext=instrumentation.context; val targetContext=instrumentation.targetContext; val component=android.content.ComponentName(targetContext.packageName,StaleLoginHarnessActivity::class.java.name); assertEquals(targetContext.packageName,component.packageName); org.junit.Assert.assertFalse(component.packageName==testContext.packageName); ActivityScenario.launch<StaleLoginHarnessActivity>(Intent().setComponent(component).putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE,true)).use {}; assertEquals(1,cancel);assertEquals(1,clear);assertEquals(1,launch);assertEquals(0,controllers) }
        finally { LoginActivity.obsoleteSeamsFactory=null;LoginActivity.controllerFactory=null;StaleLoginHarnessActivity.restored=null }
    }
    @Test fun obsoleteCoordinatorCancelsBeforeNormalLaunch() {
        val calls=mutableListOf<String>()
        ObsoleteAuthenticatorCoordinator(object: ObsoleteAuthenticatorCoordinator.Seams { override fun cancel(){calls += "cancel"}; override fun clearSecrets(){calls += "clear"}; override fun launchNormalOnce(){calls += "launch"} }).handle()
        assertEquals(listOf("cancel","clear","launch"), calls)
    }
    @Test fun controllerLiveResultCancellationDuplicatesAndRestoreAreExactOnce() {
        class Fake : AuthenticatorResponseController.Delivery { var continued=0; val results=mutableListOf<Bundle>(); var errors=0; override fun continued(){continued++}; override fun result(result: Bundle){results += Bundle(result)}; override fun error(code:Int,message:String){errors++} }
        val success=Fake(); AuthenticatorResponseController(success,null).apply { complete(Account("a","t")); finish(); finish() }
        assertEquals(1,success.continued); assertEquals(1,success.results.size); assertEquals("a", success.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_NAME)); assertEquals("t", success.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_TYPE)); assertEquals(0,success.errors)
        val canceled=Fake(); AuthenticatorResponseController(canceled,null).apply { finish(); finish() }; assertEquals(1,canceled.errors)
        val staged = Fake(); val beforeRotation = AuthenticatorResponseController(staged, null); beforeRotation.complete(Account("rotated", "type")); val state = Bundle(); beforeRotation.onSaveInstanceState(state)
        val restored = Fake(); AuthenticatorResponseController(restored, state).finish(); assertEquals(1, restored.results.size); assertEquals("rotated", restored.results.single().getString(android.accounts.AccountManager.KEY_ACCOUNT_NAME))
    }
    @Test fun sameProcessRotationPolicyPreservesAuthenticator() {
        assertFalse(AuthenticatorRestorePolicy.mustRestartNormally(true, App.processEpoch, App.processEpoch))
    }
}
