"""Tests for the bridge dashboard renderer."""

import io
import json
import shutil
import subprocess
import threading
from unittest.mock import MagicMock

import pytest
from radicale.app import Application

import silentsuite_bridge.auth_browser as auth_browser
import silentsuite_bridge.web as web_module
from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import accounts, config
from silentsuite_bridge.accounts import AccountOperationResult
from silentsuite_bridge.auth_browser import AuthenticatedAccount, AuthenticationError
from silentsuite_bridge.local_cache.models import CollectionEntity, ItemEntity
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
from tests.settings_lock_holder import hold_settings_lock

NODE = shutil.which("node")

# Default Host header matching a localhost variant so the SEC-R7.4 Host check
# accepts the request. Tests that exercise the rejection path set this explicitly.
_LOCAL_HOST = "localhost:37358"


def _get_environ(host=_LOCAL_HOST):
    environ = {}
    if host is not None:
        environ["HTTP_HOST"] = host
    return environ


def _post_environ(body=b"", csrf_token=None, host=_LOCAL_HOST):
    environ = {
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": io.BytesIO(body),
    }
    if host is not None:
        environ["HTTP_HOST"] = host
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


def _wsgi_response(app, method, path):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "SCRIPT_NAME": "",
        # SEC-R7.4: the dashboard rejects non-local Host headers, so requests
        # routed through the full WSGI stack must carry a localhost Host header.
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(b""),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    body = b"".join(app(environ, start_response))
    return captured["status"], captured["headers"], body


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


def test_successful_account_does_not_clear_another_account_failure():
    _reset_status()

    update_status("error", error="SyncFailure", account="failed@example.com")
    update_status(
        "connected",
        collections={"calendars": 1, "contacts": 0, "tasks": 0},
        account="healthy@example.com",
    )

    assert _bridge_status["state"] == "error"
    assert _bridge_status["error"] == "One or more configured accounts failed to sync"


def test_render_dashboard_uses_https_urls_when_ssl_enabled(tmp_path, monkeypatch):
    """AC 11: with SSL enabled, account DAV URLs use https://."""
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", True)
    monkeypatch.setattr(
        web_module,
        "_account_fingerprint",
        lambda _creds, _username: None,
    )

    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.save()

    update_status(
        "connected",
        collections={"calendars": 2, "contacts": 1, "tasks": 0},
        scope="all configured accounts",
    )

    html = _render_dashboard()

    assert "https://127.0.0.1:37358/alice@example.com/" in html
    assert "http://127.0.0.1:37358/alice@example.com/" not in html
    assert "Advanced setup with SSL" in html


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


def test_add_account_button_bound_via_add_event_listener(tmp_path, monkeypatch):
    """#333: the Add/Re-authenticate button must not rely on an inline onclick
    resolving a global showLoginPanel function - bind via addEventListener."""
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()

    assert 'onclick="showLoginPanel()"' not in html
    assert "addEventListener('click', showLoginPanel)" in html
    # CSRF must be injected as a JSON string literal (no surrounding single quotes
    # in the template) so it is always valid JS.
    assert "window.SILENTSUITE_DASHBOARD_CSRF = {{CSRF_TOKEN}}" not in html


