"""Contracts for the Android CI speed changes in build-android.yml.

* superseded pull_request runs are cancelled per workflow and PR; every other run
  has its own group and is never cancelled;
* the static contract suite runs once, in its own unconditional read-only job;
  build-pr no longer repeats it or provisions its Python and packages, but needs
  that job and starts with a dependency-result gate, so a failed, skipped or
  cancelled static job (or native producer) fails build-pr instead of skipping it;
* build-pr runs its helper scripts on the runner's preinstalled python3, the same
  strategy as the release build. That is not a pinned interpreter version, so
  hosted CI running every helper is what shows they are compatible;
* Etebase is built once per run by one producer, and every native consumer admits
  that same-run artifact before its first Gradle or emulator step, keeping its
  NDK provisioning and every later gate;
* right after the unchanged debug unit-test step, build-pr runs the exact admitted
  ical4android JVM evidence unless cancelled: the full suite, a fail-when-missing
  upload of its JUnit XML and HTML, and an inline python3 check that every required
  method executed and was not skipped.

The checker runs against byte copies of the original predecessor (immutable base
f867267e) and of the immediate predecessor (8cb81b42) to show the exact violations
it rejects, against the candidate, which must have none, and against candidate
mutations, which must each be caught. The gate's real shell script is also
executed with every dependency outcome.
"""

from __future__ import annotations

import copy
import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/build-android.yml"
RELEASE_WORKFLOW = ROOT / ".github/workflows/release-android.yml"
BASE_FIXTURE = ROOT / "tests/fixtures/build-android-base-f867267e.yml"
BASE_FIXTURE_SHA256 = "c429134d85718a265b5366c0cbe4aef32298c0addb0d7487a50b6854e2ffa4d8"

PRODUCER = "etebase-16kb"
STATIC_JOB = "static-contracts"
CONSUMERS = ("build-pr", "account-recreation-runtime", "color-parity-evidence", "registry-process-boundary")
UNCHANGED_JOBS = ("signing-policy", "conscrypt-r28", "conscrypt-runtime")
ARTIFACT = "etebase-16kb-${{ github.sha }}"
STAGING = "${{ runner.temp }}/etebase-16kb-artifact"
BUILD_SCRIPT = "scripts/build-etebase-client-16kb.sh"
RECORD = 'python3 scripts/etebase-run-artifact.py record --staging "$RUNNER_TEMP/etebase-16kb-artifact"'
ADMIT = 'python3 scripts/etebase-run-artifact.py verify --staging "$RUNNER_TEMP/etebase-16kb-artifact"'
NATIVE_VERIFY = (
    "scripts/verify-native-16kb.py",
    "--require-lib libetebase_android.so",
    "--require-android-ndk-major libetebase_android.so=28",
    "app/libs/client-2.3.2-16kb.aar",
)
STATIC_RUN = "python -m pytest ../tests/test_android_*.py -q"
NDK = "ndk;28.2.13676358"
UPLOAD = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
DOWNLOAD = "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
UPLOAD_WITH = {
    "name": ARTIFACT,
    "path": STAGING,
    "if-no-files-found": "error",
    "retention-days": 1,
    "overwrite": True,
}
CONCURRENCY = {
    "group": (
        "${{ github.workflow }}-${{ github.event_name == 'pull_request' && "
        "format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}"
    ),
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
}
ADMISSION_STEP_NAMES = (
    "Download same-run Etebase 16 KB AAR",
    "Admit same-run Etebase 16 KB AAR",
    "Verify admitted Etebase 16 KB AAR",
)

PREDECESSOR_FIXTURE = ROOT / "tests/fixtures/build-android-base-8cb81b42.yml"
PREDECESSOR_FIXTURE_SHA256 = "c071ade5be4e8e69425941df7a5c016a96fca92815dfc9b79b4c313ac284832a"

# The static suite exactly as both jobs provision and run it.
EXPECTED_PYTHON_SETUP = {
    "name": "Set up Python for static Android contracts",
    "uses": "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "with": {"python-version": "3.x"},
}
EXPECTED_DEPENDENCY_INSTALL = {
    "name": "Install Android static contract dependencies",
    "run": "python -m pip install --disable-pip-version-check pytest PyYAML==6.0.3\n",
}
EXPECTED_STATIC_RUN_STEP = {"name": "Run Android static Python contracts", "run": STATIC_RUN}
# Only the static job needs them; build-pr dropped both with the repeated suite.
STATIC_PROVISIONING = (EXPECTED_PYTHON_SETUP, EXPECTED_DEPENDENCY_INSTALL)
SETUP_PYTHON = "actions/setup-python@"
STATIC_PROVISIONING_MARKERS = ("pip install", "python -m", "pytest", "PyYAML")

# build-pr waits for the static job, and runs (unless the run is cancelled) even
# when a dependency did not succeed, so that its first step fails it closed rather
# than leaving a skipped job that a required check would count as passing.
BUILD_PR_NEEDS = [STATIC_JOB, "conscrypt-r28", PRODUCER]
EVENT_CONDITION = "github.event_name == 'pull_request' || !startsWith(github.ref, 'refs/tags/v')"
BUILD_PR_IF = f"${{{{ !cancelled() && ({EVENT_CONDITION}) }}}}"
GATE_NAME = "Require successful static contracts and native producers"
GATE_ENV = {
    "STATIC_RESULT": "${{ needs.static-contracts.result }}",
    "CONSCRYPT_RESULT": "${{ needs.conscrypt-r28.result }}",
    "ETEBASE_RESULT": "${{ needs.etebase-16kb.result }}",
}
# The only build-pr steps allowed a condition: report-only uploads that execute no
# candidate code and download or admit nothing.
REPORT_UPLOAD_NAMES = ("Upload unit test reports and results", "Upload lint reports")

