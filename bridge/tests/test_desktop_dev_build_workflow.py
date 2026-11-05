"""S2 (#171) development-artifact workflow contracts, static.

Contract (s2-delivery-plan-v8):
- .github/workflows/test-bridge-desktop-dev.yml (S2-F) is receipts only, pushes
  only on the feature branch and its listed inputs, is reusable, and runs the
  existing root permission-subset test with its existing setup;
- the five existing callees become reusable at the caller's SHA. A callee that
  uploads anything other than receipts (the Linux CLI binary today) skips only
  that upload step for this development candidate: when the typed input
  ``suppress_cli_artifact_upload`` is true (the dev caller), and for any
  standalone run on the development branch (a pull request from it, or a
  dispatch on it). Tests, build and smokes still run; uploads elsewhere (main
  pushes, other branches' pull requests and dispatches) are unchanged;
- the shared desktop callees use a concurrency group carrying ``inputs.caller``,
  so a called run and a standalone run on the same push never cancel each other;
- the later caller .github/workflows/build-bridge-desktop-dev.yml triggers on
  every artifact input, requires every callee at the same SHA, and uploads source
  materials, then binaries, only after every gate.

Missing future inputs are explicit RED cases. Cases that depend on them are
NOT REACHED (fixture setup errors), never import or collection errors.
Runs only where SILENTSUITE_REQUIRE_DESKTOP_DEV=1 (test-bridge-desktop-dev.yml).
"""

import os
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
WORKFLOWS = REPO / ".github" / "workflows"
BRANCH = "feat/bridge-gui-171"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_DEV"

DEV_CALLEE = "test-bridge-desktop-dev.yml"
CALLER = "build-bridge-desktop-dev.yml"
CALLER_NAME = "build-bridge-desktop-dev"
REQUIRED_CALLEES = (
    "test-bridge-linux.yml",
    "test-bridge-windows.yml",
    "test-bridge-macos.yml",
    "test-bridge-desktop.yml",
    "test-bridge-desktop-frozen.yml",
)
SHARED_CONCURRENCY_CALLEES = ("test-bridge-desktop.yml", "test-bridge-desktop-frozen.yml", DEV_CALLEE)
SUPPRESS_INPUT = "suppress_cli_artifact_upload"
# Event boundary. Inside a reusable call the github context is the caller's, so
# ref_name is the caller's branch. pull_request: head_ref is the source branch.
# workflow_dispatch and push: ref_name is the selected or pushed branch.
SUPPRESS_CONDITION = (
    "${{ inputs.suppress_cli_artifact_upload != true"
    f" && github.head_ref != '{BRANCH}'"
    f" && github.ref_name != '{BRANCH}' }}}}"
)
# Trigger forms the condition was written for; a new form needs a new review.
GUARDED_EVENTS = {"push", "pull_request", "workflow_dispatch", "workflow_call"}
RECEIPT_SUFFIXES = (".xml", ".txt", ".json", ".log", ".rc")
UPLOAD_ACTION = "actions/upload-artifact@"
CHECKOUT_ACTION = "actions/checkout@"
ROOT_PERMISSION_TEST = "tests/test_reusable_workflow_caller_permissions.py"
ROOT_PERMISSION_INSTALL = "python -m pip install --disable-pip-version-check pytest PyYAML==6.0.3"

