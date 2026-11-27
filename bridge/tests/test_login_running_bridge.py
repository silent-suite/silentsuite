"""`--login` while a bridge is already running (BRIDGE-03).

The CLI login stores the account in a separate process; the running bridge
is asked, through the dashboard's CSRF-protected account endpoint, to re-read
its configured accounts and start syncing any that has no worker. The request
names no account. The terminal must print the right next step.
"""

import contextlib
import http.server
import io
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import MagicMock, patch

import pytest

import silentsuite_bridge.auth_browser as auth_browser
import silentsuite_bridge.web as web_module
from silentsuite_bridge import accounts, config
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import Web, _dashboard_csrf_token

PORT = 45123


def _environ(method, body=b"", csrf_token=None):
    from silentsuite_bridge.radicale.server import _ListenerEvidence

    environ = {
        "REQUEST_METHOD": method,
        "HTTP_HOST": f"127.0.0.1:{PORT}",
        "REMOTE_ADDR": "127.0.0.1",
        "silentsuite_bridge.evidence": _ListenerEvidence(
            listener=("127.0.0.1", PORT),
            accepted_local=("127.0.0.1", PORT),
            peer="127.0.0.1",
            ssl=False,
        ),
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
    }
    if csrf_token is not None:
        environ["HTTP_X_SILENTSUITE_CSRF"] = csrf_token
    return environ


def _refresh(body, csrf_token=_dashboard_csrf_token):
    web = Web.__new__(Web)
    status, _headers, payload = web.post(
        _environ("POST", body, csrf_token), "", "/.web/api/accounts/refresh", None
    )
    return status, json.loads(payload)


# ---------------------------------------------------------------------------
# Dashboard endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def workers(monkeypatch):
    """Fake sync workers: ``running`` accounts have a live worker."""
    state = {"running": set(), "started": []}

    class _Thread:
        def is_alive(self):
            return True

    monkeypatch.setattr(
        accounts,
        "get_sync_thread",
        lambda user: _Thread() if user in state["running"] else None,
    )
    monkeypatch.setattr(accounts, "refresh_sync_thread", state["started"].append)
    return state


def test_refresh_endpoint_requires_csrf(monkeypatch, workers):
    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["bob@example.com"])

    status, payload = _refresh(b"{}", csrf_token=None)

    assert status == 403
    assert payload["error"] == "Invalid dashboard CSRF token"
    assert workers["started"] == []


def test_refresh_endpoint_starts_accounts_without_a_worker(monkeypatch, workers):
    monkeypatch.setattr(
        accounts, "list_accounts", lambda **_kw: ["alice@example.com", "bob@example.com"]
    )
    workers["running"].add("alice@example.com")

    status, payload = _refresh(b"{}")

    assert status == 200
    assert payload == {"ok": True}
    assert workers["started"] == ["bob@example.com"]


def test_refresh_endpoint_ignores_a_posted_account_name(monkeypatch, workers):
    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["alice@example.com"])

    status, payload = _refresh(json.dumps({"username": "bob@example.com"}).encode())

    assert status == 200
    assert payload == {"ok": True}
    assert workers["started"] == ["alice@example.com"]


def test_refresh_endpoint_with_every_account_running_starts_nothing(monkeypatch, workers):
    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["alice@example.com"])
    workers["running"].add("alice@example.com")

    status, payload = _refresh(b"")

    assert status == 200
    assert payload == {"ok": True}
    assert workers["started"] == []


def test_refresh_holds_account_lock_until_worker_exists(monkeypatch):
    # Logout takes the same lock, so it cannot run between reading the
    # configured accounts and creating the worker.
    lock_free_during_start = []

    def try_lock():
        acquired = accounts._account_lock.acquire(blocking=False)
        if acquired:
            accounts._account_lock.release()
        lock_free_during_start.append(acquired)

    def start(_user):
        probe = threading.Thread(target=try_lock)
        probe.start()
        probe.join(5)

    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["bob@example.com"])
    monkeypatch.setattr(accounts, "get_sync_thread", lambda _user: None)
    monkeypatch.setattr(accounts, "refresh_sync_thread", start)

    assert accounts.start_missing_sync_threads() == ["bob@example.com"]
    assert lock_free_during_start == [False]


