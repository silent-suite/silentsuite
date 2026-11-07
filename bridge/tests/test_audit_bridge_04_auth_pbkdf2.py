"""BRIDGE-04: PBKDF2 verification work on authenticated DAV requests.

Requests go through the real Radicale 3.2.3 WSGI ``Application`` built by
``build_radicale_configuration()`` and reach the real
``silentsuite_bridge.radicale.auth.Auth.login``. Synthetic salted credentials
are seeded by the real ``accounts.store_authenticated_account`` into a temp
``CREDS_FILE``.

Instrumentation is a pass-through wrapper around ``hashlib.pbkdf2_hmac``. It
calls the original, counts only 600000-iteration calls, and is installed and
zeroed only AFTER seeding, so seeding hashes are never counted.

- The hash count is a characterization (no caching policy is imposed). The
  exact value is emitted as a warning carrying the ID.
- The defect check is the separate shared-lock probe: while PBKDF2 runs inside
  an actual successful request, another thread tries a non-blocking acquire of
  ``CREDENTIALS_LOCK``. Session acquisition (``EteSyncCache.etesync_for_user``)
  takes the same lock.

Fixture boundaries: ``etebase`` is the conftest mock. ``storage.start_sync_thread``
and ``storage.etesync_for_user`` are stubbed. Both act after authentication, and
the principal request asserts they are never called. No timing thresholds.
"""

import base64
import hashlib
import io
import threading
import time
import warnings
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock
from urllib.parse import unquote

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import accounts, config
from silentsuite_bridge.radicale import auth as bridge_auth
from silentsuite_bridge.radicale import creds as bridge_creds
from silentsuite_bridge.radicale import etesync_cache as bridge_etesync_cache
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.application import Application

USERNAME = "bridge04@example.test"
PASSWORD = "bridge04-synthetic-password"
ITERATIONS = 600000
REQUESTS = 3
DAV = "{DAV:}"

PRINCIPAL_BODY = b"""<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal />
    <d:resourcetype />
  </d:prop>
</d:propfind>
"""


class Pbkdf2Probe:
    """Pass-through counter; optionally probes CREDENTIALS_LOCK during each hash."""

    def __init__(self, original):
        self._original = original
        self.calls = 0
        self.probe_enabled = False
        self.probe_results = []

    def __call__(self, hash_name, password, salt, iterations, *args, **kwargs):
        if iterations == ITERATIONS:
            self.calls += 1
            if self.probe_enabled:
                self.probe_results.append(self._probe_lock())
        return self._original(hash_name, password, salt, iterations, *args, **kwargs)

    @staticmethod
    def _probe_lock():
        result = {}

        def attempt():
            acquired = bridge_creds.CREDENTIALS_LOCK.acquire(blocking=False)
            result["acquired"] = acquired
            if acquired:
                bridge_creds.CREDENTIALS_LOCK.release()

        thread = threading.Thread(target=attempt, name="bridge04-lock-probe", daemon=True)
        thread.start()
        thread.join(5)
        return result.get("acquired", "probe-thread-timeout")


@pytest.fixture()
def dav(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "credentials.json"))
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "bridge.sqlite"))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "SSL_ENABLED", False)

    # Real seeding path (hashes here are excluded: counter not yet installed).
    accounts.store_authenticated_account(
        USERNAME, PASSWORD, "synthetic-session", "https://server.invalid",
    )

    start_sync_thread = MagicMock()
    etesync_for_user = MagicMock()
    monkeypatch.setattr(bridge_storage, "start_sync_thread", start_sync_thread)
    monkeypatch.setattr(bridge_storage, "etesync_for_user", etesync_for_user)

    app = Application(bridge_main.build_radicale_configuration())

    probe = Pbkdf2Probe(hashlib.pbkdf2_hmac)
    monkeypatch.setattr(hashlib, "pbkdf2_hmac", probe)
    assert probe.calls == 0
    return app, probe, (start_sync_thread, etesync_for_user)


def _basic(username, password):
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