# The admitted ical4android JVM evidence (CI-A0): immediately after the unchanged debug
# unit-test step, the full ical4android JVM suite runs unless the run is cancelled, so an
# earlier failure still fails the job; its JUnit XML and HTML are uploaded, failing when
# missing; and an inline verifier on the preinstalled python3 fails unless every
# required method executed without being skipped. Each step must match exactly.
DEBUG_STEP_NAME = "Run debug unit tests, lint, and assemble instrumentation APKs"
UNLESS_CANCELLED = "${{ !cancelled() }}"
JVM_SUITE_TASK = "ical4android:testDebugUnitTest"
JVM_TEST_STEP = {
    "name": "Run ical4android JVM unit tests",
    "if": UNLESS_CANCELLED,
    "run": f"./gradlew {JVM_SUITE_TASK} --continue --no-daemon -PrequireEtebase16Kb=true -PrequireConscryptR28=true",
}
JVM_UPLOAD_STEP = {
    "name": "Upload ical4android unit test reports and results",
    "if": UNLESS_CANCELLED,
    "uses": UPLOAD,
    "with": {
        "name": "ical4android-unit-test-results-${{ github.sha }}",
        "path": (
            "android/ical4android/build/test-results/testDebugUnitTest/\n"
            "android/ical4android/build/reports/tests/testDebugUnitTest/\n"
        ),
        "if-no-files-found": "error",
        "retention-days": 14,
    },
}
JVM_VERIFY_INVOCATION = "python3 - <<'PY'"
JVM_REQUIRED_SKIP_TRACKING = "(skipped if case.find('skipped') is not None else executed).add(key)"
JVM_VERIFY_STEP = {
    "name": "Verify required ical4android tests executed",
    "if": UNLESS_CANCELLED,
    "run": "\n".join([
        JVM_VERIFY_INVOCATION,
        "import pathlib, sys",
        "import xml.etree.ElementTree as ET",
        "# Required methods must appear in the JUnit XML and must not be skipped.",
        "# Failures are already reported by the test step above.",
        "required = [",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_UtcTime'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_TwoTimesWithSameTimezone'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_TwoTimesWithDifferentTimezone'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_TwoTimesWithOneUtc'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_AllDayDateRDate_NewYork'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_AllDayDateExDate_NewYork'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_AllDayDtStartCarrier_NewYork'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_AllDayDate_PositiveOffset'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testRecurrenceSetsToAndroidString_AllDayFloatingDateTime_NewYork'),",
        "  ('at.bitfire.ical4android.AndroidTimeUtilsTest', 'testAndroidStringToRecurrenceSet_AllDayDate_ReadPath_NewYork'),",
        "]",
        "reports = sorted(pathlib.Path('ical4android/build/test-results/testDebugUnitTest').glob('TEST-*.xml'))",
        "if not reports:",
        "  print('::error::no ical4android JUnit XML reports were produced')",
        "  sys.exit(1)",
        "executed, skipped = set(), set()",
        "for report in reports:",
        "  for case in ET.parse(report).getroot().iter('testcase'):",
        "    key = (case.get('classname'), case.get('name'))",
        f"    {JVM_REQUIRED_SKIP_TRACKING}",
        "if not executed and not skipped:",
        "  print('::error::ical4android JUnit XML contains no test cases')",
        "  sys.exit(1)",
        "print(f'ical4android JUnit: {len(reports)} reports, {len(executed)} executed, {len(skipped)} skipped')",
        "problems = [f'{c}#{n} ' + ('skipped' if (c, n) in skipped else 'missing') for c, n in required if (c, n) not in executed]",
        "for problem in problems:",
        "  print(f'::error::required ical4android test {problem}')",
        "if problems:",
        "  sys.exit(1)",
        "PY",
    ]) + "\n",
}
JVM_EVIDENCE_STEPS = (JVM_TEST_STEP, JVM_UPLOAD_STEP, JVM_VERIFY_STEP)
DEBUG_STEP_VIOLATION = "build-pr: the debug unit-test step must appear exactly once"
JVM_TEST_VIOLATION = "build-pr: the full ical4android JVM suite must run unless cancelled right after the debug unit-test step"
JVM_UPLOAD_VIOLATION = "build-pr: ical4android JVM results must be uploaded unless cancelled and fail when missing"
JVM_VERIFY_VIOLATION = "build-pr: required ical4android JVM tests must be verified as executed and not skipped"
JVM_SUITE_ONCE_VIOLATION = "build-pr: the ical4android JVM suite must run in exactly one step"

PYTHON_PROVISIONING_VIOLATION = "build-pr: must not provision the static contract suite's Python environment"
DEDUP_VIOLATIONS = sorted(
    [
        "build-pr: must not repeat the static contract suite",
        "build-pr: must also need static-contracts",
        "build-pr: must run unless cancelled and fail closed on dependency results",
        "build-pr: missing dependency-result gate",
        PYTHON_PROVISIONING_VIOLATION,
    ]
)
GATE_KEYS_VIOLATION = "build-pr: dependency-result gate must have only name, env and run"
GATE_ENV_VIOLATION = "build-pr: dependency-result gate must bind exactly the three needs results"
GATE_PLACEMENT_VIOLATION = "build-pr: dependency-result gate must immediately follow checkout"
REPORT_CONDITION_VIOLATION = "build-pr: only the two report uploads may carry a step condition"
BUILD_PR_CONTINUE_VIOLATION = "build-pr: must not continue on error"

CONCURRENCY_VIOLATION = "concurrency: must cancel only superseded pull_request runs in workflow-and-PR groups"
EXPECTED_BASE_VIOLATIONS = sorted(
    [
        CONCURRENCY_VIOLATION,
        f"{STATIC_JOB}: missing early static job",
        f"{PRODUCER}: missing producer job",
        *(f"{job}: builds Etebase itself" for job in CONSUMERS),
        *(f"{job}: installs Rust" for job in CONSUMERS),
        *(f"{job}: must need conscrypt-r28 and etebase-16kb" for job in CONSUMERS),
        *(f"{job}: missing Etebase admission" for job in CONSUMERS),
        *DEDUP_VIOLATIONS,
    ]
)


def _run(step: dict) -> str:
    return str(step.get("run", ""))


def _uses(step: dict) -> str:
    return str(step.get("uses", ""))


def _index(steps: list, predicate):
    return next((index for index, step in enumerate(steps) if predicate(step)), None)


def _first_build(steps: list) -> int:
    found = _index(
        steps,
        lambda step: "./gradlew" in _run(step)
        or _uses(step).startswith("ReactiveCircus/android-emulator-runner@"),
    )
    return len(steps) if found is None else found


def _is_native_verify(step: dict) -> bool:
    return all(part in _run(step) for part in NATIVE_VERIFY)


def _needs(job: dict) -> list:
    needs = job.get("needs")
    return [needs] if isinstance(needs, str) else list(needs or [])


def _gate(job: dict):
    return next((step for step in job.get("steps") or [] if step.get("name") == GATE_NAME), None)


