"""Version reporting tests.

Guards against the stale-version regression where `silentsuite-bridge
--version` reported 0.1.0 long after the project had moved on (the binary was
never re-stamped from the release tag). These tests keep the package version,
the pyproject version, and the CLI/env override path in agreement.
"""

import importlib
import re
import subprocess
import sys
from pathlib import Path

import silentsuite_bridge

BRIDGE_ROOT = Path(__file__).resolve().parent.parent


def _pyproject_version() -> str:
    pyproject = (BRIDGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert match, "bridge/pyproject.toml should declare [project].version"
    return match.group(1)


def test_version_is_not_stale_placeholder():
    """The long-lived 0.1.0 placeholder must never resurface."""
    assert silentsuite_bridge.__version__ != "0.1.0"


def test_version_looks_like_a_release():
    """Version must be a plausible semver-ish string (e.g. 0.3.0-beta)."""
    assert re.match(r"^\d+\.\d+\.\d+", silentsuite_bridge.__version__)


def test_fallback_matches_pyproject():
    """The hardcoded fallback must track pyproject so source runs aren't stale."""
    assert silentsuite_bridge._FALLBACK_VERSION == _pyproject_version()


def test_env_override_takes_precedence(monkeypatch):
    """Release builds stamp the version via the env override; honour it and
    strip a leading 'v' so a raw git tag works."""
    monkeypatch.setenv("SILENTSUITE_BRIDGE_VERSION", "v9.9.9-rc1")
    reloaded = importlib.reload(silentsuite_bridge)
    try:
        assert reloaded.__version__ == "9.9.9-rc1"
    finally:
        monkeypatch.delenv("SILENTSUITE_BRIDGE_VERSION", raising=False)
        importlib.reload(silentsuite_bridge)


def test_cli_version_output_matches_package():
    """`python -m silentsuite_bridge --version` must echo the package version."""
    result = subprocess.run(
        [sys.executable, "-m", "silentsuite_bridge", "--version"],
        capture_output=True,
        text=True,
        cwd=str(BRIDGE_ROOT / "src"),
    )
    assert result.returncode == 0, result.stderr
    assert silentsuite_bridge.__version__ in result.stdout
    assert "0.1.0" not in result.stdout
