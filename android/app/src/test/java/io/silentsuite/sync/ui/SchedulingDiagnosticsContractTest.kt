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
    fun absentOrBlankGenerationMetadataYieldsNoIdentity() {
        val store = io.silentsuite.sync.syncadapter.SyncStatusStore
        for (creationId in listOf(null, "", " ", "\t", "synthetic generation", "synthetic/generation", "g".repeat(129)))
            org.junit.Assert.assertNull("creation id [$creationId]", store.exactIdentityOf("type", "synthetic", creationId))
        val first = store.exactIdentityOf("type", "synthetic", "generation-1")
        org.junit.Assert.assertNotNull(first)
        assertEquals(first, store.exactIdentityOf("type", "synthetic", "generation-1"))
        assertFalse(first == store.exactIdentityOf("type", "synthetic", "generation-2"))

        var sampled = 0
        org.junit.Assert.assertNull(SchedulingDiagnostics.stableSample<String>({ null }) { sampled++; "sample" })
        assertEquals(0, sampled)
    }

    @Test
    fun sampleIsDroppedWhenGenerationChangesDuringSampling() {
        for (after in listOf<String?>("generation-b", null, "")) {
            val captures = mutableListOf<String?>("generation-a", after)
            org.junit.Assert.assertNull("after [$after]", SchedulingDiagnostics.stableSample({ captures.removeAt(0) }) { "sample" })
            assertTrue(captures.isEmpty())
        }
        var replacedDuringSampling = "generation-a"
        org.junit.Assert.assertNull(SchedulingDiagnostics.stableSample({ replacedDuringSampling }) {
            replacedDuringSampling = "generation-b"
            "sample"
        })
        org.junit.Assert.assertNull(SchedulingDiagnostics.stableSample<String>({ throw IllegalStateException("synthetic") }) { "sample" })
        org.junit.Assert.assertNull(SchedulingDiagnostics.stableSample({ "generation-a" }) { throw IllegalStateException("synthetic") })
        assertEquals("sample", SchedulingDiagnostics.stableSample({ "generation-a" }) { "sample" })
    }

    @Test
    fun malformedStoredStateIsUnknownNeverNoneOrZero() {
        val status = io.silentsuite.sync.syncadapter.SyncStatusStore.Status(
                lastSuccessAt = 1_000L,
                lastFailureCategory = io.silentsuite.sync.syncadapter.SyncStatusStore.FailureCategory.STORAGE,
                structuralStorageFailure = true
        )
        val lines = SchedulingDiagnostics.recordedLines(status, 2_000L)

        assertEquals(
                "    recorded request: unknown age=unknown\n" +
                "    recorded attempt: unknown age=unknown for open request=unknown\n" +
                "    last result: unknown age=unknown\n" +
                "    last success age=unknown last failure age=unknown category=unknown\n" +
                "    incomplete=unknown pending children=unknown storage=unknown\n",
                lines
        )
    }

    @Test
    fun readableStoredStateKeepsNoneAndFutureTimestampSemantics() {
        val now = 10 * 60_000L
        val empty = SchedulingDiagnostics.recordedLines(io.silentsuite.sync.syncadapter.SyncStatusStore.Status(), now)
        assertTrue(empty.contains("recorded request: none age=none\n"))
        assertTrue(empty.contains("pending children=0 storage=readable\n"))

        val future = SchedulingDiagnostics.recordedLines(io.silentsuite.sync.syncadapter.SyncStatusStore.Status(
                activeRequestId = "synthetic-request", requestedAt = now + 1,
                activeAttemptId = "synthetic-attempt", attemptStartedAt = now - 5 * 60_000L,
                attemptRequestId = "synthetic-request", lastSuccessAt = -1L
        ), now)
        assertTrue(future.contains("recorded request: open age=unknown\n"))
        assertTrue(future.contains("recorded attempt: open age=1m_to_15m for open request=yes\n"))
        assertTrue(future.contains("last success age=unknown "))
        assertFalse(future.contains("synthetic"))
    }

    @Test
    fun unreadableCapabilitiesNeverClaimThereIsNoNetwork() {
        assertEquals("yes", SchedulingDiagnostics.networkLabel(true, true))
        assertEquals("no", SchedulingDiagnostics.networkLabel(true, false))
        assertEquals("unknown", SchedulingDiagnostics.networkLabel(true, null))
        assertEquals("unavailable", SchedulingDiagnostics.networkLabel(false, null))
        assertEquals("unavailable", SchedulingDiagnostics.networkLabel(false, true))

        assertEquals("unknown", SchedulingDiagnostics.capabilityLabel(true, true, null))
        assertEquals("unknown", SchedulingDiagnostics.capabilityLabel(true, null, null))
        assertEquals("unknown", SchedulingDiagnostics.capabilityLabel(true, null, true))
        assertEquals("unavailable", SchedulingDiagnostics.capabilityLabel(true, false, null))
        assertEquals("unavailable", SchedulingDiagnostics.capabilityLabel(false, true, true))
        assertEquals("yes", SchedulingDiagnostics.capabilityLabel(true, true, true))
        assertEquals("no", SchedulingDiagnostics.capabilityLabel(true, true, false))
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
