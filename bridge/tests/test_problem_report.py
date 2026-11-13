"""Tests for the bridge "Report a problem" builder, POST helper and routes."""

import copy
import html
import io
import json
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import silentsuite_bridge.web as web_module
from silentsuite_bridge import config, privacy_logging, tray
from silentsuite_bridge.privacy_logging import bounded_exception_class
from silentsuite_bridge.radicale.creds import Credentials
from silentsuite_bridge.web import Web, _dashboard_csrf_token, update_status
from silentsuite_bridge.web import report
from tests.test_web_dashboard import _stamped_environ

NODE = shutil.which("node")
SCHEMA_PATH = Path(__file__).resolve().parents[2] / "contracts" / "problem-report.schema.json"

PRIVATE_EMAIL = "private.person@example.org"
PRIVATE_USER = "second.private.user@example.net"
PRIVATE_SERVER = "https://dav.private-host.example"
PRIVATE_NAME = "Private_Meeting_Title"


class Private_Meeting_Title(Exception):
    """Identifier-shaped exception class name that carries private content."""


class FakeResponse:
    def __init__(self, status=201, content=b'{"ok":true}', headers=None):
        self.status = status
        self.content = content
        self.headers = headers or {}
        self.closed = False

    def close(self):
        self.closed = True


class SpyTransport:
    def __init__(self, response=None, error=None):
        self.calls = []
        self.response = response if response is not None else FakeResponse()
        self.error = error

    def post(self, url, data, headers, timeout):
        self.calls.append({"url": url, "data": data, "headers": headers, "timeout": timeout})
        if self.error is not None:
            raise self.error
        return self.response


@pytest.fixture(autouse=True)
def report_state(monkeypatch, tmp_path):
    """Isolate bridge status, credentials and the relay transport per test."""
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    saved = copy.deepcopy(web_module._bridge_status)
    web_module._bridge_status.clear()
    web_module._bridge_status.update({
        "state": "starting",
        "last_sync": None,
        "error": None,
        "collections": {"calendars": 0, "contacts": 0, "tasks": 0},
        "collections_by_account": {},
        "account_states": {},
        "collections_scope": "all configured accounts",
    })
    spy = SpyTransport()
    monkeypatch.setattr(web_module, "_report_transport", spy)
    real_network = []

    def _no_real_network(*args, **kwargs):
        real_network.append(args)
        raise AssertionError("real network used in a test")

    monkeypatch.setattr(report.urllib.request, "build_opener", _no_real_network)
    yield SimpleNamespace(spy=spy, real_network=real_network)
    assert real_network == []
    web_module._bridge_status.clear()
    web_module._bridge_status.update(saved)


def _store_accounts(*accounts):
    creds = Credentials()
    for username, server_url in accounts:
        creds.set_etebase(username, f"session-{len(username)}", server_url)
    creds.save()


def _get(path, environ=None):
    return Web.__new__(Web).get(environ or _stamped_environ(), "", path, "")


