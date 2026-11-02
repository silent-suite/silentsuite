"""T4 (#171): desktop start-at-login is registration-only and needs a stable install.

Contract (implementation-plan-v2 sections 5-7 and T4):
- the desktop settings API (GET/POST /.web/api/settings, real Host and CSRF
  admission) exposes ``startAtLogin`` as ``{"value": bool, "editable": bool}``;
- it is editable only when the running executable sits at a stable installed
  root: Windows %LOCALAPPDATA%\\Programs, macOS /Applications or ~/Applications
  (never /Volumes or AppTranslocation), Linux /opt/silentsuite-bridge.
  Elsewhere (source checkout, download folder) POST enable returns 409 and
  nothing is written;
- enabling writes ONLY the desktop entry, with argv = installed executable +
  ``--background``: HKCU Run ``SilentSuiteBridgeDesktop``; macOS
  ~/Library/LaunchAgents/io.silentsuite.bridge.desktop.plist with RunAtLoad
  and no KeepAlive; Linux XDG autostart silentsuite-bridge-desktop.desktop with
  TryExec. Disabling removes only that entry;
- no service manager runs, nothing is launched or stopped, and a CLI
  registration (added after the owner started) is never touched.

Each scenario is one fresh child (tests/desktop_smoke/autostart_probe.py),
which also lists exactly what is simulated: the frozen/installed identity, the
Windows HKCU Run table and the trapped managers. This is not a frozen build,
an installer, ACL evidence or a login-time launch.

Needs PySide6 and a display; required (SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1)
in the native CI job. On Linux the installed scenario also needs the empty
inert /opt/silentsuite-bridge/silentsuite-bridge-desktop the CI step creates.
"""

import importlib.util
import json
import os
import plistlib
import shlex
import socket
import subprocess
import sys
from pathlib import Path

import pytest

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "autostart_probe.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
CHILD_TIMEOUT = 180
LINUX_INSTALLED = "/opt/silentsuite-bridge/silentsuite-bridge-desktop"
LINUX_DESKTOP_REL = ".config/autostart/silentsuite-bridge-desktop.desktop"
MAC_DESKTOP_REL = "Library/LaunchAgents/io.silentsuite.bridge.desktop.plist"


def _native_required():
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _executable_for(scenario, root, home, localappdata):
    if scenario == "source":
        return ""
    if sys.platform == "win32":
        base = localappdata / "Programs" if scenario == "installed" else root / "Downloads"
        return str(base / "SilentSuite Bridge" / "SilentSuite Bridge.exe")
    if sys.platform == "darwin":
        base = home / "Applications" if scenario == "installed" else root / "Downloads"
        return str(base / "SilentSuite Bridge.app" / "Contents" / "MacOS" / "SilentSuite Bridge")
    return LINUX_INSTALLED if scenario == "installed" else str(root / "Downloads" / "silentsuite-bridge-desktop")


def _journey(tmp_path_factory, scenario):
    _native_required()
    root = tmp_path_factory.mktemp(f"t4auto-{scenario}")
    data, home, localappdata = root / "data", root / "t4auto-home", root / "localappdata"
    for directory in (data, home, localappdata):
        directory.mkdir()
    executable = _executable_for(scenario, root, home, localappdata)
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(_free_port()),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    if sys.platform == "win32":
        env["LOCALAPPDATA"] = str(localappdata)
    else:
        env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                    "XDG_DATA_HOME": str(home / ".local" / "share")})
    out = root / "result.json"
    argv = [sys.executable, str(PROBE), "--scenario", scenario, "--out", str(out), "--executable", executable]
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): {scenario} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    describe = (
        f"{scenario}: rc={completed.returncode} stage={result.get('stage')!r} prereq={result.get('prereq')!r} "
        f"entry_error={result.get('entry_error')!r}\nsteps={json.dumps(result.get('steps'), default=str)[:3000]}\n"
        f"stderr tail:\n{completed.stderr[-2500:]}"
    )
    steps = result.get("steps", {})
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(f"fixture did not complete (not RED): {describe}")
    if result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): {describe}")
    if result.get("window_deadline_missed") or not steps.get("csrf_found") or steps.get("driver_error"):
        pytest.fail(f"fixture did not reach the dashboard settings API (not RED): {describe}")
    if result.get("prereq", {}).get("simulated_executable_x_ok") is False:
        pytest.fail(f"simulated executable is not executable (not RED): {describe}")
    return {"result": result, "steps": steps, "describe": describe, "executable": executable}


@pytest.fixture(scope="module")
def source_run(tmp_path_factory):
    return _journey(tmp_path_factory, "source")


@pytest.fixture(scope="module")
def offpath_run(tmp_path_factory):
    return _journey(tmp_path_factory, "offpath")


@pytest.fixture(scope="module")
def installed_run(tmp_path_factory):
    return _journey(tmp_path_factory, "installed")


def _field(get_step):
    status, body = get_step
    assert status == 200, get_step
    return body.get("startAtLogin")


