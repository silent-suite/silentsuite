"""Contract tests for Bridge safe self-update (Issue #223).

These tests define production-facing contracts for a CLI-first update design.
The following production modules must exist for tests to pass:

    silentsuite_bridge.update.types     — Platform, UpdateStatus, CheckResult,
                                         ReplaceResult, ChecksumError, HttpError
    silentsuite_bridge.update.platform  — central canonical PlatformMapping
    silentsuite_bridge.update.check     — release lookup, version comparison
    silentsuite_bridge.update.verify    — checksum parsing and validation
    silentsuite_bridge.update.fs        — filesystem adapter (stage, rename, chmod,
                                         remove, write_staging_plan)
    silentsuite_bridge.update.http      — HTTP adapter with bounded
                                         redirects/time/size
    silentsuite_bridge.update.replace   — orchestrates fetch→verify→replace
    silentsuite_bridge.update.restart   — coordinated restart or manual instruction
    silentsuite_bridge.update           — top-level perform_update and
                                         check_for_update entry points

Inject fakes/spies for all I/O. No real network, autostart, or process mutation.

These tests MUST FAIL against baseline 23871f05 because the update modules
and CLI wiring do not exist yet.
"""

import hashlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Shared constants and helpers
# ---------------------------------------------------------------------------

FAKE_64_HEX = "a" * 64

GITHUB_API = "https://api.github.com"
GITHUB_HOST = "https://github.com"
ASSETS_HOST = "https://release-assets.githubusercontent.com"

ASSET_LINUX_X86_64   = "silentsuite-bridge-linux-x86_64"
ASSET_LINUX_ARM64    = "silentsuite-bridge-linux-arm64"
ASSET_MACOS_X86_64   = "silentsuite-bridge-macos-x86_64"
ASSET_MACOS_ARM64    = "silentsuite-bridge-macos-arm64"
ASSET_WINDOWS_X86_64 = "silentsuite-bridge-windows-x86_64.exe"

ALL_ASSETS = {ASSET_LINUX_X86_64, ASSET_LINUX_ARM64, ASSET_MACOS_X86_64,
              ASSET_MACOS_ARM64, ASSET_WINDOWS_X86_64}


def _checksum_line(hex_digest, asset_name):
    return f"{hex_digest}  {asset_name}\n"


def _release(version, draft=False, *, assets):
    return {
        "tag_name": version if version.startswith("v") else f"v{version}",
        "draft": draft,
        "assets": [
            {"name": name, "browser_download_url": f"{ASSETS_HOST}/{name}"}
            for name in assets
        ],
    }


def _make_fs():
    fs = MagicMock()
    fs.stage.return_value = "/tmp/.update-staged"
    return fs


def _make_http_download_for(data, checksum_hex, asset_name):
    http = MagicMock()
    http.download.side_effect = [
        _checksum_line(checksum_hex, asset_name).encode(),
        data,
    ]
    return http


def _make_restart_success():
    from silentsuite_bridge.update.restart import RestartResult
    restart = MagicMock()
    restart.restart.return_value = RestartResult(success=True, instruction=None)
    return restart


# ---------------------------------------------------------------------------
# Platform/asset mapping (central canonical contract)
# ---------------------------------------------------------------------------

def _pm():
    from silentsuite_bridge.update.platform import PlatformMapping
    return PlatformMapping


@pytest.mark.parametrize("os_name,arch,expected_asset", [
    ("linux",   "x86_64",  ASSET_LINUX_X86_64),
    ("linux",   "amd64",   ASSET_LINUX_X86_64),
    ("linux",   "arm64",   ASSET_LINUX_ARM64),
    ("linux",   "aarch64", ASSET_LINUX_ARM64),
    ("macos",   "x86_64",  ASSET_MACOS_X86_64),
    ("macos",   "amd64",   ASSET_MACOS_X86_64),
    ("macos",   "arm64",   ASSET_MACOS_ARM64),
    ("macos",   "aarch64", ASSET_MACOS_ARM64),
    ("windows", "x86_64",  ASSET_WINDOWS_X86_64),
    ("windows", "amd64",   ASSET_WINDOWS_X86_64),
])
def test_platform_mapping_canonical_assets(os_name, arch, expected_asset):
    result = _pm().asset_name(os_name, arch)
    assert result == expected_asset


