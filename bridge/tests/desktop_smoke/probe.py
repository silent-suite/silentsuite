"""T0 native webview capability probe for the Bridge desktop window (#171).

Throwaway, non-product capability test. It imports nothing from
silentsuite_bridge and touches no Bridge settings, accounts, autostart entries
or services. It answers one question before any product code depends on it:
can a PySide6 / Qt WebEngine window, configured the way the desktop shell
would configure it, stop disallowed navigation, popups and subresource
requests BEFORE they reach a server or execute, expose no application bridge
to page script, and leave no synthetic sensitive marker on disk?

Two synthetic loopback HTTP servers are started on ephemeral ports:
  * ALLOWED stands in for the bound Bridge dashboard origin;
  * FOREIGN stands in for any other origin (another local service).
Every request each server receives is recorded. A disallowed attempt passes
only if the target server never saw the request. Execution checks use canary
requests: a page that should never run would fetch a canary path on ALLOWED,
so a recorded canary proves execution.

Exit codes: 0 all gates passed, 1 a gate failed (or watchdog timeout),
2 a prerequisite is missing (PySide6/Qt WebEngine import). Any other exit
code (for example a Qt abort with no display) means the probe crashed before
reporting; the partial result file records the last stage reached.
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import platform
import secrets
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from pathlib import Path

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_PREREQ = 2

WATCHDOG_SECONDS = 150
HARD_WATCHDOG_SECONDS = WATCHDOG_SECONDS + 45
STEP_SETTLE_MS = 2000
RESET_SETTLE_MS = 300
MAX_SCAN_BYTES = 512 * 1024 * 1024
MAX_FILE_BYTES = 64 * 1024 * 1024


class Recorder:
    """Thread-safe record of requests one fixture server received."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._requests: list[tuple[str, str]] = []

    def add(self, method: str, path: str) -> None:
        with self._lock:
            self._requests.append((method, path))

    def entries(self) -> list[tuple[str, str]]:
        with self._lock:
            return list(self._requests)

    def paths(self) -> list[str]:
        return [urllib.parse.urlsplit(p).path for _, p in self.entries()]


def _make_handler(role: str, recorder: Recorder, ctx: dict):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # keep runner logs quiet
            pass

        def _send(self, code, body=b"", ctype="text/html; charset=utf-8", headers=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_GET(self):
            recorder.add("GET", self.path)
            if role == "allowed" and f"srvprobe={ctx['marker']}" in (self.headers.get("Cookie") or ""):
                # Positive control: the browser accepted the server cookie in memory.
                ctx["cookie_echoed"] = True
            if role == "foreign":
                self._send(200, b"<!doctype html><script>fetch('/foreign-exec')</script>")
                return
            path = urllib.parse.urlsplit(self.path).path
            if path == "/":
                # Long max-age and a persistent cookie deliberately tempt the
                # browser into writing the marker to a disk cache / cookie jar.
                self._send(
                    200,
                    ctx["index_html"].encode("utf-8"),
                    headers={
                        "Set-Cookie": f"srvprobe={ctx['marker']}; Max-Age=86400; Path=/",
                        "Cache-Control": "max-age=3600",
                    },
                )
            elif path == "/redirect":
                self._send(302, headers={"Location": ctx["foreign_base"] + "/redirect-target"})
            elif path == "/download":
                self._send(
                    200,
                    ctx["marker"].encode("ascii"),
                    ctype="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="probe-{ctx["marker"]}.bin"'},
                )
            else:
                self._send(204)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(min(length, 65536))
            recorder.add("POST", self.path)
            self._send(200, b"<!doctype html><p>posted</p>")

    return Handler


def _start_server(role: str, recorder: Recorder, ctx: dict):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(role, recorder, ctx))
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, name=f"t0-{role}", daemon=True)
    thread.start()
    return server, thread


def make_policy(allowed_port: int):
    """The candidate desktop policy: exact loopback origin, no denied paths."""

    def allowed(url: str) -> bool:
        try:
            parts = urllib.parse.urlsplit(url)
            port = parts.port
        except ValueError:
            return False
        if parts.scheme != "http" or parts.hostname != "127.0.0.1" or port != allowed_port:
            return False
        # Stands in for /<account email>/ DAV paths the window must never open.
        return not parts.path.startswith("/denied/")

    return allowed


