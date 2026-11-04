"""T3 default-server UI fixture (#171): the real desktop dashboard, driven like a user.

Runs the REAL ``main(flavor="desktop")`` with no account. Once the owner's
own window shows its registry-bound dashboard, a driver runs JavaScript in the
page through QWebEnginePage.runJavaScript. That is operator-side test control:
the page itself gets no bridge. The driver reads the DOM, sets field values,
dispatches input/change events and clicks real buttons. It then checks the
effects through the real loopback settings API (Host and CSRF gated, as the
page uses it) and the synthetic DATA_DIR's settings.json. It never signs in,
never submits the login form and never contacts any server URL it enters (all
of them are under .invalid).

Modes (one per process):
  editable  no server URL in the environment: built-in default, editable
  managed   SILENTSUITE_SERVER_URL is set by the parent: read-only default

Planned UI interface (the source does not have it yet). The dedicated
control is found by meaning, not by a pre-existing id:
- an <input> OUTSIDE #dashboardLoginForm whose accessible label (<label for>,
  aria-label or aria-labelledby) contains "default server";
- in its nearest form/fieldset/section/[role=group]/[role=region] container
  (never the login form): a button whose text contains "Save", and a status
  element (role="status" or aria-live) other than #accountActionStatus.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog.
"""

import argparse
import hashlib
import json
import os
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
WATCHDOG_SECONDS = 150
TICK_MS = 100
BRAND = "SilentSuite Bridge"
DASHBOARD_DEADLINE_SECONDS = 60
STEP_SECONDS = 10  # bound on every UI acknowledgement wait
JS_CALL_SECONDS = 5  # a runJavaScript callback that never arrives counts as no result
SAVED_DEFAULT = "https://new-sign-ins.t3-ui.invalid"
INVALID_DEFAULT = "ftp://not-allowed.t3-ui.invalid"
MANAGED_DEFAULT = "https://managed.t3-ui.invalid"  # the parent sets SILENTSUITE_SERVER_URL to this

# --- page-side driver snippets (operator-side; return JSON strings) --------

INSTALL_DRIVER_JS = r"""(function(mark){
  if (!window.__t3Driver) {
    window.__t3Driver = {marker: mark, errors: []};
    window.addEventListener('error', function(e) {
      var d = window.__t3Driver; if (d.errors.length < 10) d.errors.push(String(e.message || 'error').slice(0, 200));
    });
    window.addEventListener('unhandledrejection', function(e) {
      var d = window.__t3Driver; var r = e.reason;
      if (d.errors.length < 10) d.errors.push(('rejection: ' + String((r && r.message) || r)).slice(0, 200));
    });
  }
  return JSON.stringify({marker: window.__t3Driver.marker});
})(%s)"""

PAGE_STATE_JS = r"""(function(){
  var sel = document.getElementById('syncInterval');
  var login = document.getElementById('dashboardServerUrl');
  return JSON.stringify({
    title: document.title, path: location.pathname, origin: location.origin, ready: document.readyState,
    csrf: typeof window.SILENTSUITE_DASHBOARD_CSRF === 'string' && window.SILENTSUITE_DASHBOARD_CSRF.length > 0,
    scriptRan: typeof updateInterval === 'function' && typeof showLoginPanel === 'function'
      && !!(sel && sel.getAttribute('data-saved')),
    qtObject: typeof window.qt !== 'undefined',
    marker: window.__t3Driver ? window.__t3Driver.marker : null,
    errors: window.__t3Driver ? window.__t3Driver.errors.slice(0, 10) : [],
    loginServerUrl: login ? login.value : null
  });
})()"""

INTERVAL_SAVE_JS = r"""(function(){
  var s = document.getElementById('syncInterval');
  if (!s || !document.getElementById('syncIntervalStatus')) return JSON.stringify({triggered: false});
  var v = s.getAttribute('data-saved');
  s.value = v;
  s.dispatchEvent(new Event('change', {bubbles: true}));
  return JSON.stringify({triggered: true, value: v});
})()"""

