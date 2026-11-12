"""A 401 challenge must not leave a small request body unread (issue #992).

Radicale answers 401 without reading the body, and its server closes the
connection after each response. Unread body bytes at close make the OS send a
TCP reset, which can cost the client the challenge it needs to retry with a
password.
"""

import io

import pytest

from silentsuite_bridge.radicale import application as bridge_application

from tests.test_macos_dav_discovery import (
    APPLE_PRINCIPAL_BODY,
    PASSWORD,
    USERNAME,
    _application,
    _basic_auth,
)

REPORT_BODY = b"""<?xml version="1.0" encoding="utf-8"?>
<cr:addressbook-multiget xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag /><cr:address-data /></d:prop>
  <d:href>/alice@example.test/contacts/one.vcf</d:href>
</cr:addressbook-multiget>
"""
TRAILING_BYTES = b"NEXT-REQUEST-BYTES"


def _call(app, *, method="REPORT", path="/", body=REPORT_BODY, auth=None, expect=None):
    stream = io.BytesIO(body + TRAILING_BYTES)
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "HTTP_DEPTH": "0",
        "CONTENT_LENGTH": str(len(body)),
        "CONTENT_TYPE": "application/xml; charset=utf-8",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": stream,
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if auth is not None:
        environ["HTTP_AUTHORIZATION"] = auth
    if expect is not None:
        environ["HTTP_EXPECT"] = expect
    b"".join(app(environ, start_response))
    return captured["status"], stream.tell()


@pytest.fixture
def app(tmp_path, monkeypatch):
    application = _application(tmp_path, monkeypatch)
    application._auth_delay = 0
    return application


@pytest.mark.parametrize("method", ["REPORT", "PROPFIND", "PUT"])
def test_anonymous_challenge_reads_the_whole_body(app, method):
    status, consumed = _call(app, method=method, path=f"/{USERNAME}/")

    assert status == "401 Unauthorized"
    assert consumed == len(REPORT_BODY)


def test_wrong_password_challenge_reads_the_whole_body(app):
    status, consumed = _call(
        app, path=f"/{USERNAME}/", auth=_basic_auth(USERNAME, "wrong-" + PASSWORD)
    )

    assert status == "401 Unauthorized"
    assert consumed == len(REPORT_BODY)


def test_body_larger_than_the_limit_is_left_alone(app, monkeypatch):
    monkeypatch.setattr(bridge_application, "_UNAUTHORIZED_BODY_DRAIN_LIMIT", len(REPORT_BODY) - 1)

    status, consumed = _call(app, path=f"/{USERNAME}/")

    assert status == "401 Unauthorized"
    assert consumed == 0


def test_expect_continue_body_is_not_waited_for(app):
    status, consumed = _call(app, path=f"/{USERNAME}/", expect="100-continue")

    assert status == "401 Unauthorized"
    assert consumed == 0


def test_authenticated_request_reads_only_its_own_body(app):
    status, consumed = _call(
        app,
        method="PROPFIND",
        path="/principals/",
        body=APPLE_PRINCIPAL_BODY,
        auth=_basic_auth(),
    )

    assert status == "207 Multi-Status"
    assert consumed == len(APPLE_PRINCIPAL_BODY)
