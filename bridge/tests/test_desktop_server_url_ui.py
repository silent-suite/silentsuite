"""T3 default server for new sign-ins: the dashboard control (#171).

Contract (implementation-plan-v2 section 6, lines 138-143; A4). The dashboard
has a dedicated control, separate from the sign-in form's own "Server URL"
field, that saves the default server for NEW sign-ins:
- it is labelled as the default server; a Save button and a status element
  sit in the same container; the container says it applies to new sign-ins
  only and that existing accounts keep their server;
- saving a valid http(s) URL shows an acknowledged status, writes serverUrl
  to settings.json, is reported by GET /.web/api/settings as source "saved",
  and after a reload pre-fills both the control and the sign-in form;
- an invalid URL never reports "Saved" and leaves the saved default in place;
- when SILENTSUITE_SERVER_URL manages it, the control shows that value
  read-only and a save attempt writes nothing.

The backend (validation, precedence, 409/400) is already covered by
tests/test_desktop_settings_api.py; these tests cover the rendered control.
They drive the REAL desktop dashboard (no account, no sign-in, every server
URL under .invalid) through tests/desktop_smoke/server_url_ui_probe.py, which
also documents the planned UI interface used to find the control.

Needs PySide6 and a display; required (SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1)
in the native CI job, skipped elsewhere.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_desktop_ipc import _env, _free_port, _native_required

PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "server_url_ui_probe.py"
CHILD_TIMEOUT = 180
BRAND = "SilentSuite Bridge"
SAVED_DEFAULT = "https://new-sign-ins.t3-ui.invalid"
MANAGED_DEFAULT = "https://managed.t3-ui.invalid"


def _reports_saved(text):
    return bool(text) and re.search(r"\bsaved\b", text, re.I) is not None \
        and re.search(r"\bnot\s+saved\b", text, re.I) is None


def _journey(tmp_path_factory, mode):
    _native_required()
    root = tmp_path_factory.mktemp(f"t3ui-{mode}")
    data, home = root / "data", root / "t3ui-home"
    data.mkdir()
    home.mkdir()
    env = _env(data, home, _free_port())
    if mode == "managed":
        env["SILENTSUITE_SERVER_URL"] = MANAGED_DEFAULT
    out = root / "result.json"
    argv = [sys.executable, str(PROBE), "--mode", mode, "--out", str(out)]
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): {mode} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    steps = result.get("steps", {})
    describe = (
        f"{mode}: rc={completed.returncode} stage={result.get('stage')!r} prereq={result.get('prereq')!r} "
        f"entry_error={result.get('entry_error')!r}\nsteps={json.dumps(steps, default=str)[:3500]}\n"
        f"stderr tail:\n{completed.stderr[-2000:]}"
    )
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(f"fixture did not complete (not RED): {describe}")
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): {describe}")
    if result.get("window_deadline_missed") or not result.get("journey_finished"):
        pytest.fail(f"fixture never drove the dashboard (not RED): {describe}")
    if steps.get("driver_error"):
        pytest.fail(f"page driver failed (not RED): {steps['driver_error']}\n{describe}")
    if result.get("exit_code") not in (None, 0):
        pytest.fail(f"the desktop app did not stop normally (not RED): {describe}")
    return {"result": result, "steps": steps, "describe": describe}


@pytest.fixture(scope="module")
def editable(tmp_path_factory):
    return _journey(tmp_path_factory, "editable")


@pytest.fixture(scope="module")
def managed(tmp_path_factory):
    return _journey(tmp_path_factory, "managed")


def _assert_page_live(run):
    steps = run["steps"]
    page = steps["page"]
    assert page["title"] == BRAND and page["origin_is_dashboard"] is True, run["describe"]
    assert page["csrf"] is True, run["describe"]
    assert page["scriptRan"] is True, f"the dashboard script did not run: {run['describe']}"
    assert page["qtObject"] is False and steps["web_channel_absent"] is True, run["describe"]
    assert page["errors"] == [], run["describe"]
    assert steps["get_before"][0] == 200, run["describe"]


def _require_admitted(run):
    """Controls first: a broken page, script or API must not read as a missing control."""
    try:
        _assert_page_live(run)
        if run["result"]["mode"] == "editable":
            _assert_interval_admission(run)
    except AssertionError as exc:
        pytest.fail(f"admission control failed (not RED): {exc}")


def _assert_interval_admission(run):
    steps = run["steps"]
    trigger = steps["interval_trigger"] or {}
    assert trigger.get("triggered") is True, run["describe"]
    value = int(trigger["value"])
    assert _reports_saved(steps["interval_status"]["status"]), f"interval save not acknowledged: {run['describe']}"
    assert steps["interval_settings"].get("syncInterval") == value, run["describe"]
    assert steps["interval_get"][0] == 200 and steps["interval_get"][1]["syncInterval"] == value, run["describe"]


def _discovery(run, need_button=True):
    found = run["steps"].get("discovery") or {}
    complete = found.get("inputFound") and found.get("statusFound") and (found.get("buttonFound") or not need_button)
    if not complete:
        pytest.fail(f"NOT REACHED: no dedicated default-server control to exercise ({found!r})")
    return found


# --- editable default (built-in) --------------------------------------------


def test_dashboard_page_script_and_api_are_live(editable):
    # Control: the own-origin dashboard loaded, its script ran, no bridge, API admits.
    _assert_page_live(editable)


def test_same_value_interval_save_reaches_settings_through_the_page(editable):
    # Control: a real page event goes through the page script, the CSRF-gated API and settings.json.
    _assert_interval_admission(editable)


def test_dashboard_has_a_dedicated_default_server_control(editable):
    _require_admitted(editable)
    found = editable["steps"].get("discovery") or {}
    assert found.get("inputFound") and found.get("inputShown") and found.get("buttonFound") \
        and found.get("buttonShown") and found.get("statusFound"), (
        "no visible control labelled 'default server' with a Save button and a status, outside the "
        f"sign-in form (the sign-in form's own Server URL field does not count): {found!r}"
    )


def test_default_server_control_says_it_is_for_new_sign_ins_only(editable):
    _require_admitted(editable)
    found = _discovery(editable)
    text = found.get("groupText") or ""
    assert re.search(r"\bnew sign[- ]?ins?\b", text, re.I), text
    assert re.search(r"\bexisting accounts?\b", text, re.I), text


def test_saving_a_default_server_persists_and_prefills_new_sign_ins(editable):
    _require_admitted(editable)
    _discovery(editable)
    steps = editable["steps"]
    assert (steps.get("save_click") or {}).get("clicked") is True, editable["describe"]
    assert _reports_saved(steps["save_status"]["status"]), f"no acknowledged save: {editable['describe']}"
    assert steps["save_settings"].get("serverUrl") == SAVED_DEFAULT, editable["describe"]
    assert steps["save_get"][1]["serverUrl"] == {"value": SAVED_DEFAULT, "source": "saved", "editable": True}, (
        editable["describe"]
    )
    assert (steps.get("reload_control") or {}).get("value") == SAVED_DEFAULT, editable["describe"]
    assert (steps.get("reload_page") or {}).get("loginServerUrl") == SAVED_DEFAULT, editable["describe"]
    assert (steps.get("final_page") or {}).get("errors") == [], editable["describe"]


def test_invalid_default_server_is_not_reported_saved_and_keeps_the_saved_one(editable):
    _require_admitted(editable)
    _discovery(editable)
    steps = editable["steps"]
    if steps.get("save_settings", {}).get("serverUrl") != SAVED_DEFAULT or "invalid_click" not in steps:
        pytest.fail("NOT REACHED: no saved default to protect, so the invalid case was not driven")
    before = (steps["invalid_click"] or {}).get("statusBefore", "")
    status = steps["invalid_status"]["status"]
    assert not (_reports_saved(status) and status != before), f"an invalid URL was reported saved: {status!r}"
    assert steps["invalid_settings"].get("sha256") == steps["save_settings"].get("sha256"), editable["describe"]
    assert steps["invalid_get"][1]["serverUrl"]["value"] == SAVED_DEFAULT, editable["describe"]


# --- managed by SILENTSUITE_SERVER_URL --------------------------------------


def test_managed_dashboard_and_api_report_the_environment_default(managed):
    # Control: the real backend reports the managed default as read-only.
    _assert_page_live(managed)
    get_before = managed["steps"]["get_before"][1]
    assert get_before["serverUrl"] == {"value": MANAGED_DEFAULT, "source": "env", "editable": False}, managed["describe"]
    assert not managed["steps"]["settings_before"].get("has_serverUrl"), managed["describe"]


def test_managed_default_server_is_shown_read_only_and_not_saved(managed):
    _require_admitted(managed)
    found = _discovery(managed, need_button=False)
    assert found.get("value") == MANAGED_DEFAULT, found
    assert found.get("readOnly") or found.get("disabled"), f"the managed default is editable: {found!r}"
    assert not (found.get("buttonFound") and found.get("buttonShown") and not found.get("buttonDisabled")), (
        f"Save is offered for a managed default: {found!r}"
    )
    after = managed["steps"]["managed_after"]
    assert not after["settings"].get("has_serverUrl"), managed["describe"]
    assert after["get"][1]["serverUrl"]["source"] == "env", managed["describe"]
    assert not _reports_saved((after["control"] or {}).get("status")), managed["describe"]
