"""Operator-channel policy for listener addresses on stdout (#720 review).

MEDIUM finding: requested, bound and failed listener addresses printed to
stdout persist in the launchd ``bridge.log`` (``StandardOutPath``) and in the
systemd journal even though Python logging records are redacted. These tests
pin the policy that addresses reach stdout only on an interactive terminal or
with the explicit ``SILENTSUITE_LISTENER_DETAIL=1`` opt-in. They exercise a
redirected stdout stream directly and, on Linux, a real child process whose
stdout is the rendered launchd log file or a journal-like pipe -- not caplog.

LOW finding: the first-run browser launch must resolve the *bound* loopback
dashboard URL at callback time and never fall back to the requested URL after
a failed or stopped bind.
"""

import contextlib
import io
import json
import os
import plistlib
import socket
import subprocess
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import autostart, config, operator_output
from silentsuite_bridge.radicale import server as server_module
from silentsuite_bridge.radicale.server import ListenerRegistry, get_registry

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
DETAIL_ENV = operator_output.LISTENER_DETAIL_ENV

# Channel kinds: a redirected stream withholds addresses; a terminal or the
# explicit opt-in shows them.
WITHHELD = ("redirected",)
SHOWN = ("tty", "opt-in")
ALL_CHANNELS = WITHHELD + SHOWN


class _FakeTty(io.StringIO):
    """A stdout replacement that claims to be an interactive terminal."""

    def isatty(self):
        return True


@pytest.fixture(autouse=True)
def _no_detail_opt_in_from_the_developer_shell(monkeypatch):
    monkeypatch.delenv(DETAIL_ENV, raising=False)


@contextlib.contextmanager
def _stdout_channel(kind, monkeypatch):
    """Redirect stdout to a stream shaped like one operator channel."""
    if kind == "opt-in":
        monkeypatch.setenv(DETAIL_ENV, "1")
    stream = _FakeTty() if kind == "tty" else io.StringIO()
    with contextlib.redirect_stdout(stream):
        yield stream


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


class TestPolicy:
    def test_redirected_stdout_without_opt_in_withholds(self):
        assert operator_output.stdout_is_interactive(io.StringIO()) is False
        assert operator_output.listener_detail_opted_in({}) is False
        with contextlib.redirect_stdout(io.StringIO()):
            assert operator_output.address_detail_enabled() is False

    def test_terminal_stdout_enables_detail(self):
        assert operator_output.stdout_is_interactive(_FakeTty()) is True
        with contextlib.redirect_stdout(_FakeTty()):
            assert operator_output.address_detail_enabled() is True

    @pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
    def test_opt_in_values_enable_detail_on_a_redirected_stream(self, monkeypatch, value):
        monkeypatch.setenv(DETAIL_ENV, value)
        with contextlib.redirect_stdout(io.StringIO()):
            assert operator_output.address_detail_enabled() is True

    @pytest.mark.parametrize("value", ["0", "false", "", "no", "detail"])
    def test_non_true_values_do_not_opt_in(self, monkeypatch, value):
        monkeypatch.setenv(DETAIL_ENV, value)
        with contextlib.redirect_stdout(io.StringIO()):
            assert operator_output.address_detail_enabled() is False

    def test_missing_or_broken_stdout_fails_closed(self, monkeypatch):
        class _Broken:
            def isatty(self):
                raise ValueError("closed stream")

        assert operator_output.stdout_is_interactive(_Broken()) is False
        assert operator_output.stdout_is_interactive(object()) is False
        monkeypatch.setattr(sys, "stdout", None)
        assert operator_output.address_detail_enabled() is False

    def test_withheld_note_names_the_opt_in_and_no_address(self):
        note = operator_output.ADDRESS_WITHHELD_NOTE
        assert f"{DETAIL_ENV}=1" in note
        assert "127.0.0.1" not in note
        assert "::1" not in note


# ---------------------------------------------------------------------------
# Bind / failure lines from the server adapter
# ---------------------------------------------------------------------------