@pytest.mark.parametrize("os_name,arch", [
    ("linux", "riscv64"),
    ("windows", "arm64"),
    ("freebsd", "x86_64"),
])
def test_platform_mapping_unsupported_returns_none(os_name, arch):
    assert _pm().asset_name(os_name, arch) is None


def test_platform_mapping_all_assets_have_known_names():
    pm = _pm()
    known = {pm.asset_name(o, a) for o in ("linux", "macos", "windows")
             for a in ("x86_64", "amd64", "arm64", "aarch64")}
    assert ASSET_LINUX_X86_64 in known
    assert ASSET_LINUX_ARM64 in known
    assert ASSET_MACOS_X86_64 in known
    assert ASSET_MACOS_ARM64 in known
    assert ASSET_WINDOWS_X86_64 in known


# ---------------------------------------------------------------------------
# Check: newer / current / older / dev
# ---------------------------------------------------------------------------

def test_check_reports_newer_compatible_release():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE
    assert result.tag_name == "v0.5.5-beta"


def test_check_reports_current_when_version_matches():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.4-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.CURRENT


def test_check_reports_current_when_remote_is_older():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.3-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.CURRENT


def test_check_reports_development_for_dev_version_string():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.0.0-dev",
    )

    assert result.status == UpdateStatus.DEVELOPMENT


# ---------------------------------------------------------------------------
# Semantic prerelease comparison
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("current,remote,expected", [
    ("0.5.4-beta",   "0.5.5-beta",   "AVAILABLE"),
    ("0.5.5-beta",   "0.5.4-beta",   "CURRENT"),
    ("0.5.4-beta.1", "0.5.4-beta",   "CURRENT"),
    ("0.5.4-beta",   "0.5.4-beta.1", "AVAILABLE"),
    ("0.5.5-rc1",    "0.5.5",        "AVAILABLE"),
    ("0.5.5",        "0.5.5-rc1",    "CURRENT"),
    ("0.5.4",        "0.5.5-beta",   "AVAILABLE"),
    ("0.5.5-beta",   "0.5.4",        "CURRENT"),
    ("0.5.5-alpha",  "0.5.5-beta",   "AVAILABLE"),
    ("0.5.5-beta",   "0.5.5-alpha",  "CURRENT"),
])
def test_check_semver_prerelease_ordering(current, remote, expected):
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release(f"v{remote}", assets=[ASSET_LINUX_X86_64,
                                        f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version=current,
    )

    assert result.status.name == expected


# ---------------------------------------------------------------------------
# Draft release ignored
# ---------------------------------------------------------------------------

def test_check_ignores_draft_release():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.6.0-beta", draft=True, assets=[ASSET_LINUX_X86_64,
                                                     f"{ASSET_LINUX_X86_64}.sha256"]),
        _release("v0.5.4-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.3-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE
    assert result.tag_name == "v0.5.4-beta"


# ---------------------------------------------------------------------------
# Release selection: skip release missing this platform
# ---------------------------------------------------------------------------

def test_check_skips_release_missing_platform_asset():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.6-beta", assets=[ASSET_MACOS_X86_64,
                                         f"{ASSET_MACOS_X86_64}.sha256"]),
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE
    assert result.tag_name == "v0.5.5-beta"


# ---------------------------------------------------------------------------
# Missing / ambiguous asset selection
# ---------------------------------------------------------------------------

def test_check_reports_missing_asset_when_platform_not_in_any_release():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_MACOS_X86_64,
                                         f"{ASSET_MACOS_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


