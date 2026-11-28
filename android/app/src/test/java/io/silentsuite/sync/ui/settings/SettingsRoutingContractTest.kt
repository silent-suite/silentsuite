package io.silentsuite.sync.ui.settings

import io.silentsuite.sync.notes.NotesNetworkPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SettingsRoutingContractTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync")
    private val resourceRoot = File("src/main/res/xml")

    @Test
    fun categoryHubAndProgressiveDisclosureResourcesStayComplete() {
        val expected = listOf(
            "settings_home.xml", "settings_account.xml", "settings_sync.xml",
            "settings_notifications.xml", "settings_appearance.xml",
            "settings_privacy_security.xml", "settings_help.xml", "settings_advanced.xml"
        )
        expected.forEach { assertTrue("Missing $it", File(resourceRoot, it).isFile) }
        val home = File(resourceRoot, "settings_home.xml").readText()
        listOf("settings_category_account", "settings_category_sync", "settings_category_notifications",
            "settings_category_appearance", "settings_category_privacy_security", "settings_category_help")
            .forEach { assertTrue(home.contains("android:key=\"$it\"")) }
        assertTrue("the Unsynced Notes row is in the hub and keeps no value", home.substringAfter(
            "android:key=\"unsynced_notes\"", "").substringBefore("/>").contains("android:persistent=\"false\""))
        val help = File(resourceRoot, "settings_help.xml").readText()
        assertTrue("Help offers Report a problem", help.contains("android:key=\"report_problem\""))
        assertTrue(File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
            .contains("startActivity(ReportProblemActivity.newIntent(requireContext()))"))
        val advanced = File(resourceRoot, "settings_advanced.xml").readText()
        listOf("override_proxy", "distrust_system_certs", "log_to_file", "log_verbose")
            .forEach { assertTrue(advanced.contains("android:key=\"$it\"")) }
        // The app ships English strings only: no language picker, and a locale saved by older builds is cleared.
        assertFalse(advanced.contains("select_language"))
        assertTrue(File(sourceRoot, "App.kt").readText().contains("preferences.forcedLanguage = DEFAULT_LANGUAGE"))
    }

    @Test
    fun everyAccountSensitiveEntryPointCarriesCategoryAndExactAccount() {
        val activity = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
        val legacy = File(sourceRoot, "ui/AccountSettingsActivity.kt").readText()
        val sync = File(sourceRoot, "syncadapter/SyncNotification.kt").readText()
        val logger = File(sourceRoot, "log/Logger.kt").readText()
        val drawer = File(sourceRoot, "ui/AccountActivity.kt").readText()

        assertTrue(activity.contains("EXTRA_CATEGORY"))
        assertTrue(activity.contains("intent.hasExtra(EXTRA_ACCOUNT)"))
        assertTrue(activity.contains("EXTRA_CREATION_ID"))
        assertTrue(activity.contains("ExactAccountRouting.validate(candidate, creationId"))
        assertFalse(activity.contains("requestedAccount?.takeIf"))
        assertTrue(legacy.contains("SettingsCategory.SYNC"))
        assertTrue(legacy.contains("source.getStringExtra(AppSettingsActivity.EXTRA_CREATION_ID)"))
        assertTrue(sync.contains("SettingsCategory.SYNC"))
        assertTrue(sync.contains("extras.getParcelable<Account>(Constants.KEY_ACCOUNT)"))
        assertTrue(sync.contains("fun setAccount(account: Account, capturedCreationId: String?)"))
        assertTrue(sync.contains("AppSettingsActivity.EXTRA_CREATION_ID"))
        assertTrue(logger.contains("SettingsCategory.ADVANCED"))
        assertTrue(drawer.contains("AppSettingsActivity.newIntent(this, account, accountCreationId)"))
    }

    @Test
    fun accountDashboardRowReturnsToTheDashboardThatOpenedSettings() {
        val drawer = File(sourceRoot, "ui/AccountActivity.kt").readText()
        listOf("AppSettingsActivity.newIntent(this, account, accountCreationId).fromDashboard()",
            "AppSettingsActivity.newIntent(this, account, accountCreationId, SettingsCategory.ACCOUNT).fromDashboard()",
            "AppSettingsActivity.newIntent(this, account, accountCreationId, SettingsCategory.SYNC).fromDashboard()")
            .forEach { assertTrue("the dashboard marks its Settings route: $it", drawer.contains(it)) }
        assertTrue(drawer.contains("putExtra(AppSettingsActivity.EXTRA_FROM_DASHBOARD, true)"))
        val row = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
            .substringAfter("\"manage_account\"").substringBefore("requirePreference")
        assertTrue("opened from the dashboard, the row finishes Settings", row.contains("if (host.openedFromDashboard) host.finish()"))
        assertTrue("other routes still open the exact account's dashboard",
            row.contains("else startActivity(AccountActivity.newIntent(requireContext(), exact, host.selectedCreationId!!))"))
    }

    @Test
    fun billingEntryPointsOpenTheWebSubscriptionPage() {
        val openBilling = "Intent(Intent.ACTION_VIEW, Uri.parse(BillingManager.BILLING_MANAGE_URL))"
        val accountXml = File(resourceRoot, "settings_account.xml").readText()
        assertTrue("Settings > Account has a Subscription row that keeps no value", accountXml.substringAfter(
            "android:key=\"manage_subscription\"", "").substringBefore("/>").contains("android:persistent=\"false\""))
        val settings = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
            .substringAfter("\"manage_subscription\"").substringBefore("requirePreference")
        assertTrue("the Subscription row opens the web subscription page", settings.contains(openBilling))
        assertTrue("the Subscription row is hidden for self-hosted servers", settings.contains("ProblemReport.isCustomServer("))
        // App settings has no billing controls, so the billing warning must not send people there.
        val card = File(sourceRoot, "ui/AccountActivity.kt").readText()
            .substringAfter("private fun updateSubscriptionUi(").substringBefore("companion object")
        assertTrue(card.contains("launchDashboardExternalApp($openBilling)"))
        assertFalse(card.contains("AppSettingsActivity"))
    }

    @Test
    fun accountPreferencesRemainNonPersistentAndBackedByAccountSettings() {
        val syncXml = File(resourceRoot, "settings_sync.xml").readText()
        listOf("sync_interval", "sync_wifi_only", "sync_wifi_only_ssid").forEach { key ->
            val keyAt = syncXml.indexOf("android:key=\"$key\"")
            assertTrue(keyAt >= 0)
            assertTrue(syncXml.substring(keyAt, minOf(syncXml.length, keyAt + 220)).contains("android:persistent=\"false\""))
        }
        val accountXml = File(resourceRoot, "settings_account.xml").readText()
        listOf("notes_automatic_network", "notes_sync_now_network").forEach { key ->
            val keyAt = accountXml.indexOf("android:key=\"$key\"")
            assertTrue(keyAt >= 0)
            val row = accountXml.substring(keyAt, minOf(accountXml.length, keyAt + 220))
            assertTrue(row.contains("android:persistent=\"false\""))
            assertTrue(row.contains("android:dependency=\"notes_enabled\""))
        }
        val activity = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
        assertTrue(activity.contains("AccountSettings(requireContext(), account)"))

        // The values the two rows offer are the names their listener accepts, and each has a label.
        val strings = File("src/main/res/values/strings.xml").readText()
        fun items(array: String): List<String> {
            val open = "<string-array name=\"$array\""
            assertEquals("$array is declared once", 1, strings.split(open).size - 1)
            return Regex("<item>([^<]*)</item>").findAll(strings.substringAfter(open).substringBefore("</string-array>"))
                .map { it.groupValues[1] }.toList()
        }
        assertEquals("the values offered are the names of NotesNetworkPolicy.Allowed, in its order",
            NotesNetworkPolicy.Allowed.values().map { it.name }, items("settings_notes_network_values"))
        assertEquals("one label for each value", NotesNetworkPolicy.Allowed.values().size, items("settings_notes_network_names").size)

        // The write of each row is revalidated against the exact account and goes to that account.
        val helperStart = "private fun notesNetworkPreference("
        assertEquals(1, activity.split(helperStart).size - 1)
        val helper = activity.substringAfter(helperStart).substringBefore(" fun ")
        assertEquals("a Notes network row takes the exact selected account or refuses the change", 1,
            helper.split("val exact = exactSelectedAccount() ?: return@setOnPreferenceChangeListener false").size - 1)
        assertEquals("a Notes network row writes through the exact account", 1,
            helper.split("write(AccountManager.get(requireContext().applicationContext), exact, chosen)").size - 1)
    }
}