def _build_pr_gating_violations(job: dict) -> list[str]:
    violations = []
    steps = job.get("steps") or []
    if any(_run(step).strip() == STATIC_RUN for step in steps):
        violations.append("build-pr: must not repeat the static contract suite")
    if STATIC_JOB not in _needs(job):
        violations.append("build-pr: must also need static-contracts")
    if job.get("if") != BUILD_PR_IF:
        violations.append("build-pr: must run unless cancelled and fail closed on dependency results")
    gate = _gate(job)
    if gate is None:
        violations.append("build-pr: missing dependency-result gate")
    else:
        if set(gate) != {"name", "env", "run"}:
            violations.append(GATE_KEYS_VIOLATION)
        if gate.get("env") != GATE_ENV:
            violations.append(GATE_ENV_VIOLATION)
        checkout = _index(steps, lambda step: _uses(step).startswith("actions/checkout@"))
        if checkout is None or steps.index(gate) != checkout + 1:
            violations.append(GATE_PLACEMENT_VIOLATION)
    # The exact admitted JVM evidence steps run unless cancelled; jvm_evidence_violations
    # enforces their presence and position. Any other conditional step must be a report upload.
    conditional = [step for step in steps if "if" in step and step not in JVM_EVIDENCE_STEPS]
    if sorted(step.get("name") for step in conditional) != sorted(REPORT_UPLOAD_NAMES) or any(
        step.get("if") != "always()" or _uses(step) != UPLOAD or "run" in step for step in conditional
    ):
        violations.append(REPORT_CONDITION_VIOLATION)
    if "continue-on-error" in job or any("continue-on-error" in step for step in steps):
        violations.append(BUILD_PR_CONTINUE_VIOLATION)
    if any(_uses(step).startswith(SETUP_PYTHON) or "pip install" in _run(step) for step in steps):
        violations.append(PYTHON_PROVISIONING_VIOLATION)
    return violations


def ci_speed_violations(workflow: dict) -> list[str]:
    jobs = workflow.get("jobs") or {}
    violations = []

    if workflow.get("concurrency") != CONCURRENCY:
        violations.append(CONCURRENCY_VIOLATION)
    for name, job in jobs.items():
        if "concurrency" in job:
            violations.append(f"{name}: must not override concurrency")
        if name == PRODUCER:
            continue
        steps = job.get("steps") or []
        if any(BUILD_SCRIPT in _run(step) for step in steps):
            violations.append(f"{name}: builds Etebase itself")
        if any(_uses(step).startswith("dtolnay/rust-toolchain@") for step in steps):
            violations.append(f"{name}: installs Rust")

    static = jobs.get(STATIC_JOB)
    if static is None:
        violations.append(f"{STATIC_JOB}: missing early static job")
    else:
        if "needs" in static:
            violations.append(f"{STATIC_JOB}: must not depend on another job")
        if static.get("permissions") != {"contents": "read"} or "environment" in static:
            violations.append(f"{STATIC_JOB}: must be read-only")
        static_steps = static.get("steps") or []
        if any(step not in static_steps for step in (EXPECTED_PYTHON_SETUP, EXPECTED_DEPENDENCY_INSTALL, EXPECTED_STATIC_RUN_STEP)):
            violations.append(f"{STATIC_JOB}: must run the exact Android static contract suite")
        if "if" in static or any("if" in step for step in static_steps):
            violations.append(f"{STATIC_JOB}: must not be conditional")
        if "continue-on-error" in static or any("continue-on-error" in step for step in static_steps):
            violations.append(f"{STATIC_JOB}: must not continue on error")

    build_pr = jobs.get("build-pr")
    if build_pr is not None:
        violations.extend(_build_pr_gating_violations(build_pr))

    producer = jobs.get(PRODUCER)
    if producer is None:
        violations.append(f"{PRODUCER}: missing producer job")
    else:
        steps = producer.get("steps") or []
        if producer.get("needs") != "signing-policy":
            violations.append(f"{PRODUCER}: producer must need only signing-policy")
        if producer.get("permissions") != {"contents": "read"} or "environment" in producer:
            violations.append(f"{PRODUCER}: producer must be read-only")
        if not any(NDK in _run(step) for step in steps):
            violations.append(f"{PRODUCER}: producer must provision NDK r28")
        build = _index(steps, lambda step: _run(step).strip() == BUILD_SCRIPT)
        native = _index(steps, _is_native_verify)
        record = _index(steps, lambda step: _run(step).strip() == RECORD)
        upload = _index(steps, lambda step: _uses(step) == UPLOAD)
        if None in (build, native, record, upload) or not build < native < record < upload == len(steps) - 1:
            violations.append(f"{PRODUCER}: producer must build, verify, record, then upload last")
        last = steps[-1] if steps else {}
        if _uses(last) != UPLOAD or last.get("with") != UPLOAD_WITH:
            violations.append(f"{PRODUCER}: last step must be the pinned overwrite upload of the fixed staging folder")

    for name in CONSUMERS:
        job = jobs.get(name)
        if job is None:
            violations.append(f"{name}: missing consumer job")
            continue
        needs = set(_needs(job))
        # build-pr additionally needs the static job; that rule is checked with its gate.
        allowed = set(BUILD_PR_NEEDS) if name == "build-pr" else {"conscrypt-r28", PRODUCER}
        if not {"conscrypt-r28", PRODUCER} <= needs or not needs <= allowed:
            violations.append(f"{name}: must need conscrypt-r28 and etebase-16kb")
        steps = job.get("steps") or []
        first = _first_build(steps)
        download = _index(
            steps, lambda step: _uses(step) == DOWNLOAD and step.get("with") == {"name": ARTIFACT, "path": STAGING}
        )
        admit = _index(steps, lambda step: _run(step).strip() == ADMIT)
        native = _index(steps, _is_native_verify)
        if download is None or admit is None:
            violations.append(f"{name}: missing Etebase admission")
        elif native is None:
            violations.append(f"{name}: missing consumer 16 KB verification")
        elif not download < admit < native < first:
            violations.append(f"{name}: Etebase admission after first Gradle or emulator step")
        if not any(NDK in _run(step) for step in steps[:first]):
            violations.append(f"{name}: NDK provisioning removed")
    return sorted(violations)


def jvm_evidence_violations(workflow: dict) -> list[str]:
    """The admitted ical4android JVM evidence steps, exact and in order, right after the debug step."""
    steps = ((workflow.get("jobs") or {}).get("build-pr") or {}).get("steps") or []
    debug = [index for index, step in enumerate(steps) if step.get("name") == DEBUG_STEP_NAME]
    if len(debug) != 1:
        return [DEBUG_STEP_VIOLATION]
    following = steps[debug[0] + 1 : debug[0] + 1 + len(JVM_EVIDENCE_STEPS)]
    violations = [
        message
        for offset, (expected, message) in enumerate(
            zip(JVM_EVIDENCE_STEPS, (JVM_TEST_VIOLATION, JVM_UPLOAD_VIOLATION, JVM_VERIFY_VIOLATION))
        )
        if offset >= len(following) or following[offset] != expected
    ]
    if sum(JVM_SUITE_TASK in _run(step) for step in steps) != 1:
        violations.append(JVM_SUITE_ONCE_VIOLATION)
    return sorted(violations)


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _triggers(workflow: dict):
    # PyYAML reads the bare `on` key as boolean True.
    return workflow.get("on", workflow.get(True))


