package io.silentsuite.sync.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AccountRoutingContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync")

    @Test
    fun settingsAndPostLoginSetupKeepTheExactAccount() {
        val accountActivity = File(sourceRoot, "ui/AccountActivity.kt").readText()
        val appSettings = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
        val legacySettings = File(sourceRoot, "ui/AccountSettingsActivity.kt").readText()
        val setup = File(sourceRoot, "ui/setup/PostLoginSetupActivity.kt").readText()

        assertTrue(accountActivity.contains("AppSettingsActivity.newIntent(this, account, SettingsCategory.HOME)"))
        assertTrue(appSettings.contains("fun newIntent("))
        assertTrue(appSettings.contains("account: Account?"))
        assertTrue(appSettings.contains("intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)"))
        assertTrue(appSettings.contains("EXTRA_CREATION_ID"))
        assertTrue(appSettings.contains("ExactAccountRouting.validate(candidate, creationId"))
        assertTrue(appSettings.contains("outState.putString(STATE_CREATION_ID, selectedCreationId)"))
        assertFalse(appSettings.contains("account = accounts[0]"))
        assertTrue(legacySettings.contains("SettingsCategory.SYNC"))
        assertTrue(legacySettings.contains("AppSettingsActivity.newIntent("))
        assertTrue(legacySettings.contains("AppSettingsActivity.EXTRA_CREATION_ID"))
        assertTrue(setup.contains("AccountActivity.newIntent(this, account)"))
    }

    @Test
    fun accountModelInitializesIdempotentlyAndEveryActivityObserves() {
        val source = File(sourceRoot, "ui/AccountActivity.kt").readText()

        assertTrue(source.contains("model.initialize(this, account)"))
        assertTrue(source.contains("model.observe(this)"))
        assertTrue(source.contains("if (initializedAccount == account)"))
        assertTrue(source.contains("if (model.value == null)"))
    }
}
