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
    # One gate read yields both the fail-closed decision and its decode step; never a second read.
    assert source.count("registry.readResult()") == 1
    assert "registry.records() == null" not in source
    assert (
        "if (initial.records == null)\n"
        "            return PostLoginStartupOutcome(Phase.REGISTRY_READ, Reason.REGISTRY_UNREADABLE, "
        "registryDecode = initial.status)"
    ) in source
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
    assert "const val SCHEMA_VERSION = 3" in report
    for line in (
        "bootstrap_elapsed_bucket: ", "rows_classified: ", "session_parses: ", "registry_decode: ",
        "launch_outcome: ", "launch_phase: ", "launch_reason: ", "launch_exception_category: ",
        "launch_registry_decode: ",
    ):
        assert line in report, line
    # Schema 3 only appends: the last schema 2 line still precedes every new line.
    assert report.index('"migration_marker_present: ') < report.index('"registry_decode: ')
    # The launch outcome is kept apart from the latest one and is forgotten only with it.
    assert "if (source == PostLoginStartupOutcome.Source.LAUNCH) launchOutcome = run.outcome" in checks
    assert "launchOutcome = null" in checks
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


def test_registry_decode_status_is_content_free_and_still_fails_closed():
    registry = (SETUP / "AccountCreationRegistry.kt").read_text(encoding="utf-8")
    decoder = registry.split("private fun decodeResult", 1)[1].split("private fun encode", 1)[0]

    enum_block = registry.split("enum class DecodeStatus {", 1)[1].split("}", 1)[0]
    assert re.findall(r"\b([A-Z][A-Z_]+)\b", enum_block) == [
        "OK", "NOT_STORED", "INVALID_HEADER", "INVALID_FIELD_COUNT", "INVALID_ENCODING", "INVALID_PHASE",
        "INVALID_TIMESTAMP", "UNEXPECTED_RUNTIME_EXCEPTION", "UNEXPECTED_ERROR", "UNEXPECTED_OTHER",
    ]
    # Anything thrown still yields no rows; only the step or a coarse kind leaves the decoder.
    assert "catch (error: Throwable)" in decoder
    assert "null to failureStatus(error, step)" in decoder
    assert 'require(parts.firstOrNull() == "v$VERSION")' in decoder
    assert "require(values.size == 5)" in decoder
    for forbidden in (".message", "stackTrace", "localizedMessage", "Logger", "hashCode", "MessageDigest"):
        assert forbidden not in registry, forbidden
    assert "fun records(): List<Record>? = readResult().records" in registry
    # Forward-write only: the stored form has no terminal newline, and the reader neither trims
    # nor skips anything it did not already skip.
    encoder = registry.split("private fun encode", 1)[1].split("private fun escape", 1)[0]
    assert '(listOf("v$VERSION") + ' in encoder and '}).joinToString("\\n")' in encoder
    assert "append('\\n')" not in registry
    assert "private const val VERSION = 1;" in registry
    assert 'val parts = raw.split("\\n"); require(parts.firstOrNull() == "v$VERSION")' in decoder
    assert "parts.drop(1).filter { it.isNotEmpty() }.forEach { line ->" in decoder
    for forbidden in ("trim", "isBlank", "isNotBlank", "strip", "dropLastWhile"):
        assert forbidden not in registry, forbidden


