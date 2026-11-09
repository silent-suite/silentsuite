package io.silentsuite.sync.syncadapter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** A saved WiFi network name can never be matched without location access (#971). */
class WifiOnlySyncConditionsTest {
    private val sourceRoot = File("src/main/java/io/silentsuite/sync")
    private val resRoot = File("src/main/res")

    @Test
    fun savedNetworkNameBlocksAutomaticSyncWithoutReadingTheNetwork() {
        var networkReads = 0
        assertFalse(wifiOnlySyncAllowed("Home") { networkReads++; true })
        assertFalse(wifiOnlySyncAllowed("") { networkReads++; true })
        assertEquals(0, networkReads)
    }

    @Test
    fun withoutSavedNameWifiOnlyFollowsTheConnectedWifiCheck() {
        assertTrue(wifiOnlySyncAllowed(null) { true })
        assertFalse(wifiOnlySyncAllowed(null) { false })
    }

    @Test
    fun conditionsNeverReadTheWifiNameAndStayOffWithoutWifiOnly() {
        val source = File(sourceRoot, "syncadapter/SyncAdapterService.kt").readText()
        val conditions = source.substringAfter("internal fun syncConditionsAllow(")
            .substringBefore("internal fun putSyncAttempt(")
        assertTrue(conditions.contains(
            "!settings.syncWifiOnly || wifiOnlySyncAllowed(settings.syncWifiOnlySSID) { onConnectedWifi(context) }"))
        assertTrue("plain Wi-Fi-only still needs connected WiFi",
            conditions.contains("network.type != ConnectivityManager.TYPE_WIFI || !network.isConnected"))
        listOf("WifiManager", "WIFI_SERVICE", "connectionInfo", ".ssid", "!!").forEach {
            assertFalse("sync conditions must not use $it", conditions.contains(it))
        }
        assertFalse(source.contains("android.net.wifi"))
        assertTrue("a missing ConnectivityManager counts as no network",
            conditions.contains("as? ConnectivityManager)?.activeNetworkInfo"))
    }

    @Test
    fun manualRunsStillSkipTheConditions() {
        mapOf(
            "syncadapter/CalendarsSyncAdapterService.kt" to
                "!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(settings)",
            "syncadapter/ContactsSyncAdapterService.kt" to
                "!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(settings)",
            "syncadapter/AddressBooksSyncAdapterService.kt" to
                "!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(settings)",
            "syncadapter/TasksSyncAdapterService.kt" to
                "!extras.containsKey(ContentResolver.SYNC_EXTRAS_MANUAL) && !checkSyncConditions(accountSettings)",
            "notes/NotesSyncRunner.kt" to "!request.manual && !syncConditionsAllow(appContext, settings)",
        ).forEach { (file, guard) ->
            assertTrue("$file keeps its manual bypass", File(sourceRoot, file).readText().contains(guard))
        }
    }

    @Test
    fun settingsShowAndClearASavedNameButAcceptNoNewOne() {
        val syncXml = File(resRoot, "xml/settings_sync.xml").readText()
        val row = syncXml.substringAfter("android:key=\"sync_wifi_only_ssid\"").substringBefore("/>")
        assertTrue(syncXml.contains("<Preference android:key=\"sync_wifi_only_ssid\""))
        assertFalse(row.contains("dialogMessage"))
        assertFalse(File(resRoot, "xml/settings_account_legacy.xml").readText().contains("sync_wifi_only_ssid"))

        val activity = File(sourceRoot, "ui/AppSettingsActivity.kt").readText()
        val writes = Regex("syncWifiOnlySSID = (\\w+)").findAll(activity).map { it.groupValues[1] }.toList()
        assertEquals("Settings can only clear the saved name", listOf("null"), writes)
        assertFalse(activity.contains("EditTextPreference>(\"sync_wifi_only_ssid\")"))
        assertTrue(activity.contains("isVisible = ssid != null"))

        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse("no location permission", manifest.contains("_LOCATION"))
    }
}
