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


# Qt Charts, Qt Data Visualization and Qt Graphs (P1, s2-delivery-plan-v9 section 3):
# any path segment that names one of these families, i.e. the libraries
# (libQt6Charts.so.6, Qt6Graphs.dll, Qt6Graphs2DImpl), macOS frameworks
# (QtCharts.framework), QML module directories (qml/QtDataVisualization/...) and
# PySide6 bindings (QtCharts.abi3.so, QtGraphsWidgets.pyd). The negative
# lookahead keeps unrelated names such as QtGraphicalEffects out.
EXCLUDED_QT_FAMILY = re.compile(r"^(lib)?Qt6?(Charts|DataVisualization|Graphs)(?![a-z])")
QT_CORE_NAME = re.compile(r"^(lib)?Qt6?Core(?![A-Za-z])")


def test_frozen_bundle_excludes_qt_charts_datavisualization_and_graphs(canonical):
    bundle = canonical["bundle"]
    if bundle is None:
        pytest.fail("NOT REACHED: no canonical bundle was built")
    # Controls (not RED if they fail): the rule matches each family form and
    # leaves unrelated Qt names alone; the bundle really contains Qt.
    for name in ("libQt6Charts.so.6", "Qt6DataVisualizationQml.dll", "libQt6Graphs2DImpl.so.6", "QtCharts.framework",
                 "QtGraphs", "QtGraphsWidgets.pyd", "QtDataVisualization.abi3.so"):
        if not EXCLUDED_QT_FAMILY.match(name):
            pytest.fail(f"control failed (not RED): the family rule misses {name}")
    for name in ("QtGraphicalEffects", "Qt6GraphicalEffects.dll", "libQt6Core.so.6", "QtQuick", "Qt6WebEngineCore.dll"):
        if EXCLUDED_QT_FAMILY.match(name):
            pytest.fail(f"control failed (not RED): the family rule wrongly matches {name}")
    root = bundle["root"]
    paths = [p.relative_to(root).as_posix() for p in sorted(root.rglob("*"))]
    if not any(QT_CORE_NAME.match(part) for path in paths for part in path.split("/")):
        pytest.fail("control failed (not RED): no Qt Core library found, so the scan would be vacuous")
    found = [path for path in paths if any(EXCLUDED_QT_FAMILY.match(part) for part in path.split("/"))]
    assert not found, (
        f"the bundle contains {len(found)} Qt Charts/DataVisualization/Graphs paths, e.g. {found[:20]}"
    )


# P2 (s2-delivery-plan-v9 section 3; post-p1-component-review-final-answer.md):
# Qt Quick 3D (with its helper/asset/effects/particles/runtime/utils/Xr modules),
# Qt Quick 3D Physics, Qt Quick Timeline, Qt Virtual Keyboard and, on Linux, Qt
# Wayland Compositor, plus their source-proven dependency closure: Quick3DSpatialAudio
# (links Qt::Quick3DPrivate) and the compositor's QtShell and TextureSharingExtension
# QML modules. Matched forms: library/framework/binding names (libQt6Quick3D*.so.*,
# Qt6Quick3D*.dll, QtQuick3D.framework, QtQuick3D.abi3.so), their QML URI directories
# (qml/QtQuick3D/..., qml/QtQuick/Timeline/..., qml/QtQuick/VirtualKeyboard/...,
# qml/QtWayland/Compositor/...) and two plugins outside those directories. Qt3D
# (Qt63D*, qml/Qt3D), QuickTest, WaylandClient and its client plugins/URI, WebEngine
# and the rest of QtQuick are deliberately not matched.
P2_LIBRARY_FAMILY = re.compile(r"^(lib)?Qt6?(Quick3D|QuickTimeline|VirtualKeyboard|WaylandCompositor)(?![a-z])")
P2_QML_URI_PAIRS = {("QtQuick", "Timeline"), ("QtQuick", "VirtualKeyboard"), ("QtWayland", "Compositor")}
P2_PLUGIN_NAME = re.compile(r"^(lib)?(qtvirtualkeyboardplugin|qmldbg_quick3dprofiler)\.(so|dll|dylib)$")
QT_WEBENGINE_CORE_NAME = re.compile(r"^(lib)?Qt6?WebEngineCore(?![A-Za-z])")