DEV_CALLEE_PATHS = {
    ".github/workflows/test-bridge-desktop-dev.yml",
    ".github/workflows/build-bridge-desktop-dev.yml",
    *(f".github/workflows/{name}" for name in REQUIRED_CALLEES),
    "bridge/tests/test_desktop_dev_build_workflow.py",
    "bridge/tests/test_desktop_dev_licence_gate.py",
    "bridge/dev-build/**",
    "bridge/entrypoint_desktop.py",
    "bridge/silentsuite-bridge-desktop.spec",
    "bridge/pyproject.toml",
    "bridge/tests/desktop_smoke/requirements.txt",
    ROOT_PERMISSION_TEST,
}
# Everything the artifact depends on: product source, packaging inputs,
# collector, gate, policy and notices, README, contract tests and every callee.
CALLER_PATHS = DEV_CALLEE_PATHS | {
    "bridge/src/silentsuite_bridge/**",
    "bridge/tests/test_desktop_frozen.py",
}
PACKAGE_STEP_ORDER = ("build", "frozen-tests", "facts", "licence-gate", "archive", "upload")
SOURCE_STEP_ORDER = ("fetch-sources", "verify-sources", "upload-sources")
PACKAGE_RUNNERS = {"ubuntu-22.04", "windows-latest"}
FORBIDDEN_TEXT = ("secrets.", "action-gh-release", "gh release", "git tag", "git push", "schedule:")


def _require():
    if os.environ.get(REQUIRE_ENV) != "1":
        pytest.skip("dev build contracts run only in test-bridge-desktop-dev.yml")


@pytest.fixture(scope="module")
def yaml():
    _require()
    try:
        import yaml as module
    except ImportError:
        pytest.fail("prerequisite missing (not RED): PyYAML is not installed")
    return module


def _load(yaml, name):
    path = WORKFLOWS / name
    if not path.is_file():
        return None
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(document, dict), f"{name} is not a workflow mapping"
    return document


def _on(document):
    # PyYAML reads the bare key `on` as boolean True.
    triggers = document.get("on", document.get(True))
    return triggers if isinstance(triggers, dict) else {}


def _steps(job):
    return [step for step in job.get("steps", []) if isinstance(step, dict)]


def _upload_paths(step):
    raw = (step.get("with") or {}).get("path", "")
    return [line.strip() for line in str(raw).splitlines() if line.strip()]


def _is_receipt_upload(step):
    paths = _upload_paths(step)
    return bool(paths) and all(path.endswith(RECEIPT_SUFFIXES) for path in paths)


@pytest.fixture(scope="module")
def dev_callee(yaml):
    document = _load(yaml, DEV_CALLEE)
    if document is None:
        pytest.fail(f"prerequisite missing (not RED): {DEV_CALLEE} is the workflow running these tests")
    return document


@pytest.fixture(scope="module")
def callees(yaml):
    documents = {name: _load(yaml, name) for name in REQUIRED_CALLEES}
    missing = [name for name, document in documents.items() if document is None]
    if missing:
        pytest.fail(f"prerequisite missing (not RED): existing callee workflows not found: {missing}")
    return documents


@pytest.fixture(scope="module")
def caller(yaml):
    document = _load(yaml, CALLER)
    if document is None:
        pytest.fail(f"NOT REACHED: {CALLER} does not exist yet")
    return document


# --- controls: the S2-F workflow itself ---------------------------------------


def test_dev_callee_is_restricted_reusable_and_receipts_only(dev_callee):
    triggers = _on(dev_callee)
    assert set(triggers) == {"push", "workflow_call"}, triggers
    assert triggers["push"]["branches"] == [BRANCH]
    assert set(triggers["push"]["paths"]) == DEV_CALLEE_PATHS, sorted(set(triggers["push"]["paths"]) ^ DEV_CALLEE_PATHS)
    caller_input = triggers["workflow_call"]["inputs"]["caller"]
    assert caller_input["type"] == "string" and caller_input["default"] == "", caller_input
    assert dev_callee["permissions"] == {"contents": "read"}
    assert "inputs.caller" in dev_callee["concurrency"]["group"]
    text = (WORKFLOWS / DEV_CALLEE).read_text(encoding="utf-8")
    for forbidden in FORBIDDEN_TEXT:
        assert forbidden not in text, forbidden
    for job_id, job in dev_callee["jobs"].items():
        assert job.get("permissions") in (None, {"contents": "read"}), job_id
        for step in _steps(job):
            assert "continue-on-error" not in step, (job_id, step.get("name"))
            uses = step.get("uses", "")
            if uses.startswith(CHECKOUT_ACTION):
                assert step["with"]["persist-credentials"] is False, job_id
            if uses.startswith(UPLOAD_ACTION):
                assert _is_receipt_upload(step), (job_id, _upload_paths(step))
            run = step.get("run", "")
            if "| tee" in run and "pytest" in run:
                assert 'exit "$status"' in run and "PIPESTATUS[0]" in run, (job_id, step.get("name"))