def test_dashboard_sync_script_checks_status_and_polls_request(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()

    assert "if (!r.ok)" in html
    assert "data.request_id" in html
    assert "encodeURIComponent(requestId)" in html
    assert "data.state === 'succeeded'" in html
    assert "data.state === 'failed' || data.state === 'timed_out'" in html


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

    status, headers, body = web.get(_get_environ(), "", "/.web/api/dump", None)

    assert status == 404
    assert headers == {}
    assert body == b"Not found"


def test_dump_api_requires_csrf_when_enabled(monkeypatch):
    monkeypatch.setattr(config, "DASHBOARD_DUMP_ENABLED", True)
    web = Web.__new__(Web)

    status, headers, body = web.get(_get_environ(), "", "/.web/api/dump", None)

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"


def test_dump_api_redacts_identifiers_and_remote_tokens(mem_db, user, monkeypatch):
    monkeypatch.setattr(config, "DASHBOARD_DUMP_ENABLED", True)
    collection = CollectionEntity.create(
        local_user=user,
        uid="private-address-book",
        stoken="private-remote-stoken",
        local_stoken="private-local-stoken",
        eb_col=b"collection-cache",
    )
    ItemEntity.create(
        collection=collection,
        uid="private-contact-uid",
        eb_item=b"item-cache",
        dirty=True,
    )
    environ = _get_environ()
    environ["HTTP_X_SILENTSUITE_CSRF"] = _dashboard_csrf_token
    web = Web.__new__(Web)

    status, _, body = web.get(environ, "", "/.web/api/dump", None)

    assert status == 200
    text = body.decode()
    assert "private-address-book" not in text
    assert "private-contact-uid" not in text
    assert "private-remote-stoken" not in text
    assert "private-local-stoken" not in text
    assert '"uid"' not in text
    assert '"stoken"' not in text
    assert '"local_stoken"' not in text


def test_root_route_serves_dashboard(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    web = Web.__new__(Web)

    status, headers, body = web.get(_get_environ(), "", "/", None)

    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"SilentSuite Bridge" in body
    assert b"dashboardLoginForm" in body


@pytest.mark.parametrize("path", ["/.web/", "/.web"])
def test_web_compat_route_serves_dashboard(path, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    web = Web.__new__(Web)

    status, headers, body = web.get(_get_environ(), "", path, None)

    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"SilentSuite Bridge" in body
    assert b"dashboardLoginForm" in body


@pytest.mark.parametrize("path", ["/", "/.web", "/.web/api/status"])
def test_dashboard_get_rejects_non_local_host(path, tmp_path, monkeypatch):
    # SEC-R7.4: a non-local Host header (DNS-rebinding / cross-origin) is
    # rejected before any dashboard processing.
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    web = Web.__new__(Web)

    status, headers, body = web.get(
        _get_environ(host="evil.example.com"), "", path, None
    )

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert "non-local Host" in json.loads(body)["error"]


def test_dashboard_post_rejects_non_local_host():
    # SEC-R7.4: non-local Host headers are rejected on mutating endpoints
    # before CSRF validation or body parsing.
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token, host="evil.example.com"),
        "",
        "/.web/api/sync",
        None,
    )

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert "non-local Host" in json.loads(body)["error"]


def test_radicale_root_redirect_terminates_at_dashboard(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "bridge_data.db"))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "is_dashboard_enabled", lambda: True)
    app = Application(bridge_main.build_radicale_configuration())

    status, headers, body = _wsgi_response(app, "GET", "/")

    assert status == "302 Found"
    assert headers["Location"] == "/.web"
    assert body == b"Redirected to /.web"

    status, headers, body = _wsgi_response(app, "GET", "/.web")

    assert status == "200 OK"
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert b"SilentSuite Bridge" in body

    status, headers, body = _wsgi_response(app, "HEAD", "/.web")

    assert status == "200 OK"
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert body == b""


def test_dashboard_post_requires_csrf_token():
    web = Web.__new__(Web)

    status, headers, body = web.post(_post_environ(), "", "/.web/api/sync", None)

    assert status == 403
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"


def test_dashboard_sync_post_returns_request_id_without_waiting(monkeypatch):
    web_module._sync_requests.clear()
    monkeypatch.setattr(accounts, "list_accounts", lambda: ["account@example.com"])
    thread = MagicMock()
    thread.is_alive.return_value = True
    thread.force_sync.return_value = 7
    thread.generation_status.return_value = {
        "generation": 7,
        "state": "pending",
        "started_at": None,
        "completed_at": None,
        "error_code": None,
    }
    monkeypatch.setattr(storage, "_sync_threads", {"account@example.com": thread})
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )

    assert status == 202
    assert headers["Content-Type"] == "application/json"
    payload = json.loads(body)
    assert payload["ok"] is True
    assert payload["state"] == "pending"
    assert payload["request_id"]
    thread.force_sync.assert_called_once()
    assert thread.force_sync.call_args.kwargs["deadline"] == payload["deadline"]
    thread.wait_for_sync.assert_not_called()


def test_dashboard_sync_post_fails_when_no_live_worker(monkeypatch):
    web_module._sync_requests.clear()
    thread = MagicMock()
    thread.is_alive.return_value = False
    monkeypatch.setattr(storage, "_sync_threads", {"account@example.com": thread})
    web = Web.__new__(Web)

    status, headers, body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )

    assert status == 503
    assert headers["Content-Type"] == "application/json"
    assert json.loads(body) == {
        "ok": False,
        "error": "No sync workers available",
    }


