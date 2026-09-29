"""Privacy-safe DAV request arrival/outcome and local-auth diagnostics.

The templates and argument shapes below are copied from the pinned
Radicale 3.2.3 ``radicale/app/__init__.py``. Records are delivered through
the production ``radicale`` logger so the filter registered by the bridge
application module is the one under test, and the assertions read what a
stderr-style stream sink and a file sink actually wrote.
"""

import io
import logging

import pytest

# Imported for its logger-filter registration side effect.
from silentsuite_bridge.radicale import application  # noqa: F401

ARRIVAL = "%s request for %r%s received from %s%s"
OUTCOME = "%s response status for %r%s in %.3f seconds: %s"
LOGIN_OK = "Successful login: %r"
LOGIN_OK_MAPPED = "Successful login: %r -> %r"
LOGIN_FAILED = "Failed login attempt from %s: %r"
LOGIN_REFUSED = "Refused unsafe username: %r"

APP_PATHNAMES = (
    "radicale/app/__init__.py",
    "/opt/venv/lib/python3.12/site-packages/radicale/app/__init__.py",
    "C:\\Program Files\\SilentSuite Bridge\\_internal\\radicale\\app\\__init__.py",
)

ALLOWED_METHODS = (
    "DELETE",
    "GET",
    "HEAD",
    "MKCALENDAR",
    "MKCOL",
    "MOVE",
    "OPTIONS",
    "POST",
    "PROPFIND",
    "PROPPATCH",
    "PUT",
    "REPORT",
)

MARKER_PATH = "/marker-account@example.invalid/marker-collection/marker-item.ics"
MARKER_HOST = "198.51.100.77"
MARKER_AGENT = " using 'MarkerAgent/9.9 (MarkerDevice)'"
MARKER_DEPTH = " with depth '1'"
MARKER_LOGIN = "marker-login@example.invalid"
MARKERS = (
    "marker",
    "Marker",
    "example.invalid",
    MARKER_HOST,
    "depth",
    "seconds",
    "0.123",
)


def _emit(tmp_path, template, args, *, level=logging.INFO, pathname=APP_PATHNAMES[0]):
    """Send one record through the production logger into both sink kinds."""
    logger = logging.getLogger("radicale")
    stream = io.StringIO()
    stream_handler = logging.StreamHandler(stream)
    log_file = tmp_path / "bridge.log"
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    for handler in (stream_handler, file_handler):
        handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        logger.addHandler(handler)
    record = logging.LogRecord(
        name="radicale",
        level=level,
        pathname=pathname,
        lineno=1,
        msg=template,
        args=args,
        exc_info=None,
    )
    try:
        logger.handle(record)
    finally:
        for handler in (stream_handler, file_handler):
            logger.removeHandler(handler)
            handler.close()
    stream_output = stream.getvalue()
    file_output = log_file.read_text(encoding="utf-8")
    assert stream_output == file_output
    assert record.args == ()
    for marker in MARKERS:
        assert marker not in stream_output
    return stream_output.strip()


@pytest.mark.parametrize("pathname", APP_PATHNAMES)
@pytest.mark.parametrize("method", ALLOWED_METHODS)
def test_request_arrival_reports_only_allowlisted_method(tmp_path, pathname, method):
    output = _emit(
        tmp_path,
        ARRIVAL,
        (method, MARKER_PATH, MARKER_DEPTH, MARKER_HOST, MARKER_AGENT),
        pathname=pathname,
    )

    assert output == f"INFO DAV request received (method={method})"


@pytest.mark.parametrize("pathname", APP_PATHNAMES)
@pytest.mark.parametrize(
    "status_text, status",
    (
        ("200 OK", "200"),
        ("201 Created", "201"),
        ("207 Multi-Status", "207"),
        ("304 Not Modified", "304"),
        ("401 Unauthorized", "401"),
        ("403 Forbidden", "403"),
        ("404 Not Found", "404"),
        ("412 Precondition Failed", "412"),
        ("500 Internal Server Error", "500"),
    ),
)
def test_request_outcome_reports_method_and_bounded_numeric_status(
    tmp_path, pathname, status_text, status
):
    output = _emit(
        tmp_path,
        OUTCOME,
        ("PROPFIND", MARKER_PATH, MARKER_DEPTH, 0.123, status_text),
        pathname=pathname,
    )

    assert output == f"INFO DAV request completed (method=PROPFIND status={status})"


@pytest.mark.parametrize(
    "method",
    (
        "propfind",
        "PROPFIND\nmarker-injected",
        "PROPFIND marker",
        "MARKERMETHOD",
        "",
        None,
        object(),
        b"PROPFIND",
    ),
)
def test_unlisted_or_adversarial_method_is_reported_as_other(tmp_path, method):
    arrival = _emit(
        tmp_path,
        ARRIVAL,
        (method, MARKER_PATH, MARKER_DEPTH, MARKER_HOST, MARKER_AGENT),
    )
    outcome = _emit(
        tmp_path,
        OUTCOME,
        (method, MARKER_PATH, MARKER_DEPTH, 0.123, "200 OK"),
    )

    assert arrival == "INFO DAV request received (method=OTHER)"
    assert outcome == "INFO DAV request completed (method=OTHER status=200)"


