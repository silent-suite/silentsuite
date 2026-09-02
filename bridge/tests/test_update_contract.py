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
"""

import hashlib
import json
import os
import stat
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
    # Deterministic real st_mode default — regular file, rwxr-xr-x
    fs.stat_mode.return_value = stat.S_IFREG | 0o755
    return fs


def _make_http_download_for(data, checksum_hex, asset_name, remote_version="99.0.0"):
    """Fake HTTP adapter: one newer compatible release with an exact
    checksum sidecar, plus the checksum-then-binary download sequence."""
    http = MagicMock()
    http.fetch_releases.return_value = [
        _release(f"v{remote_version}",
                 assets=[asset_name, f"{asset_name}.sha256"]),
    ]
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
# Check: newer / current / downgrade / dev — exact-same and older-remote
# are distinct statuses
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


def test_check_reports_downgrade_when_remote_is_older():
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

    assert result.status == UpdateStatus.DOWNGRADE


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
    ("0.5.5-beta",   "0.5.4-beta",   "DOWNGRADE"),
    ("0.5.4-beta.1", "0.5.4-beta",   "DOWNGRADE"),
    ("0.5.4-beta",   "0.5.4-beta.1", "AVAILABLE"),
    ("0.5.5-rc1",    "0.5.5",        "AVAILABLE"),
    ("0.5.5",        "0.5.5-rc1",    "DOWNGRADE"),
    ("0.5.4",        "0.5.5-beta",   "AVAILABLE"),
    ("0.5.5-beta",   "0.5.4",        "DOWNGRADE"),
    ("0.5.5-alpha",  "0.5.5-beta",   "AVAILABLE"),
    ("0.5.5-beta",   "0.5.5-alpha",  "DOWNGRADE"),
    # Strict SemVer: numeric prerelease identifiers sort lower than
    # non-numeric identifiers
    ("0.5.5-1",      "0.5.5-alpha",  "AVAILABLE"),
    ("0.5.5-alpha",  "0.5.5-1",      "DOWNGRADE"),
    # Exact-same version is CURRENT, never DOWNGRADE
    ("0.5.4",        "0.5.4",        "CURRENT"),
    ("0.5.4-beta",   "0.5.4-beta",   "CURRENT"),
    # Build metadata is ignored for precedence (SemVer 2.0)
    ("0.5.4",        "0.5.4+build.7", "CURRENT"),
    ("0.5.4+local.1", "0.5.4",       "CURRENT"),
    ("0.5.4+local.1", "0.5.5",       "AVAILABLE"),
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


def test_check_rejects_malformed_remote_version():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("vnot-a-version", assets=[ASSET_LINUX_X86_64,
                                            f"{ASSET_LINUX_X86_64}.sha256"]),
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    # Malformed tag is skipped; no compatible release found
    assert result.status == UpdateStatus.MISSING_ASSET


def test_check_reports_development_for_malformed_current_version():
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = AssertionError("must not reach network")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="not-a-version",
    )

    assert result.status == UpdateStatus.DEVELOPMENT


@pytest.mark.parametrize("bad_current", [
    "",
    "abc",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-",
    "1.2.3-01",
    "1.2.3+meta+extra",
])
def test_check_rejects_invalid_current_version_grammar_without_network(bad_current):
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = AssertionError("must not reach network")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version=bad_current,
    )

    assert result.status == UpdateStatus.DEVELOPMENT
    http.fetch_releases.assert_not_called()


@pytest.mark.parametrize("reserved", ["0.0.0-dev", "0.0.0"])
def test_check_reserved_development_stamps_never_reach_network(reserved):
    """The development stamp and the unknown placeholder satisfy the
    SemVer grammar but must still classify as development, pre-network."""
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    http = MagicMock()
    http.fetch_releases.side_effect = AssertionError("must not reach network")

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version=reserved,
    )

    assert result.status == UpdateStatus.DEVELOPMENT
    http.fetch_releases.assert_not_called()


def test_check_skips_malformed_release_objects_without_error():
    """Release JSON fields are validated with .get(); no KeyError paths."""
    from silentsuite_bridge.update.types import Platform, UpdateStatus

    good_assets = [
        {"name": ASSET_LINUX_X86_64, "browser_download_url": f"{ASSETS_HOST}/bin"},
        {"name": f"{ASSET_LINUX_X86_64}.sha256",
         "browser_download_url": f"{ASSETS_HOST}/bin.sha256"},
    ]
    http = MagicMock()
    http.fetch_releases.return_value = [
        "not-a-release-object",                    # non-dict entry
        {},                                        # nothing at all
        {"tag_name": 42, "assets": good_assets},   # non-string tag
        {"tag_name": "v0.9.9"},                    # missing assets key
        {"tag_name": "v0.9.9", "assets": "nope"},  # assets not a list
        {"tag_name": "v0.9.9",                     # assets missing URLs
         "assets": [{"name": ASSET_LINUX_X86_64},
                    {"name": f"{ASSET_LINUX_X86_64}.sha256"}]},
        {"tag_name": "v0.9.09", "assets": good_assets},  # leading zero
    ]

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.MISSING_ASSET


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
# API timeout, HTTP failure, malformed JSON — sanitized messages
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
    # error_message must not contain raw exception text, URL, or path
    assert result.error_message is not None
    assert "Could not fetch" in result.error_message or "Could not" in result.error_message
    assert "TimeoutError" not in (result.error_message or "")


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
    assert result.error_message is not None
    assert "403" not in (result.error_message or "")
    assert "Forbidden" not in (result.error_message or "")


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
    # Every response in the chain must be closed
    for response in redirect_responses:
        response.close.assert_called()


def test_http_adapter_rejects_disallowed_redirect_host():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(
        status=302,
        headers={"Location": "https://evil.example.com/malware"},
    )

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError, match="disallowed"):
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


def test_http_adapter_enforces_total_deadline_while_streaming():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    now = [0.0]

    def clock():
        return now[0]

    def delayed_stream():
        now[0] = 4.0
        yield b"late chunk"

    response = MagicMock(status=200, content=None)
    response.iter_content.return_value = delayed_stream()
    transport = MagicMock()
    transport.get.return_value = response
    adapter = SilentSuiteHttpAdapter(
        transport=transport,
        timeout=2,
        total_timeout=3,
        clock=clock,
    )

    with pytest.raises(HttpError, match="timed out"):
        adapter.download(f"{ASSETS_HOST}/bin")

    response.close.assert_called()


def test_http_adapter_shares_total_deadline_across_redirect_hops():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    now = [0.0]
    timeouts = []

    def clock():
        return now[0]

    def get(_url, *, timeout):
        timeouts.append(timeout)
        now[0] += 2.0
        return MagicMock(
            status=302,
            headers={"Location": f"{GITHUB_HOST}/next"},
        )

    transport = MagicMock()
    transport.get.side_effect = get
    adapter = SilentSuiteHttpAdapter(
        transport=transport,
        timeout=2,
        total_timeout=3,
        max_redirects=5,
        clock=clock,
    )

    with pytest.raises(HttpError, match="timed out"):
        adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")

    assert timeouts == [2, 1]


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


def test_http_adapter_rejects_non_2xx_status():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(status=404, content=b"not found")

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)
    with pytest.raises(HttpError):
        adapter.download(f"{ASSETS_HOST}/bin")


def test_http_adapter_rejects_redirect_without_location():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(status=302, headers={})

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)
    with pytest.raises(HttpError):
        adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")


def test_http_adapter_wraps_transport_errors_as_http_error():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.side_effect = RuntimeError("unexpected transport failure")

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)
    with pytest.raises(HttpError, match="Network"):
        adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")


def test_http_adapter_rejects_non_https_url_before_any_request():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError, match="HTTPS"):
        adapter.download("http://api.github.com/repos/silent-suite/silentsuite/releases")

    transport.get.assert_not_called()


def test_http_adapter_rejects_redirect_to_non_https():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(
        status=302,
        headers={"Location": "http://github.com/downgraded"},
    )

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError, match="HTTPS"):
        adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")

    # Only the first hop was requested; the insecure hop was refused
    assert transport.get.call_count == 1


def test_http_adapter_closes_response_on_non_2xx():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    response = MagicMock(status=500, content=b"error body")
    transport = MagicMock()
    transport.get.return_value = response

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)
    with pytest.raises(HttpError):
        adapter.download(f"{ASSETS_HOST}/bin")

    response.close.assert_called()


def test_http_adapter_closes_response_when_iter_content_overflows():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    def stream(*args, **kwargs):
        while True:
            yield b"x" * 65536

    response = MagicMock(status=200, content=None)
    response.iter_content.side_effect = stream
    transport = MagicMock()
    transport.get.return_value = response

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5,
                                     max_size=128 * 1024)
    with pytest.raises(HttpError, match="size"):
        adapter.download(f"{ASSETS_HOST}/bin")

    response.close.assert_called()


def test_real_urllib_opener_never_follows_redirects(monkeypatch):
    """The urllib opener must be built with a redirect handler that
    returns 3xx responses unfollowed, for every redirect status."""
    import urllib.request

    from silentsuite_bridge.update.http import SilentSuiteHttpAdapter

    captured = {}

    class FakeOpener:
        def open(self, req, timeout=None):
            response = MagicMock(status=200, headers={})
            response.read.side_effect = [b"payload", b""]
            return response

    def fake_build_opener(*handlers):
        captured["handlers"] = handlers
        return FakeOpener()

    monkeypatch.setattr(urllib.request, "build_opener", fake_build_opener)

    adapter = SilentSuiteHttpAdapter()
    result = adapter.download(f"{GITHUB_API}/repos/silent-suite/silentsuite/releases")

    assert result == b"payload"

    redirect_handlers = [
        h for h in captured["handlers"]
        if isinstance(h, urllib.request.HTTPRedirectHandler)
    ]
    assert len(redirect_handlers) == 1
    handler = redirect_handlers[0]

    sentinel = object()
    for method in ("http_error_301", "http_error_302", "http_error_303",
                   "http_error_307", "http_error_308"):
        assert getattr(handler, method)(None, sentinel, 0, "", {}) is sentinel, (
            f"{method} must return the response unfollowed"
        )


def test_fetch_releases_rejects_invalid_json_with_bounded_error():
    """A 200 response with invalid JSON must raise a bounded HttpError
    through the production parsing path, without echoing the payload."""
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    payload = b"<html>definitely not JSON</html>"
    transport = MagicMock()
    transport.get.return_value = MagicMock(status=200, content=payload)

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError) as excinfo:
        adapter.fetch_releases()

    message = str(excinfo.value)
    assert "JSON" in message
    assert "definitely not JSON" not in message
    assert "<html>" not in message


def test_fetch_releases_rejects_non_list_json():
    from silentsuite_bridge.update.http import HttpError, SilentSuiteHttpAdapter

    transport = MagicMock()
    transport.get.return_value = MagicMock(
        status=200, content=b'{"message": "Not Found"}',
    )

    adapter = SilentSuiteHttpAdapter(transport=transport, timeout=30, max_redirects=5)

    with pytest.raises(HttpError, match="not a list"):
        adapter.fetch_releases()


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
# Checksum parsing — sanitized messages, non-UTF-8 rejection
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
    FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64",   # no newline
    FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64\n\n",  # extra blank line
    "\n" + FAKE_64_HEX + "  silentsuite-bridge-linux-x86_64\n",  # leading blank
    FAKE_64_HEX + " silentsuite-bridge-linux-x86_64\n",  # single-space separator
    "g" * 64 + "  silentsuite-bridge-linux-x86_64\n",    # non-hex digest
    "0x" + "a" * 62 + "  silentsuite-bridge-linux-x86_64\n",  # 0x-prefixed
    "+" + "a" * 63 + "  silentsuite-bridge-linux-x86_64\n",   # signed "hex"
])
def test_parse_checksum_rejects_malformed(content):
    from silentsuite_bridge.update.verify import ChecksumError, parse_checksum

    with pytest.raises(ChecksumError):
        parse_checksum(content, expected_asset_name=ASSET_LINUX_X86_64)


def test_parse_checksum_rejects_non_utf8():
    from silentsuite_bridge.update.verify import ChecksumError, parse_checksum

    with pytest.raises(ChecksumError):
        parse_checksum(b"\xff\xfe" + FAKE_64_HEX.encode() + b"  bin\n",
                       expected_asset_name="bin")


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
# Checksum match / mismatch — sanitized
# ---------------------------------------------------------------------------

def test_verify_asset_mismatch_raises():
    from silentsuite_bridge.update.verify import ChecksumError, verify_asset

    with pytest.raises(ChecksumError, match="mismatch"):
        verify_asset(b"content", FAKE_64_HEX)


def test_verify_asset_mismatch_does_not_echo_digests():
    from silentsuite_bridge.update.verify import ChecksumError, verify_asset

    payload = b"untrusted payload"
    with pytest.raises(ChecksumError) as excinfo:
        verify_asset(payload, FAKE_64_HEX)

    message = str(excinfo.value)
    assert FAKE_64_HEX not in message
    assert hashlib.sha256(payload).hexdigest() not in message
    assert "untrusted payload" not in message


def test_verify_asset_match_passes():
    from silentsuite_bridge.update.verify import verify_asset

    data = b"binary content"
    verify_asset(data, hashlib.sha256(data).hexdigest())


# ---------------------------------------------------------------------------
# Orchestration: fetch → verify → replace ordering
# ---------------------------------------------------------------------------

def test_orchestrator_calls_fetch_then_verify_then_replace():
    from silentsuite_bridge.update.fs import FilesystemAdapter
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = FilesystemAdapter()
    fs.stage = MagicMock(return_value="/tmp/staged")
    fs.replace = MagicMock()
    fs.chmod = MagicMock()
    fs.stat_mode = MagicMock(return_value=stat.S_IFREG | 0o755)
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
# Filesystem: permissions preservation (original mode, no hard-coded 0755)
# ---------------------------------------------------------------------------

def test_fs_replace_preserves_original_executable_mode():
    from silentsuite_bridge.update.fs import FilesystemAdapter
    from silentsuite_bridge.update.types import Platform

    data = b"new binary content"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = FilesystemAdapter()
    fs.stage = MagicMock(return_value="/tmp/staged")
    fs.replace = MagicMock()
    fs.chmod = MagicMock()
    orig_mode = stat.S_IFREG | 0o750  # regular file, rwxr-x---
    fs.stat_mode = MagicMock(return_value=orig_mode)
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

    # stat_mode was called to read the original
    fs.stat_mode.assert_called_once_with(str(current_exe))
    # chmod applied exactly stat.S_IMODE of the original to the candidate
    fs.chmod.assert_called_once_with("/tmp/staged", 0o750)
    assert stat.S_IMODE(orig_mode) == 0o750
    # replace happened
    fs.replace.assert_called_once()


def test_fs_mode_read_failure_fails_before_any_mutation():
    """A failed original-mode read must fail closed: no staging, no replace."""
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    fs.stat_mode.side_effect = OSError(13, "Permission denied")
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

    fs.stage.assert_not_called()
    fs.replace.assert_not_called()


def test_fs_mode_apply_failure_removes_candidate_and_fails():
    """A failed chmod on the candidate must remove it and never replace."""
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    fs.stat_mode.return_value = stat.S_IFREG | 0o755
    fs.chmod.side_effect = OSError(1, "Operation not permitted")
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

    fs.remove.assert_called_once_with("/tmp/.update-staged")
    fs.replace.assert_not_called()


# ---------------------------------------------------------------------------
# Filesystem: Linux/macOS atomic same-directory rename
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("os_label,exe_path", [
    ("linux", Path("/opt/silentsuite-bridge")),
    ("macos", Path("/usr/local/bin/silentsuite-bridge")),
])
def test_fs_atomic_replace_uses_same_device_rename(os_label, exe_path):
    from silentsuite_bridge.update.fs import FilesystemAdapter
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = FilesystemAdapter()
    fs.stage = MagicMock(return_value=str(exe_path.parent / ".staged"))
    fs.replace = MagicMock()
    fs.chmod = MagicMock()
    fs.stat_mode = MagicMock(return_value=stat.S_IFREG | 0o755)

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

    fs.remove.assert_called()


# ---------------------------------------------------------------------------
# Filesystem: real staging behaviour (private mode, cleanup on failure)
# ---------------------------------------------------------------------------

def test_fs_stage_writes_private_candidate_in_target_directory(tmp_path):
    from silentsuite_bridge.update.fs import FilesystemAdapter

    fs = FilesystemAdapter()
    target = tmp_path / "silentsuite-bridge"
    target.write_bytes(b"old binary")

    staged = fs.stage(str(target), b"new binary")
    staged_path = Path(staged)

    assert staged_path.parent == tmp_path
    assert staged_path.name.endswith(".update-staged")
    assert staged_path.read_bytes() == b"new binary"
    assert target.read_bytes() == b"old binary"
    if os.name == "posix":
        assert stat.S_IMODE(os.stat(staged).st_mode) == 0o600


def test_fs_stage_removes_partial_file_on_error(tmp_path, monkeypatch):
    from silentsuite_bridge.update.fs import FilesystemAdapter

    fs = FilesystemAdapter()
    target = tmp_path / "silentsuite-bridge"
    target.write_bytes(b"old binary")

    def failing_fsync(fd):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(os, "fsync", failing_fsync)

    with pytest.raises(OSError):
        fs.stage(str(target), b"new binary")

    leftovers = [p for p in tmp_path.iterdir() if p != target]
    assert leftovers == []
    assert target.read_bytes() == b"old binary"


# ---------------------------------------------------------------------------
# Windows: never renames running exe in-process; writes structured plan
# helper reads plan from argv, not interpolated paths
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
    assert "pid" in plan_arg
    assert "candidate" in plan_arg
    assert "target" in plan_arg
    assert str(plan_arg["target"]) == str(exe_path)

    # A launched helper means the swap is pending, not complete
    assert result.success is True
    assert result.pending_completion is True
    # Recovery instruction must never expose staging paths
    if result.recovery_instruction:
        assert ".update-staged" not in result.recovery_instruction
        assert "/tmp/" not in result.recovery_instruction


def test_windows_helper_written_then_plan():
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

    # Helper written, plan written, helper launched
    assert fs.write_windows_helper.called
    assert fs.write_staging_plan.called
    assert fs.launch_helper.called

    # Helper must receive plan_path as an arg (static helper, no path interpolation)
    launch_call = fs.launch_helper.call_args
    assert launch_call is not None
    # kwargs should contain plan_path
    assert "plan_path" in launch_call[1] or len(launch_call[0]) >= 2


def test_windows_plan_includes_backup_same_directory():
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
    assert "backup" in plan
    backup_value = Path(plan["backup"])
    assert backup_value.parent == exe_path.parent


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


def test_windows_helper_launch_failure_preserves_original():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    fs.launch_helper.return_value = False
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
    # Launch failure is a failure, and nothing remains pending
    assert result.success is False
    assert result.pending_completion is False
    assert result.recovery_instruction is not None
    assert str(exe_path) in result.recovery_instruction
    # Never instruct staging path execution
    assert ".update-staged" not in (result.recovery_instruction or "")
    assert "/tmp/" not in (result.recovery_instruction or "")
    # All private staging artifacts (candidate, plan, helper) were removed
    removed = [call.args[0] for call in fs.remove.call_args_list]
    assert Path("/tmp/.update-staged") in removed
    assert fs.write_staging_plan.return_value in removed
    assert fs.write_windows_helper.return_value in removed


# ---------------------------------------------------------------------------
# Windows helper generation: static, validating, private
# ---------------------------------------------------------------------------

def _write_plan_and_helper(tmp_path):
    from silentsuite_bridge.update.fs import FilesystemAdapter

    fs = FilesystemAdapter()
    target = tmp_path / "silentsuite-bridge.exe"
    candidate = tmp_path / "tmp1234.update-staged"
    candidate.write_bytes(b"candidate")
    plan = {
        "pid": 4242,
        "candidate": str(candidate),
        "target": str(target),
        "backup": str(target) + ".update-backup",
    }
    plan_path = fs.write_staging_plan(plan)
    helper_path = fs.write_windows_helper(plan_path)
    return plan, plan_path, helper_path


def test_windows_helper_source_is_static_with_no_embedded_paths(tmp_path):
    plan, plan_path, helper_path = _write_plan_and_helper(tmp_path)

    content = Path(helper_path).read_text(encoding="utf-8")

    # The helper reads the plan from its first argument only — no plan,
    # candidate, target, or backup path is embedded in the script source.
    assert str(tmp_path) not in content
    assert "param(" in content
    assert "$PlanFile" in content
    assert "ConvertFrom-Json" in content


def test_windows_helper_validates_plan_and_bounds_wait(tmp_path):
    _plan, _plan_path, helper_path = _write_plan_and_helper(tmp_path)

    content = Path(helper_path).read_text(encoding="utf-8")

    # $plan_dir is assigned before it is ever compared against
    assert content.index("$plan_dir = ") < content.index("-ne $plan_dir")
    # absolute-path, suffix, and same-directory validation
    assert "must be absolute" in content
    assert ".EndsWith('.update-staged')" in content
    assert "Split-Path -Path $Candidate -Parent" in content
    assert "Split-Path -Path $Backup -Parent" in content
    # bounded wait that aborts (exit 1) if the old process never exits
    assert "$WaitSeconds" in content
    assert "WaitForExit" in content
    assert "if (-not $exited) {" in content
    # a vanished target fails closed before backup — no install without a
    # rollback source
    assert "if (-not (Test-Path -Path $Target)) {" in content
    assert (content.index("if (-not (Test-Path -Path $Target)) {")
            < content.index("Move-Item -Force -Path $Target -Destination $Backup"))
    # backup, rollback, and exact-target restart
    assert "Move-Item -Force -Path $Target -Destination $Backup" in content
    assert "Move-Item -Force -Path $Backup -Destination $Target" in content
    assert "Start-Process -FilePath $Target" in content
    # The rollback backup survives until process creation succeeds, and a
    # failed restart restores it before giving the target-only instruction.
    start_index = content.index("Start-Process -FilePath $Target")
    remove_backup_index = content.index("Remove-Item -Force -Path $Backup")
    restart_restore_index = content.rindex(
        "Move-Item -Force -Path $Backup -Destination $Target"
    )
    assert remove_backup_index > start_index
    assert restart_restore_index > start_index


def test_windows_plan_and_helper_are_private_files(tmp_path):
    plan, plan_path, helper_path = _write_plan_and_helper(tmp_path)

    # Structured JSON plan round-trips with exact paths
    loaded = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    assert loaded["pid"] == plan["pid"]
    assert loaded["candidate"] == plan["candidate"]
    assert loaded["target"] == plan["target"]
    assert loaded["backup"] == plan["backup"]

    if os.name == "posix":
        assert stat.S_IMODE(os.stat(plan_path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(helper_path).st_mode) == 0o600


@pytest.mark.skipif(sys.platform != "win32",
                    reason="requires the Windows PowerShell parser")
def test_windows_helper_parses_cleanly_without_execution(tmp_path):
    """Parse the generated helper with the PowerShell language parser.

    The script is never executed — parse errors alone fail the test.
    """
    import subprocess

    _plan, _plan_path, helper_path = _write_plan_and_helper(tmp_path)

    parse_command = (
        "$toks = $null; $errs = $null; "
        "[System.Management.Automation.Language.Parser]::ParseFile("
        "$env:SS_UPDATE_HELPER, [ref]$toks, [ref]$errs) | Out-Null; "
        "if ($errs -and $errs.Count -gt 0) { "
        "$errs | ForEach-Object { Write-Output $_.Message }; exit 1 }; "
        "exit 0"
    )
    env = dict(os.environ)
    env["SS_UPDATE_HELPER"] = str(helper_path)
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive",
         "-Command", parse_command],
        env=env, capture_output=True, text=True, timeout=120,
    )
    assert completed.returncode == 0, (
        f"PowerShell parse errors:\n{completed.stdout}\n{completed.stderr}"
    )


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
# Autostart: path identity (adapter is never called in perform_update)
# ---------------------------------------------------------------------------

def test_orchestrator_never_calls_autostart():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    fs.stat_mode = MagicMock(return_value=stat.S_IFREG | 0o755)
    restart = _make_restart_success()
    exe_path = Path("/opt/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update
    perform_update(
        http=http, fs=fs,
        restart=restart,
        admission=admission,
        platform=Platform("linux", "x86_64"),
        current_exe=exe_path,
        current_version="0.5.4-beta",
        asset_name=ASSET_LINUX_X86_64,
    )

    # The replace target must be the same installed path
    replace_target = fs.replace.call_args[0][1]
    assert replace_target == str(exe_path)


# ---------------------------------------------------------------------------
# CURRENT and DOWNGRADE always refuse self-update (no force override)
# ---------------------------------------------------------------------------

def test_perform_update_refuses_same_version():
    from silentsuite_bridge.update.types import Platform

    http = MagicMock()
    http.fetch_releases.return_value = [
        _release("v0.5.4-beta", assets=[ASSET_LINUX_X86_64,
                                         f"{ASSET_LINUX_X86_64}.sha256"]),
    ]
    fs = _make_fs()
    restart = MagicMock()
    exe_path = Path("/opt/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="current"):
        perform_update(
            http=http, fs=fs,
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=exe_path,
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
    restart = MagicMock()
    exe_path = Path("/opt/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="downgrade"):
        perform_update(
            http=http, fs=fs,
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=exe_path,
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
    fs.stat_mode = MagicMock(return_value=stat.S_IFREG | 0o755)
    restart = _make_restart_success()
    exe_path = Path("/opt/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update
    perform_update(
        http=http, fs=fs,
        restart=restart,
        admission=admission,
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
    restart = MagicMock()

    from silentsuite_bridge.update import check_for_update
    result = check_for_update(
        http=http,
        platform=Platform("linux", "x86_64"),
        current_version="0.5.4-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE
    fs.assert_not_called()
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
    restart = MagicMock()
    exe_path = Path("/usr/local/bin/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="development"):
        perform_update(
            http=http, fs=fs,
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=exe_path,
            current_version="0.0.0-dev",
            asset_name=ASSET_LINUX_X86_64,
        )

    # Refused at admission — before the release fetch and any download
    http.fetch_releases.assert_not_called()
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
    restart = MagicMock()

    admission = MagicMock()
    admission.is_frozen.return_value = False
    admission.current_exe.return_value = Path("/usr/local/bin/silentsuite-bridge")

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="frozen"):
        perform_update(
            http=http, fs=fs,
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

    exe_path = Path("/opt/silentsuite-bridge")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = False
    fs = _make_fs()
    restart = MagicMock()

    from silentsuite_bridge.update import perform_update

    with pytest.raises(RuntimeError, match="writ"):
        perform_update(
            http=MagicMock(), fs=fs,
            restart=restart,
            admission=admission,
            platform=Platform("linux", "x86_64"),
            current_exe=exe_path,
            current_version="0.5.4-beta",
            asset_name=ASSET_LINUX_X86_64,
        )

    fs.replace.assert_not_called()


# ---------------------------------------------------------------------------
# No double restart on Windows in perform_update
# ---------------------------------------------------------------------------

def test_perform_update_does_not_restart_windows():
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_WINDOWS_X86_64)
    fs = _make_fs()
    restart = MagicMock()
    exe_path = Path("C:/Users/test/AppData/Local/SilentSuite/silentsuite-bridge.exe")
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update
    result = perform_update(
        http=http, fs=fs,
        restart=restart,
        admission=admission,
        platform=Platform("windows", "x86_64"),
        current_exe=exe_path,
        current_version="0.5.4-beta",
        asset_name=ASSET_WINDOWS_X86_64,
    )

    restart.restart.assert_not_called()
    # The helper owns completion after process exit
    assert result.success is True
    assert result.pending_completion is True


# ---------------------------------------------------------------------------
# POSIX restart failure surfaces only the central target-only instruction
# ---------------------------------------------------------------------------

def test_perform_update_restart_failure_returns_target_only_instruction():
    from silentsuite_bridge.update.restart import RestartResult
    from silentsuite_bridge.update.types import Platform

    data = b"new binary"
    expected = hashlib.sha256(data).hexdigest()
    http = _make_http_download_for(data, expected, ASSET_LINUX_X86_64)
    fs = _make_fs()
    fs.stat_mode = MagicMock(return_value=stat.S_IFREG | 0o755)
    exe_path = Path("/opt/silentsuite-bridge")
    restart = MagicMock()
    # Adapter misbehaves and leaks a staging path; the wrapper must
    # discard it and rebuild the instruction from the installed target.
    restart.restart.return_value = RestartResult(
        success=False,
        instruction="Run manually: /tmp/.update-staged",
    )
    admission = MagicMock()
    admission.is_frozen.return_value = True
    admission.current_exe.return_value = exe_path
    admission.is_writable.return_value = True

    from silentsuite_bridge.update import perform_update
    result = perform_update(
        http=http, fs=fs,
        restart=restart,
        admission=admission,
        platform=Platform("linux", "x86_64"),
        current_exe=exe_path,
        current_version="0.5.4-beta",
        asset_name=ASSET_LINUX_X86_64,
    )

    assert result.success is True
    assert result.recovery_instruction == f"Run manually: {exe_path}"
    assert ".update-staged" not in result.recovery_instruction


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


@pytest.mark.parametrize("status_name,expected_exit,expected_snippet", [
    ("AVAILABLE",     0, "Update available"),
    ("CURRENT",       0, "Up to date."),
    ("DOWNGRADE",     0, "newer than"),
    ("DEVELOPMENT",   0, "Development build"),
    ("UNSUPPORTED",   1, "not supported"),
    ("MISSING_ASSET", 1, "No compatible release asset"),
    ("FAILURE",       1, "Update check failed"),
])
def test_cli_check_update_exit_codes_and_output(monkeypatch, capsys,
                                                status_name, expected_exit,
                                                expected_snippet):
    """--check-update prints the running version for every result and
    exits zero for informational results, nonzero for failure states."""
    import silentsuite_bridge.__main__ as bridge_main
    import silentsuite_bridge.update as update_pkg
    from silentsuite_bridge.update.types import CheckResult, UpdateStatus

    result = CheckResult(
        status=UpdateStatus[status_name],
        current_version="0.5.4-beta",
        tag_name="v0.5.5-beta",
    )
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--check-update"])
    monkeypatch.setattr(update_pkg, "check_for_update",
                        MagicMock(return_value=result))

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    assert excinfo.value.code == expected_exit
    stdout = capsys.readouterr().out
    # The running version is always printed, whatever the outcome
    assert "v0.5.4-beta" in stdout
    assert expected_snippet in stdout


def test_cli_rejects_contradictory_update_flags(monkeypatch, capsys):
    import silentsuite_bridge.__main__ as bridge_main

    monkeypatch.setattr(
        sys, "argv",
        ["silentsuite-bridge", "--check-update", "--self-update"],
    )

    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()

    assert excinfo.value.code == 1
    stderr = capsys.readouterr().err
    assert "--check-update" in stderr
    assert "--self-update" in stderr


# ---------------------------------------------------------------------------
# Workflow: Linux CI
# ---------------------------------------------------------------------------

def test_linux_workflow_runs_full_bridge_tests():
    workflows = Path(__file__).resolve().parents[2] / ".github" / "workflows"
    content = (workflows / "test-bridge-linux.yml").read_text()

    assert "pytest tests/" in content
    assert "python -m pytest" in content


# ---------------------------------------------------------------------------
# Workflow: Windows CI executes bridge update contract tests
# ---------------------------------------------------------------------------

def test_windows_workflow_executes_update_contract_tests():
    workflows = Path(__file__).resolve().parents[2] / ".github" / "workflows"
    content = (workflows / "test-bridge-windows.yml").read_text()

    # The suite runs with working-directory: bridge
    assert "tests/test_update_contract.py" in content, (
        "Windows workflow must run the update contract tests"
    )
    assert "working-directory: bridge" in content
