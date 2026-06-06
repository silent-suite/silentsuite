"""Tests for the bridge dashboard renderer."""

import io
import json

import pytest

import silentsuite_bridge.auth_browser as auth_browser
import silentsuite_bridge.web as web_module
from silentsuite_bridge import accounts, config
from silentsuite_bridge.accounts import AccountOperationResult
from silentsuite_bridge.auth_browser import AuthenticatedAccount, AuthenticationError
from silentsuite_bridge.radicale import storage
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import (
    Web,
    _bridge_status,
    _dashboard_csrf_token,
    _render_dashboard,
    forget_account_status,
    update_status,
)


def _post_environ(body=b"", csrf_token=None):
    environ = {
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
    }
    if csrf_token is not None:
        environ["HTTP_X_SILENTSUITE_CSRF"] = csrf_token
    return environ


def _reset_status():
    _bridge_status.update({
        "state": "starting",
        "last_sync": None,
        "error": None,
        "collections": {"calendars": 0, "contacts": 0, "tasks": 0},
        "collections_by_account": {},
        "collections_scope": "all configured accounts",
    })


def test_render_dashboard_lists_each_configured_account(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(
        web_module,
        "_account_fingerprint",
        lambda _creds, username: f"fingerprint for {username}",
    )

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.set_etebase("bob@example.com", "bob-session", "https://server-b.test")
    creds.save()

    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 1, "tasks": 0},
        scope="all configured accounts",
    )

    html = _render_dashboard()

    assert "alice@example.com" in html
    assert "bob@example.com" in html
    assert "https://server-a.test" in html
    assert "https://server-b.test" in html
    assert "http://127.0.0.1:37358/alice@example.com/" in html
    assert "http://127.0.0.1:37358/bob@example.com/" in html
    assert "Collections (all configured accounts)" in html
    assert "2 calendars, 1 contacts, 0 tasks" in html
    assert "window.SILENTSUITE_DASHBOARD_CSRF" in html
    assert "X-SilentSuite-CSRF" in html
    assert "Add / Re-authenticate Account" in html
    assert "Add or re-authenticate an account" in html
    assert 'class="login-panel hidden"' in html
    assert 'data-account="alice@example.com"' in html
    assert 'onclick="logoutAccount(this)"' in html
    assert 'onclick="removeAccount(this)"' in html
    assert 'data-fingerprint="fingerprint for alice@example.com"' in html
    assert "Hidden until revealed" in html
    assert "Compare this with Android and the web app" in html
    assert 'onclick="toggleFingerprint(\'accountFingerprint0\', this)"' in html
    assert 'data-copy-target="accountFingerprint0"' in html


def test_update_status_aggregates_background_sync_counts(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(web_module, "_account_fingerprint", lambda _creds, _username: None)

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.set_etebase("bob@example.com", "bob-session", "https://server-b.test")
    creds.save()

    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 0, "tasks": 1},
        account="alice@example.com",
    )
    update_status(
        "connected",
        collections={"calendars": 1, "contacts": 3, "tasks": 0},
        account="bob@example.com",
    )

    assert _bridge_status["collections"] == {
        "calendars": 3,
        "contacts": 3,
        "tasks": 1,
    }
    assert _bridge_status["collections_scope"] == "all configured accounts"

    html = _render_dashboard()
    assert "3 calendars, 3 contacts, 1 tasks" in html


def test_render_dashboard_handles_no_accounts(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()

    assert "No accounts configured" in html
    assert "Set up your bridge account" in html
    assert 'data-required="true"' in html
    assert 'id="dashboardLoginForm"' in html
    assert 'name="password"' in html
    assert "Add / Re-authenticate Account" in html


def test_render_dashboard_escapes_account_action_attributes(tmp_path, monkeypatch):
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(web_module, "_account_fingerprint", lambda _creds, _username: None)

    username = "evil\"'<account@example.com"
    creds = Credentials()
    creds.set_etebase(username, "session", "https://server.test")
    creds.save()

    html = _render_dashboard()

    assert 'data-account="evil&quot;&#x27;&lt;account@example.com"' in html
    assert username not in html
    assert "logoutAccount('" not in html
    assert "removeAccount('" not in html


def test_forget_account_status_removes_one_accounts_counts():
    _reset_status()
    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 0, "tasks": 1},
        account="alice@example.com",
    )
    update_status(
        "connected",
        collections={"calendars": 1, "contacts": 3, "tasks": 0},
        account="bob@example.com",
    )

    forget_account_status("alice@example.com")

    assert _bridge_status["collections"] == {
        "calendars": 1,
        "contacts": 3,
        "tasks": 0,
    }
    assert "alice@example.com" not in _bridge_status["collections_by_account"]


