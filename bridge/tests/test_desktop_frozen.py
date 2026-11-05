"""T4 packaged (#171): the canonical frozen desktop app builds and starts.

Contract (implementation-plan-v2 sections 7 and 9/T4; v3 lifecycle unchanged):
- ``bridge/entrypoint_desktop.py`` calls ``main(flavor="desktop")`` and
  ``bridge/silentsuite-bridge-desktop.spec`` builds it as a windowed onedir app
  (a .app on macOS) with Qt WebEngine bundled;
- the bundle's own executable, started by the PyInstaller bootloader with no
  arguments, runs the desktop flavor: it serves its own registry-bound
  dashboard on loopback for a synthetic DATA_DIR with no account;
- in the desktop flavor ``--check-update`` is refused before anything starts.

Build happens in the workflow (.github/workflows/test-bridge-desktop-frozen.yml),
which writes into $SILENTSUITE_FROZEN_OUT. These tests read that and launch the
built executable unmodified.
- Bundler/runtime control: the T0 recipe (PyInstaller onedir of the
  non-product tests/desktop_smoke/probe.py) is frozen in the SAME environment
  and must pass its own frozen gates. It proves the bundler can freeze
  PySide6/Qt WebEngine there; it is NOT product evidence.
- Evidence classes: build layout and file facts; PE subsystem (Windows); the
  .app Info.plist (macOS); HTTP from the launched process's loopback port; the
  instance lock seen from another process; the desktop log file. None of this
  proves a visible window, the packaged privacy profile, close/Quit behaviour,
  real stdio state or OS-login launch. Those stay separate, later acceptance.
- Teardown is an external, scoped termination of the launched process. That is
  fixture cleanup, never evidence of a native Quit.

Runs only in that workflow (SILENTSUITE_REQUIRE_DESKTOP_FROZEN=1); skipped elsewhere.
"""

import json
import os
import plistlib
import re
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.test_desktop_ipc import _connectable, _free_port, _tail
from tests.test_instance_lock import probe_instance_lock

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_INPUTS = ("entrypoint_desktop.py", "silentsuite-bridge-desktop.spec")
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_FROZEN"
OUT_ENV = "SILENTSUITE_FROZEN_OUT"
BRAND = "SilentSuite Bridge"
DESKTOP_LOG_FILENAME = "silentsuite-bridge.log"  # __main__.DESKTOP_LOG_FILENAME
T0_TIMEOUT = 360
STARTUP_SECONDS = 90
REFUSAL_SECONDS = 60
STOP_SECONDS = 30
CSRF_PATTERN = re.compile(r"SILENTSUITE_DASHBOARD_CSRF\s*=\s*\"[^\"]+\"")
PE_SUBSYSTEM_GUI = 2


def _out():
    out = os.environ.get(OUT_ENV)
    if not out:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail(f"prerequisite missing (not RED): {OUT_ENV} is not set in the frozen workflow")
        pytest.skip("frozen desktop tests run only in test-bridge-desktop-frozen.yml")
    return Path(out)


