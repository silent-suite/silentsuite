package io.silentsuite.sync.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Modifier

/**
 * Contract for the bounded, content-free scheduling diagnostic report.
 *
 * The category helpers are resolved by name so that a missing report fails these tests with a
 * readable assertion instead of breaking compilation of the whole unit-test source set.
 */
class SchedulingDiagnosticsContractTest {
    private val main = File("src/main")
    private val helperSource = File(main, "java/io/silentsuite/sync/ui/SchedulingDiagnostics.kt")

    private fun category(function: String, vararg args: Any?): String {
        val helper = try {
            Class.forName("io.silentsuite.sync.ui.SchedulingDiagnostics")
        } catch (e: ClassNotFoundException) {
            throw AssertionError("scheduling diagnostics are not implemented: SchedulingDiagnostics is missing")
        }
        val method = helper.methods.singleOrNull { it.name == function && Modifier.isStatic(it.modifiers) }
                ?: throw AssertionError("scheduling diagnostics are not implemented: $function is missing")
        try {
            return method.invoke(null, *args) as String
        } catch (e: InvocationTargetException) {
            throw AssertionError("$function must not throw for ${args.size} synthetic argument(s): ${e.targetException.javaClass.name}")
        }
    }

    @Test
    fun ageIsReportedAsBucketNeverAsTimestamp() {
        val minute = 60_000L
        val hour = 60 * minute
        for ((age, expected) in listOf(
                0L to "under_1m",
                minute - 1 to "under_1m",
                minute to "1m_to_15m",
                15 * minute - 1 to "1m_to_15m",
                15 * minute to "15m_to_1h",
                hour - 1 to "15m_to_1h",
                hour to "1h_to_6h",
                6 * hour - 1 to "1h_to_6h",
                6 * hour to "6h_to_24h",
                24 * hour - 1 to "6h_to_24h",
                24 * hour to "over_24h",
                Long.MAX_VALUE to "over_24h"
        ))
            assertEquals("age $age", expected, category("ageBucket", age))
    }

    @Test
    fun unknownAgeStaysExplicitlyUnknown() {
        for (age in listOf<Long?>(null, -1L, Long.MIN_VALUE))
            assertEquals("age $age", "unknown", category("ageBucket", age))
    }

    @Test
    fun standbyBucketIsUnavailableBelowApi28() {
        for (sdk in listOf(21, 22, 23, 26, 27))
            for (bucket in listOf<Int?>(null, 10, 40))
                assertEquals("API $sdk bucket $bucket", "unavailable", category("standbyBucket", sdk, bucket))
    }

    @Test
    fun standbyBucketUsesFixedCategoriesFromApi28() {
        for (sdk in listOf(28, 30, 34, 36))
            for ((bucket, expected) in listOf(
                    5 to "exempted",
                    10 to "active",
                    20 to "working_set",
                    30 to "frequent",
                    40 to "rare",
                    45 to "restricted"
            ))
                assertEquals("API $sdk bucket $bucket", expected, category("standbyBucket", sdk, bucket))
    }

    @Test
    fun unrecognizedStandbyBucketStaysExplicitlyUnknown() {
        for (bucket in listOf<Int?>(null, -1, 0, 7, 15, 50, Int.MAX_VALUE, Int.MIN_VALUE))
            assertEquals("bucket $bucket", "unknown", category("standbyBucket", 34, bucket))
    }

    @Test
    fun boundedReportIsReachableFromExistingAdvancedSettings() {
        val preferences = File(main, "res/xml/settings_advanced.xml").readText()
        val strings = File(main, "res/values/strings.xml").readText()
        val settings = File(main, "java/io/silentsuite/sync/ui/AppSettingsActivity.kt").readText()
        val debugInfo = File(main, "java/io/silentsuite/sync/ui/DebugInfoActivity.kt").readText()

        assertTrue(preferences.contains("""android:key="show_debug_info""""))
        assertTrue(preferences.contains("""android:key="show_scheduling_diagnostics""""))
        assertTrue(preferences.contains("""android:title="@string/app_settings_scheduling_diagnostics""""))
        assertTrue(strings.contains("""<string name="app_settings_scheduling_diagnostics">"""))
        assertTrue(settings.contains("""requirePreference<Preference>("show_scheduling_diagnostics")"""))
        assertTrue(settings.contains("DebugInfoActivity.newSchedulingIntent("))
        assertTrue(debugInfo.contains("fun newSchedulingIntent("))
    }

    @Test
    fun batteryExemptionIsNamedForWhatItMeasures() {
        val debugInfo = File(main, "java/io/silentsuite/sync/ui/DebugInfoActivity.kt").readText()

        assertFalse(debugInfo.contains("Power saving disabled"))
        assertTrue(debugInfo.contains("Battery optimization exemption: "))
    }

    @Test
    fun reportSourceNeitherMutatesNorReadsPrivateState() {
        assertTrue("scheduling diagnostics are not implemented: ${helperSource.path} is missing", helperSource.isFile)
        val source = helperSource.readText()

        for (forbidden in listOf(
                "requestSync", "cancelSync", "setSyncAutomatically", "setIsSyncable",
                "addPeriodicSync", "removePeriodicSync", "setMasterSyncAutomatically",
                "setUserData", "getUserData", "getPassword", "peekAuthToken", "getAuthToken",
                "removeAccount", "addAccountExplicitly", "SharedPreferences", ".edit()",
                "Logger.log", "android.util.Log", "printStackTrace", "stackTrace",
                ".message", ".localizedMessage", "UUID", ".ssid", "getSSID", "getBSSID",
                "Build.MODEL", "Build.MANUFACTURER", "Build.DEVICE", "Build.DISPLAY",
                "ANDROID_ID", "BuildConfig.VERSION"
        ))
            assertFalse("report source must not use $forbidden", source.contains(forbidden))
        assertFalse(Regex("""\.name\b(?!\s*\()""").containsMatchIn(source.replace("javaClass.name", "")))
    }

    @Test
    fun diagnosticsDeclareNoNewPermission() {
        val manifest = File(main, "AndroidManifest.xml").readText()
        val declared = Regex("""<uses-permission(?:-sdk-23)?\s[^>]*?android:name="([^"]+)"""")
                .findAll(manifest).map { it.groupValues[1] }.toSet()

        assertEquals(
                setOf(
                        "ACCESS_NETWORK_STATE", "ACCESS_WIFI_STATE", "INTERNET",
                        "READ_SYNC_SETTINGS", "READ_SYNC_STATS", "WRITE_SYNC_SETTINGS",
                        "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "POST_NOTIFICATIONS",
                        "AUTHENTICATE_ACCOUNTS", "GET_ACCOUNTS", "MANAGE_ACCOUNTS",
                        "WRITE_EXTERNAL_STORAGE", "READ_EXTERNAL_STORAGE",
                        "READ_CONTACTS", "WRITE_CONTACTS", "READ_CALENDAR", "WRITE_CALENDAR"
                ).map { "android.permission.$it" }.toSet(),
                declared
        )
    }
}
