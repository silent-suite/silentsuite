"""Next-step text after `--login` (BRIDGE-03).

The CLI login stores the account in a separate process and does not contact a
running bridge. It prints one next step that holds either way: a running
bridge starts the account's worker on its next DAV request for it, otherwise
the user starts the bridge with the bare command name.
"""

import contextlib
import socket
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

import silentsuite_bridge.auth_browser as auth_browser
from silentsuite_bridge import config

PORT = 45123
NEXT_STEP = (
    "If the bridge is already running, it starts syncing this account "
    "the next time your calendar or contacts app connects."
)


@contextlib.contextmanager
def _completed_login():
    server = MagicMock()
    event = MagicMock()

    def complete_auth(*_args, **_kwargs):
        server.authenticated_email = "alice@example.com"
        return True

    event.wait.side_effect = complete_auth

    def no_network(*_args, **_kwargs):
        raise AssertionError("--login must not contact a running bridge")

    with (
        patch.object(auth_browser.config, "ensure_data_dir"),
        patch.object(auth_browser, "BoundedAuthHTTPServer", return_value=server),
        patch.object(auth_browser.threading, "Event", return_value=event),
        patch.object(auth_browser.threading, "Thread"),
        patch.object(auth_browser.webbrowser, "open"),
        patch.object(auth_browser, "_find_free_port", return_value=43999),
        patch.object(urllib.request.OpenerDirector, "open", no_network),
        patch.object(socket, "create_connection", no_network),
    ):
        yield


def test_cli_login_prints_one_next_step(monkeypatch, capsys):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: "linux")

    with _completed_login():
        assert auth_browser.browser_login() == "alice@example.com"
    out = capsys.readouterr().out

    assert NEXT_STEP in out
    assert "Otherwise start it with:\n    silentsuite-bridge\n" in out
    assert "./silentsuite-bridge" not in out
    assert "daemon" not in out


def test_cli_login_start_hint_on_windows_keeps_bridge_running(monkeypatch, capsys):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: "windows")

    with _completed_login():
        auth_browser.browser_login()

    assert "    silentsuite-bridge --background\n" in capsys.readouterr().out


def test_cli_login_start_hint_on_windows_names_the_running_executable(monkeypatch, capsys):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: "windows")
    monkeypatch.setattr(auth_browser.sys, "frozen", True, raising=False)
    monkeypatch.setattr(
        auth_browser.sys, "executable", "C:\\Users\\o'neil\\Downloads\\silentsuite-bridge-windows-x86_64.exe"
    )

    with _completed_login():
        auth_browser.browser_login()

    assert (
        "    & 'C:\\Users\\o''neil\\Downloads\\silentsuite-bridge-windows-x86_64.exe' --background\n"
        in capsys.readouterr().out
    )


def test_windows_start_hint_doubles_typographic_single_quotes(monkeypatch):
    monkeypatch.setattr(config, "get_platform", lambda: "windows")
    monkeypatch.setattr(auth_browser.sys, "frozen", True, raising=False)
    monkeypatch.setattr(auth_browser.sys, "executable", "C:\\Users\\O\u2019Neil\\silentsuite-bridge.exe")

    assert auth_browser._start_command() == "& 'C:\\Users\\O\u2019\u2019Neil\\silentsuite-bridge.exe' --background"


@pytest.mark.parametrize("platform", ["linux", "windows"])
def test_tray_login_prints_no_start_hint(monkeypatch, capsys, platform):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: platform)

    with _completed_login():
        assert auth_browser.browser_login(running_bridge=True) == "alice@example.com"
    out = capsys.readouterr().out

    assert "The bridge is already running." in out
    assert NEXT_STEP not in out
    assert "Otherwise start it with:" not in out
