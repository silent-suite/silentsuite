package io.silentsuite.sync.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.io.File

/**
 * The text of the reading and of what is asked of it (design 3.6). The platform call runs only on a
 * device: the boundary runtime test runs it with no pin, on whatever network the device has, so
 * this test keeps its text.
 */
class NotesNetworkTest {
    @Test fun `the reading keeps the account switch's calls and never reads the Wi-Fi name`() {
        val source = File("src/main/java/io/silentsuite/sync/notes/NotesNetwork.kt").readText()
        for (text in listOf(
            "readingOverride?.let { return it() }",
            "as? ConnectivityManager)?.activeNetworkInfo",
            "NotesNetworkPolicy.Reading(NotesNetworkPolicy.connectionOf(present = info != null,",
            "connected = info?.isConnected == true, wifi = info?.type == ConnectivityManager.TYPE_WIFI))",
            "NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)",
            "return NotesNetworkPolicy.decide(explicit, AccountSettings.notesNetworkSettings(manager, account), rule, read(context))",
        )) {
            assertEquals("exactly once in NotesNetwork.kt: $text", 1, source.split(text).size - 1)
        }
        // #971: Android gives this app no Wi-Fi names, and a saved network name refuses without one.
        for (text in listOf("WifiManager", "WIFI_SERVICE", "connectionInfo", ".ssid")) {
            assertFalse("NotesNetwork.kt does not read the Wi-Fi name: $text", source.contains(text))
        }
        assertFalse("nothing in this file writes a log line", source.contains("Logger.") || source.contains("Log."))
    }
}
