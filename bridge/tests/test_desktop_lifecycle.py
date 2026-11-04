"""T2 desktop lifecycle (#171): close, background start, reopen and Quit.

Contract (implementation-plan-v2 section 5 lines 110-114; v3 amendment T2
lines 55-56):
- start-at-login off: an actual close of the window stops the Bridge
  gracefully. Serving and the workers stop, the registry is stopped and IPC is
  closed before the instance lock is released, the process exits normally,
  and nothing uses os._exit. Before that close the window plainly says, in a
  visible native label or status-bar message, that closing it stops the
  Bridge (v2 line 112);
- start-at-login on: an actual close hides the window. The owner keeps its
  listener, registry, workers and lock, and a second launch for the same
  DATA_DIR brings back the same window: fixed "show", no new backend, login or
  web view (the I10 restrictions of tests/test_desktop_ipc.py);
- a "--background" launch serves and binds without showing the dashboard
  window (a legacy conflict dialog is the only exception, and is covered
  elsewhere). A second launch brings that never-shown owner forward the same way;
- the native menu action "Quit SilentSuite Bridge", triggered on the owner's
  main thread, stops the Bridge the same graceful way, with no os._exit,
  service-manager call or PID signal.

"Start-at-login on" is a fixture input. Only the desktop entry is precreated
in the isolated HOME, or in a simulated read-only HKCU Run table on Windows,
using the product's own label and renderers. That is not login-time, frozen or
installer evidence. Simulated boundaries are listed in
tests/desktop_smoke/lifecycle_probe.py.

Not covered here: a notice in page content (only native window text counts),
a real account's sync workers, reopen during migration (v3 line 57, see
test_desktop_ipc.py) and login-time launch.

Needs PySide6 and a display; required (SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1)
in the native CI job, skipped elsewhere.
"""

import re
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tests.test_desktop_ipc import (
    PREPARED_LINE,
    _connectable,
    _env,
    _free_port,
    _native_required,
    _read_json,
    _tail,
    _wait_until,
)
from tests.test_instance_lock import probe_instance_lock

PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "lifecycle_probe.py"
QUIT_TEXT = "Quit SilentSuite Bridge"
READY_TIMEOUT = 90
CLOSE_TIMEOUT = 30
SECOND_TIMEOUT = 60
SHOW_ACK_TIMEOUT = 15
OWNER_EXIT_TIMEOUT = 60
EXIT_OS_EXIT = 4
# v2 line 112 notice: one visible text that says closing stops the Bridge.
# The meaning is fixed, not the wording.
CLOSE_NOTICE_WORDS = ({"close", "closes", "closing"}, {"stop", "stops", "stopping"}, {"bridge"})


def _says_close_stops_bridge(text):
    words = set(re.findall(r"[a-z]+", re.sub(r"<[^>]+>", " ", text).lower()))  # rich-text tags ignored
    return all(words & group for group in CLOSE_NOTICE_WORDS)


def _witness(data, port, owner):
    """Positive witnesses from outside the owner: an independent lock probe and a TCP connect."""
    return {
        "owner_alive": owner.poll() is None,
        "lock": probe_instance_lock(data),
        "port_connectable": _connectable(port),
    }


def _run_second(root, env):
    out = root / "second.json"
    argv = [sys.executable, str(PROBE), "--role", "second", "--out", str(out)]
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=SECOND_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): the second launch exceeded {SECOND_TIMEOUT}s")
    result = _read_json(out) or {}
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(f"fixture did not complete (not RED): second rc={completed.returncode} "
                    f"stage={result.get('stage')!r}\n{completed.stderr[-2500:]}")
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): second {result['entry_error']!r}\n"
                    f"{completed.stderr[-2500:]}")
    result["prepared"] = PREPARED_LINE in completed.stdout
    result["stderr_tail"] = completed.stderr[-2500:]
    return result