def _assert_api_admitted(run):
    """The settings API really admits this client; refusals of startAtLogin mean something."""
    steps = run["steps"]
    for name in ("get_before", "get_after_enable", "get_after_disable"):
        assert steps[name][0] == 200, f"{name} was not admitted: {steps[name]!r}"
    interval = steps.get("admission_interval")
    assert isinstance(interval, int), f"no current syncInterval to re-save: {steps['get_before']!r}"
    assert steps.get("admission_post") == [200, {"ok": True, "syncInterval": interval}], (
        f"the same-value syncInterval POST (Host + CSRF) was not admitted: {steps.get('admission_post')!r}"
    )
    # 409 is the legitimate refusal; 403/500 (or anything else) would make a
    # startAtLogin result meaningless.
    for name in ("post_enable", "post_disable"):
        assert steps[name][0] in (200, 409), f"{name} returned an unexpected status: {steps[name]!r}"


def _assert_controls(run):
    """Never a manager, a launch, a CLI-entry change or a stray file, whatever the API did."""
    _assert_api_admitted(run)
    result, steps = run["result"], run["steps"]
    assert result["exit_code"] in (None, 0), run["describe"]
    assert result["lock_free_after"] is True and result["registry_stopped_after"] is True, run["describe"]
    assert result["service_manager_traps"] == [], run["describe"]
    assert result["launch_attempts"] == [], run["describe"]
    before = steps["registrations_before"]
    for name in ("registrations_after_enable", "registrations_after_disable"):
        after = steps[name]
        assert after["cli"] == before["cli"] and before["cli"], f"CLI entry changed at {name}: {run['describe']}"
        if sys.platform == "win32":
            assert set(after["values"]) <= {"SilentSuiteBridge", "SilentSuiteBridgeDesktop"}, run["describe"]
        else:
            allowed = {LINUX_DESKTOP_REL if sys.platform != "darwin" else MAC_DESKTOP_REL}
            assert set(after["home_files"]) - set(before["home_files"]) <= allowed, run["describe"]
    if sys.platform == "win32":
        assert all(name == "SilentSuiteBridgeDesktop" for _, name in result["run_key_writes"]), run["describe"]


def _assert_refused(run):
    field = _field(run["steps"]["get_before"])
    assert field is not None and field.get("value") is False and field.get("editable") is False, (
        f"startAtLogin is not reported as off and not editable outside a stable install: {field!r}\n"
        f"{run['describe']}"
    )
    status, body = run["steps"]["post_enable"]
    assert status == 409 and "error" in body, f"enable was not refused: {status} {body!r}"
    assert run["steps"]["registrations_after_enable"]["desktop"] is None, run["describe"]


def _same_path(a, b):
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def _assert_desktop_entry(entry, executable):
    assert entry, "no desktop start-at-login entry was written"
    if sys.platform == "win32":
        assert entry.lower() == subprocess.list2cmdline([executable, "--background"]).lower(), entry
    elif sys.platform == "darwin":
        plist = plistlib.loads(entry.encode("utf-8"))
        assert plist.get("Label") == "io.silentsuite.bridge.desktop", plist
        arguments = plist.get("ProgramArguments") or []
        assert len(arguments) == 2 and _same_path(arguments[0], executable) and arguments[1] == "--background", plist
        assert plist.get("RunAtLoad") is True, plist
        assert not plist.get("KeepAlive"), plist
    else:
        lines = dict(line.split("=", 1) for line in entry.splitlines() if "=" in line and not line.startswith("#"))
        assert _same_path(lines.get("TryExec", ""), executable), entry
        exec_argv = shlex.split(lines.get("Exec", ""))
        assert len(exec_argv) == 2 and _same_path(exec_argv[0], executable) and exec_argv[1] == "--background", entry


# --- controls (expected to pass on current source) -------------------------


def test_source_run_never_touches_managers_cli_entries_or_launches(source_run):
    _assert_controls(source_run)


def test_offpath_run_never_touches_managers_cli_entries_or_launches(offpath_run):
    _assert_controls(offpath_run)


def test_installed_run_never_touches_managers_cli_entries_or_launches(installed_run):
    _assert_controls(installed_run)


# --- feature (expected RED on current source) ------------------------------


def test_source_checkout_refuses_start_at_login(source_run):
    _assert_refused(source_run)


def test_download_folder_app_refuses_start_at_login(offpath_run):
    _assert_refused(offpath_run)


def test_installed_app_enables_only_its_desktop_entry(installed_run):
    steps = installed_run["steps"]
    field = _field(steps["get_before"])
    assert field is not None and field.get("value") is False and field.get("editable") is True, (
        f"startAtLogin is not reported as off and editable at a stable install: {field!r}\n"
        f"{installed_run['describe']}"
    )
    status, body = steps["post_enable"]
    assert status == 200 and body.get("ok") is True, f"enable failed: {status} {body!r}"
    _assert_desktop_entry(steps["registrations_after_enable"]["desktop"], installed_run["executable"])
    assert _field(steps["get_after_enable"]).get("value") is True


def test_installed_app_disable_removes_only_its_desktop_entry(installed_run):
    steps = installed_run["steps"]
    assert steps["registrations_after_enable"]["desktop"], "NOT REACHED: enable never wrote an entry"
    status, body = steps["post_disable"]
    assert status == 200 and body.get("ok") is True, f"disable failed: {status} {body!r}"
    assert steps["registrations_after_disable"]["desktop"] is None, installed_run["describe"]
    assert _field(steps["get_after_disable"]).get("value") is False
