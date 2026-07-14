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
        val invalidAccount = createAccountSource.substringAfter("catch (e: InvalidAccountException)").substringBefore("if (account != null)")
        val unexpectedAccountFailure = createAccountSource.substringAfter("catch (e: Exception)").substringBefore("if (account != null)")
        val rejectedAccount = createAccountSource.substringAfter("addAccountExplicitly returned false").substringBefore("}\n    }")
        assertTrue(missingConfiguration.contains("notifyAccountCreationFailed()"))
        assertTrue(invalidAccount.contains("notifyAccountCreationFailed()"))
        assertTrue(unexpectedAccountFailure.contains("notifyAccountCreationFailed()"))
        assertTrue(rejectedAccount.contains("notifyAccountCreationFailed()"))
    }

    @Test
    fun accountRecreationRuntimeJobUsesTheRequiredUnsignedMatrixAndPinnedRunner() {
        val workflow = File("../../.github/workflows/build-android.yml").readText()
        val appBuild = File("build.gradle").readText()
        val job = workflow.substringAfter("account-recreation-runtime:").substringBefore("  # ─────────────────────────────────────────────────────────────────────\n  # Release")
        val runnerReference = Regex("ReactiveCircus/android-emulator-runner@([0-9a-f]{40})").find(job)

        assertTrue(job.contains("contents: read"))
        assertTrue(job.contains("api-level: 21") && job.contains("arch: x86"))
        assertTrue(job.contains("api-level: 35") && job.contains("arch: x86_64"))
        assertTrue(runnerReference != null)
        assertTrue(job.contains("script: cd android && ./gradlew app:connectedDebugAndroidTest"))
        assertTrue(job.contains("io.silentsuite.sync.ui.AccountActivityRecreationTest"))
        assertTrue(job.contains("-PrequireEtebase16Kb=true"))
        assertTrue(job.contains("if: always()") && job.contains("retention-days: 14"))
        assertFalse(job.contains("secrets."))
        assertTrue(appBuild.contains("androidTestImplementation \"org.jetbrains.kotlin:kotlin-stdlib:\$kotlin_version\""))
        assertTrue(appBuild.contains("'proguard-debug-test-rules.pro'"))
    }
}