def test_check_rejects_ambiguous_duplicate_asset_names():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [{
        "tag_name": "v0.5.5-beta",
        "draft": False,
        "assets": [
            {"name": ASSET_LINUX_X86_64, "browser_download_url": f"{ASSETS_HOST}/bin1"},
            {"name": ASSET_LINUX_X86_64, "browser_download_url": f"{ASSETS_HOST}/bin2"},
            {"name": f"{ASSET_LINUX_X86_64}.sha256",
             "browser_download_url": f"{ASSETS_HOST}/bin1.sha256"},
        ],
    }]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


def test_check_rejects_ambiguous_duplicate_checksum_sidecars():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [{
        "tag_name": "v0.5.5-beta",
        "draft": False,
        "assets": [
            {"name": ASSET_LINUX_X86_64, "browser_download_url": f"{ASSETS_HOST}/bin"},
            {"name": f"{ASSET_LINUX_X86_64}.sha256",
             "browser_download_url": f"{ASSETS_HOST}/bin1.sha256"},
            {"name": f"{ASSET_LINUX_X86_64}.sha256",
             "browser_download_url": f"{ASSETS_HOST}/bin2.sha256"},
        ],
    }]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


def test_check_reports_missing_asset_when_release_has_checksum_but_no_binary():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


# ---------------------------------------------------------------------------
# Unsupported OS / architecture
# ---------------------------------------------------------------------------

def test_platform_mapping_unsupported_produces_none_before_network():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = AssertionError(
        "must not call network for unsupported platform")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("freebsd", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.UNSUPPORTED
    http.fetch_releases.assert_not_called()


def test_platform_mapping_rejects_windows_arm64():
    from silentsuite_bridge.update.platform import PlatformMapping
    assert PlatformMapping.asset_name("windows", "arm64") is None


# ---------------------------------------------------------------------------
# API timeout, HTTP failure, malformed JSON
# ---------------------------------------------------------------------------

def test_check_handles_http_timeout():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = TimeoutError

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.FAILURE


def test_check_handles_http_error():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = ConnectionError("403 Forbidden")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.FAILURE


def test_check_handles_malformed_json():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = ValueError("invalid JSON")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.FAILURE


# ---------------------------------------------------------------------------
# Redirect handling (HTTP adapter contract)
# ---------------------------------------------------------------------------

def test_http_adapter_allows_github_redirect_chain():
    from silentsuite_bridge.update.http import SilentSuiteHttpAdapter

    redirect_responses = [
        MagicMock(status=302,
                  headers={"Location": f"{GITHUB_HOST}/org/repo/releases/download/v0.5.5/bin"}),
        MagicMock(status=302,
                  headers={"Location": f"{ASSETS_HOST}/org/repo/bin"}),
        MagicMock(status=200, content=b"asset data"),
    ]
    transport = MagicMock()
    transport.get.side_effect = redirect_responses

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)
    result = adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")

    assert result == b"asset data"
    assert transport.get.call_count == 3


def test_http_adapter_rejects_disallowed_redirect_host():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(
        status=302,
        headers={"Location": "https://evil.example.com/malware"},
    )

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError, match="redirect"):
        adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")


def test_http_adapter_rejects_too_many_redirects():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(
        status=302,
        headers={"Location": f"{GITHUB_HOST}/circular"},
    )

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=2)

    with pytest.raises(HttpError, match="redirect"):
        adapter.download(f"{ASSETS_HOST}/repos/silent-suite/silentsuite/releases")


def test_http_adapter_passes_configured_timeout_to_transport():
    from silentsuite_bridge.update.http import SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(status=200, content=b"ok")

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=45, max_redirects=5)
    adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")

    call_kwargs = transport.get.call_args[1]
    assert call_kwargs.get("timeout") == 45


def test_http_adapter_rejects_oversized_response():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    chunk = b"x" * 1024

    def oversized_stream(*args, **kwargs):
        for _ in range(500):
            yield chunk
        yield b"overflow"

    transport.get.return_value.iter_content.return_value = oversized_stream()
    transport.get.return_value.content = None
    transport.get.return_value.status = 200

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5,
                                     max_size=400 * 1024)

    with pytest.raises(HttpError, match="size"):
        adapter.download(f"{ASSETS_HOST}/repos/silent-suite/silentsuite/releases")