def _journey(tmp_path_factory, name, *, background=False, registration=False, close=False, reopen=False,
             quit_via_action=False):
    _native_required()
    root = tmp_path_factory.mktemp(name)
    data, home, control = root / "data", root / "t2life-home", root / "control"
    for directory in (data, home, control):
        directory.mkdir()
    port = _free_port()
    env = _env(data, home, port)
    out = root / "owner.json"
    argv = [sys.executable, str(PROBE), "--role", "owner", "--out", str(out),
            "--control", str(control), "--ready", str(root / "ready.json")]
    argv += ["--background"] * background + ["--registration"] * registration
    argv += ["--quit-via-action"] * quit_via_action
    logs = [open(root / "owner.stdout", "w", encoding="utf-8"), open(root / "owner.stderr", "w", encoding="utf-8")]
    owner = subprocess.Popen(argv, stdout=logs[0], stderr=logs[1], env=env, text=True)
    journey = {"port": port, "quit_sent": False, "hidden_reached": False}

    def ack(path, timeout):
        """A file the owner wrote, or {"gone": True} once it has exited; None on timeout."""
        return _wait_until(lambda: _read_json(path) or (owner.poll() is not None and {"gone": True}), timeout)

    try:
        ready = ack(root / "ready.json", READY_TIMEOUT)
        if not ready or ready.get("gone"):
            pytest.fail(f"fixture did not complete (not RED): the owner never became ready "
                        f"(rc={owner.poll()!r})\n{_tail(root / 'owner.stderr')}")
        journey["ready"] = ready
        journey["at_ready"] = _witness(data, port, owner)

        if close:
            (control / "close").write_text("1", encoding="utf-8")
            closed = ack(control / "closed.json", CLOSE_TIMEOUT)
            if not closed:
                pytest.fail(f"fixture timeout (not RED): after the close the owner neither reported "
                            f"nor exited\n{_tail(root / 'owner.stderr')}")
            journey["closed"] = None if closed.get("gone") else closed
            journey["after_close"] = _witness(data, port, owner)
            journey["hidden_reached"] = bool(
                journey["closed"] and journey["after_close"]["owner_alive"] and journey["closed"]["visible"] is False
            )

        # A second launch only while this owner still holds the lock (never let it become an owner).
        if reopen and owner.poll() is None and (journey["hidden_reached"] or not close):
            (control / "second.started").write_text("1", encoding="utf-8")
            journey["second_spawn_wall"] = time.time()
            journey["second"] = _run_second(root, env)
            shown = ack(control / "shown.ack", SHOW_ACK_TIMEOUT)
            journey["shown"] = shown if shown and not shown.get("gone") else None
            journey["after_second"] = _witness(data, port, owner)

        if owner.poll() is None:
            (control / "quit").write_text("1", encoding="utf-8")
            journey["quit_sent"] = True
    finally:
        if not journey["quit_sent"] and owner.poll() is None:
            (control / "abort").write_text("1", encoding="utf-8")
        try:
            owner.wait(timeout=OWNER_EXIT_TIMEOUT)
        except subprocess.TimeoutExpired:
            owner.kill()  # no graceful exit is claimed for a killed owner
            owner.wait(timeout=30)
            journey["killed"] = True
        for handle in logs:
            handle.close()

    if journey.get("killed"):
        pytest.fail(f"fixture timeout (not RED): the owner did not end after teardown and was killed\n"
                    f"{_tail(root / 'owner.stderr')}")
    result = _read_json(out) or {}
    result["rc"] = owner.returncode
    result["stderr_tail"] = _tail(root / "owner.stderr")
    journey["owner"] = result
    journey["after_exit"] = {"lock": probe_instance_lock(data), "port_connectable": _connectable(port)}
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): owner {result['entry_error']!r}\n{result['stderr_tail']}")
    finished = owner.returncode == 0 and result.get("stage") == "done"
    product_os_exit = owner.returncode == EXIT_OS_EXIT and result.get("stage") == "os-exit"
    if not (finished or product_os_exit):
        pytest.fail(f"fixture did not complete (not RED): owner rc={owner.returncode} "
                    f"stage={result.get('stage')!r}\n{result['stderr_tail']}")
    return journey


def _describe(journey):
    owner = journey.get("owner", {})
    keys = ("exit_code", "rc", "stage", "teardown", "close", "closed", "shown", "quit", "order",
            "before_release", "os_exit", "kills", "service_manager_traps")
    second = journey.get("second") or {}
    return (
        f"ready={journey.get('ready')!r}\nat_ready={journey.get('at_ready')!r} "
        f"after_close={journey.get('after_close')!r} after_second={journey.get('after_second')!r} "
        f"after_exit={journey.get('after_exit')!r}\nowner={ {k: owner.get(k) for k in keys}!r}\n"
        f"history={owner.get('history', [])[:12]!r}\n"
        f"second={ {k: second.get(k) for k in ('exit_code', 'observed', 'prepared', 'serving_attempted')}!r}\n"
        f"owner stderr tail:\n{owner.get('stderr_tail', '')}"
    )


def _early_windows(journey):
    """Non-dialog, non-menu windows shown before the second launch was started."""
    cutoff = journey.get("second_spawn_wall", float("inf"))
    return [e for e in journey["owner"].get("history", [])
            if e["event"] == "show" and not e["dialog"] and not e["menu"] and e["wall"] < cutoff]