class TestListenerLinesOnStdout:
    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_bound_lines(self, monkeypatch, kind):
        with _stdout_channel(kind, monkeypatch) as stream:
            server_module._print_bound(("127.0.0.1", 45123), ssl=False)
            server_module._print_bound(("192.0.2.10", 45124), ssl=True)
            server_module._print_bound(("0.0.0.0", 45125), ssl=False)
            server_module._print_bound(("::1", 45126, 0, 0), ssl=False)
        out = stream.getvalue()

        assert out.count("Listening:") == 4
        if kind in SHOWN:
            assert "Listening: http://127.0.0.1:45123 (DAV and dashboard, loopback only)" in out
            assert "Listening: 192.0.2.10:45124 (remote DAV only, dashboard denied)" in out
            assert "Listening: 0.0.0.0:45125 (bind address, DAV only, dashboard denied; not a client URL)" in out
            assert "Listening: http://[::1]:45126 (DAV and dashboard, loopback only)" in out
            return
        for private in ("127.0.0.1", "192.0.2.10", "0.0.0.0", "::1", "45123", "45124", "45125", "45126"):
            assert private not in out, f"{private!r} reached non-interactive stdout: {out}"
        assert "Listening: loopback listener bound (http; DAV and dashboard, loopback only)" in out
        assert "Listening: remote listener bound (https; remote DAV only, dashboard denied)" in out
        assert (
            "Listening: wildcard listener bound (http; bind address, DAV only, dashboard denied; "
            "not a client URL)"
        ) in out

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_not_bound_and_resolution_lines(self, monkeypatch, kind):
        with _stdout_channel(kind, monkeypatch) as stream:
            server_module.print_listener_not_bound(("192.0.2.10", 45124), "HTTP")
            server_module.print_listener_not_bound(("::1", 45126, 0, 0), "HTTPS")
            server_module.print_resolution_failed("bridge-host.internal.invalid:45127")
        out = stream.getvalue()

        assert out.count("Listener not bound:") == 2
        assert out.count("Listener address resolution failed:") == 1
        if kind in SHOWN:
            assert "Listener not bound: 192.0.2.10:45124 (HTTP)" in out
            assert "Listener not bound: [::1]:45126 (HTTPS)" in out
            assert "Listener address resolution failed: bridge-host.internal.invalid:45127" in out
            return
        for private in ("192.0.2.10", "::1", "45124", "45126", "bridge-host.internal.invalid", "45127"):
            assert private not in out, f"{private!r} reached non-interactive stdout: {out}"
        assert "Listener not bound: remote listener (HTTP; address withheld)" in out
        assert "Listener not bound: loopback listener (HTTPS; address withheld)" in out
        assert "Listener address resolution failed: configured hostname (address withheld)" in out

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_constructor_failure_through_the_production_server_class(self, monkeypatch, kind):
        """The bridge server subclass hands the requested address tuple to the
        not-bound printer; the persistent-sink shape must not see it."""
        registry = ListenerRegistry()
        registry.reset()

        class _FailingUpstream:
            def __init__(self, configuration, family, address, handler_class):
                raise OSError("address already in use")

        BridgeHTTP = server_module._build_bridge_http_server_class(_FailingUpstream, registry)
        with _stdout_channel(kind, monkeypatch) as stream:
            with pytest.raises(OSError, match="address already in use"):
                BridgeHTTP(object(), socket.AF_INET, ("192.0.2.10", 45123), None)
        out = stream.getvalue()

        assert registry.failed_count() == 1
        assert "Listener not bound:" in out
        if kind in SHOWN:
            assert "192.0.2.10:45123 (HTTP)" in out
        else:
            assert "192.0.2.10" not in out
            assert "45123" not in out
            assert "remote listener (HTTP; address withheld)" in out


# ---------------------------------------------------------------------------
# Startup report and no-account hint (check_credentials)
# ---------------------------------------------------------------------------