def test_refresh_endpoint_reports_failure_without_details(monkeypatch, workers):
    def fail(_username):
        raise RuntimeError("bob@example.com secret detail")

    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["bob@example.com"])
    monkeypatch.setattr(accounts, "refresh_sync_thread", fail)

    status, payload = _refresh(b"{}")

    assert status == 500
    assert payload["ok"] is False
    assert "bob@example.com" not in json.dumps(payload)


# ---------------------------------------------------------------------------
# CLI side: asking the running bridge
# ---------------------------------------------------------------------------


class _Response:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self, _limit=-1):
        return self._body


class _BridgeOpener:
    """Routes urllib requests to the real dashboard handler in this process."""

    def __init__(self):
        self.web = Web.__new__(Web)
        self.requests = []

    def open(self, target, timeout=None):
        request = target if isinstance(target, urllib.request.Request) else urllib.request.Request(target)
        self.requests.append(request)
        path = urllib.parse.urlparse(request.full_url).path
        csrf = request.get_header("X-silentsuite-csrf")
        if request.get_method() == "GET":
            status, _h, body = self.web.get(_environ("GET"), "", path, None)
        else:
            status, _h, body = self.web.post(
                _environ("POST", request.data, csrf), "", path, None
            )
        if isinstance(body, str):
            body = body.encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(body))
        return _Response(body)


@pytest.fixture
def loopback_dashboard(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(web_module, "_account_fingerprint", lambda _creds, username: "fp")


def test_cli_login_starts_sync_in_running_bridge(loopback_dashboard, workers):
    creds = Credentials()
    creds.set_etebase("bob@example.com", "bob-session", "https://server.test")
    creds.save()
    opener = _BridgeOpener()

    outcome = auth_browser.start_sync_in_running_bridge(opener=opener)

    assert outcome == "started"
    assert workers["started"] == ["bob@example.com"]
    get, post = opener.requests
    assert get.full_url == f"http://127.0.0.1:{PORT}/.web/"
    assert post.full_url == f"http://127.0.0.1:{PORT}/.web/api/accounts/refresh"
    assert post.get_header("X-silentsuite-csrf") == _dashboard_csrf_token
    assert post.data == b"{}"


def test_cli_login_reports_failure_when_bridge_cannot_start_sync(loopback_dashboard, monkeypatch):
    def fail(_username):
        raise RuntimeError("worker failed")

    monkeypatch.setattr(accounts, "list_accounts", lambda **_kw: ["bob@example.com"])
    monkeypatch.setattr(accounts, "get_sync_thread", lambda _user: None)
    monkeypatch.setattr(accounts, "refresh_sync_thread", fail)

    assert auth_browser.start_sync_in_running_bridge(opener=_BridgeOpener()) == "failed"


def test_cli_login_detects_no_running_bridge(loopback_dashboard):
    opener = MagicMock()
    opener.open.side_effect = urllib.error.URLError(ConnectionRefusedError(111, "refused"))

    assert auth_browser.start_sync_in_running_bridge(opener=opener) == "not_running"


def test_cli_login_treats_other_listener_as_failed(loopback_dashboard):
    opener = MagicMock()
    opener.open.return_value = _Response(b"<html>something else</html>")

    assert auth_browser.start_sync_in_running_bridge(opener=opener) == "failed"
    assert opener.open.call_count == 1


def test_cli_login_without_loopback_dashboard_cannot_ask(monkeypatch):
    monkeypatch.setattr(config, "SERVER_HOSTS", "0.0.0.0:37358")
    opener = MagicMock()

    assert auth_browser.start_sync_in_running_bridge(opener=opener) == "unknown"
    opener.open.assert_not_called()


class _RecordingHandler(http.server.BaseHTTPRequestHandler):
    """Records each request path; ``/start`` redirects to ``/elsewhere``."""

    def do_GET(self):
        self.server.paths.append(self.path)
        if self.path == "/start":
            self.send_response(302)
            self.send_header("Location", "/elsewhere")
        else:
            self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_args):
        pass


