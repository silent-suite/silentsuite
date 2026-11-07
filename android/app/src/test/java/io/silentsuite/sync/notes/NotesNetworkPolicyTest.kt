package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.NotesNetworkPolicy.AccountRule
import io.silentsuite.sync.notes.NotesNetworkPolicy.Allowed
import io.silentsuite.sync.notes.NotesNetworkPolicy.Blocker
import io.silentsuite.sync.notes.NotesNetworkPolicy.Connection
import io.silentsuite.sync.notes.NotesNetworkPolicy.Reading
import io.silentsuite.sync.notes.NotesNetworkPolicy.Settings
import io.silentsuite.sync.notes.NotesNetworkPolicy.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Which network a Notes run may use (design 3.6): every row of the rule, for both kinds of run. */
class NotesNetworkPolicyTest {
    private val off = AccountRule(wifiOnly = false, networkName = null)
    private val offHome = AccountRule(wifiOnly = false, networkName = "home")
    private val on = AccountRule(wifiOnly = true, networkName = null)
    private val onHome = AccountRule(wifiOnly = true, networkName = "home")
    private val accounts = listOf(off, offHome, on, onHome)

    private val none = Reading(Connection.NONE)
    private val other = Reading(Connection.OTHER)
    private val wifi = Reading(Connection.WIFI)
    private val wifiHome = Reading(Connection.WIFI, "\"home\"")
    private val wifiCafe = Reading(Connection.WIFI, "\"cafe\"")

    /** The platform's unknown-name value (WifiManager.UNKNOWN_SSID): what it reports when it does not give the name. */
    private val wifiUnknown = Reading(Connection.WIFI, "<unknown ssid>")
    private val readings = listOf(none, other, wifi, wifiHome, wifiCafe, wifiUnknown)

    private class Row(val id: String, val allowed: Allowed, val account: AccountRule, val reading: Reading, vararg blockers: Blocker) {
        val blockers = blockers.toSet()
    }

    @Test fun `the defaults are Wi-Fi only for automatic runs and any network for runs the user starts`() {
        assertEquals(Allowed.WIFI_ONLY, Settings.DEFAULT.automatic)
        assertEquals(Allowed.ANY_NETWORK, Settings.DEFAULT.syncNow)
        assertEquals("nothing stored is the defaults", Settings.DEFAULT, Settings.fromStored(null, null))
    }

    @Test fun `a stored value reads back, and anything else is the default of that setting`() {
        for (default in Allowed.values()) {
            for (value in Allowed.values()) assertEquals(value, Allowed.parse(value.name, default))
            for (stored in listOf(null, "", "wifi_only", "any_network", "SOMETHING")) {
                assertEquals("stored: $stored", default, Allowed.parse(stored, default))
            }
        }
        assertEquals(Settings(Allowed.ANY_NETWORK, Allowed.WIFI_ONLY), Settings.fromStored("ANY_NETWORK", "WIFI_ONLY"))
        assertEquals("each setting falls back to its own default", Settings.DEFAULT, Settings.fromStored("SOMETHING", ""))
        assertEquals("a value in lower case is not a stored value", Settings.DEFAULT, Settings.fromStored("any_network", "wifi_only"))
    }

