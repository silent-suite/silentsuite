"""T2 lifecycle fixture (#171): close, background start, reopen and Quit, in real processes.

Roles (one per process; the parent test drives them):

  owner   runs the REAL main(flavor="desktop"), plus "--background" when asked.
          It writes ready.json once its own registry has bound the dashboard
          (foreground: once the dashboard window is visible; background: after
          a fixed settle time, whatever is on screen). Then, driven by files in
          --control:
            close           an ACTUAL close of the dashboard window:
                            QWidget.close() delivers a real QCloseEvent to the
                            product's window. This probe never calls hide().
                            closed.json reports the state 1.5 s later, unless
                            the process has already stopped.
            second.started  watch for the dashboard window to be visible, then
                            write shown.ack.
            quit            with --quit-via-action: trigger the native QAction
                            whose text is exactly "Quit SilentSuite Bridge", on
                            this (the owner's main) thread. Without such an
                            action, or without the flag, the fixture ends the
                            event loop itself and records that it did; that is
                            teardown, never evidence of a product Quit.
            abort           fixture teardown after an early parent exit.
  second  runs the REAL main(flavor="desktop") for the same DATA_DIR and
          records what it did: dialogs, web views, serving, legacy-gate reads,
          bytes written to the owner's endpoint.

Owner witnesses:
- every Show/Hide of a top-level widget, with wall-clock time (bounded list);
- a snapshot taken inside the instance-lock context just before the lock is
  released: server thread, registry, IPC listening state, endpoint file and
  the synthetic worker; plus the order of IPC close and lock release, from
  delegating observers on OwnerIpc.close and instance_ownership;
- os.kill is recorded and refused; os._exit writes the result first and then
  exits with code 4, so a product os._exit is visible as such.

Simulated boundaries (and only these):
- "start-at-login on" is a fixture input. Only the DESKTOP entry is
  precreated, before the product starts: a file in the isolated HOME, or a
  value in a simulated read-only HKCU Run table on Windows. The content comes
  from the product's own desktop_autostart label and renderers, used
  read-only; the executable it names is text only, never created or run.
- service managers are trapped (migration_probe), and so is any Windows
  Run-key write.
- no account exists, so one synthetic worker thread is registered in the real
  worker table to observe that stopping the Bridge stops workers. It is not a
  real sync worker.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog,
4 the product called os._exit (result written first).
"""

import argparse
import contextlib
import gc
import hashlib
import os
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ipc_probe  # noqa: E402 - reuse its socket observer, call counters and endpoint facts read-only
import migration_probe  # noqa: E402 - reuse its service-manager trap and Windows Run table read-only

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
EXIT_OS_EXIT = 4
WATCHDOG_SECONDS = 240
TICK_MS = 100
BRAND = "SilentSuite Bridge"
QUIT_TEXT = "Quit SilentSuite Bridge"
SERVER_THREAD = "silentsuite-bridge-server"
SYNTHETIC_USER = "synthetic-worker@t2-lifecycle.invalid"
BACKGROUND_SETTLE_SECONDS = 3.0
CLOSE_SETTLE_SECONDS = 1.5
QUIT_STOP_SECONDS = 15.0
HISTORY_CAP = 200
# Text only: named in the precreated entry, never created or executed.
SYNTHETIC_EXECUTABLE = {
    "win32": r"C:\synthetic\SilentSuite Bridge\SilentSuite Bridge.exe",
    "darwin": "/Applications/SilentSuite Bridge.app/Contents/MacOS/SilentSuite Bridge",
}.get(sys.platform, "/opt/silentsuite-bridge/silentsuite-bridge-desktop")

_real_exit = os._exit


def _write(path, payload) -> None:
    ipc_probe._write(Path(path), payload)


def _watchdog(out, result):
    def fire():
        result["stage"] = str(result.get("stage")) + ":fixture-watchdog"
        _write(out, result)
        _real_exit(EXIT_WATCHDOG)  # fixture-only

    timer = threading.Timer(WATCHDOG_SECONDS, fire)
    timer.daemon = True
    timer.start()
    return timer


