"""Tests for browser-auth CSRF handling."""

import http.server
import json
import logging
import threading
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from silentsuite_bridge import auth_browser
from silentsuite_bridge.auth_browser import AUTH_PAGE_HTML, AuthCallbackHandler, browser_login


def _post_auth(server, fields):
    url = f"http://127.0.0.1:{server.server_address[1]}/auth"
    request = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(fields).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def _get_auth_path(server, path):
    url = f"http://127.0.0.1:{server.server_address[1]}{path}"
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def _serve_one_auth_request(csrf_token="expected-token"):
    server = http.server.HTTPServer(("127.0.0.1", 0), AuthCallbackHandler)
    server.csrf_token = csrf_token
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    return server, thread


def test_auth_page_contains_csrf_field():
    assert 'name="csrf_token"' in AUTH_PAGE_HTML
    assert 'value="CSRF_TOKEN"' in AUTH_PAGE_HTML


def test_auth_csrf_validation_requires_matching_token():
    assert AuthCallbackHandler._valid_csrf("expected", "expected") is True
    assert AuthCallbackHandler._valid_csrf("", "expected") is False
    assert AuthCallbackHandler._valid_csrf("wrong", "expected") is False
    assert AuthCallbackHandler._valid_csrf("expected", "") is False


def test_auth_request_logging_does_not_retain_request_target(caplog):
    private_target = "/auth?private.person@example.invalid"
    server, thread = _serve_one_auth_request()
    try:
        with caplog.at_level(logging.DEBUG, logger=auth_browser.logger.name):
            status, _ = _get_auth_path(server, private_target)
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 200
    assert private_target not in caplog.text
    assert "private.person@example.invalid" not in caplog.text
    assert "Auth server request completed (method=GET status=200)" in caplog.text


def test_auth_post_rejects_wrong_csrf_before_login():
    server, thread = _serve_one_auth_request()
    try:
        status, payload = _post_auth(server, {
            "email": "alice@example.com",
            "password": "secret",
            "server_url": "https://server.silentsuite.io",
            "csrf_token": "wrong-token",
        })
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 403
    assert payload == {"success": False, "error": "Invalid CSRF token."}


def test_auth_post_with_valid_csrf_reaches_login():
    server, thread = _serve_one_auth_request()
    try:
        with patch("silentsuite_bridge.auth_browser.Account.login", side_effect=Exception("401 Unauthorized")) as login:
            status, payload = _post_auth(server, {
                "email": "alice@example.com",
                "password": "secret",
                "server_url": "https://server.silentsuite.io",
                "csrf_token": "expected-token",
            })
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 401
    assert payload == {"success": False, "error": "Invalid email or password."}
    assert login.called


def test_auth_post_does_not_distinguish_unknown_account_from_wrong_password():
    server, thread = _serve_one_auth_request()
    try:
        with patch("silentsuite_bridge.auth_browser.Account.login", side_effect=Exception("404 Not Found")) as login:
            status, payload = _post_auth(server, {
                "email": "unknown@example.com",
                "password": "secret",
                "server_url": "https://server.silentsuite.io",
                "csrf_token": "expected-token",
            })
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 401
    assert payload == {"success": False, "error": "Invalid email or password."}
    assert login.called


def test_auth_success_redirect_does_not_include_email_query():
    server, thread = _serve_one_auth_request()
    etebase = MagicMock()
    etebase.save.return_value = "stored-session"
    try:
        with (
            patch("silentsuite_bridge.auth_browser.Account.login", return_value=etebase),
            patch(
                "silentsuite_bridge.auth_browser.store_authenticated_account",
                return_value=SimpleNamespace(username="alice@example.com"),
            ),
        ):
            status, payload = _post_auth(server, {
                "email": "alice@example.com",
                "password": "secret",
                "server_url": "https://server.silentsuite.io",
                "csrf_token": "expected-token",
            })
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 200
    assert payload == {"success": True, "redirect": "/success"}


