"""T4 start-at-login toggle in the desktop dashboard (#171).

Contract (implementation-plan-v2 section 5 registration-only, section 6 line
156, section 7 stable paths; the start-at-login API is already covered by
tests/test_desktop_autostart.py):
- the dashboard shows a labelled "Start at login" checkbox or switch, outside
  the sign-in form, with a status in the same container;
- in a stable installed app, turning it on with a real click says "Saved"
  only after the API accepted it. GET then reports it on, and only the
  desktop entry exists, naming the installed executable plus --background.
  Turning it off removes only that entry. A CLI registration added after
  start-up is never touched. The owner's PID, registry URL, server thread and
  instance lock stay the same, and nothing is launched or stopped;
- a rejected registration write (API 500) is never shown as saved or on;
- the window's native close notice follows the setting while it stays open;
- from a source checkout the control is disabled, the container mentions the
  installed app, and a click changes nothing.

Driven through the real desktop dashboard by
tests/desktop_smoke/autostart_ui_probe.py, which lists every simulated
boundary and the planned UI interface. Each toggle case also checks the
page's own startAtLogin POST made after that click (boolean and HTTP status,
seen by an operator-side wrapper around window.fetch), so a control that
never calls the API cannot pass. This is not a frozen build, an
installer or an OS login-time launch.

Needs PySide6 and a display; required (SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1)
in the native CI job. On Linux the installed scenario needs the CI-created
inert /opt file and its recorded inode (T4_OPT_FILE_INODE).
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_desktop_autostart import _assert_desktop_entry, _executable_for, _native_required
from tests.test_desktop_ipc import _env, _free_port

PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "autostart_ui_probe.py"
CHILD_TIMEOUT = 200
BRAND = "SilentSuite Bridge"
OPT_INODE_ENV = "T4_OPT_FILE_INODE"


def _reports_saved(text):
    return bool(text) and re.search(r"\bsaved\b", text, re.I) is not None \
        and re.search(r"\bnot\s+saved\b", text, re.I) is None


def _journey(tmp_path_factory, scenario):
    _native_required()
    root = tmp_path_factory.mktemp(f"t4ui-{scenario}")
    data, home, localappdata = root / "data", root / "t4ui-home", root / "t4ui-localappdata"
    for directory in (data, home, localappdata):
        directory.mkdir()
    executable = _executable_for(scenario, root, home, localappdata)
    env = _env(data, home, _free_port())
    if sys.platform == "win32":
        env["LOCALAPPDATA"] = str(localappdata)
    if os.environ.get(OPT_INODE_ENV):
        env[OPT_INODE_ENV] = os.environ[OPT_INODE_ENV]
    out = root / "result.json"
    argv = [sys.executable, str(PROBE), "--scenario", scenario, "--out", str(out), "--executable", executable]
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): {scenario} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    steps = result.get("steps", {})
    describe = (
        f"{scenario}: rc={completed.returncode} stage={result.get('stage')!r} prereq={result.get('prereq')!r} "
        f"entry_error={result.get('entry_error')!r}\nsteps={json.dumps(steps, default=str)[:4000]}\n"
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
    return {"result": result, "steps": steps, "describe": describe, "executable": executable}


@pytest.fixture(scope="module")
def installed(tmp_path_factory):
    return _journey(tmp_path_factory, "installed")


@pytest.fixture(scope="module")
def source(tmp_path_factory):
    return _journey(tmp_path_factory, "source")


def _assert_live(run, editable):
    steps = run["steps"]
    page = steps["page"]
    assert page["title"] == BRAND and page["origin_is_dashboard"] is True, run["describe"]
    assert page["csrf"] is True and page["scriptRan"] is True, f"dashboard script did not run: {run['describe']}"
    assert page["qtObject"] is False and steps["web_channel_absent"] is True, run["describe"]
    status, body = steps["get_before"]
    assert status == 200, run["describe"]
    assert body.get("startAtLogin") == {"value": False, "editable": editable}, (
        f"start-at-login metadata is not as expected: {body.get('startAtLogin')!r}\n{run['describe']}"
    )
    trigger = steps["interval_trigger"] or {}
    assert trigger.get("triggered") is True and _reports_saved(steps["interval_status"]["status"]), run["describe"]
    assert steps["interval_get"][1]["syncInterval"] == int(trigger["value"]), run["describe"]


def _require_admitted(run, editable):
    try:
        _assert_live(run, editable)
    except (AssertionError, KeyError, TypeError) as exc:
        pytest.fail(f"admission control failed (not RED): {exc!r}")


def _require_control(run):
    found = run["steps"].get("discovery") or {}
    if not (found.get("controlFound") and found.get("statusFound")):
        pytest.fail(f"NOT REACHED: no labelled start-at-login control to exercise ({found!r})")
    return found


def _require_step(run, name):
    step = run["steps"].get(name)
    if step is None:
        pytest.fail(f"NOT REACHED: {name} was not driven (an earlier toggle step did not succeed)")
    return step


def _assert_owner_unchanged(run, step):
    before = run["steps"]["identity_before"]
    assert before["lock"] == "BUSY" and before["server_thread_alive"] and not before["registry_stopped"], before
    assert before["same_server_thread_object"] is True and before["server_thread_ident"] is not None, before
    # Same PID, registry URL, server Thread object and ident, lock still held.
    assert step["identity"] == before, f"the owner changed: {step['identity']!r} vs {before!r}"


def _requests(step):
    """The page's own startAtLogin POSTs made after this click: (boolean sent, HTTP status)."""
    return [(r["startAtLogin"], r["status"]) for r in step["requests"]]