# ---------------------------------------------------------------------------
# Missing checksum asset
# ---------------------------------------------------------------------------

def test_check_rejects_release_without_checksum_asset():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


# ---------------------------------------------------------------------------
# Checksum parsing
# ---------------------------------------------------------------------------

def test_parse_checksum_rejects_wrong_asset_name():
    from silentsuite_bridge.update.verify import ChecksumError, parse_checksum

    content = _checksum_line(FAKE_64_HEX, ASSET_MACOS_X86_64)

    with pytest.raises(ChecksumError):
        parse_checksum(content, expected_asset_name=ASSET_LINUX_X86_64)


@pytest.mark.parametrize("content", [
    "abc  silentsuite-bridge-linux-x86_64\n",
    FAKE_64_HEX + "\n",
    FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64 extra\n",
    FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64\n"
    + "b" * 64 + "  silentsuite-bridge-linux-x86_64\n",
    "",
    FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64",
])
def test_parse_checksum_rejects_malformed(content):
    from silentsuite_bridge.update.verify import ChecksumError, parse_checksum

    with pytest.raises(ChecksumError):
        parse_checksum(content, expected_asset_name=ASSET_LINUX_X86_64)


def test_parse_checksum_accepts_valid_line():
    from silentsuite_bridge.update.verify import parse_checksum

    result = parse_checksum(
        _checksum_line(FAKE_64_HEX, ASSET_LINUX_X86_64),
        expected_asset_name=ASSET_LINUX_X86_64,
    )
    assert result == FAKE_64_HEX


def test_parse_checksum_normalises_case():
    from silentsuite_bridge.update.verify import parse_checksum

    upper = "A" * 64
    result = parse_checksum(
        _checksum_line(upper, ASSET_LINUX_X86_64),
        expected_asset_name=ASSET_LINUX_X86_64,
    )
    assert result == upper.lower()


# ---------------------------------------------------------------------------
# Checksum match / mismatch
# ---------------------------------------------------------------------------

def test_verify_asset_mismatch_raises():
    from silentsuite_bridge.update.verify import ChecksumError, verify_asset

    with pytest.raises(ChecksumError, match="mismatch"):
        verify_asset(b"content", FAKE_64_HEX)


def test_verify_asset_match_passes():
    from silentsuite_bridge.update.verify import verify_asset

    data = b"binary content"
    verify_asset(data, hashlib.sha256(data).hexdigest())


# ---------------------------------------------------------------------------
# Orchestration: fetch → verify → replace ordering
# ---------------------------------------------------------------------------

def test_orchestrator_calls_fetch_then_verify_then_replace():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge
    replace_bridge(
        http=http, fs=fs,
        platform=Platform("linux", "x86_64"),
        current_exe=current_exe,
        asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
        asset_name=ASSET_LINUX_X86_64,
    )

    assert http.download.call_count == 2
    first_call_url = http.download.call_args_list[0][0][0]
    assert ".sha256" in first_call_url
    fs.replace.assert_called_once()


