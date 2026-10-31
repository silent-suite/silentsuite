"""Characterization of the two Bridge update commands' failure boundaries.

`--check-update` and `--self-update` are separate entry points in
``silentsuite_bridge.__main__`` with separate exception handling. These tests
drive the real CLI and the real ``check_for_update`` / ``perform_update``
functions through their existing injected seams (http, fs, restart, admission,
platform, current version) and record which message and exit code each
failure class reaches today.

They are passing characterization controls on current source, except the
final availability regression, which is expected to fail until the release
fetch fits the unchanged response bound. None of them reproduces a customer
incident, and they say nothing about frozen packages or published release
assets. No real network, filesystem replacement,
launchd or process mutation happens here.
"""

import hashlib
import os
import ssl
import stat
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

CURRENT = "0.5.12-beta"
NEWER = "0.5.17-beta"
ASSETS_HOST = "https://release-assets.githubusercontent.com"
MAC_ASSET = "silentsuite-bridge-macos-x86_64"
MAC_EXE = Path("/Applications/SilentSuite/silentsuite-bridge-macos-x86_64")

CHECK_CATCH_ALL = "Error: update check failed."
SELF_CATCH_ALL = "Error: update failed; the installed Bridge was preserved."

# A marker placed in raised exception text. It must never reach CLI output.
PRIVATE_MARKER = "private-marker-7f3a"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _release(version, assets):
    return {
        "tag_name": f"v{version}",
        "draft": False,
        "assets": [
            {"name": name, "browser_download_url": f"{ASSETS_HOST}/{name}"}
            for name in assets
        ],
    }


def _checksum_line(hex_digest, asset_name):
    return f"{hex_digest}  {asset_name}\n".encode()


def _mac():
    from silentsuite_bridge.update.types import Platform
    return Platform("macos", "x86_64")


def _admission(exe=MAC_EXE, *, frozen=True, writable=True):
    admission = MagicMock()
    admission.is_frozen.return_value = frozen
    admission.current_exe.return_value = exe
    admission.is_writable.return_value = writable
    return admission


def _fs():
    fs = MagicMock()
    fs.stage.return_value = "/Applications/SilentSuite/tmp.update-staged"
    fs.stat_mode.return_value = stat.S_IFREG | 0o755
    return fs


def _restart(success=True):
    from silentsuite_bridge.update.restart import RestartResult
    restart = MagicMock()
    restart.restart.return_value = RestartResult(
        success=success,
        instruction=None if success else "adapter text is discarded",
    )
    return restart


def _http(remote=NEWER, *, assets=(MAC_ASSET, f"{MAC_ASSET}.sha256"),
          downloads=None):
    http = MagicMock()
    http.fetch_releases.return_value = [_release(remote, list(assets))]
    if downloads is not None:
        http.download.side_effect = downloads
    return http


def _good_downloads(data=b"new bridge binary"):
    return [_checksum_line(hashlib.sha256(data).hexdigest(), MAC_ASSET), data]


class _Response:
    def __init__(self, content, status=200):
        self.status = status
        self.headers = {}
        self.content = content


class _Transport:
    """Injected transport for the real SilentSuiteHttpAdapter."""

    def __init__(self, *, content=None, error=None):
        self._content = content
        self._error = error
        self.urls = []

    def get(self, url, timeout):
        self.urls.append(url)
        if self._error is not None:
            raise self._error
        return _Response(self._content)


def _real_http(transport):
    from silentsuite_bridge.update.http import SilentSuiteHttpAdapter
    return SilentSuiteHttpAdapter(transport=transport)


def _oversized_release_json():
    # Valid JSON that is larger than the 512 KiB release-response bound.
    return b"[" + b" " * (512 * 1024) + b"]"


def _route_check(monkeypatch, **kwargs):
    import silentsuite_bridge.update as update_pkg
    real = update_pkg.check_for_update
    monkeypatch.setattr(update_pkg, "check_for_update", lambda: real(**kwargs))


def _route_self_update(monkeypatch, **kwargs):
    import silentsuite_bridge.update as update_pkg
    real = update_pkg.perform_update
    monkeypatch.setattr(update_pkg, "perform_update", lambda: real(**kwargs))