def test_registry_process_boundary_lane_is_wired_with_an_exact_inventory():
    workflow = (ROOT / ".github/workflows/build-android.yml").read_text(encoding="utf-8")
    script = (ROOT / "android/scripts/run-registry-process-boundary.sh").read_text(encoding="utf-8")
    runner = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/SilentSuiteTestRunner.kt").read_text(encoding="utf-8")
    runtime = (
        ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/setup/RegistryProcessBoundaryRuntimeTest.kt"
    ).read_text(encoding="utf-8")
    ledger = (ROOT / "android/scripts/focused-runtime-ledger-v1.json").read_text(encoding="utf-8")
    checker = _load_boundary_checker()

    job = workflow.split("\n  registry-process-boundary:\n", 1)[1]
    assert "timeout-minutes: 60" in job and "contents: read" in job and "needs: conscrypt-r28" in job
    assert re.findall(r"api-level: (\d+)\n\s+image-required: (true|false)", job) == [
        ("21", "true"), ("35", "true"), ("36", "true"), ("37", "false"),
    ]
    assert 'script: bash android/scripts/run-registry-process-boundary.sh "${{ matrix.api-level }}"' in job
    # A lane that did not run says exactly why; a broken probe is never reported as a missing image.
    for outcome in ("NOT_RUN_IMAGE_NOT_LISTED", "NOT_RUN_AVAILABILITY_PROBE_FAILED", "INVENTORY_UNAVAILABLE"):
        assert outcome in job, outcome
    assert "NOT_RUN_FIXTURE_DID_NOT_START" not in job
    assert "continue-on-error" not in job
    # The image is matched as a whole first-column identifier: x86 must never match x86_64.
    assert 'mode == "exact" && id == wanted { found = 1 }' in job
    assert 'if first_column_has "$IMAGE" exact; then' in job
    assert 'grep -Fq "$IMAGE"' not in job
    # An absent required image is recorded as absent before the job fails.
    required = job.split('image-required }}" = "true" ]; then', 1)[1].split("\n          else\n", 1)[0]
    assert required.index('echo "available=false" >> "$GITHUB_OUTPUT"') < required.index("exit 1")
    # Every lane without a pass, including an optional API level, says so in the run summary.
    record = job.split("- name: Record why the registry process boundary did not run", 1)[1].split("- name: ", 1)[0]
    assert "if: always()" in record and '>> "$GITHUB_STEP_SUMMARY"' in record
    assert "No pass was produced for this API level." in record
    debug_rules = (ROOT / "android/app/proguard-debug-test-rules.pro").read_text(encoding="utf-8")
    # Linkage is proven by the minified lane itself, not by exempting the subject from R8.
    assert "io.silentsuite" not in debug_rules
    assert 'printf \'%s\\n\' "${command_status}" > "${output}/${step}.exit"' in script
    assert "|| true\n  tr -d" not in script
    for forbidden in ("secrets.", "KSTOREPWD", "signingStoreLocation", "assembleRelease", "bundleRelease"):
        assert forbidden not in job and forbidden not in script, forbidden

    # Separate instrumentation invocations, the process terminated before each, and no data reset.
    steps = re.findall(r"^run_step (\S+) (\S+)$", script, flags=re.MULTILINE)
    assert tuple(steps) == checker.EXPECTED_STEPS
    assert script.count("terminate_app_process\n") >= 2 and 'am force-stop "${package}"' in script
    assert script.index("run_step reinstall-write") < script.index('adb install -r "${apk}"') < script.index(
        "run_step reinstall-read")
    for forbidden in ("pm clear", "uninstall", "connectedDebugAndroidTest", "rm -rf /data", "run-as"):
        assert forbidden not in script, forbidden
    for bound in ("1500s", "300s"):
        assert f"timeout --signal=TERM --kill-after=10s {bound}" in script

    methods = set(re.findall(r"@Test fun (\w+)\(", runtime))
    assert methods == {method for _, method in checker.EXPECTED_STEPS}
    assert checker.TEST_CLASS.rsplit(".", 1)[1] == "RegistryProcessBoundaryRuntimeTest"
    assert "AccountCreationRegistry.open(context)" in runtime
    for forbidden in (".edit()", "putString", "remove(", "resetForTest", "ActivityScenario"):
        assert forbidden not in runtime, forbidden
    # Transport controls: plain SharedPreferences in their own test-only file, never the registry,
    # never a reset, and nothing but names, enums and a capped count can leave them.
    controls = (
        ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/setup/RegistryTransportControls.kt"
    ).read_text(encoding="utf-8")
    assert 'private const val PREFS = "registry_transport_controls_test"' in controls
    assert controls.count("getSharedPreferences(") == 1
    for forbidden in (
        "account_creation_registry", "AccountCreationRegistry.open", ".clear()", "remove(", "Log.", "println",
        "MessageDigest", "hashCode", ".code", "toByteArray", "File(",
    ):
        assert forbidden not in controls, forbidden
    assert "minOf(suffix.length, MAX_REPORTED_SUFFIX)" in controls
    assert "RegistryTransportControls.commit(context)" in runtime
    assert "RegistryTransportControls.observe(context)" in runtime
    # The fail-closed expectation is unchanged; it now carries the content-free evidence line.
    assert 'assertEquals("$evidence verdict=REGISTRY_PROBE_STATUS", DecodeStatus.OK, beforeLaunch.status)' in runtime
    assert runtime.count("DecodeStatus.OK, beforeLaunch.status)") == 2
    # The registry's twin is the newline-free control; the newline-terminated one stays as a diagnostic.
    assert 'const val EMPTY_REGISTRY = "v1"\n' in runtime
    assert 'const val REGISTRY_TWIN = "header_plain"' in controls
    assert 'REGISTRY_TWIN to "v1",' in controls and '"header_newline" to "v1\\n",' in controls
    assert runtime.index("RegistryTransportControls.report(evidence)") < runtime.index("verdict=CONTROL_MISSING")
    assert 'assertEquals("$evidence verdict=REGISTRY_VALUE_CHANGED", exact, registryChange)' in runtime
    assert "verdict=NEWLINE_CONTROL_UNEXPECTED" in runtime
    assert "assertNotEquals(\"Reader shares the writer's process\"" in runtime
    # A raw stored value can never reach an assertion message.
    assert "storedValue())" not in runtime.replace("RegistryTransportControls.classify(EMPTY_REGISTRY, storedValue())", "")
    assert "if (registryBoundaryProbe) RegistryProcessBoundaryProbe.captureBeforeLaunch(app)" in runner
    # The pair is meaningless inside one process, so it stays out of the single-process ledger.
    assert "RegistryProcessBoundaryRuntimeTest" not in ledger


