"""T1b (#171): the desktop app's legacy CLI gate.

Contract (implementation-plan-v2 section 5 plus the v3 amendment):
- the instance lock is taken FIRST; a busy lock never runs legacy detection
  or removal and never starts serving;
- only the lock owner then checks for a CLI start-at-login registration
  (systemd unit / launchd plist / HKCU Run "SilentSuiteBridge") and for a
  listener already on the effective loopback port, BEFORE
  ``_prepare_server_start`` and any serving;
- a conflict shows a native QMessageBox whose text contains
  "Move to the desktop app";
- cancel: no removal, no preparation, no serving, non-zero exit;
- confirm: ``autostart.remove_autostart()`` exactly once, then one re-check;
  clear -> the app starts on its OWN bound dashboard; still present -> refuse
  without serving, non-zero exit;
- a desktop-specific registration is not mistaken for a CLI one.

Each case runs ``tests/desktop_smoke/migration_probe.py`` in a fresh process
with synthetic DATA_DIR/HOME/port. See that file for exactly what is real and
what is simulated. "Prepared" is witnessed by the real no-account line
``No account configured yet`` that ``_prepare_server_start`` prints; "serving
attempted" by the real listener registry having left its never-started state.

Needs PySide6 and a display: skipped in ordinary headless suites, required
(SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1) in the native CI job.
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_instance_lock import hold_instance_lock

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "migration_probe.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
PREPARED_LINE = "No account configured yet"
CHILD_TIMEOUT = 150


@pytest.fixture(autouse=True)
def _native_required():
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _dirs(tmp_path):
    root = tmp_path / "t1b-run"
    data_dir, home = root / "data", root / "t1b-home"
    data_dir.mkdir(parents=True)
    home.mkdir()
    return root, data_dir, home


def _run(root, data_dir, home, scenario):
    out = root / f"{scenario}.json"
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(_free_port()),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    if sys.platform != "win32":
        env.update({
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
        })
    try:
        completed = subprocess.run(
            [sys.executable, str(PROBE), "--scenario", scenario, "--out", str(out)],
            capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): scenario {scenario} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    describe = (
        f"scenario={scenario} rc={completed.returncode} stage={result.get('stage')!r} "
        f"entry_error={result.get('entry_error')!r}\nstdout tail:\n{completed.stdout[-1500:]}"
        f"\nstderr tail:\n{completed.stderr[-4000:]}"
    )
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(f"fixture did not complete (not RED): {describe}")
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not a gate result): {describe}")
    result["prepared"] = PREPARED_LINE in completed.stdout
    result["describe"] = describe
    return result


def _witness(result):
    observed = result["observed"]
    return (
        f"prompts={observed['prompts']!r} prepared={result['prepared']} "
        f"serving_attempted={result['serving_attempted']} dashboard_shown={observed['dashboard_shown']} "
        f"removal_calls={result['removal_calls']} exit_code={result['exit_code']!r}"
        # Diagnostic context only (never asserted), so a failure shows where startup stood.
        f"\nlast_registry={observed.get('last_registry')!r} first_bound_seconds={observed.get('first_bound_seconds')!r}"
        f"\ndiagnostics={result.get('diagnostics')!r}"
        f"\nstall_stacks={observed.get('stall_stacks')!r}"
        f"\n{result['describe']}"
    )


def _assert_prompted_once(result):
    prompts = result["observed"]["prompts"]
    assert len(prompts) == 1, (
        f"the legacy conflict got past the desktop preflight without one 'Move to the desktop app' prompt: "
        f"{_witness(result)}"
    )
    assert result["observed"].get("prompt_answered") == [True], "the prompt had no Accept/Reject button to answer"


def _assert_refused_without_serving(result):
    assert result["prepared"] is False, _witness(result)
    assert result["serving_attempted"] is False, _witness(result)
    assert result["observed"]["dashboard_shown"] is False, _witness(result)
    assert result["exit_code"] not in (None, 0), _witness(result)
    assert result["lock_free_after"] is True


def _assert_no_side_effects(result):
    assert result["service_manager_traps"] == [], result["service_manager_traps"]


# --- controls (expected to pass on current source) -------------------------


def test_no_legacy_state_starts_on_its_own_dashboard_without_a_prompt(tmp_path):
    result = _run(*_dirs(tmp_path), "no_legacy")

    assert result["observed"]["prompts"] == []
    assert result["removal_calls"] == 0
    assert result["observed"]["dashboard_shown"] is True, _witness(result)
    assert result["observed"]["requested_url"] == result["observed"]["registry_dashboard_url"]
    assert result["exit_code"] in (None, 0)
    assert result["lock_free_after"] is True
    _assert_no_side_effects(result)


def test_desktop_registration_is_not_mistaken_for_the_cli(tmp_path):
    result = _run(*_dirs(tmp_path), "desktop_only")

    assert result["observed"]["prompts"] == []
    assert result["removal_calls"] == 0
    assert result["registration_present_after"] is True
    assert result["observed"]["dashboard_shown"] is True, _witness(result)
    assert result["exit_code"] in (None, 0)
    _assert_no_side_effects(result)


def test_busy_lock_never_detects_removes_or_serves(tmp_path):
    root, data_dir, home = _dirs(tmp_path)
    with hold_instance_lock(data_dir):
        result = _run(root, data_dir, home, "busy_lock")

    assert result["observed"]["prompts"] == []
    assert result["removal_calls"] == 0
    assert result["prepared"] is False
    assert result["serving_attempted"] is False
    assert result["observed"]["dashboard_shown"] is False
    assert result["exit_code"] not in (None, 0)
    _assert_no_side_effects(result)


# --- legacy gate (expected RED on current source) --------------------------


def test_cli_registration_cancel_refuses_without_removal_or_serving(tmp_path):
    result = _run(*_dirs(tmp_path), "cli_cancel")

    _assert_prompted_once(result)
    assert result["removal_calls"] == 0
    assert result["registration_present_after"] is True
    _assert_refused_without_serving(result)
    _assert_no_side_effects(result)


def test_cli_registration_confirm_removes_once_then_starts_on_own_dashboard(tmp_path):
    result = _run(*_dirs(tmp_path), "cli_confirm_clears")

    _assert_prompted_once(result)
    assert result["removal_calls"] == 1
    assert result["registration_present_after"] is False
    assert result["prepared"] is True
    assert result["observed"]["dashboard_shown"] is True, _witness(result)
    assert result["observed"]["requested_url"] == result["observed"]["registry_dashboard_url"]
    assert result["exit_code"] in (None, 0)
    assert result["lock_free_after"] is True
    _assert_no_side_effects(result)


def test_cli_registration_still_present_after_removal_refuses_after_one_recheck(tmp_path):
    result = _run(*_dirs(tmp_path), "cli_confirm_remains")

    _assert_prompted_once(result)
    assert result["removal_calls"] == 1
    assert result["registration_present_after"] is True
    _assert_refused_without_serving(result)
    _assert_no_side_effects(result)


def test_occupied_loopback_port_cancel_refuses_without_touching_the_old_listener(tmp_path):
    result = _run(*_dirs(tmp_path), "port_cancel")

    _assert_prompted_once(result)
    assert result["removal_calls"] == 0
    assert result["foreign_requests"] == []
    _assert_refused_without_serving(result)
    _assert_no_side_effects(result)
