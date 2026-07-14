package io.silentsuite.sync.ui.setup

import org.junit.Assert.assertFalse
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
    fun loginSubmissionIsGuardedBeforeTheDetectorTransactionAndResetsOnlyOnFailure() {
        val loginSource = File(sourceRoot, "LoginCredentialsFragment.kt").readText()
        val detectorSource = File(sourceRoot, "DetectConfigurationFragment.kt").readText()

        assertTrue(loginSource.contains("private var submissionInProgress = false"))
        assertTrue(loginSource.contains("setFragmentResultListener(SUBMISSION_FAILED_RESULT, this)"))
        assertTrue(loginSource.contains("if (credentials != null && !submissionInProgress &&"))
        assertTrue(loginSource.contains("findFragmentByTag(DETECT_CONFIGURATION_TAG) == null"))
        assertTrue(loginSource.indexOf("submissionInProgress = true") < loginSource.indexOf("DetectConfigurationFragment.newInstance().show"))
        assertTrue(detectorSource.contains("setFragmentResult(LoginCredentialsFragment.SUBMISSION_FAILED_RESULT"))
    }

    @Test
    fun accountRecreationRuntimeJobUsesTheRequiredUnsignedMatrixAndPinnedRunner() {
        val workflow = File("../../.github/workflows/build-android.yml").readText()
        val job = workflow.substringAfter("account-recreation-runtime:").substringBefore("  # ─────────────────────────────────────────────────────────────────────\n  # Release")
        val runnerReference = Regex("ReactiveCircus/android-emulator-runner@([0-9a-f]{40})").find(job)

        assertTrue(job.contains("contents: read"))
        assertTrue(job.contains("api-level: 21") && job.contains("arch: x86"))
        assertTrue(job.contains("api-level: 35") && job.contains("arch: x86_64"))
        assertTrue(runnerReference != null)
        assertTrue(job.contains("script: cd android && ./gradlew connectedDebugAndroidTest"))
        assertTrue(job.contains("io.silentsuite.sync.ui.AccountActivityRecreationTest"))
        assertTrue(job.contains("-PrequireEtebase16Kb=true"))
        assertTrue(job.contains("if: always()") && job.contains("retention-days: 14"))
        assertFalse(job.contains("secrets."))
    }
}