INTERVAL_STATUS_JS = r"""JSON.stringify({status: ((document.getElementById('syncIntervalStatus') || {}).textContent || '').slice(0, 200)})"""

# Shared locator for the planned dedicated control (see module docstring).
LOCATE_JS = r"""
function t3Locate() {
  var login = document.getElementById('dashboardLoginForm');
  function outside(el) { return !(login && login.contains(el)); }
  function labelText(el) {
    var parts = [];
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].textContent);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    (el.getAttribute('aria-labelledby') || '').split(/\s+/).forEach(function(id) {
      var n = id && document.getElementById(id); if (n) parts.push(n.textContent);
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  function shown(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      && getComputedStyle(el).visibility !== 'hidden';
  }
  var inputs = [].slice.call(document.querySelectorAll('input')).filter(function(el) {
    return outside(el) && /default server/i.test(labelText(el));
  });
  var r = {candidates: inputs.length, input: null, group: null, button: null, status: null,
           label: null, shown: shown};
  if (!inputs.length) return r;
  r.input = inputs[0];
  r.label = labelText(r.input);
  var group = r.input.closest('form,fieldset,section,[role="group"],[role="region"]');
  if (!group || group === login || (login && group.contains(login))) return r;
  r.group = group;
  r.button = [].slice.call(group.querySelectorAll('button,input[type="submit"],input[type="button"]'))
    .filter(function(b) { return outside(b) && /\bsave\b/i.test(b.textContent || b.value || ''); })[0] || null;
  r.status = [].slice.call(group.querySelectorAll('[role="status"],[aria-live]'))
    .filter(function(s) { return outside(s) && s.id !== 'accountActionStatus'; })[0] || null;
  return r;
}
"""

DISCOVER_JS = LOCATE_JS + r"""(function(){
  var d = t3Locate();
  var out = {candidates: d.candidates, inputFound: !!d.input, groupFound: !!d.group,
             buttonFound: !!d.button, statusFound: !!d.status};
  if (d.input) {
    out.label = (d.label || '').slice(0, 200);
    out.value = d.input.value;
    out.readOnly = !!d.input.readOnly;
    out.disabled = !!d.input.disabled;
    out.inputShown = d.shown(d.input);
  }
  if (d.button) { out.buttonDisabled = !!d.button.disabled; out.buttonShown = d.shown(d.button); }
  if (d.status) out.statusText = (d.status.textContent || '').slice(0, 200);
  if (d.group) out.groupText = (d.group.innerText || d.group.textContent || '').replace(/\s+/g, ' ').slice(0, 600);
  return JSON.stringify(out);
})()"""

SET_AND_SAVE_JS = LOCATE_JS + r"""(function(v){
  var d = t3Locate();
  if (!d.input || !d.button) return JSON.stringify({clicked: false});
  var before = d.status ? (d.status.textContent || '') : '';
  var wasEnabled = !d.input.readOnly && !d.input.disabled && !d.button.disabled;
  if (!d.input.readOnly && !d.input.disabled) {
    d.input.focus();
    d.input.value = v;
    d.input.dispatchEvent(new Event('input', {bubbles: true}));
    d.input.dispatchEvent(new Event('change', {bubbles: true}));
  }
  d.button.click();  // a disabled button ignores the click, as it would a user's
  return JSON.stringify({clicked: true, controlsEnabled: wasEnabled, statusBefore: before.slice(0, 200)});
})(%s)"""

CONTROL_STATUS_JS = LOCATE_JS + r"""(function(){
  var d = t3Locate();
  return JSON.stringify({
    status: d.status ? (d.status.textContent || '').slice(0, 200) : null,
    value: d.input ? d.input.value : null
  });
})()"""

RELOAD_JS = r"""(function(){ location.reload(); return 'reloading'; })()"""