def test_dev_callee_runs_the_root_permission_test_with_its_existing_setup(dev_callee):
    ci_server = (WORKFLOWS / "ci-server.yml").read_text(encoding="utf-8")
    assert ROOT_PERMISSION_INSTALL in ci_server and ROOT_PERMISSION_TEST in ci_server, "control: ci-server setup moved"
    job = dev_callee["jobs"]["contracts-permissions"]
    steps = _steps(job)
    pythons = [s["with"]["python-version"] for s in steps if s.get("uses", "").startswith("actions/setup-python@")]
    assert pythons == ["3.12"], pythons
    assert any(s.get("run", "").strip() == ROOT_PERMISSION_INSTALL for s in steps)
    assert any(ROOT_PERMISSION_TEST in s.get("run", "") and "--junitxml" in s.get("run", "") for s in steps)


def test_dev_callee_facts_job_never_collects_without_the_admitted_collector(dev_callee):
    steps = _steps(dev_callee["jobs"]["facts"])
    helper = [s for s in steps if s.get("id") == "helper"]
    assert helper and "bridge/dev-build/collect_bundle_facts.py" in helper[0]["run"]
    gated = [s for s in steps if s.get("id") != "helper" and not s.get("uses", "").startswith((CHECKOUT_ACTION, UPLOAD_ACTION))
             and s.get("name") != "Fail when the collector was not reached"]
    assert gated and all("steps.helper.outputs.present == 'true'" in str(s.get("if", "")) for s in gated)
    final = steps[-1]
    assert "steps.helper.outputs.present != 'true'" in final["if"] and "exit 1" in final["run"]


# --- RED until the reviewed callee edits (S2b-1) ---------------------------------


def test_required_callees_are_reusable_at_the_callers_sha(callees):
    not_reusable = [name for name, document in callees.items() if "workflow_call" not in _on(document)]
    assert not not_reusable, f"callees without a workflow_call trigger: {not_reusable}"


def test_callee_binary_uploads_are_suppressed_for_the_dev_caller(callees):
    binary_uploads = []
    failures = []
    for name, document in callees.items():
        for job_id, job in document.get("jobs", {}).items():
            steps = _steps(job)
            for step in steps:
                if not step.get("uses", "").startswith(UPLOAD_ACTION) or _is_receipt_upload(step):
                    continue
                binary_uploads.append((name, job_id))
                if str(step.get("if", "")).strip() != SUPPRESS_CONDITION:
                    failures.append(f"{name}:{job_id} uploads {_upload_paths(step)} without the suppression condition")
                declared = (_on(document).get("workflow_call") or {}).get("inputs", {}).get(SUPPRESS_INPUT)
                if not (isinstance(declared, dict) and declared.get("type") == "boolean" and declared.get("default") is False):
                    failures.append(f"{name} does not declare {SUPPRESS_INPUT} as boolean, default false")
                unguarded = set(_on(document)) - GUARDED_EVENTS
                if unguarded:
                    failures.append(f"{name} has trigger forms the upload condition was not reviewed for: {sorted(unguarded)}")
                # Only the upload is skipped: tests, build and smokes keep running.
                others = [s.get("name") for s in steps if s is not step and SUPPRESS_INPUT in str(s.get("if", ""))]
                if others:
                    failures.append(f"{name}:{job_id} also skips non-upload steps: {others}")
    # Control: the known Linux CLI binary upload is found, so this is never vacuous.
    assert ("test-bridge-linux.yml", "build") in binary_uploads, binary_uploads
    assert not failures, failures