def _assert_ready_owner(journey, kind):
    ready = journey["ready"]
    assert ready["kind"] == kind, _describe(journey)
    assert ready["registry_dashboard_url"] == f"http://127.0.0.1:{journey['port']}/", _describe(journey)
    assert journey["at_ready"] == {"owner_alive": True, "lock": "BUSY", "port_connectable": True}, _describe(journey)
    assert ready["ipc"].get("listening") is True, _describe(journey)


def _assert_stopped_before_release(journey):
    owner = journey["owner"]
    assert owner.get("os_exit") is None, f"the owner ended through os._exit: {_describe(journey)}"
    assert owner["rc"] == 0 and owner["exit_code"] in (None, 0), _describe(journey)
    assert owner["kills"] == [] and owner["service_manager_traps"] == [], _describe(journey)
    order = owner["order"]
    assert order and order[-1] == "lock_released", _describe(journey)
    assert "ipc_close" in order and order.index("ipc_close") < order.index("lock_releasing"), _describe(journey)
    before = owner["before_release"]
    assert before["server_thread_alive"] is False, f"still serving at lock release: {_describe(journey)}"
    assert before["registry_stopped"] is True, _describe(journey)
    assert before["ipc_listening"] is False, f"IPC still listening at lock release: {_describe(journey)}"
    if sys.platform != "win32":
        assert before["endpoint_file_exists"] is False, _describe(journey)
    worker = before["worker"] or {}
    assert worker.get("stop_calls", 0) >= 1 and worker.get("alive") is False and worker.get("registered") is False, (
        f"the (synthetic) worker was not stopped before lock release: {_describe(journey)}"
    )
    assert owner["lock_free_after"] is True, _describe(journey)
    assert journey["after_exit"] == {"lock": "FREE", "port_connectable": False}, _describe(journey)


def _assert_reopened(journey, same_window):
    second = journey["second"]
    observed = second["observed"]
    assert second["exit_code"] in (None, 0), f"the second launch did not hand over: {_describe(journey)}"
    client = second["client_socket"]
    assert "".join(client["writes_hex"]) == b"show".hex() and client["read_attempts"] == 0, _describe(journey)
    # I10: the second launch runs nothing of its own.
    assert observed["dialogs"] == [] and observed["web_views_seen"] == 0, _describe(journey)
    assert second["prepared"] is False and second["serving_attempted"] is False, _describe(journey)
    assert second["legacy_gate_calls"] == {} and second["removal_calls"] == 0, _describe(journey)
    assert second["service_manager_traps"] == [] and second["kills"] == [], _describe(journey)
    shown = journey["shown"]
    assert shown is not None, f"the owner window did not come back after the second launch: {_describe(journey)}"
    assert shown["dashboard_url"] == journey["ready"]["registry_dashboard_url"], _describe(journey)
    assert shown["requested_url"] == shown["dashboard_url"] and shown["view_count"] == 1, _describe(journey)
    if same_window:
        assert shown["same_window"] is True, f"a different window came back: {_describe(journey)}"
    assert journey["after_second"] == {"owner_alive": True, "lock": "BUSY", "port_connectable": True}, (
        _describe(journey)
    )
    assert journey["owner"].get("external_open_calls", []) == [], _describe(journey)


@pytest.fixture(scope="module")
def foreground_off(tmp_path_factory):
    return _journey(tmp_path_factory, "t2life-off", close=True)


@pytest.fixture(scope="module")
def foreground_on(tmp_path_factory):
    return _journey(tmp_path_factory, "t2life-on", registration=True, close=True, reopen=True)


@pytest.fixture(scope="module")
def background_on(tmp_path_factory):
    return _journey(tmp_path_factory, "t2life-bg", background=True, registration=True, reopen=True,
                    quit_via_action=True)


# --- start-at-login off: ordinary launch and close (controls) ---------------


def test_foreground_launch_without_start_at_login_shows_its_dashboard(foreground_off):
    _assert_ready_owner(foreground_off, "dashboard")
    assert foreground_off["ready"]["dashboard_visible"] is True and foreground_off["ready"]["view_count"] == 1
    assert foreground_off["owner"]["registration_before"] is None, "no-entry control has a desktop entry"
    # The Show/Hide history witness works: the dashboard window's Show was recorded.
    assert any(e["event"] == "show" and not e["dialog"] for e in foreground_off["owner"].get("history", [])), (
        _describe(foreground_off)
    )


def test_close_without_start_at_login_stops_everything_before_the_lock_is_released(foreground_off):
    owner = foreground_off["owner"]
    assert foreground_off["closed"] is None and foreground_off["after_close"]["owner_alive"] is False, (
        f"the owner kept running after an actual close with start-at-login off: {_describe(foreground_off)}"
    )
    assert (owner.get("close") or {}).get("accepted") is True, _describe(foreground_off)
    assert owner.get("teardown") is None, f"the fixture had to stop the owner: {_describe(foreground_off)}"
    _assert_stopped_before_release(foreground_off)