def test_dashboard_sync_request_reports_generation_completion(monkeypatch):
    web_module._sync_requests.clear()
    monkeypatch.setattr(accounts, "list_accounts", lambda: ["account@example.com"])
    thread = MagicMock()
    thread.is_alive.return_value = True
    thread.force_sync.return_value = 7
    thread.generation_status.return_value = {
        "generation": 7,
        "state": "succeeded",
        "started_at": 100.0,
        "completed_at": 101.0,
        "error_code": None,
    }
    monkeypatch.setattr(storage, "_sync_threads", {"account@example.com": thread})
    web = Web.__new__(Web)
    _, _, post_body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )
    request_id = json.loads(post_body)["request_id"]

    status, headers, body = web.get(
        _get_environ(),
        "",
        f"/.web/api/sync/{request_id}",
        None,
    )

    assert status == 200
    assert headers["Content-Type"] == "application/json"
    payload = json.loads(body)
    assert payload["request_id"] == request_id
    assert payload["state"] == "succeeded"
    assert payload["accounts"] == {
        "total": 1,
        "pending": 0,
        "running": 0,
        "succeeded": 1,
        "failed": 0,
        "timed_out": 0,
    }
    assert "account@example.com" not in body.decode()


def test_dashboard_sync_waits_for_all_configured_accounts(monkeypatch):
    web_module._sync_requests.clear()
    monkeypatch.setattr(
        accounts,
        "list_accounts",
        lambda: ["live@example.com", "missing@example.com"],
    )
    thread = MagicMock()
    thread.is_alive.return_value = True
    thread.force_sync.return_value = 4
    thread.generation_status.return_value = {
        "generation": 4,
        "state": "running",
        "started_at": 100.0,
        "completed_at": None,
        "error_code": None,
    }
    monkeypatch.setattr(storage, "_sync_threads", {"live@example.com": thread})
    web = Web.__new__(Web)

    _, _, first_body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )
    first = json.loads(first_body)
    assert first["state"] == "running"
    assert first["accounts"]["failed"] == 1

    _, _, duplicate_body = web.post(
        _post_environ(csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/sync",
        None,
    )
    assert json.loads(duplicate_body)["request_id"] == first["request_id"]

    thread.generation_status.return_value = {
        "generation": 4,
        "state": "succeeded",
        "started_at": 100.0,
        "completed_at": 101.0,
        "error_code": None,
    }
    _, _, final_body = web.get(
        _get_environ(),
        "",
        f"/.web/api/sync/{first['request_id']}",
        None,
    )
    final = json.loads(final_body)
    assert final["state"] == "partial_failure"
    assert final["accounts"]["succeeded"] == 1
    assert final["accounts"]["failed"] == 1


def test_abandoned_completed_request_survives_generation_history_pruning():
    web_module._sync_requests.clear()
    thread = storage.SyncThread("account@example.com")
    generation = thread.force_sync(deadline=1000.0)
    handle = thread.generation_handle(generation)
    request_id = "request-id"
    web_module._sync_requests[request_id] = {
        "requested_at": 900.0,
        "deadline": 1000.0,
        "targets": [{
            "thread": thread,
            "generation": generation,
            "status_handle": handle,
        }],
        "signature": ((id(thread), generation),),
        "terminal_result": None,
        "terminal_at": None,
    }
    thread._complete_generation(generation, "succeeded", 950.0)

    for _ in range(105):
        later_generation = thread.force_sync()
        thread._begin_generation()
        thread._complete_generation(later_generation, "succeeded", 951.0)
    assert thread.generation_status(generation) is None

    web_module._prune_sync_requests(1001.0)

    result = web_module._sync_requests[request_id]["terminal_result"]
    assert result["state"] == "succeeded"
    assert result["accounts"]["succeeded"] == 1


def test_concurrent_poll_cannot_regress_or_evict_published_terminal_result(monkeypatch):
    web_module._sync_requests.clear()
    thread = MagicMock()
    thread.is_alive.return_value = True
    request_id = "request-id"
    terminal = {
        "request_id": request_id,
        "state": "succeeded",
        "requested_at": 1.0,
        "deadline": 31.0,
        "accounts": {
            "total": 1,
            "pending": 0,
            "running": 0,
            "succeeded": 1,
            "failed": 0,
            "timed_out": 0,
        },
    }
    web_module._sync_requests[request_id] = {
        "requested_at": 1.0,
        "deadline": 31.0,
        "targets": [{
            "thread": thread,
            "generation": 1,
            "status_handle": None,
        }],
        "signature": ((id(thread), 1),),
        "terminal_result": None,
        "terminal_at": None,
    }

    def publish_terminal_during_poll(_generation):
        web_module._sync_requests[request_id]["terminal_result"] = terminal
        web_module._sync_requests[request_id]["terminal_at"] = 2.0
        monkeypatch.setattr(web_module, "_sync_request_retention", 0)
        web_module._prune_sync_requests(3.0)
        return {"state": "pending"}

    thread.generation_status.side_effect = publish_terminal_during_poll

    assert web_module._sync_request_status(request_id) == terminal
    assert request_id in web_module._sync_requests
    assert web_module._sync_request_status(request_id) == terminal


def test_expired_poll_lease_reinserts_terminal_result():
    web_module._sync_requests.clear()
    thread = MagicMock()
    thread.is_alive.return_value = True
    request_id = "expired-lease-request"
    web_module._sync_requests[request_id] = {
        "requested_at": 1.0,
        "deadline": 31.0,
        "targets": [{
            "thread": thread,
            "generation": 1,
            "status_handle": None,
        }],
        "signature": ((id(thread), 1),),
        "terminal_result": None,
        "terminal_at": None,
    }

    def expire_during_poll(_generation):
        web_module._sync_requests.pop(request_id, None)
        return {"state": "succeeded"}

    thread.generation_status.side_effect = expire_during_poll

    result = web_module._sync_request_status(request_id)
    assert result["state"] == "succeeded"
    assert request_id in web_module._sync_requests
    assert web_module._sync_request_status(request_id)["state"] == "succeeded"


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


# --- Settings failures must never look like success (#658) ------------------


def _isolated_settings(tmp_path, monkeypatch, current_interval=900):
    settings_file = tmp_path / "settings.json"
    monkeypatch.setattr(config, "SETTINGS_FILE", str(settings_file))
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SYNC_INTERVAL", current_interval)
    return settings_file


def _post_interval(seconds):
    body = json.dumps({"syncInterval": seconds}).encode()
    return Web.__new__(Web).post(
        _post_environ(body=body, csrf_token=_dashboard_csrf_token),
        "",
        "/.web/api/settings",
        None,
    )


def test_dashboard_settings_post_reports_unconfirmed_durability_as_failure(tmp_path, monkeypatch):
    settings_file = _isolated_settings(tmp_path, monkeypatch)
    settings_file.write_text(json.dumps({"network": {"listenPort": 45123}}), encoding="utf-8")

    def refuse_directory_sync(directory):
        raise OSError("EIO")

    monkeypatch.setattr(config, "_fsync_directory", refuse_directory_sync)

    status, headers, response_body = _post_interval(60)

    assert status == 500
    assert headers["Content-Type"] == "application/json"
    error = json.loads(response_body)["error"]
    assert "not confirmed durable" in error
    assert "retry" in error
    # The replace completed (content visible, profile intact) but the running
    # interval was not switched on an unconfirmed write.
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "network": {"listenPort": 45123},
        "syncInterval": 60,
    }
    assert config.SYNC_INTERVAL == 900