def _isolated_home_ok():
    if sys.platform == "win32":
        return True
    home = os.environ.get("HOME", "")
    return bool(home) and os.path.expanduser("~") == home and "t2life" in home


def _plain(text):
    """Action text without mnemonic markers ("&Quit" reads "Quit"; "&&" is a literal "&")."""
    return (text or "").replace("&&", "\0").replace("&", "").replace("\0", "&")


# --- start-at-login fixture input ------------------------------------------


def _desktop_entry_path():
    from silentsuite_bridge import desktop_autostart

    if sys.platform == "win32":
        return None
    if sys.platform == "darwin":
        return desktop_autostart._launchd_plist_path()
    return desktop_autostart._xdg_entry_path()


def _precreate_desktop_entry(path, run_values):
    """Only the desktop entry, rendered by the product's own helpers (read-only use)."""
    from silentsuite_bridge import autostart, desktop_autostart

    if sys.platform == "win32":
        run_values[desktop_autostart.DESKTOP_RUN_VALUE] = autostart.render_windows_command(
            [SYNTHETIC_EXECUTABLE, desktop_autostart.BACKGROUND_ARG],
        )
        return
    if sys.platform == "darwin":
        data = desktop_autostart.render_launchd_plist(SYNTHETIC_EXECUTABLE)
    else:
        data = desktop_autostart.render_xdg_entry(SYNTHETIC_EXECUTABLE).encode("utf-8")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Path(path).write_bytes(data)


def _registration_state(path, run_values):
    if sys.platform == "win32":
        from silentsuite_bridge import desktop_autostart

        return run_values.get(desktop_autostart.DESKTOP_RUN_VALUE)
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


# --- synthetic worker (no account exists) ----------------------------------


class _SyntheticWorker(threading.Thread):
    """Fixture-only stand-in in the real worker table; stops when asked."""

    def __init__(self):
        super().__init__(name="t2-lifecycle-synthetic-worker", daemon=True)
        self._stop_sync = threading.Event()
        self.stop_calls = 0

    def stop(self):
        self.stop_calls += 1
        self._stop_sync.set()

    def run(self):
        self._stop_sync.wait(WATCHDOG_SECONDS)


def _register_synthetic_worker(storage):
    worker = _SyntheticWorker()
    worker.start()
    with storage._sync_threads_lock:
        storage._sync_threads[SYNTHETIC_USER] = worker
    return worker


# --- roles -----------------------------------------------------------------