    @Test fun `a connected Wi-Fi network is Wi-Fi, any other connected network is other, and none or unconnected is none`() {
        assertEquals(Connection.WIFI, NotesNetworkPolicy.connectionOf(present = true, connected = true, wifi = true))
        assertEquals(Connection.OTHER, NotesNetworkPolicy.connectionOf(present = true, connected = true, wifi = false))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = true, connected = false, wifi = true))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = true, connected = false, wifi = false))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = false, connected = true, wifi = true))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = false, connected = true, wifi = false))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = false, connected = false, wifi = true))
        assertEquals(Connection.NONE, NotesNetworkPolicy.connectionOf(present = false, connected = false, wifi = false))
    }

    @Test fun `every row for a run the user starts`() {
        // The setting of each row is the Sync now one. The account's rule of a row is replaced below.
        val rows = listOf(
            Row("E1", Allowed.ANY_NETWORK, off, wifi),
            Row("E2", Allowed.ANY_NETWORK, off, other),
            // Not refused, so the run is attempted. If there really is no connection it fails by itself,
            // and that is a failure of the run (answer 5, last sentence).
            Row("E3", Allowed.ANY_NETWORK, off, none),
            Row("E4", Allowed.WIFI_ONLY, off, wifi),
            Row("E5", Allowed.WIFI_ONLY, off, other, Blocker.NOTES_SETTING),
            Row("E6", Allowed.WIFI_ONLY, off, none, Blocker.NOTES_SETTING),
        )
        for (row in rows) for (automatic in Allowed.values()) for (account in listOf(off, on, onHome)) {
            val what = "${row.id}, automatic $automatic, $account"
            val verdict = NotesNetworkPolicy.decide(explicit = true, Settings(automatic, row.allowed), account, row.reading)
            assertEquals(what, Verdict(row.blockers, row.reading.connection), verdict)
            assertEquals(what, row.blockers.isEmpty(), verdict.run)
        }
        // E7: on Wi-Fi while the account's switch is on with a name that does not match.
        for (syncNow in Allowed.values()) for (automatic in Allowed.values()) {
            assertEquals("E7, Sync now $syncNow, automatic $automatic", Verdict(emptySet(), Connection.WIFI),
                NotesNetworkPolicy.decide(explicit = true, Settings(automatic, syncNow), onHome, wifiCafe))
        }
    }

    @Test fun `every row for an automatic run`() {
        // The setting of each row is the automatic one.
        val rows = listOf(
            Row("A1", Allowed.WIFI_ONLY, off, wifi),
            Row("A2", Allowed.WIFI_ONLY, off, other, Blocker.NOTES_SETTING),
            Row("A3", Allowed.WIFI_ONLY, off, none, Blocker.NOTES_SETTING),
            Row("A4", Allowed.WIFI_ONLY, on, wifi),
            Row("A5", Allowed.WIFI_ONLY, on, other, Blocker.NOTES_SETTING, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A5, a name set", Allowed.WIFI_ONLY, onHome, other, Blocker.NOTES_SETTING, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A6", Allowed.WIFI_ONLY, on, none, Blocker.NOTES_SETTING, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A6, a name set", Allowed.WIFI_ONLY, onHome, none, Blocker.NOTES_SETTING, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A7", Allowed.WIFI_ONLY, onHome, wifiHome),
            Row("A8, another name", Allowed.WIFI_ONLY, onHome, wifiCafe, Blocker.ACCOUNT_NETWORK_NAME),
            // No Wi-Fi info object. The adapters' log line throws here; refused here on purpose.
            Row("A8, no name", Allowed.WIFI_ONLY, onHome, wifi, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A8, the unknown name", Allowed.WIFI_ONLY, onHome, wifiUnknown, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A9", Allowed.ANY_NETWORK, off, wifi),
            Row("A10", Allowed.ANY_NETWORK, off, other),
            // As E3: not refused, so the run is attempted. If there really is no connection it fails by
            // itself, and that is a failure of the run (answer 5, last sentence).
            Row("A11", Allowed.ANY_NETWORK, off, none),
            Row("A12", Allowed.ANY_NETWORK, on, wifi),
            Row("A13", Allowed.ANY_NETWORK, on, other, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A13, a name set", Allowed.ANY_NETWORK, onHome, other, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A14", Allowed.ANY_NETWORK, on, none, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A14, a name set", Allowed.ANY_NETWORK, onHome, none, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A15", Allowed.ANY_NETWORK, onHome, wifiHome),
            Row("A16, another name", Allowed.ANY_NETWORK, onHome, wifiCafe, Blocker.ACCOUNT_NETWORK_NAME),
            // No Wi-Fi info object. The adapters' log line throws here; refused here on purpose.
            Row("A16, no name", Allowed.ANY_NETWORK, onHome, wifi, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A16, the unknown name", Allowed.ANY_NETWORK, onHome, wifiUnknown, Blocker.ACCOUNT_NETWORK_NAME),
            // A17: a name left over from when the switch was on is ignored.
            Row("A17, Wi-Fi", Allowed.WIFI_ONLY, offHome, wifiCafe),
            Row("A17, other", Allowed.WIFI_ONLY, offHome, other, Blocker.NOTES_SETTING),
            Row("A17, none", Allowed.WIFI_ONLY, offHome, none, Blocker.NOTES_SETTING),
            Row("A17, any network, Wi-Fi", Allowed.ANY_NETWORK, offHome, wifiCafe),
            Row("A17, any network, other", Allowed.ANY_NETWORK, offHome, other),
            Row("A17, any network, none", Allowed.ANY_NETWORK, offHome, none),
        )
        for (row in rows) for (syncNow in Allowed.values()) {
            val what = "${row.id}, Sync now $syncNow"
            val verdict = NotesNetworkPolicy.decide(explicit = false, Settings(row.allowed, syncNow), row.account, row.reading)
            assertEquals(what, Verdict(row.blockers, row.reading.connection), verdict)
            assertEquals(what, row.blockers.isEmpty(), verdict.run)
        }
    }

    @Test fun `a run the user starts never looks at the automatic setting, the account switch or its network name`() {
        for (syncNow in Allowed.values()) for (reading in readings) {
            val alone = NotesNetworkPolicy.decide(explicit = true, Settings(Allowed.WIFI_ONLY, syncNow), off, reading)
            assertTrue("only the Notes setting can refuse it: $alone", (alone.blockers - Blocker.NOTES_SETTING).isEmpty())
            for (automatic in Allowed.values()) for (account in accounts) {
                assertEquals("Sync now $syncNow, $reading, automatic $automatic, $account", alone,
                    NotesNetworkPolicy.decide(explicit = true, Settings(automatic, syncNow), account, reading))
            }
        }
    }

    @Test fun `an automatic run never looks at the Sync now setting`() {
        for (automatic in Allowed.values()) for (account in accounts) for (reading in readings) {
            assertEquals("automatic $automatic, $account, $reading",
                NotesNetworkPolicy.decide(explicit = false, Settings(automatic, Allowed.ANY_NETWORK), account, reading),
                NotesNetworkPolicy.decide(explicit = false, Settings(automatic, Allowed.WIFI_ONLY), account, reading))
        }
    }

    @Test fun `with both settings on any network the rule is the read-only slice's`() {
        // That rule: a run the user started always starts, and any other run asks the account's own rule.
        val anyNetwork = Settings(Allowed.ANY_NETWORK, Allowed.ANY_NETWORK)
        var refused = 0
        for (account in accounts) for (reading in readings) {
            val what = "$account, $reading"
            assertTrue(what, NotesNetworkPolicy.decide(explicit = true, anyNetwork, account, reading).run)
            val blocker = NotesNetworkPolicy.accountBlocker(account, reading)
            val automatic = NotesNetworkPolicy.decide(explicit = false, anyNetwork, account, reading)
            assertEquals(what, blocker == null, automatic.run)
            assertEquals(what, setOfNotNull(blocker), automatic.blockers)
            if (blocker != null) refused++
        }
        // Switch on: two readings that are not Wi-Fi, for both rules; with a name, three more that do not match.
        assertEquals("the account's own rule refuses some of these, so the comparison is not empty", 7, refused)
    }

    @Test fun `the account's network name is compared in quotes as the platform reports it, and a name that cannot be read never matches`() {
        assertNull(NotesNetworkPolicy.accountBlocker(onHome, wifiHome))
        // The bare name, another network, no name at all, and the platform's unknown-name value.
        // No name at all is no Wi-Fi info object. The adapters' log line throws here; refused here on purpose.
        for (reading in listOf(Reading(Connection.WIFI, "home"), wifiCafe, wifi, wifiUnknown)) {
            assertEquals("$reading", Blocker.ACCOUNT_NETWORK_NAME, NotesNetworkPolicy.accountBlocker(onHome, reading))
        }
        // The comparison is exact about letter case.
        assertEquals(Blocker.ACCOUNT_NETWORK_NAME,
            NotesNetworkPolicy.accountBlocker(onHome, Reading(Connection.WIFI, "\"Home\"")))
        // The stored name is put in quotes before it is compared, so not even a stored name that
        // spells the unknown-name value matches it.
        assertEquals(Blocker.ACCOUNT_NETWORK_NAME,
            NotesNetworkPolicy.accountBlocker(AccountRule(wifiOnly = true, networkName = "<unknown ssid>"), wifiUnknown))
    }

    @Test fun `a stored network name means nothing while the account switch is off`() {
        for (reading in readings) {
            assertNull("$reading", NotesNetworkPolicy.accountBlocker(offHome, reading))
            for (explicit in listOf(true, false)) for (automatic in Allowed.values()) for (syncNow in Allowed.values()) {
                val settings = Settings(automatic, syncNow)
                assertEquals("explicit $explicit, $settings, $reading",
                    NotesNetworkPolicy.decide(explicit, settings, off, reading),
                    NotesNetworkPolicy.decide(explicit, settings, offHome, reading))
            }
        }
    }

    @Test fun `the adapters' own rule still has the text the account rule here repeats`() {
        // accountBlocker and connectionOf repeat syncConditionsAllow instead of calling it, so that the
        // rule can be decided for any reading. The body of the original, between its signature and its
        // closing brace, is compared here with the list below: each line trimmed, in order, none more
        // and none less. Left free: its log lines (Logger.log.), comment lines and blank lines. The
        // signature has to occur exactly once in the file.
        val message = "the account rule changed, so NotesNetworkPolicy.accountBlocker and connectionOf must follow"
        val source = File("src/main/java/io/silentsuite/sync/syncadapter/SyncAdapterService.kt").readText()
        val start = "internal fun syncConditionsAllow(context: Context, settings: AccountSettings): Boolean {"
        assertEquals(message, 1, source.split(start).size - 1)
        val expected = listOf(
            "if (settings.syncWifiOnly) {",
            "val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager",
            "val network = cm.activeNetworkInfo",
            "if (network == null) {",
            "return false",
            "}",
            "if (network.type != ConnectivityManager.TYPE_WIFI || !network.isConnected) {",
            "return false",
            "}",
            "var onlySSID = settings.syncWifiOnlySSID",
            "if (onlySSID != null) {",
            """onlySSID = "\"" + onlySSID + "\""""",
            "val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager",
            "val info = wifi.connectionInfo",
            "if (info == null || onlySSID != info.ssid) {",
            "return false",
            "}",
            "}",
            "}",
            "return true",
        )
        val lines = source.substringAfter(start).substringBefore("\n}").lines().map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("Logger.log.") && !it.startsWith("//") }
        val at = (0 until maxOf(expected.size, lines.size)).firstOrNull { expected.getOrNull(it) != lines.getOrNull(it) } ?: -1
        assertEquals("$message; first difference at compared line ${at + 1}: " +
            "the test has <${expected.getOrNull(at)}>, the source has <${lines.getOrNull(at)}>", expected, lines)
    }
}
