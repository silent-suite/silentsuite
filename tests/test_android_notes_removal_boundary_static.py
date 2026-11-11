"""Static contracts for the Notes removal allowance's process boundary (a slot never outlives its process)."""

from pathlib import Path
import importlib.util
import json
import re


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "android/scripts/run-registry-process-boundary.sh"
RUNTIME = ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/NotesRemovalProcessBoundaryRuntimeTest.kt"
LEDGER = ROOT / "android/scripts/focused-runtime-ledger-v1.json"
WORKFLOW = ROOT / ".github/workflows/build-android.yml"


def _checker():
    spec = importlib.util.spec_from_file_location(
        "check_notes_removal_process_boundary", ROOT / "android/scripts/check-notes-removal-process-boundary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_notes_removal_pair_runs_as_separate_steps_in_the_registry_boundary_lane():
    script = SCRIPT.read_text(encoding="utf-8")
    runtime = RUNTIME.read_text(encoding="utf-8")
    checker = _checker()

    # Each step is its own invocation in a terminated app process, recorded for its own checker.
    steps = re.findall(r"^run_notes_step (\S+) (\S+)$", script, flags=re.MULTILINE)
    assert tuple(steps) == checker.EXPECTED_STEPS
    body = script.split("run_notes_step() {", 1)[1].split("\n}\n", 1)[0]
    assert body.index("terminate_app_process") < body.index("adb shell am instrument -w -r")
    # An app process that would not stop fails the step and does not end the script, so the cleanup step still runs.
    assert "\n  terminate_app_process || command_status=$?\n" in body
    assert '-e class "${notes_class}#${method}"' in body
    assert 'printf \'%s\\n\' "${command_status}" > "${notes_output}/${step}.exit"' in body
    assert "|| command_status=$?" in body and "timeout --signal=TERM --kill-after=10s 300s" in body
    assert 'notes_class="io.silentsuite.sync.ui.NotesRemovalProcessBoundaryRuntimeTest"' in script
    assert checker.TEST_CLASS == "io.silentsuite.sync.ui.NotesRemovalProcessBoundaryRuntimeTest"
    # Its inventory is written on every exit path, and a failure fails the lane.
    inventory = script.split("write_inventory() {", 1)[1].split("\n}\n", 1)[0]
    assert ('python3 "${script_dir}/check-notes-removal-process-boundary.py" "${notes_output}" "${api_level}" '
            "|| status=1") in inventory
    # The pair runs before the registry steps, whose last pair leaves an unreadable registry, and the cleanup
    # step runs last of the pair; the writer comes before the reader, with the control before both.
    assert script.index("run_notes_step cleanup") < script.index("run_step empty-write")
    assert [name for name, _ in checker.EXPECTED_STEPS] == ["control", "write", "read", "cleanup"]
    # The lane itself is unchanged: it runs this script on every API level it runs.
    job = WORKFLOW.read_text(encoding="utf-8").split("\n  registry-process-boundary:\n", 1)[1]
    assert 'script: bash android/scripts/run-registry-process-boundary.sh "${{ matrix.api-level }}"' in job

    # One method per step, and nothing in the class can stand in for a fresh process.
    methods = set(re.findall(r"@Test fun (\w+)\(", runtime))
    assert methods == {method for _, method in checker.EXPECTED_STEPS}
    for forbidden in ("resetForTesting", "ForTesting", "probe", "removeAccountExplicitly", "ActivityScenario"):
        assert forbidden not in runtime, forbidden
    # Only Android's asking path is under test; the rows go through AndroidCompat in the cleanup.
    assert runtime.count("manager.removeAccount(account, null, null, null)") == 1
    assert runtime.count("AndroidCompat.removeAccount(") == 1
    assert "NotesRemovalAllowance.process" in runtime
    reader = runtime.split("@Test fun readerInAFreshProcessIsRefusedWithTheSameVerdictAndFingerprint()", 1)[1]
    reader = reader.split("\n    @Test", 1)[0]
    for check in ('assertNotEquals("the reader shares the writer\'s process"', "NotesRemovalAllowance.WINDOW_MS",
                  'assertNull("the same key", decision.creationId)',
                  'assertEquals("the same verdict"', 'assertEquals("the same fingerprint"',
                  'assertFalse("a fresh process has no allowance", removeThroughAndroid(account))',
                  'assertTrue("the row stays", present(account))'):
        assert check in reader or check in runtime.split("private fun consumeState()", 1)[1], check
    assert reader.index("consumeState()") < reader.index("removeThroughAndroid(account)")
    # The launch's classification gave the row a creation id and a setup state; both go before the guard reads it.
    launch = reader.index('assertNotNull("this process\'s launch gave the row a creation id"')
    for key in ("AccountSettings.KEY_CREATION_ID, AccountSettings.KEY_POST_LOGIN_SETUP_STATE",
                "manager.setUserData(account, key, null)"):
        assert launch < reader.index(key) < reader.index("PendingNotesRemovalGuard.decision(context, account)"), key
    # The counters the slot binds start at 0 in every process: the reader takes the writer's row count and checks the
    # writer's notes-pending count after the guard's reads and right before the removal, so only the slot is missing.
    minted = runtime.split("private fun minted(account: Account): Minted {", 1)[1].split("\n    }\n", 1)[0]
    assert minted.index("allowance.mint(") < minted.index("val after = allowance.counts()")
    assert "Minted(tapped, fingerprint, after.rows, after.folders.getValue(Folder.PENDING))" in minted
    assert "assertEquals(setOf(Folder.PENDING), shown.folders.keys)" in minted
    aligned = ["val rows = AccountRowChanges.mainType\n",
               "while (rows.count() < state.rows) rows.before()\n",
               'assertEquals("the writer\'s row count", state.rows, rows.count())\n',
               'assertEquals("the writer\'s notes-pending count", state.pendingListings, '
               "NotesFolderListings.count(Folder.PENDING))\n",
               'assertFalse("a fresh process has no allowance", removeThroughAndroid(account))']
    positions = [reader.index(line) for line in aligned]
    assert positions == sorted(positions)
    assert reader.index('assertEquals("the same fingerprint"') < positions[0]
    assert runtime.count("assertEquals(9, lines.size)") == 1
    assert "minted.rows.toString(),\n            minted.pendingListings.toString()" in runtime
    # The pair is meaningless inside one process, so it stays out of the single-process ledger.
    assert "NotesRemovalProcessBoundaryRuntimeTest" not in LEDGER.read_text(encoding="utf-8")
    assert "NotesRemovalProcessBoundaryRuntimeTest" not in json.loads(LEDGER.read_text(encoding="utf-8"))["classes"]


def _transcript(test_class, method):
    return "\n".join([
        "INSTRUMENTATION_STATUS: class=" + test_class,
        "INSTRUMENTATION_STATUS: current=1",
        "INSTRUMENTATION_STATUS: test=" + method,
        "INSTRUMENTATION_STATUS_CODE: 1",
        "INSTRUMENTATION_STATUS: class=" + test_class,
        "INSTRUMENTATION_STATUS: test=" + method,
        "INSTRUMENTATION_STATUS_CODE: 0",
        "INSTRUMENTATION_RESULT: stream=",
        "OK (1 test)",
        "INSTRUMENTATION_CODE: -1",
        "",
    ])


def _write_all(directory, checker, skip=None):
    for step, method in checker.EXPECTED_STEPS:
        if step == skip:
            continue
        (directory / f"{step}.txt").write_text(_transcript(checker.TEST_CLASS, method), encoding="utf-8")
        (directory / f"{step}.exit").write_text("0\n", encoding="utf-8")


def test_notes_removal_boundary_checker_fails_closed(tmp_path):
    checker = _checker()

    good = tmp_path / "good"
    good.mkdir()
    _write_all(good, checker)
    assert checker.main(["checker", str(good), "36"]) == 0
    inventory = json.loads((good / checker.INVENTORY).read_text(encoding="utf-8"))
    assert inventory["outcome"] == "PASS" and inventory["api"] == 36 and inventory["extraFiles"] == []
    assert [item["step"] for item in inventory["steps"]] == ["control", "write", "read", "cleanup"]

    missing = tmp_path / "missing"
    missing.mkdir()
    _write_all(missing, checker, skip="read")
    assert checker.main(["checker", str(missing), "36"]) == 1

    failed = tmp_path / "failed"
    failed.mkdir()
    _write_all(failed, checker)
    method = dict(checker.EXPECTED_STEPS)["read"]
    (failed / "read.txt").write_text(_transcript(checker.TEST_CLASS, method).replace(
        "INSTRUMENTATION_STATUS_CODE: 0", "INSTRUMENTATION_STATUS_CODE: -2"), encoding="utf-8")
    assert checker.main(["checker", str(failed), "36"]) == 1

    timed_out = tmp_path / "timed-out"
    timed_out.mkdir()
    _write_all(timed_out, checker)
    (timed_out / "cleanup.exit").write_text("124\n", encoding="utf-8")
    assert checker.main(["checker", str(timed_out), "36"]) == 1

    other = tmp_path / "other"
    other.mkdir()
    _write_all(other, checker)
    (other / "write.txt").write_text(_transcript(checker.TEST_CLASS, dict(checker.EXPECTED_STEPS)["read"]),
                                     encoding="utf-8")
    assert checker.main(["checker", str(other), "36"]) == 1

    extra = tmp_path / "extra"
    extra.mkdir()
    _write_all(extra, checker)
    (extra / "stray.txt").write_text("", encoding="utf-8")
    assert checker.main(["checker", str(extra), "36"]) == 1
    assert json.loads((extra / checker.INVENTORY).read_text(encoding="utf-8"))["extraFiles"] == ["stray.txt"]
