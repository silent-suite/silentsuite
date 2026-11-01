"""T1b legacy-gate fixture (#171): run the REAL desktop entrypoint per scenario.

Run as a child process by ``tests/test_desktop_migration.py``; never imported
by the Bridge. One scenario per process:

  no_legacy            nothing legacy present (control)
  desktop_only         only a DESKTOP start-at-login registration (control)
  busy_lock            the parent holds the instance lock (control)
  cli_cancel           CLI registration; the user cancels the migration prompt
  cli_confirm_clears   CLI registration; confirm; removal clears it
  cli_confirm_remains  CLI registration; confirm; it is still there afterwards
  port_cancel          a foreign listener owns the effective loopback port; cancel

What is real: the Qt application and every product window/dialog, the
product's gate and policy, the instance lock, the loopback listener (a real
bound socket for ``port_cancel``), and on Linux/macOS the CLI/desktop
registration FILES at the paths ``autostart`` already uses, inside the
parent's isolated HOME.

What is simulated (and only this):
- ``autostart.remove_autostart`` is replaced by a recorder that returns 0
  like the real one and, for ``cli_confirm_clears`` only, deletes the
  synthetic registration. No systemctl/launchctl/registry call is made.
- On Windows, reads of the HKCU ``...\\CurrentVersion\\Run`` key are served
  from a per-process table; every registry write or delete is trapped.
- Service-manager subprocesses (systemctl, launchctl, reg, schtasks) are
  trapped and recorded instead of run.

Native dialogs are answered through their real buttons: the migration prompt
(a QMessageBox whose text contains MIGRATION_PROMPT) gets its Accept/Yes or
Reject/No button per scenario; any other message box is acknowledged.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog.
"""