def test_dump_api_returns_404_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "DASHBOARD_DUMP_ENABLED", False)
    web = Web.__new__(Web)

    status, headers, body = web.get({}, "", "/.web/api/dump", None)

    assert status == 404
    assert headers == {}
    assert body == b"Not found"


def test_root_route_serves_dashboard(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    web = Web.__new__(Web)

    status, headers, body = web.get({}, "", "/", None)

    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"SilentSuite Bridge" in body
    assert b"dashboardLoginForm" in body


@pytest.mark.parametrize("path", ["/.web/", "/.web"])
def test_web_compat_route_redirects_to_root(path):
    web = Web.__new__(Web)

    status, headers, body = web.get({}, "", path, None)

    assert status == 302
    assert headers["Location"] == "/"
    assert body == b""


def test_dashboard_post_requires_csrf_token():
    web = Web.__new__(Web)

    status, headers, body = web.post(_post_environ(), "", "/.web/api/sync", None)

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"


def test_dashboard_sync_post_accepts_valid_csrf_token():
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )

    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body) == {"ok": True}


def test_dashboard_sync_post_rejects_wrong_csrf_token():
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(csrf_token="not-the-token"),
        "",
        "/.web/api/sync",
        None,
    )

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"


def test_dashboard_account_login_requires_csrf_before_reading_body(monkeypatch):
    def fail_login(environ):
        raise AssertionError("login body should not be read without CSRF")

    monkeypatch.setattr(web_module, "_handle_account_login", fail_login)
    web = Web.__new__(Web)
    body = json.dumps({"email": "alice@example.com", "password": "secret"}).encode()

    status, _, _ = web.post(_post_environ(body=body), "", "/.web/api/accounts/login", None)

    assert status == 403


def test_dashboard_account_login_rejects_invalid_json():
    web = Web.__new__(Web)

    status, headers, response_body = web.post(
        _post_environ(body=b"{", csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/login",
        None,
    )

    assert status == 400
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Invalid JSON"


@pytest.mark.parametrize("payload", [{"email": "", "password": "secret"}, {"email": "alice@example.com"}])
def test_dashboard_account_login_requires_email_and_password(payload):
    web = Web.__new__(Web)
    body = json.dumps(payload).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/login",
        None,
    )

    assert status == 400
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Email and password are required"


def test_dashboard_account_login_returns_user_safe_auth_error(monkeypatch):
    def fail_auth(email, password, server_url=None):
        raise AuthenticationError("Invalid email or password.")

    monkeypatch.setattr(auth_browser, "authenticate_and_store_account", fail_auth)
    web = Web.__new__(Web)
    body = json.dumps({"email": "alice@example.com", "password": "wrong"}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/login",
        None,
    )

    assert status == 401
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Invalid email or password."


def test_dashboard_account_login_authenticates_and_refreshes_sync(monkeypatch):
    auth_calls = []
    refresh_calls = []

    def fake_auth(email, password, server_url=None):
        auth_calls.append((email, password, server_url))
        return AuthenticatedAccount(username="bob@example.com", server_url="https://server.test")

    monkeypatch.setattr(auth_browser, "authenticate_and_store_account", fake_auth)
    monkeypatch.setattr(storage, "refresh_sync_thread", refresh_calls.append)
    web = Web.__new__(Web)
    body = json.dumps({
        "email": " bob@example.com ",
        "password": "secret",
        "serverUrl": "https://server.test",
    }).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/login",
        None,
    )

    payload = json.loads(response_body)
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert payload["ok"] is True
    assert payload["username"] == "bob@example.com"
    assert payload["serverUrl"] == "https://server.test"
    assert payload["syncStarted"] is True
    assert "password" not in payload
    assert auth_calls == [("bob@example.com", "secret", "https://server.test")]
    assert refresh_calls == ["bob@example.com"]


def test_dashboard_account_login_reports_sync_refresh_failure_after_auth(monkeypatch):
    def fake_auth(email, password, server_url=None):
        return AuthenticatedAccount(username="bob@example.com", server_url="https://server.test")

    def fail_refresh(username):
        raise RuntimeError("thread failed")

    monkeypatch.setattr(auth_browser, "authenticate_and_store_account", fake_auth)
    monkeypatch.setattr(storage, "refresh_sync_thread", fail_refresh)
    web = Web.__new__(Web)
    body = json.dumps({"email": "bob@example.com", "password": "secret"}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/login",
        None,
    )

    payload = json.loads(response_body)
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert payload["ok"] is True
    assert payload["username"] == "bob@example.com"
    assert payload["syncStarted"] is False
    assert "sync could not start automatically" in payload["message"]
    assert "password" not in payload


