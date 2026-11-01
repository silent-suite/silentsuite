"""T2 (#171): first real native window journey for the desktop flavor.

One child process (``tests/desktop_smoke/product_probe.py``) runs the real
``main(flavor="desktop")`` with a synthetic, account-free data directory and a
free loopback port, observes the product's window through Qt, loads one
off-origin URL into it, closes it like a user (start-at-login off), and
measures what is left afterwards. The tests below judge that one journey.

Evidence classes are kept apart:
- ``test_native_prerequisites_are_present`` is the positive witness that Qt,
  a display and Qt WebEngine work on this runner. A failure there is a
  prerequisite problem, never product evidence.
- ``test_desktop_entrypoint_accepts_desktop_flavor`` is the entrypoint gap.
- The remaining tests are only meaningful once the entrypoint runs; until
  then they fail with an explicit NOT REACHED message.

This needs PySide6 and a display. Ordinary headless suites skip it; the
required native CI job sets SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1, which turns
a missing PySide6 into a failure instead of a skip.
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

import pytest

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "product_probe.py"
BRAND = "SilentSuite Bridge"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
CHILD_TIMEOUT = 180
CLOSE_DEADLINE_SECONDS = 15.0


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def journey(tmp_path_factory):
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")

    root = tmp_path_factory.mktemp("t2-window")
    data_dir = root / "data"
    home = root / "home"
    out = root / "result.json"
    for directory in (data_dir, home):
        directory.mkdir()
    port = _free_port()

    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src") + os.pathsep + str(BRIDGE_ROOT)
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(port),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    if sys.platform != "win32":
        # Keep any per-user start-at-login registration lookups inside the run.
        env.update({
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
        })

    try:
        completed = subprocess.run(
            [sys.executable, str(PROBE), "--out", str(out)],
            capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): the desktop journey exceeded {CHILD_TIMEOUT}s")

    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    return {
        "rc": completed.returncode,
        "stdout": completed.stdout[-4000:],
        "stderr": completed.stderr[-4000:],
        "result": result,
        "port": port,
    }


def _describe(journey):
    result = journey["result"]
    return (
        f"rc={journey['rc']} stage={result.get('stage')!r} entry_error={result.get('entry_error')!r}\n"
        f"stderr tail:\n{journey['stderr']}"
    )


def _require_entrypoint_ran(journey):
    result = journey["result"]
    if result.get("entry_error") is not None:
        pytest.fail(f"NOT REACHED: the desktop entrypoint did not run. {_describe(journey)}")


def test_native_prerequisites_are_present(journey):
    result = journey["result"]
    prereq = result.get("prereq", {})
    assert journey["rc"] != 2 and "import_error" not in prereq, (
        f"prerequisite missing (not RED): {_describe(journey)}"
    )
    assert prereq.get("qapplication") and prereq.get("screen") and prereq.get("webengine_view_constructed"), (
        f"prerequisite missing (not RED): no QApplication, screen or Qt WebEngine view. {_describe(journey)}"
    )
    assert journey["rc"] == 0, f"fixture crashed or hit its watchdog (not RED): {_describe(journey)}"


def test_desktop_entrypoint_accepts_desktop_flavor(journey):
    entry_error = journey["result"].get("entry_error")
    assert entry_error is None, (
        f"desktop entrypoint missing or failed: main(flavor='desktop') raised {entry_error!r}"
    )


def test_window_is_branded_and_shows_its_own_bound_dashboard(journey):
    _require_entrypoint_ran(journey)
    observed = journey["result"].get("observed", {})
    assert not observed.get("window_deadline_missed"), f"no product window showed the dashboard: {_describe(journey)}"
    assert BRAND in observed.get("window_title", ""), observed
    assert observed.get("page_title") == BRAND
    assert observed.get("visible_top_level_windows") == 1
    # The view shows the URL this process's registry confirmed after binding,
    # on the port the run requested: not a requested, file- or IPC-supplied URL.
    assert observed.get("view_url") == observed.get("registry_dashboard_url")
    assert observed.get("view_url") == f"http://127.0.0.1:{journey['port']}/"
    assert observed.get("off_the_record") is True
    assert observed.get("web_channel_absent") is True


def test_off_origin_load_is_refused_before_any_request(journey):
    _require_entrypoint_ran(journey)
    observed = journey["result"].get("observed", {})
    assert "foreign_requests" in observed, f"NOT REACHED: the window was never observed. {_describe(journey)}"
    assert observed["foreign_requests"] == []
    assert observed.get("view_url_after_off_origin") == observed.get("registry_dashboard_url")


def test_window_close_stops_the_owned_server_and_releases_the_lock(journey):
    _require_entrypoint_ran(journey)
    result = journey["result"]
    assert result.get("stage") == "done", f"main() did not return after the window closed: {_describe(journey)}"
    after = result["after"]
    assert after["close_to_return_seconds"] is not None, f"NOT REACHED: the window was never closed. {_describe(journey)}"
    assert after["close_to_return_seconds"] < CLOSE_DEADLINE_SECONDS
    assert after["exit_code"] in (None, 0)
    assert after["lock_free"] is True
    assert after["listener_closed"] is True
    assert after["registry_stopped"] is True
    assert after["registry_dashboard_url"] is None
    assert after["live_sync_workers"] == 0
    assert after["stray_non_daemon_threads"] == []


def test_desktop_journey_never_opens_a_system_browser(journey):
    _require_entrypoint_ran(journey)
    traps = journey["result"].get("traps", {})
    assert traps.get("webbrowser_calls") == 0
    assert traps.get("external_open_calls") == []
