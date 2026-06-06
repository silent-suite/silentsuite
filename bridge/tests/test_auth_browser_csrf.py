"""Tests for browser-auth CSRF handling."""

import http.server
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from silentsuite_bridge.auth_browser import AUTH_PAGE_HTML, AuthCallbackHandler


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