def _load_boundary_checker():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "check_registry_process_boundary", ROOT / "android/scripts/check-registry-process-boundary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_registry_process_boundary_checker_fails_closed(tmp_path):
    checker = _load_boundary_checker()

    good_evidence = (
        "registry-transport probe=OK registry=EXACT header_plain=EXACT "
        "header_newline=TRAILING_WHITESPACE_APPENDED/SPACES_ONLY/4 newline_only=OTHER"
    )

    def transcript(method, codes=("1", "0"), tail="OK (1 test)", evidence=None):
        blocks = [
            f"INSTRUMENTATION_STATUS: class={checker.TEST_CLASS}\r\nINSTRUMENTATION_STATUS: test={method}\r\n"
            f"INSTRUMENTATION_STATUS_CODE: {code}\r\n" for code in codes]
        if evidence is not None:
            blocks.insert(1, f"INSTRUMENTATION_STATUS: registryTransport={evidence}\r\nINSTRUMENTATION_STATUS_CODE: 2\r\n")
        return "".join(blocks) + f"INSTRUMENTATION_RESULT: stream=\r\n\r\n{tail}\r\n\r\nINSTRUMENTATION_CODE: -1\r\n"

    def seed(directory):
        directory.mkdir()
        for step, method in checker.EXPECTED_STEPS:
            evidence = good_evidence if step == checker.EVIDENCE_STEP else None
            (directory / f"{step}.txt").write_text(transcript(method, evidence=evidence), encoding="utf-8")
            (directory / f"{step}.exit").write_text("0\n", encoding="utf-8")
        (directory / "reinstall-install.exit").write_text("0\n", encoding="utf-8")
        (directory / "reinstall-before.txt").write_text("firstInstallTime=a\nlastUpdateTime=a\n", encoding="utf-8")
        (directory / "reinstall-install.txt").write_text("Performing Streamed Install\nSuccess\n", encoding="utf-8")
        (directory / "reinstall-after.txt").write_text("firstInstallTime=a\nlastUpdateTime=b\n", encoding="utf-8")
        return directory

    passing = seed(tmp_path / "pass")
    assert checker.main(["checker", str(passing), "36"]) == 0
    assert '"outcome":"PASS"' in (passing / "inventory.json").read_text(encoding="utf-8")
    # The inventory it wrote is not an extra file on a second evaluation.
    assert checker.evaluate(passing, "36")["outcome"] == "PASS"

    def failing(name, mutate):
        directory = seed(tmp_path / name)
        mutate(directory)
        assert checker.main(["checker", str(directory), "36"]) == 1, name
        assert '"outcome":"FAIL"' in (directory / "inventory.json").read_text(encoding="utf-8")

    reader = checker.EXPECTED_STEPS[1][1]
    # The passing inventory carries the content-free transport line of the empty reader only.
    recorded = {item["step"]: item["evidence"] for item in checker.evaluate(passing, "36")["steps"]}
    assert recorded.pop(checker.EVIDENCE_STEP) == good_evidence and set(recorded.values()) == {None}
    empty_reader = checker.EXPECTED_STEPS[1][1]
    failing("no-evidence", lambda d: (d / "empty-read.txt").write_text(transcript(empty_reader), encoding="utf-8"))
    for index, raw in enumerate(("registry-transport probe=OK registry=v1", "registry-transport probe=OK x=EXACT/aGVsbG8=/4",
                                 "probe=OK", "registry-transport probe=OK registry=EXACT/SPACES_ONLY/400")):
        failing(f"raw-evidence-{index}", lambda d, raw=raw: (d / "empty-read.txt").write_text(
            transcript(empty_reader, evidence=raw), encoding="utf-8"))
        assert raw not in (tmp_path / f"raw-evidence-{index}" / "inventory.json").read_text(encoding="utf-8")
    failing("stray-evidence", lambda d: (d / "populated-read.txt").write_text(
        transcript(checker.EXPECTED_STEPS[3][1], evidence=good_evidence), encoding="utf-8"))
    failing("missing", lambda d: (d / "populated-read.txt").unlink())
    # A complete-looking transcript never rescues a timed-out, failed or unrecorded command.
    failing("timeout", lambda d: (d / "populated-read.exit").write_text("124\n", encoding="utf-8"))
    failing("adb-failure", lambda d: (d / "empty-write.exit").write_text("1\n", encoding="utf-8"))
    failing("missing-exit", lambda d: (d / "reinstall-read.exit").unlink())
    failing("reinstall-timeout", lambda d: (d / "reinstall-install.exit").write_text("137\n", encoding="utf-8"))
    failing("extra", lambda d: (d / "surprise.txt").write_text("x", encoding="utf-8"))
    failing("failed", lambda d: (d / "empty-read.txt").write_text(
        transcript(reader, codes=("1", "-2"), tail="FAILURES!!!"), encoding="utf-8"))
    failing("wrong-method", lambda d: (d / "empty-read.txt").write_text(
        transcript(checker.EXPECTED_STEPS[0][1]), encoding="utf-8"))
    failing("duplicate", lambda d: (d / "empty-read.txt").write_text(
        transcript(reader, codes=("1", "0", "1", "0")), encoding="utf-8"))
    failing("crash", lambda d: (d / "empty-read.txt").write_text(
        "INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: 0\n", encoding="utf-8"))
    failing("empty-run", lambda d: (d / "empty-read.txt").write_text(
        "INSTRUMENTATION_RESULT: stream=\n\nOK (0 tests)\n\nINSTRUMENTATION_CODE: -1\n", encoding="utf-8"))
    failing("fresh-install", lambda d: (d / "reinstall-after.txt").write_text(
        "firstInstallTime=b\nlastUpdateTime=b\n", encoding="utf-8"))
    failing("install-failed", lambda d: (d / "reinstall-install.txt").write_text("Failure [X]\n", encoding="utf-8"))
