"""T4 desktop start-at-login fixture (#171): the real settings API of a real desktop owner.

One scenario per child process:

  source     launched from this source checkout (not frozen)
  offpath    a SIMULATED frozen app whose executable sits in a download folder
  installed  a SIMULATED frozen app at the platform's stable installed root

The simulated identity sets ``sys.frozen = True`` and ``sys.executable`` to an
inert, never-executed file BEFORE any product import. It is not a frozen or
installed build. The installed roots follow implementation-plan-v2 sections 5
and 7: Linux /opt/silentsuite-bridge (the CI step creates the empty inert file),
macOS ~/Applications/SilentSuite Bridge.app/... inside the isolated HOME,
Windows %LOCALAPPDATA%\\Programs\\SilentSuite Bridge\\... with LOCALAPPDATA
pointed at a fixture directory by the parent.

The REAL ``main(flavor="desktop")`` runs to its own registry-confirmed
dashboard. A worker thread then uses that dashboard's real HTTP settings API
(loopback Host, CSRF token read from the served page):
GET settings, add a synthetic CLI start-at-login entry (after owner startup),
POST startAtLogin true, GET, POST false, GET, snapshotting registrations after
each step. Then the window is closed normally.

Simulated boundaries (and only these):
- Windows: the HKCU ...\\CurrentVersion\\Run key is a complete in-process
  table for reads AND writes; any write to another key is trapped.
- Service managers (systemctl, launchctl, reg, schtasks) are trapped and
  recorded, never run; any subprocess start of the simulated executable, or
  os.startfile, is recorded and refused.
POSIX registrations are real files inside the isolated HOME.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migration_probe  # noqa: E402 - reuse the service-manager trap read-only

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
WATCHDOG_SECONDS = 150
BRAND = "SilentSuite Bridge"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
CLI_RUN_VALUE = "SilentSuiteBridge"
DESKTOP_RUN_VALUE = "SilentSuiteBridgeDesktop"
CSRF_PATTERN = re.compile(r"SILENTSUITE_DASHBOARD_CSRF\s*=\s*(\"[^\"]*\")")


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _install_windows_run_table(table, writes, traps):
    """A complete simulated HKCU Run key (reads and writes); other writes trapped."""
    import winreg

    class _SimRunKey:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def Close(self):  # noqa: N802 - mirrors PyHKEY
            pass

    real = {name: getattr(winreg, name) for name in ("OpenKey", "OpenKeyEx", "QueryValueEx", "CloseKey")}

    def is_run(key, sub_key):
        return key == winreg.HKEY_CURRENT_USER and str(sub_key).lower() == RUN_KEY.lower()

    def open_key(key, sub_key, *args, **kwargs):
        if is_run(key, sub_key):
            return _SimRunKey()
        return real["OpenKey"](key, sub_key, *args, **kwargs)

    def create_key(key, sub_key, *args, **kwargs):
        if is_run(key, sub_key):
            return _SimRunKey()
        traps.append("registry-create-other")
        raise PermissionError("T4 fixture: registry create outside the Run key trapped")

    def query_value_ex(key, name):
        if isinstance(key, _SimRunKey):
            if name in table:
                return table[name], winreg.REG_SZ
            raise FileNotFoundError(2, "T4 fixture: simulated value not present")
        return real["QueryValueEx"](key, name)

    def set_value_ex(key, name, reserved, value_type, value):
        if not isinstance(key, _SimRunKey):
            traps.append("registry-write-other")
            raise PermissionError("T4 fixture: registry write outside the Run key trapped")
        table[name] = value
        writes.append(("set", name))

    def delete_value(key, name):
        if not isinstance(key, _SimRunKey):
            traps.append("registry-delete-other")
            raise PermissionError("T4 fixture: registry delete outside the Run key trapped")
        if name not in table:
            raise FileNotFoundError(2, "T4 fixture: simulated value not present")
        del table[name]
        writes.append(("delete", name))

    def close_key(key):
        if isinstance(key, _SimRunKey):
            return None
        return real["CloseKey"](key)

    def trapped(name):
        def refuse(*_args, **_kwargs):
            traps.append("registry-" + name)
            raise PermissionError("T4 fixture: registry operation trapped")
        return refuse

    winreg.OpenKey = open_key
    winreg.OpenKeyEx = open_key
    winreg.CreateKey = create_key
    winreg.CreateKeyEx = create_key
    winreg.QueryValueEx = query_value_ex
    winreg.SetValueEx = set_value_ex
    winreg.DeleteValue = delete_value
    winreg.CloseKey = close_key
    for name in ("SetValue", "DeleteKey", "DeleteKeyEx"):
        if hasattr(winreg, name):
            setattr(winreg, name, trapped(name))


def _install_launch_trap(executable, launches):
    """Record and refuse any attempt to start the simulated executable."""
    target = os.path.normcase(os.path.realpath(executable)) if executable else None

    def guard(original):
        def wrapper(*args, **kwargs):
            argv = args[0] if args else kwargs.get("args")
            first = argv[0] if isinstance(argv, (list, tuple)) and argv else argv
            if target and isinstance(first, str) and os.path.normcase(os.path.realpath(first)) == target:
                launches.append("subprocess")
                raise PermissionError("T4 fixture: launching the simulated app is refused")
            return original(*args, **kwargs)
        return wrapper

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        setattr(subprocess, name, guard(getattr(subprocess, name)))
    if hasattr(os, "startfile"):
        def refuse_startfile(*_args, **_kwargs):
            launches.append("startfile")
            raise PermissionError("T4 fixture: os.startfile refused")
        os.startfile = refuse_startfile


def _file_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return None


def _digest(path):
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def run(args) -> int:
    out = Path(args.out)
    result = {"scenario": args.scenario, "stage": "prereq", "prereq": {}, "entry_error": None, "steps": {}}
    _write(out, result)

    def watchdog():
        result["stage"] = str(result["stage"]) + ":fixture-watchdog"
        _write(out, result)
        os._exit(EXIT_WATCHDOG)  # fixture-only

    timer = threading.Timer(WATCHDOG_SECONDS, watchdog)
    timer.daemon = True
    timer.start()

    try:
        from PySide6.QtCore import QCoreApplication, Qt, QTimer
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication
    except Exception as exc:  # noqa: BLE001
        result["prereq"]["import_error"] = type(exc).__name__
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    home = os.environ.get("HOME", "")
    if sys.platform != "win32" and (not home or os.path.expanduser("~") != home or "t4auto" not in home):
        result["prereq"]["isolated_home"] = False
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    executable = args.executable or None
    if executable:
        if sys.platform.startswith("linux") and args.scenario == "installed":
            # Created by the CI step; never created or run here. It must look
            # like a plausible executable: a regular, non-symlink, empty file
            # with the execute bit, owned by this user.
            try:
                st = os.lstat(executable)
                plausible = (
                    stat.S_ISREG(st.st_mode)
                    and st.st_size == 0
                    and st.st_uid == os.getuid()
                    and os.access(executable, os.X_OK)
                )
            except OSError:
                plausible = False
            if not plausible:
                result["prereq"]["installed_fixture"] = False
                _write(out, result)
                timer.cancel()
                return EXIT_PREREQ
        else:
            os.makedirs(os.path.dirname(executable), exist_ok=True)
            if not os.path.exists(executable):
                with open(executable, "wb"):
                    pass  # empty and inert; never executed
            if sys.platform != "win32":
                os.chmod(executable, 0o755)  # a plausible executable identity; still never run
            result["prereq"]["simulated_executable_x_ok"] = (
                sys.platform == "win32" or os.access(executable, os.X_OK)
            )
        # SIMULATED frozen identity, before any product import.
        sys.frozen = True
        sys.executable = executable
    result["simulated_identity"] = executable

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    traps, passthrough, launches, run_writes = [], [], [], []
    run_table = {}
    migration_probe._install_service_manager_trap(traps, passthrough)
    _install_launch_trap(executable, launches)
    if sys.platform == "win32":
        _install_windows_run_table(run_table, run_writes, traps)

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import autostart, config
    from silentsuite_bridge.radicale.server import get_registry

    if sys.platform == "darwin":
        cli_path = autostart._launchd_plist_path()
        desktop_path = os.path.join(home, "Library", "LaunchAgents", "io.silentsuite.bridge.desktop.plist")
    elif sys.platform != "win32":
        cli_path = autostart._systemd_service_path()
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        desktop_path = os.path.join(xdg, "autostart", "silentsuite-bridge-desktop.desktop")
    else:
        cli_path = desktop_path = None

    def add_cli_registration():
        if sys.platform == "win32":
            run_table[CLI_RUN_VALUE] = '"C:\\synthetic\\silentsuite-bridge.exe"'
            return
        os.makedirs(os.path.dirname(cli_path), exist_ok=True)
        Path(cli_path).write_text("# synthetic CLI registration added after owner startup\n", encoding="utf-8")

    def snapshot():
        if sys.platform == "win32":
            return {
                "desktop": run_table.get(DESKTOP_RUN_VALUE),
                "cli": run_table.get(CLI_RUN_VALUE),
                "values": sorted(run_table),
            }
        # Only the start-at-login locations, so unrelated Qt or font caches in
        # HOME cannot look like a stray registration.
        files = []
        for rel in (".config/autostart", ".config/systemd", "Library/LaunchAgents"):
            directory = Path(home) / rel
            if directory.is_dir():
                files.extend(p.relative_to(home).as_posix() for p in directory.rglob("*") if p.is_file())
        return {"desktop": _file_text(desktop_path), "cli": _digest(cli_path), "home_files": sorted(files)[:50]}

    def http(base, method, path, csrf=None, body=None):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", "application/json")
        if csrf:
            request.add_header("X-SilentSuite-CSRF", csrf)
        try:
            with opener.open(request, timeout=15) as response:
                raw = response.read()
                status = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            status = exc.code
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {"non_json_length": len(raw)}

    steps = result["steps"]
    state = {"phase": "wait", "started": time.monotonic(), "window": None}

    def drive(base):
        try:
            page = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base + "/.web", timeout=15).read()
            match = CSRF_PATTERN.search(page.decode("utf-8", "replace"))
            csrf = json.loads(match.group(1)) if match else None
            steps["csrf_found"] = bool(csrf)
            steps["get_before"] = http(base, "GET", "/.web/api/settings")
            # Positive admission control: POST the existing setting back with its
            # current value through the same Host and CSRF gates. It only rewrites
            # the same value into this synthetic DATA_DIR's settings.json.
            current_interval = steps["get_before"][1].get("syncInterval")
            steps["admission_interval"] = current_interval
            if isinstance(current_interval, int):
                steps["admission_post"] = http(
                    base, "POST", "/.web/api/settings", csrf, {"syncInterval": current_interval},
                )
            add_cli_registration()
            steps["registrations_before"] = snapshot()
            steps["post_enable"] = http(base, "POST", "/.web/api/settings", csrf, {"startAtLogin": True})
            steps["registrations_after_enable"] = snapshot()
            steps["get_after_enable"] = http(base, "GET", "/.web/api/settings")
            steps["post_disable"] = http(base, "POST", "/.web/api/settings", csrf, {"startAtLogin": False})
            steps["registrations_after_disable"] = snapshot()
            steps["get_after_disable"] = http(base, "GET", "/.web/api/settings")
        except Exception as exc:  # noqa: BLE001 - reported as a fixture failure, never as a result
            steps["driver_error"] = type(exc).__name__
        finally:
            state["phase"] = "driven"

    def tick():
        if state["phase"] == "wait":
            if time.monotonic() - state["started"] > 60:
                result["window_deadline_missed"] = True
                state["phase"] = "closing"
                for widget in QApplication.topLevelWidgets():
                    widget.close()
                return
            dashboard = get_registry().dashboard_url(False)
            for widget in QApplication.topLevelWidgets():
                if not widget.isVisible():
                    continue
                views = [widget] if isinstance(widget, QWebEngineView) else widget.findChildren(QWebEngineView)
                if not views:
                    continue
                getter = getattr(views[0].page(), "requestedUrl", None)
                requested = getter().toString() if getter is not None else None
                if dashboard and requested == dashboard and views[0].title() == BRAND:
                    result["dashboard_url"] = dashboard
                    state.update({"phase": "driving", "window": widget})
                    threading.Thread(target=drive, args=(dashboard.rstrip("/"),), daemon=True).start()
                return
        elif state["phase"] == "driven":
            state["phase"] = "closing"
            state["window"].close()  # normal close

    poll = QTimer()
    poll.setInterval(100)
    poll.timeout.connect(tick)
    poll.start()

    sys.argv = ["silentsuite-bridge"]
    exit_code = None
    result["stage"] = "entrypoint"
    _write(out, result)
    try:
        bridge_main.main(flavor="desktop")
    except SystemExit as exc:
        exit_code = exc.code
    except Exception as exc:  # noqa: BLE001
        frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)][-6:]
        result["entry_error"] = {"class": type(exc).__name__, "frames": frames}
    poll.stop()

    fd = os.open(os.path.join(config.DATA_DIR, "instance.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        lock_free = bool(config._try_lock_fd(fd))
        if lock_free:
            config._unlock_fd(fd)
    finally:
        os.close(fd)
    result.update({
        "stage": "done",
        "exit_code": exit_code,
        "lock_free_after": lock_free,
        "registry_stopped_after": get_registry().is_stopped,
        "service_manager_traps": traps,
        "launch_attempts": launches,
        "run_key_writes": run_writes,
        "desktop_registration_path": desktop_path,
    })
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T4 desktop start-at-login fixture (non-product)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--scenario", required=True, choices=["source", "offpath", "installed"])
    parser.add_argument("--executable", default="")
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