def test_orchestrator_does_not_replace_on_asset_download_failure():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.download.side_effect = ConnectionError
    fs = _make_fs()
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(ConnectionError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("linux", "x86_64"),
            current_exe=current_exe,
            asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


def test_orchestrator_does_not_replace_on_checksum_parse_failure():
    from silentsuite_bridge.update.types import Platform
    from silentsuite_bridge.update.verify import ChecksumError

    http = MagicMock()
    http.download.return_value = b"not a valid checksum line"
    fs = _make_fs()
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(ChecksumError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("linux", "x86_64"),
            current_exe=current_exe,
            asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
            asset_name=ASSET_LINUX_X86_64,
        )

    assert http.download.call_count == 1
    fs.replace.assert_not_called()


def test_orchestrator_does_not_replace_on_checksum_mismatch():
    from silentsuite_bridge.update.types import Platform
    from silentsuite_bridge.update.verify import ChecksumError

    data = b"real binary"
    wrong_hash = "f" * 64
    http = _make_http_download_for(data, wrong_hash, ASSET_LINUX_X86_64)
    fs = _make_fs()
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(ChecksumError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("linux", "x86_64"),
            current_exe=current_exe,
            asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


# ---------------------------------------------------------------------------
# Oversized download guard
# ---------------------------------------------------------------------------

def test_orchestrator_does_not_replace_on_oversized_download():
    from silentsuite_bridge.update.http import HttpError
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.download.side_effect = HttpError("download size exceeded")
    fs = _make_fs()
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(HttpError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("linux", "x86_64"),
            current_exe=current_exe,
            asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


# ---------------------------------------------------------------------------
# Filesystem: permissions preservation
# ---------------------------------------------------------------------------

def test_fs_replace_preserves_executable_mode():
    fs = _make_fs()
    chmod_calls = []
    fs.chmod.side_effect = lambda *a: chmod_calls.append(a)

    from silentsuite_bridge.update.replace import replace_bridge
    from silentsuite_bridge.update.types import Platform

    data = b"new binary content"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    current_exe = Path("/opt/silentsuite-bridge")

    replace_bridge(
        http=http, fs=fs,
        platform=Platform("linux", "x86_64"),
        current_exe=current_exe,
        asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
        asset_name=ASSET_LINUX_X86_64,
    )

    assert any(
        str(current_exe) in str(args) for args in chmod_calls
    ), "chmod must be called on the final target path"


# ---------------------------------------------------------------------------
# Filesystem: Linux/macOS atomic same-directory rename
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("os_label,exe_path", [
    ("linux", Path("/opt/silentsuite-bridge")),
    ("macos", Path("/usr/local/bin/silentsuite-bridge")),
])
def test_fs_atomic_replace_uses_same_device_rename(os_label, exe_path):
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()

    from silentsuite_bridge.update.replace import replace_bridge
    replace_bridge(
        http=http, fs=fs,
        platform=Platform(os_label, "x86_64"),
        current_exe=exe_path,
        asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
        asset_name=ASSET_LINUX_X86_64,
    )

    stage_call = fs.stage.call_args
    assert stage_call is not None
    stage_dir = Path(stage_call[0][0]).parent
    assert stage_dir == exe_path.parent

    replace_call = fs.replace.call_args
    assert replace_call is not None
    assert replace_call[0][1] == str(exe_path)


# ---------------------------------------------------------------------------
# Filesystem: rollback on rename failure
# ---------------------------------------------------------------------------

def test_fs_replace_rollback_removes_staged_candidate():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    fs.replace.side_effect = OSError(5, "I/O error")
    current_exe = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(OSError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("linux", "x86_64"),
            current_exe=current_exe,
            asset_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_LINUX_X86_64}.sha256",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.cleanup.assert_called()
    fs.remove.assert_not_called()


# ---------------------------------------------------------------------------
# Windows: never renames running exe in-process; writes structured plan
# ---------------------------------------------------------------------------

def test_windows_replace_never_calls_fs_replace_in_process():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    exe_path = Path("C:/Users/test/AppData/Local/SilentSuite/silentsuite-bridge.exe")

    from silentsuite_bridge.update.replace import replace_bridge
    result = replace_bridge(
        http=http, fs=fs,
        platform=Platform("windows", "x86_64"),
        current_exe=exe_path,
        asset_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}.sha256",
        asset_name=ASSET_WINDOWS_X86_64,
    )

    fs.replace.assert_not_called()

    plan_call = fs.write_staging_plan.call_args
    assert plan_call is not None
    plan_arg = plan_call[0][0]
    assert isinstance(plan_arg, dict)
    assert "pid" in plan_arg or "process_id" in plan_arg
    assert "candidate" in plan_arg
    assert "target" in plan_arg
    assert str(plan_arg["target"]) == str(exe_path)

    assert result.needs_manual_completion is True
    assert result.recovery_instruction is not None
    assert str(exe_path) in result.recovery_instruction


def test_windows_staging_plan_includes_backup_path():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    exe_path = Path("C:/Users/test/AppData/Local/SilentSuite/silentsuite-bridge.exe")

    from silentsuite_bridge.update.replace import replace_bridge
    replace_bridge(
        http=http, fs=fs,
        platform=Platform("windows", "x86_64"),
        current_exe=exe_path,
        asset_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}.sha256",
        asset_name=ASSET_WINDOWS_X86_64,
    )

    plan_call = fs.write_staging_plan.call_args
    plan = plan_call[0][0]
    assert "backup" in plan or "rollback" in plan
    backup_value = str(plan.get("backup", plan.get("rollback", "")))
    assert exe_path.parent.as_posix() in Path(backup_value).as_posix()


def test_windows_does_not_write_helper_on_checksum_failure():
    from silentsuite_bridge.update.types import Platform
    from silentsuite_bridge.update.verify import ChecksumError

    http = _make_http_download_for(b"real binary", "f" * 64, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    exe_path = Path("C:/Users/test/AppData/Local/SilentSuite/silentsuite-bridge.exe")

    from silentsuite_bridge.update.replace import replace_bridge

    with pytest.raises(ChecksumError):
        replace_bridge(
            http=http, fs=fs,
            platform=Platform("windows", "x86_64"),
            current_exe=exe_path,
            asset_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}",
            checksum_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}.sha256",
            asset_name=ASSET_WINDOWS_X86_64,
        )

    fs.write_staging_plan.assert_not_called()
    fs.replace.assert_not_called()


