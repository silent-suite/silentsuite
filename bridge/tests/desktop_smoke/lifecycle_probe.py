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
- every Show/Hide of a top-level widget, with wall-clock time (bounded list).
  An event filter goes on each top-level widget itself, never on the
  application. It is attached before the product's first show (in a delegating
  start_workers wrapper) and on every tick, and removed on aboutToQuit;
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

Crash diagnostics (POSIX): faulthandler writes the crashing thread's Python
stack to stderr. It is armed before Qt and again after the web engine has
started. Short "t2-lifecycle-probe phase:" lines on stderr mark the probe's
own boundaries, each printed at most once. Neither changes what is observed.
"""

import argparse
import contextlib
import faulthandler
import gc
import hashlib
import os
import sys
import threading
import time
import traceback
from pathlib import Path

# --- crash diagnostics (run 41818896067: the owner died with SIGSEGV on Linux/macOS) ---
# faulthandler prints the crashing thread's Python stack to stderr, which the
# parent already includes in its failure message (the last 2500 characters).
# Only the crashing thread is dumped so the stack fits in that tail. Phase markers
# are one short stderr line per probe-only boundary, each printed at most once.
# POSIX only: Windows passed, and faulthandler there also reports handled exceptions.
_FAULTHANDLER = sys.platform != "win32"
_PHASES_SEEN = set()
_PHASE_CAP = 32


def _phase(name):
    if name in _PHASES_SEEN or len(_PHASES_SEEN) >= _PHASE_CAP:
        return
    _PHASES_SEEN.add(name)
    print(f"t2-lifecycle-probe phase: {name}", file=sys.stderr, flush=True)


def _arm_faulthandler(reason):
    """(Re)install faulthandler. Chromium's start-up may reset SIGSEGV/SIGBUS to the
    default action, so it is armed again after the web engine has started."""
    if not _FAULTHANDLER:
        return
    faulthandler.disable()
    faulthandler.enable(file=sys.stderr, all_threads=False)
    _phase(f"faulthandler armed ({reason})")


_arm_faulthandler("before Qt and product import")

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
    _phase(f"{args.role}: QApplication created")

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
        _phase(f"{args.role}: entering desktop main")
        try:
            bridge_main.main(flavor="desktop")
        except SystemExit as exc:
            exit_code = exc.code
        except Exception as exc:  # noqa: BLE001
            frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)]
            result["entry_error"] = {"class": type(exc).__name__, "frames": frames[-6:]}
        _phase(f"{args.role}: desktop main returned")
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

    def record_show_hide(widget, kind, attached_visible=False):
        if len(history) >= HISTORY_CAP:
            result["history_truncated"] = True
            return
        entry = {
            "wall": time.time(),
            "event": kind,
            "class": type(widget).__name__,
            "dialog": isinstance(widget, QDialog),
            "menu": isinstance(widget, (QMenu, QMenuBar)),  # a menu (bar) is not a dashboard window
        }
        if attached_visible:
            entry["attached_visible"] = True  # already on screen when first seen: counted as a show
        history.append(entry)

    # TARGETED Show/Hide observation (fixture correction 1). The first version
    # installed this filter on the QApplication, which delivers every event of
    # every main-thread QObject (WebEngine internals included) into Python.
    # All six POSIX owners then died in app.exec() with that filter active (run
    # 41820702916). Now the filter goes only on individual top-level widgets
    # (QObject.installEventFilter on the widget itself), whatever their class,
    # so a future QMainWindow container is covered the same way as today's view.
    class _WindowShowHide(QObject):
        def eventFilter(self, obj, event):  # noqa: N802 - Qt override
            kind = event.type()
            if kind in (QEvent.Type.Show, QEvent.Type.Hide) and isinstance(obj, QWidget) and obj.isWindow():
                record_show_hide(obj, "show" if kind == QEvent.Type.Show else "hide")
            return False  # never consumes: the widget's own handlers run unchanged

    window_show_hide = _WindowShowHide()
    watched = []
    watching = {"detached": False}

    def watch_top_levels():
        """Attach to every top-level widget not yet watched (hidden ones too)."""
        if watching["detached"]:
            return
        for widget in QApplication.topLevelWidgets():
            if any(widget is seen for seen in watched):
                continue
            widget.installEventFilter(window_show_hide)
            watched.append(widget)
            if widget.isVisible():
                record_show_hide(widget, "show", attached_visible=True)

    def unwatch_top_levels():
        """Remove every per-window filter before the product tears its windows down."""
        if watching["detached"]:
            return
        watching["detached"] = True
        for widget in watched:
            try:
                widget.removeEventFilter(window_show_hide)
            except RuntimeError:  # that widget is already gone (Qt dropped its filters)
                pass
        watched.clear()
        _phase("owner: per-window Show/Hide filters removed")

    # First-show coverage: run_desktop calls start_workers() after building its
    # window and before view.show()/app.exec(), so a delegating wrapper attaches
    # there, before the first product show. Every tick attaches to any later
    # top-level as well. aboutToQuit removes the filters after the event loop
    # ends and before run_desktop deletes the view.
    original_start_workers = bridge_main._start_sync_threads

    def start_workers_after_watch():
        watch_top_levels()
        _phase(f"owner: per-window Show/Hide filters attached before first show ({len(watched)})")
        return original_start_workers()

    bridge_main._start_sync_threads = start_workers_after_watch  # main() passes it at call time
    app.aboutToQuit.connect(unwatch_top_levels)
    _phase("owner: targeted per-window Show/Hide observer prepared (no application-wide filter)")

    # Diagnostic only: run_desktop calls DesktopStartAtLogin.for_running_app() after it
    # has built the web profile and view and before view.show()/app.exec(). A
    # delegating wrapper re-arms faulthandler there, after Chromium's start-up.
    from silentsuite_bridge import desktop_autostart

    original_for_running_app = desktop_autostart.DesktopStartAtLogin.for_running_app

    def for_running_app_after_rearm():
        _arm_faulthandler("after the web profile and view were built")
        return original_for_running_app()

    desktop_autostart.DesktopStartAtLogin.for_running_app = staticmethod(for_running_app_after_rearm)

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
            _phase("owner: instance lock acquired")
            try:
                yield
            finally:
                _phase("owner: lock-release snapshot")
                before_release.update(ownership_snapshot())
                order.append("lock_releasing")
        order.append("lock_released")
        _phase("owner: instance lock released")

    instance.instance_ownership = observed_ownership  # delegating; main() imports it at call time

    original_ipc_close = desktop_ipc.OwnerIpc.close

    def observed_ipc_close(self):
        order.append("ipc_close")
        _phase("owner: OwnerIpc.close")
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
        _arm_faulthandler("at ready, after the page loaded")
        _phase("owner: ready: endpoint facts")
        servers = app.findChildren(QLocalServer)
        facts = ipc_probe._endpoint_facts(servers[0]) if servers else {"found": False}
        if sys.platform != "win32" and facts.get("full_name") and os.path.isabs(facts["full_name"]):
            state["endpoint"] = facts["full_name"]
        _phase("owner: ready: synthetic worker")
        worker_box["worker"] = _register_synthetic_worker(storage)
        window, _view = visible_dashboard()
        _phase("owner: ready: QAction scan (incl. gc.get_objects)")
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
        _phase("owner: ready written")

    def fixture_quit(reason):
        result["teardown"] = reason  # fixture teardown only; never evidence of a product Quit
        state["phase"] = "ending"
        _phase(f"owner: fixture teardown ({reason})")
        app.quit()

    def begin_quit():
        _phase("owner: quit: QAction scan (incl. gc.get_objects)")
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
            _phase("owner: quit: QAction.trigger()")
            action.trigger()  # the real native action, on the owner's main thread
            return
        fixture_quit("fixture-quit")

    def tick():
        watch_top_levels()  # top-levels created after start_workers (none today)
        if not state.get("ticked"):
            state["ticked"] = True
            _arm_faulthandler("first event-loop tick")
            _phase("owner: event loop running")
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
            _phase("owner: close: QWidget.close() called")
            close["accepted"] = bool(window.close())
            _phase("owner: close: QWidget.close() returned")
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
            _phase("owner: closed snapshot written")
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
            _phase("owner: shown ack written")
            state["phase"] = "shown"

    poll = QTimer()
    poll.setInterval(TICK_MS)
    poll.timeout.connect(tick)
    poll.start()

    argv = ["silentsuite-bridge"] + (["--background"] if args.background else [])
    exit_code = run_main(argv)
    poll.stop()
    unwatch_top_levels()  # no-op when aboutToQuit already removed them
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