def _index_html(foreign_base: str, marker: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'><title>T0 probe</title></head><body>"
        f"<a id='ext' href='{foreign_base}/nav-link'>external</a>"
        f"<a id='blank' href='{foreign_base}/popup-link' target='_blank'>blank external</a>"
        "<a id='blankallowed' href='/popup-allowed-link' target='_blank'>blank same origin</a>"
        f"<form id='f' method='post' action='{foreign_base}/form'><input name='a' value='b'></form>"
        "<form id='login' method='post' action='/login'>"
        "<input name='email' value='probe@example.invalid'>"
        f"<input type='password' name='password' value='{marker}'>"
        "</form></body></html>"
    )


def _write_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _scan_for_marker(roots: list[str], marker: str) -> tuple[list[str], int, list[str], int]:
    """Return (files containing the marker, bytes scanned, roots scanned, files skipped).

    A skipped file (too large, over the total budget, unreadable) is counted so
    a truncated scan can never be reported as a clean one.
    """
    needles = [marker.encode("ascii"), marker.encode("utf-16-le")]
    hits: list[str] = []
    scanned = 0
    skipped = 0
    seen_roots: list[str] = []
    seen_files: set[str] = set()
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        real_root = os.path.realpath(root)
        if real_root in seen_roots:
            continue
        seen_roots.append(real_root)
        for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
            for name in filenames:
                full = os.path.join(dirpath, name)
                # Roots can nest (the isolated HOME holds Qt's app paths); scan each file once.
                if full in seen_files:
                    continue
                seen_files.add(full)
                if marker in name:
                    hits.append(full)
                    continue
                try:
                    if os.path.islink(full) or not os.path.isfile(full):
                        continue
                    size = os.path.getsize(full)
                    if size > MAX_FILE_BYTES or scanned + size > MAX_SCAN_BYTES:
                        skipped += 1
                        continue
                    with open(full, "rb") as handle:
                        data = handle.read()
                except OSError:
                    skipped += 1
                    continue
                scanned += len(data)
                if any(n in data for n in needles):
                    hits.append(full)
    return hits, scanned, seen_roots, skipped


