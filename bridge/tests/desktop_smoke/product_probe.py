"""T2 first-window fixture (#171): run the REAL desktop entrypoint and observe it.

Run as a child process by ``tests/test_desktop_shell.py``; never imported by
the Bridge. The fixture:

1. records positive native prerequisites: PySide6 / Qt WebEngine import, a
   QApplication with a screen, and a QWebEngineView that can be constructed;
2. installs observation traps that change nothing about the product:
   ``webbrowser.open*`` and QDesktopServices URL handlers only record calls,
   and a foreign loopback server only records requests;
3. starts a QTimer observer, then calls the real
   ``silentsuite_bridge.__main__.main(flavor="desktop")``. Contract: the
   desktop entrypoint reuses an existing QApplication instead of creating a
   second one, and runs its event loop on this (main) thread;
4. once the product's window shows the bound dashboard, the observer loads an
   off-origin URL into that same view, then closes the window like a user;
5. after ``main`` returns, checks that the lock is free, the listener is
   closed and the registry is stopped.

Data, settings and HOME come from the parent's synthetic directories. No
account, network service or autostart entry is touched.

Exit codes: 0 result written (parent judges it), 2 prerequisite missing,
3 fixture watchdog (the product did not finish), anything else = crash.
"""

import argparse
import http.server
import json
import os
import socket
import sys
import threading
import time
import traceback
import urllib.parse
from pathlib import Path

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3

WATCHDOG_SECONDS = 120
OBSERVE_INTERVAL_MS = 200
WINDOW_DEADLINE_SECONDS = 60
OFF_ORIGIN_SETTLE_SECONDS = 2.5
BRAND = "SilentSuite Bridge"


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


class _Recorder:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = []

    def add(self, path):
        with self.lock:
            self.requests.append(path)

    def snapshot(self):
        with self.lock:
            return list(self.requests)


def _foreign_server(recorder):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            recorder.add(urllib.parse.urlsplit(self.path).path)
            body = b"<!doctype html><title>foreign</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name="t2-foreign", daemon=True)
    thread.start()
    return server, thread