def test_windows_plan_is_not_executed_in_process():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    exe_path = Path("C:/Users/test/AppData/Local/SilentSuite/silentsuite-bridge.exe")

    from silentsuite_bridge.update.replace import replace_bridge
    replace_bridge(
        http=http, fs=fs,
        platform=Platform("windows", "x86_64"),
        current_exe=exe_path,
        asset_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}",
        checksum_url=f"{ASSETS_HOST}/{ASSET_WINDOWS_X86_64}.sha256",
        asset_name=ASSET_WINDOWS_X86_64,
    )

    plan_call = fs.write_staging_plan.call_args
    plan = plan_call[0][0]
    assert not isinstance(plan, str), (
        "staging plan must be a structured plan (dict/list), not a raw shell string"
    )

    for method_name in ["exec", "subprocess", "run", "call", "popen"]:
        method = getattr(fs, method_name, None)
        if method is not None:
            method.assert_not_called()


# ---------------------------------------------------------------------------
# Restart
# ---------------------------------------------------------------------------

def test_restart_success_on_linux():
    from silentsuite_bridge.update.restart import RestartResult, restart_bridge

    process = MagicMock()
    process.restart.return_value = RestartResult(success=True, instruction=None)

    result = restart_bridge(
        process=process,
        exe_path=Path("/opt/silentsuite-bridge"),
        platform="linux",
    )

    assert result.success is True
    assert result.instruction is None


def test_restart_failure_returns_exact_instruction():
    from silentsuite_bridge.update.restart import RestartResult, restart_bridge

    process = MagicMock()
    exe_path = Path("/opt/silentsuite-bridge")
    process.restart.return_value = RestartResult(
        success=False,
        instruction=f"Run manually: {exe_path}",
    )

    result = restart_bridge(
        process=process,
        exe_path=exe_path,
        platform="linux",
    )

    assert result.success is False
    assert str(exe_path) in result.instruction


def test_restart_instruction_never_contains_staging_path():
    from silentsuite_bridge.update.restart import RestartResult, restart_bridge

    process = MagicMock()
    process.restart.return_value = RestartResult(
        success=False,
        instruction="Run manually: /tmp/.update-candidate",
    )

    result = restart_bridge(
        process=process,
        exe_path=Path("/opt/silentsuite-bridge"),
        platform="linux",
    )

    assert "/tmp/.update-candidate" not in result.instruction


# ---------------------------------------------------------------------------
# Autostart: path identity
# ---------------------------------------------------------------------------