def test_dashboard_settings_post_reports_write_failure_and_keeps_interval(tmp_path, monkeypatch):
    settings_file = _isolated_settings(tmp_path, monkeypatch)
    settings_file.write_text(json.dumps({"network": {"listenPort": 45123}}), encoding="utf-8")
    original = settings_file.read_text(encoding="utf-8")

    def refuse_replace(src, dst):
        raise OSError("disk full")

    monkeypatch.setattr(config.os, "replace", refuse_replace)

    status, _, response_body = _post_interval(60)

    assert status == 500
    assert "was not changed" in json.loads(response_body)["error"]
    assert settings_file.read_text(encoding="utf-8") == original
    assert config.SYNC_INTERVAL == 900


def test_dashboard_settings_post_waits_for_a_concurrent_install_and_keeps_its_profile(tmp_path, monkeypatch):
    settings_file = _isolated_settings(tmp_path, monkeypatch)
    settings_file.write_text(json.dumps({"syncInterval": 900}), encoding="utf-8")
    outcome = {}

    def post():
        try:
            outcome["response"] = _post_interval(60)
        except BaseException as exc:  # reported by the main thread
            outcome["error"] = exc

    # --install-autostart in another process has read settings.json and holds
    # the lock; the dashboard's write must wait for it rather than interleave.
    with hold_settings_lock(tmp_path, {"network": {"listenPort": 45123}}) as installer:
        assert installer.snapshot == {"syncInterval": 900}

        request = threading.Thread(target=post)
        request.start()
        request.join(timeout=1.0)

        assert request.is_alive(), outcome
        assert json.loads(settings_file.read_text(encoding="utf-8")) == {"syncInterval": 900}
        assert config.SYNC_INTERVAL == 900

        assert installer.written == {"syncInterval": 900, "network": {"listenPort": 45123}}

    request.join(timeout=config.SETTINGS_LOCK_TIMEOUT + 5)
    assert not request.is_alive()
    assert "error" not in outcome, outcome
    status, _, response_body = outcome["response"]
    assert status == 200
    assert json.loads(response_body) == {"ok": True, "syncInterval": 60}
    assert config.SYNC_INTERVAL == 60
    # The dashboard merged over the completed install: the profile survived.
    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "syncInterval": 60,
        "network": {"listenPort": 45123},
    }