def _without_native_compile(job: dict) -> dict:
    """The predecessor consumer minus only its Rust toolchain and Etebase compile."""
    job = copy.deepcopy(job)
    steps = []
    for step in job.get("steps") or []:
        if _uses(step).startswith("dtolnay/rust-toolchain@"):
            continue
        run = step.get("run")
        if isinstance(run, str) and BUILD_SCRIPT in run:
            kept = "".join(line for line in run.splitlines(keepends=True) if line.strip() != BUILD_SCRIPT)
            if not kept.strip():
                continue
            step = dict(step, run=kept)
            if step.get("name") == "Make gradlew executable and build native client":
                step["name"] = "Make gradlew executable"
        steps.append(step)
    job["steps"] = steps
    job.pop("needs", None)
    return job


def _without_admission(job: dict) -> dict:
    job = copy.deepcopy(job)
    job["steps"] = [step for step in job.get("steps") or [] if step.get("name") not in ADMISSION_STEP_NAMES]
    job.pop("needs", None)
    return job


# The one approved change since both predecessors (#898): the focused runtime ledger grew from 172 to
# 179 methods, the seven new ones owned by a new fresh-emulator API 36 launcher-recovery shard that API 29
# runs with its account-dashboard shard. Only the matrix row after API 36 first-run-setup and these four
# exact lines of the runtime job's final assertion are carried forward; every other byte must still match.
RUNTIME_LEDGER_JOB = "account-recreation-runtime"
RUNTIME_LEDGER_MATRIX_ANCHOR = {"api-level": 36, "arch": "x86_64", "shard": "first-run-setup"}
RUNTIME_LEDGER_MATRIX_ROW = {"api-level": 36, "arch": "x86_64", "shard": "launcher-recovery"}
RUNTIME_LEDGER_COUNT_LINES = (
    (
        "expected_sizes={'29:mixed':1,'29:account-dashboard':32,'29:first-run-setup':19,'29:status-routes':72,'29:sibling-routes':48,'35:all':172,'36:account-dashboard':33,'36:first-run-setup':19,'36:sibling-routes':48,'36:status-routes':72}\n",
        "expected_sizes={'29:mixed':1,'29:account-dashboard':39,'29:first-run-setup':19,'29:status-routes':72,'29:sibling-routes':48,'35:all':179,'36:account-dashboard':33,'36:first-run-setup':19,'36:launcher-recovery':7,'36:sibling-routes':48,'36:status-routes':72}\n",
    ),
    (
        "if len(canonical) != 172 or len(expected) != expected_sizes[key]:\n",
        "if len(canonical) != 179 or len(expected) != expected_sizes[key]:\n",
    ),
    (
        "'29:account-dashboard':owned('36:account-dashboard')-mixed,\n",
        "'29:account-dashboard':(owned('36:account-dashboard')|owned('36:launcher-recovery'))-mixed,\n",
    ),
    (
        "elif key in {'36:account-dashboard','36:first-run-setup','36:sibling-routes','36:status-routes'}:\n",
        "elif key in {'36:account-dashboard','36:first-run-setup','36:launcher-recovery','36:sibling-routes','36:status-routes'}:\n",
    ),
)


def _with_approved_runtime_ledger_changes(job: dict) -> dict:
    """A predecessor runtime job with only the approved matrix row and ledger lines applied, each exactly once."""
    job = copy.deepcopy(job)
    include = job["strategy"]["matrix"]["include"]
    assert include.count(RUNTIME_LEDGER_MATRIX_ANCHOR) == 1 and RUNTIME_LEDGER_MATRIX_ROW not in include
    include.insert(include.index(RUNTIME_LEDGER_MATRIX_ANCHOR) + 1, dict(RUNTIME_LEDGER_MATRIX_ROW))
    owners = [
        step for step in job.get("steps") or []
        if isinstance(step.get("run"), str) and RUNTIME_LEDGER_COUNT_LINES[0][0] in step["run"]
    ]
    assert len(owners) == 1, "exactly one predecessor step must own the runtime ledger counts"
    run = owners[0]["run"]
    for old, new in RUNTIME_LEDGER_COUNT_LINES:
        assert run.count(old) == 1 and new not in run, old
        run = run.replace(old, new)
    owners[0]["run"] = run
    return job


def _without_static_dedup(job: dict) -> dict:
    """build-pr minus the gating edits: its condition, gate and repeated static suite."""
    job = copy.deepcopy(job)
    job["steps"] = [
        step
        for step in job.get("steps") or []
        if step.get("name") != GATE_NAME and _run(step).strip() != STATIC_RUN
    ]
    job.pop("if", None)
    job.pop("needs", None)
    return job


def _without_static_provisioning(job: dict) -> dict:
    """A predecessor build-pr minus exactly its static-suite Python setup and install."""
    job = copy.deepcopy(job)
    steps = job.get("steps") or []
    for expected in STATIC_PROVISIONING:
        assert steps.count(expected) == 1, f"predecessor build-pr must contain {expected['name']!r} exactly once"
    job["steps"] = [step for step in steps if step not in STATIC_PROVISIONING]
    return job


def _with_approved_jvm_evidence(job: dict) -> dict:
    """A predecessor build-pr with exactly the admitted JVM evidence steps inserted, once,
    immediately after its unchanged debug unit-test step."""
    job = copy.deepcopy(job)
    steps = job.get("steps") or []
    debug = [index for index, step in enumerate(steps) if step.get("name") == DEBUG_STEP_NAME]
    assert len(debug) == 1, f"predecessor build-pr must contain {DEBUG_STEP_NAME!r} exactly once"
    assert not any(step in steps for step in JVM_EVIDENCE_STEPS), "the JVM evidence transport applies once"
    steps[debug[0] + 1 : debug[0] + 1] = copy.deepcopy(list(JVM_EVIDENCE_STEPS))
    job["steps"] = steps
    return job


def _python_invocations(job: dict) -> list[str]:
    """Every operative run line, comments aside, that invokes a Python interpreter."""
    return [
        line.strip()
        for step in job.get("steps") or []
        for line in _run(step).splitlines()
        if not line.strip().startswith("#")
        and any(token.rstrip("0123456789.") == "python" for token in line.split())
    ]


def _expected_build_pr(predecessor_job: dict, gate_run: str) -> dict:
    """The 8cb81b42 build-pr with exactly the admitted edits applied: needs, if, the
    gate, the removed static suite with its Python setup and install, and the JVM evidence."""
    job = _with_approved_jvm_evidence(_without_static_provisioning(predecessor_job))
    job["needs"] = list(BUILD_PR_NEEDS)
    job["if"] = BUILD_PR_IF
    steps = [step for step in job["steps"] if _run(step).strip() != STATIC_RUN]
    checkout = _index(steps, lambda step: _uses(step).startswith("actions/checkout@"))
    assert checkout is not None, "8cb81b42 build-pr must check out first"
    steps.insert(checkout + 1, {"name": GATE_NAME, "env": dict(GATE_ENV), "run": gate_run})
    job["steps"] = steps
    return job


