package io.silentsuite.sync.ui.etebase

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NewAccountWizardLifecycleContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync/ui/etebase")

    @Test
    fun everyWizardActivityInitializesItsModelFromTheDurableAccountRoute() {
        val source = File(sourceRoot, "NewAccountWizardActivity.kt").readText()
        val onCreate = source.substringAfter("override fun onCreate").substringBefore("override fun finish")

        assertTrue(onCreate.contains("SetupSecretHolder.consumePendingSession(account.name)"))
        assertTrue(onCreate.contains("model.initialize(this, account, etebaseSession)"))
        assertTrue(onCreate.indexOf("model.initialize(this, account, etebaseSession)") < onCreate.indexOf("if (savedInstanceState == null)"))
        assertFalse(onCreate.substringAfter("if (savedInstanceState == null)").contains("model.initialize("))
    }

    @Test
    fun restoredWizardFragmentsInitializeViewsAndObserveWithoutRepeatingActions() {
        val source = File(sourceRoot, "NewAccountWizardActivity.kt").readText()
        val checkFragment = source.substringAfter("class WizardCheckFragment").substringBefore("class WizardFragment")
        val wizardFragment = source.substringAfter("class WizardFragment")

        assertTrue(checkFragment.contains("override fun onViewCreated"))
        assertTrue(checkFragment.contains("initUi(view)"))
        assertTrue(checkFragment.contains("model.observe(viewLifecycleOwner)"))
        assertTrue(checkFragment.contains("if (loadingModel.isLoading)"))
        assertFalse(checkFragment.contains("if (savedInstanceState == null)"))

        assertTrue(wizardFragment.contains("override fun onViewCreated"))
        assertTrue(wizardFragment.contains("initUi(view)"))
        assertTrue(wizardFragment.contains("model.observe(viewLifecycleOwner)"))
        assertTrue(wizardFragment.contains("automaticCreationStarted"))
        assertTrue(wizardFragment.contains("KEY_AUTOMATIC_CREATION_STARTED"))
        assertTrue(wizardFragment.contains("if (loadingModel.isLoading)"))
        assertFalse(wizardFragment.contains("if (savedInstanceState == null)"))
    }

    @Test
    fun accountModelInitializationIsIdempotentAndRetainsTheExactAccount() {
        val source = File(sourceRoot, "CollectionActivity.kt").readText()
        val model = source.substringAfter("class AccountViewModel").substringBefore("data class AccountHolder")

        assertTrue(model.contains("private var initializedAccount: Account? = null"))
        assertTrue(model.contains("fun initialize(context: Context, account: Account"))
        assertTrue(model.contains("if (initializedAccount == account)"))
        assertTrue(model.contains("AccountViewModel cannot be reused for another account"))
        assertTrue(model.contains("AccountSettings(context, account)"))
    }
}
