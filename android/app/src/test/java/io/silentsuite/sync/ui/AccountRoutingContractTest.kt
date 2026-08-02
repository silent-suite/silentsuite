package io.silentsuite.sync.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AccountRoutingContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync")

    @Test
    fun releaseDependenciesNeverResolveThroughUnboundedSnapshotRepositories() {
        val rootBuild = File("../build.gradle").readText()
        assertFalse(rootBuild.contains("oss.sonatype.org/content/repositories/snapshots"))
    }

    @Test
    fun settingsAndPostLoginSetupKeepTheExactAccount() {
        val accountActivity = File(sourceRoot, "ui/AccountActivity.kt").readText()
        val appSettings = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
        val legacySettings = File(sourceRoot, "ui/AccountSettingsActivity.kt").readText()
        val notification = File(sourceRoot, "syncadapter/SyncNotification.kt").readText()
        val setup = File(sourceRoot, "ui/setup/PostLoginSetupActivity.kt").readText()

        assertTrue(accountActivity.contains("AppSettingsActivity.newIntent(this, account, accountCreationId)"))
        assertTrue(accountActivity.contains("InvitationsActivity.newIntent(this, account, accountCreationId)"))
        assertTrue(Regex(
            """fun newIntent\(\s*context: Context,\s*account: Account,\s*creationId: String,"""
        ).containsMatchIn(appSettings))
        assertTrue(appSettings.contains("const val EXTRA_CREATION_ID = \"account_creation_id\""))
        assertTrue(appSettings.contains("intent.getParcelableExtra<Account>(EXTRA_ACCOUNT)"))
        assertTrue(appSettings.contains("ExactAccountRouting.validate(candidate, creationId"))
        assertTrue(appSettings.contains("outState.putString(STATE_CREATION_ID, selectedCreationId)"))
        assertFalse(appSettings.contains("account = accounts[0]"))
        assertTrue(legacySettings.contains("SettingsCategory.SYNC"))
        assertTrue(legacySettings.contains("AppSettingsActivity.newIntent("))
        assertTrue(legacySettings.contains("AppSettingsActivity.EXTRA_CREATION_ID"))
        assertTrue(notification.contains("detailsIntent.putExtras(extras)"))
        assertTrue(setup.contains("val exact = exactAccount() ?: return true"))
        assertTrue(setup.contains("AccountActivity.newIntent(this, exact, creationId)"))
        assertFalse(setup.contains("AccountActivity.newIntent(this, account, creationId)"))
    }

    @Test
    fun accountModelInitializesIdempotentlyAndEveryActivityObserves() {
        val source = File(sourceRoot, "ui/AccountActivity.kt").readText()

        assertTrue(source.contains("model.initialize(this, account, accountCreationId)"))
        assertTrue(source.contains("model.observe(this)"))
        assertTrue(source.contains("private var initializedIdentity: ExactAccountIdentity? = null"))
        assertTrue(source.contains("fun initialize(context: Context, account: Account, creationId: String)"))
        assertTrue(source.contains("if (initializedIdentity == identity)"))
        assertTrue(source.contains("if (model.value == null)"))
    }

    @Test
    fun accountModelRejectsReplacementGenerationBeforePrivateReadsAndPublication() {
        val source = File(sourceRoot, "ui/AccountActivity.kt").readText()
        val model = source.substringAfter("class AccountInfoViewModel").substringBefore("/* LIST ADAPTERS */")

        assertTrue(model.contains("((Context, Account, String) -> AccountActivity.AccountInfo)?"))
        assertTrue(model.contains("loader(context, account, accountCreationId)"))
        assertTrue(model.contains("if (!exactGenerationStillCurrent()) return null"))
        assertTrue(model.contains("return info.takeIf { exactGenerationStillCurrent() }"))
        assertTrue(model.contains("info != null && !cleared && exactGenerationStillCurrent()"))
        assertFalse(model.contains("AccountActivity.AccountInfo() else null"))
        assertTrue(model.contains("var ordinaryFailure = false"))
        assertTrue(model.contains("loadFailed = true"))
    }

    @Test
    fun exporterAndNotificationRoutesRequireTheCapturedGeneration() {
        val exporter = File(sourceRoot, "dataexport/AndroidDataExporter.kt").readText()
        val syncManager = File(sourceRoot, "syncadapter/SyncManager.kt").readText()
        val syncAdapter = File(sourceRoot, "syncadapter/SyncAdapterService.kt").readText()

        assertTrue(exporter.contains("creationId: String"))
        assertTrue(exporter.contains("require(creationId.isNotBlank())"))
        assertTrue(exporter.contains("ExactAccountRouting.validate("))
        assertTrue(exporter.contains("exactGenerationStillCurrent: () -> Boolean"))
        assertTrue(exporter.contains("fun writeCollectionExport("))
        assertTrue(syncManager.contains("setAccount(account, accountCreationId)"))
        assertTrue(syncAdapter.contains("setAccount(account, accountCreationId)"))
    }
}
