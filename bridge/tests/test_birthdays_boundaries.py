"""Bridge Birthdays (#738): final boundary tests (added after the implementation).

These are CONTROLS / characterization of already-implemented behaviour, not original RED:
- a real Radicale WSGI request (no TCP listener) refuses a DAV write into an active Birthdays
  calendar, while ordinary and retired calendars accept the same write;
- the rendered dashboard's actual setBirthdays JavaScript reports success only for done, in a
  bare V8 context (same convention as the interval-save harness in test_web_dashboard.py);
- a session replaced in the middle of an operation publishes nothing into the cache.

SDK managers stay mocked (round-trip cache store from the CardDAV convergence harness); this is
not real Python SDK or server transport proof.
"""

import io
import json
import subprocess
from unittest.mock import MagicMock

import pytest
from etebase import CollectionAccessLevel

from silentsuite_bridge import birthdays, config
from silentsuite_bridge.local_cache import SessionSuperseded, models
from silentsuite_bridge.radicale import rights as bridge_rights
from silentsuite_bridge.radicale.creds import Credentials
from tests.test_birthdays import ACTIVE, RETIRED, _account, _configured_account
from tests.test_birthdays import USERNAME as BIRTHDAYS_USER
from tests.test_carddav_remote_delete_convergence import _bridge
from tests.test_macos_dav_discovery import USERNAME as DAV_USER
from tests.test_macos_dav_discovery import _basic_auth
from tests.test_web_dashboard import NODE, _extract_js_function, _reset_status

ORDINARY_EVENT = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\n"
    "UID:dav-written-event\r\nDTSTAMP:20261031T120000Z\r\nDTSTART;VALUE=DATE:20261101\r\n"
    "DTEND;VALUE=DATE:20261102\r\nSUMMARY:Written over DAV\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


# ---------------------------------------------------------------------------
# Real Radicale WSGI: DAV write refusal follows the cached Birthdays marker
# ---------------------------------------------------------------------------


