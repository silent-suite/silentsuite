"""Static production-wiring contracts for Android post-login bootstrap."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup"
MIGRATION = SETUP / "PostLoginSetupMigration.kt"


def test_production_bootstrap_separates_row_classification_from_marker_publication():
    source = MIGRATION.read_text(encoding="utf-8")
    production = source.split(
        "fun bootstrapOutcome(\n"
        "        context: Context,\n"
        "        onRowClassified: () -> Unit = {},\n"
        "        onSessionParse: () -> Unit = {},\n"
        "    ): PostLoginStartupOutcome = synchronized(BOOTSTRAP_LOCK)",
        1,
    )[1].split(
        "/**\n     * Startup repair", 1
    )[0]

    assert "interface RowStore" in source
    assert "interface Store : RowStore" in source
    assert "internal fun classifyRows(store: RowStore" in source
    assert "val rows = object : RowStore" in production
    assert production.count("object : RowStore") == 1
    assert re.search(r"\bbootstrap\s*\(", production) is None
    assert "override fun marker() = 0" not in production
    assert "override fun writeMarker" not in production
    assert "marker()" not in production
    assert "classifyRows = { classifyRowsOutcome(rows, onRowClassified, onSessionParse) }" in production
    assert 'prefs.edit().putInt("version", MIGRATION_VERSION).commit()' in production
    # The simplified JVM Store overload keeps its short-circuit; production always reconciles.
    assert "if (store.marker() == MIGRATION_VERSION) return true" in source
    assert "fun bootstrap(context: Context): Boolean = bootstrapOutcome(context).succeeded" in source
    assert "synchronized(BOOTSTRAP_LOCK)" in source


def test_every_fail_closed_boundary_maps_to_a_typed_reason():
    source = MIGRATION.read_text(encoding="utf-8")
    outcome = (SETUP / "PostLoginStartupOutcome.kt").read_text(encoding="utf-8")
    coordinator = (SETUP / "PostLoginBootstrapCoordinator.kt").read_text(encoding="utf-8")
    classify = source.split("internal fun classifyRowsOutcome", 1)[1].split("/** Runs row classification", 1)[0]
    reconcile = source.split("internal fun <H : Any> reconcileRecords", 1)[1].split("/** Account.restore", 1)[0]

    assert "return false" not in classify and "return false" not in reconcile
    assert classify.count("return Reason.CLASSIFY_") == 3
    assert reconcile.count("return Reason.RECONCILE_") == 6
    # Ownership remains fail closed: nothing erases or bypasses an unreadable registry.
    assert "Reason.REGISTRY_UNREADABLE" in source
    assert "registry.records() == null" in source
    for forbidden in ("commit(null)", 'remove("rows")', "quarantineBlob", "clearActiveAccount"):
        assert forbidden not in source

    enum_block = outcome.split("enum class Reason {", 1)[1].split("}", 1)[0]
    reasons = re.findall(r"\b([A-Z][A-Z_]+)\b", enum_block)
    assert "REGISTRY_UNREADABLE" in reasons and "EXCEPTION" in reasons
    combined = source + outcome + coordinator
    for reason in reasons:
        assert f"Reason.{reason}" in combined, reason


def test_startup_diagnostics_are_allowlisted_local_and_never_reuse_debug_info():
    report = (SETUP / "StartupDiagnosticReport.kt").read_text(encoding="utf-8")
    dialog = (SETUP / "StartupDiagnosticReportDialog.kt").read_text(encoding="utf-8")
    checks = (SETUP / "PostLoginStartupChecks.kt").read_text(encoding="utf-8")
    outcome = (SETUP / "PostLoginStartupOutcome.kt").read_text(encoding="utf-8")
    activity = (SETUP / "PostLoginSetupActivity.kt").read_text(encoding="utf-8")
    view_model = (SETUP / "PostLoginSetupViewModel.kt").read_text(encoding="utf-8")
    app = (ROOT / "android/app/src/main/java/io/silentsuite/sync/App.kt").read_text(encoding="utf-8")
    layout = (ROOT / "android/app/src/main/res/layout/activity_post_login_setup.xml").read_text(encoding="utf-8")

    for forbidden in (
        "AccountSettings(", "AccountManager", "getAccountsByType", "AccountCreationRegistry",
        "Build.MODEL", "Build.DEVICE", "Build.MANUFACTURER", "Build.DISPLAY", "Build.FINGERPRINT",
        "Build.BRAND", "Build.PRODUCT", "Build.SERIAL", "INSTALLER", "Logger", ".message",
        "stackTrace", "printStackTrace", "System.currentTimeMillis", "hashCode", "MessageDigest",
        "Locale", "DebugInfoActivity",
    ):
        assert forbidden not in report, forbidden
    for forbidden in (".message", "stackTrace", "localizedMessage", "toString()"):
        assert forbidden not in outcome, forbidden
    for forbidden in (
        "AccountManager", "AccountSettings", "DebugInfoActivity", "EXTRA_STREAM", "FileProvider",
        "HttpClient", "java.net", "okhttp",
    ):
        assert forbidden not in dialog, forbidden
    assert "Intent.ACTION_SEND" in dialog and '.setType("text/plain")' in dialog
    assert "putExtra(Intent.EXTRA_TEXT, report)" in dialog
    assert "ClipData.newPlainText(getString(R.string.startup_report_clip_label), report)" in dialog
    assert "catch (_: ActivityNotFoundException)" in dialog
    assert "LayoutInflater.from(requireContext())" in dialog
    # In-memory only: no persisted snapshot, blob, timestamp or export path.
    for forbidden in ("getSharedPreferences", "commit()", "File(", "filesDir", "cacheDir"):
        assert forbidden not in checks, forbidden
    # Bootstrap-only timing: a coarse bucket and capped counters, never a raw duration or clock.
    assert "const val SCHEMA_VERSION = 2" in report
    for line in ("bootstrap_elapsed_bucket: ", "rows_classified: ", "session_parses: "):
        assert line in report, line
    assert "SystemClock.elapsedRealtime()" in checks
    assert "latestElapsedBucket = BootstrapElapsedBucket.NOT_RECORDED" in checks

    assert "DebugInfoActivity" not in activity
    assert "StartupDiagnosticReport.capture(applicationContext" in activity
    assert "R.string.post_login_bootstrap_retry_failed" in activity
    assert 'android:id="@+id/setup_view_diagnostic_report"' in layout
    assert "PostLoginStartupChecks.runAtLaunch(this)" in app
    assert "PostLoginSetupMigration.bootstrap(this)" not in app
    assert "PostLoginStartupChecks.retry(context)" in view_model
    assert "PostLoginSetupMigration.bootstrap(context)" not in view_model