def _post(path, payload, csrf_token=_dashboard_csrf_token, environ=None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    environ = environ or _stamped_environ()
    environ["CONTENT_LENGTH"] = str(len(body))
    environ["wsgi.input"] = io.BytesIO(body)
    if csrf_token is not None:
        environ["HTTP_X_SILENTSUITE_CSRF"] = csrf_token
    return Web.__new__(Web).post(environ, "", path, "")


def _page_snapshot(page):
    """Return (diagnostics object, preview text) from the rendered report page."""
    marker = "var DIAGNOSTICS = "
    start = page.index(marker) + len(marker)
    diagnostics, _ = json.JSONDecoder().raw_decode(page, start)
    pre_start = page.index('<pre id="diagnosticsText">') + len('<pre id="diagnosticsText">')
    preview = html.unescape(page[pre_start:page.index("</pre>", pre_start)])
    return diagnostics, preview


def _request(**overrides):
    request = {
        "kind": "problem",
        "summary": "Calendar does not sync",
        "description": "Events stopped appearing in Thunderbird.",
        "contact_email": "",
        "diagnostics": None,
    }
    request.update(overrides)
    return request


def _full_diagnostics():
    return report.build_diagnostics(
        state="error",
        last_sync=None,
        account_entries=[{"state": "error", "report_code": code, "last_sync": None}
                         for code in sorted(report.ERROR_CODES)],
        account_count=999,
        server_urls=[PRIVATE_SERVER],
        app_version="0.5.18-beta",
        platform="macos-arm64",
        frozen=True,
        tray=True,
        ssl=True,
        now=0,
    )


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------


def test_error_code_table_matches_bounded_codes_and_schema_enum():
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    enum = set(schema["$defs"]["bridgeErrorCode"]["enum"])
    assert set(report._ERROR_CODES) == (
        set(privacy_logging._BOUNDED_DIAGNOSTIC_CODES) | {"SyncTimeout", "SyncStopped"}
    )
    assert report.ERROR_CODES == enum
    assert set(schema["$defs"]["bridgeFields"]["properties"]) == set(report._FIELD_KEYS)
    assert set(schema["properties"]["diagnostics"]["properties"]) == set(report._DIAGNOSTIC_KEYS)


def test_disclosure_states_retention_once_from_the_constant():
    assert report.REPORT_RETENTION_DAYS == 90
    assert report.DISCLOSURE_TEXT == (
        "Your report is sent through Cloudflare and delivered by email (via Resend) "
        "to the SilentSuite support inbox. It is not end-to-end encrypted and not "
        "linked to your account. We delete it 90 days after we've dealt with it; "
        "to have it deleted sooner, email support@silentsuite.io."
    )
    assert "support@silentsuite.io" in report.DISCLOSURE_TEXT


# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------


def test_diagnostics_count_accounts_and_never_carry_identity_or_free_text_errors(monkeypatch):
    _store_accounts((PRIVATE_EMAIL, PRIVATE_SERVER), (PRIVATE_USER, report.HOSTED_SERVER_URL))
    update_status(
        "error",
        error=bounded_exception_class(Private_Meeting_Title()),
        account=PRIVATE_EMAIL,
    )
    update_status("error", error="SyncTimeout", account=PRIVATE_USER)
    web_module._bridge_status["error"] = f"{PRIVATE_NAME} failed for {PRIVATE_EMAIL}"
    assert web_module._bridge_status["account_states"][PRIVATE_EMAIL]["error"] == PRIVATE_NAME

    diagnostics = web_module._report_diagnostics()
    body = report.serialize_payload(report.build_payload(_request(diagnostics=diagnostics)))
    page = web_module._render_report_page()

    assert diagnostics["error_codes"] == ["other", "sync_timeout"]
    assert diagnostics["server"] == "custom"
    assert diagnostics["sync_status"] == "error"
    assert diagnostics["fields"]["accounts"] == 2
    for private in (PRIVATE_EMAIL, PRIVATE_USER, "private-host", PRIVATE_NAME, "example"):
        assert private.encode() not in body
        assert private not in page


def test_bounded_diagnostic_code_maps_by_table_lookup():
    update_status(
        "error",
        error=bounded_exception_class(
            privacy_logging.BoundedDiagnosticError("CacheRevisionIntegrityError")
        ),
        account=PRIVATE_EMAIL,
    )
    assert web_module._report_diagnostics()["error_codes"] == ["cache_revision_integrity_error"]


def test_unknown_state_and_unmapped_codes_become_other_and_unknown():
    diagnostics = report.build_diagnostics(
        state="mystery-state",
        last_sync="not a timestamp",
        account_entries=[
            {"state": "error", "report_code": PRIVATE_NAME, "last_sync": None},
            {"state": "error", "report_code": None, "last_sync": None},
        ],
        account_count="many",
        server_urls=[report.HOSTED_SERVER_URL + "/"],
        app_version="0.5.18 beta <script>",
        platform=PRIVATE_EMAIL,
        frozen=False,
        tray=False,
        ssl=False,
        now=0,
    )
    assert diagnostics == {
        "app_version": "unknown",
        "platform": "unknown",
        "server": "hosted",
        "sync_status": "unknown",
        "last_success": "unknown",
        "error_codes": ["other"],
        "fields": {"install": "python", "accounts": 0, "tray": "no", "ssl": "no"},
    }
    assert report.error_code_for(PRIVATE_NAME) == "other"
    assert report.error_code_for(RuntimeError("SyncTimeout")) == "other"
    assert report.error_code_for("SyncStopped") == "sync_stopped"


def test_hosted_accounts_report_hosted_and_last_success_bucket():
    _store_accounts((PRIVATE_EMAIL, report.HOSTED_SERVER_URL))
    update_status("connected", account=PRIVATE_EMAIL)
    diagnostics = web_module._report_diagnostics()
    assert diagnostics["server"] == "hosted"
    assert diagnostics["sync_status"] == "synced"
    assert diagnostics["last_success"] == "under_1h"
    assert diagnostics["error_codes"] == []
    assert diagnostics["fields"]["accounts"] == 1
    assert report.validate_diagnostics(diagnostics) == diagnostics


# ---------------------------------------------------------------------------
# User text limits and serialization
# ---------------------------------------------------------------------------


def test_maximum_four_byte_text_fits_and_one_more_is_rejected():
    emoji = "\U0001F600"
    local = "a" * 64
    contact = f"{local}@{'b' * 185}.org"
    assert len(contact) == 254
    payload = report.build_payload(_request(
        summary=emoji * 120,
        description=emoji * 4000,
        contact_email=contact,
        diagnostics=_full_diagnostics(),
    ))
    body = report.serialize_payload(payload)
    assert len(body) <= report.MAX_BODY_BYTES
    # ensure_ascii=False: raw UTF-8, not \\u escapes.
    assert emoji.encode("utf-8") * 120 in body
    assert b"\\ud83d" not in body
    assert len(body) > (120 + 4000) * 4

    with pytest.raises(report.ReportError):
        report.build_payload(_request(summary=emoji * 121))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(description=emoji * 4001))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(contact_email="a" + contact))