class TestStartupReportOnStdout:
    @staticmethod
    def _no_account(tmp_path, monkeypatch, hosts, allow_remote):
        monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
        monkeypatch.setattr(config, "SERVER_HOSTS", hosts)
        monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
        monkeypatch.setattr(config, "LISTEN_PORT", 37358)
        monkeypatch.setattr(config, "ALLOW_REMOTE", allow_remote)
        monkeypatch.setattr(config, "SSL_ENABLED", False)

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_mixed_profile_without_account(self, tmp_path, monkeypatch, kind):
        self._no_account(tmp_path, monkeypatch, "127.0.0.1:45123,192.0.2.10:45124,0.0.0.0:45125", True)
        with _stdout_channel(kind, monkeypatch) as stream:
            assert bridge_main.check_credentials(open_browser=False) is True
        out = stream.getvalue()

        assert "Requested listeners:" in out
        assert "No account configured yet" in out
        if kind in SHOWN:
            assert "127.0.0.1:45123 (loopback" in out
            assert "192.0.2.10:45124 (remote" in out
            assert "0.0.0.0:45125 (wildcard" in out
            assert "http://127.0.0.1:45123/" in out
            assert "confirmed when the listener binds" in out
            return
        for private in ("127.0.0.1", "192.0.2.10", "0.0.0.0", "45123", "45124", "45125"):
            assert private not in out, f"{private!r} reached non-interactive stdout: {out}"
        assert "Requested listeners: 3 configured (1 loopback, 1 wildcard, 1 remote)" in out
        assert "confirmed when the loopback listener binds" in out
        assert f"{DETAIL_ENV}=1" in out

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_invalid_entry_is_counted_and_labelled(self, tmp_path, monkeypatch, kind):
        self._no_account(tmp_path, monkeypatch, "127.0.0.1:45123,not a host", False)
        with _stdout_channel(kind, monkeypatch) as stream:
            bridge_main.check_credentials(open_browser=False)
        out = stream.getvalue()
        if kind in SHOWN:
            assert "not a host (invalid — not parseable, will not bind)" in out
        else:
            assert "2 configured (1 loopback, 1 invalid)" in out
            assert "not a host" not in out

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_wildcard_only_profile_hint(self, tmp_path, monkeypatch, kind):
        self._no_account(tmp_path, monkeypatch, "0.0.0.0:45123", True)
        with _stdout_channel(kind, monkeypatch) as stream:
            assert bridge_main.check_credentials(open_browser=False) is False
        out = stream.getvalue()

        assert "no loopback listener is configured" in out
        assert "--login" in out
        if kind in SHOWN:
            assert "SILENTSUITE_SERVER_HOSTS=0.0.0.0:45123,127.0.0.1:" in out
            return
        for private in ("0.0.0.0", "45123", "127.0.0.1"):
            assert private not in out, f"{private!r} reached non-interactive stdout: {out}"
        assert "SILENTSUITE_SERVER_HOSTS=" not in out
        assert "Add a loopback address on a free port to SILENTSUITE_SERVER_HOSTS" in out
        assert f"{DETAIL_ENV}=1" in out

    def test_help_documents_the_opt_in(self, monkeypatch, capsys):
        monkeypatch.setattr(sys, "argv", ["silentsuite-bridge", "--help"])
        with pytest.raises(SystemExit) as exc:
            bridge_main.main()
        assert exc.value.code == 0
        assert DETAIL_ENV in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Login completion (auth_browser.browser_login)
# ---------------------------------------------------------------------------


class TestLoginCompletionOnStdout:
    @staticmethod
    @contextlib.contextmanager
    def _completed_login():
        from silentsuite_bridge import auth_browser

        server = MagicMock()
        event = MagicMock()

        def complete_auth(*_args, **_kwargs):
            server.authenticated_email = "alice@example.com"
            server.authenticated_server_url = "https://private-server.example.invalid"
            return True

        event.wait.side_effect = complete_auth
        with (
            patch.object(auth_browser.config, "ensure_data_dir"),
            patch.object(auth_browser, "BoundedAuthHTTPServer", return_value=server),
            patch.object(auth_browser.threading, "Event", return_value=event),
            patch.object(auth_browser.threading, "Thread"),
            patch.object(auth_browser.webbrowser, "open"),
            patch.object(auth_browser, "_find_free_port", return_value=43999),
        ):
            yield auth_browser

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_requested_dashboard_url_before_serving(self, monkeypatch, kind):
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123")
        monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        with self._completed_login() as auth_browser:
            with _stdout_channel(kind, monkeypatch) as stream:
                assert auth_browser.browser_login(running_bridge=True) == "alice@example.com"
        out = stream.getvalue()

        assert "CalDAV/CardDAV account configured." in out
        assert "alice@example.com" not in out
        assert "private-server.example.invalid" not in out
        if kind in SHOWN:
            assert (
                "Dashboard will be available on the configured loopback listener: "
                "http://127.0.0.1:45123/"
            ) in out
            return
        assert "Dashboard will be available on the configured loopback listener." in out
        assert "45123" not in out
        assert f"{DETAIL_ENV}=1" in out

    @pytest.mark.parametrize("kind", ALL_CHANNELS)
    def test_bound_dashboard_url_while_running(self, monkeypatch, kind):
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123")
        monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        registry.reset()
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        with self._completed_login() as auth_browser:
            with _stdout_channel(kind, monkeypatch) as stream:
                assert auth_browser.browser_login(running_bridge=True) == "alice@example.com"
        out = stream.getvalue()

        if kind in SHOWN:
            assert "Dashboard available on the loopback listener: http://127.0.0.1:45124/" in out
            return
        assert "Dashboard available on the bound loopback listener." in out
        assert "45124" not in out
        assert f"{DETAIL_ENV}=1" in out

    def test_not_bound_after_serving_prints_no_address_on_any_channel(self, monkeypatch):
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123")
        monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        registry.reset()
        registry.record_failed()
        with self._completed_login() as auth_browser:
            with _stdout_channel("tty", monkeypatch) as stream:
                auth_browser.browser_login(running_bridge=True)
        out = stream.getvalue()
        assert "Dashboard is not bound on a loopback listener" in out
        assert "45123" not in out