@contextlib.contextmanager
def _recording_server():
    server = http.server.HTTPServer(("127.0.0.1", 0), _RecordingHandler)
    server.paths = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_loopback_opener_bypasses_proxies_and_redirects(monkeypatch):
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    for name in ("no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)

    with _recording_server() as bridge, _recording_server() as proxy:
        bridge_url = f"http://127.0.0.1:{bridge.server_address[1]}"
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_address[1]}")

        # Control: a default opener honours the proxy variable.
        with urllib.request.build_opener().open(bridge_url + "/plain", timeout=5):
            pass
        assert proxy.paths == [bridge_url + "/plain"]
        assert bridge.paths == []

        opener = auth_browser._loopback_opener()
        with pytest.raises(urllib.error.HTTPError) as redirect:
            opener.open(bridge_url + "/start", timeout=5)

    assert redirect.value.code == 302
    assert bridge.paths == ["/start"]
    assert proxy.paths == [bridge_url + "/plain"]


# ---------------------------------------------------------------------------
# CLI side: next-step text
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _completed_login(outcome):
    server = MagicMock()
    event = MagicMock()

    def complete_auth(*_args, **_kwargs):
        server.authenticated_email = "alice@example.com"
        return True

    event.wait.side_effect = complete_auth
    asked = []

    def fake_start():
        asked.append(True)
        return outcome

    with (
        patch.object(auth_browser.config, "ensure_data_dir"),
        patch.object(auth_browser, "BoundedAuthHTTPServer", return_value=server),
        patch.object(auth_browser.threading, "Event", return_value=event),
        patch.object(auth_browser.threading, "Thread"),
        patch.object(auth_browser.webbrowser, "open"),
        patch.object(auth_browser, "_find_free_port", return_value=43999),
        patch.object(auth_browser, "start_sync_in_running_bridge", side_effect=fake_start),
    ):
        yield asked


@pytest.mark.parametrize(
    ("outcome", "expected", "start_hint"),
    [
        ("started", "The running bridge is now syncing this account.", False),
        ("failed", "Restart the bridge, or sign in again from the dashboard.", False),
        ("not_running", "Now start the bridge:", True),
        ("unknown", "If the bridge is already running, restart it", True),
    ],
)
def test_cli_login_prints_next_step(monkeypatch, capsys, outcome, expected, start_hint):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: "linux")

    with _completed_login(outcome) as asked:
        assert auth_browser.browser_login() == "alice@example.com"
    out = capsys.readouterr().out

    assert asked == [True]
    assert expected in out
    assert "./silentsuite-bridge" not in out
    assert "daemon" not in out
    assert ("    silentsuite-bridge\n" in out) is start_hint


def test_cli_login_start_hint_on_windows_keeps_bridge_running(monkeypatch, capsys):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")
    monkeypatch.setattr(config, "get_platform", lambda: "windows")

    with _completed_login("not_running"):
        auth_browser.browser_login()

    assert "    silentsuite-bridge --background\n" in capsys.readouterr().out


def test_tray_login_does_not_ask_over_http(monkeypatch, capsys):
    monkeypatch.setattr(config, "SERVER_HOSTS", f"127.0.0.1:{PORT}")

    with _completed_login("failed") as asked:
        assert auth_browser.browser_login(running_bridge=True) == "alice@example.com"

    assert asked == []
    assert "The bridge is already running." in capsys.readouterr().out