def test_maximum_escaped_characters_fit_and_one_more_is_rejected():
    escaped = '"\\\n\t' * 1000
    payload = report.build_payload(_request(
        summary='"\\' * 60,
        description=escaped,
        diagnostics=_full_diagnostics(),
    ))
    body = report.serialize_payload(payload)
    assert len(body) <= report.MAX_BODY_BYTES
    assert json.loads(body.decode("utf-8"))["description"] == escaped
    with pytest.raises(report.ReportError):
        report.build_payload(_request(description=escaped + '"'))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(summary='"' * 121))


@pytest.mark.parametrize("contact", [
    "a@x.io\r",
    "a@x.io\n",
    "a\n@x.io",
    "a@x.io\t",
    "\ta@x.io",
    "a@x.io\r\n",
    " a@x.io",
    "a@x.io,b@y.io",
    "Name <a@x.io>",
    "a@x.io b@y.io",
    "no-at-sign.example",
])
def test_contact_email_must_fullmatch_the_schema_pattern(contact):
    with pytest.raises(report.ReportError):
        report.build_payload(_request(contact_email=contact))


def test_valid_contact_email_is_kept_and_empty_is_omitted():
    assert report.build_payload(_request(contact_email="a@x.io"))["contact_email"] == "a@x.io"
    assert "contact_email" not in report.build_payload(_request(contact_email=""))
    assert "contact_email" not in report.build_payload(_request(contact_email=None))


@pytest.mark.parametrize("control", ["\x00", "\x07", "\x0b", "\x0c", "\r", "\x1b", "\x7f", "\x85", "\x9f"])
def test_control_characters_are_rejected(control):
    with pytest.raises(report.ReportError):
        report.build_payload(_request(summary=f"bad{control}summary"))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(description=f"bad{control}description"))