# --- stable installed app -----------------------------------------------------


def test_installed_dashboard_page_script_and_api_are_live(installed):
    # Control: own-origin page, script, no bridge, editable metadata, and a
    # same-value interval save through the page reaches the API.
    _assert_live(installed, editable=True)


def test_dashboard_has_a_labelled_start_at_login_control(installed):
    _require_admitted(installed, editable=True)
    found = installed["steps"].get("discovery") or {}
    assert found.get("controlFound") and found.get("controlShown") and found.get("statusFound"), (
        f"no visible checkbox/switch labelled 'Start at login' with a status, outside the sign-in form: {found!r}"
    )
    assert found.get("disabled") is False and found.get("checked") is False, found


def test_turning_start_at_login_on_registers_only_the_desktop_entry(installed):
    _require_admitted(installed, editable=True)
    _require_control(installed)
    on = _require_step(installed, "toggle_on")
    assert _requests(on) == [(True, 200)], f"the click did not POST startAtLogin true with a 200 answer: {on!r}"
    assert _reports_saved((on["after"] or {}).get("status")), f"not acknowledged: {on!r}"
    assert (on["after"] or {}).get("checked") is True, on
    assert on["get"][1]["startAtLogin"] == {"value": True, "editable": True}, on
    _assert_desktop_entry(on["registrations"]["desktop"], installed["executable"])
    assert on["registrations"]["cli"] == installed["steps"]["registrations_before"]["cli"], on
    _assert_owner_unchanged(installed, on)


def test_turning_start_at_login_off_removes_only_the_desktop_entry(installed):
    _require_admitted(installed, editable=True)
    _require_control(installed)
    off = _require_step(installed, "toggle_off")
    assert _requests(off) == [(False, 200)], f"the click did not POST startAtLogin false with a 200 answer: {off!r}"
    assert _reports_saved((off["after"] or {}).get("status")), f"not acknowledged: {off!r}"
    assert (off["after"] or {}).get("checked") is False, off
    assert off["get"][1]["startAtLogin"] == {"value": False, "editable": True}, off
    assert off["registrations"]["desktop"] is None, off
    assert off["registrations"]["cli"] == installed["steps"]["registrations_before"]["cli"], off
    _assert_owner_unchanged(installed, off)


