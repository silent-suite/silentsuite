"""Static release-version consistency checks.

These tests guard against stale user-visible versions across the bridge, web
workspace packages, and Android metadata. They intentionally avoid archived
prototype code under _archive/.
"""

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
CURRENT_RELEASE_VERSION = "0.3.1-beta"

PACKAGE_JSON_PATHS = [
    "package.json",
    "apps/web/package.json",
    "apps/docs/package.json",
    "packages/core/package.json",
    "packages/ui/package.json",
    "packages/config/package.json",
]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_workspace_package_versions_match_current_release():
    for rel in PACKAGE_JSON_PATHS:
        package = json.loads(read(rel))
        assert package["version"] == CURRENT_RELEASE_VERSION, rel


def test_bridge_pyproject_version_matches_current_release():
    pyproject = read("bridge/pyproject.toml")
    match = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert match, "bridge/pyproject.toml should declare [project].version"
    assert match.group(1) == CURRENT_RELEASE_VERSION


def test_web_signup_uses_named_display_version_constant():
    constants = read("apps/web/app/lib/constants.ts")
    signup = read("apps/web/app/(auth)/signup/page.tsx")

    assert f"DISPLAY_VERSION = '{CURRENT_RELEASE_VERSION}'" in constants
    assert "import { DISPLAY_VERSION }" in signup
    assert "v{DISPLAY_VERSION}" in signup
    assert "v0.3.0" not in signup


def test_android_version_name_matches_current_release():
    gradle = read("android/app/build.gradle")
    match = re.search(r'versionName\s+"([^"]+)"', gradle)
    assert match, "android/app/build.gradle should declare versionName"
    assert match.group(1) == CURRENT_RELEASE_VERSION


def test_bridge_release_workflow_validates_frozen_version_without_runtime_env_override():
    workflow = read(".github/workflows/build-bridge.yml")
    spec = read("bridge/silentsuite-bridge.spec")

    assert "env -u SILENTSUITE_BRIDGE_VERSION" in workflow
    assert "SPECPATH" in spec
    assert "Removed stale generated version stamp" in spec
    assert "target.unlink()" in spec
    assert "VERSION = {version!r}" in spec