def _p2_family_path(path):
    parts = path.split("/")
    if any(P2_LIBRARY_FAMILY.match(part) for part in parts) or P2_PLUGIN_NAME.match(parts[-1]):
        return True
    return any(pair in P2_QML_URI_PAIRS for pair in zip(parts, parts[1:]))


def _has_sequence(paths, sequence):
    width = len(sequence)
    for path in paths:
        parts = path.split("/")
        if any(tuple(parts[i:i + width]) == sequence for i in range(len(parts) - width + 1)):
            return True
    return False


def test_frozen_bundle_excludes_quick3d_timeline_virtualkeyboard_and_waylandcompositor(canonical):
    bundle = canonical["bundle"]
    if bundle is None:
        pytest.fail("NOT REACHED: no canonical bundle was built")
    # Controls (not RED if they fail): the rule matches every family form and
    # leaves the retained neighbours alone.
    for path in ("libQt6Quick3DXr.so.6", "Qt6Quick3DSpatialAudio.dll", "QtQuick3DPhysics.framework/QtQuick3DPhysics",
                 "PySide6/QtQuick3D.abi3.so", "libQt6QuickTimelineBlendTrees.so.6", "Qt6VirtualKeyboardSettings.dll",
                 "libQt6WaylandCompositor.so.6", "PySide6/Qt/qml/QtQuick3D/SpatialAudio/qmldir",
                 "PySide6/qml/QtQuick/Timeline/BlendTrees/qtquicktimelineblendtreesplugin.dll",
                 "PySide6/Qt/qml/QtQuick/VirtualKeyboard/Styles/Builtin/libqtvkbbuiltinstylesplugin.so",
                 "PySide6/Qt/qml/QtWayland/Compositor/QtShell/libwaylandcompositorqtshellplugin.so",
                 "PySide6/Qt/qml/QtWayland/Compositor/TextureSharingExtension/libwaylandtexturesharingextensionplugin.so",
                 "PySide6/Qt/plugins/platforminputcontexts/libqtvirtualkeyboardplugin.so",
                 "PySide6/plugins/qmltooling/qmldbg_quick3dprofiler.dll"):
        if not _p2_family_path(path):
            pytest.fail(f"control failed (not RED): the P2 rule misses {path}")
    for path in ("libQt63DQuick.so.6", "libQt63DQuickScene3D.so.6", "Qt63DCore.dll", "PySide6/Qt/qml/Qt3D/Input/libquick3dinputplugin.so",
                 "libQt6QuickTest.so.6", "PySide6/qml/QtTest/quicktestplugin.dll", "libQt6WaylandClient.so.6",
                 "PySide6/Qt/qml/QtWayland/Client/TextureSharing/libwaylandtexturesharingplugin.so",
                 "PySide6/Qt/plugins/platforms/libqwayland.so", "PySide6/Qt/plugins/wayland-shell-integration/libxdg-shell.so",
                 "libQt6Quick.so.6", "QtQuick.framework/QtQuick", "PySide6/Qt/qml/QtQuick/Layouts/qmldir",
                 "Qt6WebEngineCore.dll", "QtGraphicalEffects", "PySide6/Qt/plugins/qmltooling/libqmldbg_quickprofiler.so"):
        if _p2_family_path(path):
            pytest.fail(f"control failed (not RED): the P2 rule wrongly matches {path}")
    root = bundle["root"]
    paths = [p.relative_to(root).as_posix() for p in sorted(root.rglob("*"))]
    parts = [part for path in paths for part in path.split("/")]
    if not any(QT_CORE_NAME.match(part) for part in parts):
        pytest.fail("control failed (not RED): no Qt Core library found, so the scan would be vacuous")
    if not any(QT_WEBENGINE_CORE_NAME.match(part) for part in parts):
        pytest.fail("control failed (not RED): no Qt WebEngine Core library found in the bundle")
    # Retained neighbours that the current Linux/Windows facts show in this bundle;
    # P2 must not remove them (asserted only where they were observed).
    if sys.platform in ("win32",) or sys.platform.startswith("linux"):
        assert _has_sequence(paths, ("qml", "Qt3D")), "retained Qt3D QML content is missing (not a family RED)"
        assert any(re.match(r"^(lib)?Qt6QuickTest(?![A-Za-z])", part) for part in parts), (
            "retained QuickTest library is missing (not a family RED)")
    if sys.platform.startswith("linux"):
        assert any(re.match(r"^libQt6WaylandClient(?![A-Za-z])", part) for part in parts), (
            "retained WaylandClient library is missing (not a family RED)")
        assert any(path.endswith("platforms/libqwayland.so") for path in paths), (
            "retained Wayland client platform plugin is missing (not a family RED)")
        assert _has_sequence(paths, ("QtWayland", "Client", "TextureSharing")), (
            "retained Wayland client TextureSharing QML module is missing (not a family RED)")
    found = [path for path in paths if _p2_family_path(path)]
    assert not found, (
        f"the bundle contains {len(found)} Qt Quick3D/QuickTimeline/VirtualKeyboard/WaylandCompositor paths, "
        f"e.g. {found[:20]}"
    )


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