def run(args) -> int:
    out = Path(args.out)
    control = Path(args.control) if args.control else None
    result = {"role": args.role, "stage": "prereq", "prereq": {}, "entry_error": None}
    _write(out, result)
    timer = _watchdog(out, result)

    try:
        from PySide6.QtCore import QCoreApplication, QEvent, QObject, Qt, QTimer, QUrl, Slot
        from PySide6.QtGui import QAction, QDesktopServices
        from PySide6.QtNetwork import QLocalServer
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import (
            QApplication,
            QDialog,
            QMenu,
            QMenuBar,
            QMessageBox,
            QSystemTrayIcon,
            QWidget,
        )
    except Exception as exc:  # noqa: BLE001
        result["prereq"]["import_error"] = type(exc).__name__
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    if not _isolated_home_ok():
        result["prereq"]["isolated_home"] = False
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    client_socket = {"connects": 0, "writes_hex": [], "write_bytes": 0, "read_attempts": 0, "read_methods": []}
    if args.role == "second":
        # Before any product import, so the product's QLocalSocket is the observed one.
        ipc_probe._install_client_socket_observer(client_socket)

    traps, kills, run_values = [], [], {}
    migration_probe._install_service_manager_trap(traps)
    if sys.platform == "win32":
        # Read-only simulated HKCU Run table; any write access is trapped.
        migration_probe._install_windows_run_key(run_values, traps)

    def refuse_kill(pid, sig):
        kills.append({"own_pid": pid == os.getpid(), "signal": int(sig)})
        raise PermissionError("T2 lifecycle fixture: os.kill refused")

    os.kill = refuse_kill

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import autostart, config, desktop_ipc, instance
    from silentsuite_bridge.radicale import storage
    from silentsuite_bridge.radicale.server import get_registry

    removals = []

    def recorded_remove_autostart():
        removals.append(args.role)
        return 0

    autostart.remove_autostart = recorded_remove_autostart

    external = []

    class _ExternalTrap(QObject):
        @Slot(QUrl)
        def handle(self, url):
            external.append(url.scheme())

    external_trap = _ExternalTrap()
    for scheme in ("http", "https", "file"):
        QDesktopServices.setUrlHandler(scheme, external_trap, "handle")

    def run_main(argv):
        sys.argv = argv
        exit_code = None
        result["stage"] = "entrypoint"
        _write(out, result)
        try:
            bridge_main.main(flavor="desktop")
        except SystemExit as exc:
            exit_code = exc.code
        except Exception as exc:  # noqa: BLE001
            frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)]
            result["entry_error"] = {"class": type(exc).__name__, "frames": frames[-6:]}
        return exit_code

    # --- second launch ------------------------------------------------------
    if args.role == "second":
        from silentsuite_bridge import desktop

        legacy_gate_calls = {}
        ipc_probe._count_calls(desktop, ("resolve_legacy_conflicts", "legacy_conflicts", "_loopback_listener_in_use"),
                               legacy_gate_calls)
        ipc_probe._count_calls(autostart, ("legacy_cli_registration_present",), legacy_gate_calls)
        observed = {"dialogs": [], "web_views_seen": 0}

        def second_tick():
            for widget in [w for w in QApplication.topLevelWidgets() if w.isVisible()]:
                if isinstance(widget, QMessageBox):
                    observed["dialogs"].append(((widget.text() or "") + "\n" + (widget.informativeText() or ""))[:300])
                    reject = [b for b in widget.buttons() if widget.buttonRole(b) in (
                        QMessageBox.ButtonRole.RejectRole, QMessageBox.ButtonRole.NoRole)]
                    buttons = reject or widget.buttons()
                    if buttons:
                        buttons[0].click()  # never confirm anything from a second launch
                    else:
                        widget.close()
                    return
                if isinstance(widget, QWebEngineView) or widget.findChildren(QWebEngineView):
                    observed["web_views_seen"] += 1
                    widget.close()
                    return

        poll = QTimer()
        poll.setInterval(TICK_MS)
        poll.timeout.connect(second_tick)
        poll.start()
        exit_code = run_main(["silentsuite-bridge"])
        poll.stop()
        registry = get_registry()
        result.update({
            "stage": "done",
            "exit_code": exit_code,
            "observed": observed,
            "serving_attempted": bool(registry.is_started or registry.is_stopped),
            "legacy_gate_calls": legacy_gate_calls,
            "client_socket": client_socket,
            "removal_calls": len(removals),
            "service_manager_traps": traps,
            "kills": kills,
            "external_open_calls": external,
        })
        _write(out, result)
        timer.cancel()
        return EXIT_WRITTEN

    # --- owner --------------------------------------------------------------
    def trapped_exit(code=0):
        result["os_exit"] = {"code": code, "thread": threading.current_thread().name}
        result["stage"] = "os-exit"
        _write(out, result)
        _real_exit(EXIT_OS_EXIT)

    os._exit = trapped_exit

    entry_path = _desktop_entry_path()
    if args.registration:
        _precreate_desktop_entry(entry_path, run_values)
    result["registration_before"] = _registration_state(entry_path, run_values)

    history = []

    class _ShowHistory(QObject):
        def eventFilter(self, obj, event):  # noqa: N802 - Qt override
            kind = event.type()
            if kind in (QEvent.Type.Show, QEvent.Type.Hide) and isinstance(obj, QWidget) and obj.isWindow():
                if len(history) < HISTORY_CAP:
                    history.append({
                        "wall": time.time(),
                        "event": "show" if kind == QEvent.Type.Show else "hide",
                        "class": type(obj).__name__,
                        "dialog": isinstance(obj, QDialog),
                        "menu": isinstance(obj, (QMenu, QMenuBar)),  # a menu (bar) is not a dashboard window
                    })
                else:
                    result["history_truncated"] = True
            return False

    show_history = _ShowHistory()
    app.installEventFilter(show_history)

    order = []
    before_release = {}
    state = {"phase": "start", "window": None, "bound_at": None, "endpoint": None}
    worker_box = {}

    def worker_state():
        worker = worker_box.get("worker")
        if worker is None:
            return None
        with storage._sync_threads_lock:
            registered = storage._sync_threads.get(SYNTHETIC_USER) is worker
        return {"alive": worker.is_alive(), "stop_calls": worker.stop_calls, "registered": registered}

    def ownership_snapshot():
        endpoint = state["endpoint"]
        return {
            "server_thread_alive": any(t.name == SERVER_THREAD and t.is_alive() for t in threading.enumerate()),
            "registry_stopped": bool(get_registry().is_stopped),
            "ipc_listening": any(s.isListening() for s in app.findChildren(QLocalServer)),
            "endpoint_file_exists": os.path.exists(endpoint) if endpoint else None,
            "worker": worker_state(),
        }

    original_ownership = instance.instance_ownership

    @contextlib.contextmanager
    def observed_ownership(*a, **kw):
        with original_ownership(*a, **kw):
            order.append("lock_acquired")
            try:
                yield
            finally:
                before_release.update(ownership_snapshot())
                order.append("lock_releasing")
        order.append("lock_released")

    instance.instance_ownership = observed_ownership  # delegating; main() imports it at call time

    original_ipc_close = desktop_ipc.OwnerIpc.close

    def observed_ipc_close(self):
        order.append("ipc_close")
        return original_ipc_close(self)

    desktop_ipc.OwnerIpc.close = observed_ipc_close

    def flag(name):
        return control is not None and (control / name).exists()

    def view_count():
        return sum(1 for w in QApplication.allWidgets() if isinstance(w, QWebEngineView))

    def visible_dashboard():
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
                return widget, views[0]
        return None, None

    def quit_actions():
        """Every reachable QAction: app children, widget actions, tray menus, live Python wrappers."""
        candidates = list(app.findChildren(QAction))
        for widget in QApplication.allWidgets():
            candidates.extend(widget.actions())
        for tray in app.findChildren(QSystemTrayIcon):
            menu = tray.contextMenu()
            if menu is not None:
                candidates.extend(menu.actions())
        for obj in gc.get_objects():
            try:
                if isinstance(obj, QAction):
                    candidates.append(obj)
            except Exception:  # noqa: BLE001 - e.g. a dead weakref proxy
                continue
        unique = {}
        for action in candidates:
            unique.setdefault(id(action), action)
        actions = list(unique.values())
        matches = [a for a in actions if _plain(a.text()) == QUIT_TEXT]
        return matches, sorted({a.text() for a in actions if a.text()})[:30]

    def write_ready(kind):
        servers = app.findChildren(QLocalServer)
        facts = ipc_probe._endpoint_facts(servers[0]) if servers else {"found": False}
        if sys.platform != "win32" and facts.get("full_name") and os.path.isabs(facts["full_name"]):
            state["endpoint"] = facts["full_name"]
        worker_box["worker"] = _register_synthetic_worker(storage)
        window, _view = visible_dashboard()
        ready = {
            "kind": kind,
            "registry_dashboard_url": get_registry().dashboard_url(False),
            "port": config.LISTEN_PORT,
            "ipc": facts,
            "pid": os.getpid(),
            "view_count": view_count(),
            "dashboard_visible": window is not None,
            "quit_actions_found": len(quit_actions()[0]),
            "wall": time.time(),
        }
        result["ready"] = ready
        _write(args.ready, ready)

    def fixture_quit(reason):
        result["teardown"] = reason  # fixture teardown only; never evidence of a product Quit
        state["phase"] = "ending"
        app.quit()

    def begin_quit():
        matches, texts = quit_actions()
        quit = {"found": len(matches), "texts": texts, "requested_wall": time.time()}
        result["quit"] = quit
        if args.quit_via_action and matches:
            action = matches[0]
            quit.update({
                "enabled": bool(action.isEnabled()),
                "main_thread": threading.current_thread() is threading.main_thread(),
                "stopped_in_time": True,
            })
            result["teardown"] = "quit-action"
            state.update({"phase": "quitting", "quit_at": time.monotonic()})
            action.trigger()  # the real native action, on the owner's main thread
            return
        fixture_quit("fixture-quit")

    def tick():
        phase = state["phase"]
        if phase == "ending":
            return
        if phase == "quitting":
            if time.monotonic() - state["quit_at"] > QUIT_STOP_SECONDS:
                result["quit"]["stopped_in_time"] = False
                fixture_quit("fixture-quit-after-action")
            return
        if flag("abort"):
            fixture_quit("fixture-abort")
            return
        if phase == "start":
            if args.background:
                if get_registry().dashboard_url(False) is None:
                    return
                if state["bound_at"] is None:
                    state["bound_at"] = time.monotonic()
                    return
                if time.monotonic() - state["bound_at"] < BACKGROUND_SETTLE_SECONDS:
                    return
                write_ready("background")
                state["phase"] = "ready"
                return
            window, _view = visible_dashboard()
            if window is None:
                return
            state["window"] = window
            write_ready("dashboard")
            state["phase"] = "ready"
            return
        if flag("quit"):
            begin_quit()
            return
        if phase == "ready" and flag("close") and state["window"] is not None:
            window = state["window"]
            close = {"wall": time.time(), "visible_before": bool(window.isVisible())}
            result["close"] = close
            # An ACTUAL close: a real QCloseEvent through QWidget.close(), not hide().
            close["accepted"] = bool(window.close())
            state.update({"phase": "closed", "closed_at": time.monotonic()})
            return
        if phase == "closed":
            if time.monotonic() - state["closed_at"] < CLOSE_SETTLE_SECONDS:
                return
            try:
                visible, deleted = bool(state["window"].isVisible()), False
            except RuntimeError:  # the product destroyed its window
                visible, deleted = False, True
            closed = {"visible": visible, "window_deleted": deleted, "view_count": view_count(),
                      "wall": time.time(), **ownership_snapshot()}
            result["closed"] = closed
            _write(control / "closed.json", closed)
            state["phase"] = "hidden"
            return
        if phase in ("ready", "hidden") and flag("second.started"):
            window, view = visible_dashboard()
            if window is None:
                return
            getter = getattr(view.page(), "requestedUrl", None)
            shown = {
                "wall": time.time(),
                "same_window": state["window"] is not None and window is state["window"],
                "view_count": view_count(),
                "dashboard_url": get_registry().dashboard_url(False),
                "requested_url": getter().toString() if getter is not None else None,
                "title": view.title(),
            }
            result["shown"] = shown
            _write(control / "shown.ack", shown)
            state["phase"] = "shown"

    poll = QTimer()
    poll.setInterval(TICK_MS)
    poll.timeout.connect(tick)
    poll.start()

    argv = ["silentsuite-bridge"] + (["--background"] if args.background else [])
    exit_code = run_main(argv)
    poll.stop()
    app.removeEventFilter(show_history)
    if result.get("quit"):
        result["quit"]["main_returned_wall"] = time.time()

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
        "order": order,
        "before_release": before_release,
        "lock_free_after": lock_free,
        "registry_stopped_after": bool(get_registry().is_stopped),
        "worker_after": worker_state(),
        "history": history,
        "registration_after": _registration_state(entry_path, run_values),
        "service_manager_traps": traps,
        "kills": kills,
        "removal_calls": len(removals),
        "external_open_calls": external,
    })
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T2 lifecycle fixture (non-product)")
    parser.add_argument("--role", required=True, choices=["owner", "second"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--ready", default="")
    parser.add_argument("--control", default="")
    parser.add_argument("--background", action="store_true")
    parser.add_argument("--registration", action="store_true")
    parser.add_argument("--quit-via-action", action="store_true")
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
