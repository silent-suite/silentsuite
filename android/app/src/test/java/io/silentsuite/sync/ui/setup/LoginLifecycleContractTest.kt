package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LoginLifecycleContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync/ui/setup")

    @Test
    fun invalidSignupReturnStartsANewClearedLoginTask() {
        val source = File(sourceRoot, "SignupReturnActivity.kt").readText()
        val fallback = source.substringAfter("} else {").substringBefore("}\n        finish()")

        assertTrue(fallback.contains("Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK"))
        assertFalse(fallback.contains("FLAG_ACTIVITY_CLEAR_TOP"))
        assertFalse(fallback.contains("FLAG_ACTIVITY_SINGLE_TOP"))
    }

    @Test
    fun validSignupReturnKeepsTheExistingLoginTaskRoute() {
        val source = File(sourceRoot, "SignupReturnActivity.kt").readText()
        val valid = source.substringAfter("if (SignupContinuationRegistry.isValid").substringBefore("} else {")

        assertTrue(valid.contains("Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP"))
    }

    @Test
    fun loginSubmissionIsGuardedBeforeTheDetectorTransactionAndResetsForEverySetupFailure() {
        val loginSource = File(sourceRoot, "LoginCredentialsFragment.kt").readText()
        val detectorSource = File(sourceRoot, "DetectConfigurationFragment.kt").readText()
        val createAccountSource = File(sourceRoot, "CreateAccountFragment.kt").readText()

        assertTrue(loginSource.contains("private var submissionInProgress = false"))
        assertTrue(loginSource.contains("internal fun onSubmissionFailed()"))
        assertTrue(loginSource.contains("if (credentials != null && !submissionInProgress &&"))
        assertTrue(loginSource.contains("findFragmentByTag(DETECT_CONFIGURATION_TAG) == null"))
        assertTrue(loginSource.indexOf("submissionInProgress = true") < loginSource.indexOf("DetectConfigurationFragment.newInstance().show"))
        assertTrue(detectorSource.contains("findFragmentById(android.R.id.content) as? LoginCredentialsFragment"))
        assertTrue(detectorSource.contains("?.onSubmissionFailed()"))
        assertTrue(createAccountSource.contains("private fun notifyAccountCreationFailed()"))
        assertTrue(createAccountSource.contains("fragments.filterIsInstance<LoginCredentialsFragment>()"))
        assertTrue(createAccountSource.contains(".forEach { it.onSubmissionFailed() }"))
        val missingConfiguration = createAccountSource.substringAfter("if (config == null)").substringBefore("val activity")
        val unexpectedAccountFailure = createAccountSource.substringAfter("catch (e: Exception)").substringBefore("if (attempt is CreationAttempt.SettingsResolution)")
        val retryPresentation = createAccountSource.substringAfter("private fun notifyRecoverableFailure").substringBefore("private fun notifyAccountCreationFailed")
        assertTrue(missingConfiguration.contains("notifyRecoverableFailure"))
        assertTrue(unexpectedAccountFailure.contains("recoverFromUnexpectedFailure"))
        assertFalse(unexpectedAccountFailure.contains("throw e"))
        assertTrue(retryPresentation.contains("popBackStackImmediate()"))
        assertTrue(retryPresentation.contains("onSubmissionFailed()"))
        assertTrue(retryPresentation.contains("RETRY_ERROR_TAG"))
        assertFalse(retryPresentation.contains("cancelBeforeAccountCreated"))
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
                "creationAttemptFromDurableEvidence\\(account, accountManager, registry\\)"
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
        val unsignedBuild = workflow.substringAfter("  build-pr:").substringBefore("  account-recreation-runtime:")
        val job = workflow.substringAfter("account-recreation-runtime:").substringBefore("  # ─────────────────────────────────────────────────────────────────────\n  # Release")
        val runnerReference = Regex("ReactiveCircus/android-emulator-runner@([0-9a-f]{40})").find(job)

        assertTrue(job.contains("contents: read"))
        assertTrue(job.contains("api-level: 21") && job.contains("arch: x86"))
        assertTrue(job.contains("api-level: 35") && job.contains("arch: x86_64"))
        assertTrue(runnerReference != null)
        listOf(
            "app:testDebugUnitTest", "app:lintDebug", "app:assembleDebugAndroidTest",
            "cert4android:assembleDebugAndroidTest", "ical4android:assembleDebugAndroidTest",
            "vcard4android:assembleDebugAndroidTest"
        ).forEach { command -> assertTrue(unsignedBuild.contains(command)) }
        assertTrue(job.contains("""script: bash android/scripts/run-focused-runtime-tests.sh "${'$'}{{ matrix.api-level }}""""))
        listOf(
            "app:connectedDebugAndroidTest", "io.silentsuite.sync.ui.AccountActivityRecreationTest",
            "-PrequireEtebase16Kb=true", "--no-daemon"
        ).forEach { command -> assertTrue(runtimeScript.contains(command)) }
        assertTrue(job.contains("if: always()") && job.contains("retention-days: 14"))
        assertFalse(job.contains("secrets."))
    }

    @Test
    fun focusedRuntimeExpectedSetIncludesAuthenticatorLifecycleContracts() {
        val workflow = File("../../.github/workflows/build-android.yml").readText()
        val expectedSet = workflow.substringAfter("          expected={")
            .substringBefore("          }\n          seen=[]")
        val expectedTuple = "('io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest','recoverableCreationFailureRestoresCredentialsWithoutFinishingOrCancelling')"
        val bootstrapTuple = "('io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest','cleanInstallBootstrapPublishesMarkerAfterReconciliation')"

        assertTrue(expectedSet.contains(expectedTuple))
        assertTrue(expectedSet.contains(bootstrapTuple))
        assertTrue(expectedSet.contains("('io.silentsuite.sync.ui.PostLoginSetupRuntimeTest','accountCreatedSyncConfigurationEnablesCoreAuthoritiesWithoutRecovery')"))
        assertTrue(expectedSet.contains("('io.silentsuite.sync.ui.PostLoginSetupRuntimeTest','accountCreatedSyncFailureKeepsExactRowAndOffersContinueRetry')"))
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
    fun api21ThreeProcessBatchesAreBoundedOrderedAndExactlyCoverRuntimeMethods() {
        val runtimeScript = File("../scripts/run-focused-runtime-tests.sh").readText()
        val dashboard = "io.silentsuite.sync.ui.AccountDashboardRuntimeTest"
        val diagnostic = "$dashboard#requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention"
        val mixed = "$dashboard#mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue"
        val batchA = Regex("""^api21_batch_a='([^']+)'$""", RegexOption.MULTILINE)
            .find(runtimeScript)!!.groupValues[1].split(",")
        val batchB = Regex("""^api21_batch_b='([^']+)'$""", RegexOption.MULTILINE)
            .find(runtimeScript)!!.groupValues[1].split(",")
        val batchC = Regex("""^api21_batch_c='([^']+)'$""", RegexOption.MULTILINE)
            .find(runtimeScript)!!.groupValues[1].split(",")
        val focusedClasses = Regex("""^focused_classes='([^']+)'$""", RegexOption.MULTILINE)
            .find(runtimeScript)!!.groupValues[1].split(",")
        val expectedOtherDashboard = setOf(
            "freshContactsGenerationFinishesBeforeChildDispatchOrCompletion",
            "futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent",
            "truthfulDashboardTransitionsUseDurableEvidenceAndDedupeAcrossRecreation",
            "serviceModulesAndCompleteActionsPreserveMetadataAndExactAccountRouting",
            "retainedLoadRejectsSameNameReplacementBeforePublication",
            "initialLoadFailurePublishesTerminalErrorAndRefreshFailureRetainsValidDashboard",
            "retainedSurfaceRejectsReplacementBeforePrivateActionsAndRoutes",
            "dashboardExportCompletionPreservesExactDashboardAfterRecreation",
        ).map { "$dashboard#$it" }.toSet()

        assertEquals(listOf(diagnostic), batchA)
        assertEquals(listOf(mixed), batchB)
        assertEquals(expectedOtherDashboard, batchC.filter { it.startsWith("$dashboard#") }.toSet())
        assertTrue(batchA.toSet().intersect(batchB.toSet()).isEmpty())
        assertTrue(batchA.toSet().intersect(batchC.toSet()).isEmpty())
        assertTrue(batchB.toSet().intersect(batchC.toSet()).isEmpty())
        assertEquals(16, batchC.size)
        assertEquals(expectedOtherDashboard.toList(), batchC.take(8))
        val runtimeMethods = focusedClasses.flatMap { className ->
            val source = File(
                "src/androidTest/java/${className.replace('.', '/')}.kt"
            ).readText()
            Regex("""@Test\s+fun\s+(\w+)""").findAll(source)
                .map { "$className#${it.groupValues[1]}" }.toList()
        }
        val expandedBatches = (batchA + batchB + batchC).flatMap { selector ->
            if ("#" in selector) listOf(selector)
            else runtimeMethods.filter { it.startsWith("$selector#") }
        }
        assertEquals(66, runtimeMethods.size)
        assertEquals(66, runtimeMethods.toSet().size)
        assertEquals(runtimeMethods.toSet(), expandedBatches.toSet())
        assertEquals(66, expandedBatches.size)
        assertTrue(runtimeScript.contains(
            """timeout --signal=TERM --kill-after=10s 600s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${'$'}{api21_batch_a}""""
        ))
        assertTrue(runtimeScript.contains(
            """timeout --signal=TERM --kill-after=10s 300s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${'$'}{api21_batch_b}""""
        ))
        assertTrue(runtimeScript.contains(
            """timeout --signal=TERM --kill-after=10s 900s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${'$'}{api21_batch_c}""""
        ))
        assertTrue(runtimeScript.indexOf("trap restore_api21_batches EXIT") <
            runtimeScript.indexOf("""class="${'$'}{api21_batch_a}""""))
        assertTrue(runtimeScript.contains("connected/api21-batch-a"))
        assertTrue(runtimeScript.contains("connected/api21-batch-b"))
        assertTrue(runtimeScript.contains("api21_batch_a_results="))
        assertTrue(runtimeScript.contains("api21_batch_b_results="))
        assertTrue(runtimeScript.contains("api21_batch_b_started=1"))
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

        assertEquals(2, Regex("scenario\\.onActivity").findAll(mixed).count())
        assertEquals(1, Regex("addTextChangedListener").findAll(mixed).count())
        assertTrue(mixed.indexOf("scenario.onActivity") < mixed.indexOf("val store = SyncStatusStore(context)"))
        assertTrue(mixed.contains("observe(R.id.dashboard_overall_status, overallText)"))
        assertTrue(mixed.contains("observe(R.id.caldav_status, caldavText)"))
        assertTrue(mixed.contains("observe(R.id.carddav_status, carddavText)"))
        assertEquals(3, Regex("waitForObservedText\\(").findAll(mixed).count())
        assertFalse(mixed.contains("waitForText(scenario"))
        assertFalse(mixed.substringAfter("scenario.onActivity { it.refresh() }").contains("scenario.onActivity"))
        assertTrue(mixed.contains("assertEquals(syncing, overallText.get())"))
        assertTrue(mixed.contains("assertEquals(syncing, caldavText.get())"))
        assertTrue(mixed.contains("assertEquals(issue, carddavText.get())"))
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