def _write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _settled(text):
    """A status that is no longer in progress: non-empty and not 'Saving...'."""
    return bool(text) and "saving" not in text.lower()


def run(args) -> int:
    out = Path(args.out)
    result = {"mode": args.mode, "stage": "prereq", "prereq": {}, "entry_error": None, "steps": {}}
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
    if sys.platform != "win32" and (not home or os.path.expanduser("~") != home or "t3ui" not in home):
        result["prereq"]["isolated_home"] = False
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ
    env_server = os.environ.get("SILENTSUITE_SERVER_URL")
    if (args.mode == "managed") != (env_server == MANAGED_DEFAULT) or (args.mode == "editable" and env_server):
        result["prereq"]["server_url_environment"] = False
        _write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import config
    from silentsuite_bridge.radicale.server import get_registry

    steps = result["steps"]

    def http_get_settings(base):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(base + "/.web/api/settings", timeout=10) as response:
                return [response.status, json.loads(response.read())]
        except urllib.error.HTTPError as exc:
            return [exc.code, None]
        except (OSError, ValueError) as exc:
            return [None, type(exc).__name__]

    def settings_file():
        try:
            raw = Path(config.SETTINGS_FILE).read_bytes()
        except FileNotFoundError:
            return {"exists": False}
        data = json.loads(raw)
        return {
            "exists": True,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "has_serverUrl": "serverUrl" in data,
            "serverUrl": data.get("serverUrl"),
            "syncInterval": data.get("syncInterval"),
        }

    # --- generator-driven journey (one runJavaScript at a time) -----------
    state = {"phase": "wait", "started": time.monotonic(), "window": None, "view": None,
             "gen": None, "busy": False, "busy_since": 0.0, "value": None, "wake": 0.0}

    def parse(value):
        try:
            return json.loads(value) if isinstance(value, str) else None
        except ValueError:
            return None

    def wait_js(code, done, seconds=STEP_SECONDS):
        """Re-run ``code`` until ``done(parsed)`` or the bound passes; returns (parsed, met)."""
        deadline = time.monotonic() + seconds
        while True:
            parsed = parse((yield ("js", code)))
            if parsed is not None and done(parsed):
                return parsed, True
            if time.monotonic() > deadline:
                return parsed, False
            yield ("sleep", 0.2)

    def load_page(marker, base):
        page, met = yield from wait_js(
            PAGE_STATE_JS,
            lambda s: s["ready"] == "complete" and s["marker"] is None and s["title"] == BRAND,
            DASHBOARD_DEADLINE_SECONDS if marker == "load-1" else STEP_SECONDS,
        )
        if not met:
            return None
        yield ("js", INSTALL_DRIVER_JS % json.dumps(marker))
        page = parse((yield ("js", PAGE_STATE_JS)))
        if page is not None:
            page["origin_is_dashboard"] = page.get("origin") == base
        return page

    def journey(base):
        page = yield from load_page("load-1", base)
        steps["page"] = page
        steps["web_channel_absent"] = state["view"].page().webChannel() is None
        if not page or page.get("marker") != "load-1":
            steps["driver_error"] = "the dashboard page never reached a complete, driveable state"
            return
        steps["get_before"] = http_get_settings(base)
        steps["settings_before"] = settings_file()

        if args.mode == "editable":
            # Positive admission control: the existing interval selector saves its
            # unchanged value through the page script, the API and settings.json.
            steps["interval_trigger"] = parse((yield ("js", INTERVAL_SAVE_JS)))
            status, met = yield from wait_js(INTERVAL_STATUS_JS, lambda s: _settled(s["status"]))
            steps["interval_status"] = {"status": (status or {}).get("status"), "settled": met}
            steps["interval_settings"] = settings_file()
            steps["interval_get"] = http_get_settings(base)

        discovery = parse((yield ("js", DISCOVER_JS)))
        if discovery is None:
            steps["driver_error"] = "the control discovery script returned no result"
            return
        steps["discovery"] = discovery
        if not discovery.get("inputFound"):
            return  # nothing more to drive; the parent decides RED / NOT REACHED

        if args.mode == "managed":
            steps["managed_attempt"] = parse((yield ("js", SET_AND_SAVE_JS % json.dumps(SAVED_DEFAULT))))
            yield ("sleep", 1.5)  # bounded window for a wrongly accepted save to land
            steps["managed_after"] = {
                "control": parse((yield ("js", CONTROL_STATUS_JS))),
                "settings": settings_file(),
                "get": http_get_settings(base),
            }
            return

        if not (discovery.get("buttonFound") and discovery.get("statusFound")):
            return
        # Valid save: type the synthetic default, click Save, wait for the status.
        steps["save_click"] = parse((yield ("js", SET_AND_SAVE_JS % json.dumps(SAVED_DEFAULT))))
        before = (steps["save_click"] or {}).get("statusBefore", "")
        status, met = yield from wait_js(
            CONTROL_STATUS_JS, lambda s: _settled(s["status"]) and s["status"] != before)
        steps["save_status"] = {"status": (status or {}).get("status"), "settled": met}
        steps["save_settings"] = settings_file()
        steps["save_get"] = http_get_settings(base)

        # Reload: the dedicated control and the login form's default both show it.
        yield ("js", RELOAD_JS)
        reloaded = yield from load_page("load-2", base)
        steps["reload_page"] = reloaded
        if not reloaded or reloaded.get("marker") != "load-2":
            steps["driver_error"] = "the dashboard did not come back after reload"
            return
        steps["reload_control"] = parse((yield ("js", CONTROL_STATUS_JS)))

        # Invalid value on the fresh page: never "Saved", the saved default kept.
        steps["invalid_click"] = parse((yield ("js", SET_AND_SAVE_JS % json.dumps(INVALID_DEFAULT))))
        before = (steps["invalid_click"] or {}).get("statusBefore", "")
        status, met = yield from wait_js(
            CONTROL_STATUS_JS, lambda s: _settled(s["status"]) and s["status"] != before)
        steps["invalid_status"] = {"status": (status or {}).get("status"), "changed": met}
        steps["invalid_settings"] = settings_file()
        steps["invalid_get"] = http_get_settings(base)
        steps["final_page"] = parse((yield ("js", PAGE_STATE_JS)))

    def on_js(value):
        state["value"] = value
        state["busy"] = False

    def advance():
        try:
            kind, arg = state["gen"].send(state.pop("value", None))
        except StopIteration:
            state["phase"] = "closing"
            state["window"].close()  # a normal user close; no start-at-login entry here
            return
        except Exception as exc:  # noqa: BLE001 - fixture failure, never a UI result
            steps["driver_error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            state["phase"] = "closing"
            state["window"].close()
            return
        if kind == "js":
            state.update({"busy": True, "busy_since": time.monotonic()})
            state["view"].page().runJavaScript(arg, 0, on_js)
        else:
            state["wake"] = time.monotonic() + arg

    def tick():
        if state["phase"] == "wait":
            if time.monotonic() - state["started"] > DASHBOARD_DEADLINE_SECONDS:
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
                    state.update({"phase": "driving", "window": widget, "view": views[0],
                                  "gen": journey(dashboard.rstrip("/"))})
                return
        elif state["phase"] == "driving":
            if state["busy"]:
                if time.monotonic() - state["busy_since"] > JS_CALL_SECONDS:
                    state.update({"busy": False, "value": None})  # no callback: no result
                return
            if time.monotonic() < state["wake"]:
                return
            advance()

    poll = QTimer()
    poll.setInterval(TICK_MS)
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

    result.update({"stage": "done", "exit_code": exit_code, "journey_finished": state["phase"] == "closing"})
    _write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    parser = argparse.ArgumentParser(description="T3 default-server UI fixture (non-product)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--mode", required=True, choices=["editable", "managed"])
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
