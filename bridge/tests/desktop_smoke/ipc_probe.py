"""T2 IPC fixture (#171): owner, second launch and payload sender, in real processes.

Roles (one per process; the parent test drives them):

  owner    runs the REAL main(flavor="desktop"). Driven by files in --control:
           when its dashboard (or, with --with-cli-registration, its migration
           prompt) is up it writes ready.json, hides the dashboard window, and
           then records whether a later launch made it visible again. Control
           files: "rehide", "report", "close" (dashboard) or "cancel" (prompt).
  second   runs the REAL main(flavor="desktop") for the same DATA_DIR and
           records what it did: dialogs, web views, serving, removal calls.
  payload  connects to the owner's endpoint (read from ready.json) with a
           QLocalSocket and sends non-"show" payloads, recording any reply.

How the owner's endpoint is found: a QLocalServer descendant of the running
QApplication (Qt introspection, like the T2 window probe). No product helper,
file or URL is used. If none exists, ready.json says so and the parent test
reports the endpoint and payload checks as NOT REACHED.

Simulated boundaries are reused read-only from migration_probe: the
service-manager subprocess trap, the Windows HKCU Run-key table, and a
recorder for autostart.remove_autostart. Everything else is real.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog.
"""

import argparse
import json
import os
import stat
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import migration_probe  # noqa: E402 - reuse its boundary traps read-only

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
WATCHDOG_SECONDS = 150
TICK_MS = 100
BRAND = "SilentSuite Bridge"
MIGRATION_PROMPT = migration_probe.MIGRATION_PROMPT
PAYLOADS = [
    b"open http://127.0.0.1:9/",
    b"showhttp://127.0.0.1:9/",
    b"\x00\xffshow",
    b"SHOW",
    b"x" * 65536,
]


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _watchdog(out, result):
    def fire():
        result["stage"] = str(result.get("stage")) + ":fixture-watchdog"
        _write(out, result)
        os._exit(EXIT_WATCHDOG)  # fixture-only

    timer = threading.Timer(WATCHDOG_SECONDS, fire)
    timer.daemon = True
    timer.start()
    return timer


def _isolated_home_ok():
    if sys.platform == "win32":
        return True
    home = os.environ.get("HOME", "")
    return bool(home) and os.path.expanduser("~") == home and "t2ipc" in home


def _add_cli_registration(traps):
    """Create the CLI start-at-login entry this process will see (isolated HOME / simulated HKCU)."""
    from silentsuite_bridge import autostart

    if sys.platform == "win32":
        migration_probe._install_windows_run_key(
            {migration_probe.CLI_RUN_VALUE: '"C:\\synthetic\\silentsuite-bridge.exe"'}, traps,
        )
        return
    path = autostart._launchd_plist_path() if sys.platform == "darwin" else autostart._systemd_service_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("# synthetic T2 IPC registration\n")


def _install_client_socket_observer(log):
    """Second launch only: a delegating QLocalSocket subclass.

    Every call goes to the real native socket. It records the outgoing bytes
    (hex, first 64 bytes per write), connect attempts, and the NAME of any
    read-style call; it never records data that was read.
    """
    import PySide6.QtNetwork as qtnetwork

    native = qtnetwork.QLocalSocket

    def as_bytes(data):
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        if isinstance(data, str):
            return data.encode("utf-8")
        if hasattr(data, "data"):
            return bytes(data.data())
        return b""

    def reader(name):
        def method(self, *args, **kwargs):
            log["read_attempts"] += 1
            if len(log["read_methods"]) < 20:
                log["read_methods"].append(name)
            return getattr(native, name)(self, *args, **kwargs)
        return method

    class ObservedLocalSocket(native):
        def connectToServer(self, *args, **kwargs):  # noqa: N802 - Qt name
            log["connects"] += 1
            return native.connectToServer(self, *args, **kwargs)

        def write(self, data, *args):
            raw = as_bytes(data)
            if len(log["writes_hex"]) < 20:
                log["writes_hex"].append(raw[:64].hex())
            log["write_bytes"] += len(raw)
            return native.write(self, data, *args)

        read = reader("read")
        readAll = reader("readAll")  # noqa: N815 - Qt name
        readLine = reader("readLine")  # noqa: N815
        peek = reader("peek")
        getChar = reader("getChar")  # noqa: N815
        waitForReadyRead = reader("waitForReadyRead")  # noqa: N815

    qtnetwork.QLocalSocket = ObservedLocalSocket


def _count_calls(module, names, counts):
    """Wrap existing functions with delegating call counters (real logic still runs)."""
    for name in names:
        original = getattr(module, name)

        def counted(*args, _name=name, _original=original, **kwargs):
            counts[_name] = counts.get(_name, 0) + 1
            return _original(*args, **kwargs)

        setattr(module, name, counted)


