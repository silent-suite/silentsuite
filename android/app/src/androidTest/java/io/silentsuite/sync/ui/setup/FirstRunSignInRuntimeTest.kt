package io.silentsuite.sync.ui.setup

import android.accounts.AccountManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.silentsuite.sync.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FirstRunSignInRuntimeTest {
    @Test
    fun accountChoiceAndCredentialNavigationRemainExact() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        startScenario()
        var passed = false
        installNoOpAuthenticatorDelivery()
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertEquals("Add account", activity.title.toString())
                    LoginActivity.browserLauncherForTest = { _, _ -> throw ActivityNotFoundException() }
                    activity.findViewById<View>(requiredId(activity, "account_choice_create_account")).performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertFalse(activity.intent.hasExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN))
                    LoginActivity.browserLauncherForTest = null
                    activity.findViewById<View>(requiredId(activity, "account_choice_sign_in")).performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "LoginCredentialsFragment")
                    assertEquals("Sign in", activity.title.toString())
                    assertEquals(1, activity.supportFragmentManager.backStackEntryCount)
                    val leaseBeforeMalformedRestore = requireNotNull(activity.setupLease())
                    val operationBeforeMalformedRestore = requireNotNull(
                        SetupSecretHolder.beginOperation(leaseBeforeMalformedRestore),
                    )
                    DetectConfigurationFragment().show(
                        activity.supportFragmentManager,
                        LoginActivity.DETECT_CONFIGURATION_TAG,
                    )
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "LoginCredentialsFragment")
                    assertTrue(leaseBeforeMalformedRestore == activity.setupLease())
                    assertTrue(SetupSecretHolder.compareOperation(operationBeforeMalformedRestore))
                    assertTrue(
                        activity.supportFragmentManager.findFragmentByTag(
                            LoginActivity.DETECT_CONFIGURATION_TAG + "_expired",
                        ) == null,
                    )
                    assertEquals(1, activity.supportFragmentManager.backStackEntryCount)
                    activity.onBackPressedDispatcher.onBackPressed()
                    activity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertEquals("Add account", activity.title.toString())
                }
            }
            passed = true
        } finally {
            finishScenario("choice-credentials-back-up", passed)
        }
    }

    @Test
    fun signupReturnClaimsOnlyOwningFlowAndIsIdempotent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        startScenario()
        var passed = false
        installNoOpAuthenticatorDelivery()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val returnMonitors = mutableListOf<android.app.Instrumentation.ActivityMonitor>()
        fun monitorSignupReturn() = instrumentation
            .addMonitor(SignupReturnActivity::class.java.name, null, false)
            .also(returnMonitors::add)
        val otherFlow = "other-${System.nanoTime()}"
        val otherToken = SignupContinuationRegistry.issue(otherFlow)
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                val firstReturnMonitor = monitorSignupReturn()
                lateinit var callback: android.net.Uri
                lateinit var owningToken: String
                lateinit var ownerFlow: String
                var foregroundAttempts = 0
                scenario.onActivity { activity ->
                    assertTrue(
                        "A tokenless exported return must not replace a live login owner",
                        LoginFlowOwnerRegistry.routeSignupToken(null) is SignupRouteResult.UNRELATED_LIVE_OWNER,
                    )
                    deliverNewIntent(
                        activity,
                        Intent(activity, LoginActivity::class.java)
                            .putExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN, otherToken)
                    )
                    assertTrue(SignupContinuationRegistry.isValid(otherToken))

                    callback = activity.issueSignupCallbackUri()
                    owningToken = requireNotNull(callback.getQueryParameter("continuation"))
                    ownerFlow = callbackOwnerFlow(activity)
                    SignupReturnActivity.foregroundExecutorForTest = { command ->
                        foregroundAttempts += 1
                        foregroundAttempts > 1 && command.execute()
                    }
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW, callback, activity, SignupReturnActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                    )
                }
                val firstReturn = instrumentation.waitForMonitorWithTimeout(firstReturnMonitor, 5_000L)
                assertTrue("Signup callback Activity did not launch", firstReturn is SignupReturnActivity)
                instrumentation.waitForIdleSync()
                assertTrue("Signup callback Activity did not finish", firstReturn!!.isFinishing)
                assertTrue("Failed foreground delivery was not retried", foregroundAttempts >= 2)
                SignupReturnActivity.foregroundExecutorForTest = null
                val handledDeadline = android.os.SystemClock.elapsedRealtime() + 5_000L
                var callbackHandled = false
                while (!callbackHandled && android.os.SystemClock.elapsedRealtime() < handledDeadline) {
                    instrumentation.waitForIdleSync()
                    scenario.onActivity { activity ->
                        activity.supportFragmentManager.executePendingTransactions()
                        callbackHandled =
                            !activity.intent.hasExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN) &&
                                (activity.supportFragmentManager.findFragmentByTag(LoginActivity.CREDENTIALS_TAG)
                                    is LoginCredentialsFragment)
                    }
                    if (!callbackHandled) android.os.SystemClock.sleep(25L)
                }
                assertTrue("Owning callback was not acknowledged by the resumed credentials destination", callbackHandled)
                val replayMonitor = monitorSignupReturn()
                scenario.onActivity { activity ->
                    activity.supportFragmentManager.executePendingTransactions()
                    assertEquals(ownerFlow, callbackOwnerFlow(activity))
                    assertEquals(
                        SignupContinuationRegistry.ClaimResult.SAME_FLOW_HANDLED,
                        SignupContinuationRegistry.claim(owningToken, ownerFlow),
                    )
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW, callback, activity, SignupReturnActivity::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                    )
                }
                val replayReturn = instrumentation.waitForMonitorWithTimeout(replayMonitor, 5_000L)
                assertTrue("Signup replay Activity did not launch", replayReturn is SignupReturnActivity)
                instrumentation.waitForIdleSync()
                assertTrue("Signup replay Activity did not finish", replayReturn!!.isFinishing)
                scenario.onActivity { activity ->
                    assertFalse(activity.intent.hasExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN))
                    assertFalse(activity.intent.extras?.keySet().orEmpty().any {
                        it.contains("password", ignoreCase = true) ||
                            it.contains("credential", ignoreCase = true) ||
                            it.contains("session", ignoreCase = true)
                    })
                }

                lateinit var releasedAdmission: LoginFlowOwnerRegistry.Admission
                val admissionField = LoginActivity::class.java.getDeclaredField("admission").apply {
                    isAccessible = true
                }
                scenario.onActivity { activity ->
                    releasedAdmission = admissionField.get(activity) as LoginFlowOwnerRegistry.Admission
                    LoginFlowOwnerRegistry.release(
                        activity,
                        releasedAdmission.releaseToken,
                        changingConfigurations = true,
                    )
                }
                val rebindMonitor = monitorSignupReturn()
                context.startActivity(
                    Intent(
                        Intent.ACTION_VIEW,
                        android.net.Uri.parse("silentsuite://signup-complete"),
                        context,
                        SignupReturnActivity::class.java,
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                )
                val rebindReturn = instrumentation.waitForMonitorWithTimeout(rebindMonitor, 5_000L)
                assertTrue("Tokenless callback did not enter the rebind queue", rebindReturn is SignupReturnActivity)
                assertFalse("Rebind-queued callback finished before replacement admission", rebindReturn!!.isFinishing)
                scenario.onActivity { activity ->
                    val rebound = LoginFlowOwnerRegistry.admit(
                        activity,
                        releasedAdmission.flowId,
                        releasedAdmission.generation,
                    )
                    admissionField.set(activity, rebound)
                }
                val rebindFinishDeadline = android.os.SystemClock.elapsedRealtime() + 5_000L
                while (!rebindReturn.isFinishing && android.os.SystemClock.elapsedRealtime() < rebindFinishDeadline)
                    android.os.SystemClock.sleep(50L)
                assertTrue("Rebind-queued callback did not finish after replacement admission", rebindReturn.isFinishing)
            }

            var deadlineRecoveryMonitor: android.app.Instrumentation.ActivityMonitor? = null
            var deadlineRecovery: android.app.Activity? = null
            try {
                val failedReturnMonitor = monitorSignupReturn()
                ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                    scenario.onActivity { activity ->
                        deadlineRecoveryMonitor = instrumentation.addMonitor(LoginActivity::class.java.name, null, false)
                        SignupReturnActivity.foregroundExecutorForTest = { false }
                        activity.startActivity(
                            Intent(
                                Intent.ACTION_VIEW,
                                activity.issueSignupCallbackUri(),
                                activity,
                                SignupReturnActivity::class.java,
                            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                        )
                    }
                    val failedReturn = instrumentation.waitForMonitorWithTimeout(failedReturnMonitor, 5_000L)
                    try {
                        assertTrue("Persistent foreground-failure callback did not launch", failedReturn is SignupReturnActivity)
                        deadlineRecovery = instrumentation.waitForMonitorWithTimeout(
                            requireNotNull(deadlineRecoveryMonitor),
                            5_000L,
                        )
                        try {
                            assertTrue(
                                "Persistent foreground failure did not recover after its deadline",
                                deadlineRecovery is LoginActivity,
                            )
                            assertTrue("Deadline-recovered callback did not finish", failedReturn!!.isFinishing)
                        } finally {
                            deadlineRecovery?.let {
                                finishAndAwaitDestroyed(
                                    instrumentation,
                                    it,
                                    "Deadline-recovered login did not finish before scenario cleanup",
                                )
                            }
                        }
                    } finally {
                        failedReturn?.let {
                            finishAndAwaitDestroyed(
                                instrumentation,
                                it,
                                "Persistent foreground-failure callback did not finish before scenario cleanup",
                            )
                        }
                    }
                }
            } finally {
                SignupReturnActivity.foregroundExecutorForTest = null
                deadlineRecovery?.finish()
                deadlineRecoveryMonitor?.let(instrumentation::removeMonitor)
            }
            instrumentation.waitForIdleSync()

            val cleanLoginMonitor = instrumentation.addMonitor(LoginActivity::class.java.name, null, false)
            var cleanLogin: android.app.Activity? = null
            try {
                context.startActivity(
                    Intent(
                        Intent.ACTION_VIEW,
                        android.net.Uri.parse("silentsuite://signup-complete?continuation=unknown-runtime-token"),
                        context,
                        SignupReturnActivity::class.java,
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                )
                cleanLogin = instrumentation.waitForMonitorWithTimeout(cleanLoginMonitor, 5_000L)
                assertTrue("Unknown no-owner callback did not open clean account entry", cleanLogin is LoginActivity)
                val cleanActivity = cleanLogin as LoginActivity
                instrumentation.runOnMainSync {
                    cleanActivity.supportFragmentManager.executePendingTransactions()
                    assertVisibleDestination(cleanActivity, "AccountChoiceFragment")
                    assertFalse(cleanActivity.intent.hasExtra(LoginActivity.EXTRA_SIGNUP_CONTINUATION_TOKEN))
                    cleanActivity.finish()
                }
            } finally {
                cleanLogin?.finish()
                instrumentation.removeMonitor(cleanLoginMonitor)
            }
            passed = true
        } finally {
            returnMonitors.forEach(instrumentation::removeMonitor)
            SignupContinuationRegistry.remove(otherFlow)
            finishScenario("signup-owner-claim-replay", passed)
        }
    }

    @Test
    fun normalAuthenticatorAndLegacyRestorationUseSafeDestinations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        startScenario()
        var passed = false
        installNoOpAuthenticatorDelivery()
        try {
            val firstOwner = Any()
            val replacementOwner = Any()
            val changeLease = SetupSecretHolder.issue(
                SetupSecretHolder.LeaseKind.CREDENTIAL_CHANGE,
                bound = false,
            )
            val firstBinding = requireNotNull(SetupSecretHolder.bind(changeLease, firstOwner, "first"))
            assertTrue(SetupSecretHolder.releaseBinding(firstBinding, firstOwner, changingConfigurations = true))
            val replacementBinding = requireNotNull(
                SetupSecretHolder.bind(changeLease, replacementOwner, "replacement"),
            )
            assertTrue(SetupSecretHolder.bind(changeLease, firstOwner, "stale") == null)
            assertFalse(SetupSecretHolder.retireUnboundOrRebinding(changeLease))
            assertTrue(SetupSecretHolder.compareBinding(replacementBinding, replacementOwner))
            assertTrue(
                SetupSecretHolder.releaseBinding(
                    replacementBinding,
                    replacementOwner,
                    changingConfigurations = false,
                ),
            )

            val operationLease = SetupSecretHolder.issue(SetupSecretHolder.LeaseKind.LOGIN)
            val staleOperation = requireNotNull(SetupSecretHolder.beginOperation(operationLease))
            assertTrue(SetupSecretHolder.clearCredentialsAndConfiguration(operationLease))
            assertFalse(
                SetupSecretHolder.commitIfCurrent(
                    staleOperation,
                    SetupSecretHolder.CommitKind.UI_PUBLICATION,
                ),
            )
            assertTrue(SetupSecretHolder.revoke(operationLease))

            var elapsed = 100L
            SetupElapsedClock.nowForTest = { elapsed }
            val unbound = SetupSecretHolder.issue(
                SetupSecretHolder.LeaseKind.CREDENTIAL_CHANGE,
                bound = false,
            )
            val unboundRef = SetupSecretHolder.reference(unbound)
            assertTrue(SetupSecretHolder.resolve(unboundRef) == unbound)
            assertTrue(
                SetupSecretHolder.resolve(
                    SetupSecretHolder.LeaseRefV1(
                        unboundRef.ownerId,
                        unboundRef.generation,
                        SetupSecretHolder.LeaseKind.LOGIN,
                    ),
                ) == null,
            )
            elapsed += 5_000L
            assertFalse(SetupSecretHolder.compareCurrent(unbound))

            val expiringFlow = "expiring-flow"
            val expiringToken = SignupContinuationRegistry.issue(expiringFlow)
            assertEquals(
                SignupContinuationRegistry.ClaimResult.NEW_PENDING,
                SignupContinuationRegistry.claim(expiringToken, expiringFlow),
            )
            val expiringClaim = requireNotNull(
                SignupContinuationRegistry.pendingClaimRef(expiringToken, expiringFlow),
            )
            elapsed = expiringClaim.deadline
            assertTrue(SignupContinuationRegistry.route(expiringToken) is SignupContinuationRegistry.Route.UNKNOWN)
            assertEquals(
                SignupContinuationRegistry.ClaimResult.EXPIRED_SAME_FLOW,
                SignupContinuationRegistry.claim(expiringToken, expiringFlow),
            )
            assertTrue(SignupContinuationRegistry.rollbackExpired(expiringToken, expiringFlow, expiringClaim))
            SetupElapsedClock.nowForTest = null

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
            ActivityScenario.launch<LoginActivity>(normal).use { scenario ->
                scenario.onActivity { activity ->
                    val loginLease = requireNotNull(activity.setupLease())
                    val malformedChange = LoginCredentialsChangeFragment().apply {
                        arguments = Bundle().apply {
                            putParcelable(
                                "account",
                                android.accounts.Account("inactive-change@example.invalid", "invalid.account.type"),
                            )
                        }
                    }
                    malformedChange.show(activity.supportFragmentManager, "malformed-credential-change-runtime")
                    activity.supportFragmentManager.executePendingTransactions()
                    assertTrue(loginLease == activity.setupLease())
                    assertTrue(SetupSecretHolder.compareCurrent(loginLease))
                    (activity.supportFragmentManager.findFragmentByTag(null) as? androidx.fragment.app.DialogFragment)
                        ?.dismissAllowingStateLoss()
                }
            }
            ActivityScenario.launch<LoginActivity>(normal).use { scenario ->
                scenario.onActivity { activity ->
                    activity.findViewById<View>(R.id.account_choice_sign_in).performClick()
                    activity.supportFragmentManager.executePendingTransactions()
                    val lease = requireNotNull(activity.setupLease())
                    val operationBeforeInvalidRestore = requireNotNull(SetupSecretHolder.beginOperation(lease))
                    val navigationValidator = LoginActivity::class.java.getDeclaredMethod(
                        "hasValidNavigation",
                        Bundle::class.java,
                    ).apply { isAccessible = true }
                    val malformedDetector = DetectConfigurationFragment()
                    activity.supportFragmentManager.beginTransaction()
                        .add(malformedDetector, LoginActivity.DETECT_CONFIGURATION_TAG)
                        .setMaxLifecycle(malformedDetector, androidx.lifecycle.Lifecycle.State.CREATED)
                        .commit()
                    activity.supportFragmentManager.executePendingTransactions()
                    val restoredCredentialsNavigation = Bundle().apply {
                        putInt("login_navigation_schema", 2)
                        putString("login_navigation_destination", "CREDENTIALS")
                    }
                    assertFalse(navigationValidator.invoke(activity, restoredCredentialsNavigation) as Boolean)
                    assertTrue(SetupSecretHolder.compareOperation(operationBeforeInvalidRestore))
                    activity.supportFragmentManager.beginTransaction().remove(malformedDetector).commitNow()
                    val creator = CreateAccountFragment.newInstance(
                        requireNotNull(SetupSecretHolder.reference(lease)),
                    )
                    activity.supportFragmentManager.beginTransaction()
                        .replace(android.R.id.content, creator, LoginActivity.CREATE_ACCOUNT_TAG)
                        .addToBackStack(LoginActivity.CREDENTIALS_TO_CREATOR_BACK_STACK)
                        .setMaxLifecycle(creator, androidx.lifecycle.Lifecycle.State.CREATED)
                        .commit()
                    activity.supportFragmentManager.executePendingTransactions()
                    val creationIdField = CreateAccountFragment::class.java.getDeclaredField("creationId").apply {
                        isAccessible = true
                    }
                    val restoredNavigation = Bundle().apply {
                        putInt("login_navigation_schema", 2)
                        putString("login_navigation_destination", "CREATOR")
                    }
                    assertFalse(navigationValidator.invoke(activity, restoredNavigation) as Boolean)
                    val hadStartedField = CreateAccountFragment::class.java
                        .getDeclaredField("hadStartedBeforeSave")
                        .apply { isAccessible = true }
                    hadStartedField.setBoolean(creator, true)
                    creationIdField.set(creator, null)
                    assertFalse(navigationValidator.invoke(activity, restoredNavigation) as Boolean)
                    creationIdField.set(creator, "1-1-1-1-1")
                    assertFalse(navigationValidator.invoke(activity, restoredNavigation) as Boolean)
                    creationIdField.set(creator, "not-a-creation-uuid")
                    assertFalse(navigationValidator.invoke(activity, restoredNavigation) as Boolean)
                    assertTrue(SetupSecretHolder.compareOperation(operationBeforeInvalidRestore))
                    creationIdField.set(creator, java.util.UUID.randomUUID().toString())
                    assertTrue(navigationValidator.invoke(activity, restoredNavigation) as Boolean)
                    assertTrue(activity.recoverStalledRestoredCreator())
                    assertVisibleDestination(activity, "AccountChoiceFragment")
                    assertFalse(SetupSecretHolder.compareOperation(operationBeforeInvalidRestore))
                }
            }
            passed = true
        } finally {
            finishScenario("normal-authenticator-legacy-destinations", passed)
        }
    }

    @Test
    fun accountEntryRemainsAccessibleAcrossConfigurations() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        startScenario()
        var passed = false
        installNoOpAuthenticatorDelivery()
        try {
            ActivityScenario.launch<LoginActivity>(Intent(context, LoginActivity::class.java)).use { scenario ->
                repeat(2) { pass ->
                    assertTrue(
                        "Account-choice actions were not laid out after configuration change",
                        waitForAccountChoiceActionsLaidOut(scenario),
                    )
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
                            assertTrue(ViewCompat.isLaidOut(action))
                            assertTrue(action.width > 0)
                            assertTrue(action.height > 0)
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
            passed = true
        } finally {
            finishScenario("choice-accessibility-recreation", passed)
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

    private fun startScenario() {
        assertTestStateEmpty()
    }

    private fun finishScenario(helper: String, passed: Boolean) {
        LoginActivity.controllerFactory = null
        LoginActivity.browserLauncherForTest = null
        SignupReturnActivity.foregroundExecutorForTest = null
        LoginFlowOwnerRegistry.resetForTests()
        SignupContinuationRegistry.resetForTests()
        SetupSecretHolder.resetForTests()
        assertTestStateEmpty()
        if (passed) recordScenario(helper)
    }

    private fun assertTestStateEmpty() {
        assertTrue("Login owner registry leaked between scenarios", LoginFlowOwnerRegistry.isEmptyForTests())
        assertTrue("Signup continuation registry leaked between scenarios", SignupContinuationRegistry.isEmptyForTests())
        assertTrue("Setup secret holder leaked between scenarios", SetupSecretHolder.isEmptyForTests())
    }

    private fun recordScenario(helper: String) {
        require(helper.matches(Regex("[A-Za-z0-9._-]+")))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val nonce = requireNotNull(arguments.getString("scenarioNonce"))
        require(nonce.matches(Regex("[A-Za-z0-9._-]+")))
        val context = instrumentation.targetContext
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val versionCode = if (Build.VERSION.SDK_INT >= 28) packageInfo.longVersionCode else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toLong()
        }
        val wrapper = when (helper) {
            "choice-credentials-back-up" -> "accountChoiceAndCredentialNavigationRemainExact"
            "signup-owner-claim-replay" -> "signupReturnClaimsOnlyOwningFlowAndIsIdempotent"
            "normal-authenticator-legacy-destinations" -> "normalAuthenticatorAndLegacyRestorationUseSafeDestinations"
            "choice-accessibility-recreation" -> "accountEntryRemainsAccessibleAcrossConfigurations"
            else -> error("Unexpected focused runtime helper: $helper")
        }
        val evidence = JSONObject()
            .put("api", Build.VERSION.SDK_INT)
            .put("attempt", arguments.getString("scenarioAttempt").orEmpty())
            .put("checkout", arguments.getString("scenarioCheckout").orEmpty())
            .put("helperSet", JSONArray().put(helper))
            .put("invocationNonce", nonce)
            .put("job", arguments.getString("scenarioJob").orEmpty())
            .put("package", context.packageName)
            .put("run", arguments.getString("scenarioRun").orEmpty())
            .put("shard", arguments.getString("scenarioShard").orEmpty())
            .put("versionCode", versionCode)
            .put("versionName", packageInfo.versionName.orEmpty())
            .put("wrapper", "${FirstRunSignInRuntimeTest::class.java.name}#$wrapper")
        val directory = File(context.filesDir, "focused-runtime/$nonce").apply { mkdirs() }
        val target = File(directory, "$helper.json")
        val temporary = File(directory, ".$helper.${UUID.randomUUID()}.tmp")
        check(temporary.createNewFile())
        val serializedEvidence = evidence.toString()
        temporary.writeText(serializedEvidence + "\n", Charsets.UTF_8)
        check(!target.exists() && temporary.renameTo(target))
        android.util.Log.i(SCENARIO_LOG_TAG, serializedEvidence)
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

    private fun waitForAccountChoiceActionsLaidOut(
        scenario: ActivityScenario<LoginActivity>,
    ): Boolean {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = android.os.SystemClock.elapsedRealtime() + 5_000L
        var laidOut = false
        while (!laidOut && android.os.SystemClock.elapsedRealtime() < deadline) {
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                laidOut = listOf(
                    activity.findViewById<View>(R.id.account_choice_sign_in),
                    activity.findViewById<View>(R.id.account_choice_create_account),
                ).all { ViewCompat.isLaidOut(it) && it.width > 0 && it.height > 0 }
            }
            if (!laidOut) android.os.SystemClock.sleep(25L)
        }
        return laidOut
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

    private fun callbackOwnerFlow(activity: LoginActivity): String {
        val field = LoginActivity::class.java.getDeclaredField("admission").apply { isAccessible = true }
        return (field.get(activity) as LoginFlowOwnerRegistry.Admission).flowId
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

    companion object {
        private const val SCENARIO_LOG_TAG = "FocusedRuntimeScenario"
    }
}