def _gate_run(workflow: dict) -> str:
    job = (workflow.get("jobs") or {}).get("build-pr") or {}
    gate = _gate(job)
    assert gate is not None, f"build-pr: dependency-result gate {GATE_NAME!r} is missing"
    run = gate.get("run")
    assert isinstance(run, str) and run.strip(), "build-pr: dependency-result gate has no run script"
    return run


@pytest.fixture(scope="module")
def base() -> dict:
    assert hashlib.sha256(BASE_FIXTURE.read_bytes()).hexdigest() == BASE_FIXTURE_SHA256
    return _load(BASE_FIXTURE)


@pytest.fixture(scope="module")
def predecessor() -> dict:
    assert hashlib.sha256(PREDECESSOR_FIXTURE.read_bytes()).hexdigest() == PREDECESSOR_FIXTURE_SHA256
    return _load(PREDECESSOR_FIXTURE)


@pytest.fixture(scope="module")
def candidate() -> dict:
    return _load(WORKFLOW)


def test_predecessor_workflow_is_rejected_with_exactly_the_expected_violations(base):
    assert ci_speed_violations(base) == EXPECTED_BASE_VIOLATIONS


def test_immediate_predecessor_is_rejected_only_for_the_repeated_static_suite(predecessor):
    assert ci_speed_violations(predecessor) == DEDUP_VIOLATIONS


def test_candidate_workflow_satisfies_every_speed_contract(candidate):
    assert ci_speed_violations(candidate) == []


def test_candidate_changes_nothing_else_relative_to_the_predecessor(base, candidate):
    assert candidate["name"] == base["name"]
    assert _triggers(candidate) == _triggers(base)
    assert set(candidate["jobs"]) == set(base["jobs"]) | {STATIC_JOB, PRODUCER}
    for name in UNCHANGED_JOBS:
        assert candidate["jobs"][name] == base["jobs"][name], name
    # Consumers lose only the Rust toolchain and the Etebase compile, and gain only
    # the admission steps: NDK, build-tools, JDKs, matrices, runtime scripts,
    # ledgers, producer manifests and every final gate are otherwise identical.
    # build-pr additionally differs only by its static-suite gating, by dropping
    # the suite's Python setup and install, and by the exact JVM evidence steps.
    for name in CONSUMERS:
        current = _without_admission(candidate["jobs"][name])
        original = _without_native_compile(base["jobs"][name])
        if name == RUNTIME_LEDGER_JOB:
            original = _with_approved_runtime_ledger_changes(original)
        if name == "build-pr":
            current = _without_static_dedup(current)
            original = _with_approved_jvm_evidence(_without_static_provisioning(_without_static_dedup(original)))
        assert current == original, name


def test_candidate_changes_only_build_pr_gating_relative_to_8cb81b42(predecessor, candidate):
    assert {key: value for key, value in candidate.items() if key != "jobs"} == {
        key: value for key, value in predecessor.items() if key != "jobs"
    }
    assert set(candidate["jobs"]) == set(predecessor["jobs"])
    for name, job in predecessor["jobs"].items():
        if name == RUNTIME_LEDGER_JOB:
            job = _with_approved_runtime_ledger_changes(job)
        if name != "build-pr":
            assert candidate["jobs"][name] == job, name
    expected = _expected_build_pr(predecessor["jobs"]["build-pr"], _gate_run(candidate))
    assert candidate["jobs"]["build-pr"] == expected, (
        "build-pr may differ from 8cb81b42 only by needs, if, the dependency-result gate, "
        "the removed static suite with its Python setup and install, and the exact JVM evidence steps"
    )


def test_runtime_ledger_count_transport_admits_only_the_approved_lines(predecessor, candidate):
    carried = _with_approved_runtime_ledger_changes(predecessor["jobs"][RUNTIME_LEDGER_JOB])
    current = candidate["jobs"][RUNTIME_LEDGER_JOB]
    assert carried == current
    # The transport applies once, to the old lines only.
    with pytest.raises(AssertionError):
        _with_approved_runtime_ledger_changes(current)
    # Any other change to the same step, including another count, still fails the comparison.
    for old, new in (
        ("raise SystemExit(f'missing {sorted(missing)}')", "raise SystemExit('missing')"),
        ("'36:account-dashboard':33", "'36:account-dashboard':34"),
        ("'36:launcher-recovery':7", "'36:launcher-recovery':8"),
        ("if len(canonical) != 179 or", "if len(canonical) < 179 or"),
        ("|owned('36:launcher-recovery'))-mixed", ")-mixed"),
    ):
        mutated = copy.deepcopy(current)
        owners = [step for step in mutated["steps"] if isinstance(step.get("run"), str) and old in step["run"]]
        assert len(owners) == 1 and owners[0]["run"].count(old) == 1, old
        owners[0]["run"] = owners[0]["run"].replace(old, new)
        assert carried != mutated, old
    # Any other matrix change, such as moving the new row or giving it a navigation mode, still fails.
    include = current["strategy"]["matrix"]["include"]
    row = include.index(RUNTIME_LEDGER_MATRIX_ROW)
    moved = copy.deepcopy(current)
    moved["strategy"]["matrix"]["include"].append(moved["strategy"]["matrix"]["include"].pop(row))
    assert carried != moved
    navigated = copy.deepcopy(current)
    navigated["strategy"]["matrix"]["include"][row]["navigation-mode"] = 0
    assert carried != navigated


def test_static_job_runs_the_suite_build_pr_ran_before(predecessor, candidate):
    static = candidate["jobs"][STATIC_JOB]
    previous = predecessor["jobs"]["build-pr"]["steps"]
    for expected in (EXPECTED_PYTHON_SETUP, EXPECTED_DEPENDENCY_INSTALL, EXPECTED_STATIC_RUN_STEP):
        assert expected in previous, expected["name"]
        assert expected in static["steps"], expected["name"]
    assert static["defaults"] == {"run": {"working-directory": "android"}}
    assert predecessor["jobs"]["build-pr"]["defaults"] == static["defaults"]
    assert "needs" not in static and "if" not in static


def test_dependency_gate_is_exactly_specified(candidate):
    job = candidate["jobs"]["build-pr"]
    gate = _gate(job)
    assert gate is not None, f"build-pr: dependency-result gate {GATE_NAME!r} is missing"
    assert set(gate) == {"name", "env", "run"}, sorted(gate)
    assert gate["env"] == GATE_ENV
    assert job["steps"].index(gate) == 1 and _uses(job["steps"][0]).startswith("actions/checkout@")
    assert _needs(job) == BUILD_PR_NEEDS
    assert job["if"] == BUILD_PR_IF


