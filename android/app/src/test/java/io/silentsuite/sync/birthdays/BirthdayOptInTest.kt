package io.silentsuite.sync.birthdays

import android.accounts.Account
import android.content.ContextWrapper
import io.silentsuite.sync.log.Logger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.logging.Handler
import java.util.logging.LogRecord

/**
 * The experimental per-account Birthdays opt-in. It is off unless the account row holds exactly "true", and
 * a failed read is off too. While off, a maintenance trigger ([BirthdayMaintenance.run]) and an explicit
 * turn ([BirthdayMaintenance.turn]) stop at their entry: no slot, no ownership check, no engine run.
 *
 * On the JVM the platform stubs answer every call with a default, so the account manager here is null and
 * reading the opt-in fails; both entry points must treat that as off.
 */
class BirthdayOptInTest {
    private val main = File("src/main")
    private val context = ContextWrapper(null)
    private val account = Account("birthdays-opt-in@example.invalid", "io.silentsuite.sync")

    private fun logged(block: () -> Unit): List<String> {
        val lines = mutableListOf<String>()
        val handler = object : Handler() {
            override fun publish(record: LogRecord) { lines += record.message }
            override fun flush() = Unit
            override fun close() = Unit
        }
        Logger.log.addHandler(handler)
        try {
            block()
        } finally {
            Logger.log.removeHandler(handler)
        }
        return lines
    }

    @Test fun aMaintenanceTriggerStopsAtItsEntryWhileTheOptInCannotBeReadAsOn() {
        val lines = logged { BirthdayMaintenance.run(context, account, null, "address-book sync") }
        assertEquals("only the opt-in skip is logged; no pass started", listOf("Birthdays after the address-book sync skipped (off)"), lines)
    }

    @Test fun anExplicitTurnStopsAtItsEntryWhileTheOptInCannotBeReadAsOn() {
        for (on in listOf(true, false)) {
            var asked = 0
            var result: BirthdayReconciler.RunResult? = null
            val lines = logged { result = BirthdayMaintenance.turn(context, account, "generation-1", on) { asked++; true } }
            val action = if (on) "turn-on" else "turn-off"
            assertNull("$action does not run", result)
            assertEquals("$action never asks the caller's ownership check", 0, asked)
            assertEquals("only the opt-in skip is logged for $action", listOf("Birthdays $action skipped (off)"), lines)
        }
    }

    @Test fun theOptInIsOffUnlessStoredAsTrueAndOnlyTheSettingsSwitchWritesIt() {
        val settings = File(main, "java/io/silentsuite/sync/AccountSettings.kt").readText()
        assertTrue("absent or any other value reads as off", settings.contains(
            "accountManager.getUserData(account, KEY_BIRTHDAYS_ENABLED) == \"true\""))
        val maintenance = File(main, "java/io/silentsuite/sync/birthdays/BirthdayMaintenance.kt").readText()
        assertTrue(maintenance.contains("AccountSettings.birthdaysEnabled(AccountManager.get(context), main)"))
        // Nothing turns it on by itself: the only writer outside AccountSettings is the account settings switch.
        val writers = File(main, "java").walkTopDown().filter { it.isFile && it.name.endsWith(".kt") && it.name != "AccountSettings.kt" }
            .filter { it.readText().let { text -> text.contains("writeBirthdaysEnabled") || text.contains("KEY_BIRTHDAYS_ENABLED") } }
            .map { it.name }.toList()
        assertEquals(listOf("AppSettingsActivity.kt"), writers)
        val xml = File(main, "res/xml/settings_account.xml").readText()
        val experimental = xml.substringAfter("@string/settings_experimental_title").substringBefore("</PreferenceCategory>")
        assertTrue("the switch is in the Experimental category and stores nothing itself",
            experimental.contains("android:key=\"birthdays_enabled\"") &&
                experimental.substringAfter("android:key=\"birthdays_enabled\"").substringBefore("/>").contains("android:persistent=\"false\""))
        val activity = File(main, "java/io/silentsuite/sync/ui/AccountActivity.kt").readText()
        assertTrue("the Calendars menu offers the actions only while on", activity.contains(
            "val visible = AccountSettings.birthdaysEnabled(AccountManager.get(this), account)"))
        assertFalse("the opt-in never removes or retires a calendar by itself",
            File(main, "java/io/silentsuite/sync/ui/AppSettingsActivity.kt").readText()
                .substringAfter("\"birthdays_enabled\"").substringBefore("private fun setupSync").contains("BirthdayMaintenance"))
    }
}
