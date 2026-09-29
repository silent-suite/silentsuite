"""Request and local-auth diagnostics at the real Radicale WSGI boundary.

Requests run through the bridge ``Application`` so every record is produced by
the pinned Radicale code itself and reaches the sink through the production
logger filter.
"""

import base64
import hashlib
import io
import logging
import sys
from unittest.mock import MagicMock

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge.radicale import application as bridge_application
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.application import Application
from silentsuite_bridge.radicale.creds import Credentials

USER = "alice@example.test"
PASSWORD = "correct-test-password"
WRONG_PASSWORD = "wrong-marker-password"
PRINCIPAL_PATH = f"/principals/{USER}/"
REMOTE_ADDRESS = "198.51.100.77"
FORWARDED_FOR = "203.0.113.9"
USER_AGENT = "MarkerAgent/9.9 (MarkerDevice)"
COOKIE = "session=marker-cookie"
FAILURE_TEXT = "marker-failure for /marker-collection/marker-item.ics"


def _basic_auth(password):
    return "Basic " + base64.b64encode(f"{USER}:{password}".encode()).decode()


FORBIDDEN_FRAGMENTS = (
    USER,
    "alice",
    "example.test",
    PASSWORD,
    WRONG_PASSWORD,
    _basic_auth(PASSWORD).split(" ", 1)[1],
    _basic_auth(WRONG_PASSWORD).split(" ", 1)[1],
    "Basic",
    "principals",
    REMOTE_ADDRESS,
    FORWARDED_FOR,
    "MarkerAgent",
    "MarkerDevice",
    "marker",
    "depth",
    "seconds",
    "Traceback",
    "RuntimeError",
)


class _Sink(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []
        self.lines = []
        self.setFormatter(logging.Formatter("%(levelname)s %(message)s"))

    def emit(self, record):
        self.records.append(record)
        self.lines.extend(self.format(record).splitlines())


@pytest.fixture
def sink():
    logger = logging.getLogger("radicale")
    previous_level = logger.level
    handler = _Sink()
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        logger.setLevel(previous_level)
        logger.removeHandler(handler)


@pytest.fixture
def app(tmp_path, monkeypatch):
    credentials_file = str(tmp_path / "credentials.json")
    monkeypatch.setattr(config, "CREDS_FILE", credentials_file)
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "bridge.sqlite"))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    monkeypatch.setattr(config, "SERVER_HOSTS", "127.0.0.1:37358")
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(bridge_storage, "start_sync_thread", MagicMock())
    monkeypatch.setattr(bridge_storage, "etesync_for_user", MagicMock())
    credentials = Credentials(filename=credentials_file)
    credentials.set_etebase(USER, "fake-session", "https://server.test")
    credentials.set_password_hash(USER, hashlib.sha256(PASSWORD.encode()).hexdigest())
    credentials.save()
    return Application(bridge_main.build_radicale_configuration())


def _request(app, method="PROPFIND", authorization=None):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    errors = io.StringIO()
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": PRINCIPAL_PATH,
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": REMOTE_ADDRESS,
        "CONTENT_LENGTH": "0",
        "CONTENT_TYPE": "application/xml; charset=utf-8",
        "HTTP_DEPTH": "0",
        "HTTP_USER_AGENT": USER_AGENT,
        "HTTP_X_FORWARDED_FOR": FORWARDED_FOR,
        "HTTP_COOKIE": COOKIE,
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(),
        "wsgi.errors": errors,
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    if authorization is not None:
        environ["HTTP_AUTHORIZATION"] = authorization
    b"".join(app(environ, start_response))
    return captured["status"], errors.getvalue()


def _assert_private_values_absent(sink, errors):
    output = "\n".join(sink.lines) + "\n" + errors
    for fragment in FORBIDDEN_FRAGMENTS:
        assert fragment not in output
    for record in sink.records:
        assert record.args == ()
        assert record.exc_info is None
        assert record.exc_text is None
        assert record.stack_info is None