# --- W1 characterization: the executable's PE import tables (measurement only) ----
#
# Approved as a tests-only measurement (c3r-c4-review-answer.md, C4_MINIMAL_PLAN).
# It records the ordinary and delay-load import DLL names of THIS job's own
# executable into the uploaded frozen/*.txt receipt. It asserts no expected names,
# is not a behavioural RED, and permits no DLL exclusion. An "error" entry is a
# diagnostic, never an empty table and never W1 evidence. Parser: pefile, which
# PyInstaller requires on win32. Only the inspected 2024.8.26 API is used
# (pefile.py 819-826, 3449-3457, 3688-3781, 5675-5782, 5872-5976).
W1_RECEIPT_NAME = "w1-executable-pe-imports.txt"
W1_PEFILE_VERSION = "2024.8.26"
W1_DIRECTORIES = {"ordinary": "IMAGE_DIRECTORY_ENTRY_IMPORT", "delayed": "IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT"}
W1_DELAY_DESCRIPTOR_SIZE = 32  # IMAGE_DELAYLOAD_DESCRIPTOR (PE/COFF); Size counts the zero terminator
# Real positive control: byte-bound in post-p2-delayed-imports/index.json.
W1_PDF_CONTROL = ("_internal/PySide6/Qt6Pdf.dll",
                  "5caf5744e017df85455c5c7e11028c5ec2765633a7ca64a11d7b64d127f6c4cc", ["WINMM.dll"])


def _w1_sha256(path):
    import hashlib

    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _w1_dll_names(items):
    """Exact DLL names in descriptor order, or None if any name is invalid."""
    names = []
    for item in items:
        dll = getattr(item, "dll", None)
        if not isinstance(dll, bytes) or not dll or dll == b"*invalid*":
            return None
        try:
            names.append(dll.decode("ascii"))
        except UnicodeDecodeError:
            return None
    return names