def test_crlf_is_normalised_and_tab_newline_kept():
    payload = report.build_payload(_request(description="line one\r\nline\ttwo\n"))
    assert payload["description"] == "line one\nline\ttwo\n"


@pytest.mark.parametrize("surrogate", [
    "\ud800", "\ud83d", "\udbff", "\udc00", "\udfff",
    b"bad \xff bytes".decode("utf-8", "surrogateescape"),
])
def test_lone_surrogates_are_rejected_before_send(surrogate, report_state):
    with pytest.raises(report.ReportError):
        report.build_payload(_request(summary=f"bad {surrogate} text"))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(description=f"bad {surrogate} text"))
    # Through the route as well: rejected locally, relay never contacted.
    body = json.dumps(_request(description=f"bad {surrogate} text")).encode()
    status, _, response = _post("/.web/api/report", body)
    assert status == 400
    assert json.loads(response)["outcome"] == "invalid"
    assert report_state.spy.calls == []


def test_lone_surrogates_and_blank_text_are_rejected():
    with pytest.raises(report.ReportError):
        report.build_payload(_request(description="bad \ud83d text"))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(summary="   "))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(kind="question"))
    with pytest.raises(report.ReportError):
        report.build_payload(_request(extra="field"))


@pytest.mark.parametrize("mutate", [
    lambda d: d.update(extra="x"),
    lambda d: d.pop("platform"),
    lambda d: d.update(platform=PRIVATE_EMAIL),
    lambda d: d.update(app_version="1.0\n"),
    lambda d: d.update(server=["hosted"]),
    lambda d: d.update(error_codes=[PRIVATE_NAME]),
    lambda d: d.update(error_codes=["other", "other"]),
    lambda d: d.update(error_codes=["other"] * 11),
    lambda d: d["fields"].update(accounts=True),
    lambda d: d["fields"].update(accounts=1000),
    lambda d: d["fields"].update(server_url=PRIVATE_SERVER),
    lambda d: d["fields"].update(tray={"yes": 1}),
])
def test_diagnostics_snapshot_is_revalidated_strictly(mutate):
    diagnostics = _full_diagnostics()
    mutate(diagnostics)
    with pytest.raises(report.ReportError):
        report.validate_diagnostics(diagnostics)


# ---------------------------------------------------------------------------
# POST helper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("url", [
    "http://silentsuite.io/api/report",
    "https://evil.example/api/report",
    "https://silentsuite.io.evil.example/api/report",
    "https://www.silentsuite.io/api/report",
    "https://report.silentsuite.io/v1/reports",
    "https://silentsuite.io:8443/api/report",
    "https://user@silentsuite.io/api/report",
    "ftp://silentsuite.io/api/report",
])
def test_post_helper_refuses_other_hosts_and_schemes_before_network(url):
    spy = SpyTransport()
    with pytest.raises(report.ReportSendError):
        report.send_report(b"{}", url=url, transport=spy)
    assert spy.calls == []


def test_post_helper_sends_once_with_fixed_headers_and_no_origin():
    spy = SpyTransport()
    assert report.send_report(b'{"schema":1}', transport=spy) == report.OUTCOME_SENT
    assert len(spy.calls) == 1
    call = spy.calls[0]
    assert call["url"] == "https://silentsuite.io/api/report"
    assert call["data"] == b'{"schema":1}'
    assert call["headers"] == {
        "Content-Type": "application/json",
        "User-Agent": "SilentSuite-Bridge-Report",
    }
    assert call["timeout"] == report.SEND_TIMEOUT
    assert spy.response.closed


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_post_helper_does_not_follow_redirects(status):
    spy = SpyTransport(FakeResponse(status=status, content=b"", headers={"Location": "https://evil.example/"}))
    assert report.send_report(b"{}", transport=spy) == report.OUTCOME_FAILED
    assert len(spy.calls) == 1