def _read(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


def _isolated_env(root):
    """The runner environment without SILENTSUITE_*, with a synthetic home/profile under ``root``."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    for name in ("home", "tmp", "xdg-config", "xdg-data", "xdg-cache"):
        (root / name).mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        env.update({"TMP": str(root / "tmp"), "TEMP": str(root / "tmp")})
    else:
        env.update({"HOME": str(root / "home"), "TMPDIR": str(root / "tmp")})
        if sys.platform.startswith("linux"):
            env.update({"XDG_CONFIG_HOME": str(root / "xdg-config"), "XDG_DATA_HOME": str(root / "xdg-data"),
                        "XDG_CACHE_HOME": str(root / "xdg-cache")})
    return env


# --- bundler/runtime control (T0 recipe; non-product) ------------------------


@pytest.fixture(scope="module")
def t0_control(tmp_path_factory):
    out = _out()
    result = {"build_rc": _read(out / "t0-build.rc"), "pyinstaller": _read(out / "pyinstaller-version.txt")}
    exe = out / "t0-dist" / "t0-probe" / ("t0-probe.exe" if sys.platform == "win32" else "t0-probe")
    result["exe_present"] = exe.is_file()
    if result["build_rc"] == "0" and result["exe_present"]:
        root = tmp_path_factory.mktemp("t0-frozen")
        report = out / "t0-frozen.json"
        try:
            done = subprocess.run([str(exe), "--mode", "frozen", "--out", str(report), "--isolated-root", str(root)],
                                  capture_output=True, text=True, timeout=T0_TIMEOUT, env=_isolated_env(root))
            result["run_rc"] = done.returncode
            result["stderr_tail"] = done.stderr[-1500:]
        except subprocess.TimeoutExpired:
            result["run_rc"] = "timeout"
    result["build_log_tail"] = (_read(out / "t0-build.log") or "")[-1500:]
    return result


def _require_control(control):
    if not (control["build_rc"] == "0" and control.get("run_rc") == 0):
        pytest.fail(f"bundler/runtime control failed (not RED): {json.dumps(control)[:3000]}")


def test_bundler_control_freezes_and_runs_the_t0_qt_probe(t0_control):
    # Control: PyInstaller can freeze PySide6/Qt WebEngine in this environment
    # and the frozen non-product probe passes its own gates. Not product proof.
    assert t0_control["build_rc"] == "0" and t0_control["exe_present"], t0_control
    assert t0_control.get("run_rc") == 0, t0_control


# --- canonical product inputs and build ---------------------------------------


def test_canonical_desktop_build_inputs_exist():
    _out()
    missing = [name for name in CANONICAL_INPUTS if not (BRIDGE_ROOT / name).is_file()]
    assert not missing, f"canonical desktop build inputs are missing: {missing}"


def _bundle(out):
    """The single onedir bundle the canonical spec produced (planned layout, see handoff)."""
    dist = out / "dist"
    if sys.platform == "darwin":
        apps = sorted(dist.glob("*.app"))
        if len(apps) != 1:
            return None
        info = plistlib.loads((apps[0] / "Contents" / "Info.plist").read_bytes())
        exe = apps[0] / "Contents" / "MacOS" / str(info.get("CFBundleExecutable", ""))
        return {"root": apps[0], "exe": exe, "info": info}
    suffix = ".exe" if sys.platform == "win32" else ""
    found = [d for d in sorted(dist.iterdir()) if d.is_dir() and (d / f"{d.name}{suffix}").is_file()] \
        if dist.is_dir() else []
    if len(found) != 1:
        return None
    return {"root": found[0], "exe": found[0] / f"{found[0].name}{suffix}", "info": None}


def _pe_subsystem(path):
    data = Path(path).read_bytes()[:4096]
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[offset:offset + 4] != b"PE\0\0":
        return None
    return struct.unpack_from("<H", data, offset + 4 + 20 + 68)[0]


@pytest.fixture(scope="module")
def canonical(t0_control):
    out = _out()
    _require_control(t0_control)
    if any(not (BRIDGE_ROOT / name).is_file() for name in CANONICAL_INPUTS):
        pytest.fail("NOT REACHED: the canonical desktop build inputs are missing")
    rc = _read(out / "canonical-build.rc")
    bundle = _bundle(out) if rc == "0" else None
    return {"rc": rc, "bundle": bundle, "log_tail": (_read(out / "canonical-build.log") or "")[-3000:]}


def test_canonical_spec_builds_a_windowed_onedir_bundle(canonical):
    assert canonical["rc"] == "0", f"the canonical desktop spec did not build:\n{canonical['log_tail']}"
    bundle = canonical["bundle"]
    assert bundle is not None, "no single onedir bundle (folder with its same-named executable / one .app) in dist"
    assert bundle["exe"].is_file(), bundle
    if sys.platform == "darwin":
        assert bundle["info"].get("CFBundleExecutable"), bundle["info"]  # an app bundle: windowed on macOS
    else:
        assert (bundle["root"] / "_internal").is_dir(), "not a onedir layout (no _internal folder)"
    if sys.platform == "win32":
        assert _pe_subsystem(bundle["exe"]) == PE_SUBSYSTEM_GUI, "the Windows executable is not a GUI (windowed) binary"
    # Linux: windowed has no binary property; nothing further is claimed.


def test_frozen_bundle_contains_qt_webengine_runtime(canonical):
    bundle = canonical["bundle"]
    if bundle is None:
        pytest.fail("NOT REACHED: no canonical bundle was built")
    names = {p.name for p in bundle["root"].rglob("*")}
    assert any(n.startswith("QtWebEngineProcess") for n in names), "no QtWebEngineProcess helper in the bundle"
    assert "qtwebengine_resources.pak" in names, "no Qt WebEngine resources in the bundle"


# --- the real bootloader launch ------------------------------------------------


def _get(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except (OSError, ValueError):
        return None, b""


@pytest.fixture(scope="module")
def started(canonical, tmp_path_factory):
    bundle = canonical["bundle"]
    if bundle is None:
        pytest.fail("NOT REACHED: no canonical bundle was built")
    root = tmp_path_factory.mktemp("frozen-start")
    data = root / "data"
    port = _free_port()
    env = _isolated_env(root)
    env.update({"SILENTSUITE_DATA_DIR": str(data), "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
                "SILENTSUITE_LISTEN_PORT": str(port)})
    base = f"http://127.0.0.1:{port}"
    logs = [open(root / "app.stdout", "w", encoding="utf-8"), open(root / "app.stderr", "w", encoding="utf-8")]
    app = subprocess.Popen([str(bundle["exe"])], cwd=str(root), env=env, stdout=logs[0], stderr=logs[1])
    journey = {"pid": app.pid, "port": port, "data": data}
    try:
        deadline = time.monotonic() + STARTUP_SECONDS
        page = (None, b"")
        while time.monotonic() < deadline and app.poll() is None:
            page = _get(base + "/.web")
            if page[0] == 200:
                break
            time.sleep(0.5)
        journey["exited_early"] = app.poll()
        journey["page_status"] = page[0]
        text = page[1].decode("utf-8", "replace")
        journey["page_brand"] = BRAND in text
        journey["page_csrf"] = CSRF_PATTERN.search(text) is not None
        if page[0] == 200:
            status, body = _get(base + "/.web/api/settings")
            journey["settings"] = [status, json.loads(body) if status == 200 else None]
            status, body = _get(base + "/.web/api/status")
            journey["status"] = [status, json.loads(body) if status == 200 else None]
            journey["lock_while_running"] = probe_instance_lock(data)
            journey["log_file"] = (data / DESKTOP_LOG_FILENAME).is_file()
            journey["alive_after_checks"] = app.poll() is None
    finally:
        # Fixture cleanup only (never a native Quit): terminate, then kill if needed.
        outcome = "exited-by-itself" if app.poll() is not None else None
        if outcome is None:
            app.terminate()
            try:
                app.wait(timeout=STOP_SECONDS)
                outcome = "terminated"
            except subprocess.TimeoutExpired:
                app.kill()
                try:
                    app.wait(timeout=STOP_SECONDS)
                    outcome = "killed"
                except subprocess.TimeoutExpired:
                    outcome = "unknown"
        for handle in logs:
            handle.close()
    journey["stop_outcome"] = outcome
    journey["returncode"] = app.returncode
    journey["port_released"] = not _connectable(port)
    journey["lock_after"] = probe_instance_lock(data) if data.is_dir() else "no-data-dir"
    journey["stderr_tail"] = _tail(root / "app.stderr")
    journey["log_tail"] = _tail(data / DESKTOP_LOG_FILENAME) if data.is_dir() else ""
    return journey


def test_frozen_app_starts_and_serves_its_own_dashboard(started):
    assert started["exited_early"] is None and started["page_status"] == 200, (
        f"the frozen app did not serve its dashboard: {started!r}"
    )
    assert started["page_brand"] and started["page_csrf"], started
    settings_status, settings = started["settings"]
    assert settings_status == 200, started
    # Desktop-flavor witness: only the desktop server reports startAtLogin.
    assert isinstance(settings.get("startAtLogin"), dict), f"not the desktop flavor: {settings!r}"
    bound = json.dumps(started["status"][1]["network"]["bound"])
    assert f"127.0.0.1:{started['port']}" in bound or str(started["port"]) in bound, started["status"]
    assert started["lock_while_running"] == "BUSY", started  # this process owns the synthetic DATA_DIR
    assert started["log_file"] is True, "no desktop log file in DATA_DIR (windowed logging)"
    assert started["alive_after_checks"] is True, started


def test_frozen_app_releases_its_port_and_lock_after_fixture_termination(started):
    if started.get("page_status") != 200:
        pytest.fail("NOT REACHED: the frozen app never served its dashboard")
    # Fixture termination, recorded as such: an exit was positively observed,
    # the listener is gone and the instance lock is free.
    assert started["stop_outcome"] in ("terminated", "killed"), started["stop_outcome"]
    assert started["returncode"] is not None and started["port_released"] is True, started
    assert started["lock_after"] == "FREE", started


def test_frozen_desktop_refuses_the_updater_without_side_effects(canonical, tmp_path):
    bundle = canonical["bundle"]
    if bundle is None:
        pytest.fail("NOT REACHED: no canonical bundle was built")
    data = tmp_path / "data-not-created"
    port = _free_port()
    env = _isolated_env(tmp_path)
    env.update({"SILENTSUITE_DATA_DIR": str(data), "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
                "SILENTSUITE_LISTEN_PORT": str(port)})
    try:
        done = subprocess.run([str(bundle["exe"]), "--check-update"], cwd=str(tmp_path), env=env,
                              capture_output=True, timeout=REFUSAL_SECONDS)
    except subprocess.TimeoutExpired:
        pytest.fail("the frozen desktop app did not refuse --check-update promptly")
    # Evidence: exit code and the absence of start-up side effects. Whether the
    # updater module was imported is not observable here.
    assert done.returncode == 1, f"rc={done.returncode}"
    assert not data.exists(), "the refused launch created the data directory"
    assert not _connectable(port), "the refused launch bound a listener"
