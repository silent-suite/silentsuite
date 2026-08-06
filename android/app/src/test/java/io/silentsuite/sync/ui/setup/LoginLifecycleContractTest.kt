package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LoginLifecycleContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync/ui/setup")

    @Test
    fun unknownSignupReturnStartsCleanLoginWithoutClearingOtherTasks() {
        val source = File(sourceRoot, "SignupReturnActivity.kt").readText()

        assertTrue(source.contains("Intent.FLAG_ACTIVITY_NEW_TASK"))
        assertFalse(source.contains("FLAG_ACTIVITY_CLEAR_TASK"))
        assertFalse(source.contains("FLAG_ACTIVITY_CLEAR_TOP"))
        assertFalse(source.contains("FLAG_ACTIVITY_SINGLE_TOP"))
    }

    @Test
    fun validSignupReturnUsesTypedExactOwnerRouter() {
        val source = File(sourceRoot, "SignupReturnActivity.kt").readText()

        assertTrue(source.contains("LoginFlowOwnerRegistry.routeSignupToken"))
        assertTrue(source.contains("SignupRouteResult"))
        assertFalse(source.contains("Toast.makeText"))
        assertFalse(source.contains("SignupContinuationRegistry.isValid"))
    }

    @Test
    fun loginActivityUsesOneChoiceRootAndNamedCredentialsBackEntry() {
        val source = File(sourceRoot, "LoginActivity.kt").readText()

        assertTrue(source.contains("ACCOUNT_CHOICE_TAG = \"account-choice\""))
        assertTrue(source.contains("CREDENTIALS_TAG = \"credentials\""))
        assertTrue(source.contains("CHOICE_TO_CREDENTIALS_BACK_STACK = \"choice-to-credentials\""))
        assertTrue(source.contains("AccountChoiceFragment()"))
        assertTrue(source.contains("addToBackStack(CHOICE_TO_CREDENTIALS_BACK_STACK)"))
        assertTrue(source.contains("onBackPressedDispatcher"))
        assertFalse(source.contains("onKeyDown("))
    }

    @Test
    fun loginSubmissionIsGuardedBeforeTheDetectorTransactionAndResetsForEverySetupFailure() {
        val loginSource = File(sourceRoot, "LoginCredentialsFragment.kt").readText()
        val detectorSource = File(sourceRoot, "DetectConfigurationFragment.kt").readText()
        val createAccountSource = File(sourceRoot, "CreateAccountFragment.kt").readText()
        val activitySource = File(sourceRoot, "LoginActivity.kt").readText()

        assertTrue(loginSource.contains("private var submissionInProgress = false"))
        assertTrue(loginSource.contains("internal fun onSubmissionFailed()"))
        assertTrue(loginSource.contains("if (credentials != null && !submissionInProgress &&"))
        assertTrue(loginSource.contains("findFragmentByTag(LoginActivity.DETECT_CONFIGURATION_TAG) == null"))
        assertTrue(loginSource.indexOf("submissionInProgress = true") <
            loginSource.indexOf("DetectConfigurationFragment.newInstance(SetupSecretHolder.reference(lease))"))
        assertTrue(detectorSource.contains("findFragmentById(android.R.id.content) as? LoginCredentialsFragment"))
        assertTrue(detectorSource.contains("?.onSubmissionFailed()"))
        assertTrue(createAccountSource.contains("private fun notifyAccountCreationFailed()"))
        assertTrue(createAccountSource.contains("fragments.filterIsInstance<LoginCredentialsFragment>()"))
        assertTrue(createAccountSource.contains(".forEach { it.onSubmissionFailed() }"))
        val missingConfiguration = createAccountSource.substringAfter("if (host == null").substringBefore("performCreation")
        val unexpectedAccountFailure = createAccountSource.substringAfter("catch (e: Exception)").substringBefore("if (attempt is CreationAttempt.SettingsResolution)")
        val retryPresentation = createAccountSource.substringAfter("private fun notifyRecoverableFailure").substringBefore("private fun notifyAccountCreationFailed")
        assertTrue(missingConfiguration.contains("notifyRecoverableFailure"))
        assertTrue(unexpectedAccountFailure.contains("recoverFromUnexpectedFailure"))
        assertFalse(unexpectedAccountFailure.contains("throw e"))
        assertTrue(retryPresentation.contains("recoverFromAccountCreationFailure"))
        assertTrue(activitySource.contains("supportFragmentManager.popBackStack()"))
        assertTrue(activitySource.contains("CREATE_RETRY_ERROR_TAG"))
        assertTrue(activitySource.contains("f.onSubmissionFailed()"))
        assertFalse(retryPresentation.contains("cancelBeforeAccountCreated"))
        assertTrue(retryPresentation.contains("SetupSecretHolder::clearCredentialsAndConfiguration"))
        assertFalse(retryPresentation.contains("SetupSecretHolder::revoke"))
    }

    @Test
    fun interruptedCoordinatorResultsUseTheTotalDurableEvidenceRouter() {
        val source = File(sourceRoot, "CreateAccountFragment.kt").readText()
        val coordinatorResultRouting = source.substringAfter("return when (val result = coordinator.create(creationId, fields))")
            .substringBefore("    /**\n     * Routes all interrupted")
        val unexpectedRecovery = source.substringAfter("private fun recoverFromUnexpectedFailure")
            .substringBefore("private fun creationAttemptFromDurableEvidence")
        val durableRouter = source.substringAfter("private fun creationAttemptFromDurableEvidence")
            .substringBefore("    sealed class CreationAttempt")

        val sharedDurableBranch = Regex(
            "AccountCreationCoordinator\\.Result\\.EXISTS_OR_BUSY,\\s*" +
                "AccountCreationCoordinator\\.Result\\.NOT_ADDED,\\s*" +
                "AccountCreationCoordinator\\.Result\\.QUARANTINED,\\s*" +
                "AccountCreationCoordinator\\.Result\\.QUARANTINE_FAILED\\s*->\\s*" +
                "creationAttemptFromDurableEvidence\\(account, accountManager, registry, creationId\\)"
        )
        assertTrue(sharedDurableBranch.containsMatchIn(coordinatorResultRouting))
        assertFalse(coordinatorResultRouting.contains("resumableOwnedIncomplete"))
        assertTrue(unexpectedRecovery.contains("rowObserved = account in manager.getAccountsByType"))
        assertTrue(unexpectedRecovery.contains("if (rowObserved) CreationAttempt.SettingsResolution(account) else CreationAttempt.RetryCredentials"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.outcome"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.Outcome.Recovery -> CreationAttempt.Recovery"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.Outcome.Created -> CreationAttempt.Created"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.Outcome.Completed -> CreationAttempt.Completed"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.Outcome.SettingsResolution -> CreationAttempt.SettingsResolution"))
        assertTrue(durableRouter.contains("DurableCreationAttemptPolicy.Outcome.RetryCredentials -> CreationAttempt.RetryCredentials"))
        assertTrue(source.contains("data class Created(val account: Account, val creationId: String)"))
        assertTrue(source.contains("data class Completed(val account: Account, val creationId: String)"))
        assertTrue(coordinatorResultRouting.contains(
            "AccountCreationCoordinator.Result.CREATED -> CreationAttempt.Created(account, creationId)"
        ))
        assertTrue(coordinatorResultRouting.contains(
            "AccountCreationCoordinator.Result.ACCOUNT_CREATED_QUARANTINED ->\n" +
                "                    creationAttemptFromDurableEvidence(account, accountManager, registry, creationId)"
        ))
        assertTrue(source.contains("if (verifiedId != expectedId)"))
        assertTrue(source.contains("openSetup() { startActivity(PostLoginSetupActivity.newIntent(requireContext(), account, expectedId)) }"))
        assertTrue(source.contains("openDashboard() { startActivity(AccountActivity.newIntent(requireContext(), account, expectedId)) }"))
        assertTrue(source.contains("creationId = if (savedInstanceState == null)"))
        assertTrue(source.contains("savedInstanceState.getString(KEY_CREATION_ID)?.takeIf"))
        assertTrue(source.contains("java.util.UUID.fromString(value)"))
        assertTrue(source.contains("hadStartedBeforeSave &&"))
        assertTrue(source.contains("outState.putBoolean(KEY_HAD_STARTED, hadStartedBeforeSave)"))
        assertTrue(source.contains("outState.putString(KEY_CREATION_ID, creationId)"))
        assertTrue(source.contains("createAccount(config.userName, config, creationId)"))
        assertTrue(source.contains("recoverFromUnexpectedFailure(config.userName, creationId)"))
        assertTrue(source.contains("expectedCreationId: String,"))
        assertFalse(source.contains("expectedCreationId: String? = null"))
    }

    @Test fun loginFailureDialogsPersistOnlyResourceIdentifiers() {
        listOf("DetectConfigurationFragment.kt", "LoginCredentialsChangeFragment.kt").forEach { name ->
            val source = File(sourceRoot, name).readText()
            assertFalse(source.contains("localizedMessage"))
            assertFalse(source.contains("KEY_LOGS"))
            assertTrue(source.contains("putInt(KEY_MESSAGE_RES"))
        }
    }

    @Test fun configurationDetectionRethrowsCoroutineCancellation() {
        listOf("DetectConfigurationFragment.kt", "LoginCredentialsChangeFragment.kt").forEach { name ->
            val source = File(sourceRoot, name).readText()
            assertTrue(source.contains("import kotlinx.coroutines.CancellationException"))
            assertTrue(source.contains("if (e is CancellationException) throw e"))
        }
    }

    @Test fun changedCredentialsFailureCanOpenLogsWithoutPassingRawPayload() {
        val source = File(sourceRoot, "LoginCredentialsChangeFragment.kt").readText()
        val dialog = source.substringAfter("class NothingDetectedFragment").substringBefore("companion object")

        assertTrue(dialog.contains("setNeutralButton(R.string.login_view_logs)"))
        assertTrue(dialog.contains("DebugInfoActivity.newIntent"))
        assertFalse(dialog.contains("KEY_LOGS"))
        assertFalse(dialog.contains("putExtra"))
    }

    @Test
    fun accountRecreationRuntimeJobUsesTheRequiredUnsignedMatrixAndPinnedRunner() {
        val workflow = File("../../.github/workflows/build-android.yml").readText()
        val runtimeScript = File("../scripts/run-focused-runtime-tests.sh").readText()
        val navigationWrapper = File("../scripts/run-focused-runtime-with-navigation.sh").readText()
        val unsignedBuild = workflow.substringAfter("  build-pr:").substringBefore("  account-recreation-runtime:")
        val job = workflow.substringAfter("account-recreation-runtime:").substringBefore("  # ─────────────────────────────────────────────────────────────────────\n  # Release")
        val runnerReference = Regex("ReactiveCircus/android-emulator-runner@([0-9a-f]{40})").find(job)

        assertTrue(job.contains("contents: read"))
        assertEquals(2, Regex("""api-level: 21\n\s+arch: x86""").findAll(job).count())
        assertEquals(1, Regex("""api-level: 35\n\s+arch: x86_64""").findAll(job).count())
        assertEquals(1, Regex("""api-level: 36\n\s+arch: x86_64\n\s+shard: account-dashboard""").findAll(job).count())
        assertEquals(1, Regex("""api-level: 36\n\s+arch: x86_64\n\s+shard: first-run-setup""").findAll(job).count())
        assertEquals(1, Regex("""api-level: 36\n\s+arch: x86_64\n\s+shard: status-routes""").findAll(job).count())
        assertEquals(1, Regex("shard: mixed").findAll(job).count())
        assertEquals(1, Regex("shard: remaining").findAll(job).count())
        assertEquals(1, Regex("shard: all").findAll(job).count())
        assertTrue(job.contains("""name: Account recreation (API ${'$'}{{ matrix.api-level }}, ${'$'}{{ matrix.arch }}, ${'$'}{{ matrix.shard }})"""))
        assertTrue(runnerReference != null)
        listOf(
            "app:testDebugUnitTest", "app:lintDebug", "app:assembleDebugAndroidTest",
            "cert4android:assembleDebugAndroidTest", "ical4android:assembleDebugAndroidTest",
            "vcard4android:assembleDebugAndroidTest"
        ).forEach { command -> assertTrue(unsignedBuild.contains(command)) }
        assertTrue(job.contains("""script: bash android/scripts/run-focused-runtime-with-navigation.sh "${'$'}{{ matrix.api-level }}" "${'$'}{{ matrix.shard }}" "${'$'}{{ matrix.navigation-mode }}""""))
        assertTrue(navigationWrapper.contains("exec bash \"${'$'}(dirname \"${'$'}0\")/run-focused-runtime-tests.sh\" \"${'$'}api_level\" \"${'$'}shard\""))
        assertTrue(navigationWrapper.contains("settings get secure navigation_mode"))
        assertTrue(job.contains("""name: account-recreation-androidTest-api${'$'}{{ matrix.api-level }}-${'$'}{{ matrix.arch }}-${'$'}{{ matrix.shard }}-${'$'}{{ github.sha }}"""))
        listOf(
            "app:connectedDebugAndroidTest", "focused-runtime-ledger-v1.json", "len(tests) != 84",
            "-Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true",
            "-PrequireEtebase16Kb=true", "--no-daemon"
        ).forEach { command -> assertTrue(runtimeScript.contains(command)) }
        assertTrue(job.contains("if: always()") && job.contains("retention-days: 14"))
        assertFalse(job.contains("secrets."))
        assertTrue(unsignedBuild.contains("ANDROID_BUILD_TOOLS_VERSION: '36.0.0'"))
        assertTrue(unsignedBuild.contains("\"\$ANDROID_HOME/build-tools/\$ANDROID_BUILD_TOOLS_VERSION/aapt\""))
        assertTrue(unsignedBuild.contains("sdkVersion:'21'"))
        assertTrue(unsignedBuild.contains("targetSdkVersion:'36'"))
        assertTrue(unsignedBuild.contains("grep -Fxc \"sdkVersion:"))
        assertTrue(unsignedBuild.contains("grep -Fxc \"targetSdkVersion:"))
    }

    @Test
    fun api36BackContractsUseDebugOnlyWebViewContentAndDispatcherCallbacks() {
        val appBuild = File("build.gradle").readText()
        val webView = File("src/main/java/io/silentsuite/sync/ui/WebViewActivity.kt").readText()
        val importActivity = File("src/main/java/io/silentsuite/sync/ui/importlocal/ImportActivity.kt").readText()
        val runtime = File("src/androidTest/java/io/silentsuite/sync/ui/SiblingRoutesRuntimeTest.kt").readText()

        assertTrue(appBuild.contains("targetSdkVersion 36"))
        listOf(webView, importActivity).forEach { source ->
            assertFalse(source.contains("KeyEvent"))
            assertFalse(source.contains("onKeyDown("))
            assertTrue(source.contains("OnBackPressedCallback"))
            assertTrue(source.contains("onBackPressedDispatcher.addCallback(this"))
        }
        assertTrue(webView.contains("BuildConfig.DEBUG"))
        assertTrue(webView.contains("EXTRA_DEBUG_INITIAL_HTML"))
        assertTrue(webView.contains("debugWebViewClientOverride"))
        assertTrue(webView.contains("Constants.registrationUrl"))
        listOf(
            "importDispatcherBackPopsNestedStackThenFinishesWithCanceledResult",
            "importToolbarUpPopsNestedStackThenFinishesWithCanceledResult",
            "importSystemBackPopsNestedStackThenFinishesWithCanceledResult",
            "webViewDispatcherBackConsumesLocalHistoryThenFinishes",
            "webViewToolbarUpFinishesInsteadOfTraversingLocalHistory",
            "webViewSystemBackConsumesLocalHistoryThenFinishes",
        ).forEach { method -> assertTrue(runtime.contains("fun $method()")) }
        assertTrue(runtime.contains("UiDevice.getInstance"))
    }

    @Test
    fun focusedRuntimeExpectedSetIncludesFirstRunAndSetupLifecycleContracts() {
        val ledger = File("../scripts/focused-runtime-ledger-v1.json").readText()
        listOf(
            "recoverableCreationFailureRestoresCredentialsWithoutFinishingOrCancelling",
            "cleanInstallBootstrapPublishesMarkerAfterReconciliation",
            "accountChoiceAndCredentialNavigationRemainExact",
            "signupReturnClaimsOnlyOwningFlowAndIsIdempotent",
            "normalAuthenticatorAndLegacyRestorationUseSafeDestinations",
            "accountEntryRemainsAccessibleAcrossConfigurations",
        ).forEach { assertTrue(ledger.contains("\"$it\"")) }
        assertFalse(ledger.contains("combinedSignInKeepsPrimaryActionReachableAndSecretsOutOfSavedState"))
        assertFalse(ledger.contains("normalAndAuthenticatorModesUseOneCombinedCredentialSurfaceAcrossRecreation"))
    }

    @Test
    fun dashboardRuntimePhaseControlIsPublishedAcrossInstrumentationAndLoaderThreads() {
        val source = File("src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").readText()
        val test = source.substringAfter(
            "@Test fun requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention()"
        ).substringBefore("@Test fun freshContactsGenerationFinishesBeforeChildDispatchOrCompletion()")

        assertTrue(test.contains("val phase = AtomicInteger(0)"))
        assertTrue(test.contains("phase.get() == 1"))
        assertTrue(test.contains("phase.get() == 2"))
        listOf(1, 2, 3).forEach { phase ->
            assertTrue(test.contains("phase.set($phase)"))
        }
        assertFalse(test.contains("var phase = 0"))
    }

    @Test
    fun freshEmulatorShardsAreBoundedDisjointAndExactlyCoverRuntimeMethods() {
        val runtimeScript = File("../scripts/run-focused-runtime-tests.sh").readText()
        assertTrue(runtimeScript.contains("focused-runtime-ledger-v1.json"))
        assertTrue(runtimeScript.contains("if len(tests) != 84 or len(set(tests)) != 84"))
        listOf(
            "\"21:mixed\": 1", "\"21:requested\": 1", "\"21:remaining\": 82",
            "\"35:all\": 84", "\"36:account-dashboard\": 27",
            "\"36:first-run-setup\": 17", "\"36:status-routes\": 40",
        ).forEach { assertTrue(runtimeScript.contains(it)) }
        assertTrue(runtimeScript.contains("remaining_selectors=\"\$(ledger_selectors '21:remaining')\""))
        assertTrue(runtimeScript.contains("all_selectors=\"\$(ledger_selectors '35:all')\""))
        assertFalse(runtimeScript.contains("other77_selectors"))
        assertFalse(runtimeScript.contains("focused_classes="))
        assertEquals(listOf("600", "600", "1500", "2400", "1800", "1800", "1800"),
            Regex("""timeout --signal=TERM --kill-after=10s (\d+)s""")
                .findAll(runtimeScript).map { it.groupValues[1] }.toList())
        assertTrue(600 + 1500 < 45 * 60 && 2400 < 45 * 60)
        assertTrue(runtimeScript.indexOf("trap restore_requested_results EXIT") <
            runtimeScript.indexOf("""class="${'$'}{requested_selector}""""))
        assertTrue(runtimeScript.indexOf("\n  save_requested_results",
            runtimeScript.indexOf("""class="${'$'}{requested_selector}""")) <
            runtimeScript.indexOf("""class="${'$'}{remaining_selectors}""""))
        assertTrue(runtimeScript.contains("connected/api21-requested"))
        assertFalse(runtimeScript.contains("api21_batch_"))
        assertTrue(runtimeScript.contains("""if [[ "${'$'}{status}" -eq 0 && "${'$'}{restore_status}" -ne 0 ]]"""))
    }

    @Test
    fun dashboardLifecycleObservationAvoidsRepeatedActivityScenarioPolling() {
        val source = File("src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").readText()
        val lifecycle = source.substringAfter(
            "@Test fun requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention()"
        ).substringBefore("@Test fun freshContactsGenerationFinishesBeforeChildDispatchOrCompletion()")
        val observerPoll = source.substringAfter("private fun waitForObservedText(")
            .substringBefore("private fun waitForText(")

        assertEquals(6, Regex("scenario\\.onActivity").findAll(lifecycle).count())
        assertEquals(1, Regex("addTextChangedListener").findAll(lifecycle).count())
        assertTrue(lifecycle.contains("observe(R.id.dashboard_overall_status, overallText)"))
        assertTrue(lifecycle.contains("observe(R.id.caldav_status, caldavText)"))
        assertTrue(lifecycle.contains("waitForObservedText("))
        assertFalse(lifecycle.contains("waitForText(scenario"))
        assertFalse(lifecycle.contains("assertNoGenericAttention(scenario)"))
        assertTrue(lifecycle.contains("SyncLifecycleWindows(interruptionAfterMillis = Long.MAX_VALUE)"))
        assertFalse(lifecycle.contains("lifecycle-diagnostic"))
        assertTrue(observerPoll.contains("AtomicReference<String>"))
        assertTrue(observerPoll.contains("System.nanoTime()"))
        assertFalse(observerPoll.contains("scenario.onActivity"))
    }

    @Test
    fun mixedDashboardObserversPrecedeMutationAndAvoidPostRefreshBarriers() {
        val source = File("src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").readText()
        val mixed = source.substringAfter(
            "@Test fun mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue()"
        ).substringBefore("@Test fun futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent()")

        assertEquals(1, Regex("scenario\\.onActivity").findAll(mixed).count())
        assertEquals(1, Regex("addTextChangedListener").findAll(mixed).count())
        assertTrue(mixed.indexOf("scenario.onActivity") < mixed.indexOf("val store = SyncStatusStore(context)"))
        assertTrue(mixed.contains("observe(R.id.dashboard_overall_status, overallText)"))
        assertTrue(mixed.contains("observe(R.id.caldav_status, caldavText)"))
        assertTrue(mixed.contains("observe(R.id.carddav_status, carddavText)"))
        assertEquals(4, Regex("waitForObservedText\\(").findAll(mixed).count())
        assertFalse(mixed.contains("waitForText(scenario"))
        assertTrue(mixed.contains("val dashboardActivity = AtomicReference<AccountActivity>()"))
        assertTrue(mixed.contains("dashboardActivity.set(activity)"))
        assertTrue(mixed.contains("activity.runOnUiThread { activity.refresh() }"))
        assertFalse(mixed.substringAfter("val store = SyncStatusStore(context)").contains("scenario.onActivity"))
        assertTrue(mixed.contains("assertEquals(syncing, overallText.get())"))
        assertTrue(mixed.contains("assertEquals(syncing, caldavText.get())"))
        assertTrue(mixed.contains("assertEquals(issue, carddavText.get())"))
        assertTrue(mixed.contains("val calendarRefreshing = AtomicBoolean(false)"))
        assertTrue(mixed.contains("it.refreshing = calendarRefreshing.get()"))
        assertTrue(mixed.indexOf("calendarRefreshing.set(true)") <
            mixed.indexOf("val store = SyncStatusStore(context)"))
        assertTrue(mixed.contains("calendarRefreshing.set(false)"))
        assertTrue(mixed.indexOf("calendarRefreshing.set(false)") >
            mixed.indexOf("categories.forEachIndexed"))
        assertTrue(mixed.contains("dashboard_status_never_synced"))
        assertFalse(mixed.contains("mixed-diagnostic"))
        assertFalse(source.contains("helper-diagnostic"))
    }

    @Test
    fun sharedDashboardTextWaitUsesOneActivityScenarioBarrierAndEventDrivenPolling() {
        val source = File("src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").readText()
        val helper = source.substringAfter("private fun waitForText(")
            .substringBefore("private fun assertNoGenericAttention")

        assertEquals(1, Regex("scenario\\.onActivity").findAll(helper).count())
        assertTrue(helper.contains("addTextChangedListener"))
        assertTrue(helper.contains("AtomicReference<String>"))
        assertTrue(helper.contains("System.nanoTime()"))
        assertTrue(helper.contains("SystemClock.sleep(50)"))
        assertFalse(helper.contains("repeat(200)"))
    }
}