def run_probe(out_path: Path, isolated_root: Path, mode: str) -> int:
    result: dict = {
        "probe": "bridge-desktop-t0",
        "mode": mode,
        "frozen": bool(getattr(sys, "frozen", False)),
        "platform": {"system": platform.system(), "machine": platform.machine(), "python": platform.python_version()},
        "stage": "import",
        "gates": {},
        "info": {},
    }
    _write_json(out_path, result)

    def hard_watchdog():
        result["stage"] = result.get("stage", "?") + ":hard-watchdog"
        result["outcome"] = "timeout"
        try:
            _write_json(out_path, result)
        finally:
            os._exit(EXIT_FAIL)  # probe-only: the Qt loop did not return in time

    hard = threading.Timer(HARD_WATCHDOG_SECONDS, hard_watchdog)
    hard.daemon = True
    hard.start()

    try:
        import PySide6
        from PySide6.QtCore import QCoreApplication, QObject, QStandardPaths, Qt, QTimer, QUrl, Slot, qVersion
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtWebEngineCore import (
            QWebEnginePage,
            QWebEngineProfile,
            QWebEngineSettings,
            QWebEngineUrlRequestInterceptor,
        )
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication
    except Exception as exc:  # noqa: BLE001 - classify any import failure as a prerequisite
        result["outcome"] = "prerequisite-missing"
        result["info"]["import_error"] = type(exc).__name__
        _write_json(out_path, result)
        hard.cancel()
        return EXIT_PREREQ

    marker = "t0marker" + secrets.token_hex(12)
    allowed_rec, foreign_rec = Recorder(), Recorder()
    ctx: dict = {"marker": marker}
    foreign_server, foreign_thread = _start_server("foreign", foreign_rec, ctx)
    foreign_base = f"http://127.0.0.1:{foreign_server.server_address[1]}"
    ctx["foreign_base"] = foreign_base
    ctx["index_html"] = _index_html(foreign_base, marker)
    allowed_server, allowed_thread = _start_server("allowed", allowed_rec, ctx)
    allowed_port = allowed_server.server_address[1]
    allowed_base = f"http://127.0.0.1:{allowed_port}"
    policy = make_policy(allowed_port)

    nav_log: list[dict] = []
    blocked: list[str] = []
    blocked_lock = threading.Lock()
    popup_log: list[dict] = []
    external_calls: list[str] = []
    download_log: list[str] = []
    load_events: list[bool] = []
    step_urls: dict = {}
    step_errors: dict = {}
    max_windows = {"n": 0}
    pending: dict = {}
    # "name" tags every navigation, interceptor and popup event with the step
    # that caused it, so each blocked step must show its own attempt evidence.
    state = {"i": -1, "timed_out": False, "name": ""}

    result["stage"] = "qapplication"
    _write_json(out_path, result)
    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    QCoreApplication.setOrganizationName("SilentSuiteProbe")
    QCoreApplication.setApplicationName("BridgeDesktopT0Probe")
    app = QApplication([sys.argv[0]])

    class Interceptor(QWebEngineUrlRequestInterceptor):
        def interceptRequest(self, info):  # noqa: N802 - Qt override
            url = info.requestUrl().toString()
            if not policy(url):
                info.block(True)
                with blocked_lock:
                    blocked.append({"step": state["name"], "url": url[:200]})

    class GuardedPage(QWebEnginePage):
        def acceptNavigationRequest(self, url, nav_type, is_main_frame):  # noqa: N802
            text = url.toString()
            ok = policy(text)
            nav_log.append({
                "step": state["name"], "url": text[:200], "type": str(nav_type),
                "main": bool(is_main_frame), "accepted": ok,
            })
            return ok

        def createWindow(self, window_type):  # noqa: N802
            popup_log.append({"step": state["name"], "via": "createWindow", "type": str(window_type)})
            return None

    class ExternalTrap(QObject):
        @Slot(QUrl)
        def handle(self, url):
            external_calls.append(url.toString()[:200])

    profile = QWebEngineProfile(app)  # no storage name: off-the-record by Qt contract
    interceptor = Interceptor(profile)
    profile.setUrlRequestInterceptor(interceptor)

    def on_download(request):
        download_log.append("requested")
        try:
            request.cancel()
            download_log.append("cancelled")
        except Exception as exc:  # noqa: BLE001
            download_log.append("cancel-error:" + type(exc).__name__)

    profile.downloadRequested.connect(on_download)

    page = GuardedPage(profile, app)

    def on_new_window(request):
        entry = {"step": state["name"], "via": "newWindowRequested"}
        try:
            entry["has_requested_url"] = bool(request.requestedUrl().toString())
        except Exception as exc:  # noqa: BLE001
            entry["requested_url_error"] = type(exc).__name__
        popup_log.append(entry)

    try:
        page.newWindowRequested.connect(on_new_window)
        result["info"]["new_window_signal"] = True
    except AttributeError:
        result["info"]["new_window_signal"] = False

    hardening = {}
    settings = page.settings()
    for name, value in (
        ("JavascriptCanOpenWindows", False),
        ("LocalContentCanAccessRemoteUrls", False),
        ("LocalContentCanAccessFileUrls", False),
    ):
        attr = getattr(QWebEngineSettings.WebAttribute, name, None)
        if attr is None:
            hardening[name] = "attribute-missing"
            continue
        settings.setAttribute(attr, value)
        hardening[name] = bool(settings.testAttribute(attr))
    result["info"]["settings_readback"] = hardening

    trap = ExternalTrap()
    for scheme in ("http", "https", "file", "mailto"):
        QDesktopServices.setUrlHandler(scheme, trap, "handle")

    view = QWebEngineView()
    view.setPage(page)
    view.resize(900, 650)
    view.setWindowTitle("Bridge desktop T0 probe")
    view.show()

    def visible_windows() -> int:
        return len([w for w in QApplication.topLevelWidgets() if w.isVisible()])

    def wrap_js(name: str, action_js: str) -> str:
        # Report "ran" BEFORE the attempt, then run it; a thrown error is
        # reported too. A blocked step only counts if its script really ran
        # inside the allowed page, otherwise "zero foreign requests" could
        # merely mean the action never executed.
        return (
            "fetch('/report?step=ran&name=" + name + "').finally(function(){try{" + action_js + "}"
            "catch(e){fetch('/report?step=err&name=" + name + "&e='+encodeURIComponent(e.name));}});"
        )

    def js(name: str, action_js: str):
        return lambda: page.runJavaScript(wrap_js(name, action_js))

    def open_with_js_windows_enabled():
        # With JavascriptCanOpenWindows off, Chromium refuses window.open before
        # Qt's createWindow is ever consulted. Enable it for this one step so
        # the createWindow/newWindowRequested layer itself is exercised.
        attr = getattr(QWebEngineSettings.WebAttribute, "JavascriptCanOpenWindows", None)
        if attr is None:
            raise RuntimeError("JavascriptCanOpenWindows attribute missing")
        settings.setAttribute(attr, True)
        page.runJavaScript(wrap_js(
            "window_open_with_js_windows_enabled",
            "var w=window.open('" + foreign_base + "/popup-enabled');"
            "fetch('/report?step=ret&name=window_open_with_js_windows_enabled&ret='+(w?'window':'null'));",
        ))
        QTimer.singleShot(STEP_SETTLE_MS - 300, lambda: settings.setAttribute(attr, False))

    canary_data = f'<script>fetch({json.dumps(allowed_base + "/canary-data")},{{mode:"no-cors"}})</script>'
    data_url = "data:text/html," + urllib.parse.quote(canary_data)
    file_page = isolated_root / "t0-file-page.html"
    file_page.write_text(
        f'<script>fetch({json.dumps(allowed_base + "/canary-file")},{{mode:"no-cors"}})</script>',
        encoding="utf-8",
    )
    storage_js = (
        "(function(){var m=" + json.dumps(marker) + ";"
        "document.cookie='jsprobe='+m+'; max-age=86400; path=/';"
        # Positive controls: each write must be read back in the page.
        "var ck=(document.cookie.indexOf(m)>=0)?'ok':'missing';var ls='ok';"
        "try{localStorage.setItem('probe',m);sessionStorage.setItem('probe',m);"
        "if(localStorage.getItem('probe')!==m||sessionStorage.getItem('probe')!==m){ls='mismatch';}}"
        "catch(e){ls='error';}"
        "function done(s){fetch('/report?step=storage-done&idb='+s+'&ls='+ls+'&ck='+ck);}"
        "try{var r=indexedDB.open('probe',1);"
        "r.onupgradeneeded=function(){r.result.createObjectStore('s');};"
        "r.onsuccess=function(){var t=r.result.transaction('s','readwrite');"
        "t.objectStore('s').put(m,'k');t.oncomplete=function(){done('ok');};t.onerror=function(){done('error');};};"
        "r.onerror=function(){done('open-error');};}catch(e){done('exception');}})();"
    )
    exposure_js = (
        "fetch('/report?step=exposure'"
        "+'&qt='+(typeof window.qt)"
        "+'&qtwct='+((window.qt&&window.qt.webChannelTransport)?'present':'absent')"
        "+'&pywebview='+(typeof window.pywebview)"
        "+'&chromewebview='+((window.chrome&&window.chrome.webview)?'present':'absent'));"
    )

    def open_ret(name: str, target: str) -> str:
        return "var w=window.open('" + target + "');fetch('/report?step=ret&name=" + name + "&ret='+(w?'window':'null'));"

    steps = [
        ("js_location_foreign", js("js_location_foreign", f"location.href='{foreign_base}/nav-js';")),
        ("link_click_foreign", js("link_click_foreign", "document.getElementById('ext').click();")),
        ("blank_link_foreign", js("blank_link_foreign", "document.getElementById('blank').click();")),
        ("blank_link_same_origin", js("blank_link_same_origin", "document.getElementById('blankallowed').click();")),
        ("window_open_foreign", js("window_open_foreign", open_ret("window_open_foreign", foreign_base + "/popup-open"))),
        ("window_open_same_origin", js("window_open_same_origin", open_ret("window_open_same_origin", "/popup-allowed-open"))),
        ("window_open_with_js_windows_enabled", open_with_js_windows_enabled),
        ("form_post_foreign", js("form_post_foreign", "document.getElementById('f').submit();")),
        ("iframe_foreign", js(
            "iframe_foreign",
            f"var i=document.createElement('iframe');i.src='{foreign_base}/frame';document.body.appendChild(i);")),
        ("subresources_foreign", js(
            "subresources_foreign",
            f"fetch('{foreign_base}/fetch',{{mode:'no-cors'}}).catch(function(){{}});"
            f"var m=new Image();m.src='{foreign_base}/img';")),
        ("redirect_to_foreign", js("redirect_to_foreign", "location.href='/redirect';")),
        ("same_origin_denied_path", js("same_origin_denied_path", "location.href='/denied/account@example.invalid/';")),
        ("data_url", js("data_url", "location.href=" + json.dumps(data_url) + ";")),
        ("file_url", js("file_url", "location.href=" + json.dumps(file_page.resolve().as_uri()) + ";")),
        ("app_load_foreign", lambda: view.load(QUrl(foreign_base + "/app-load"))),
        ("javascript_url_informational", js("javascript_url_informational", "location.href=\"javascript:fetch('/canary-js')\";")),
        ("exposure_report", js("exposure_report", exposure_js)),
        ("storage_markers", js("storage_markers", storage_js)),
        ("password_form_submit", js("password_form_submit", "document.getElementById('login').submit();")),
        ("download_attempt", js("download_attempt", "location.href='/download';")),
    ]

    def on_load_finished(ok):
        load_events.append(bool(ok))
        callback = pending.pop("cb", None)
        if callback is not None:
            QTimer.singleShot(RESET_SETTLE_MS, callback)

    page.loadFinished.connect(on_load_finished)

    def load_index_then(callback):
        pending["cb"] = callback
        view.load(QUrl(allowed_base + "/"))

    def after_step(name):
        step_urls[name] = page.url().toString()[:200]
        max_windows["n"] = max(max_windows["n"], visible_windows())
        next_step()

    def next_step():
        if state["timed_out"]:
            return
        state["i"] += 1
        if state["i"] >= len(steps):
            finish()
            return
        name, action = steps[state["i"]]
        state["name"] = name
        result["stage"] = "step:" + name
        _write_json(out_path, result)

        def do_action():
            try:
                action()
            except Exception as exc:  # noqa: BLE001
                step_errors[name] = type(exc).__name__
            QTimer.singleShot(STEP_SETTLE_MS, lambda: after_step(name))

        load_index_then(do_action)

    profile_info: dict = {}
    scan_roots: list[str] = [str(isolated_root)]

    def collect_profile_info():
        profile_info["off_the_record"] = bool(profile.isOffTheRecord())
        profile_info["memory_http_cache"] = profile.httpCacheType() == QWebEngineProfile.HttpCacheType.MemoryHttpCache
        profile_info["no_persistent_cookies"] = (
            profile.persistentCookiesPolicy() == QWebEngineProfile.PersistentCookiesPolicy.NoPersistentCookies
        )
        for getter in ("persistentStoragePath", "cachePath", "downloadPath"):
            try:
                path = getattr(profile, getter)()
            except Exception:  # noqa: BLE001
                path = ""
            profile_info[getter + "_set"] = bool(path)
            if path:
                scan_roots.append(path)
        for location in ("AppDataLocation", "AppLocalDataLocation", "CacheLocation"):
            loc = getattr(QStandardPaths.StandardLocation, location, None)
            if loc is not None:
                scan_roots.append(QStandardPaths.writableLocation(loc))

    def finish():
        result["stage"] = "finish"
        collect_profile_info()
        max_windows["n"] = max(max_windows["n"], visible_windows())
        view.close()
        app.quit()

    def soft_timeout():
        if state["i"] < len(steps):
            state["timed_out"] = True
            result["stage"] = result.get("stage", "?") + ":timeout"
            try:
                collect_profile_info()
            except Exception:  # noqa: BLE001
                pass
            view.close()
            app.quit()

    QTimer.singleShot(WATCHDOG_SECONDS * 1000, soft_timeout)
    QTimer.singleShot(0, next_step)

    result["stage"] = "event-loop"
    _write_json(out_path, result)
    started = time.monotonic()
    app.exec()
    elapsed = round(time.monotonic() - started, 1)

    # Teardown: release the page before its profile, then stop fixtures.
    try:
        view.setPage(None)
    except Exception:  # noqa: BLE001 - binding may reject None; deleteLater still releases
        pass
    view.deleteLater()
    page.deleteLater()
    profile.deleteLater()
    app.processEvents()
    for server in (allowed_server, foreign_server):
        server.shutdown()
        server.server_close()
    allowed_thread.join(5)
    foreign_thread.join(5)
    servers_stopped = not allowed_thread.is_alive() and not foreign_thread.is_alive()

    result["stage"] = "scan"
    _write_json(out_path, result)
    marker_hits, scanned_bytes, scanned_roots, scan_skipped = _scan_for_marker(scan_roots, marker)
    # Scanner positive control: a different random marker, written by the probe
    # itself in ASCII and UTF-16LE, must be found. Proves the scan can see a hit.
    control = "t0control" + secrets.token_hex(12)
    (isolated_root / "t0-scan-control-ascii.bin").write_bytes(control.encode("ascii"))
    (isolated_root / "t0-scan-control-utf16.bin").write_bytes(control.encode("utf-16-le"))
    control_hits, _, _, _ = _scan_for_marker([str(isolated_root)], control)

    allowed_paths = allowed_rec.paths()
    allowed_entries = allowed_rec.entries()
    foreign_entries = foreign_rec.entries()

    def allowed_hits(prefix: str) -> list[str]:
        return [p for p in allowed_paths if p.startswith(prefix)]

    report_qs = [
        dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(p).query))
        for _, p in allowed_entries
        if urllib.parse.urlsplit(p).path == "/report"
    ]
    exposure = [q for q in report_qs if q.get("step") == "exposure"]
    storage_done = [q for q in report_qs if q.get("step") == "storage-done"]
    exp = exposure[0] if exposure else {}
    sto = storage_done[0] if storage_done else {}
    ran = {q.get("name") for q in report_qs if q.get("step") == "ran"}
    js_errors = {q.get("name"): q.get("e") for q in report_qs if q.get("step") == "err"}
    rets = {q.get("name"): q.get("ret") for q in report_qs if q.get("step") == "ret"}
    js_steps = [name for name, _ in steps if name != "app_load_foreign"]

    def nav_rejected(step: str, needle: str) -> bool:
        return any(n["step"] == step and not n["accepted"] and needle in n["url"] for n in nav_log)

    def intercepted(step: str, needle: str) -> bool:
        with blocked_lock:
            return any(b["step"] == step and needle in b["url"] for b in blocked)

    # Attempt evidence: each blocked outcome must be matched by proof that the
    # attempt reached a Qt enforcement layer (or, for window.open, that the
    # page saw a null window). Zero foreign requests alone is not enough.
    evidence = {
        "js_location_foreign": nav_rejected("js_location_foreign", "/nav-js"),
        "link_click_foreign": nav_rejected("link_click_foreign", "/nav-link"),
        "form_post_foreign": nav_rejected("form_post_foreign", "/form"),
        "iframe_foreign": nav_rejected("iframe_foreign", "/frame") or intercepted("iframe_foreign", "/frame"),
        "subresources_foreign": intercepted("subresources_foreign", "/fetch")
        and intercepted("subresources_foreign", "/img"),
        "redirect_to_foreign": "/redirect" in allowed_paths
        and (nav_rejected("redirect_to_foreign", "/redirect-target")
             or intercepted("redirect_to_foreign", "/redirect-target")),
        "same_origin_denied_path": nav_rejected("same_origin_denied_path", "/denied/"),
        "app_load_foreign": nav_rejected("app_load_foreign", "/app-load"),
        "window_open_foreign": rets.get("window_open_foreign") == "null",
        "window_open_same_origin": rets.get("window_open_same_origin") == "null",
        "window_open_with_js_windows_enabled": any(
            p.get("step") == "window_open_with_js_windows_enabled" for p in popup_log
        ),
    }

    gates = {
        "every_js_step_ran_in_allowed_page": all(name in ran for name in js_steps),
        "no_js_step_errors": not js_errors,
        **{"attempt_evidence_" + key: bool(value) for key, value in evidence.items()},
        "allowed_page_loaded": "/" in allowed_paths and any(load_events),
        "foreign_origin_never_contacted": len(foreign_entries) == 0,
        "denied_same_origin_path_never_requested": not allowed_hits("/denied/"),
        "data_url_did_not_execute": not allowed_hits("/canary-data"),
        "file_url_did_not_execute": not allowed_hits("/canary-file"),
        "same_origin_popups_never_requested": not allowed_hits("/popup-allowed-"),
        "no_extra_top_level_window": max_windows["n"] <= 1,
        "no_external_open_attempt": not external_calls,
        "exposure_reported": bool(exposure),
        "no_qt_webchannel_transport": exp.get("qtwct") == "absent",
        "no_pywebview_api": exp.get("pywebview") == "undefined",
        "no_chrome_webview_bridge": exp.get("chromewebview") == "absent",
        "off_the_record_effective": bool(
            profile_info.get("off_the_record")
            and profile_info.get("memory_http_cache")
            and profile_info.get("no_persistent_cookies")
        ),
        "storage_writes_confirmed_in_page": sto.get("idb") == "ok" and sto.get("ls") == "ok" and sto.get("ck") == "ok",
        "server_cookie_accepted_in_memory": bool(ctx.get("cookie_echoed")),
        "password_form_posted": ("POST", "/login") in [(m, urllib.parse.urlsplit(p).path) for m, p in allowed_entries],
        "scanner_positive_control_found": len(control_hits) == 2,
        "marker_scan_complete": scan_skipped == 0 and bool(scanned_roots),
        "no_sensitive_marker_on_disk": not marker_hits,
        "download_requested_and_cancelled": "cancelled" in download_log,
        "no_step_exceptions": not step_errors,
        "finished_before_watchdog": not state["timed_out"],
        "fixture_servers_stopped": servers_stopped,
    }
    result["gates"] = gates
    result["info"].update({
        "pyside6_version": getattr(PySide6, "__version__", "unknown"),
        "qt_version": qVersion(),
        "elapsed_seconds": elapsed,
        "profile": profile_info,
        "navigation_log": nav_log,
        "navigation_rejections": len([n for n in nav_log if not n["accepted"]]),
        "interceptor_blocked_count": len(blocked),
        "popup_log": popup_log,
        "external_open_attempts": len(external_calls),
        "download_log": download_log,
        "step_urls": step_urls,
        "step_errors": step_errors,
        "exposure": exp,
        "typeof_window_qt": exp.get("qt"),
        "storage_report": sto,
        "js_steps_ran": sorted(n for n in ran if n),
        "js_step_errors": js_errors,
        "window_open_returns": rets,
        "interceptor_blocked": blocked[:60],
        "scan_skipped_files": scan_skipped,
        # Non-gating: javascript: URLs run in the current page's own context;
        # the navigation layer is not expected to see them. Product pages must
        # simply not contain them.
        "javascript_url_executed_in_page": bool(allowed_hits("/canary-js")),
        "marker_hit_count": len(marker_hits),
        "marker_hit_files": [os.path.basename(h) for h in marker_hits][:20],
        "scanned_roots_count": len(scanned_roots),
        "scanned_bytes": scanned_bytes,
        "qtwebengine_chromium_flags": os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", ""),
        "remote_debugging_env_set": "QTWEBENGINE_REMOTE_DEBUGGING" in os.environ,
    })
    passed = all(gates.values())
    result["outcome"] = "pass" if passed else ("timeout" if state["timed_out"] else "assertion-failed")
    result["stage"] = "done"
    _write_json(out_path, result)
    hard.cancel()
    failed = sorted(k for k, v in gates.items() if not v)
    print(f"T0 probe ({mode}, frozen={result['frozen']}): {result['outcome']}")
    if failed:
        print("Failed gates: " + ", ".join(failed))
    return EXIT_PASS if passed else EXIT_FAIL


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Bridge desktop T0 capability probe (non-product)")
    parser.add_argument("--out", required=True, help="Result JSON path")
    parser.add_argument("--isolated-root", default=os.environ.get("PROBE_ISOLATED_ROOT", ""))
    parser.add_argument("--mode", default="source", choices=["source", "frozen"])
    args = parser.parse_args(argv)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    root = Path(args.isolated_root) if args.isolated_root else Path(tempfile.mkdtemp(prefix="t0-probe-"))
    root.mkdir(parents=True, exist_ok=True)
    try:
        return run_probe(out_path, root, args.mode)
    except Exception as exc:  # noqa: BLE001
        try:
            payload = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
        except (OSError, ValueError):
            payload = {}
        payload["outcome"] = "probe-error"
        payload["error_class"] = type(exc).__name__
        payload["error_frames"] = [
            f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)
        ][-6:]
        _write_json(out_path, payload)
        print(f"T0 probe error: {type(exc).__name__}")
        return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