def test_auth_persistence_failure_does_not_retain_exception_values(
    caplog,
    capsys,
):
    private_value = "/private/person/credentials.json?token=secret"
    server, thread = _serve_one_auth_request()
    etebase = MagicMock()
    etebase.save.return_value = "stored-session"
    try:
        with (
            patch("silentsuite_bridge.auth_browser.Account.login", return_value=etebase),
            patch(
                "silentsuite_bridge.auth_browser.store_authenticated_account",
                side_effect=RuntimeError(private_value),
            ),
            caplog.at_level(logging.ERROR, logger=auth_browser.logger.name),
        ):
            status, payload = _post_auth(server, {
                "email": "alice@example.com",
                "password": "secret",
                "server_url": "https://server.silentsuite.io",
                "csrf_token": "expected-token",
            })
    finally:
        server.server_close()
        thread.join(timeout=5)

    captured = capsys.readouterr()
    assert status == 500
    assert payload == {
        "success": False,
        "error": "Authentication could not be completed.",
    }
    assert private_value not in caplog.text
    assert private_value not in captured.out
    assert private_value not in captured.err
    assert all(record.exc_info is None for record in caplog.records)


def test_success_page_requires_completed_authentication():
    server = http.server.HTTPServer(("127.0.0.1", 0), AuthCallbackHandler)
    server.csrf_token = "expected-token"
    server.authenticated_email = None
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    try:
        status, body = _get_auth_path(server, "/success")
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 404
    assert "404" in body


def test_success_page_links_root_dashboard():
    server = http.server.HTTPServer(("127.0.0.1", 0), AuthCallbackHandler)
    server.csrf_token = "expected-token"
    server.authenticated_email = "alice@example.com"
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    try:
        status, body = _get_auth_path(server, "/success")
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 200
    assert "http://127.0.0.1:37358/" in body
    assert "/.web/" not in body


def test_success_page_uses_https_bridge_urls_when_ssl_enabled():
    server = http.server.HTTPServer(("127.0.0.1", 0), AuthCallbackHandler)
    server.csrf_token = "expected-token"
    server.authenticated_email = "alice@example.com"
    thread = threading.Thread(target=server.handle_request)
    thread.start()
    try:
        with patch("silentsuite_bridge.auth_browser.config.SSL_ENABLED", True):
            status, body = _get_auth_path(server, "/success")
    finally:
        server.server_close()
        thread.join(timeout=5)

    assert status == 200
    assert "https://127.0.0.1:37358/" in body
    assert "https://127.0.0.1:37358/alice@example.com/" in body
    assert "http://127.0.0.1:37358/" not in body


def test_browser_login_completion_does_not_print_account_or_server_values(capsys):
    server = MagicMock()
    event = MagicMock()

    def complete_auth(*_args, **_kwargs):
        server.authenticated_email = "alice@example.com"
        server.authenticated_server_url = "https://private-server.example.invalid"
        return True

    event.wait.side_effect = complete_auth
    with (
        patch("silentsuite_bridge.auth_browser.config.ensure_data_dir"),
        patch("silentsuite_bridge.auth_browser.config.SSL_ENABLED", True),
        patch("silentsuite_bridge.auth_browser.http.server.HTTPServer", return_value=server),
        patch("silentsuite_bridge.auth_browser.threading.Event", return_value=event),
        patch("silentsuite_bridge.auth_browser.threading.Thread"),
        patch("silentsuite_bridge.auth_browser.webbrowser.open"),
        patch("silentsuite_bridge.auth_browser._find_free_port", return_value=43999),
    ):
        assert browser_login(running_bridge=True) == "alice@example.com"

    output = capsys.readouterr().out
    assert "Dashboard will be available on the configured local listener." in output
    assert "CalDAV/CardDAV account configured." in output
    assert "alice@example.com" not in output
    assert "https://private-server.example.invalid" not in output


def test_rejected_server_replacement_does_not_change_process_default(monkeypatch):
    monkeypatch.setattr(
        auth_browser.config,
        "ETEBASE_SERVER_URL",
        "https://existing-server.test",
    )
    account = MagicMock()
    account.save.return_value = "replacement-session"
    monkeypatch.setattr(auth_browser.Account, "login", lambda *_args: account)
    monkeypatch.setattr(
        auth_browser,
        "store_authenticated_account",
        MagicMock(side_effect=ValueError("different server")),
    )

    with pytest.raises(ValueError, match="different server"):
        auth_browser.authenticate_and_store_account(
            "account@example.com",
            "password",
            "https://rejected-server.test",
        )

    assert auth_browser.config.ETEBASE_SERVER_URL == "https://existing-server.test"