def test_urllib_redirect_handler_returns_response_unfollowed():
    response = object()
    handler = report._NoRedirect()
    for code in (301, 302, 303, 307, 308):
        assert getattr(handler, f"http_error_{code}")(None, response, code, "", {}) is response


@pytest.mark.parametrize("status", [400, 413, 415, 429, 502, 503, 200])
def test_post_helper_reports_definite_failures(status):
    spy = SpyTransport(FakeResponse(status=status, content=b'{"ok":false}'))
    assert report.send_report(b"{}", transport=spy) == report.OUTCOME_FAILED
    assert len(spy.calls) == 1


def test_post_helper_timeout_is_unknown_and_not_retried():
    spy = SpyTransport(error=TimeoutError())
    assert report.send_report(b"{}", transport=spy) == report.OUTCOME_UNKNOWN
    assert len(spy.calls) == 1


def test_post_helper_caps_response_size_and_body_size():
    spy = SpyTransport(FakeResponse(content=b" " * (report.MAX_RESPONSE_BYTES + 1)))
    assert report.send_report(b"{}", transport=spy) == report.OUTCOME_UNKNOWN
    spy = SpyTransport()
    with pytest.raises(report.ReportSendError):
        report.send_report(b"x" * (report.MAX_BODY_BYTES + 1), transport=spy)
    assert spy.calls == []


# ---------------------------------------------------------------------------
# Dashboard routes
# ---------------------------------------------------------------------------


def test_report_page_is_served_with_disclosure_and_actions(report_state):
    status, headers, body = _get("/.web/report")
    page = body.decode("utf-8")
    assert status == 200
    assert headers["Content-Type"] == "text/html; charset=utf-8"
    assert html.escape(report.DISCLOSURE_TEXT) in page
    assert report.PRIVACY_URL in page
    for label in ("Send", "Email instead", "Copy", "Include diagnostic info", "Feature request"):
        assert label in page
    assert report_state.spy.calls == []


def test_dashboard_links_to_report_page():
    assert 'href="/.web/report"' in web_module._render_dashboard()


@pytest.mark.parametrize("environ", [
    _stamped_environ(HTTP_HOST="evil.example:37358"),
    _stamped_environ(HTTP_HOST="localhost:9999"),
    _stamped_environ(listener_host="192.0.2.10", accepted_host="192.0.2.10", peer="192.0.2.20"),
    {"HTTP_HOST": "localhost:37358", "REMOTE_ADDR": "127.0.0.1"},
])
def test_report_routes_deny_foreign_host_and_non_loopback(environ, report_state):
    status, _, _ = _get("/.web/report", environ=dict(environ))
    assert status == 404
    status, _, _ = _post("/.web/api/report", _request(), environ=dict(environ))
    assert status == 404
    assert report_state.spy.calls == []


@pytest.mark.parametrize("token", [None, "", "wrong-token"])
def test_report_send_requires_csrf_before_any_network(token, report_state):
    status, _, body = _post("/.web/api/report", _request(), csrf_token=token)
    assert status == 403
    assert json.loads(body) == {"error": "Invalid dashboard CSRF token"}
    assert report_state.spy.calls == []


def test_no_relay_request_before_send(report_state):
    # Opening the page (with and without accounts), and local validation
    # failures, never contact the relay.
    _get("/.web/report")
    _store_accounts((PRIVATE_EMAIL, PRIVATE_SERVER))
    update_status("error", error="SyncTimeout", account=PRIVATE_EMAIL)
    _get("/.web/report")
    status, _, body = _post("/.web/api/report", _request(summary=""))
    assert status == 400
    assert json.loads(body)["outcome"] == "invalid"
    status, _, _ = _post("/.web/api/report", b"not json")
    assert status == 400
    assert report_state.spy.calls == []