def test_dashboard_settings_post_reports_lock_contention_without_changing_interval(tmp_path, monkeypatch):
    settings_file = _isolated_settings(tmp_path, monkeypatch)
    settings_file.write_text(json.dumps({"syncInterval": 900}), encoding="utf-8")
    original = settings_file.read_text(encoding="utf-8")
    monkeypatch.setattr(config, "SETTINGS_LOCK_TIMEOUT", 0.2)

    with hold_settings_lock(tmp_path, {"network": {"listenPort": 45123}}) as installer:
        status, headers, response_body = _post_interval(60)

        assert status == 503
        assert headers["Content-Type"] == "application/json"
        error = json.loads(response_body)["error"]
        assert "Another bridge process is updating settings.json" in error
        assert "was not changed" in error
        assert settings_file.read_text(encoding="utf-8") == original
        assert config.SYNC_INTERVAL == 900

        assert installer.written == {"syncInterval": 900, "network": {"listenPort": 45123}}

    assert json.loads(settings_file.read_text(encoding="utf-8")) == {
        "syncInterval": 900,
        "network": {"listenPort": 45123},
    }


def _extract_js_function(html, name):
    """Return the source of top-level ``function name(...) {...}`` from the dashboard script."""
    start = html.index(f"function {name}(")
    depth = 0
    for index in range(html.index("{", start), len(html)):
        if html[index] == "{":
            depth += 1
        elif html[index] == "}":
            depth -= 1
            if depth == 0:
                return html[start:index + 1]
    raise AssertionError(f"unterminated function {name}")


def _rendered_scripts(html):
    """Every complete <script> block of the rendered dashboard, in document order."""
    scripts = []
    position = 0
    while True:
        start = html.find("<script>", position)
        if start == -1:
            return scripts
        end = html.index("</script>", start)
        scripts.append(html[start + len("<script>"):end])
        position = end


def test_rendered_dashboard_scripts_keep_javascript_escapes_through_the_python_template(tmp_path, monkeypatch):
    """The template is a Python string: a lone backslash escape is consumed by
    Python and reaches the browser unescaped, which breaks the whole script
    block (and with it every handler in it, including the interval save)."""
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()
    scripts = _rendered_scripts(html)

    assert len(scripts) == 3
    remove_prompt = [s for s in scripts if "function removeAccount(" in s][0]
    assert "that account\\'s local decrypted bridge cache" in remove_prompt
    assert "that account's local" not in remove_prompt


@pytest.mark.skipif(NODE is None, reason="node is required to parse the rendered dashboard scripts")
def test_rendered_dashboard_scripts_parse_completely(tmp_path, monkeypatch):
    """Parse each complete rendered <script> block with node, not extracted functions."""
    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(web_module, "_account_fingerprint", lambda _creds, username: f"fingerprint for {username}")
    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.save()

    html = _render_dashboard()
    scripts = _rendered_scripts(html)
    assert len(scripts) == 3

    for index, script in enumerate(scripts):
        path = tmp_path / f"dashboard-script-{index}.js"
        path.write_text(script, encoding="utf-8")
        check = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True, timeout=60)
        assert check.returncode == 0, f"script block {index} does not parse:\n{check.stderr}"


def _interval_script(html):
    """The dashboard's interval-save code: its script-level state plus the two functions it uses."""
    state_start = html.index("var intervalSave = {")
    state = html[state_start:html.index("};", state_start) + 2]
    functions = (_extract_js_function(html, name) for name in ("handleJsonResponse", "updateInterval"))
    return "\n".join([state, *functions])


def test_dashboard_interval_script_checks_the_http_status_before_reporting_saved(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))

    html = _render_dashboard()
    source = _extract_js_function(html, "updateInterval")

    assert ".then(handleJsonResponse)" in source
    assert "return r.json()" not in source
    assert "'Saved'" in source.split(".then(handleJsonResponse)", 1)[1]
    assert "sel.setAttribute('data-saved', sel.value)" in html
    # Serialized saves: in-flight guard, disabled selector, cancelled clear timer.
    assert "if (intervalSave.pending)" in source
    assert "select.disabled = true;" in source
    assert "clearTimeout(intervalSave.clearTimer)" in source