def test_close_notice_follows_start_at_login_while_the_window_stays_open(installed):
    _require_admitted(installed, editable=True)
    _require_control(installed)
    texts = installed["result"]["notice_texts"]
    assert texts["stops"] in installed["steps"]["notice_before"], installed["steps"]["notice_before"]
    notice_on = _require_step(installed, "notice_on")
    assert notice_on["matched"] is True, f"notice did not change to the hide text: {notice_on!r}"
    notice_off = _require_step(installed, "notice_off")
    assert notice_off["matched"] is True, f"notice did not change back to the stop text: {notice_off!r}"


def test_rejected_registration_write_is_not_shown_as_saved_or_on(installed):
    _require_admitted(installed, editable=True)
    _require_control(installed)
    _require_step(installed, "toggle_off")
    if "rejection_armed" not in installed["steps"]:
        pytest.fail("NOT REACHED: turning start at login off did not succeed, so no rejected write was tried")
    if installed["steps"]["rejection_armed"] is not True:
        pytest.fail(f"fixture could not arm the rejected write (not RED): {installed['steps'].get('rejection_boundary')!r}")
    rejected = _require_step(installed, "toggle_rejected")
    restored = installed["steps"]["rejection_restored"]
    if restored.get("restored") is not True:
        pytest.fail(f"fixture boundary not restored (not RED): {restored!r}")
    # The page really asked to turn it on, while the write boundary was armed, and got the 500.
    assert rejected["boundary_active_at_settle"] is True, rejected
    assert _requests(rejected) == [(True, 500)], f"no refused startAtLogin true POST was observed: {rejected!r}"
    assert rejected["get"][1]["startAtLogin"]["value"] is False, rejected
    status = (rejected["after"] or {}).get("status")
    assert rejected["settled"] and not _reports_saved(status), f"a refused change was shown as saved: {rejected!r}"
    after = installed["steps"]["after_rejection"]
    assert (after["state"] or {}).get("checked") is False, f"the control shows on after a refusal: {after!r}"
    assert after["registrations"]["desktop"] is None, after
    _assert_owner_unchanged(installed, rejected)


def test_installed_journey_ends_cleanly_without_side_effects(installed):
    # Control: whatever the UI did, no manager, no launch, the CLI entry kept,
    # no desktop entry left, fixture boundary restored, normal stop.
    result = installed["result"]
    steps = installed["steps"]
    assert result["exit_code"] in (None, 0), installed["describe"]
    assert result["lock_free_after"] is True and result["registry_stopped_after"] is True, installed["describe"]
    assert result["service_manager_traps"] == [] and result["launch_attempts"] == [], installed["describe"]
    assert result["registrations_after"]["desktop"] is None, installed["describe"]
    assert result["registrations_after"]["cli"] == steps["registrations_before"]["cli"] is not None, installed["describe"]
    assert result["boundary_after"].get("active") is False, installed["describe"]
    if sys.platform == "win32":
        assert all(name == "SilentSuiteBridgeDesktop" for _, name in result["run_key_writes"]), installed["describe"]


# --- source checkout -----------------------------------------------------------


def test_source_dashboard_reports_start_at_login_unavailable(source):
    # Control: live page and script, metadata {value: false, editable: false}.
    _assert_live(source, editable=False)
    assert source["result"]["registrations_after"]["desktop"] is None, source["describe"]


def test_source_checkout_shows_start_at_login_disabled_with_an_explanation(source):
    _require_admitted(source, editable=False)
    found = _require_control(source)
    assert found.get("disabled") is True and found.get("checked") is False, found
    assert re.search(r"\binstall", found.get("groupText") or "", re.I), found
    click = _require_step(source, "source_click")
    assert _requests(click) == [], f"a disabled control still POSTed startAtLogin: {click!r}"
    assert not _reports_saved((click["after"] or {}).get("status")), click
    assert (click["after"] or {}).get("checked") is False, click
    assert click["get"][1]["startAtLogin"] == {"value": False, "editable": False}, click
    assert click["registrations"]["desktop"] is None, click