@pytest.mark.parametrize(
    "status_text",
    (
        "",
        "marker",
        "99 marker",
        "600 marker",
        "2000 OK",
        "207marker",
        "207\nmarker-injected",
        "207 Multi-Status\nmarker-injected",
        " 207 Multi-Status",
        "２０７ Multi-Status",
        None,
        207,
        object(),
    ),
)
def test_adversarial_status_is_reported_as_unknown(tmp_path, status_text):
    output = _emit(
        tmp_path,
        OUTCOME,
        ("GET", MARKER_PATH, MARKER_DEPTH, 0.123, status_text),
    )

    assert output == "INFO DAV request completed (method=GET status=unknown)"


@pytest.mark.parametrize("pathname", APP_PATHNAMES)
@pytest.mark.parametrize(
    "template, args, level, expected",
    (
        (LOGIN_OK, (MARKER_LOGIN,), logging.INFO, "INFO Local authentication succeeded"),
        (
            LOGIN_OK_MAPPED,
            (MARKER_LOGIN, "marker-user"),
            logging.INFO,
            "INFO Local authentication succeeded",
        ),
        (
            LOGIN_FAILED,
            (MARKER_HOST, MARKER_LOGIN),
            logging.WARNING,
            "WARNING Local authentication failed",
        ),
        (
            LOGIN_REFUSED,
            ("../marker-user",),
            logging.INFO,
            "INFO Local authentication refused",
        ),
    ),
)
def test_local_auth_result_uses_fixed_categories(
    tmp_path, pathname, template, args, level, expected
):
    assert _emit(tmp_path, template, args, level=level, pathname=pathname) == expected


# The remaining tests are fail-closed guards. They hold on the current
# suppress-everything filter and must keep holding once the diagnostics above
# are restored.

GENERIC_OUTPUTS = {
    "INFO Radicale diagnostic suppressed",
    "WARNING Radicale request was rejected",
    "INFO Radicale item diagnostic suppressed",
    "INFO Radicale server diagnostic suppressed",
    "WARNING Radicale failure",
}


@pytest.mark.parametrize(
    "template, args",
    (
        (ARRIVAL + " ", ("GET", MARKER_PATH, "", MARKER_HOST, MARKER_AGENT)),
        (ARRIVAL.lower(), ("GET", MARKER_PATH, "", MARKER_HOST, MARKER_AGENT)),
        ("%s request for %r received from %s", ("GET", MARKER_PATH, MARKER_HOST)),
        (
            "%s request for %r%s received from %s%s%s",
            ("GET", MARKER_PATH, "", MARKER_HOST, MARKER_AGENT, "marker"),
        ),
        (
            "%s response status for %r%s in %.3f seconds: %s %s",
            ("GET", MARKER_PATH, "", 0.123, "200 OK", "marker"),
        ),
        ("Successful login: %r marker", (MARKER_LOGIN,)),
        ("Successful login: %s", (MARKER_LOGIN,)),
        ("Failed login attempt: %r", (MARKER_LOGIN,)),
        ("Access to %r denied for %s", (MARKER_PATH, repr("marker-user"))),
        ("Sanitized path: %r", (MARKER_PATH,)),
        ("Request header:\n%s", ("Authorization: Basic marker",)),
    ),
)
def test_unknown_templates_fail_closed(tmp_path, template, args):
    assert _emit(tmp_path, template, args) in GENERIC_OUTPUTS


@pytest.mark.parametrize(
    "template, args",
    (
        (ARRIVAL, ()),
        (ARRIVAL, ("GET",)),
        (ARRIVAL, ("GET", MARKER_PATH, "", MARKER_HOST, MARKER_AGENT, "marker")),
        (ARRIVAL, ({"method": "GET", "path": MARKER_PATH},)),
        (OUTCOME, ("GET", MARKER_PATH, "", "marker", "200 OK")),
        (OUTCOME, ("GET", "200 OK")),
        (LOGIN_OK, ()),
        (LOGIN_OK, (MARKER_LOGIN, "marker")),
        (LOGIN_FAILED, (MARKER_LOGIN,)),
    ),
)
def test_known_template_with_unexpected_argument_shape_fails_closed(
    tmp_path, template, args
):
    assert _emit(tmp_path, template, args) in GENERIC_OUTPUTS


@pytest.mark.parametrize(
    "pathname",
    (
        "radicale/app/put.py",
        "radicale/app/propfind.py",
        "radicale/item/__init__.py",
        "radicale/server.py",
        "radicale/log.py",
        "radicale/app/__init__.py.marker",
        "marker/app/__init__.py",
        "site-packages/marker_radicale/app/__init__.py",
        "silentsuite_bridge/radicale/app/__init__.py",
    ),
)
@pytest.mark.parametrize(
    "template, args",
    (
        (ARRIVAL, ("GET", MARKER_PATH, "", MARKER_HOST, MARKER_AGENT)),
        (OUTCOME, ("GET", MARKER_PATH, "", 0.123, "200 OK")),
        (LOGIN_OK, (MARKER_LOGIN,)),
    ),
)
def test_known_template_from_unexpected_origin_fails_closed(
    tmp_path, pathname, template, args
):
    output = _emit(tmp_path, template, args, pathname=pathname)

    assert "DAV request" not in output
    assert "Local authentication" not in output