DURABILITY_ERROR = "settings.json was replaced but not confirmed durable; retry to confirm the sync interval"
WRITE_ERROR = "Could not write settings.json; the sync interval was not changed"
LOCK_ERROR = "Another bridge process is updating settings.json; the sync interval was not changed, retry shortly"

UPDATE_INTERVAL_SCENARIOS = [
    {"id": "ok", "status": 200, "body": {"ok": True, "syncInterval": 300}},
    {"id": "durability-unconfirmed", "status": 500, "body": {"error": DURABILITY_ERROR}},
    {"id": "write-failed", "status": 500, "body": {"error": WRITE_ERROR}},
    {"id": "lock-held", "status": 503, "body": {"error": LOCK_ERROR}},
    {"id": "csrf-rejected", "status": 403, "body": {"error": "Invalid dashboard CSRF token"}},
    {"id": "non-json-error-page", "status": 502, "body": None},
    {"id": "transport-failure", "status": 0, "body": None, "transportError": True},
]

# Runs the extracted dashboard functions in a bare V8 context with a fake
# document/fetch: the same code path a browser executes, minus the DOM.
UPDATE_INTERVAL_HARNESS = r"""
'use strict';
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const scenarios = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

function element(value) {
    const attributes = {};
    return {
        value: value,
        textContent: '',
        style: {},
        getAttribute: function(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        setAttribute: function(name, v) { attributes[name] = String(v); }
    };
}

function response(spec) {
    if (spec.transportError) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        json: function() {
            if (spec.body === null) return Promise.reject(new SyntaxError('Unexpected token < in JSON'));
            return Promise.resolve(spec.body);
        }
    });
}

async function flush() {
    for (let i = 0; i < 20; i++) await new Promise(function(r) { setImmediate(r); });
}

// Page state shared by both modes: fake select/status elements, a fetch that
// either answers immediately (single-request mode) or hands out deferreds the
// scenario settles explicitly (step mode), and timers that are only fired on
// request so stale-timer cancellation is observable.
function page(scenario) {
    const select = element('300');
    select.disabled = false;
    select.setAttribute('data-saved', '900');
    const status = element('');
    const requests = [];
    const deferreds = [];
    const timers = [];
    const sandbox = {
        window: { SILENTSUITE_DASHBOARD_CSRF: 'csrf-token' },
        document: {
            getElementById: function(id) {
                if (id === 'syncInterval') return select;
                if (id === 'syncIntervalStatus') return status;
                return null;
            }
        },
        fetch: function(url, init) {
            requests.push({ url: url, method: init.method, csrf: init.headers['X-SilentSuite-CSRF'], body: init.body });
            if (!scenario.steps) return response(scenario);
            let settle;
            const promise = new Promise(function(resolve) { settle = resolve; });
            deferreds.push(function(spec) { settle(response(spec)); });
            return promise;
        },
        setTimeout: function(fn, delay) {
            timers.push({ fn: fn, delay: delay, cleared: false, fired: false });
            return timers.length - 1;
        },
        clearTimeout: function(id) { if (timers[id]) timers[id].cleared = true; }
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(source, context);
    return { select: select, status: status, requests: requests, deferreds: deferreds, timers: timers, context: context };
}

function snapshot(p) {
    return {
        status: p.status.textContent,
        color: p.status.style.color,
        selected: p.select.value,
        saved: p.select.getAttribute('data-saved'),
        disabled: p.select.disabled,
        requests: p.requests.map(function(r) { return r.body; }),
        timers: p.timers.map(function(t) { return { delay: t.delay, cleared: t.cleared, fired: t.fired }; })
    };
}

async function run(scenario) {
    const p = page(scenario);
    let result = vm.runInContext('updateInterval()', p.context);
    try { await result; } catch (e) {}
    await flush();
    const state = snapshot(p);
    return {
        id: scenario.id,
        status: state.status,
        color: state.color,
        selected: state.selected,
        saved: state.saved,
        disabled: state.disabled,
        requests: p.requests,
        timers: p.timers.map(function(t) { return t.delay; })
    };
}

// Step mode: each step sets the dropdown and calls updateInterval(), settles a
// pending request out of order, fires live timers, or records a snapshot.
async function runSteps(scenario) {
    const p = page(scenario);
    const calls = [];
    const snapshots = {};
    for (const step of scenario.steps) {
        if (step.set !== undefined) {
            p.select.value = step.set;
            const promise = vm.runInContext('updateInterval()', p.context);
            calls.push({ sameAsFirst: calls.length > 0 && promise === calls[0].promise, promise: promise });
        } else if (step.settle !== undefined) {
            if (!p.deferreds[step.settle]) throw new Error('no request #' + step.settle + ' to settle in ' + scenario.id);
            p.deferreds[step.settle](step);
        } else if (step.fireTimers) {
            for (const t of p.timers) { if (!t.cleared && !t.fired) { t.fired = true; t.fn(); } }
        } else if (step.snapshot) {
            snapshots[step.snapshot] = snapshot(p);
        }
        await flush();
    }
    for (const call of calls) { try { await call.promise; } catch (e) {} }
    await flush();
    snapshots.final = snapshot(p);
    return { id: scenario.id, snapshots: snapshots, calls: calls.map(function(c) { return { sameAsFirst: c.sameAsFirst }; }) };
}

(async function() {
    const results = [];
    for (const scenario of scenarios) results.push(scenario.steps ? await runSteps(scenario) : await run(scenario));
    process.stdout.write(JSON.stringify(results));
})().catch(function(err) { console.error(err && err.stack || err); process.exit(1); });
"""


