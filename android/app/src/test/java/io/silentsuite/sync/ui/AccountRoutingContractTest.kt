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

        assertTrue(accountActivity.contains("AppSettingsActivity.newIntent(this, account)"))
        assertTrue(appSettings.contains("fun newIntent(context: Context, account: Account?)"))
        assertTrue(appSettings.contains("intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)"))
        assertFalse(appSettings.contains("account = accounts[0]"))
        assertTrue(legacySettings.contains("AppSettingsActivity.newIntent(this, intent.getParcelableExtra"))
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