def _assert_in_order(lines, expected):
    position = 0
    for line in lines:
        if position < len(expected) and line == expected[position]:
            position += 1
    assert position == len(expected), lines


def test_authenticated_request_reports_arrival_auth_and_outcome(app, sink):
    status, errors = _request(app, authorization=_basic_auth(PASSWORD))

    assert status == "207 Multi-Status"
    _assert_in_order(
        sink.lines,
        [
            "INFO DAV request received (method=PROPFIND)",
            "INFO Local authentication succeeded",
            "INFO DAV request completed (method=PROPFIND status=207)",
        ],
    )
    _assert_private_values_absent(sink, errors)


def test_rejected_password_reports_fixed_failure_and_status(app, sink):
    status, errors = _request(app, authorization=_basic_auth(WRONG_PASSWORD))

    assert status == "401 Unauthorized"
    _assert_in_order(
        sink.lines,
        [
            "INFO DAV request received (method=PROPFIND)",
            "WARNING Local authentication failed",
            "INFO DAV request completed (method=PROPFIND status=401)",
        ],
    )
    assert "INFO Local authentication succeeded" not in sink.lines
    _assert_private_values_absent(sink, errors)


def test_anonymous_request_reports_no_auth_result(app, sink):
    status, errors = _request(app)

    assert status.split(" ", 1)[0] in {"401", "403"}
    _assert_in_order(
        sink.lines,
        [
            "INFO DAV request received (method=PROPFIND)",
            "INFO DAV request completed "
            f"(method=PROPFIND status={status.split(' ', 1)[0]})",
        ],
    )
    assert not [line for line in sink.lines if "Local authentication" in line]
    _assert_private_values_absent(sink, errors)


def test_unlisted_method_is_reported_without_its_name(app, sink):
    status, errors = _request(
        app, method="MARKERMETHOD", authorization=_basic_auth(PASSWORD)
    )

    assert status.split(" ", 1)[0] == "405"
    _assert_in_order(
        sink.lines,
        [
            "INFO DAV request received (method=OTHER)",
            "INFO DAV request completed (method=OTHER status=405)",
        ],
    )
    _assert_private_values_absent(sink, errors)
    assert "MARKERMETHOD" not in "\n".join(sink.lines) + errors


def test_request_failure_reports_method_without_exception_text(
    app, sink, monkeypatch
):
    def fail(_path, _user):
        raise RuntimeError(FAILURE_TEXT)

    monkeypatch.setattr(bridge_application, "canonical_principal_alias_path", fail)

    status, errors = _request(app, authorization=_basic_auth(PASSWORD))

    assert status.split(" ", 1)[0] == "500"
    _assert_in_order(
        sink.lines,
        [
            "INFO DAV request received (method=PROPFIND)",
            "INFO Local authentication succeeded",
            "ERROR DAV request failed (method=PROPFIND)",
        ],
    )
    _assert_private_values_absent(sink, errors)


def test_exception_stack_and_extra_fields_never_reach_a_sink(sink):
    logger = logging.getLogger("radicale")
    try:
        raise RuntimeError(FAILURE_TEXT)
    except RuntimeError as error:
        logger.warning(
            "An exception occurred: %s",
            error,
            exc_info=sys.exc_info(),
            stack_info=True,
            extra={"marker_field": FAILURE_TEXT, "dav_path": PRINCIPAL_PATH},
        )
    logger.info(
        "%s request for %r%s received from %s%s",
        "GET",
        PRINCIPAL_PATH,
        "",
        REMOTE_ADDRESS,
        "",
        stack_info=True,
        extra={"marker_field": FAILURE_TEXT},
    )

    assert sink.lines == [
        "WARNING Radicale failure",
        "INFO Radicale diagnostic suppressed",
    ]
    for record in sink.records:
        assert not hasattr(record, "marker_field")
        assert not hasattr(record, "dav_path")
    _assert_private_values_absent(sink, "")