def _put(app, path, body):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    data = body.encode("utf-8")
    environ = {
        "REQUEST_METHOD": "PUT",
        "PATH_INFO": path,
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": str(len(data)),
        "CONTENT_TYPE": "text/calendar; charset=utf-8",
        "HTTP_AUTHORIZATION": _basic_auth(),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(data),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    b"".join(app(environ, start_response))
    return captured["status"]


def _cached_calendar(remote, user, uid, content):
    calendar = MagicMock()
    calendar.uid = uid
    calendar.stoken = "col-1"
    calendar.deleted = False
    calendar.meta = {"name": "Calendar"}
    calendar.collection_type = "etebase.vevent"
    calendar.access_level = CollectionAccessLevel.Admin
    calendar.content = content
    models.CollectionEntity.create(local_user=user, uid=uid, eb_col=remote.store.save(calendar))
    return calendar


@pytest.mark.parametrize(
    "content, expected_write",
    [(ACTIVE, False), (RETIRED, True), (b"", True)],
    ids=["active-birthdays-refused", "retired-writable", "ordinary-writable"],
)
def test_real_wsgi_put_is_refused_only_for_an_active_birthdays_calendar(tmp_path, monkeypatch, content, expected_write):
    """CONTROL: the same PUT reaches a real write (201/204 + an SDK item create) for ordinary and
    retired calendars, and is refused (403) with no create for an active Birthdays calendar.

    Fixture note: the convergence harness patches only storage.etesync_for_user; the rights
    backend resolves collections through its own etesync_for_user, so it is patched to the same
    cached session here (otherwise rights would fall back to plain owner permissions)."""
    app, _database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    _cached_calendar(remote, user, "cal-x", content)
    context = MagicMock()
    context.__enter__.return_value = (direct_storage.etesync, False)
    context.__exit__.return_value = False
    monkeypatch.setattr(bridge_rights, "etesync_for_user", lambda _user, **_kwargs: context)

    status = _put(app, f"/{DAV_USER}/cal-x/dav-written-event.ics", ORDINARY_EVENT)

    if expected_write:
        assert status.split(" ", 1)[0] in ("201", "204"), status
        assert len(remote.created) == 1
    else:
        assert status.startswith("403"), status
        assert remote.created == []


# ---------------------------------------------------------------------------
# The rendered dashboard's actual setBirthdays JavaScript
# ---------------------------------------------------------------------------

SET_BIRTHDAYS_SCENARIOS = [
    {"id": "on-done", "action": "on", "status": 200, "body": {"ok": True, "status": "done"}},
    {"id": "on-pending", "action": "on", "status": 200, "body": {"ok": False, "status": "pending"}},
    {"id": "on-skipped", "action": "on", "status": 200, "body": {"ok": False, "status": "skipped"}},
    {"id": "on-inconsistent", "action": "on", "status": 200, "body": {"ok": True, "status": "pending"}},
    {"id": "on-server-failed", "action": "on", "status": 500, "body": {"ok": False, "status": "failed"}},
    {"id": "on-csrf-rejected", "action": "on", "status": 403, "body": {"error": "Invalid dashboard CSRF token"}},
    {"id": "on-non-json", "action": "on", "status": 502, "body": None},
    {"id": "on-network-error", "action": "on", "status": 0, "body": None, "transportError": True},
    {"id": "off-confirmed-done", "action": "off", "confirm": True, "status": 200, "body": {"ok": True, "status": "done"}},
    {"id": "off-cancelled", "action": "off", "confirm": False, "status": 200, "body": {"ok": True, "status": "done"}},
]

SET_BIRTHDAYS_HARNESS = r"""
'use strict';
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(process.argv[2], 'utf8');
const scenarios = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

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

async function run(scenario) {
    const messages = [];
    const requests = [];
    const confirms = [];
    const attributes = { 'data-birthdays-account': 'alice@example.com', 'data-birthdays-action': scenario.action };
    const button = {
        disabled: false,
        getAttribute: function(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; }
    };
    let disabledWhileRequesting = null;
    const sandbox = {
        window: { SILENTSUITE_DASHBOARD_CSRF: 'csrf-token' },
        confirm: function(message) { confirms.push(message); return scenario.confirm !== false; },
        setAccountStatus: function(message, isError) { messages.push({ message: message, isError: !!isError }); },
        fetch: function(url, init) {
            disabledWhileRequesting = button.disabled;
            requests.push({
                url: url,
                method: init.method,
                csrf: init.headers['X-SilentSuite-CSRF'],
                contentType: init.headers['Content-Type'],
                body: JSON.parse(init.body)
            });
            return response(scenario);
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    sandbox.setBirthdays(button);
    await flush();
    return {
        id: scenario.id,
        messages: messages,
        requests: requests,
        confirms: confirms,
        disabledWhileRequesting: disabledWhileRequesting,
        disabledAfter: button.disabled
    };
}

(async function() {
    const results = [];
    for (const scenario of scenarios) results.push(await run(scenario));
    process.stdout.write(JSON.stringify(results));
})().catch(function(err) { console.error(err && err.stack || err); process.exit(1); });
"""


@pytest.mark.skipif(NODE is None, reason="node is required to run the rendered dashboard JavaScript")
def test_rendered_set_birthdays_reports_success_only_for_done(tmp_path, monkeypatch):
    """CONTROL (characterization of the implemented handler): the request carries the CSRF header,
    JSON body and exact route; only {ok:true,status:'done'} is shown as success; pending, skipped,
    inconsistent, server errors, CSRF refusal, non-JSON and network errors are shown as errors;
    turning off asks first and a cancelled turn-off sends nothing."""
    import silentsuite_bridge.web as web_module

    _reset_status()
    monkeypatch.setattr(config, "CREDS_FILE", str(tmp_path / "creds.json"))
    monkeypatch.setattr(web_module, "_account_fingerprint", lambda _creds, username: f"fingerprint for {username}")
    creds = Credentials()
    creds.set_etebase("alice@example.com", "alice-session", "https://server-a.test")
    creds.save()
    html = web_module._render_dashboard()

    script = tmp_path / "set-birthdays.js"
    script.write_text(
        "\n".join(_extract_js_function(html, name) for name in ("handleJsonResponse", "setBirthdays")),
        encoding="utf-8",
    )
    scenarios = tmp_path / "scenarios.json"
    scenarios.write_text(json.dumps(SET_BIRTHDAYS_SCENARIOS), encoding="utf-8")
    harness = tmp_path / "harness.js"
    harness.write_text(SET_BIRTHDAYS_HARNESS, encoding="utf-8")

    run = subprocess.run([NODE, str(harness), str(script), str(scenarios)], capture_output=True, text=True, timeout=60)

    assert run.returncode == 0, run.stderr
    results = {result["id"]: result for result in json.loads(run.stdout)}
    assert set(results) == {scenario["id"] for scenario in SET_BIRTHDAYS_SCENARIOS}

    for scenario in SET_BIRTHDAYS_SCENARIOS:
        result = results[scenario["id"]]
        if scenario["id"] == "off-cancelled":
            assert result["requests"] == []
            assert result["messages"] == []
            assert result["disabledAfter"] is False
            continue
        assert result["requests"] == [{
            "url": "/.web/api/accounts/birthdays",
            "method": "POST",
            "csrf": "csrf-token",
            "contentType": "application/json",
            "body": {"username": "alice@example.com", "action": scenario["action"]},
        }]
        assert result["disabledWhileRequesting"] is True
        assert result["disabledAfter"] is False
        final = result["messages"][-1]
        succeeded = scenario["id"] in ("on-done", "off-confirmed-done")
        assert final["isError"] is (not succeeded), (scenario["id"], final)
        assert ("turned " + scenario["action"] in final["message"]) is succeeded, (scenario["id"], final)

    confirms = results["off-confirmed-done"]["confirms"]
    assert len(confirms) == 1
    assert "alice@example.com" in confirms[0]
    assert "Generated birthdays are removed; your own events are kept." in confirms[0]
    assert results["on-done"]["confirms"] == []


# ---------------------------------------------------------------------------
# Session replaced in the middle of an operation (existing _assert_session_current guard)
# ---------------------------------------------------------------------------


def test_dashboard_session_replaced_after_writing_publishes_nothing_into_the_cache(monkeypatch):
    """CONTROL: the session is current when the turn-off starts but replaced before the cache
    refresh; the result is still reported truthfully and nothing is synced into the replaced
    session's cache."""
    calendar, account = _account()
    service, _calls = _configured_account(monkeypatch, account)
    service._assert_session_current.side_effect = [None, SessionSuperseded("replaced")]

    result = birthdays.set_dashboard_birthdays(BIRTHDAYS_USER, "off")

    assert result.get("status") == "done"
    assert calendar.content == RETIRED
    service.sync_collection_list.assert_not_called()
    service.sync_collection.assert_not_called()


def test_hook_session_replaced_after_writing_publishes_nothing_into_the_cache(monkeypatch):
    """CONTROL: same guard on the post-sync path: a session replaced during the run skips the
    targeted cache refresh (the next regular sync of the new session publishes it)."""
    service = MagicMock(name="sync-service")
    service.username = BIRTHDAYS_USER
    service._assert_session_current.side_effect = [None, SessionSuperseded("replaced")]
    monkeypatch.setattr(birthdays, "reconcile_birthdays",
                        lambda account, username: {"status": "done", "written": ["cal-birthdays"]})

    result = birthdays.reconcile_after_sync(service)

    assert result.get("status") == "done"
    service.sync_collection_list.assert_not_called()
    service.sync_collection.assert_not_called()