def test_build_pr_uses_the_preinstalled_python_strategy(candidate):
    """build-pr sets up no Python and installs no packages; its helpers run as
    `python3 scripts/...` on the runner's preinstalled interpreter. The one other
    invocation is the exact admitted inline JVM-evidence verifier on that same
    python3, which uses only the standard library. This does not pin or prove one
    interpreter version: hosted CI must run every helper."""
    job = candidate["jobs"]["build-pr"]
    steps = job["steps"]
    assert [step.get("name") for step in steps if _uses(step).startswith(SETUP_PYTHON)] == []
    operative = [
        line.strip()
        for step in steps
        for line in _run(step).splitlines()
        if not line.strip().startswith("#")
    ]
    assert [line for line in operative if any(marker in line for marker in STATIC_PROVISIONING_MARKERS)] == []
    assert steps.count(JVM_VERIFY_STEP) == 1
    assert _python_invocations({"steps": [JVM_VERIFY_STEP]}) == [JVM_VERIFY_INVOCATION]
    invocations = _python_invocations({**job, "steps": [step for step in steps if step != JVM_VERIFY_STEP]})
    assert invocations and all(line.startswith("python3 scripts/") for line in invocations), invocations


def test_release_unsigned_build_shares_the_preinstalled_python_strategy():
    """The same strategy as build-pr, not a guarantee of the same interpreter version."""
    job = _load(RELEASE_WORKFLOW)["jobs"]["build-unsigned-release"]
    assert [
        step.get("name")
        for step in job["steps"]
        if _uses(step).startswith(SETUP_PYTHON) or "pip install" in _run(step)
    ] == []
    invocations = _python_invocations(job)
    assert invocations and all(line.startswith("python3 scripts/") for line in invocations), invocations


def test_only_report_uploads_and_jvm_evidence_are_conditional_in_build_pr(candidate):
    conditional = [step for step in candidate["jobs"]["build-pr"]["steps"] if "if" in step]
    reports = [step for step in conditional if step not in JVM_EVIDENCE_STEPS]
    assert sorted(step["name"] for step in reports) == sorted(REPORT_UPLOAD_NAMES)
    for step in reports:
        assert step["if"] == "always()", step["name"]
        assert _uses(step) == UPLOAD and "run" not in step, step["name"]
    assert [step for step in conditional if step in JVM_EVIDENCE_STEPS] == list(JVM_EVIDENCE_STEPS)


def test_candidate_runs_the_exact_ical4android_jvm_evidence(candidate):
    assert jvm_evidence_violations(candidate) == []


def test_predecessors_lack_the_ical4android_jvm_evidence(base, predecessor):
    # The evidence is new in CI-A0; the frozen predecessor fixtures must not already satisfy it.
    for workflow in (base, predecessor):
        assert JVM_TEST_VIOLATION in jvm_evidence_violations(workflow)
        assert JVM_SUITE_ONCE_VIOLATION in jvm_evidence_violations(workflow)


def _execute_gate(script: str, results: dict, cwd: Path) -> subprocess.CompletedProcess:
    bash = shutil.which("bash")
    assert bash is not None, "bash is required to execute the gate script"
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    env.update({key: value for key, value in results.items() if value is not None})
    # GitHub runs an unconfigured `run` step as `bash -e {0}`.
    return subprocess.run(
        [bash, "-e", "-c", script], cwd=cwd, env=env, capture_output=True, text=True, timeout=30, check=False
    )


def test_gate_script_admits_three_successful_dependencies(candidate, tmp_path):
    result = _execute_gate(_gate_run(candidate), {key: "success" for key in GATE_ENV}, tmp_path)
    assert result.returncode == 0, result.stdout + result.stderr


NON_SUCCESS = ("failure", "skipped", "cancelled", "", "Success", "SUCCESS", "success ", None)


@pytest.mark.parametrize("variable", sorted(GATE_ENV))
@pytest.mark.parametrize("value", NON_SUCCESS, ids=lambda value: "unset" if value is None else repr(value))
def test_gate_script_rejects_any_non_successful_dependency(candidate, tmp_path, variable, value):
    results = {key: "success" for key in GATE_ENV}
    results[variable] = value
    result = _execute_gate(_gate_run(candidate), results, tmp_path)
    assert result.returncode != 0, f"{variable}={value!r} must fail the gate"


def _step_named(job: dict, name: str) -> dict:
    return next(step for step in job["steps"] if step.get("name") == name)


def _remove_step(job: dict, predicate) -> None:
    job["steps"] = [step for step in job["steps"] if not predicate(step)]


def _move_to_end(job: dict, name: str) -> None:
    step = _step_named(job, name)
    job["steps"].remove(step)
    job["steps"].append(step)