def run(out: Path) -> int:
    result = {
        "stage": "prereq",
        "prereq": {},
        "entry_error": None,
        "observed": {},
        "after": {},
        "traps": {},
    }
    _write(out, result)

    def watchdog():
        result["stage"] = result["stage"] + ":fixture-watchdog"
        _write(out, result)
        os._exit(EXIT_WATCHDOG)  # fixture-only: the product never returned

    timer = threading.Timer(WATCHDOG_SECONDS, watchdog)
    timer.daemon = True
    timer.start()

    try:
        import PySide6
        from PySide6.QtCore import QCoreApplication, QObject, Qt, QTimer, QUrl, Slot
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication
    except Exception as exc:  # noqa: BLE001
        result["prereq"]["import_error"] = type(exc).__name__
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({
        "pyside6_version": getattr(PySide6, "__version__", "unknown"),
        "qapplication": True,
        "screen": app.primaryScreen() is not None,
    })
    witness_view = QWebEngineView()  # positive Qt WebEngine runtime witness, never shown
    result["prereq"]["webengine_view_constructed"] = True
    witness_view.deleteLater()
    app.processEvents()

    # Observation traps: record, never act.
    import webbrowser

    browser_calls = []

    def trap_browser(url, *args, **kwargs):
        browser_calls.append("webbrowser")
        return True

    webbrowser.open = trap_browser
    webbrowser.open_new = trap_browser
    webbrowser.open_new_tab = trap_browser

    external_calls = []

    class ExternalTrap(QObject):
        @Slot(QUrl)
        def handle(self, url):
            external_calls.append(url.scheme())

    trap = ExternalTrap()
    for scheme in ("http", "https", "file", "mailto"):
        QDesktopServices.setUrlHandler(scheme, trap, "handle")

    foreign_rec = _Recorder()
    foreign, foreign_thread = _foreign_server(foreign_rec)
    foreign_base = f"http://127.0.0.1:{foreign.server_address[1]}"

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import config
    from silentsuite_bridge.radicale.server import get_registry

    state = {"phase": "wait-window", "started": time.monotonic(), "window": None, "view": None}

    def find_product_window():
        for widget in QApplication.topLevelWidgets():
            if not widget.isVisible():
                continue
            views = [widget] if isinstance(widget, QWebEngineView) else widget.findChildren(QWebEngineView)
            if views:
                return widget, views[0]
        return None, None

    def requested_of(view):
        # QWebEnginePage.requestedUrl: the URL originally requested for the
        # page now shown, before any redirect. None if the binding lacks it.
        getter = getattr(view.page(), "requestedUrl", None)
        return getter().toString() if getter is not None else None

    def same_origin(url_a, url_b):
        a, b = urllib.parse.urlsplit(url_a), urllib.parse.urlsplit(url_b)
        return (a.scheme, a.hostname, a.port) == (b.scheme, b.hostname, b.port)

    def observe():
        phase = state["phase"]
        if phase == "wait-window":
            window, view = find_product_window()
            dashboard = get_registry().dashboard_url(False)
            # Bounded last-seen diagnostics, so a missed deadline says why.
            state["last_seen"] = {
                "window_title": window.windowTitle() if window is not None else None,
                "view_url": view.url().toString() if view is not None else None,
                "requested_url": requested_of(view) if view is not None else None,
                "page_title": view.title() if view is not None else None,
                "registry_dashboard_url": dashboard,
            }
            if time.monotonic() - state["started"] > WINDOW_DEADLINE_SECONDS:
                result["observed"]["window_deadline_missed"] = True
                result["observed"]["last_seen"] = state["last_seen"]
                state["phase"] = "gave-up"
                result["stage"] = "window-deadline-missed"
                _write(out, result)
                # Ask the product to finish the normal way; the parent fails the run.
                for widget in QApplication.topLevelWidgets():
                    widget.close()
                return
            if window is None or dashboard is None:
                return
            # The view must have been asked to load THIS process's registry URL;
            # Radicale's root then redirects same-origin to the dashboard route
            # (302 / -> /.web), so the final URL is judged by the parent test.
            requested = requested_of(view)
            current = view.url().toString()
            if requested != dashboard or not same_origin(current, dashboard) or view.title() != BRAND:
                return
            page = view.page()
            profile = page.profile()
            result["observed"].update({
                "window_title": window.windowTitle(),
                "visible_top_level_windows": len([w for w in QApplication.topLevelWidgets() if w.isVisible()]),
                "view_url": current,
                "requested_url": requested,
                "page_title": view.title(),
                "registry_dashboard_url": dashboard,
                "requested_port": config.LISTEN_PORT,
                "off_the_record": bool(profile.isOffTheRecord()),
                "web_channel_absent": page.webChannel() is None,
            })
            state.update({"window": window, "view": view, "phase": "off-origin", "t": time.monotonic()})
            result["stage"] = "window-observed"
            _write(out, result)
            view.load(QUrl(foreign_base + "/product-off-origin"))
        elif phase == "off-origin":
            if time.monotonic() - state["t"] < OFF_ORIGIN_SETTLE_SECONDS:
                return
            result["observed"]["foreign_requests"] = foreign_rec.snapshot()
            result["observed"]["view_url_after_off_origin"] = state["view"].url().toString()
            state["phase"] = "closing"
            result["stage"] = "closing"
            state["close_requested"] = time.monotonic()
            _write(out, result)
            state["window"].close()  # a normal user close, start-at-login off
        # "closing" / "gave-up": nothing more; the product must return from main().

    observer = QTimer()
    observer.setInterval(OBSERVE_INTERVAL_MS)
    observer.timeout.connect(observe)
    observer.start()

    sys.argv = ["silentsuite-bridge"]
    exit_code = None
    result["stage"] = "entrypoint"
    _write(out, result)
    try:
        bridge_main.main(flavor="desktop")
    except SystemExit as exc:
        exit_code = exc.code
    except TypeError as exc:
        # Distinguish "the entrypoint does not take flavor" (raised at the
        # call itself) from a TypeError deep inside the product.
        at_call = exc.__traceback__ is not None and exc.__traceback__.tb_next is None
        result["entry_error"] = {"class": "TypeError", "at_call": at_call, "mentions_flavor": "flavor" in str(exc)}
    except Exception as exc:  # noqa: BLE001
        frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)][-6:]
        result["entry_error"] = {"class": type(exc).__name__, "at_call": False, "frames": frames}
    observer.stop()
    returned = time.monotonic()
    result["stage"] = "after-main"

    # Post-conditions measured in the same process the product ran in.
    lock_path = os.path.join(config.DATA_DIR, "instance.lock")
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        lock_free = bool(config._try_lock_fd(fd))
        if lock_free:
            config._unlock_fd(fd)
    finally:
        os.close(fd)

    port = config.LISTEN_PORT
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            listener_closed = False
    except OSError:
        listener_closed = True

    registry = get_registry()
    from silentsuite_bridge.radicale import storage

    with storage._sync_threads_lock:
        live_workers = [t for t in storage._sync_threads.values() if t.is_alive()]
    stray = [
        t.name for t in threading.enumerate()
        if t is not threading.main_thread() and t.is_alive() and not t.daemon
    ]
    result["after"].update({
        "exit_code": exit_code,
        "close_to_return_seconds": (
            round(returned - state["close_requested"], 2) if "close_requested" in state else None
        ),
        "lock_free": lock_free,
        "listener_closed": listener_closed,
        "registry_stopped": registry.is_stopped,
        "registry_dashboard_url": registry.dashboard_url(False),
        "live_sync_workers": len(live_workers),
        "stray_non_daemon_threads": stray,
    })
    result["traps"] = {"webbrowser_calls": len(browser_calls), "external_open_calls": external_calls}

    foreign.shutdown()
    foreign.server_close()
    foreign_thread.join(5)
    result["stage"] = "done"
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T2 desktop first-window fixture (non-product)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    return run(out)


if __name__ == "__main__":
    sys.exit(main())
