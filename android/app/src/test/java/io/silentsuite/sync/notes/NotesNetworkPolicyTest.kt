package io.silentsuite.sync.notes

import io.silentsuite.sync.notes.NotesNetworkPolicy.AccountRule
import io.silentsuite.sync.notes.NotesNetworkPolicy.Allowed
import io.silentsuite.sync.notes.NotesNetworkPolicy.Blocker
import io.silentsuite.sync.notes.NotesNetworkPolicy.Connection
import io.silentsuite.sync.notes.NotesNetworkPolicy.NoticePart
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
    private val readings = listOf(none, other, wifi)

    private class Row(val id: String, val allowed: Allowed, val account: AccountRule, val reading: Reading, vararg blockers: Blocker) {
        val blockers = blockers.toSet()
    }

    /** One row of the notice table: the sentences after the opening one, for every combination the row covers. */
    private class NoticeRow(val id: String, val automatic: List<Allowed>, val syncNow: List<Allowed>,
                            val cells: List<Pair<AccountRule, Reading>>, vararg rest: NoticePart) {
        val rest = rest.toList()
    }

    private fun cells(accounts: List<AccountRule>, readings: List<Reading>) = accounts.flatMap { account -> readings.map { account to it } }

    private val either = Allowed.values().toList()
    private val wifiOnly = listOf(Allowed.WIFI_ONLY)
    private val anyNetwork = listOf(Allowed.ANY_NETWORK)
    private val notWifi = listOf(other, none)
    private val switchOff = listOf(off, offHome)
    private val switchOn = listOf(on)

    private val noticeRows = listOf(
        // 1. On Wi-Fi with nothing against it: the switch off, or on without a network name.
        NoticeRow("1", either, either, cells(listOf(off, offHome, on), listOf(wifi))),
        // 2. The switch on with a network name saved: the name is the only reason, on every network
        // (#971). The last sentence is what a run the user starts would get there.
        NoticeRow("2", either, either, cells(listOf(onHome), listOf(wifi)),
            NoticePart.ACCOUNT_NETWORK_NAME, NoticePart.TRY_NOW),
        NoticeRow("2, off Wi-Fi", either, anyNetwork, cells(listOf(onHome), notWifi),
            NoticePart.ACCOUNT_NETWORK_NAME, NoticePart.TRY_NOW),
        NoticeRow("2, off Wi-Fi, Sync now on Wi-Fi only", either, wifiOnly, cells(listOf(onHome), notWifi),
            NoticePart.ACCOUNT_NETWORK_NAME, NoticePart.SYNC_NOW_NEEDS_WIFI),
        // 3 is the defaults off Wi-Fi.
        NoticeRow("3", wifiOnly, anyNetwork, cells(switchOff, notWifi),
            NoticePart.NOTES_SETTING, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW),
        NoticeRow("4", wifiOnly, wifiOnly, cells(switchOff, notWifi),
            NoticePart.NOTES_SETTING, NoticePart.NO_WIFI_REPORTED, NoticePart.SYNC_NOW_NEEDS_WIFI),
        NoticeRow("5", wifiOnly, anyNetwork, cells(switchOn, notWifi),
            NoticePart.NOTES_SETTING, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW),
        NoticeRow("6", wifiOnly, wifiOnly, cells(switchOn, notWifi),
            NoticePart.NOTES_SETTING, NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.SYNC_NOW_NEEDS_WIFI),
        NoticeRow("7", anyNetwork, anyNetwork, cells(switchOn, notWifi),
            NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW),
        NoticeRow("8", anyNetwork, wifiOnly, cells(switchOn, notWifi),
            NoticePart.ACCOUNT_WIFI_ONLY, NoticePart.NO_WIFI_REPORTED, NoticePart.SYNC_NOW_NEEDS_WIFI),
        // 9 and 10: an automatic run would start, so nothing is said, also where a run the user starts would be refused (10).
        NoticeRow("9", anyNetwork, anyNetwork, cells(switchOff, notWifi)),
        NoticeRow("10", anyNetwork, wifiOnly, cells(switchOff, notWifi)),
    )

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
        // E7: on Wi-Fi while the account's switch is on with a network name saved.
        for (syncNow in Allowed.values()) for (automatic in Allowed.values()) {
            assertEquals("E7, Sync now $syncNow, automatic $automatic", Verdict(emptySet(), Connection.WIFI),
                NotesNetworkPolicy.decide(explicit = true, Settings(automatic, syncNow), onHome, wifi))
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
            // A name saved refuses on every network (#971), so it is the account's reason off Wi-Fi too.
            Row("A5, a name saved", Allowed.WIFI_ONLY, onHome, other, Blocker.NOTES_SETTING, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A6", Allowed.WIFI_ONLY, on, none, Blocker.NOTES_SETTING, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A6, a name saved", Allowed.WIFI_ONLY, onHome, none, Blocker.NOTES_SETTING, Blocker.ACCOUNT_NETWORK_NAME),
            // A7 and A8 were the named network and any other: no Wi-Fi name is read, so both are a refusal.
            Row("A7, A8", Allowed.WIFI_ONLY, onHome, wifi, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A9", Allowed.ANY_NETWORK, off, wifi),
            Row("A10", Allowed.ANY_NETWORK, off, other),
            // As E3: not refused, so the run is attempted. If there really is no connection it fails by
            // itself, and that is a failure of the run (answer 5, last sentence).
            Row("A11", Allowed.ANY_NETWORK, off, none),
            Row("A12", Allowed.ANY_NETWORK, on, wifi),
            Row("A13", Allowed.ANY_NETWORK, on, other, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A13, a name saved", Allowed.ANY_NETWORK, onHome, other, Blocker.ACCOUNT_NETWORK_NAME),
            Row("A14", Allowed.ANY_NETWORK, on, none, Blocker.ACCOUNT_WIFI_ONLY),
            Row("A14, a name saved", Allowed.ANY_NETWORK, onHome, none, Blocker.ACCOUNT_NETWORK_NAME),
            // A15 and A16, as A7 and A8.
            Row("A15, A16", Allowed.ANY_NETWORK, onHome, wifi, Blocker.ACCOUNT_NETWORK_NAME),
            // A17: a name left over from when the switch was on is ignored.
            Row("A17, Wi-Fi", Allowed.WIFI_ONLY, offHome, wifi),
            Row("A17, other", Allowed.WIFI_ONLY, offHome, other, Blocker.NOTES_SETTING),
            Row("A17, none", Allowed.WIFI_ONLY, offHome, none, Blocker.NOTES_SETTING),
            Row("A17, any network, Wi-Fi", Allowed.ANY_NETWORK, offHome, wifi),
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
        // Switch on: two readings that are not Wi-Fi without a name; with a name saved, all three.
        assertEquals("the account's own rule refuses some of these, so the comparison is not empty", 5, refused)
    }

    @Test fun `with the switch on, any saved network name refuses on every network, and no saved name is the switch alone`() {
        // Any value counts as saved, also an empty one or one that spells the platform's unknown-name value (#971).
        for (name in listOf("home", "", "<unknown ssid>")) for (reading in readings) {
            assertEquals("<$name>, $reading", Blocker.ACCOUNT_NETWORK_NAME,
                NotesNetworkPolicy.accountBlocker(AccountRule(wifiOnly = true, networkName = name), reading))
        }
        assertNull(NotesNetworkPolicy.accountBlocker(on, wifi))
        assertEquals(Blocker.ACCOUNT_WIFI_ONLY, NotesNetworkPolicy.accountBlocker(on, other))
        assertEquals(Blocker.ACCOUNT_WIFI_ONLY, NotesNetworkPolicy.accountBlocker(on, none))
    }

    @Test fun `an automatic run with the switch on and a saved name is refused before any reading, and no other run is`() {
        for (explicit in listOf(false, true)) for (wifiOnly in listOf(false, true)) for (name in listOf(null, "", "home")) {
            val account = AccountRule(wifiOnly, name)
            val what = "explicit $explicit, switch $wifiOnly, name <$name>"
            val unread = NotesNetworkPolicy.refusedUnread(explicit, account)
            if (!explicit && wifiOnly && name != null) {
                assertEquals(what, Verdict(setOf(Blocker.ACCOUNT_NETWORK_NAME), null), unread)
                // The same answer as with a reading, whatever the reading and the settings.
                for (reading in readings) for (automatic in Allowed.values()) for (syncNow in Allowed.values()) {
                    val read = NotesNetworkPolicy.decide(explicit, Settings(automatic, syncNow), account, reading)
                    assertTrue("$what, $reading: refused with a reading too", !read.run && Blocker.ACCOUNT_NETWORK_NAME in read.blockers)
                }
            } else {
                assertNull(what, unread)
            }
        }
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

    @Test fun `the account switch's connection check still has the text connectionOf repeats`() {
        // connectionOf repeats the connection check of the account switch (syncadapter/SyncAdapterService.kt)
        // instead of calling it, so that the rule can be decided for any reading: its two refusals, each
        // exactly once and in this order. The saved network name is not compared: a saved name refuses
        // here without any reading (#971).
        val message = "the account switch's connection check changed, so NotesNetworkPolicy.connectionOf must follow"
        val source = File("src/main/java/io/silentsuite/sync/syncadapter/SyncAdapterService.kt").readText()
        val checks = listOf(
            "if (network == null) {",
            "if (network.type != ConnectivityManager.TYPE_WIFI || !network.isConnected) {",
        )
        for (text in checks) assertEquals("$message: $text", 1, source.split(text).size - 1)
        assertTrue(message, source.indexOf(checks[0]) < source.indexOf(checks[1]))
    }

    @Test fun `every row of the notebook list's network line`() {
        val seen = HashSet<String>()
        for (row in noticeRows) for (automatic in row.automatic) for (syncNow in row.syncNow) for ((account, reading) in row.cells) {
            val what = "row ${row.id}, automatic $automatic, Sync now $syncNow, $account, $reading"
            assertTrue("no combination is in two rows: $what", seen.add("$automatic $syncNow $account $reading"))
            val expected = if (row.rest.isEmpty()) emptyList() else listOf(NoticePart.MAY_BE_OUT_OF_DATE) + row.rest
            assertEquals(what, expected, NotesNetworkPolicy.notice(Settings(automatic, syncNow), account, reading))
        }
        assertEquals("the rows cover every combination of the two settings, the account's rule and the reading",
            Allowed.values().size * Allowed.values().size * accounts.size * readings.size, seen.size)
    }

    @Test fun `the line shows exactly when an automatic run would be refused, and it ends with what a run the user starts would get`() {
        for (automatic in Allowed.values()) for (syncNow in Allowed.values()) for (account in accounts) for (reading in readings) {
            val settings = Settings(automatic, syncNow)
            val what = "$settings, $account, $reading"
            val parts = NotesNetworkPolicy.notice(settings, account, reading)
            val byItself = NotesNetworkPolicy.decide(explicit = false, settings, account, reading)
            val byTheUser = NotesNetworkPolicy.decide(explicit = true, settings, account, reading)
            assertEquals(what, byItself.run, parts.isEmpty())
            if (parts.isEmpty()) continue
            assertEquals(what, NoticePart.MAY_BE_OUT_OF_DATE, parts.first())
            assertEquals(what, if (byTheUser.run) NoticePart.TRY_NOW else NoticePart.SYNC_NOW_NEEDS_WIFI, parts.last())
            if (Blocker.ACCOUNT_NETWORK_NAME in byItself.blockers) {
                assertEquals("a saved network name is the only reason given, since it refuses on every network: $what",
                    listOf(NoticePart.MAY_BE_OUT_OF_DATE, NoticePart.ACCOUNT_NETWORK_NAME, parts.last()), parts)
                continue
            }
            assertEquals(what, Blocker.NOTES_SETTING in byItself.blockers, NoticePart.NOTES_SETTING in parts)
            assertEquals(what, Blocker.ACCOUNT_WIFI_ONLY in byItself.blockers, NoticePart.ACCOUNT_WIFI_ONLY in parts)
            assertTrue(what, NoticePart.ACCOUNT_NETWORK_NAME !in parts)
            assertEquals("Wi-Fi is said to be missing only when the reading is not Wi-Fi: $what",
                reading.connection != Connection.WIFI, NoticePart.NO_WIFI_REPORTED in parts)
            assertEquals("no sentence twice: $what", parts.size, parts.toSet().size)
        }
    }

    @Test fun `no active network gets the words of any network that is not Wi-Fi, and pulling down now is still offered unless Sync now is Wi-Fi only`() {
        for (automatic in Allowed.values()) for (syncNow in Allowed.values()) for (account in accounts) {
            val settings = Settings(automatic, syncNow)
            assertEquals("$settings, $account",
                NotesNetworkPolicy.notice(settings, account, other), NotesNetworkPolicy.notice(settings, account, none))
        }
        // With the defaults: the reason is what the platform reports, and the run the user can start is on offer.
        assertEquals(listOf(NoticePart.MAY_BE_OUT_OF_DATE, NoticePart.NOTES_SETTING, NoticePart.NO_WIFI_REPORTED, NoticePart.TRY_NOW),
            NotesNetworkPolicy.notice(Settings.DEFAULT, off, none))
        for (account in accounts) for (automatic in Allowed.values()) {
            val parts = NotesNetworkPolicy.notice(Settings(automatic, Allowed.ANY_NETWORK), account, none)
            assertTrue("$account, automatic $automatic: $parts", parts.isEmpty() || parts.last() == NoticePart.TRY_NOW)
        }
    }
}
