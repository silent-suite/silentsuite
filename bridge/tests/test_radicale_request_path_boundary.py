"""Radicale 3.2.3 request-target decoding and path-sanitization contract."""

import base64
import hashlib
import io
import wsgiref.simple_server
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock
from urllib.parse import quote, unquote

import pytest
from radicale import pathutils
from radicale.server import RequestHandler

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale import application as bridge_application
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.application import Application
from silentsuite_bridge.radicale.creds import Credentials

USER = "alice@example.test"
PASSWORD = "correct-test-password"
DAV = "{DAV:}"
PATH_CASES = [
    (
        "/principals/alice@example.test/",
        "/principals/alice@example.test/",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals//alice@example.test/",
        "/principals//alice@example.test/",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals%2Falice@example.test/",
        "/principals/alice@example.test/",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals/%2Falice@example.test/",
        "/principals//alice@example.test/",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals/other/%2e%2e/alice@example.test/",
        "/principals/other/../alice@example.test/",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals/alice@example.test/child/%2e%2e/",
        "/principals/alice@example.test/child/../",
        "/principals/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals/%2e%2e/alice@example.test/",
        "/principals/../alice@example.test/",
        "/alice@example.test/",
        "207",
        True,
    ),
    (
        "/principals/alice@example.test%2Fchild/",
        "/principals/alice@example.test/child/",
        "/principals/alice@example.test/child/",
        "403",
        False,
    ),
    (
        "/principals/bob@example.test/",
        "/principals/bob@example.test/",
        "/principals/bob@example.test/",
        "403",
        False,
    ),
    (
        "/principals/alice@example.test/%2e%2e/bob@example.test/",
        "/principals/alice@example.test/../bob@example.test/",
        "/principals/bob@example.test/",
        "403",
        False,
    ),
    (
        "/Principals/alice@example.test/",
        "/Principals/alice@example.test/",
        "/Principals/alice@example.test/",
        "403",
        False,
    ),
    (
        "/principals/Alice@example.test/",
        "/principals/Alice@example.test/",
        "/principals/Alice@example.test/",
        "403",
        False,
    ),
    (
        "/principals/alice@example.test/child/",
        "/principals/alice@example.test/child/",
        "/principals/alice@example.test/child/",
        "403",
        False,
    ),
]


def _seed_user(credentials_file: str) -> None:
    credentials = Credentials(filename=credentials_file)
    credentials.set_etebase(USER, "fake-session", "https://server.test")
    credentials.set_password_hash(USER, hashlib.sha256(PASSWORD.encode()).hexdigest())
    credentials.save()


def _basic_auth() -> str:
    return "Basic " + base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()


def _request(app, path: str):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    environ = {
        "REQUEST_METHOD": "PROPFIND",
        "PATH_INFO": path,
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": "0",
        "CONTENT_TYPE": "application/xml; charset=utf-8",
        "HTTP_AUTHORIZATION": _basic_auth(),
        "HTTP_DEPTH": "0",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    body = b"".join(app(environ, start_response))
    return captured["status"], body


def _application(tmp_path, monkeypatch):
    credentials_file = str(tmp_path / "credentials.json")
    monkeypatch.setattr(config, "CREDS_FILE", credentials_file)
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "bridge.sqlite"))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    _seed_user(credentials_file)
    return Application(bridge_main.build_radicale_configuration())


def _paths_from_raw_target(monkeypatch, raw_target: str) -> tuple[str, str]:
    monkeypatch.setattr(wsgiref.simple_server.WSGIRequestHandler, "get_environ", lambda _self: {})
    handler = object.__new__(RequestHandler)
    handler.path = raw_target + "?ignored=query"
    handler.connection = object()
    decoded_path = handler.get_environ()["PATH_INFO"]
    return decoded_path, pathutils.sanitize_path(decoded_path)


@pytest.mark.parametrize(
    ("raw_target", "decoded_path", "sanitized_path", "expected_status", "has_canonical_href"),
    PATH_CASES,
)
def test_request_handler_decodes_sanitizes_and_dispatches_to_bridge(
    tmp_path,
    monkeypatch,
    raw_target,
    decoded_path,
    sanitized_path,
    expected_status,
    has_canonical_href,
):
    app = _application(tmp_path, monkeypatch)
    start_sync_thread = MagicMock()
    etesync_for_user = MagicMock()
    monkeypatch.setattr(bridge_storage, "start_sync_thread", start_sync_thread)
    monkeypatch.setattr(bridge_storage, "etesync_for_user", etesync_for_user)

    actual_decoded_path, actual_sanitized_path = _paths_from_raw_target(monkeypatch, raw_target)
    assert actual_decoded_path == decoded_path
    assert actual_sanitized_path == sanitized_path
    assert actual_decoded_path == unquote(raw_target)

    status, body = _request(app, actual_sanitized_path)
    assert status == f"{expected_status} {'Multi-Status' if expected_status == '207' else 'Forbidden'}"
    if has_canonical_href:
        hrefs = [element.text or "" for element in ET.fromstring(body).iter(f"{DAV}href")]
        assert hrefs[0] == f"/{quote(USER)}/"
        assert f"/principals/{quote(USER)}/" not in hrefs
    else:
        assert f"/principals/{quote(USER)}/" not in body.decode()
        assert f"/{quote(USER)}/" not in body.decode()
    start_sync_thread.assert_not_called()
    etesync_for_user.assert_not_called()


def test_same_account_alias_requires_canonicalization_at_wsgi_boundary(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    monkeypatch.setattr(bridge_application, "canonical_principal_alias_path", lambda path, _user: path)

    status, _body = _request(app, f"/principals/{USER}/")

    assert status == "403 Forbidden"
