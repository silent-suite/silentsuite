package io.silentsuite.sync.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The text of the reading and of what is asked of it (design 3.6). The platform calls run only on a
 * device: the boundary runtime test runs them with no pin, on whatever network the device has, so
 * this test keeps their text.
 */
class NotesNetworkTest {
    @Test fun `the reading keeps the account switch's calls, and the Wi-Fi name is asked for only where it can decide and inside a try that catches`() {
        val source = File("src/main/java/io/silentsuite/sync/notes/NotesNetwork.kt").readText()
        for (text in listOf(
            "readingOverride?.let { return it(withWifiName) }",
            "as? ConnectivityManager)?.activeNetworkInfo",
            "NotesNetworkPolicy.connectionOf(present = info != null, connected = info?.isConnected == true,",
            "wifi = info?.type == ConnectivityManager.TYPE_WIFI)",
            "if (withWifiName && connection == NotesNetworkPolicy.Connection.WIFI) {",
            "(context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)?.connectionInfo?.ssid",
            "} catch (e: RuntimeException) {",
            "return NotesNetworkPolicy.Reading(connection, name)",
            "NotesNetworkPolicy.AccountRule(accountSettings.syncWifiOnly, accountSettings.syncWifiOnlySSID)",
            "read(context, withWifiName = !explicit && rule.wifiOnly && rule.networkName != null)",
            "return NotesNetworkPolicy.decide(explicit, AccountSettings.notesNetworkSettings(manager, account), rule, reading)",
        )) {
            assertEquals("exactly once in NotesNetwork.kt: $text", 1, source.split(text).size - 1)
        }
        val tryAt = source.indexOf("try {")
        val readAt = source.indexOf("?.connectionInfo?.ssid")
        val catchAt = source.indexOf("} catch (e: RuntimeException) {")
        assertTrue("the name read sits between the try and its catch", tryAt in 0 until readAt && readAt < catchAt)
        assertFalse("nothing in this file writes a log line, so no name can reach one", source.contains("Logger.") || source.contains("Log."))
    }
}