def _mutation(workflow: dict, case: str) -> None:
    jobs = workflow["jobs"]
    if case == "remove-admission":
        _remove_step(jobs["account-recreation-runtime"], lambda step: step.get("name") == ADMISSION_STEP_NAMES[1])
    elif case == "remove-download":
        _remove_step(jobs["registry-process-boundary"], lambda step: step.get("name") == ADMISSION_STEP_NAMES[0])
    elif case == "reorder-admission":
        _move_to_end(jobs["color-parity-evidence"], ADMISSION_STEP_NAMES[1])
    elif case == "reorder-native-verify":
        _move_to_end(jobs["build-pr"], ADMISSION_STEP_NAMES[2])
    elif case == "remove-native-verify":
        _remove_step(jobs["registry-process-boundary"], lambda step: step.get("name") == ADMISSION_STEP_NAMES[2])
    elif case == "remove-ndk":
        _remove_step(jobs["build-pr"], lambda step: NDK in _run(step))
    elif case == "rebuild-etebase":
        jobs["account-recreation-runtime"]["steps"].insert(0, {"name": "Rebuild", "run": BUILD_SCRIPT})
    elif case == "consumer-skips-producer":
        jobs["color-parity-evidence"]["needs"] = "conscrypt-r28"
    elif case == "cancel-every-event":
        workflow["concurrency"]["cancel-in-progress"] = True
    elif case == "non-unique-push-group":
        workflow["concurrency"]["group"] = "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
    elif case == "job-level-concurrency":
        jobs["build-pr"]["concurrency"] = {"group": "x", "cancel-in-progress": True}
    elif case == "upload-without-overwrite":
        jobs[PRODUCER]["steps"][-1]["with"]["overwrite"] = False
    elif case == "upload-not-last":
        jobs[PRODUCER]["steps"].append({"name": "After upload", "run": "true"})
    elif case == "producer-needs-conscrypt":
        jobs[PRODUCER]["needs"] = ["signing-policy", "conscrypt-r28"]
    elif case == "static-job-waits":
        jobs[STATIC_JOB]["needs"] = "conscrypt-r28"
    elif case == "static-job-conditional":
        jobs[STATIC_JOB]["if"] = "${{ false }}"
    elif case == "static-job-continue-on-error":
        _step_named(jobs[STATIC_JOB], EXPECTED_STATIC_RUN_STEP["name"])["continue-on-error"] = True
    elif case == "static-job-drops-suite":
        _remove_step(jobs[STATIC_JOB], lambda step: _run(step).strip() == STATIC_RUN)
    elif case == "build-pr-repeats-static-suite":
        jobs["build-pr"]["steps"].append(dict(EXPECTED_STATIC_RUN_STEP))
    elif case == "build-pr-drops-static-need":
        jobs["build-pr"]["needs"] = ["conscrypt-r28", PRODUCER]
    elif case == "build-pr-plain-event-condition":
        jobs["build-pr"]["if"] = EVENT_CONDITION
    elif case == "build-pr-always-condition":
        jobs["build-pr"]["if"] = f"${{{{ always() && ({EVENT_CONDITION}) }}}}"
    elif case == "build-pr-sets-up-python":
        steps = jobs["build-pr"]["steps"]
        steps.insert(steps.index(_step_named(jobs["build-pr"], GATE_NAME)) + 1, copy.deepcopy(EXPECTED_PYTHON_SETUP))
    elif case == "build-pr-installs-static-dependencies":
        jobs["build-pr"]["steps"].append(copy.deepcopy(EXPECTED_DEPENDENCY_INSTALL))
    elif case == "build-pr-job-continue-on-error":
        jobs["build-pr"]["continue-on-error"] = True
    elif case == "gate-removed":
        _remove_step(jobs["build-pr"], lambda step: step.get("name") == GATE_NAME)
    elif case == "gate-after-download":
        steps = jobs["build-pr"]["steps"]
        gate = _step_named(jobs["build-pr"], GATE_NAME)
        steps.remove(gate)
        steps.insert(_index(steps, lambda step: _uses(step) == DOWNLOAD) + 1, gate)
    elif case == "gate-after-gradle":
        _move_to_end(jobs["build-pr"], GATE_NAME)
    elif case == "gate-continue-on-error":
        _step_named(jobs["build-pr"], GATE_NAME)["continue-on-error"] = True
    elif case == "gate-if-false":
        _step_named(jobs["build-pr"], GATE_NAME)["if"] = "${{ false }}"
    elif case == "gate-if-always":
        _step_named(jobs["build-pr"], GATE_NAME)["if"] = "always()"
    elif case == "gate-shell-override":
        _step_named(jobs["build-pr"], GATE_NAME)["shell"] = "sh"
    elif case == "gate-swapped-bindings":
        env = _step_named(jobs["build-pr"], GATE_NAME)["env"]
        env["STATIC_RESULT"], env["CONSCRYPT_RESULT"] = env["CONSCRYPT_RESULT"], env["STATIC_RESULT"]
    elif case == "gate-literal-success":
        _step_named(jobs["build-pr"], GATE_NAME)["env"]["STATIC_RESULT"] = "success"
    elif case == "gate-outcome-not-result":
        _step_named(jobs["build-pr"], GATE_NAME)["env"]["ETEBASE_RESULT"] = "${{ needs.etebase-16kb.outcome }}"
    elif case == "gate-missing-binding":
        del _step_named(jobs["build-pr"], GATE_NAME)["env"]["CONSCRYPT_RESULT"]
    elif case == "extra-conditional-step":
        _step_named(jobs["build-pr"], "Make gradlew executable")["if"] = "always()"
    elif case == "report-upload-condition-changed":
        _step_named(jobs["build-pr"], REPORT_UPLOAD_NAMES[0])["if"] = "success()"
    elif case == "jvm-test-condition-always":
        _step_named(jobs["build-pr"], JVM_TEST_STEP["name"])["if"] = "always()"
    elif case == "jvm-verify-continue-on-error":
        _step_named(jobs["build-pr"], JVM_VERIFY_STEP["name"])["continue-on-error"] = True
    else:
        raise AssertionError(case)


MUTATIONS = {
    "remove-admission": "account-recreation-runtime: missing Etebase admission",
    "remove-download": "registry-process-boundary: missing Etebase admission",
    "reorder-admission": "color-parity-evidence: Etebase admission after first Gradle or emulator step",
    "reorder-native-verify": "build-pr: Etebase admission after first Gradle or emulator step",
    "remove-native-verify": "registry-process-boundary: missing consumer 16 KB verification",
    "remove-ndk": "build-pr: NDK provisioning removed",
    "rebuild-etebase": "account-recreation-runtime: builds Etebase itself",
    "consumer-skips-producer": "color-parity-evidence: must need conscrypt-r28 and etebase-16kb",
    "cancel-every-event": CONCURRENCY_VIOLATION,
    "non-unique-push-group": CONCURRENCY_VIOLATION,
    "job-level-concurrency": "build-pr: must not override concurrency",
    "upload-without-overwrite": f"{PRODUCER}: last step must be the pinned overwrite upload of the fixed staging folder",
    "upload-not-last": f"{PRODUCER}: producer must build, verify, record, then upload last",
    "producer-needs-conscrypt": f"{PRODUCER}: producer must need only signing-policy",
    "static-job-waits": f"{STATIC_JOB}: must not depend on another job",
    "static-job-conditional": f"{STATIC_JOB}: must not be conditional",
    "static-job-continue-on-error": f"{STATIC_JOB}: must not continue on error",
    "static-job-drops-suite": f"{STATIC_JOB}: must run the exact Android static contract suite",
    "build-pr-repeats-static-suite": "build-pr: must not repeat the static contract suite",
    "build-pr-drops-static-need": "build-pr: must also need static-contracts",
    "build-pr-plain-event-condition": "build-pr: must run unless cancelled and fail closed on dependency results",
    "build-pr-always-condition": "build-pr: must run unless cancelled and fail closed on dependency results",
    "build-pr-sets-up-python": PYTHON_PROVISIONING_VIOLATION,
    "build-pr-installs-static-dependencies": PYTHON_PROVISIONING_VIOLATION,
    "build-pr-job-continue-on-error": BUILD_PR_CONTINUE_VIOLATION,
    "gate-removed": "build-pr: missing dependency-result gate",
    "gate-after-download": GATE_PLACEMENT_VIOLATION,
    "gate-after-gradle": GATE_PLACEMENT_VIOLATION,
    "gate-continue-on-error": GATE_KEYS_VIOLATION,
    "gate-if-false": GATE_KEYS_VIOLATION,
    "gate-if-always": GATE_KEYS_VIOLATION,
    "gate-shell-override": GATE_KEYS_VIOLATION,
    "gate-swapped-bindings": GATE_ENV_VIOLATION,
    "gate-literal-success": GATE_ENV_VIOLATION,
    "gate-outcome-not-result": GATE_ENV_VIOLATION,
    "gate-missing-binding": GATE_ENV_VIOLATION,
    "extra-conditional-step": REPORT_CONDITION_VIOLATION,
    "report-upload-condition-changed": REPORT_CONDITION_VIOLATION,
    "jvm-test-condition-always": REPORT_CONDITION_VIOLATION,
    "jvm-verify-continue-on-error": BUILD_PR_CONTINUE_VIOLATION,
}


