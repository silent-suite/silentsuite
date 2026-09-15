package io.silentsuite.sync.ui.setup

import android.content.Context
import android.os.Build
import io.silentsuite.sync.BuildConfig

/**
 * Privacy-reviewed startup report. Unlike the general debug report it never constructs
 * AccountSettings, reads accounts, logs or device/build identifiers: every value is a version
 * number, an allowlisted enum name, a capped counter or a yes/no flag.
 */
object StartupDiagnosticReport {
    const val SCHEMA_VERSION = 1
    private const val MAX_VERSION_NAME_LENGTH = 32

    data class Input(
        val versionName: String,
        val versionCode: Int,
        val androidSdk: Int,
        val snapshot: PostLoginStartupChecks.Snapshot,
        val uiRetryInFlight: Boolean,
        val migrationMarkerPresent: Boolean?,
    )

    fun capture(context: Context, uiRetryInFlight: Boolean): String = build(
        Input(
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            androidSdk = Build.VERSION.SDK_INT,
            snapshot = PostLoginStartupChecks.snapshot(),
            uiRetryInFlight = uiRetryInFlight,
            // Marker read only: no account, registry or AccountSettings access.
            migrationMarkerPresent = try {
                PostLoginSetupMigration.isBootstrapped(context.applicationContext)
            } catch (_: Exception) {
                null
            },
        )
    )

    fun build(input: Input): String {
        val outcome = input.snapshot.outcome
        return listOf(
            "SilentSuite startup diagnostic report",
            "schema_version: $SCHEMA_VERSION",
            "app_version: ${safeVersionName(input.versionName)}",
            "app_version_code: ${input.versionCode.coerceAtLeast(0)}",
            "android_sdk: ${input.androidSdk.coerceAtLeast(0)}",
            "startup_outcome: " + when {
                outcome == null -> "NOT_RECORDED"
                outcome.succeeded -> "SUCCEEDED"
                else -> "FAILED"
            },
            "startup_phase: ${outcome?.phase?.name ?: "NOT_RECORDED"}",
            "startup_reason: ${outcome?.reason?.name ?: "NOT_RECORDED"}",
            "exception_category: ${outcome?.exceptionCategory?.name ?: "NOT_RECORDED"}",
            "last_check: ${input.snapshot.source?.name ?: "NOT_RECORDED"}",
            "retry_attempts_this_process: ${input.snapshot.retryAttempts.coerceIn(0, 99)}",
            "retry_in_flight: ${yesNo(input.snapshot.retryInFlight || input.uiRetryInFlight)}",
            "migration_marker_present: ${input.migrationMarkerPresent?.let(::yesNo) ?: "unknown"}",
        ).joinToString("\n", postfix = "\n")
    }

    internal fun safeVersionName(raw: String): String =
        raw.filter { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it in "._+-" }
            .take(MAX_VERSION_NAME_LENGTH)
            .ifEmpty { "unknown" }

    private fun yesNo(value: Boolean) = if (value) "yes" else "no"
}