def _propfind(app, auth=None):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    environ = {
        "REQUEST_METHOD": "PROPFIND",
        "PATH_INFO": "/principals/",
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": str(len(PRINCIPAL_BODY)),
        "CONTENT_TYPE": "application/xml; charset=utf-8",
        "HTTP_DEPTH": "0",
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(PRINCIPAL_BODY),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if auth is not None:
        environ["HTTP_AUTHORIZATION"] = auth
    started = time.monotonic()
    body = b"".join(app(environ, start_response))
    return captured["status"], body, round(time.monotonic() - started, 3)


def _principal_identity(body):
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return None
    href = root.find(f"{DAV}response/{DAV}propstat/{DAV}prop/{DAV}current-user-principal/{DAV}href")
    return None if href is None or href.text is None else unquote(href.text)


def _successful(status, body):
    return status == "207 Multi-Status" and _principal_identity(body) == f"/{USERNAME}/"


def _require_success(results):
    failures = [(status, body[:300]) for status, body, _ in results if not _successful(status, body)]
    if failures:
        pytest.fail(f"BRIDGE-04 fixture precondition: authenticated request not 207+identity: {failures!r}")


def test_BRIDGE_04_single_authenticated_request_control(dav):
    app, probe, (start_sync_thread, etesync_for_user) = dav
    status, body, _ = _propfind(app, _basic(USERNAME, PASSWORD))
    observed = {
        "status": status,
        "identity": _principal_identity(body),
        "pbkdf2_600k": probe.calls,
        "storage_touched": start_sync_thread.called or etesync_for_user.called,
    }
    assert observed == {
        "status": "207 Multi-Status",
        "identity": f"/{USERNAME}/",
        "pbkdf2_600k": 1,
        "storage_touched": False,
    }, f"BRIDGE-04 control: {observed!r}"


def test_BRIDGE_04_hash_count_characterization(dav):
    app, probe, _ = dav
    results = [_propfind(app, _basic(USERNAME, PASSWORD)) for _ in range(REQUESTS)]
    _require_success(results)
    warnings.warn(
        "BRIDGE-04 characterization: "
        f"pbkdf2_600k_count={probe.calls} over {REQUESTS} successful requests; "
        f"wall_seconds={[elapsed for _, _, elapsed in results]}",
        UserWarning,
    )
    # Characterization bound only (real verifier ran; at most once per request).
    assert 1 <= probe.calls <= REQUESTS, f"BRIDGE-04 characterization: count={probe.calls}"


def test_BRIDGE_04_probe_acquires_free_lock_control(dav):
    _app, probe, _ = dav
    assert probe._probe_lock() is True, "BRIDGE-04 control: probe could not acquire a free lock"


def test_BRIDGE_04_pbkdf2_not_under_session_lock(dav):
    app, probe, _ = dav
    shared = {
        "auth_uses_creds_decorator": bridge_auth.credentials_locked is bridge_creds.credentials_locked,
        "session_cache_uses_creds_decorator": (
            bridge_etesync_cache.credentials_locked is bridge_creds.credentials_locked
        ),
    }
    if not all(shared.values()):
        pytest.fail(f"BRIDGE-04 fixture precondition: lock not shared: {shared!r}")

    probe.probe_enabled = True
    results = [_propfind(app, _basic(USERNAME, PASSWORD)) for _ in range(REQUESTS)]
    probe.probe_enabled = False
    _require_success(results)

    assert probe.probe_results, "BRIDGE-04: no PBKDF2 executed during successful requests"
    assert all(result is True for result in probe.probe_results), (
        "BRIDGE-04: shared CREDENTIALS_LOCK (session acquisition) was unavailable while "
        f"PBKDF2 ran: probe_results={probe.probe_results!r}, pbkdf2_600k={probe.calls}, "
        f"wall_seconds={[elapsed for _, _, elapsed in results]}"
    )


def test_BRIDGE_04_unknown_user_control(dav):
    app, probe, _ = dav
    statuses = [_propfind(app, _basic("unknown@example.test", PASSWORD))[0] for _ in range(REQUESTS)]
    observed = {"statuses": statuses, "pbkdf2_600k": probe.calls}
    assert observed == {
        "statuses": ["401 Unauthorized"] * REQUESTS,
        "pbkdf2_600k": 0,
    }, f"BRIDGE-04 control: {observed!r}"


def test_BRIDGE_04_idle_unauthenticated_stream_control(dav):
    app, probe, _ = dav
    statuses = [_propfind(app, None)[0] for _ in range(REQUESTS)]
    observed = {"statuses": statuses, "pbkdf2_600k": probe.calls}
    assert observed == {
        "statuses": ["401 Unauthorized"] * REQUESTS,
        "pbkdf2_600k": 0,
    }, f"BRIDGE-04 control: {observed!r}"


def test_BRIDGE_04_wrong_password_control(dav):
    app, probe, _ = dav
    status, _body, _ = _propfind(app, _basic(USERNAME, "wrong-password"))
    observed = {"status": status, "pbkdf2_600k": probe.calls}
    assert observed == {"status": "401 Unauthorized", "pbkdf2_600k": 1}, (
        f"BRIDGE-04 control: {observed!r}"
    )