import argparse
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from pathlib import Path

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
WATCHDOG_SECONDS = 100
OBSERVE_INTERVAL_MS = 200
OUTCOME_DEADLINE_SECONDS = 60
STALL_CAPTURE_SECONDS = 20  # diagnostic snapshot, before the product's own 30 s dashboard deadline
BRAND = "SilentSuite Bridge"
MIGRATION_PROMPT = "Move to the desktop app"
CLI_RUN_VALUE = "SilentSuiteBridge"
DESKTOP_RUN_VALUE = "SilentSuiteBridgeDesktop"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
MANAGERS = {"systemctl", "launchctl", "reg", "reg.exe", "schtasks", "schtasks.exe"}
SCENARIOS = (
    "no_legacy", "desktop_only", "busy_lock",
    "cli_cancel", "cli_confirm_clears", "cli_confirm_remains", "port_cancel",
)


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _foreign_listener(port, recorder):
    """A real listener that owns 127.0.0.1:port and records any request."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            recorder.append(urllib.parse.urlsplit(self.path).path)
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    class Server(http.server.ThreadingHTTPServer):
        allow_reuse_address = False
        daemon_threads = True

        def server_bind(self):
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows: refuse any shared bind
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    server = Server(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, name="t1b-foreign", daemon=True)
    thread.start()
    return server, thread


def _install_service_manager_trap(traps, passthrough=None):
    def guard(original):
        def wrapper(*args, **kwargs):
            argv = args[0] if args else kwargs.get("args")
            first = argv[0] if isinstance(argv, (list, tuple)) and argv else argv
            if passthrough is not None and len(passthrough) < 50:
                # Diagnostic only: which subprocesses ran, from which thread.
                passthrough.append(f"{threading.current_thread().name}:{os.path.basename(str(first))}")
            if isinstance(first, str) and os.path.basename(first).lower() in MANAGERS:
                traps.append(os.path.basename(first).lower())
                raise PermissionError("T1b fixture: service-manager call trapped")
            return original(*args, **kwargs)
        return wrapper

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        setattr(subprocess, name, guard(getattr(subprocess, name)))


def _install_windows_run_key(values, traps):
    """Serve HKCU Run-key reads from ``values``; trap every registry mutation."""
    import winreg

    class _SimRunKey:
        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def Close(self):  # noqa: N802 - mirrors PyHKEY
            pass

    real = {name: getattr(winreg, name) for name in ("OpenKey", "OpenKeyEx", "QueryValueEx", "CloseKey")}

    def open_key(key, sub_key, *args, **kwargs):
        if key == winreg.HKEY_CURRENT_USER and str(sub_key).lower() == RUN_KEY.lower():
            access = kwargs.get("access", args[1] if len(args) > 1 else winreg.KEY_READ)
            if access & winreg.KEY_SET_VALUE:
                traps.append("registry-write-open")
                raise PermissionError("T1b fixture: Run-key write access trapped")
            return _SimRunKey()
        return real["OpenKey"](key, sub_key, *args, **kwargs)

    def open_key_ex(key, sub_key, *args, **kwargs):
        return open_key(key, sub_key, *args, **kwargs)

    def query_value_ex(key, name):
        if isinstance(key, _SimRunKey):
            if name in values:
                return values[name], winreg.REG_SZ
            raise FileNotFoundError(2, "T1b fixture: simulated value not present")
        return real["QueryValueEx"](key, name)

    def close_key(key):
        if isinstance(key, _SimRunKey):
            return None
        return real["CloseKey"](key)

    def mutation(name):
        def trapped(*_args, **_kwargs):
            traps.append("registry-" + name)
            raise PermissionError("T1b fixture: registry mutation trapped")
        return trapped

    winreg.OpenKey = open_key
    winreg.OpenKeyEx = open_key_ex
    winreg.QueryValueEx = query_value_ex
    winreg.CloseKey = close_key
    for name in ("SetValue", "SetValueEx", "DeleteValue", "DeleteKey", "DeleteKeyEx", "CreateKey", "CreateKeyEx"):
        if hasattr(winreg, name):
            setattr(winreg, name, mutation(name))


def run(out: Path, scenario: str) -> int:
    result = {"scenario": scenario, "stage": "prereq", "prereq": {}, "entry_error": None}
    _write(out, result)

    def watchdog():
        result["stage"] = result["stage"] + ":fixture-watchdog"
        _write(out, result)
        os._exit(EXIT_WATCHDOG)  # fixture-only

    timer = threading.Timer(WATCHDOG_SECONDS, watchdog)
    timer.daemon = True
    timer.start()

    try:
        from PySide6.QtCore import QCoreApplication, Qt, QTimer
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication, QMessageBox
    except Exception as exc:  # noqa: BLE001
        result["prereq"]["import_error"] = type(exc).__name__
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import autostart, config
    from silentsuite_bridge.radicale.server import get_registry

    traps = []
    subprocess_calls = []  # diagnostic only
    _install_service_manager_trap(traps, subprocess_calls)

    # --- scenario setup -------------------------------------------------
    cli_registration = scenario.startswith("cli_")
    windows = sys.platform == "win32"
    run_values = {}
    registration_path = None
    if windows:
        if cli_registration:
            run_values[CLI_RUN_VALUE] = '"C:\\synthetic\\silentsuite-bridge.exe"'
        if scenario == "desktop_only":
            run_values[DESKTOP_RUN_VALUE] = '"C:\\synthetic\\SilentSuite Bridge.exe" --background'
        _install_windows_run_key(run_values, traps)
    else:
        home = os.environ.get("HOME", "")
        if not home or os.path.expanduser("~") != home or "t1b" not in home:
            result["prereq"]["isolated_home"] = False
            _write(out, result)
            timer.cancel()
            return EXIT_PREREQ  # never write registrations outside the isolated HOME
        result["prereq"]["isolated_home"] = True
        if sys.platform == "darwin":
            cli_path = autostart._launchd_plist_path()
            desktop_path = os.path.join(home, "Library", "LaunchAgents", "io.silentsuite.bridge.desktop.plist")
        else:
            cli_path = autostart._systemd_service_path()
            desktop_path = os.path.join(home, ".config", "autostart", "silentsuite-bridge-desktop.desktop")
        if cli_registration:
            registration_path = cli_path
        elif scenario == "desktop_only":
            registration_path = desktop_path
        if registration_path:
            os.makedirs(os.path.dirname(registration_path), exist_ok=True)
            with open(registration_path, "w", encoding="utf-8") as handle:
                handle.write("# synthetic T1b registration\n")

    def registration_present():
        if windows:
            name = DESKTOP_RUN_VALUE if scenario == "desktop_only" else CLI_RUN_VALUE
            return name in run_values
        return bool(registration_path) and os.path.exists(registration_path)

    removals = []

    def recorded_remove_autostart():
        removals.append(scenario)
        if scenario == "cli_confirm_clears":
            if windows:
                run_values.pop(CLI_RUN_VALUE, None)
            elif registration_path and os.path.exists(registration_path):
                os.remove(registration_path)
        return 0  # the real function's success code

    autostart.remove_autostart = recorded_remove_autostart

    def trapped_install(*_args, **_kwargs):
        traps.append("install_autostart")
        raise PermissionError("T1b fixture: install_autostart trapped")

    autostart.install_autostart = trapped_install

    foreign_requests = []
    foreign = None
    if scenario == "port_cancel":
        foreign, _ = _foreign_listener(config.LISTEN_PORT, foreign_requests)
        result["prereq"]["foreign_listener_bound"] = True

    # --- observer -------------------------------------------------------
    observed = {"prompts": [], "other_dialogs": [], "dashboard_shown": False, "requested_url": None,
                "registry_dashboard_url": None, "deadline_missed": False}
    started = time.monotonic()
    answer_accept = scenario in ("cli_confirm_clears", "cli_confirm_remains")
    accept_roles = (QMessageBox.ButtonRole.AcceptRole, QMessageBox.ButtonRole.YesRole)
    reject_roles = (QMessageBox.ButtonRole.RejectRole, QMessageBox.ButtonRole.NoRole)

    def click_role(box, roles):
        for button in box.buttons():
            if box.buttonRole(button) in roles:
                button.click()
                return True
        return False

    def record_diagnostics():
        # Diagnostic only, never asserted: registry progress, and one bounded
        # stack snapshot of every thread if no dashboard appeared in time.
        registry = get_registry()
        elapsed = round(time.monotonic() - started, 1)
        snapshot = {
            "t": elapsed,
            "started": registry.is_started,
            "stopped": registry.is_stopped,
            "bound": len(registry.bound_listeners()),
            "failed": registry.failed_count(),
        }
        observed["last_registry"] = snapshot
        if snapshot["bound"] and "first_bound_seconds" not in observed:
            observed["first_bound_seconds"] = elapsed
        if (
            elapsed >= STALL_CAPTURE_SECONDS
            and not observed["dashboard_shown"]
            and "stall_stacks" not in observed
        ):
            names = {thread.ident: thread.name for thread in threading.enumerate()}
            stacks = {}
            for ident, frame in sys._current_frames().items():
                frames = traceback.extract_stack(frame)[-10:]
                stacks[names.get(ident, str(ident))] = [
                    f"{os.path.basename(f.filename)}:{f.lineno}:{f.name}" for f in frames
                ]
            observed["stall_stacks"] = stacks

    def observe():
        record_diagnostics()
        for widget in QApplication.topLevelWidgets():
            if not widget.isVisible():
                continue
            if isinstance(widget, QMessageBox):
                text = (widget.text() or "") + "\n" + (widget.informativeText() or "")
                if MIGRATION_PROMPT in text:
                    observed["prompts"].append(text[:300])
                    answered = click_role(widget, accept_roles if answer_accept else reject_roles)
                    observed.setdefault("prompt_answered", []).append(answered)
                else:
                    observed["other_dialogs"].append(text[:300])
                    if not click_role(widget, accept_roles + reject_roles):
                        widget.close()
                return
            views = [widget] if isinstance(widget, QWebEngineView) else widget.findChildren(QWebEngineView)
            if views:
                view = views[0]
                dashboard = get_registry().dashboard_url(False)
                getter = getattr(view.page(), "requestedUrl", None)
                requested = getter().toString() if getter is not None else None
                if dashboard and requested == dashboard and view.title() == BRAND:
                    observed.update({"dashboard_shown": True, "requested_url": requested,
                                     "registry_dashboard_url": dashboard})
                    widget.close()  # a normal user close; start-at-login is off
                    return
        if time.monotonic() - started > OUTCOME_DEADLINE_SECONDS:
            observed["deadline_missed"] = True
            for widget in QApplication.topLevelWidgets():
                widget.close()

    poll = QTimer()
    poll.setInterval(OBSERVE_INTERVAL_MS)
    poll.timeout.connect(observe)
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

    # --- after main -----------------------------------------------------
    registry = get_registry()
    lock_path = os.path.join(config.DATA_DIR, "instance.lock")
    lock_free = None
    if scenario != "busy_lock":  # the parent still holds it in that scenario
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            lock_free = bool(config._try_lock_fd(fd))
            if lock_free:
                config._unlock_fd(fd)
        finally:
            os.close(fd)
    if foreign is not None:
        foreign.shutdown()
        foreign.server_close()

    result.update({
        "stage": "done",
        "exit_code": exit_code,
        "observed": observed,
        "removal_calls": len(removals),
        "registration_present_after": registration_present(),
        # Never-started registry: neither started nor stopped. Any serving
        # attempt (bind, failure, stop) leaves a mark.
        "serving_attempted": bool(registry.is_started or registry.is_stopped),
        "lock_free_after": lock_free,
        "foreign_requests": list(foreign_requests),
        "service_manager_traps": traps,
        "diagnostics": {  # never asserted
            "subprocess_calls": subprocess_calls,
            "seconds_in_main": round(time.monotonic() - started, 1),
        },
    })
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T1b legacy-gate fixture (non-product)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--scenario", required=True, choices=SCENARIOS)
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    return run(out, args.scenario)


if __name__ == "__main__":
    sys.exit(main())