def _endpoint_facts(server):
    """Record what the owner's QLocalServer is, and on POSIX who can reach it."""
    name = server.fullServerName()
    facts = {
        "found": True,
        "full_name": name,
        "name_length": len(name),
        "socket_options": str(server.socketOptions()),
        "listening": bool(server.isListening()),
    }
    if sys.platform != "win32" and name and os.path.isabs(name):
        parent = os.path.dirname(name)
        try:
            st = os.lstat(parent)
            facts.update({
                "parent_is_symlink": stat.S_ISLNK(st.st_mode),
                "parent_owner_is_me": st.st_uid == os.getuid(),
                "parent_group_other_bits": oct(st.st_mode & 0o077),
            })
            sst = os.lstat(name)
            facts["socket_is_socket"] = stat.S_ISSOCK(sst.st_mode)
            facts["socket_owner_is_me"] = sst.st_uid == os.getuid()
        except OSError as exc:
            facts["stat_error"] = type(exc).__name__
    return facts


def run(args) -> int:
    out = Path(args.out)
    control = Path(args.control) if args.control else None
    result = {"role": args.role, "stage": "prereq", "prereq": {}, "entry_error": None}
    _write(out, result)
    timer = _watchdog(out, result)

    try:
        from PySide6.QtCore import QCoreApplication, QObject, Qt, QTimer, QUrl, Slot
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtNetwork import QLocalServer, QLocalSocket
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication, QMessageBox
    except Exception as exc:  # noqa: BLE001
        result["prereq"]["import_error"] = type(exc).__name__
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    if args.role == "payload":
        app = QCoreApplication([sys.argv[0]])
        ready = json.loads(Path(args.ready).read_text(encoding="utf-8"))
        name = (ready.get("ipc") or {}).get("full_name")
        sent = []
        for payload in PAYLOADS:
            sock = QLocalSocket()
            sock.connectToServer(name)
            connected = bool(sock.waitForConnected(2000))
            written = 0
            flushed = False
            received = 0
            if connected:
                written = int(sock.write(payload))
                flushed = bool(sock.waitForBytesWritten(2000)) or sock.bytesToWrite() == 0
                if sock.waitForReadyRead(500):
                    received = int(sock.bytesAvailable())
                sock.disconnectFromServer()
                if sock.state() != QLocalSocket.LocalSocketState.UnconnectedState:
                    sock.waitForDisconnected(1000)
            sent.append({"size": len(payload), "connected": connected, "written": written,
                         "flushed": flushed, "received": received})
        result.update({"stage": "done", "payloads": sent})
        _write(out, result)
        timer.cancel()
        return EXIT_WRITTEN

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
        _install_client_socket_observer(client_socket)

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import autostart, config
    from silentsuite_bridge.radicale.server import get_registry

    legacy_gate_calls = {}
    if args.role == "second":
        from silentsuite_bridge import desktop

        _count_calls(desktop, ("resolve_legacy_conflicts", "legacy_conflicts", "_loopback_listener_in_use"),
                     legacy_gate_calls)
        _count_calls(autostart, ("legacy_cli_registration_present",), legacy_gate_calls)

    traps = []
    migration_probe._install_service_manager_trap(traps)
    removals = []

    def recorded_remove_autostart():
        removals.append(args.role)
        return 0

    autostart.remove_autostart = recorded_remove_autostart
    if args.with_cli_registration:
        _add_cli_registration(traps)

    external = []

    class _ExternalTrap(QObject):
        @Slot(QUrl)
        def handle(self, url):
            external.append(url.scheme())

    trap_obj = _ExternalTrap()
    for scheme in ("http", "https", "file"):
        QDesktopServices.setUrlHandler(scheme, trap_obj, "handle")

    started = time.monotonic()
    observed = {
        "prompts": [], "other_dialogs": [], "web_views_seen": 0, "shown_after_hide": False,
        "shown_after_rehide": False, "visible_windows_max": 0,
    }
    state = {"phase": "start", "window": None, "view": None, "prompt_widgets": []}

    def control_flag(name):
        return control is not None and (control / name).exists()

    def visible_windows():
        return [w for w in QApplication.topLevelWidgets() if w.isVisible()]

    def find_dashboard():
        for widget in visible_windows():
            views = [widget] if isinstance(widget, QWebEngineView) else widget.findChildren(QWebEngineView)
            if views:
                return widget, views[0]
        return None, None

    def ipc_facts():
        servers = app.findChildren(QLocalServer)
        return _endpoint_facts(servers[0]) if servers else {"found": False}

    def write_ready(kind):
        ready = {
            "kind": kind,
            "registry_dashboard_url": get_registry().dashboard_url(False),
            "port": config.LISTEN_PORT,
            "ipc": ipc_facts(),
            "t": round(time.monotonic() - started, 2),
        }
        result["ready"] = ready
        _write(Path(args.ready), ready)

    def handle_dialogs(answer_prompt):
        for widget in visible_windows():
            if isinstance(widget, QMessageBox):
                text = (widget.text() or "") + "\n" + (widget.informativeText() or "")
                if MIGRATION_PROMPT in text:
                    # Count prompt instances (a re-prompt is a new dialog), not texts.
                    if not any(seen is widget for seen in state["prompt_widgets"]):
                        state["prompt_widgets"].append(widget)
                        observed["prompts"].append(text[:300])
                    if answer_prompt is not None:
                        roles = (
                            (QMessageBox.ButtonRole.RejectRole, QMessageBox.ButtonRole.NoRole)
                            if answer_prompt == "reject"
                            else (QMessageBox.ButtonRole.AcceptRole, QMessageBox.ButtonRole.YesRole)
                        )
                        for button in widget.buttons():
                            if widget.buttonRole(button) in roles:
                                button.click()
                                return "answered"
                    return "prompt"
                observed["other_dialogs"].append(text[:300])
                for button in widget.buttons():
                    button.click()
                    break
                else:
                    widget.close()
                return "other"
        return None

    def tick():
        observed["visible_windows_max"] = max(observed["visible_windows_max"], len(visible_windows()))
        if args.role == "second":
            dialog = handle_dialogs("reject")  # never confirm a removal from a second launch
            if dialog:
                return
            window, view = find_dashboard()
            if window is not None:
                observed["web_views_seen"] += 1
                window.close()
            return

        # --- owner ---
        phase = state["phase"]
        if args.with_cli_registration:
            if phase == "start":
                if handle_dialogs(None) == "prompt":
                    state["phase"] = "prompt-up"
                    write_ready("prompt")
            elif phase == "prompt-up" and control_flag("cancel"):
                handle_dialogs("reject")
                state["phase"] = "cancelled"
            return
        if phase == "start":
            window, view = find_dashboard()
            dashboard = get_registry().dashboard_url(False)
            getter = getattr(view.page(), "requestedUrl", None) if view is not None else None
            if window is None or dashboard is None or getter is None or getter().toString() != dashboard:
                return
            if view.title() != BRAND:
                return
            state.update({"window": window, "view": view, "phase": "hidden", "url": view.url().toString()})
            window.hide()  # fixture-driven hide; not evidence of a product close-to-hide
            write_ready("dashboard")
        elif phase == "hidden":
            if state["window"].isVisible() and not observed["shown_after_hide"]:
                observed["shown_after_hide"] = True
                (control / "shown.ack").write_text("ok", encoding="utf-8")
            if control_flag("rehide"):
                state["window"].hide()
                observed["view_url_before_payloads"] = state["view"].url().toString()
                state["phase"] = "rehidden"
                (control / "rehidden.ack").write_text("ok", encoding="utf-8")
        elif phase == "rehidden":
            if state["window"].isVisible():
                observed["shown_after_rehide"] = True
            if control_flag("report"):
                observed["view_url_after_payloads"] = state["view"].url().toString()
                observed["dialogs_after_payloads"] = len(
                    [w for w in visible_windows() if isinstance(w, QMessageBox)]
                )
                result["observed"] = observed
                _write(out, result)
                (control / "report.ack").write_text("ok", encoding="utf-8")
                state["phase"] = "reported"
        elif phase == "reported" and control_flag("close"):
            state["window"].show()
            state["window"].close()  # normal close; start-at-login is off
            state["phase"] = "closing"

    poll = QTimer()
    poll.setInterval(TICK_MS)
    poll.timeout.connect(tick)
    poll.start()

    sys.argv = ["silentsuite-bridge"]
    exit_code = None
    result["stage"] = "entrypoint"
    _write(out, result)
    entered = time.monotonic()
    try:
        bridge_main.main(flavor="desktop")
    except SystemExit as exc:
        exit_code = exc.code
    except Exception as exc:  # noqa: BLE001
        frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)][-6:]
        result["entry_error"] = {"class": type(exc).__name__, "frames": frames}
    poll.stop()
    seconds_in_main = round(time.monotonic() - entered, 2)

    registry = get_registry()
    lock_free = None
    if args.role == "owner":
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
        "seconds_in_main": seconds_in_main,
        "observed": observed,
        "removal_calls": len(removals),
        "serving_attempted": bool(registry.is_started or registry.is_stopped),
        "lock_free_after": lock_free,
        "service_manager_traps": traps,
        "external_open_calls": external,
        "client_socket": client_socket,  # second launch only
        "legacy_gate_calls": legacy_gate_calls,  # second launch only
    })
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T2 IPC fixture (non-product)")
    parser.add_argument("--role", required=True, choices=["owner", "second", "payload"])
    parser.add_argument("--out", required=True)
    parser.add_argument("--ready", default="")
    parser.add_argument("--control", default="")
    parser.add_argument("--with-cli-registration", action="store_true")
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