def _w1_measure(pefile, path, label):
    """One PE file's import tables, or an honest error with no lists (fail closed)."""
    result = {"path": label}
    try:
        result["bytes"] = Path(path).stat().st_size
        result["sha256"] = _w1_sha256(path)
    except OSError as exc:
        result["error"] = f"unreadable ({type(exc).__name__})"
        return result
    try:
        pe = pefile.PE(str(path), fast_load=True)
        with pe:
            indexes = {key: pefile.DIRECTORY_ENTRY[name] for key, name in W1_DIRECTORIES.items()}
            directories = {}
            for key, index in indexes.items():
                entry = pe.OPTIONAL_HEADER.DATA_DIRECTORY[index]
                directories[key] = {"rva": entry.VirtualAddress, "size": entry.Size}
            result["directories"] = directories
            before = len(pe.get_warnings())
            pe.parse_data_directories(directories=list(indexes.values()), import_dllnames_only=True)
            result["warnings_added"] = len(pe.get_warnings()) - before
            result["warnings_total"] = len(pe.get_warnings())
            if result["warnings_added"]:
                result["error"] = "parser-warning"
                return result
            lists = {}
            for key, name in W1_DIRECTORIES.items():
                rva, size = directories[key]["rva"], directories[key]["size"]
                if rva == 0:
                    if size != 0:
                        result["error"] = f"{key}: directory-size-without-address"
                        return result
                    lists[key] = []  # no such directory in the image
                    continue
                items = getattr(pe, name[len("IMAGE_"):], None)
                if not items:  # a non-zero directory yielded nothing: not proof of an empty table
                    result["error"] = f"{key}: unparsed-nonzero-directory"
                    return result
                if key == "delayed" and (size % W1_DELAY_DESCRIPTOR_SIZE
                                         or len(items) != size // W1_DELAY_DESCRIPTOR_SIZE - 1):
                    result["error"] = "delayed: delay-descriptor-count-mismatch"
                    return result
                names = _w1_dll_names(items)
                if names is None:
                    result["error"] = f"{key}: invalid-dll-name"
                    return result
                lists[key] = names
            result.update(lists)
    except Exception as exc:  # malformed input or parser failure: recorded, never a list
        result.pop("ordinary", None)
        result.pop("delayed", None)
        result["error"] = type(exc).__name__
    return result


def _w1_write(receipt, record):
    try:
        receipt.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except OSError as exc:
        pytest.fail(f"prerequisite failed (not RED): the measurement receipt was not written ({type(exc).__name__})")


@pytest.mark.skipif(sys.platform != "win32", reason="PE executable import measurement is Windows-only")
def test_windows_executable_import_measurement(canonical, tmp_path):
    out = _out()
    receipt = out / W1_RECEIPT_NAME
    record = {
        "scope": "W1 characterization of this frozen job's own executable bytes; not a behavioural RED, "
                 "not exclusion permission; error entries are diagnostics, not empty tables",
        "pyinstaller": _read(out / "pyinstaller-version.txt"),
        "pefile_required": W1_PEFILE_VERSION,
        "pefile": None,
    }
    bundle = canonical["bundle"]
    if bundle is None:
        record["error"] = "NOT REACHED: no canonical bundle was built"
        _w1_write(receipt, record)
        pytest.fail("NOT REACHED: no canonical bundle was built")
    problems = []
    try:
        import importlib.metadata

        record["pefile"] = importlib.metadata.version("pefile")
        import pefile
    except Exception as exc:
        problems.append(f"pefile is unavailable ({type(exc).__name__})")
    if not problems and record["pefile"] != W1_PEFILE_VERSION:
        problems.append(f"pefile {record['pefile']} is not the inspected {W1_PEFILE_VERSION}")
    if not problems:
        # Positive control: real, byte-verified Pdf DLL with its independently measured delay import.
        control_path, control_sha, control_delayed = W1_PDF_CONTROL
        control = _w1_measure(pefile, bundle["root"] / control_path, control_path)
        record["positive_control"] = control
        if control.get("sha256") != control_sha:
            problems.append(f"positive control bytes are not the verified Qt6Pdf.dll: {control.get('sha256')}")
        elif "error" in control or control.get("delayed") != control_delayed:
            problems.append(f"positive control did not reproduce {control_delayed}: {control!r}")
        # Negative control: a truncated copy of the actual executable must not yield lists.
        exe_bytes = bundle["exe"].read_bytes()
        truncated = tmp_path / "truncated-executable.exe"
        truncated.write_bytes(exe_bytes[:min(4096, len(exe_bytes) // 2)])
        negative = _w1_measure(pefile, truncated, "truncated copy of the executable")
        record["negative_control"] = negative
        if "error" not in negative or "ordinary" in negative or "delayed" in negative:
            problems.append(f"negative control admitted import lists: {negative!r}")
    if problems:
        record["prerequisite_errors"] = problems
        _w1_write(receipt, record)
        pytest.fail(f"prerequisite failed (not RED): {problems}")
    measurement = _w1_measure(pefile, bundle["exe"], bundle["exe"].relative_to(out).as_posix())
    record["executable"] = measurement
    _w1_write(receipt, record)
    if not receipt.is_file():
        pytest.fail("prerequisite failed (not RED): the measurement receipt is absent")
    if "error" in measurement:
        pytest.fail(f"measurement unavailable (not RED, not W1 evidence): {measurement['error']}")
    # Characterization only: the measured names are raw review inputs; none is asserted.


# --- W1 tests first: two Windows-only family absence cases (w1-plan-v2.md) ------
#
# Approved tests-only (c4-s2b1-w1-review-answer.md, W1_V2_PLAN); no spec removal is
# admitted. Exact basenames are copied from the real Windows facts unknown_origins
# (s2b1-green-628fe68d4872/qualification.json). Before either absence assertion
# can count, a module fixture measures EVERY bundled .exe/.dll/.pyd with
# _w1_measure. It re-runs its own parser, positive and negative controls, checks
# the real witnesses and file controls, and writes the closure receipt.
#   W1a: Windows API-set forwarders and ucrtbase. Remaining importers are recorded
#        and permitted only under the documented system resolution for the Qt 6.12
#        GUI's vendor floor, Windows 10 (1809+) and 11 x86_64. This is not a new CLI
#        support promise and not proof of arbitrary runtime LoadLibrary.
#   W1b: OpenSSL 3. No prospective remaining PE file may import either basename,
#        ordinary or delayed.
# Each family's prospective remaining set excludes only that family's own candidate
# paths, so a candidate-to-candidate edge (libssl-3 -> libcrypto-3) is never a
# remaining consumer.
W1_CLOSURE_RECEIPT_NAME = "w1-closure-pe-imports.txt"
W1_PE_SUFFIXES = (".exe", ".dll", ".pyd")
W1A_NAMES = (
    "api-ms-win-core-console-l1-1-0.dll", "api-ms-win-core-datetime-l1-1-0.dll",
    "api-ms-win-core-debug-l1-1-0.dll", "api-ms-win-core-errorhandling-l1-1-0.dll",
    "api-ms-win-core-fibers-l1-1-0.dll", "api-ms-win-core-fibers-l1-1-1.dll",
    "api-ms-win-core-file-l1-1-0.dll", "api-ms-win-core-file-l1-2-0.dll",
    "api-ms-win-core-file-l2-1-0.dll", "api-ms-win-core-handle-l1-1-0.dll",
    "api-ms-win-core-heap-l1-1-0.dll", "api-ms-win-core-interlocked-l1-1-0.dll",
    "api-ms-win-core-kernel32-legacy-l1-1-1.dll", "api-ms-win-core-libraryloader-l1-1-0.dll",
    "api-ms-win-core-localization-l1-2-0.dll", "api-ms-win-core-memory-l1-1-0.dll",
    "api-ms-win-core-namedpipe-l1-1-0.dll", "api-ms-win-core-processenvironment-l1-1-0.dll",
    "api-ms-win-core-processthreads-l1-1-0.dll", "api-ms-win-core-processthreads-l1-1-1.dll",
    "api-ms-win-core-profile-l1-1-0.dll", "api-ms-win-core-rtlsupport-l1-1-0.dll",
    "api-ms-win-core-string-l1-1-0.dll", "api-ms-win-core-synch-l1-1-0.dll",
    "api-ms-win-core-synch-l1-2-0.dll", "api-ms-win-core-sysinfo-l1-1-0.dll",
    "api-ms-win-core-sysinfo-l1-2-0.dll", "api-ms-win-core-timezone-l1-1-0.dll",
    "api-ms-win-core-util-l1-1-0.dll", "api-ms-win-crt-conio-l1-1-0.dll",
    "api-ms-win-crt-convert-l1-1-0.dll", "api-ms-win-crt-environment-l1-1-0.dll",
    "api-ms-win-crt-filesystem-l1-1-0.dll", "api-ms-win-crt-heap-l1-1-0.dll",
    "api-ms-win-crt-locale-l1-1-0.dll", "api-ms-win-crt-math-l1-1-0.dll",
    "api-ms-win-crt-private-l1-1-0.dll", "api-ms-win-crt-process-l1-1-0.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll", "api-ms-win-crt-stdio-l1-1-0.dll",
    "api-ms-win-crt-string-l1-1-0.dll", "api-ms-win-crt-time-l1-1-0.dll",
    "api-ms-win-crt-utility-l1-1-0.dll", "ucrtbase.dll",
)
W1B_NAMES = ("libcrypto-3-x64.dll", "libssl-3-x64.dll")
W1_FAMILIES = {"W1a": W1A_NAMES, "W1b": W1B_NAMES}
W1_FAMILY_LABELS = {"W1a": "Windows API-set/UCRT (W1a)", "W1b": "OpenSSL 3 (W1b)"}
# Real witnesses (non-vacuous coverage) and unweakened file controls, all observed
# at these exact paths in the current Windows facts.
W1_WITNESSES = ("_internal/python310.dll", "_internal/etebase/etebase_python.pyd",
                "_internal/PySide6/Qt6Core.dll", "_internal/PySide6/Qt6Pdf.dll",
                "_internal/PySide6/Qt6WebEngineCore.dll")
W1_KEPT_FILES = (
    "_internal/python310.dll", "_internal/libssl-1_1.dll", "_internal/libcrypto-1_1.dll",
    "_internal/VCRUNTIME140.dll", "_internal/VCRUNTIME140_1.dll", "_internal/PySide6/MSVCP140.dll",
    "_internal/PySide6/Qt6Core.dll", "_internal/PySide6/Qt6Network.dll",
    "_internal/PySide6/Qt6WebEngineCore.dll", "_internal/PySide6/Qt6Pdf.dll",
    "_internal/PySide6/plugins/tls/qcertonlybackend.dll",
    "_internal/PySide6/plugins/tls/qopensslbackend.dll",
    "_internal/PySide6/plugins/tls/qschannelbackend.dll",
)


def _w1_family_grouping_problems():
    problems = []
    lowered = [name.lower() for name in W1A_NAMES]
    if (len(W1A_NAMES) != 44 or len(set(lowered)) != 44 or "ucrtbase.dll" not in lowered
            or sum(name.startswith("api-ms-win-") for name in lowered) != 43):
        problems.append("W1a is not exactly 43 api-ms-win-* names plus ucrtbase.dll")
    if sorted(name.lower() for name in W1B_NAMES) != ["libcrypto-3-x64.dll", "libssl-3-x64.dll"]:
        problems.append("W1b is not exactly libssl-3-x64.dll and libcrypto-3-x64.dll")
    if set(lowered) & {name.lower() for name in W1B_NAMES}:
        problems.append("W1a and W1b overlap")
    return problems


def _w1_family_closure(measurements, family):
    """Present candidate paths, other same-named occurrences and remaining importers."""
    names = {name.lower() for name in W1_FAMILIES[family]}
    candidates = sorted(path for path in measurements
                        if path.lower() in {f"_internal/{name}" for name in names})
    others = sorted(path for path in measurements
                    if path not in candidates and path.rsplit("/", 1)[-1].lower() in names)
    importers = {}
    for path, entry in measurements.items():
        if path in candidates:  # proposed for removal with the family: not a remaining consumer
            continue
        for kind in ("ordinary", "delayed"):
            for imported in entry.get(kind, []):
                if imported.lower() in names:
                    importers.setdefault(imported, []).append({"importer": path, "kind": kind})
    return {"label": W1_FAMILY_LABELS[family], "expected_names": len(names), "present": candidates,
            "same_named_elsewhere": others, "remaining_importers": importers}


@pytest.fixture(scope="module")
def w1_closure(canonical, tmp_path_factory):
    """Full PE closure over the real bundle; its problems are prerequisites, never RED."""
    out = _out()
    receipt = out / W1_CLOSURE_RECEIPT_NAME
    record = {
        "scope": "W1 tests-first closure over this frozen job's own bundle bytes; not final-package proof, "
                 "not exclusion permission; error entries are diagnostics, not empty tables",
        "pyinstaller": _read(out / "pyinstaller-version.txt"),
        "pefile_required": W1_PEFILE_VERSION,
        "pefile": None,
    }
    problems = _w1_family_grouping_problems()
    bundle = canonical["bundle"]
    if bundle is None:
        problems.append("NOT REACHED: no canonical bundle was built")
        record["prerequisite_errors"] = problems
        _w1_write(receipt, record)
        return {"problems": problems, "families": {}}
    pefile = None
    try:
        import importlib.metadata

        record["pefile"] = importlib.metadata.version("pefile")
        import pefile
    except Exception as exc:
        problems.append(f"pefile is unavailable ({type(exc).__name__})")
        pefile = None
    if pefile is not None and record["pefile"] != W1_PEFILE_VERSION:
        problems.append(f"pefile {record['pefile']} is not the inspected {W1_PEFILE_VERSION}")
        pefile = None
    root = bundle["root"]
    exe_relative = bundle["exe"].relative_to(root).as_posix()
    families = {}
    if pefile is not None:
        # Controls repeated here, so they do not depend on the characterization case's order.
        control_path, control_sha, control_delayed = W1_PDF_CONTROL
        control = _w1_measure(pefile, root / control_path, control_path)
        record["positive_control"] = control
        if control.get("sha256") != control_sha:
            problems.append(f"positive control bytes are not the verified Qt6Pdf.dll: {control.get('sha256')}")
        elif "error" in control or control.get("delayed") != control_delayed:
            problems.append(f"positive control did not reproduce {control_delayed}: {control!r}")
        exe_bytes = bundle["exe"].read_bytes()
        truncated = tmp_path_factory.mktemp("w1-closure") / "truncated-executable.exe"
        truncated.write_bytes(exe_bytes[:min(4096, len(exe_bytes) // 2)])
        negative = _w1_measure(pefile, truncated, "truncated copy of the executable")
        record["negative_control"] = negative
        if "error" not in negative or "ordinary" in negative or "delayed" in negative:
            problems.append(f"negative control admitted import lists: {negative!r}")
        # Complete enumeration: every regular .exe/.dll/.pyd, suffix compared case-insensitively.
        enumerated = sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                            if p.is_file() and not p.is_symlink() and p.suffix.lower() in W1_PE_SUFFIXES)
        measurements = {path: _w1_measure(pefile, root / path, path) for path in enumerated}
        record["pe_files"] = len(enumerated)
        record["measurements"] = measurements
        errors = sorted(path for path, entry in measurements.items() if "error" in entry)
        if errors:
            problems.append(f"{len(errors)} bundled PE files could not be measured, e.g. "
                            f"{[(path, measurements[path]['error']) for path in errors[:10]]}")
        if set(measurements) != set(enumerated):
            problems.append("the closure does not cover every enumerated PE file")
        for witness in (exe_relative, *W1_WITNESSES):
            entry = measurements.get(witness)
            if entry is None or "error" in entry or not entry.get("ordinary"):
                problems.append(f"witness {witness} was not measured with ordinary imports: {entry!r}")
        for kept in W1_KEPT_FILES:
            if not (root / kept).is_file():
                problems.append(f"kept file control {kept} is missing")
        families = {family: _w1_family_closure(measurements, family) for family in W1_FAMILIES}
        record["families"] = families
        record["w1a_rule"] = ("remaining W1a importers are permitted only under documented system API-set/UCRT "
                              "resolution for the Qt 6.12 GUI floor, Windows 10 (1809+) and 11 x86_64")
    record["prerequisite_errors"] = problems
    _w1_write(receipt, record)  # the closure is recorded before any absence assertion
    if not receipt.is_file():
        problems.append("the closure receipt is absent")
    return {"problems": problems, "families": families}


def _w1_require_closure(closure, family):
    if closure["problems"]:
        pytest.fail(f"prerequisite failed (not RED): {closure['problems']}")
    info = closure["families"].get(family)
    if info is None:
        pytest.fail(f"prerequisite failed (not RED): no {family} closure was recorded")
    if family == "W1b" and info["remaining_importers"]:
        pytest.fail(f"closure failed (not RED): remaining PE files import OpenSSL 3: {info['remaining_importers']}")
    return info


@pytest.mark.skipif(sys.platform != "win32", reason="W1 families are Windows-only bundle files")
def test_windows_bundle_omits_w1a_api_set_and_ucrt_family(w1_closure):
    info = _w1_require_closure(w1_closure, "W1a")
    assert not info["present"], (
        f"{info['label']} family still bundled: {len(info['present'])} of {info['expected_names']} exact basenames "
        f"under _internal, e.g. {info['present'][:5]}")


@pytest.mark.skipif(sys.platform != "win32", reason="W1 families are Windows-only bundle files")
def test_windows_bundle_omits_w1b_openssl3_family(w1_closure):
    info = _w1_require_closure(w1_closure, "W1b")
    assert not info["present"], (
        f"{info['label']} family still bundled: {len(info['present'])} of {info['expected_names']} exact basenames "
        f"under _internal: {info['present']}")