# ---------------------------------------------------------------------------
# LOW: first-run browser launch resolves the bound URL at callback time
# ---------------------------------------------------------------------------


class TestDashboardAutoOpener:
    @staticmethod
    def _recording_opener():
        opened: list[str] = []
        event = threading.Event()

        def opener(url):
            opened.append(url)
            event.set()

        return opened, event, opener

    def test_partial_bind_opens_the_bound_loopback_not_the_requested_port(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123,127.0.0.1:45124")
        registry = get_registry()
        opened, event, opener = self._recording_opener()

        auto_opener = bridge_main._open_dashboard_when_bound(opener=opener)
        assert opened == [], "the requested URL must never be scheduled before binding"

        registry.reset()
        registry.record_failed()  # requested 127.0.0.1:45123 is occupied
        assert opened == []
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        assert event.wait(timeout=5)

        assert opened == ["http://127.0.0.1:45124/"]
        assert auto_opener._done is True
        # A later bind never opens a second tab.
        registry.record_bound(("127.0.0.1", 45123), socket.AF_INET, ssl=False)
        assert opened == ["http://127.0.0.1:45124/"]

    def test_loopback_failed_and_remote_bound_never_opens(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123,192.0.2.10:45124")
        registry = get_registry()
        opened, event, opener = self._recording_opener()

        auto_opener = bridge_main._open_dashboard_when_bound(opener=opener)
        registry.reset()
        registry.record_failed()
        registry.record_bound(("192.0.2.10", 45124), socket.AF_INET, ssl=False)
        assert not event.wait(timeout=0.2)
        registry.mark_stopped()

        assert opened == []
        assert auto_opener._done is True

    def test_nothing_bound_then_stopped_never_opens_the_requested_url(self, monkeypatch, caplog):
        import logging

        monkeypatch.setattr(config, "SSL_ENABLED", False)
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123")
        registry = get_registry()
        opened, event, opener = self._recording_opener()

        auto_opener = bridge_main._open_dashboard_when_bound(opener=opener)
        with caplog.at_level(logging.INFO, logger=bridge_main.logger.name):
            registry.reset()
            registry.record_failed()
            registry.mark_stopped()

        assert not event.wait(timeout=0.2)
        assert opened == []
        assert auto_opener._done is True
        assert "no loopback listener bound before serving stopped" in caplog.text
        assert "45123" not in caplog.text
        # The requested fallback is gone once serving was attempted.
        assert bridge_main._dashboard_url() is None

    def test_wildcard_bound_is_not_a_dashboard_url(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123,0.0.0.0:45124")
        registry = get_registry()
        opened, event, opener = self._recording_opener()

        bridge_main._open_dashboard_when_bound(opener=opener)
        registry.reset()
        registry.record_bound(("0.0.0.0", 45124), socket.AF_INET, ssl=False)
        assert not event.wait(timeout=0.2)
        assert opened == []

    def test_tls_ipv6_bound_url(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", True)
        monkeypatch.setattr(config, "SERVER_HOSTS", "[::1]:45123")
        registry = get_registry()
        opened, event, opener = self._recording_opener()

        bridge_main._open_dashboard_when_bound(opener=opener)
        registry.reset()
        registry.record_bound(("::1", 45123, 0, 0), socket.AF_INET6, ssl=True)
        assert event.wait(timeout=5)
        assert opened == ["https://[::1]:45123/"]

    def test_already_bound_at_registration_opens_once(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        registry.reset()
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        opened, event, opener = self._recording_opener()

        bridge_main._open_dashboard_when_bound(opener=opener)
        assert event.wait(timeout=5)
        assert opened == ["http://127.0.0.1:45124/"]

    def test_browser_failure_is_swallowed_and_logged_without_url(self, monkeypatch, caplog):
        import logging

        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        failed = threading.Event()

        def opener(_url):
            failed.set()
            raise RuntimeError("no browser")

        with caplog.at_level(logging.DEBUG, logger=bridge_main.logger.name):
            bridge_main._open_dashboard_when_bound(opener=opener)
            registry.reset()
            registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
            assert failed.wait(timeout=5)
            # Give the launch thread a moment to log after raising.
            for _ in range(50):
                if "Could not open dashboard automatically" in caplog.text:
                    break
                threading.Event().wait(0.02)
        assert "Could not open dashboard automatically" in caplog.text
        assert "45124" not in caplog.text
        assert "no browser" not in caplog.text

    def test_check_credentials_registers_the_opener_and_uses_the_bound_url(
        self, tmp_path, monkeypatch,
    ):
        """End to end through check_credentials(): no timer, no URL captured
        before binding, and the URL opened is the bound listener's."""
        import webbrowser

        monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
        monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:45123,127.0.0.1:45124")
        monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
        monkeypatch.setattr(config, "LISTEN_PORT", 37358)
        monkeypatch.setattr(config, "ALLOW_REMOTE", False)
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        opened, event, opener = self._recording_opener()
        monkeypatch.setattr(webbrowser, "open", opener)
        monkeypatch.setattr(
            threading, "Timer",
            MagicMock(side_effect=AssertionError("no fixed-delay timer may capture a requested URL")),
        )

        with contextlib.redirect_stdout(io.StringIO()):
            assert bridge_main.check_credentials(open_browser=True) is True
        assert opened == []

        registry = get_registry()
        registry.reset()
        registry.record_failed()
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        assert event.wait(timeout=5)
        assert opened == ["http://127.0.0.1:45124/"]


class TestDashboardAutoOpenerDetachment:
    """Re-review LOW: the registry removes callbacks by identity, and a bound
    method evaluated twice is two objects. The opener must register and remove
    one stable reference so a completed opener is actually detached, unrelated
    subscribers survive, and repeated starts do not accumulate."""

    @staticmethod
    def _subscribers(registry):
        with registry._lock:
            return list(registry._listeners)

    @staticmethod
    def _unrelated_subscriber():
        calls = []

        def subscriber():
            calls.append(True)

        return calls, subscriber

    def test_successful_bind_detaches_and_keeps_unrelated_subscriber(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        calls, unrelated = self._unrelated_subscriber()
        registry.add_listener(unrelated)
        opened = threading.Event()

        auto = bridge_main._open_dashboard_when_bound(opener=lambda _url: opened.set())
        assert auto._callback in self._subscribers(registry)

        registry.reset()
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        assert opened.wait(timeout=5)

        subscribers = self._subscribers(registry)
        assert auto._callback not in subscribers, "completed opener is still subscribed"
        assert unrelated in subscribers, "unrelated subscriber was dropped"
        assert not any(getattr(cb, "__self__", None) is auto for cb in subscribers)

        # A later notification no longer reaches the opener at all.
        notified_before = len(calls)
        registry.record_bound(("127.0.0.1", 45123), socket.AF_INET, ssl=False)
        assert len(calls) == notified_before + 1
        assert auto._registered is False

    def test_stopped_without_bind_detaches_and_keeps_unrelated_subscriber(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        calls, unrelated = self._unrelated_subscriber()
        registry.add_listener(unrelated)

        auto = bridge_main._open_dashboard_when_bound(opener=lambda _url: None)
        registry.reset()
        registry.record_failed()
        registry.mark_stopped()

        subscribers = self._subscribers(registry)
        assert auto._done is True
        assert auto._callback not in subscribers
        assert unrelated in subscribers
        assert calls, "unrelated subscriber must still have been notified"

    def test_repeated_start_does_not_accumulate_subscriptions(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        opened: list[str] = []
        auto = bridge_main._DashboardAutoOpener(registry, opener=opened.append)

        auto.start()
        auto.start()
        auto.start()
        subscribers = self._subscribers(registry)
        assert subscribers.count(auto._callback) == 1
        assert len(subscribers) == 1

        registry.reset()
        registry.record_bound(("127.0.0.1", 45124), socket.AF_INET, ssl=False)
        assert self._subscribers(registry) == []
        # Starting again after completion neither re-subscribes nor re-opens.
        auto.start()
        assert self._subscribers(registry) == []

    def test_many_openers_leave_no_residue_after_completion(self, monkeypatch):
        monkeypatch.setattr(config, "SSL_ENABLED", False)
        registry = get_registry()
        openers = [bridge_main._open_dashboard_when_bound(opener=lambda _url: None) for _ in range(5)]
        assert len(self._subscribers(registry)) == 5

        registry.reset()
        registry.mark_stopped()
        assert self._subscribers(registry) == []
        assert all(o._done for o in openers)


# ---------------------------------------------------------------------------
# Rendered autostart sinks: a real child process with redirected stdout
# ---------------------------------------------------------------------------

# The child performs the production startup surface (requested-listener
# report, no-account dashboard hint) and then the production serve wrapper
# with one loopback port pre-occupied by the parent and one free, so stdout
# receives one Listening: and one Listener not bound: line. It never opens a
# browser and never touches the real data directory.
_CHILD_SCRIPT = r"""
import json, socket, sys, threading, time
import tests.mock_etebase as _mock_etebase
sys.modules.setdefault("etebase", _mock_etebase)
from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration
from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale.server import get_registry

busy_port, free_port = int(sys.argv[1]), int(sys.argv[2])
hosts = f"127.0.0.1:{busy_port},127.0.0.1:{free_port}"
config.SERVER_HOSTS = hosts
config.ALLOW_REMOTE = False
config.SSL_ENABLED = False
config.ensure_data_dir()

assert bridge_main.check_credentials(open_browser=False) is True

configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
configuration.update(
    {
        "server": {"hosts": hosts},
        "auth": {"type": "silentsuite_bridge.radicale.auth"},
        "storage": {"type": "silentsuite_bridge.radicale.storage"},
        "rights": {"type": "silentsuite_bridge.radicale.rights"},
        "web": {"type": "silentsuite_bridge.web"},
        "logging": {"level": "warning"},
    },
    source="test",
    privileged=True,
)

registry = get_registry()
a, b = socket.socketpair()
errors = []

def run():
    try:
        bridge_main._serve_radicale_with_bridge_application(configuration, shutdown_socket=a)
    except Exception as exc:
        errors.append(type(exc).__name__)

thread = threading.Thread(target=run, daemon=True)
thread.start()
deadline = time.monotonic() + 15.0
while time.monotonic() < deadline:
    if registry.failed_count() >= 1 and len(registry.bound_listeners()) >= 1:
        break
    time.sleep(0.05)
b.close()
thread.join(15.0)
sys.stdout.flush()
summary = {
    "bound": len(registry.bound_listeners()),
    "failed": registry.failed_count(),
    "errors": errors,
    "alive": thread.is_alive(),
}
sys.stderr.write("SUMMARY " + json.dumps(summary) + "\n")
sys.stderr.flush()
"""


def _child_env(tmp_path: Path, detail: bool) -> dict:
    pythonpath = [str(BRIDGE_ROOT / "src"), str(BRIDGE_ROOT)]
    if os.environ.get("PYTHONPATH"):
        pythonpath.append(os.environ["PYTHONPATH"])
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": os.pathsep.join(pythonpath),
        "PYTHONDONTWRITEBYTECODE": "1",
        "SILENTSUITE_DATA_DIR": str(tmp_path / "data"),
        "TMPDIR": str(tmp_path),
    }
    for passthrough in ("SYSTEMROOT", "PYTHONHOME", "VIRTUAL_ENV", "LANG", "LC_ALL"):
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]
    if detail:
        env[DETAIL_ENV] = "1"
    return env


def _run_child_with_sink(tmp_path: Path, sink: str, detail: bool):
    """Run the child with stdout shaped like ``sink``; return (stdout, stderr, ports)."""
    busy_port = _free_port()
    free_port = _free_port()
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    blocker.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    blocker.bind(("127.0.0.1", busy_port))
    blocker.listen(1)
    argv = [sys.executable, "-c", _CHILD_SCRIPT, str(busy_port), str(free_port)]
    env = _child_env(tmp_path, detail)
    try:
        if sink == "launchd-log-file":
            # The exact persistent sink the supported macOS agent renders:
            # StandardOutPath of the generated plist, opened as a plain file.
            log_dir = tmp_path / "Library" / "Logs" / "SilentSuiteBridge"
            log_dir.mkdir(parents=True)
            payload = plistlib.loads(autostart.render_launchd_plist(argv[:1], str(log_dir)))
            out_path = Path(payload["StandardOutPath"])
            with open(out_path, "w", encoding="utf-8") as out_file:
                result = subprocess.run(
                    argv, cwd=str(tmp_path), env=env, stdin=subprocess.DEVNULL,
                    stdout=out_file, stderr=subprocess.PIPE, text=True, timeout=120,
                )
            stdout = out_path.read_text(encoding="utf-8")
        else:
            # journal-like: systemd hands the service a pipe/socket for stdout.
            result = subprocess.run(
                argv, cwd=str(tmp_path), env=env, stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120,
            )
            stdout = result.stdout
    finally:
        blocker.close()
    assert result.returncode == 0, f"child failed\nstdout:\n{stdout}\nstderr:\n{result.stderr}"
    summary_lines = [line for line in result.stderr.splitlines() if line.startswith("SUMMARY ")]
    assert summary_lines, result.stderr
    summary = json.loads(summary_lines[-1][len("SUMMARY "):])
    assert summary["errors"] == [], summary
    assert summary["alive"] is False, summary
    assert summary["bound"] == 1 and summary["failed"] == 1, summary
    stderr_without_summary = "\n".join(
        line for line in result.stderr.splitlines() if not line.startswith("SUMMARY ")
    )
    return stdout, stderr_without_summary, (busy_port, free_port)


@pytest.mark.skipif(sys.platform != "linux", reason="Wired child-process sink test is Linux-only")
@pytest.mark.parametrize("sink", ["launchd-log-file", "journal-pipe"])
def test_rendered_autostart_sink_receives_no_listener_addresses(tmp_path, sink):
    stdout, stderr, (busy_port, free_port) = _run_child_with_sink(tmp_path, sink, detail=False)

    assert "Requested listeners:" in stdout
    assert "No account configured yet" in stdout
    assert stdout.count("Listening:") == 1, stdout
    assert "Listener not bound:" in stdout
    for private in ("127.0.0.1", str(busy_port), str(free_port)):
        assert private not in stdout, f"{private!r} persisted in the {sink} sink:\n{stdout}"
    for private in (f"127.0.0.1:{busy_port}", f"127.0.0.1:{free_port}", f":{busy_port}", f":{free_port}"):
        assert private not in stderr, f"{private!r} reached stderr:\n{stderr}"
    assert "Traceback" not in stderr
    assert f"{DETAIL_ENV}=1" in stdout


@pytest.mark.skipif(sys.platform != "linux", reason="Wired child-process sink test is Linux-only")
def test_explicit_opt_in_prints_addresses_to_a_redirected_sink(tmp_path):
    """Control: the same child prints the requested and bound addresses when
    the operator explicitly opts in, so the withheld assertions above are not
    vacuous."""
    stdout, _stderr, (busy_port, free_port) = _run_child_with_sink(
        tmp_path, "journal-pipe", detail=True,
    )
    assert f"127.0.0.1:{busy_port} (loopback" in stdout
    assert f"127.0.0.1:{free_port} (loopback" in stdout
    assert f"Listening: http://127.0.0.1:{free_port} (DAV and dashboard, loopback only)" in stdout
    assert f"Listener not bound: 127.0.0.1:{busy_port} (HTTP)" in stdout
    assert f"http://127.0.0.1:{busy_port}/" in stdout  # requested dashboard URL, unconfirmed