@pytest.mark.parametrize(("case", "expected"), MUTATIONS.items(), ids=MUTATIONS.keys())
def test_candidate_mutations_are_rejected(candidate, case, expected):
    assert ci_speed_violations(candidate) == [], (
        "the unmutated candidate must be clean for this mutation to be meaningful"
    )
    mutated = copy.deepcopy(candidate)
    _mutation(mutated, case)
    assert expected in ci_speed_violations(mutated)


def _replace_in_step(job: dict, name: str, key: str, old: str, new: str) -> None:
    step = _step_named(job, name)
    assert step[key].count(old) == 1, (name, old)
    step[key] = step[key].replace(old, new)


def _jvm_mutation(workflow: dict, case: str) -> None:
    job = workflow["jobs"]["build-pr"]
    if case == "debug-step-removed":
        _remove_step(job, lambda step: step.get("name") == DEBUG_STEP_NAME)
    elif case == "jvm-test-removed":
        _remove_step(job, lambda step: step.get("name") == JVM_TEST_STEP["name"])
    elif case == "jvm-test-filtered":
        _replace_in_step(job, JVM_TEST_STEP["name"], "run", JVM_SUITE_TASK, f"{JVM_SUITE_TASK} --tests at.bitfire.ical4android.AndroidTimeUtilsTest")
    elif case == "jvm-test-stops-at-first-failure":
        _replace_in_step(job, JVM_TEST_STEP["name"], "run", " --continue", "")
    elif case == "jvm-test-skipped-after-failure":
        del _step_named(job, JVM_TEST_STEP["name"])["if"]
    elif case == "jvm-test-disabled":
        _step_named(job, JVM_TEST_STEP["name"])["if"] = "${{ false }}"
    elif case == "jvm-test-continue-on-error":
        _step_named(job, JVM_TEST_STEP["name"])["continue-on-error"] = True
    elif case == "jvm-test-before-debug-step":
        step = _step_named(job, JVM_TEST_STEP["name"])
        job["steps"].remove(step)
        job["steps"].insert(job["steps"].index(_step_named(job, DEBUG_STEP_NAME)), step)
    elif case == "jvm-suite-repeated-filtered":
        job["steps"].append({"name": "Extra filtered ical4android run", "run": f"./gradlew {JVM_SUITE_TASK} --tests 'at.bitfire.*'"})
    elif case == "jvm-upload-removed":
        _remove_step(job, lambda step: step.get("name") == JVM_UPLOAD_STEP["name"])
    elif case == "jvm-upload-skipped-after-failure":
        del _step_named(job, JVM_UPLOAD_STEP["name"])["if"]
    elif case == "jvm-upload-tolerates-missing-results":
        _step_named(job, JVM_UPLOAD_STEP["name"])["with"]["if-no-files-found"] = "warn"
    elif case == "jvm-upload-drops-junit-xml":
        upload = _step_named(job, JVM_UPLOAD_STEP["name"])["with"]
        assert upload["path"].count("android/ical4android/build/test-results/testDebugUnitTest/\n") == 1
        upload["path"] = upload["path"].replace("android/ical4android/build/test-results/testDebugUnitTest/\n", "")
    elif case == "jvm-verify-removed":
        _remove_step(job, lambda step: step.get("name") == JVM_VERIFY_STEP["name"])
    elif case == "jvm-verify-skipped-after-failure":
        del _step_named(job, JVM_VERIFY_STEP["name"])["if"]
    elif case == "jvm-verify-requires-nothing":
        step = _step_named(job, JVM_VERIFY_STEP["name"])
        start = step["run"].index("required = [\n")
        end = step["run"].index("]\n", start) + 2
        step["run"] = step["run"][:start] + "required = []\n" + step["run"][end:]
    elif case == "jvm-verify-counts-skipped-as-executed":
        _replace_in_step(job, JVM_VERIFY_STEP["name"], "run", JVM_REQUIRED_SKIP_TRACKING, "executed.add(key)")
    elif case == "jvm-verify-accepts-missing-reports":
        _replace_in_step(job, JVM_VERIFY_STEP["name"], "run", "  print('::error::no ical4android JUnit XML reports were produced')\n  sys.exit(1)\n", "  pass\n")
    else:
        raise AssertionError(case)


JVM_MUTATIONS = {
    "debug-step-removed": DEBUG_STEP_VIOLATION,
    "jvm-test-removed": JVM_TEST_VIOLATION,
    "jvm-test-filtered": JVM_TEST_VIOLATION,
    "jvm-test-stops-at-first-failure": JVM_TEST_VIOLATION,
    "jvm-test-skipped-after-failure": JVM_TEST_VIOLATION,
    "jvm-test-disabled": JVM_TEST_VIOLATION,
    "jvm-test-continue-on-error": JVM_TEST_VIOLATION,
    "jvm-test-before-debug-step": JVM_TEST_VIOLATION,
    "jvm-suite-repeated-filtered": JVM_SUITE_ONCE_VIOLATION,
    "jvm-upload-removed": JVM_UPLOAD_VIOLATION,
    "jvm-upload-skipped-after-failure": JVM_UPLOAD_VIOLATION,
    "jvm-upload-tolerates-missing-results": JVM_UPLOAD_VIOLATION,
    "jvm-upload-drops-junit-xml": JVM_UPLOAD_VIOLATION,
    "jvm-verify-removed": JVM_VERIFY_VIOLATION,
    "jvm-verify-skipped-after-failure": JVM_VERIFY_VIOLATION,
    "jvm-verify-requires-nothing": JVM_VERIFY_VIOLATION,
    "jvm-verify-counts-skipped-as-executed": JVM_VERIFY_VIOLATION,
    "jvm-verify-accepts-missing-reports": JVM_VERIFY_VIOLATION,
}


@pytest.mark.parametrize(("case", "expected"), JVM_MUTATIONS.items(), ids=JVM_MUTATIONS.keys())
def test_jvm_evidence_mutations_are_rejected(candidate, case, expected):
    assert jvm_evidence_violations(candidate) == [], (
        "the unmutated candidate must be clean for this mutation to be meaningful"
    )
    mutated = copy.deepcopy(candidate)
    _jvm_mutation(mutated, case)
    assert expected in jvm_evidence_violations(mutated)
