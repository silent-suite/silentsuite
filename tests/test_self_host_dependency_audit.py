"""Wiring contracts for the Python-lock and built-image vulnerability audit.

These are static checks of `.github/workflows/ci-server.yml` and the audit-tool
lock. They prove the planned audit gates are wired with the intended flags and
failure behaviour; they do not prove scanner behaviour, which only real hosted
runs can show.

Planned wiring:
- pip-audit 2.10.1, hash-locked under scripts/ (outside the server image build
  context), installed into an isolated virtualenv in the test-server job;
- native pip-audit runs over the runtime lock (hash-pinned) and the dev lock
  (exact pins, no dependency resolution), each writing a fresh JSON report;
- Trivy v0.76.2 downloaded per architecture and checked against literal release
  digests, one all-severity OS + library JSON inventory of the built image, all
  findings printed, then a native HIGH/CRITICAL gate on the same report;
- installed-Python coverage: Trivy's `python-pkg` results must equal the image's
  real installed distribution metadata.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
CI_PATH = ROOT / ".github" / "workflows" / "ci-server.yml"
AUDIT_IN = ROOT / "scripts" / "pip-audit-requirements.in"
AUDIT_LOCK = ROOT / "scripts" / "pip-audit-requirements.txt"
AUDIT_LOCK_REL = "scripts/pip-audit-requirements.txt"

TRIVY_RELEASE = "https://github.com/aquasecurity/trivy/releases/download/v0.76.2/"
TRIVY_ASSETS = {
    "amd64": ("trivy_0.76.2_Linux-64bit.tar.gz", "bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf"),
    "arm64": ("trivy_0.76.2_Linux-ARM64.tar.gz", "ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3"),
}

# BaseLoader keeps every scalar a string, including the `on:` key.
CI = yaml.load(CI_PATH.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def _job(name: str) -> dict:
    jobs = CI.get("jobs", {})
    assert name in jobs, f"ci-server.yml has no {name!r} job"
    return jobs[name]


def _steps(job_name: str) -> list[dict]:
    return list(_job(job_name).get("steps", []))


def _run(step: dict) -> str:
    return step.get("run", "")


def _steps_running(job_name: str, needle: str) -> list[dict]:
    return [step for step in _steps(job_name) if needle in _run(step)]


def _only_step_running(job_name: str, needle: str) -> dict:
    matches = _steps_running(job_name, needle)
    assert len(matches) == 1, f"expected exactly one {job_name} step running {needle!r}, found {len(matches)}"
    return matches[0]


def _pip_audit_steps() -> list[dict]:
    return [step for step in _steps("test-server") if "pip-audit " in _run(step)]


def _trivy_steps() -> list[dict]:
    return [step for step in _steps("self-host-image") if "trivy" in _run(step)]


def _index(job_name: str, step: dict) -> int:
    return _steps(job_name).index(step)


# ── Audit tool lock (existence) ──────────────────────────────────────


def test_audit_tool_lock_is_hash_pinned_outside_the_server_image():
    assert AUDIT_IN.is_file(), f"the planned audit-tool input {AUDIT_IN.relative_to(ROOT)} is missing"
    declared = [
        line.strip()
        for line in AUDIT_IN.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    assert declared == ["pip-audit==2.10.1"], declared

    assert AUDIT_LOCK.is_file(), f"the planned audit-tool lock {AUDIT_LOCK_REL} is missing"
    pins: dict[str, int] = {}
    current = None
    for line in AUDIT_LOCK.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith((" ", "\t")):
            match = re.fullmatch(r"(?P<name>[A-Za-z0-9._-]+)(\[[^\]]+\])?==(?P<version>\S+) \\", line)
            assert match, f"audit lock line is not an exact hash-continued pin: {line!r}"
            current = match.group("name").lower()
            assert current not in pins, f"{current} is pinned twice"
            pins[current] = 0
        elif "--hash=sha256:" in line:
            assert current is not None, f"hash without a requirement: {line!r}"
            assert re.search(r"--hash=sha256:[0-9a-f]{64}", line), line
            pins[current] += 1
    assert "pip-audit" in pins, "pip-audit itself is not pinned in the audit lock"
    unhashed = sorted(name for name, count in pins.items() if count == 0)
    assert not unhashed, f"audit lock pins without hashes: {unhashed}"


# ── Python lock audits in the test-server job (wiring) ───────────────


def test_audit_tool_installs_into_an_isolated_venv_from_the_hash_lock():
    install = _only_step_running("test-server", AUDIT_LOCK_REL)
    run = _run(install)
    assert "--require-hashes" in run and "--only-binary=:all:" in run, run
    assert "bin/pip" in run, "the audit tool must be installed with the isolated venv's pip"
    venv_steps = _steps_running("test-server", "-m venv")
    assert venv_steps, "no isolated virtualenv is created for the audit tool"
    assert _index("test-server", venv_steps[0]) <= _index("test-server", install)


@pytest.mark.parametrize(
    ("lock", "required_flags"),
    [
        pytest.param("server/requirements.txt", ("--require-hashes", "--disable-pip", "--strict"), id="runtime-lock"),
        pytest.param("server/requirements-dev.txt", ("--no-deps", "--disable-pip", "--strict"), id="dev-lock"),
    ],
)
def test_lock_audit_uses_native_pinned_mode(lock, required_flags):
    target = f"-r {lock}"
    matches = [step for step in _pip_audit_steps() if target in _run(step)]
    assert len(matches) == 1, f"expected exactly one pip-audit step auditing {lock}, found {len(matches)}"
    run = _run(matches[0])
    for flag in required_flags:
        assert flag in run, f"pip-audit over {lock} lacks {flag}"
    assert re.search(r"(-s|--vulnerability-service)[ =]osv\b", run), run
    assert re.search(r"(-f|--format)[ =]json\b", run), run
    assert re.search(r"(-o|--output)[ =]", run), run
    removal = run.find("rm -f")
    assert 0 <= removal < run.find(target), "the report must be deleted before every pip-audit run"


def test_lock_audit_steps_survive_earlier_failures():
    steps = _pip_audit_steps()
    assert steps, "the test-server job runs no pip-audit step"
    for step in steps:
        assert "!cancelled()" in step.get("if", ""), step.get("name")
        assert "continue-on-error" not in step, step.get("name")


# ── Built-image audit in the self-host-image lanes (wiring) ──────────


@pytest.mark.parametrize("arch", sorted(TRIVY_ASSETS))
def test_image_lanes_pin_trivy_release_digests(arch):
    asset, digest = TRIVY_ASSETS[arch]
    entries = [entry for entry in _job("self-host-image")["strategy"]["matrix"]["include"] if entry.get("arch") == arch]
    assert len(entries) == 1, f"no single {arch} image lane"
    values = set(entries[0].values())
    assert asset in values, f"the {arch} lane does not pin {asset}"
    assert digest in values, f"the {arch} lane does not pin the {asset} release digest"


def test_trivy_download_is_verified_against_the_matrix_digest():
    download = _only_step_running("self-host-image", TRIVY_RELEASE)
    run = _run(download)
    assert "sha256sum -c" in run, "the Trivy archive must be checked against the literal digest"
    assert "matrix." in run, "the download must use the lane's own pinned asset and digest"


def test_image_scan_inventories_all_os_and_library_packages():
    scan = _only_step_running("self-host-image", "trivy image")
    run = _run(scan)
    for flag in ("--input", "--scanners vuln", "--pkg-types os,library", "--format json", "--output", "--list-all-pkgs", '--ignorefile ""'):
        assert flag in run, f"the image scan lacks {flag}"
    assert "--severity" not in run and "--exit-code" not in run, "the inventory scan must keep every severity"
    removal = run.find("rm -f")
    assert 0 <= removal < run.find("trivy image"), "the report must be deleted before the scan"


def test_all_findings_are_printed_before_the_high_critical_gate():
    converts = _steps_running("self-host-image", "trivy convert")
    printers = [step for step in converts if "--severity" not in _run(step)]
    gates = [step for step in converts if "--severity HIGH,CRITICAL" in _run(step)]
    assert len(printers) == 1, "exactly one step must print every finding from the inventory"
    assert len(gates) == 1, "exactly one step must apply the HIGH/CRITICAL gate"
    assert "--exit-code 1" in _run(gates[0])
    for step in printers + gates:
        assert '--ignorefile ""' in _run(step)
    assert _index("self-host-image", printers[0]) < _index("self-host-image", gates[0])


def test_installed_python_coverage_compares_python_pkg_with_image_metadata():
    text = "\n".join(_run(step) for step in _steps("self-host-image"))
    assert "importlib.metadata" in text, "no installed-distribution inventory is read from the image"
    assert "--network none" in text, "the image inventory must be read without network access"
    assert '"python-pkg"' in text and '"lang-pkgs"' in text, "coverage must use Trivy's installed python-pkg results"
    assert '.Type=="pip"' not in text, "requirement-file declarations are not installed packages"
    assert '"alpine"' in text and '"os-pkgs"' in text, "the OS package inventory must be checked as well"
    assert "diff -u" in text, "installed and scanned inventories must be compared exactly"


def test_image_audit_steps_follow_the_existing_build_and_fail_closed():
    steps = _trivy_steps()
    assert steps, "the self-host-image job runs no Trivy step"
    build = [step for step in _steps("self-host-image") if "docker/build-push-action" in step.get("uses", "")]
    assert len(build) == 1 and build[0].get("id") == "build", "the single existing build step must carry id: build"
    smoke = _only_step_running("self-host-image", "self-host-image-smoke.sh")
    for step in steps:
        condition = step.get("if", "")
        assert "!cancelled()" in condition and "steps.build.outcome == 'success'" in condition, step.get("name")
        assert _index("self-host-image", step) > _index("self-host-image", smoke), step.get("name")


def test_audit_steps_add_no_masking_secrets_artifacts_or_pushes():
    steps = _pip_audit_steps() + _trivy_steps()
    assert steps, "no audit steps are wired"
    for step in steps:
        run = _run(step)
        assert "continue-on-error" not in step, step.get("name")
        for forbidden in ("|| true", "--ignore-vuln", ".trivyignore", "secrets.", "docker push", "upload-artifact"):
            assert forbidden not in run, f"{step.get('name')}: {forbidden}"
        uses = step.get("uses", "")
        assert not uses.startswith(("actions/upload-artifact", "actions/cache")), step.get("name")


@pytest.mark.parametrize("event", ["push", "pull_request"])
def test_audit_lock_is_a_ci_trigger_path(event):
    paths = CI["on"][event]["paths"]
    for required in ("scripts/pip-audit-requirements.in", AUDIT_LOCK_REL):
        assert required in paths, f"{event}: {required} is not a CI trigger path"


# ── Healthy controls ──────────────────────────────────────────────────


def test_image_lanes_still_build_once_per_architecture_without_push():
    include = _job("self-host-image")["strategy"]["matrix"]["include"]
    assert sorted(entry.get("arch") for entry in include) == ["amd64", "arm64"]
    builds = [step for step in _steps("self-host-image") if "docker/build-push-action" in step.get("uses", "")]
    assert len(builds) == 1
    assert builds[0]["with"]["push"] == "false"


def test_no_audit_lock_inside_the_server_image_context():
    for path in (ROOT / "server" / "requirements-audit.txt", ROOT / "server" / "requirements.in" / "audit.txt"):
        assert not path.exists(), f"{path.relative_to(ROOT)} would be copied into the server image"
