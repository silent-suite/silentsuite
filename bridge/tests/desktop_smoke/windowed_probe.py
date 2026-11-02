"""T4 windowed-stdio fixture (#171): the real desktop journey with or without stdio.

Runs the REAL ``main(flavor="desktop")`` once, with no account, in a child
process. With ``--windowed`` the fixture sets ``sys.stdin``, ``sys.stdout``
and ``sys.stderr`` to None just before ``main`` (what a windowed Python
executable has); otherwise stdio stays as the parent gave it.

A QTimer observer waits until the product window shows this process's own
registry-confirmed dashboard (requested URL == registry URL, final URL is the
canonical /.web route, title "SilentSuite Bridge"). It then records whether
stdio really is None, logs one fixed synthetic witness line through the
product's own "silentsuite-bridge" logger (no account, page or PIM data) and
closes the window like a user. After ``main`` returns it records the lock,
listener and registry state, and whether the CLI ``run_server`` path ran (a
delegating counter; the real function would still run).

The fixture never configures logging itself, so whatever handlers exist come
from the product's ``configure_logging``. Results go to --out as JSON; no
stdio is needed to report them.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog.
"""

import argparse
import json
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
WATCHDOG_SECONDS = 120
WINDOW_DEADLINE_SECONDS = 60
BRAND = "SilentSuite Bridge"


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def run(out: Path, windowed: bool, witness: str) -> int:
    result = {"stage": "prereq", "prereq": {}, "entry_error": None, "windowed": windowed, "observed": {}}
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

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    import logging

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import config
    from silentsuite_bridge.radicale.server import get_registry

    run_server_calls = []
    real_run_server = bridge_main.run_server

    def counted_run_server(*args, **kwargs):
        run_server_calls.append(1)
        return real_run_server(*args, **kwargs)

    bridge_main.run_server = counted_run_server

    observed = result["observed"]
    state = {"done": False, "started": time.monotonic()}

    def observe():
        if state["done"]:
            return
        if time.monotonic() - state["started"] > WINDOW_DEADLINE_SECONDS:
            observed["window_deadline_missed"] = True
            state["done"] = True
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
            view = views[0]
            getter = getattr(view.page(), "requestedUrl", None)
            requested = getter().toString() if getter is not None else None
            if not dashboard or requested != dashboard or view.title() != BRAND:
                return
            observed.update({
                "requested_url": requested,
                "registry_dashboard_url": dashboard,
                "view_url": view.url().toString(),
                "stdio_none_during_run": sys.stdin is None and sys.stdout is None and sys.stderr is None,
                "root_handler_kinds": sorted({type(h).__name__ for h in logging.getLogger().handlers}),
            })
            logging.getLogger("silentsuite-bridge").warning("%s", witness)
            state["done"] = True
            widget.close()  # normal user close; start-at-login is off
            return

    poll = QTimer()
    poll.setInterval(200)
    poll.timeout.connect(observe)
    poll.start()

    saved = (sys.stdin, sys.stdout, sys.stderr)
    sys.argv = ["silentsuite-bridge"]
    exit_code = None
    result["stage"] = "entrypoint"
    _write(out, result)
    if windowed:
        sys.stdin = sys.stdout = sys.stderr = None
    try:
        bridge_main.main(flavor="desktop")
    except SystemExit as exc:
        exit_code = exc.code
    except Exception as exc:  # noqa: BLE001
        frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)][-6:]
        result["entry_error"] = {"class": type(exc).__name__, "frames": frames}
    finally:
        sys.stdin, sys.stdout, sys.stderr = saved
    poll.stop()

    lock_path = os.path.join(config.DATA_DIR, "instance.lock")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        lock_free = bool(config._try_lock_fd(fd))
        if lock_free:
            config._unlock_fd(fd)
    finally:
        os.close(fd)
    try:
        with socket.create_connection(("127.0.0.1", config.LISTEN_PORT), timeout=1.0):
            listener_closed = False
    except OSError:
        listener_closed = True
    registry = get_registry()
    for handler in logging.getLogger().handlers:
        try:
            handler.flush()
        except Exception:  # noqa: BLE001 - a handler on a None stream may refuse; not our evidence
            pass
    result.update({
        "stage": "done",
        "exit_code": exit_code,
        "lock_free_after": lock_free,
        "listener_closed_after": listener_closed,
        "registry_stopped_after": registry.is_stopped,
        "run_server_calls": len(run_server_calls),
    })
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T4 windowed-stdio fixture (non-product)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--witness", required=True)
    parser.add_argument("--windowed", action="store_true")
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    return run(out, args.windowed, args.witness)


if __name__ == "__main__":
    sys.exit(main())
