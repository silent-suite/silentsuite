package io.silentsuite.sync.ui

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class AccountDrawerContractTest {
    private val main = File("src/main")

    @Test fun `drawer contains only real destinations and one separated sign out`() {
        val drawer = File(main, "res/menu/activity_accounts_drawer.xml").readText()
        listOf("nav_calendar", "nav_contacts", "nav_tasks", "nav_add_account", "nav_theme",
            "nav_show_fingerprint", "nav_export_data", "nav_website", "nav_external", "nav_privacy")
            .forEach { assertFalse(it, drawer.contains(it)) }
        listOf("nav_sync_overview", "nav_invitations", "nav_app_settings", "nav_about", "nav_logout")
            .forEach { assertTrue(it, drawer.contains(it)) }
        assertEquals(1, Regex("nav_logout").findAll(drawer).count())
        assertTrue(drawer.contains("nav_sign_out_group"))
    }

    @Test fun `switcher and dashboard actions retain stable resource contracts`() {
        val header = File(main, "res/layout/nav_header_accounts.xml").readText()
        val row = File(main, "res/layout/nav_account_row.xml").readText()
        val toolbar = File(main, "res/menu/activity_account.xml").readText()
        assertEquals(1, Regex("nav_add_account_row").findAll(header).count())
        listOf("nav_account_row", "nav_account_name", "nav_account_current_indicator", "@dimen/touch_target_min")
            .forEach { assertTrue(it, row.contains(it)) }
        assertTrue(toolbar.contains("account_show_fingerprint")); assertTrue(toolbar.contains("account_export_data"))
        val activity = File(main, "java/io/silentsuite/sync/ui/AccountActivity.kt").readText()
        val signOut = File(main, "java/io/silentsuite/sync/ui/AndroidCurrentAccountSignOut.kt").readText()
        listOf("R.id.caldav", "R.id.carddav", "R.id.taskdav").forEach { assertTrue(it, activity.contains(it)) }
        assertTrue(activity.contains("AppSettingsActivity.newIntent(this, account, accountCreationId)"))
        assertTrue(activity.contains("row.id = rowId"))
        assertTrue(activity.contains("accountRowViewId(identity)"))
        assertTrue(activity.indexOf("attachRetainedSignOut()") < activity.indexOf("ExactAccountRouting.validate"))
        assertTrue(signOut.contains("KEY_CREATION_ID) != main.creationId"))
        assertTrue(signOut.contains("mainGenerationAbsent"))
        assertFalse(activity.contains("etebase.logout()"))
    }
}