def test_window_says_before_closing_that_closing_stops_the_bridge(foreground_off):
    # v2 line 112: "start-at-login off: close stops the Bridge, and the window
    # says so beforehand". Sampled from the owner's own window right before the
    # actual close: visible native QLabels and a visible status-bar message only.
    sample = (foreground_off["owner"].get("close") or {}).get("notice_before")
    if not sample or sample.get("window_visible") is not True:
        pytest.fail(f"fixture did not sample a visible window before the close (not RED): {sample!r}")
    texts = [entry["text"] for entry in sample["texts"]]
    assert any(_says_close_stops_bridge(text) for text in texts), (
        f"the window does not say that closing it stops SilentSuite Bridge; visible native texts: {texts!r} "
        f"(labels {sample['labels_total']}, status bars {sample['status_bars_total']}); "
        f"at ready: {foreground_off['ready'].get('notice')!r}"
    )


# --- start-at-login on: actual close hides; a second launch reopens ---------


def test_owner_with_start_at_login_on_starts_normally_with_an_isolated_entry(foreground_on):
    _assert_ready_owner(foreground_on, "dashboard")
    owner = foreground_on["owner"]
    assert owner["registration_before"], "the desktop entry fixture input is missing"
    assert owner.get("registration_after") == owner["registration_before"], _describe(foreground_on)
    assert owner.get("service_manager_traps") == [] and owner.get("kills") == [], _describe(foreground_on)


def test_close_with_start_at_login_on_hides_the_window_and_keeps_serving(foreground_on):
    closed, after = foreground_on.get("closed"), foreground_on["after_close"]
    assert closed is not None and after["owner_alive"], (
        f"an actual close stopped the owner although start-at-login is on: {_describe(foreground_on)}"
    )
    assert closed["visible"] is False, f"the window is still visible after an actual close: {_describe(foreground_on)}"
    assert closed["server_thread_alive"] is True and closed["registry_stopped"] is False, _describe(foreground_on)
    assert closed["ipc_listening"] is True, _describe(foreground_on)
    assert (closed["worker"] or {}).get("alive") is True, _describe(foreground_on)
    assert after["lock"] == "BUSY" and after["port_connectable"] is True, _describe(foreground_on)


def test_second_launch_reopens_the_hidden_owner(foreground_on):
    if not foreground_on["hidden_reached"]:
        pytest.fail("NOT REACHED: the owner was not hidden and still running after the actual close")
    _assert_reopened(foreground_on, same_window=True)


# --- --background: never shown until reopened; native Quit ------------------


def test_background_launch_serves_and_holds_the_lock(background_on):
    _assert_ready_owner(background_on, "background")


def test_background_launch_shows_no_window_before_a_reopen_request(background_on):
    early = _early_windows(background_on)
    assert not early, f"a --background launch showed a window on its own: {early[:5]}\n{_describe(background_on)}"


def test_second_launch_reopens_a_never_shown_background_owner(background_on):
    if _early_windows(background_on):
        pytest.fail("NOT REACHED: the --background owner had already shown a window, so it was never hidden")
    if "second" not in background_on:
        pytest.fail("NOT REACHED: the owner was gone before a second launch could run")
    _assert_reopened(background_on, same_window=False)


def test_running_owner_offers_the_quit_menu_action(background_on):
    if not background_on["quit_sent"]:
        pytest.fail("NOT REACHED: the owner had already ended before the Quit step")
    quit = background_on["owner"].get("quit") or {}
    assert quit.get("found", 0) >= 1, (
        f"no native action named exactly {QUIT_TEXT!r} in the running owner; actions seen: {quit.get('texts')!r}"
    )


def test_quit_menu_action_stops_everything_before_the_lock_is_released(background_on):
    owner = background_on["owner"]
    quit = owner.get("quit") or {}
    if not background_on["quit_sent"] or not quit.get("found"):
        pytest.fail(f"NOT REACHED: no {QUIT_TEXT!r} action was triggered; teardown={owner.get('teardown')!r}")
    assert quit["main_thread"] is True and quit["enabled"] is True, _describe(background_on)
    assert owner.get("os_exit") is None, f"Quit ended the owner through os._exit: {_describe(background_on)}"
    assert owner["teardown"] == "quit-action" and quit["stopped_in_time"] is True, (
        f"the Quit action did not end the owner; the fixture had to: {_describe(background_on)}"
    )
    _assert_stopped_before_release(background_on)
