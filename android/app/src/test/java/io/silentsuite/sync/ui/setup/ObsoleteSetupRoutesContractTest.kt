package io.silentsuite.sync.ui.setup

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ObsoleteSetupRoutesContractTest {
    private val main = File("src/main")
    private val androidTest = File("src/androidTest")

    @Test
    fun supportedRoutesUsePostLoginSetupAndRetainExternalSignupReturn() {
        val manifest = File(main, "AndroidManifest.xml").readText()
        val creation = File(main, "java/io/silentsuite/sync/ui/setup/CreateAccountFragment.kt").readText()
        val launcher = File(main, "java/io/silentsuite/sync/ui/AccountActivity.kt").readText()
        val runtime = File(androidTest, "java/io/silentsuite/sync/ui/AccountActivityRecreationTest.kt").readText()
        val screenshotProvisioner = File(androidTest, "java/io/silentsuite/screenshots/ScreenshotAccountProvisioner.kt").readText()

        assertTrue(manifest.contains(".ui.setup.PostLoginSetupActivity"))
        assertTrue(manifest.contains(".ui.setup.SignupReturnActivity"))
        assertTrue(manifest.contains("android:scheme=\"silentsuite\" android:host=\"signup-complete\""))
        assertTrue(creation.contains("PostLoginSetupActivity.newIntent"))
        assertTrue(launcher.contains("PostLoginSetupActivity.newIntent"))
        assertTrue(runtime.contains("ActivityScenario.launch<PostLoginSetupActivity>(PostLoginSetupActivity.newIntent(context, account, \"setup-generation\"))"))
        assertTrue(screenshotProvisioner.contains("AccountSettings.KEY_CREATION_ID"))
        assertTrue(screenshotProvisioner.contains("PostLoginSetupState.COMPLETE"))
    }

    @Test
    fun obsoleteRoutesResourcesAndBridgeModePreferenceStayRetired() {
        val obsoleteNames = listOf(
            "ModeSelectionActivity",
            "NewAccountWizardActivity",
            "WelcomeFragment",
            "SignupFragment",
            "mode_selector_fragment",
            "account_wizard_check",
            "account_wizard_collections",
            "welcome_fragment",
            "signup_fragment",
            "app_mode",
            "sync_mode"
        )
        val supportedSource = sequenceOf(main, androidTest)
            .flatMap { root -> root.walkTopDown() }
            .filter { it.isFile && it.extension in setOf("kt", "java", "xml") }
            .joinToString("\n") { it.readText() }

        obsoleteNames.forEach { name ->
            assertFalse("Obsolete setup contract must stay retired: $name", supportedSource.contains(name))
        }
    }
}