@pytest.mark.parametrize(
    ("path", "helper_name"),
    [
        ("/.web/api/accounts/logout", "logout_account"),
        ("/.web/api/accounts/remove", "remove_account"),
    ],
)
def test_dashboard_account_mutation_requires_csrf_before_calling_helpers(monkeypatch, path, helper_name):
    def fail_helper(username):
        raise AssertionError("account helper should not run without CSRF")

    monkeypatch.setattr(accounts, helper_name, fail_helper)
    web = Web.__new__(Web)
    body = json.dumps({"username": "alice@example.com"}).encode()

    status, headers, response_body = web.post(_post_environ(body=body), "", path, None)

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Invalid dashboard CSRF token"


@pytest.mark.parametrize(
    "path",
    ["/.web/api/accounts/logout", "/.web/api/accounts/remove"],
)
def test_dashboard_account_mutation_rejects_invalid_json(path):
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(body=b"{", csrf_token=_dashboard_csrf_token),
        "",
        path,
        None,
    )

    assert status == 400
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body)["error"] == "Invalid JSON"


@pytest.mark.parametrize(
    "path",
    ["/.web/api/accounts/logout", "/.web/api/accounts/remove"],
)
def test_dashboard_account_mutation_requires_username(path):
    web = Web.__new__(Web)
    body = json.dumps({"username": "  "}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        path,
        None,
    )

    assert status == 400
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Account username is required"


def test_dashboard_account_logout_calls_account_helper(monkeypatch):
    calls = []

    def fake_logout(username):
        calls.append(username)
        return AccountOperationResult(username=username, existed=True, sync_stopped=True)

    monkeypatch.setattr(accounts, "logout_account", fake_logout)
    web = Web.__new__(Web)
    body = json.dumps({"username": "alice@example.com"}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/logout",
        None,
    )

    payload = json.loads(response_body)
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert calls == ["alice@example.com"]
    assert payload["ok"] is True
    assert payload["existed"] is True
    assert payload["syncStopped"] is True
    assert "Local bridge cache was kept" in payload["message"]


def test_dashboard_account_remove_calls_account_helper(monkeypatch):
    calls = []

    def fake_remove(username):
        calls.append(username)
        return AccountOperationResult(
            username=username,
            existed=True,
            sync_stopped=True,
            cache_cleared=True,
        )

    monkeypatch.setattr(accounts, "remove_account", fake_remove)
    web = Web.__new__(Web)
    body = json.dumps({"username": "alice@example.com"}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/accounts/remove",
        None,
    )

    payload = json.loads(response_body)
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert calls == ["alice@example.com"]
    assert payload["ok"] is True
    assert payload["existed"] is True
    assert payload["cacheCleared"] is True
    assert "Local bridge cache for this account was deleted" in payload["message"]


@pytest.mark.parametrize(
    ("path", "helper_name"),
    [
        ("/.web/api/accounts/logout", "logout_account"),
        ("/.web/api/accounts/remove", "remove_account"),
    ],
)
def test_dashboard_account_mutation_unknown_account_is_noop(monkeypatch, path, helper_name):
    def fake_helper(username):
        return AccountOperationResult(username=username, existed=False)

    monkeypatch.setattr(accounts, helper_name, fake_helper)
    web = Web.__new__(Web)
    body = json.dumps({"username": "ghost@example.com"}).encode()

    status, _, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        path,
        None,
    )

    payload = json.loads(response_body)
    assert status == 200
    assert payload["ok"] is True
    assert payload["existed"] is False
    assert "nothing changed" in payload["message"]


def test_dashboard_settings_post_requires_csrf_before_writing(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    web = Web.__new__(Web)
    body = json.dumps({"syncInterval": 60}).encode()

    status, _, _ = web.post(_post_environ(body=body), "", "/.web/api/settings", None)

    assert status == 403
    assert not settings_file.exists()


def test_dashboard_settings_post_rejects_wrong_csrf_before_writing(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    web = Web.__new__(Web)
    body = json.dumps({"syncInterval": 60}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token="not-the-token"),
        "",
        "/.web/api/settings",
        None,
    )

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body)["error"] == "Invalid dashboard CSRF token"
    assert not settings_file.exists()


def test_dashboard_settings_post_accepts_valid_csrf(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SYNC_INTERVAL", config.SYNC_INTERVAL)
    web = Web.__new__(Web)
    body = json.dumps({"syncInterval": 60}).encode()

    status, headers, response_body = web.post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/settings",
        None,
    )

    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert json.loads(response_body) == {"ok": True, "syncInterval": 60}