def test_orchestrator_preserves_autostart_path():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    autostart = MagicMock()
    restart = _make_restart_success()
    exe_path = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update import perform_update
    perform_update(
        http=http, fs=fs,
        autostart=autostart,
        restart=restart,
        platform=Platform("linux", "x86_64"),
        current_exe=exe_path,
        current_version="0.5.4-beta",
        asset_name=ASSET_LINUX_X86_64,
    )

    replace_target = fs.replace.call_args[0][1]
    assert replace_target == str(exe_path)

    autostart.install.assert_not_called()
    autostart.uninstall.assert_not_called()


# ---------------------------------------------------------------------------
# CURRENT / downgrade refuse self-update without I/O
# ---------------------------------------------------------------------------

def test_perform_update_refuses_when_already_current():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.4-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = _make_fs()
    autostart = MagicMock()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="current"):
        perform_update(
            http=http, fs=fs,
            autostart=autostart,
            restart=restart,
            platform=Platform("linux", "x86_64"),
            current_exe=Path("/opt/silentsuite-bridge"),
            current_version="0.5.4-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    http.download.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


def test_perform_update_refuses_downgrade_when_remote_older():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.3-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = _make_fs()
    autostart = MagicMock()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="current"):
        perform_update(
            http=http, fs=fs,
            autostart=autostart,
            restart=restart,
            platform=Platform("linux", "x86_64"),
            current_exe=Path("/opt/silentsuite-bridge"),
            current_version="0.5.4-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    http.download.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


# ---------------------------------------------------------------------------
# Sentinel: no config/cache/credentials/PIM files touched
# ---------------------------------------------------------------------------

def test_orchestrator_only_touches_executable_related_paths():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    restart = _make_restart_success()
    exe_path = Path("/opt/silentsuite-bridge")

    from silentsuite_bridge.update import perform_update
    perform_update(
        http=http, fs=fs,
        autostart=MagicMock(),
        restart=restart,
        platform=Platform("linux", "x86_64"),
        current_exe=exe_path,
        current_version="0.5.4-beta",
        asset_name=ASSET_LINUX_X86_64,
    )

    all_fs_arg_strings = []
    for call_obj in fs.mock_calls:
        all_fs_arg_strings.extend(
            str(a) for a in call_obj.args if isinstance(a, (str, Path))
        )
        all_fs_arg_strings.extend(
            str(v) for v in call_obj.kwargs.values()
            if isinstance(v, (str, Path))
        )

    forbidden = {"settings.json", "credentials.json", "bridge_data.db",
                 "htpasswd", "certificate", "key.pem", ".config", ".cache",
                 "account", "PIM"}
    for arg_str in all_fs_arg_strings:
        for keyword in forbidden:
            assert keyword not in arg_str, (
                f"fs adapter was called with forbidden path containing '{keyword}': {arg_str}"
            )


# ---------------------------------------------------------------------------
# Check-only performs no mutation
# ---------------------------------------------------------------------------

def test_check_only_leaves_fs_autostart_and_restart_untouched():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = MagicMock()
    autostart = MagicMock()
    restart = MagicMock()

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE
    fs.assert_not_called()
    autostart.assert_not_called()
    restart.assert_not_called()


# ---------------------------------------------------------------------------
# Source/development install refuses self-update
# ---------------------------------------------------------------------------

def test_perform_update_refuses_development_version():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = _make_fs()
    autostart = MagicMock()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="development"):
        perform_update(
            http=http, fs=fs,
            autostart=autostart,
            restart=restart,
            platform=Platform("linux", "x86_64"),
            current_exe=Path("/usr/local/bin/silentsuite-bridge"),
            current_version="0.0.0-dev",
            asset_name=ASSET_LINUX_X86_64,
        )

    http.download.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


# ---------------------------------------------------------------------------
# Frozen-install admission (independent of version text)
# ---------------------------------------------------------------------------