def _run_cli(monkeypatch, capsys, flag):
    import silentsuite_bridge.__main__ as bridge_main
    monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", flag])
    with pytest.raises(SystemExit) as excinfo:
        bridge_main.main()
    captured = capsys.readouterr()
    return excinfo.value.code, captured.out, captured.err


def _assert_no_private_text(out, err):
    assert PRIVATE_MARKER not in out
    assert PRIVATE_MARKER not in err


# ---------------------------------------------------------------------------
# --check-update
# ---------------------------------------------------------------------------

def test_check_oversized_release_response_is_a_reported_failure(monkeypatch, capsys):
    transport = _Transport(content=_oversized_release_json())
    _route_check(monkeypatch, http=_real_http(transport), platform=_mac(),
                 current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--check-update")

    assert code == 1
    assert "Update check failed." in out
    assert CHECK_CATCH_ALL not in err
    assert len(transport.urls) == 1


def test_check_tls_verification_error_is_a_reported_failure(monkeypatch, capsys):
    error = ssl.SSLCertVerificationError(
        f"certificate verify failed for {PRIVATE_MARKER}"
    )
    _route_check(monkeypatch, http=_real_http(_Transport(error=error)),
                 platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--check-update")

    assert code == 1
    assert "Update check failed." in out
    assert CHECK_CATCH_ALL not in err
    _assert_no_private_text(out, err)


def test_check_unexpected_error_from_release_fetch_is_a_reported_failure(
        monkeypatch, capsys):
    http = MagicMock()
    http.fetch_releases.side_effect = ValueError(PRIVATE_MARKER)
    _route_check(monkeypatch, http=http, platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--check-update")

    assert code == 1
    assert "Update check failed." in out
    assert CHECK_CATCH_ALL not in err
    _assert_no_private_text(out, err)


def test_check_reaches_catch_all_only_when_failing_before_the_fetch(
        monkeypatch, capsys):
    """An error while constructing the HTTP adapter escapes check_for_update."""
    import silentsuite_bridge.update as update_pkg

    def _broken_adapter():
        raise ImportError(PRIVATE_MARKER)

    monkeypatch.setattr(update_pkg, "_default_http", _broken_adapter)
    _route_check(monkeypatch, platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--check-update")

    assert code == 1
    assert err.strip() == CHECK_CATCH_ALL
    _assert_no_private_text(out, err)


# ---------------------------------------------------------------------------
# --self-update: admission
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("admission,version,expected", [
    (_admission(frozen=False), CURRENT,
     "Error: Self-update requires a release (frozen) binary installation."),
    (_admission(exe=None), CURRENT,
     "Error: Cannot determine the installed bridge executable location."),
    (_admission(writable=False), CURRENT,
     "Error: The installed bridge executable or its parent directory is not writable."),
    (_admission(), "0.0.0-dev",
     "Error: Self-update is not available for development builds."),
])
def test_self_update_admission_refusals_are_specific(
        monkeypatch, capsys, admission, version, expected):
    http, fs, restart = _http(), _fs(), _restart()
    _route_self_update(monkeypatch, http=http, fs=fs, restart=restart,
                       admission=admission, platform=_mac(),
                       current_version=version)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == expected
    http.fetch_releases.assert_not_called()
    http.download.assert_not_called()
    fs.stage.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


# ---------------------------------------------------------------------------
# --self-update: each non-available check status refuses before any download
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("make_http,arch,expected", [
    pytest.param(lambda: _http(remote=CURRENT), "x86_64",
                 "Error: The installed Bridge is already current.", id="current"),
    pytest.param(lambda: _http(remote="0.5.11-beta"), "x86_64",
                 "Error: Refusing to downgrade the installed Bridge.", id="downgrade"),
    pytest.param(lambda: _http(assets=(MAC_ASSET,)), "x86_64",
                 "Error: Update not available.", id="missing_asset"),
    pytest.param(lambda: _http(), "ppc",
                 "Error: Update not available.", id="unsupported"),
    pytest.param(lambda: _real_http(_Transport(content=_oversized_release_json())),
                 "x86_64", "Error: Update not available.", id="failure_oversized"),
])
def test_self_update_check_statuses_refuse_with_specific_message(
        monkeypatch, capsys, make_http, arch, expected):
    from silentsuite_bridge.update.types import Platform

    fs, restart = _fs(), _restart()
    _route_self_update(monkeypatch, http=make_http(), fs=fs, restart=restart,
                       admission=_admission(), platform=Platform("macos", arch),
                       current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == expected
    fs.stage.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


# ---------------------------------------------------------------------------
# --self-update: download, verification and replacement
# ---------------------------------------------------------------------------

def test_self_update_download_error_is_specific(monkeypatch, capsys):
    from silentsuite_bridge.update.types import HttpError

    http = _http(downloads=HttpError("Network error during download."))
    fs, restart = _fs(), _restart()
    _route_self_update(monkeypatch, http=http, fs=fs, restart=restart,
                       admission=_admission(), platform=_mac(),
                       current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == "Error: Network error during download."
    fs.stage.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


@pytest.mark.parametrize("downloads", [
    pytest.param([b"not a checksum record\n", b"new bridge binary"],
                 id="malformed_sidecar"),
    pytest.param([_checksum_line("b" * 64, MAC_ASSET), b"new bridge binary"],
                 id="digest_mismatch"),
])
def test_self_update_checksum_failures_reach_the_preserved_catch_all(
        monkeypatch, capsys, downloads):
    http = _http(downloads=downloads)
    fs, restart = _fs(), _restart()
    _route_self_update(monkeypatch, http=http, fs=fs, restart=restart,
                       admission=_admission(), platform=_mac(),
                       current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == SELF_CATCH_ALL
    # Verification fails before any live-path operation.
    fs.stat_mode.assert_not_called()
    fs.stage.assert_not_called()
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()


def test_self_update_staging_error_reaches_catch_all_before_replacement(
        monkeypatch, capsys):
    fs = _fs()
    fs.stage.side_effect = OSError(28, "No space left", PRIVATE_MARKER)
    restart = _restart()
    _route_self_update(monkeypatch, http=_http(downloads=_good_downloads()),
                       fs=fs, restart=restart, admission=_admission(),
                       platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == SELF_CATCH_ALL
    fs.replace.assert_not_called()
    restart.restart.assert_not_called()
    _assert_no_private_text(out, err)


def test_self_update_replace_error_removes_candidate_and_reaches_catch_all(
        monkeypatch, capsys):
    fs = _fs()
    staged = fs.stage.return_value
    fs.replace.side_effect = OSError(13, "Permission denied", PRIVATE_MARKER)
    restart = _restart()
    _route_self_update(monkeypatch, http=_http(downloads=_good_downloads()),
                       fs=fs, restart=restart, admission=_admission(),
                       platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == SELF_CATCH_ALL
    fs.replace.assert_called_once_with(staged, str(MAC_EXE))
    fs.remove.assert_called_once_with(staged)
    restart.restart.assert_not_called()
    _assert_no_private_text(out, err)


def test_self_update_reaches_catch_all_when_failing_before_admission(
        monkeypatch, capsys):
    """An error while constructing the HTTP adapter escapes perform_update."""
    import silentsuite_bridge.update as update_pkg

    def _broken_adapter():
        raise ImportError(PRIVATE_MARKER)

    monkeypatch.setattr(update_pkg, "_default_http", _broken_adapter)
    fs, restart = _fs(), _restart()
    admission = _admission()
    _route_self_update(monkeypatch, fs=fs, restart=restart, admission=admission,
                       platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 1
    assert err.strip() == SELF_CATCH_ALL
    admission.is_frozen.assert_not_called()
    fs.replace.assert_not_called()
    _assert_no_private_text(out, err)


# ---------------------------------------------------------------------------
# --self-update: macOS restart dispatch
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("restart_ok", [True, False], ids=["restarted", "manual"])
def test_self_update_macos_success_reports_update_and_restart_outcome(
        monkeypatch, capsys, restart_ok):
    fs = _fs()
    restart = _restart(success=restart_ok)
    _route_self_update(monkeypatch, http=_http(downloads=_good_downloads()),
                       fs=fs, restart=restart, admission=_admission(),
                       platform=_mac(), current_version=CURRENT)

    code, out, err = _run_cli(monkeypatch, capsys, "--self-update")

    assert code == 0
    assert "Bridge updated." in out
    assert err == ""
    fs.replace.assert_called_once_with(fs.stage.return_value, str(MAC_EXE))
    restart.restart.assert_called_once_with(exe_path=MAC_EXE, platform_name="macos")
    if restart_ok:
        assert "Run manually" not in out
    else:
        assert f"Run manually: {MAC_EXE}" in out
        assert "adapter text is discarded" not in out


def test_macos_restart_kickstarts_the_autostart_service_target(tmp_path, monkeypatch):
    from silentsuite_bridge import autostart
    from silentsuite_bridge.update import restart as restart_mod

    agents = tmp_path / "Library" / "LaunchAgents"
    agents.mkdir(parents=True)
    (agents / f"{autostart.LAUNCHD_LABEL}.plist").write_text("<plist/>")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setattr(os, "getuid", lambda: 501, raising=False)

    calls = []

    class _Completed:
        returncode = 0

    def _fake_run(argv, **kwargs):
        calls.append(list(argv))
        return _Completed()

    monkeypatch.setattr(restart_mod._subprocess, "run", _fake_run)

    result = restart_mod.ProcessAdapter().restart(
        exe_path=MAC_EXE, platform_name="macos",
    )

    assert result.success is True
    assert calls == [
        ["launchctl", "kickstart", "-k", autostart._launchd_service_target()]
    ]


# ---------------------------------------------------------------------------
# Availability regression (RED on current source)
# ---------------------------------------------------------------------------
#
# Measured 2026-10-31T20:59:30Z: the unauthenticated GitHub releases list
# requested with per_page=100 returned 32 releases in 1,017,206 bytes, about
# twice the 512 KiB release-response bound. That bound is a deliberate
# security control and the oversize-refusal tests above must keep passing:
# one over-bound response is still refused. This test asks something
# different: with the bound unchanged, the newest compatible release must
# still be discoverable. It does not prescribe how.

_MEASURED_RELEASE_COUNT = 32
_MEASURED_LIST_BYTES = 1_017_206
_RELEASE_JSON_BOUND = 512 * 1024
_RELEASES_PATH = "/repos/silent-suite/silentsuite/releases"


def _release_versions():
    """Newest first, as GitHub lists published releases."""
    versions = [f"0.5.{n}-beta" for n in range(17, -1, -1)]
    versions += [f"0.4.{n}-beta" for n in range(13, -1, -1)]
    return versions[:_MEASURED_RELEASE_COUNT]


def _umbrella_asset_names(version):
    bridge = [
        "silentsuite-bridge-linux-arm64",
        "silentsuite-bridge-linux-x86_64",
        "silentsuite-bridge-macos-arm64",
        MAC_ASSET,
        "silentsuite-bridge-windows-x86_64.exe",
    ]
    others = [
        f"silentsuite-android-v{version}.apk",
        f"silentsuite-android-v{version}.aab",
        f"silentsuite-android-v{version}-native-debug-symbols.zip",
        f"silentsuite-self-host-v{version}.tar.gz",
    ]
    payloads = bridge + others
    return (payloads + [f"{name}.sha256" for name in payloads]
            + ["SHA256SUMS.txt", "server-image.json"])


def _github_user():
    return {
        "login": "github-actions[bot]",
        "id": 41898282,
        "node_id": "MDM6Qm90NDE4OTgyODI=",
        "avatar_url": "https://avatars.githubusercontent.com/in/15368?v=4",
        "url": "https://api.github.com/users/github-actions%5Bbot%5D",
        "html_url": "https://github.com/apps/github-actions",
        "type": "Bot",
        "site_admin": False,
    }


def _github_release(index, version, target_bytes):
    """GitHub-shaped published release whose compact JSON is target_bytes."""
    import json

    api = f"https://api.github.com{_RELEASES_PATH}"
    web = "https://github.com/silent-suite/silentsuite/releases"
    release_id = 250_000_000 + index
    assets = []
    for n, name in enumerate(_umbrella_asset_names(version)):
        asset_id = release_id * 100 + n
        assets.append({
            "url": f"{api}/assets/{asset_id}",
            "id": asset_id,
            "node_id": f"RA_{asset_id}",
            "name": name,
            "label": "",
            "uploader": _github_user(),
            "content_type": "application/octet-stream",
            "state": "uploaded",
            "size": 1_000_000 + n,
            "digest": "sha256:" + "0" * 64,
            "download_count": 0,
            "created_at": "2026-10-29T20:00:00Z",
            "updated_at": "2026-10-29T20:00:00Z",
            "browser_download_url": f"{web}/download/v{version}/{name}",
        })
    release = {
        "url": f"{api}/{release_id}",
        "assets_url": f"{api}/{release_id}/assets",
        "html_url": f"{web}/tag/v{version}",
        "id": release_id,
        "author": _github_user(),
        "node_id": f"RE_{release_id}",
        "tag_name": f"v{version}",
        "target_commitish": "main",
        "name": f"SilentSuite v{version}",
        "draft": False,
        "prerelease": False,
        "created_at": "2026-10-29T20:00:00Z",
        "published_at": "2026-10-29T20:29:50Z",
        "assets": assets,
        "body": "",
    }
    # Release notes make up the rest of the measured per-release size.
    used = len(json.dumps(release, separators=(",", ":")).encode())
    release["body"] = "x" * max(target_bytes - used, 0)
    return release


class _GitHubReleasesTransport:
    """Serves synthetic releases the way the GitHub API does.

    Newest first; honours ``per_page`` (default 30, max 100) and ``page``,
    sends a ``Link: rel="next"`` header while more pages remain, and serves
    ``/releases/latest`` as a single object. Every response is real bytes, so
    the adapter's unchanged 512 KiB bound applies to each one.
    """

    def __init__(self, releases):
        self.releases = releases
        self.urls = []

    def get(self, url, timeout):
        import json
        from urllib.parse import parse_qs, urlparse

        self.urls.append(url)
        parsed = urlparse(url)
        if parsed.hostname != "api.github.com":
            return _Response(b"", status=404)
        if parsed.path == f"{_RELEASES_PATH}/latest":
            return _Response(
                json.dumps(self.releases[0], separators=(",", ":")).encode()
            )
        if parsed.path != _RELEASES_PATH:
            return _Response(b"", status=404)
        query = parse_qs(parsed.query)
        per_page = min(max(int(query.get("per_page", ["30"])[0]), 1), 100)
        page = max(int(query.get("page", ["1"])[0]), 1)
        chunk = self.releases[(page - 1) * per_page:page * per_page]
        response = _Response(json.dumps(chunk, separators=(",", ":")).encode())
        if page * per_page < len(self.releases):
            response.headers = {
                "Link": (
                    f'<https://api.github.com{_RELEASES_PATH}'
                    f'?per_page={per_page}&page={page + 1}>; rel="next"'
                ),
            }
        return response


def test_check_finds_newest_release_when_full_release_list_exceeds_bound():
    import json

    from silentsuite_bridge.update import check_for_update
    from silentsuite_bridge.update.types import UpdateStatus

    versions = _release_versions()
    per_release = _MEASURED_LIST_BYTES // len(versions)
    releases = [
        _github_release(index, version, per_release)
        for index, version in enumerate(versions)
    ]

    # Fixture sanity: the whole list matches the measurement and is about
    # twice the bound, while one release is far below it.
    full_list = json.dumps(releases, separators=(",", ":")).encode()
    assert abs(len(full_list) - _MEASURED_LIST_BYTES) < 1024
    assert len(full_list) > _RELEASE_JSON_BOUND
    assert len(json.dumps(releases[0]).encode()) < _RELEASE_JSON_BOUND // 8

    transport = _GitHubReleasesTransport(releases)
    result = check_for_update(
        http=_real_http(transport),
        platform=_mac(),
        current_version="0.5.13-beta",
    )

    assert result.status == UpdateStatus.AVAILABLE, (
        f"newest release not discoverable within the response bound; "
        f"status={result.status.name} requests={transport.urls}"
    )
    assert result.tag_name == "v0.5.17-beta"
    assert result.release.asset_name == MAC_ASSET
