"""Optional packaged macOS ``--check-update`` characterization.

Runs only when an operator opts in (``SILENTSUITE_PACKAGED_UPDATE_CHECK=1``,
set by the manual input in build-bridge.yml). Ordinary source runs skip it.

When opted in, it runs the just-built frozen binary's ``--check-update`` once,
with HOME and TMPDIR inside pytest's disposable ``tmp_path``. That makes one
unauthenticated read of the public GitHub releases list. It never runs
``--self-update`` and never touches an installed Bridge, account or cache.

It records only bounded evidence: source SHA, binary version, binary
architecture, exit code and an outcome category. Raw command output, network
errors and paths are never printed. A rate limit is its own category and is
never counted as a successful check. Any other failure stays a failure.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

import pytest

OPT_IN_ENV = "SILENTSUITE_PACKAGED_UPDATE_CHECK"
BINARY_ENV = "SILENTSUITE_PACKAGED_BINARY"
ARCH_ENV = "SILENTSUITE_PACKAGED_ARCH"
VERSION_ENV = "SILENTSUITE_PACKAGED_VERSION"
SOURCE_SHA_ENV = "SILENTSUITE_PACKAGED_SOURCE_SHA"
EVIDENCE_ENV = "SILENTSUITE_PACKAGED_UPDATE_EVIDENCE"

# Outcomes that show the release list was fetched and a release was compared.
SUCCESSFUL_OUTCOMES = {"available", "current", "downgrade"}

pytestmark = pytest.mark.skipif(
    os.environ.get(OPT_IN_ENV) != "1",
    reason=f"packaged update-check characterization runs only when {OPT_IN_ENV}=1",
)


def _require(name):
    value = os.environ.get(name, "").strip()
    assert value, f"{name} is required when {OPT_IN_ENV}=1"
    return value


def _isolated_env(tmp_path):
    home = tmp_path / "home"
    tmp = tmp_path / "tmp"
    home.mkdir()
    tmp.mkdir()
    # A minimal environment: no inherited SILENTSUITE_* overrides, no
    # credentials, and a disposable home and temp directory.
    return {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(home),
        "TMPDIR": str(tmp),
        "LANG": "C",
        "LC_ALL": "C",
    }


def _run(binary, args, env, timeout):
    return subprocess.run(
        [binary, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _binary_version(binary, env):
    result = _run(binary, ["--version"], env, timeout=60)
    match = re.fullmatch(r"SilentSuite Bridge v(\S{1,64})", result.stdout.strip())
    return match.group(1) if result.returncode == 0 and match else "unknown"


def _binary_arch(binary):
    try:
        result = subprocess.run(
            ["lipo", "-archs", binary],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    archs = result.stdout.split()
    if result.returncode != 0 or len(archs) != 1:
        return "unknown"
    return archs[0] if archs[0] in {"x86_64", "arm64"} else "unknown"


def _classify(exit_code, stdout, stderr):
    if exit_code == 0:
        if "Update available:" in stdout:
            return "available"
        if "Up to date." in stdout:
            return "current"
        if "newer than the latest compatible release" in stdout:
            return "downgrade"
        if "Development build" in stdout:
            return "development"
    elif exit_code == 1:
        if stderr.strip() == "Error: update check failed.":
            return "catch_all"
        if "Update check failed." in stdout:
            return "fetch_failure"
        if "not supported" in stdout:
            return "unsupported"
        if "No compatible release asset" in stdout:
            return "missing_asset"
    return "unrecognized"


def _rate_limit_exhausted():
    """True only when GitHub reports zero remaining core requests.

    The rate-limit endpoint itself does not count against the limit. Any
    error here returns None (unknown); its details are not reported.
    """
    request = urllib.request.Request(
        "https://api.github.com/rate_limit",
        headers={"User-Agent": "SilentSuite-Bridge-CI-Characterization"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.loads(response.read(64 * 1024))
        remaining = data["resources"]["core"]["remaining"]
    except Exception:
        return None
    return isinstance(remaining, int) and remaining == 0


def test_packaged_check_update_fetches_and_compares_a_release(tmp_path):
    assert sys.platform == "darwin", "packaged update check runs on macOS lanes only"
    binary = _require(BINARY_ENV)
    expected_arch = _require(ARCH_ENV)
    source_sha = _require(SOURCE_SHA_ENV)
    assert re.fullmatch(r"[0-9a-f]{40}", source_sha), "source SHA must be 40 hex"
    assert os.path.isfile(binary) and os.access(binary, os.X_OK), "packaged binary missing"

    env = _isolated_env(tmp_path)
    version = _binary_version(binary, env)
    arch = _binary_arch(binary)

    try:
        result = _run(binary, ["--check-update"], env, timeout=180)
        exit_code = result.returncode
        outcome = _classify(exit_code, result.stdout, result.stderr)
    except subprocess.TimeoutExpired:
        exit_code = None
        outcome = "timeout"

    if outcome not in SUCCESSFUL_OUTCOMES and _rate_limit_exhausted():
        outcome = "rate_limited"

    evidence = {
        "source_sha": source_sha,
        "binary_version": version,
        "binary_arch": arch,
        "expected_arch": expected_arch,
        "exit_code": exit_code,
        "outcome": outcome,
    }
    line = json.dumps(evidence, sort_keys=True)
    print(f"PACKAGED_UPDATE_CHECK {line}")
    evidence_path = os.environ.get(EVIDENCE_ENV, "").strip()
    if evidence_path:
        with open(evidence_path, "w", encoding="utf-8") as handle:
            handle.write(line + "\n")

    assert arch == expected_arch, f"binary architecture is {arch}, expected {expected_arch}"
    expected_version = os.environ.get(VERSION_ENV, "").strip()
    if expected_version:
        assert version == expected_version, "binary version differs from the stamped release"
    assert version != "unknown", "binary version could not be read"
    assert outcome != "rate_limited", "GitHub rate limit reached; check is unverified"
    assert outcome in SUCCESSFUL_OUTCOMES, f"packaged check outcome: {outcome}"
