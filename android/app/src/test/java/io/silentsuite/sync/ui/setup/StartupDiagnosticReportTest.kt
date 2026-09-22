package io.silentsuite.sync.ui.setup

import io.silentsuite.sync.ui.setup.PostLoginStartupChecks.BootstrapElapsedBucket as Bucket
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.ExceptionCategory
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Phase
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Reason
import io.silentsuite.sync.ui.setup.PostLoginStartupOutcome.Source
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartupDiagnosticReportTest {
    private val lineShape = Regex("[a-z_]+: [A-Za-z0-9._+-]+")

    private fun input(
        outcome: PostLoginStartupOutcome?,
        source: Source? = Source.LAUNCH,
        attempts: Int = 0,
        snapshotInFlight: Boolean = false,
        uiInFlight: Boolean = false,
        marker: Boolean? = true,
        versionName: String = "0.5.7-beta",
        bucket: Bucket = Bucket.UNDER_1S,
        rows: Int = 1,
        parses: Int = 1,
        launch: PostLoginStartupOutcome? = null,
    ) = StartupDiagnosticReport.Input(
        versionName, 57, 34,
        PostLoginStartupChecks.Snapshot(outcome, source, attempts, snapshotInFlight, bucket, rows, parses, launch),
        uiInFlight, marker,
    )

    private fun assertAllowlisted(report: String) {
        val lines = report.removeSuffix("\n").split("\n")
        assertEquals("SilentSuite startup diagnostic report", lines.first())
        assertEquals(22, lines.size)
        lines.drop(1).forEach { assertTrue(it, lineShape.matches(it)) }
    }

    @Test fun `schema 3 keeps every schema 2 line in place and appends the decode and launch lines`() {
        val lines = StartupDiagnosticReport.build(input(null)).removeSuffix("\n").split("\n")
        assertEquals(
            listOf(
                "schema_version", "app_version", "app_version_code", "android_sdk", "startup_outcome",
                "startup_phase", "startup_reason", "exception_category", "last_check",
                "retry_attempts_this_process", "retry_in_flight", "bootstrap_elapsed_bucket",
                "rows_classified", "session_parses", "migration_marker_present",
            ),
            lines.subList(1, 16).map { it.substringBefore(": ") },
        )
        assertEquals(
            listOf("registry_decode", "launch_outcome", "launch_phase", "launch_reason",
                "launch_exception_category", "launch_registry_decode"),
            lines.drop(16).map { it.substringBefore(": ") },
        )
        lines.drop(16).forEach { assertEquals("NOT_RECORDED", it.substringAfter(": ")) }
    }

    @Test fun `a retry never replaces the recorded launch outcome`() {
        val launch = PostLoginStartupOutcome(Phase.REGISTRY_READ, Reason.REGISTRY_UNREADABLE,
            registryDecode = AccountCreationRegistry.DecodeStatus.INVALID_PHASE)
        val retried = StartupDiagnosticReport.build(input(
            PostLoginStartupOutcome(Phase.MARKER_COMMIT, Reason.EXCEPTION, ExceptionCategory.SECURITY),
            Source.RETRY, attempts = 1, launch = launch,
        ))
        assertAllowlisted(retried)
        listOf(
            "startup_phase: MARKER_COMMIT", "startup_reason: EXCEPTION", "exception_category: SECURITY",
            "last_check: RETRY", "registry_decode: NOT_RECORDED",
            "launch_outcome: FAILED", "launch_phase: REGISTRY_READ", "launch_reason: REGISTRY_UNREADABLE",
            "launch_exception_category: NONE", "launch_registry_decode: INVALID_PHASE",
        ).forEach { assertTrue(it, retried.contains("$it\n")) }
        for (decode in AccountCreationRegistry.DecodeStatus.values()) {
            val outcome = PostLoginStartupOutcome(Phase.REGISTRY_READ, Reason.REGISTRY_UNREADABLE, registryDecode = decode)
            val report = StartupDiagnosticReport.build(input(outcome, Source.RETRY, launch = PostLoginStartupOutcome.SUCCEEDED))
            assertAllowlisted(report)
            assertTrue(report.contains("registry_decode: ${decode.name}\n"))
            assertTrue(report.contains("launch_outcome: SUCCEEDED\n"))
            assertTrue(report.contains("launch_registry_decode: NOT_RECORDED\n"))
        }
    }

    @Test fun `failed registry read renders the exact allowlisted schema`() {
        val unreadable = PostLoginStartupOutcome(Phase.REGISTRY_READ, Reason.REGISTRY_UNREADABLE,
            registryDecode = AccountCreationRegistry.DecodeStatus.INVALID_FIELD_COUNT)
        assertEquals(
            "SilentSuite startup diagnostic report\n" +
                "schema_version: 3\n" +
                "app_version: 0.5.7-beta\n" +
                "app_version_code: 57\n" +
                "android_sdk: 34\n" +
                "startup_outcome: FAILED\n" +
                "startup_phase: REGISTRY_READ\n" +
                "startup_reason: REGISTRY_UNREADABLE\n" +
                "exception_category: NONE\n" +
                "last_check: LAUNCH\n" +
                "retry_attempts_this_process: 0\n" +
                "retry_in_flight: no\n" +
                "bootstrap_elapsed_bucket: 1S_TO_5S\n" +
                "rows_classified: 0\n" +
                "session_parses: 0\n" +
                "migration_marker_present: yes\n" +
                "registry_decode: INVALID_FIELD_COUNT\n" +
                "launch_outcome: FAILED\n" +
                "launch_phase: REGISTRY_READ\n" +
                "launch_reason: REGISTRY_UNREADABLE\n" +
                "launch_exception_category: NONE\n" +
                "launch_registry_decode: INVALID_FIELD_COUNT\n",
            StartupDiagnosticReport.build(input(
                unreadable, bucket = Bucket.FROM_1S_TO_5S, rows = 0, parses = 0, launch = unreadable,
            )),
        )
    }

    @Test fun `hostile version text and out of range counters cannot inject content`() {
        val hostile = "0.5.7\nstartup_outcome: SUCCEEDED alice@example.invalid https://server.example.invalid/ " + "x".repeat(80)
        val report = StartupDiagnosticReport.build(
            input(PostLoginStartupOutcome.failed(Phase.MARKER_COMMIT, Reason.MARKER_COMMIT_FAILED), attempts = 5000,
                versionName = hostile, rows = 5000, parses = Int.MAX_VALUE)
        )
        assertAllowlisted(report)
        assertTrue(report.contains("rows_classified: 99\n"))
        assertTrue(report.contains("session_parses: 99\n"))
        assertFalse(report.contains("@"))
        assertFalse(report.contains("://"))
        assertFalse(report.contains(" SUCCEEDED"))
        assertEquals(1, report.split("\n").count { it.startsWith("startup_outcome: ") })
        assertTrue(report.contains("retry_attempts_this_process: 99\n"))
        assertTrue(report.split("\n")[2].length <= "app_version: ".length + 32)
        assertEquals("unknown", StartupDiagnosticReport.safeVersionName("\n@ /:"))
    }

    @Test fun `every typed code renders within the allowlist and either in-flight source is reported`() {
        for (phase in Phase.values()) for (reason in Reason.values()) for (category in ExceptionCategory.values()) {
            val report = StartupDiagnosticReport.build(
                input(PostLoginStartupOutcome(phase, reason, category), Source.RETRY, attempts = -3, uiInFlight = true, marker = null,
                    bucket = Bucket.OVER_30S, rows = -1, parses = -7)
            )
            assertAllowlisted(report)
            assertTrue(report.contains("retry_in_flight: yes\n"))
            assertTrue(report.contains("migration_marker_present: unknown\n"))
            assertTrue(report.contains("retry_attempts_this_process: 0\n"))
            assertTrue(report.contains("bootstrap_elapsed_bucket: OVER_30S\n"))
            assertTrue(report.contains("rows_classified: 0\n"))
            assertTrue(report.contains("session_parses: 0\n"))
        }
        val unrecorded = StartupDiagnosticReport.build(input(null, source = null, snapshotInFlight = true,
            bucket = Bucket.NOT_RECORDED, rows = 0, parses = 0))
        assertAllowlisted(unrecorded)
        assertTrue(unrecorded.contains("bootstrap_elapsed_bucket: NOT_RECORDED\n"))
        assertTrue(unrecorded.contains("startup_outcome: NOT_RECORDED\n"))
        assertTrue(unrecorded.contains("last_check: NOT_RECORDED\n"))
        assertTrue(unrecorded.contains("retry_in_flight: yes\n"))
        assertTrue(StartupDiagnosticReport.build(input(PostLoginStartupOutcome.SUCCEEDED)).contains("startup_outcome: SUCCEEDED\n"))
    }

    @Test fun `elapsed bucket boundaries are exact and out of range counters clamp`() {
        listOf(
            Long.MIN_VALUE to Bucket.UNDER_1S, -1L to Bucket.UNDER_1S, 0L to Bucket.UNDER_1S, 999L to Bucket.UNDER_1S,
            1_000L to Bucket.FROM_1S_TO_5S, 4_999L to Bucket.FROM_1S_TO_5S,
            5_000L to Bucket.FROM_5S_TO_15S, 14_999L to Bucket.FROM_5S_TO_15S,
            15_000L to Bucket.FROM_15S_TO_30S, 29_999L to Bucket.FROM_15S_TO_30S,
            30_000L to Bucket.OVER_30S, Long.MAX_VALUE to Bucket.OVER_30S,
        ).forEach { (elapsed, bucket) -> assertEquals("elapsed=$elapsed", bucket, Bucket.of(elapsed)) }
        assertEquals(
            listOf("UNDER_1S", "1S_TO_5S", "5S_TO_15S", "15S_TO_30S", "OVER_30S", "NOT_RECORDED"),
            Bucket.values().map { it.reportValue },
        )
        for (bucket in Bucket.values()) {
            val report = StartupDiagnosticReport.build(input(PostLoginStartupOutcome.SUCCEEDED, bucket = bucket, rows = 100, parses = 99))
            assertAllowlisted(report)
            assertTrue(report.contains("bootstrap_elapsed_bucket: ${bucket.reportValue}\n"))
            assertTrue(report.contains("rows_classified: 99\n"))
            assertTrue(report.contains("session_parses: 99\n"))
        }
        val defaults = PostLoginStartupChecks.Snapshot(null, null, 0, false)
        assertEquals(Bucket.NOT_RECORDED, defaults.bootstrapElapsedBucket)
        assertEquals(0, defaults.rowsClassified)
        assertEquals(0, defaults.sessionParses)
    }
}