def test_perform_update_refuses_non_frozen_with_release_looking_version():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.5-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = _make_fs()
    autostart = MagicMock()
    restart = MagicMock()

    admission = MagicMock()
    admission.is_frozen.return_value = False
    admission.current_exe.return_value = Path("/usr/local/bin/silentsuite-bridge")

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="frozen"):
        perform_update(
            http=http, fs=fs,
            autostart=autostart,
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=Path("/usr/local/bin/silentsuite-bridge"),
            current_version="0.5.3-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    http.download.assert_not_called()
    fs.replace.assert_not_called()


def test_perform_update_refuses_unknown_executable_location():
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = None
    fs = _make_fs()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="executable"):
        perform_update(
            http=MagicMock(), fs=fs,
            autostart=MagicMock(),
            restart=restart,
            admission=admission,
            platform=MagicMock(),
            current_exe=None,
            current_version="0.5.4-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


def test_perform_update_refuses_non_writable_executable():
    from silentsuite_bridge.update.types import Platform

    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = Path("/opt/silentsuite-bridge")
    admission.is_writable.return_value = False
    fs = _make_fs()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="writ"):
        perform_update(
            http=MagicMock(), fs=fs,
            autostart=MagicMock(),
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=Path("/opt/silentsuite-bridge"),
            current_version="0.5.4-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


# ---------------------------------------------------------------------------
# CLI: update flags before config/data-dir/server init
# ---------------------------------------------------------------------------

def _patch_main_for_update_flag(monkeypatch, flag, update_patch_path):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", flag])

    update_spy = MagicMock()
    monkeypatch.setattr(update_patch_path, update_spy, raising=False)

    import silentsuite_bridge.__main__ as bridge_main
    log_spy = MagicMock()
    monkeypatch.setattr(bridge_main, "configure_logging", log_spy)
    from silentsuite_bridge import config
    data_dir_spy = MagicMock()
    monkeypatch.setattr(config, "ensure_data_dir", data_dir_spy)
    server_spy = MagicMock()
    monkeypatch.setattr(bridge_main, "run_server", server_spy)
    validate_spy = MagicMock()
    monkeypatch.setattr(bridge_main, "validate_radicale_ssl_schema", validate_spy)

    return {
        "log": log_spy, "data_dir": data_dir_spy,
        "server": server_spy, "validate": validate_spy,
    }


def test_cli_check_update_skips_config_and_server_init(monkeypatch):
    spies = _patch_main_for_update_flag(
        monkeypatch, "--check-update",
        "silentsuite_bridge.update.check_for_update",
    )

    import silentsuite_bridge.__main__ as bridge_main

    with pytest.raises(SystemExit):
        bridge_main.main()

    spies["log"].assert_not_called()
    spies["validate"].assert_not_called()
    spies["data_dir"].assert_not_called()
    spies["server"].assert_not_called()


def test_cli_self_update_skips_config_and_server_init(monkeypatch):
    spies = _patch_main_for_update_flag(
        monkeypatch, "--self-update",
        "silentsuite_bridge.update.perform_update",
    )

    import silentsuite_bridge.__main__ as bridge_main

    with pytest.raises(SystemExit):
        bridge_main.main()

    spies["log"].assert_not_called()
    spies["data_dir"].assert_not_called()
    spies["server"].assert_not_called()


def test_cli_help_invocation_lists_update_flags(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--help"])

    import silentsuite_bridge.__main__ as bridge_main

    with pytest.raises(SystemExit):
        bridge_main.main()

    stdout = capsys.readouterr().out
    assert "--check-update" in stdout
    assert "--self-update" in stdout


# ---------------------------------------------------------------------------
# Workflow: Linux CI
# ---------------------------------------------------------------------------

def test_linux_workflow_runs_full_bridge_tests():
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    content = (workflows / "test-bridge-linux.yml").read_text()

    assert "pytest tests/" in content
    assert "python -m pytest" in content


# ---------------------------------------------------------------------------
# Workflow: Windows CI executes bridge update contract tests
# ---------------------------------------------------------------------------

def test_windows_workflow_executes_update_contract_tests():
    workflows = Path(__file__).resolve().parents[3] / ".github" / "workflows"
    content = (workflows / "test-bridge-windows.yml").read_text()

    assert "bridge/tests/test_update_contract.py" in content, (
        "Windows workflow must run the update contract tests"
    )