@pytest.mark.skipif(NODE is None, reason="node is required to execute the dashboard script")
def test_dashboard_update_interval_never_shows_saved_on_http_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    html = _render_dashboard()
    script = tmp_path / "dashboard-interval.js"
    script.write_text(_interval_script(html), encoding="utf-8")
    scenarios = tmp_path / "scenarios.json"
    scenarios.write_text(json.dumps(UPDATE_INTERVAL_SCENARIOS), encoding="utf-8")
    harness = tmp_path / "harness.js"
    harness.write_text(UPDATE_INTERVAL_HARNESS, encoding="utf-8")

    run = subprocess.run(
        [NODE, str(harness), str(script), str(scenarios)],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert run.returncode == 0, run.stderr
    results = {result["id"]: result for result in json.loads(run.stdout)}
    assert set(results) == {scenario["id"] for scenario in UPDATE_INTERVAL_SCENARIOS}

    ok = results["ok"]
    assert ok["status"] == "Saved"
    assert ok["selected"] == "300"
    assert ok["saved"] == "300"
    assert ok["disabled"] is False
    assert ok["timers"] == [2000]
    assert ok["requests"] == [
        {"url": "/.web/api/settings", "method": "POST", "csrf": "csrf-token", "body": '{"syncInterval":300}'}
    ]

    for scenario in UPDATE_INTERVAL_SCENARIOS:
        if scenario["id"] == "ok":
            continue
        failed = results[scenario["id"]]
        assert failed["status"] != "Saved", scenario["id"]
        assert failed["status"].startswith("Not saved: "), scenario["id"]
        assert failed["color"] == "#ff8a8a", scenario["id"]
        # The dropdown goes back to the last confirmed value and the error stays visible.
        assert failed["selected"] == "900", scenario["id"]
        assert failed["saved"] == "900", scenario["id"]
        assert failed["disabled"] is False, scenario["id"]
        assert failed["timers"] == [], scenario["id"]
        assert len(failed["requests"]) == 1, scenario["id"]
        if scenario["body"] and "error" in scenario["body"]:
            assert failed["status"] == "Not saved: " + scenario["body"]["error"], scenario["id"]
    assert results["transport-failure"]["status"] == "Not saved: Failed to fetch"


# Overlapping programmatic saves. Each step either changes the dropdown and
# calls updateInterval(), settles a specific outstanding request (any order),
# fires the timers still alive, or records a snapshot of the page state.
OVERLAP_SCENARIOS = [
    {
        # The review case: 300 then 60 while 300 is in flight; the newer save
        # fails after the older one succeeded. The dropdown must end on the
        # acknowledged 300, the error must stay visible, and no stale
        # "Saved" clear timer may wipe it.
        "id": "later-failure-after-earlier-success",
        "steps": [
            {"set": "300"},
            {"snapshot": "first-sent"},
            {"set": "60"},
            {"snapshot": "second-queued"},
            {"settle": 0, "status": 200, "body": {"ok": True, "syncInterval": 300}},
            {"snapshot": "first-acknowledged"},
            {"settle": 1, "status": 500, "body": {"error": WRITE_ERROR}},
            {"snapshot": "second-failed"},
            {"fireTimers": True},
        ],
    },
    {
        "id": "both-succeed-in-order",
        "steps": [
            {"set": "300"},
            {"set": "60"},
            {"settle": 0, "status": 200, "body": {"ok": True, "syncInterval": 300}},
            {"snapshot": "first-acknowledged"},
            {"settle": 1, "status": 200, "body": {"ok": True, "syncInterval": 60}},
            {"snapshot": "second-acknowledged"},
            {"fireTimers": True},
        ],
    },
    {
        "id": "acknowledged-value-wins",
        "steps": [
            {"set": "300"},
            {"settle": 0, "status": 200, "body": {"ok": True, "syncInterval": 60}},
        ],
    },
    {
        "id": "repeat-of-acknowledged-value-is-not-resent",
        "steps": [
            {"set": "300"},
            {"set": "300"},
            {"settle": 0, "status": 200, "body": {"ok": True, "syncInterval": 300}},
        ],
    },
]


@pytest.mark.skipif(NODE is None, reason="node is required to execute the dashboard script")
def test_dashboard_update_interval_serializes_overlapping_saves_and_cancels_stale_timers(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    html = _render_dashboard()
    script = tmp_path / "dashboard-interval.js"
    script.write_text(_interval_script(html), encoding="utf-8")
    scenarios = tmp_path / "scenarios.json"
    scenarios.write_text(json.dumps(OVERLAP_SCENARIOS), encoding="utf-8")
    harness = tmp_path / "harness.js"
    harness.write_text(UPDATE_INTERVAL_HARNESS, encoding="utf-8")

    run = subprocess.run(
        [NODE, str(harness), str(script), str(scenarios)],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert run.returncode == 0, run.stderr
    results = {result["id"]: result for result in json.loads(run.stdout)}
    assert set(results) == {scenario["id"] for scenario in OVERLAP_SCENARIOS}

    review_case = results["later-failure-after-earlier-success"]
    snaps = review_case["snapshots"]
    first_sent = snaps["first-sent"]
    assert first_sent["requests"] == ['{"syncInterval":300}']
    assert first_sent["disabled"] is True
    assert first_sent["status"] == "Saving..."
    # The second call while one is in flight sends nothing and shares the pending promise.
    queued = snaps["second-queued"]
    assert queued["requests"] == ['{"syncInterval":300}']
    assert queued["disabled"] is True
    assert review_case["calls"][1]["sameAsFirst"] is True
    # Once 300 is acknowledged the queued 60 goes out immediately, still
    # serialized: the selector stays disabled and the "Saved" clear timer from
    # the first save is cancelled before it can touch the second save's status.
    acknowledged = snaps["first-acknowledged"]
    assert acknowledged["status"] == "Saving..."
    assert acknowledged["saved"] == "300"
    assert acknowledged["requests"] == ['{"syncInterval":300}', '{"syncInterval":60}']
    assert acknowledged["disabled"] is True
    assert acknowledged["timers"] == [{"delay": 2000, "cleared": True, "fired": False}]
    # The failure of 60 reverts to the acknowledged 300 (not the original 900),
    # re-enables the selector and schedules nothing that could hide the error.
    failed = snaps["second-failed"]
    assert failed["status"] == "Not saved: " + WRITE_ERROR
    assert failed["selected"] == "300"
    assert failed["saved"] == "300"
    assert failed["disabled"] is False
    assert failed["timers"] == [{"delay": 2000, "cleared": True, "fired": False}]
    # Firing whatever timers are still alive leaves the error visible.
    assert snaps["final"]["status"] == "Not saved: " + WRITE_ERROR
    assert snaps["final"]["selected"] == "300"

    ordered = results["both-succeed-in-order"]["snapshots"]
    assert ordered["first-acknowledged"]["saved"] == "300"
    assert ordered["second-acknowledged"]["status"] == "Saved"
    assert ordered["second-acknowledged"]["selected"] == "60"
    assert ordered["second-acknowledged"]["saved"] == "60"
    assert ordered["second-acknowledged"]["disabled"] is False
    assert [t["cleared"] for t in ordered["second-acknowledged"]["timers"]] == [True, False]
    # Only the live timer clears the "Saved" text.
    assert ordered["final"]["status"] == ""
    assert [t["fired"] for t in ordered["final"]["timers"]] == [False, True]

    reconciled = results["acknowledged-value-wins"]["snapshots"]["final"]
    assert reconciled["status"] == "Saved"
    assert reconciled["selected"] == "60"
    assert reconciled["saved"] == "60"
    assert reconciled["disabled"] is False

    repeated = results["repeat-of-acknowledged-value-is-not-resent"]
    assert repeated["calls"][1]["sameAsFirst"] is True
    assert repeated["snapshots"]["final"]["requests"] == ['{"syncInterval":300}']
    assert repeated["snapshots"]["final"]["status"] == "Saved"
    assert repeated["snapshots"]["final"]["disabled"] is False