def test_preview_snapshot_is_exactly_what_is_sent(report_state):
    _store_accounts((PRIVATE_EMAIL, PRIVATE_SERVER))
    update_status("connected", account=PRIVATE_EMAIL)
    _, _, body = _get("/.web/report")
    diagnostics, preview = _page_snapshot(body.decode("utf-8"))

    # Status changes after the preview is shown must not change what is sent.
    update_status("error", error="SyncTimeout", account=PRIVATE_EMAIL)

    status, _, response = _post("/.web/api/report", _request(diagnostics=diagnostics))
    assert status == 200
    assert json.loads(response) == {"ok": True, "outcome": "sent"}
    assert len(report_state.spy.calls) == 1
    sent = json.loads(report_state.spy.calls[0]["data"].decode("utf-8"))
    assert sent["diagnostics"] == diagnostics
    assert report.preview_text(sent["diagnostics"]) == preview
    assert sent["diagnostics"]["sync_status"] == "synced"
    assert sent["surface"] == "bridge"
    assert sent["schema"] == 1


def test_feature_request_without_diagnostics_sends_none(report_state):
    status, _, _ = _post("/.web/api/report", _request(kind="feature", diagnostics=None))
    assert status == 200
    sent = json.loads(report_state.spy.calls[0]["data"].decode("utf-8"))
    assert "diagnostics" not in sent
    assert "contact_email" not in sent
    assert sent["kind"] == "feature"


def test_timeout_reports_unknown_outcome_with_exactly_one_request(report_state):
    report_state.spy.error = TimeoutError()
    status, _, body = _post("/.web/api/report", _request())
    assert status == 502
    assert json.loads(body) == {"ok": False, "outcome": "unknown"}
    assert len(report_state.spy.calls) == 1


def test_report_content_is_not_logged_or_printed(report_state, caplog, capsys):
    caplog.set_level("DEBUG")
    marker = "UniqueReportMarker"
    _post("/.web/api/report", _request(summary=marker, description=marker, contact_email="m@example.org"))
    report_state.spy.error = TimeoutError()
    _post("/.web/api/report", _request(summary=marker, description=marker))
    captured = capsys.readouterr()
    assert marker not in caplog.text
    assert marker not in captured.out + captured.err
    assert all(marker not in entry["message"] for entry in web_module._sync_log)


def test_report_page_sends_csrf_header_and_freezes_snapshot():
    page = web_module._render_report_page()
    assert "'X-SilentSuite-CSRF': CSRF" in page
    assert "diagnostics: include.checked ? DIAGNOSTICS : null" in page
    assert "We couldn't confirm your report was sent" in page
    assert "mailto:" in page


@pytest.mark.skipif(NODE is None, reason="node is required to parse the report page script")
def test_report_page_script_parses(tmp_path):
    page = web_module._render_report_page()
    start = page.index("<script>") + len("<script>")
    script = page[start:page.index("</script>", start)]
    path = tmp_path / "report-script.js"
    path.write_text(script, encoding="utf-8")
    check = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True, timeout=60)
    assert check.returncode == 0, check.stderr


# ---------------------------------------------------------------------------
# Tray
# ---------------------------------------------------------------------------


class _FakeMenu:
    SEPARATOR = object()

    def __init__(self, *items):
        self.items = items


class _FakeMenuItem:
    def __init__(self, text, action, **kwargs):
        self._text = text
        self.action = action
        self.kwargs = kwargs

    @property
    def text(self):
        return self._text(self) if callable(self._text) else self._text


def test_tray_report_item_opens_dashboard_report_page(monkeypatch, fresh_registry):
    monkeypatch.setattr(tray, "TRAY_AVAILABLE", True)
    monkeypatch.setattr(tray, "pystray", SimpleNamespace(Menu=_FakeMenu, MenuItem=_FakeMenuItem))
    monkeypatch.setattr(tray, "_get_accounts", lambda: [])
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", 37358)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    open_browser = MagicMock()
    monkeypatch.setattr(tray.webbrowser, "open", open_browser)

    menu = tray.BridgeTray()._build_menu()
    item = next(i for i in menu.items if isinstance(i, _FakeMenuItem) and i.text == "Report a problem")
    item.action("icon", "item")
    open_browser.assert_called_once_with("http://127.0.0.1:37358/.web/report")