def test_shared_desktop_callees_separate_called_and_standalone_concurrency(yaml, callees, dev_callee):
    documents = {**callees, DEV_CALLEE: dev_callee}
    failures = []
    for name in SHARED_CONCURRENCY_CALLEES:
        document = documents[name]
        caller_input = ((_on(document).get("workflow_call") or {}).get("inputs") or {}).get("caller")
        group = str((document.get("concurrency") or {}).get("group", ""))
        if not (isinstance(caller_input, dict) and caller_input.get("type") == "string"):
            failures.append(f"{name} has no string input 'caller'")
        if "inputs.caller" not in group:
            failures.append(f"{name} concurrency group does not carry inputs.caller: {group!r}")
    assert not failures, failures


# --- RED until the final caller (S2b-2); the rest NOT REACHED ------------------


def test_dev_caller_exists():
    _require()
    assert (WORKFLOWS / CALLER).is_file(), f"{CALLER} does not exist yet"


def test_dev_caller_triggers_on_every_artifact_input(caller):
    triggers = _on(caller)
    assert set(triggers) == {"push"}, triggers  # one-off push runs; no schedule or dispatch transport
    assert triggers["push"]["branches"] == [BRANCH]
    missing = CALLER_PATHS - set(triggers["push"]["paths"])
    assert not missing, sorted(missing)
    assert caller["concurrency"]["group"].startswith("bridge-desktop-dev-build-")


def test_dev_caller_requires_every_callee_at_its_sha(caller):
    assert caller["permissions"] == {"contents": "read"}
    called = {}
    for job_id, job in caller["jobs"].items():
        assert job.get("permissions") == {"contents": "read"}, f"{job_id} lacks explicit contents: read"
        assert "secrets" not in job, job_id
        uses = job.get("uses", "")
        if uses.startswith("./.github/workflows/"):
            called[uses.rsplit("/", 1)[-1]] = (job_id, job.get("with") or {})
    assert set(called) == set(REQUIRED_CALLEES) | {DEV_CALLEE}, sorted(called)
    assert called["test-bridge-linux.yml"][1] == {SUPPRESS_INPUT: True}
    for name in SHARED_CONCURRENCY_CALLEES:
        assert called[name][1] == {"caller": CALLER_NAME}, name
    for name in ("test-bridge-windows.yml", "test-bridge-macos.yml"):
        assert called[name][1] == {}, name
    text = (WORKFLOWS / CALLER).read_text(encoding="utf-8")
    for forbidden in FORBIDDEN_TEXT:
        assert forbidden not in text, forbidden


def test_dev_caller_uploads_sources_then_binaries_only_after_every_gate(caller):
    jobs = caller["jobs"]
    callee_jobs = {job_id for job_id, job in jobs.items() if str(job.get("uses", "")).startswith("./.github/workflows/")}
    sources, package = jobs["source-materials"], jobs["package"]
    assert set(sources["needs"]) == callee_jobs and "success()" in str(sources.get("if", "success()"))
    assert package["needs"] == ["source-materials"] or set(package["needs"]) == {"source-materials"}
    assert {row["runner"] for row in package["strategy"]["matrix"]["include"]} == PACKAGE_RUNNERS
    for job, order in ((sources, SOURCE_STEP_ORDER), (package, PACKAGE_STEP_ORDER)):
        steps = _steps(job)
        ids = [step.get("id") for step in steps if step.get("id")]
        assert ids == list(order), ids
        uploads = [index for index, step in enumerate(steps) if step.get("uses", "").startswith(UPLOAD_ACTION)]
        assert uploads == [len(steps) - 1], "the only upload must be the last step"
        for step in steps:
            assert "always()" not in str(step.get("if", "")) and "continue-on-error" not in step, step.get("id")
            if step.get("uses", "").startswith(CHECKOUT_ACTION):
                assert step["with"]["persist-credentials"] is False
        assert "github.sha" in str(steps[-1]["with"]["name"])
    archive = next(step for step in _steps(package) if step.get("id") == "archive")
    assert "tar -czf" in archive["run"], "Linux archives must be tarballs (Actions artifacts drop exec bits)"
