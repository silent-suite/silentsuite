"""Protocol-level tests for macOS Apple Accounts DAV discovery."""

import base64
import hashlib
import io
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock
from urllib.parse import quote

from radicale.app import Application

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.creds import Credentials

USERNAME = "alice@example.test"
PASSWORD = "correct-test-password"
DAV = "{DAV:}"
CALDAV = "{urn:ietf:params:xml:ns:caldav}"
CARDDAV = "{urn:ietf:params:xml:ns:carddav}"

APPLE_PRINCIPAL_BODY = b"""<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"
            xmlns:c="urn:ietf:params:xml:ns:caldav"
            xmlns:cr="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:current-user-principal />
    <d:principal-URL />
    <c:calendar-home-set />
    <cr:addressbook-home-set />
    <d:resourcetype />
  </d:prop>
</d:propfind>
"""
ALLPROP_BODY = b'<d:propfind xmlns:d="DAV:"><d:allprop /></d:propfind>'
PROPNAME_BODY = b'<d:propfind xmlns:d="DAV:"><d:propname /></d:propfind>'


def _seed_user(credentials_file: str) -> None:
    credentials = Credentials(filename=credentials_file)
    credentials.set_etebase(USERNAME, "fake-session", "https://server.test")
    credentials.set_password_hash(
        USERNAME,
        hashlib.sha256(PASSWORD.encode()).hexdigest(),
    )
    credentials.save()


def _basic_auth(username: str = USERNAME, password: str = PASSWORD) -> str:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {token}"


def _request(
    app,
    path: str,
    *,
    method: str = "PROPFIND",
    body: bytes = b"",
    depth: str | None = "0",
    auth: str | None = None,
    scheme: str = "http",
    user_agent: str | None = "macOS/15.7.7 accountsd/1.0",
    query: str = "",
):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = dict(headers)

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "QUERY_STRING": query,
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": str(len(body)),
        "CONTENT_TYPE": "application/xml; charset=utf-8",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": scheme,
        "wsgi.input": io.BytesIO(body),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if depth is not None:
        environ["HTTP_DEPTH"] = depth
    if auth is not None:
        environ["HTTP_AUTHORIZATION"] = auth
    if user_agent is not None:
        environ["HTTP_USER_AGENT"] = user_agent

    response_body = b"".join(app(environ, start_response))
    return captured["status"], captured["headers"], response_body


def _application(tmp_path, monkeypatch):
    credentials_file = str(tmp_path / "credentials.json")
    monkeypatch.setattr(config, "CREDS_FILE", credentials_file)
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "bridge.sqlite"))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    _seed_user(credentials_file)

    thread = MagicMock()
    thread.wait_for_sync.return_value = True
    monkeypatch.setattr(
        "silentsuite_bridge.radicale.storage.start_sync_thread",
        lambda _user: thread,
    )
    etesync = MagicMock()
    etesync.list.return_value = []
    context = MagicMock()
    context.__enter__.return_value = (etesync, False)
    context.__exit__.return_value = False
    monkeypatch.setattr(
        "silentsuite_bridge.radicale.storage.etesync_for_user",
        lambda _user: context,
    )
    return Application(bridge_main.build_radicale_configuration())


def _response_hrefs(body: bytes) -> list[str]:
    return [element.text or "" for element in ET.fromstring(body).iter(f"{DAV}href")]


def _prop_names(body: bytes) -> set[str]:
    root = ET.fromstring(body)
    prop = root.find(f"{DAV}response/{DAV}propstat/{DAV}prop")
    assert prop is not None
    return {child.tag for child in prop}


def test_authenticated_apple_principal_container_points_to_canonical_home(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    start_sync_thread = MagicMock()
    etesync_for_user = MagicMock()
    monkeypatch.setattr(bridge_storage, "start_sync_thread", start_sync_thread)
    monkeypatch.setattr(bridge_storage, "etesync_for_user", etesync_for_user)
    status, _headers, body = _request(
        app, "/principals/", body=APPLE_PRINCIPAL_BODY, auth=_basic_auth()
    )

    assert status == "207 Multi-Status"
    root = ET.fromstring(body)
    responses = root.findall(f"{DAV}response")
    assert len(responses) == 1
    assert responses[0].findtext(f"{DAV}href") == "/principals/"
    principal_href = responses[0].find(
        f"{DAV}propstat/{DAV}prop/{DAV}current-user-principal/{DAV}href"
    )
    assert principal_href is not None
    assert principal_href.text == f"/{quote(USERNAME)}/"
    resource_type = responses[0].find(f"{DAV}propstat/{DAV}prop/{DAV}resourcetype")
    assert resource_type is not None
    assert resource_type.find(f"{DAV}collection") is not None
    assert resource_type.find(f"{DAV}principal") is None
    assert responses[0].find(f"{DAV}propstat/{DAV}prop/{DAV}principal-URL/{DAV}href") is None
    assert responses[0].find(f"{DAV}propstat/{DAV}prop/{CALDAV}calendar-home-set/{DAV}href") is None
    assert responses[0].find(f"{DAV}propstat/{DAV}prop/{CARDDAV}addressbook-home-set/{DAV}href") is None
    start_sync_thread.assert_not_called()
    etesync_for_user.assert_not_called()


def test_anonymous_principal_discovery_forms_are_challenged(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    for body in (APPLE_PRINCIPAL_BODY, ALLPROP_BODY, PROPNAME_BODY, b""):
        status, headers, response_body = _request(app, "/principals/", body=body)
        assert status == "401 Unauthorized"
        assert headers["WWW-Authenticate"] == 'Basic realm="Radicale - Password Required"'
        assert response_body == b"Access to the requested resource forbidden."


def test_invalid_credentials_have_identical_responses(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    attempts = (
        _basic_auth("unknown@example.test", PASSWORD),
        _basic_auth(USERNAME, ""),
        _basic_auth(USERNAME, "wrong-password"),
    )
    responses = [_request(app, "/principals/", auth=auth) for auth in attempts]
    assert responses[0] == responses[1] == responses[2]
    status, headers, body = responses[0]
    assert status == "401 Unauthorized"
    assert headers == {
        "Content-Type": "text/plain; charset=utf-8",
        "WWW-Authenticate": 'Basic realm="Radicale - Password Required"',
        "Content-Length": "43",
    }
    assert body == b"Access to the requested resource forbidden."


def test_authenticated_allprop_and_empty_body_expose_only_static_metadata(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    expected_properties = {
        f"{DAV}principal-collection-set",
        f"{DAV}current-user-principal",
        f"{DAV}current-user-privilege-set",
        f"{DAV}supported-report-set",
        f"{DAV}resourcetype",
        f"{DAV}owner",
    }
    for body in (ALLPROP_BODY, b""):
        status, _headers, response_body = _request(
            app, "/principals/", body=body, auth=_basic_auth()
        )
        assert status == "207 Multi-Status"
        assert _prop_names(response_body) == expected_properties
        assert _response_hrefs(response_body) == [
            "/principals/",
            "/",
            f"/{quote(USERNAME)}/",
        ]


def test_authenticated_propname_exposes_only_static_property_names(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    status, _headers, body = _request(
        app, "/principals/", body=PROPNAME_BODY, auth=_basic_auth()
    )
    assert status == "207 Multi-Status"
    assert _prop_names(body) == {
        f"{DAV}principal-collection-set",
        f"{DAV}current-user-principal",
        f"{DAV}current-user-privilege-set",
        f"{DAV}supported-report-set",
        f"{DAV}resourcetype",
        f"{DAV}owner",
    }
    assert _response_hrefs(body) == ["/principals/"]


def test_authenticated_depth_forms_never_enumerate_principals(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    for depth in ("0", "1", "infinity", None, "", "2", "unknown"):
        status, _headers, body = _request(
            app,
            "/principals/",
            body=APPLE_PRINCIPAL_BODY,
            depth=depth,
            auth=_basic_auth(),
        )
        assert status == "207 Multi-Status"
        assert _response_hrefs(body) == ["/principals/", f"/{quote(USERNAME)}/"]


def test_principal_aliases_do_not_reveal_account_existence(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    responses = [
        _request(app, "/principals/bob@example.test/", auth=_basic_auth()),
        _request(app, "/principals/nobody@example.test/", auth=_basic_auth()),
        _request(app, f"/principals/{USERNAME}/", auth=_basic_auth()),
    ]
    assert responses[0] == responses[1] == responses[2]
    assert responses[0][0] == "403 Forbidden"


def test_principal_path_sanitation_preserves_existing_owner_boundary(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    for path in (
        "/principals",
        "/principals/",
        "//principals//",
        "/./principals/",
        "/principals/./",
    ):
        status, _headers, body = _request(app, path, auth=_basic_auth())
        assert status == "207 Multi-Status"
        assert _response_hrefs(body)[0] == "/principals/"

    for path in (
        f"/principals/{USERNAME}/",
        f"/principals//{USERNAME}/",
        f"/principals%2F{USERNAME}/",
        f"/principals/%2F{USERNAME}/",
        f"/principals/%2e%2e/{USERNAME}/",
        f"/principals\\{USERNAME}/",
        "/Principals/",
        "/príncipals/",
    ):
        status, _headers, _body = _request(app, path, auth=_basic_auth())
        assert status == "403 Forbidden"

    status, _headers, body = _request(
        app, f"/principals/../{USERNAME}/", auth=_basic_auth()
    )
    assert status == "207 Multi-Status"
    assert _response_hrefs(body)[0] == f"/{quote(USERNAME)}/"
    status, _headers, _body = _request(
        app, "/principals/../bob@example.test/", auth=_basic_auth()
    )
    assert status == "403 Forbidden"


def test_direct_dav_paths_and_user_agent_behavior_are_unchanged(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    for user_agent in ("macOS/15.7.7 AddressBookCore/2695.500.71", None):
        root_status, _headers, root_body = _request(
            app, "/", auth=_basic_auth(), user_agent=user_agent
        )
        home_status, _headers, home_body = _request(
            app, f"/{USERNAME}/", auth=_basic_auth(), user_agent=user_agent
        )
        assert root_status == home_status == "207 Multi-Status"
        assert f"/{quote(USERNAME)}/" in _response_hrefs(root_body)
        assert _response_hrefs(home_body)[0] == f"/{quote(USERNAME)}/"


def test_existing_well_known_redirects_are_preserved(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    for path in ("/.well-known/carddav", "/.well-known/caldav"):
        for auth in (None, _basic_auth()):
            for scheme in ("http", "https"):
                status, headers, _body = _request(
                    app,
                    path,
                    auth=auth,
                    scheme=scheme,
                    query="source=apple",
                )
                assert status == "301 Moved Permanently"
                assert headers["Location"] == "/"
