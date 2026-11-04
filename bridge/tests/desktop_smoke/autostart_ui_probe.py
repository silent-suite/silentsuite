"""T4 start-at-login dashboard toggle fixture (#171): the real desktop dashboard, driven like a user.

One scenario per process:
  installed  a SIMULATED frozen app at the platform's stable installed root
             (Linux: the CI-created inert /opt file; macOS/Windows: an inert
             empty file this probe creates under the isolated HOME/LOCALAPPDATA)
  source     launched from this source checkout (not frozen)

The REAL ``main(flavor="desktop")`` runs to its own registry-bound dashboard.
A driver then runs JavaScript in the page with QWebEnginePage.runJavaScript.
That is operator-side control: the page itself gets no bridge. The driver
reads the DOM and clicks real controls. Effects are checked through the real
loopback settings API (Host and CSRF gated), the isolated registration
locations, the window's own native status-bar text, and the owner's identity
(PID, registry URL, server thread, instance lock seen from a child process).
There is no sign-in, no account and no remote request.

Planned UI interface (the source does not have it yet), found by meaning:
- a checkbox (<input type="checkbox">) or [role="switch"] OUTSIDE
  #dashboardLoginForm whose accessible label contains "start at login";
- in its nearest form/fieldset/section/[role=group]/[role=region] container
  (never the login form): a status element (role="status" or aria-live)
  other than #accountActionStatus and #defaultServerStatus;
- the status says "Saved" only after an acknowledged change, otherwise
  "Not saved: ..."; when start at login is unavailable, the control is
  disabled and the container text mentions the installed app;
- the page saves through its existing window.fetch, POSTing
  {"startAtLogin": <bool>} to /.web/api/settings, as the other dashboard
  settings do.

Request witness: after load, an operator-side wrapper around the page's
window.fetch records, for own-origin POST /.web/api/settings with a boolean
startAtLogin only, that boolean and the HTTP status. The original fetch and
its Promise are used unchanged. Each click reads the record counter first, so
only requests made after that click count. Owner identity: PID, registry URL,
the SAME server Thread object (kept from the baseline, plus its ident), and
the instance lock seen from a child process.

Simulated boundaries (and only these), reused read-only from existing probes:
- frozen identity: sys.frozen plus an inert sys.executable, set before any
  product import, and NEVER executed. The launch trap refuses any start of it
  (autostart_probe);
- Windows: a complete in-process HKCU Run table, reads and writes; any other
  registry write is trapped (autostart_probe). POSIX entries are real files,
  only inside the isolated HOME;
- service managers are trapped (migration_probe);
- one rejected registration write: for a single enable, POSIX makes the
  isolated autostart directory read-only (mode 0500); Windows makes the
  simulated Run table's SetValueEx refuse. Both are restored at once, and the
  restoration is recorded.

Exit codes: 0 result written, 2 prerequisite missing, 3 fixture watchdog,
4 teardown impossible without faking (fixture failure, not RED).
"""

import json
import os
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

REAL_PYTHON = sys.executable  # before the simulated identity replaces sys.executable

sys.path.insert(0, str(Path(__file__).resolve().parent))

import autostart_probe  # noqa: E402 - reuse its Run table, launch trap and readers read-only
import migration_probe  # noqa: E402 - reuse its service-manager trap read-only
import server_url_ui_probe as ui  # noqa: E402 - reuse its page driver snippets read-only

EXIT_WRITTEN = 0
EXIT_PREREQ = 2
EXIT_WATCHDOG = 3
EXIT_TEARDOWN = 4
WATCHDOG_SECONDS = 170
TICK_MS = 100
BRAND = "SilentSuite Bridge"
DASHBOARD_DEADLINE_SECONDS = 60
STEP_SECONDS = 10
NOTICE_SECONDS = 5  # the product refreshes its notice every 2 s
JS_CALL_SECONDS = 5
QUIT_ACTION_TEXT = "Quit SilentSuite Bridge"
OPT_INODE_ENV = "T4_OPT_FILE_INODE"  # the CI create step's recorded inode (Linux installed)

LOCATE_TOGGLE_JS = r"""
function t4Locate() {
  var login = document.getElementById('dashboardLoginForm');
  function outside(el) { return !(login && login.contains(el)); }
  function labelText(el) {
    var parts = [];
    if (el.labels) for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].textContent);
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    (el.getAttribute('aria-labelledby') || '').split(/\s+/).forEach(function(id) {
      var n = id && document.getElementById(id); if (n) parts.push(n.textContent);
    });
    if (!parts.length && el.tagName === 'BUTTON') parts.push(el.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  function shown(el) {
    return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      && getComputedStyle(el).visibility !== 'hidden';
  }
  var found = [].slice.call(document.querySelectorAll('input[type="checkbox"],[role="switch"]')).filter(function(el) {
    return outside(el) && /start at login/i.test(labelText(el));
  });
  var r = {candidates: found.length, control: null, group: null, status: null, label: null, shown: shown};
  if (!found.length) return r;
  r.control = found[0];
  r.label = labelText(r.control);
  var group = r.control.closest('form,fieldset,section,[role="group"],[role="region"]');
  if (!group || group === login || (login && group.contains(login))) return r;
  r.group = group;
  r.status = [].slice.call(group.querySelectorAll('[role="status"],[aria-live]')).filter(function(s) {
    return outside(s) && s.id !== 'accountActionStatus' && s.id !== 'defaultServerStatus';
  })[0] || null;
  return r;
}
function t4Checked(el) {
  if (el.tagName !== 'INPUT') return el.getAttribute('aria-checked') === 'true';
  return !!el.checked;
}
function t4Disabled(el) { return !!el.disabled || el.getAttribute('aria-disabled') === 'true'; }
"""

DISCOVER_JS = LOCATE_TOGGLE_JS + r"""(function(){
  var d = t4Locate();
  var out = {candidates: d.candidates, controlFound: !!d.control, groupFound: !!d.group, statusFound: !!d.status};
  if (d.control) {
    out.label = (d.label || '').slice(0, 200);
    out.checked = t4Checked(d.control);
    out.disabled = t4Disabled(d.control);
    out.controlShown = d.shown(d.control);
  }
  if (d.status) out.statusText = (d.status.textContent || '').slice(0, 200);
  if (d.group) out.groupText = (d.group.innerText || d.group.textContent || '').replace(/\s+/g, ' ').slice(0, 600);
  return JSON.stringify(out);
})()"""

CLICK_JS = LOCATE_TOGGLE_JS + r"""(function(){
  var d = t4Locate();
  if (!d.control) return JSON.stringify({clicked: false});
  var before = d.status ? (d.status.textContent || '') : '';
  var checkedBefore = t4Checked(d.control);
  d.control.click();  // a disabled control ignores it, as it would a user's click
  return JSON.stringify({clicked: true, statusBefore: before.slice(0, 200), checkedBefore: checkedBefore});
})()"""

TOGGLE_STATE_JS = LOCATE_TOGGLE_JS + r"""(function(){
  var d = t4Locate();
  return JSON.stringify({
    status: d.status ? (d.status.textContent || '').slice(0, 200) : null,
    checked: d.control ? t4Checked(d.control) : null,
    disabled: d.control ? t4Disabled(d.control) : null
  });
})()"""

# Operator-side request witness (not an application bridge). Wraps the page's
# existing window.fetch: the original is called unchanged and its own Promise
# is returned. It records ONLY own-origin POST /.web/api/settings requests whose
# JSON body has a boolean startAtLogin: the sequence number, that boolean and
# the HTTP status (or 'transport-error'). No headers, token, other body fields
# or page content are kept. At most 20 records.
INSTALL_FETCH_OBSERVER_JS = r"""(function(){
  if (window.__t4Fetch) return JSON.stringify({installed: true});
  var original = window.fetch;
  if (typeof original !== 'function') return JSON.stringify({installed: false});
  var state = {seq: 0, log: []};
  window.__t4Fetch = state;
  window.fetch = function(input, init) {
    var promise = original.apply(window, arguments);
    var record = null;
    try {
      var url = new URL(typeof input === 'string' ? input : ((input && input.url) || ''), location.href);
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (method === 'POST' && url.origin === location.origin && url.pathname === '/.web/api/settings'
          && init && typeof init.body === 'string') {
        var body = JSON.parse(init.body);
        if (body && typeof body.startAtLogin === 'boolean') {
          state.seq += 1;
          record = {seq: state.seq, startAtLogin: body.startAtLogin, status: null};
          if (state.log.length < 20) state.log.push(record);
        }
      }
    } catch (e) { record = null; }
    if (record) {
      promise.then(function(r) { record.status = r.status; }, function() { record.status = 'transport-error'; });
    }
    return promise;
  };
  return JSON.stringify({installed: window.fetch !== original});
})()"""

FETCH_LOG_JS = r"""JSON.stringify(window.__t4Fetch
  ? {seq: window.__t4Fetch.seq, log: window.__t4Fetch.log.slice(0, 20)} : null)"""

LOCK_PROBE_CODE = (
    "import os, sys\n"
    "from silentsuite_bridge import config\n"
    "fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT, 0o600)\n"
    "try:\n"
    "    free = config._try_lock_fd(fd)\n"
    "    if free:\n"
    "        config._unlock_fd(fd)\n"
    "finally:\n"
    "    os.close(fd)\n"
    "print('FREE' if free else 'BUSY')\n"
)


def _plausible_linux_fixture(path):
    """The CI-created inert file: regular, non-symlink, empty, ours, X_OK, recorded inode."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    recorded = os.environ.get(OPT_INODE_ENV, "")
    return (stat.S_ISREG(st.st_mode) and st.st_size == 0 and st.st_uid == os.getuid()
            and os.access(path, os.X_OK) and recorded.isdigit() and int(recorded) == st.st_ino)


def run(args) -> int:
    out = Path(args.out)
    result = {"scenario": args.scenario, "stage": "prereq", "prereq": {}, "entry_error": None, "steps": {}}
    ui._write(out, result)

    def watchdog():
        result["stage"] = str(result["stage"]) + ":fixture-watchdog"
        restore_boundary()
        ui._write(out, result)
        os._exit(EXIT_WATCHDOG)  # fixture-only

    timer = threading.Timer(WATCHDOG_SECONDS, watchdog)
    timer.daemon = True

    def stop_prereq(key, value=False):
        result["prereq"][key] = value
        ui._write(out, result)
        timer.cancel()
        return EXIT_PREREQ

    try:
        from PySide6.QtCore import QCoreApplication, Qt, QTimer
        from PySide6.QtGui import QAction
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication, QLabel
    except Exception as exc:  # noqa: BLE001
        return stop_prereq("import_error", type(exc).__name__)

    windows = sys.platform == "win32"
    home = os.environ.get("HOME", "")
    if not windows and (not home or os.path.expanduser("~") != home or "t4ui" not in home):
        return stop_prereq("isolated_home")
    if windows and "t4ui" not in os.environ.get("LOCALAPPDATA", ""):
        return stop_prereq("isolated_localappdata")

    executable = args.executable or None
    if args.scenario == "installed":
        if not executable:
            return stop_prereq("installed_executable")
        if sys.platform.startswith("linux"):
            if not _plausible_linux_fixture(executable):  # created by CI; never created or run here
                return stop_prereq("installed_fixture")
        else:
            os.makedirs(os.path.dirname(executable), exist_ok=True)
            if not os.path.exists(executable):
                with open(executable, "wb"):
                    pass  # empty and inert; never executed
            if not windows:
                os.chmod(executable, 0o755)
                if not os.access(executable, os.X_OK):
                    return stop_prereq("simulated_executable_x_ok")
        sys.frozen = True  # SIMULATED frozen identity, before any product import
        sys.executable = executable
    result["simulated_identity"] = executable
    timer.start()

    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0]])
    result["prereq"].update({"qapplication": True, "screen": app.primaryScreen() is not None})

    traps, launches, run_writes = [], [], []
    run_table = {}
    migration_probe._install_service_manager_trap(traps)
    autostart_probe._install_launch_trap(executable, launches)
    if windows:
        autostart_probe._install_windows_run_table(run_table, run_writes, traps)

    from silentsuite_bridge import __main__ as bridge_main
    from silentsuite_bridge import autostart, config, desktop
    from silentsuite_bridge.radicale.server import get_registry

    result["notice_texts"] = {"stops": desktop.CLOSE_STOPS_NOTICE, "hides": desktop.CLOSE_HIDES_NOTICE}
    if windows:
        cli_path = desktop_path = None
    elif sys.platform == "darwin":
        cli_path = autostart._launchd_plist_path()
        desktop_path = os.path.join(home, "Library", "LaunchAgents", "io.silentsuite.bridge.desktop.plist")
    else:
        cli_path = autostart._systemd_service_path()
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        desktop_path = os.path.join(xdg, "autostart", "silentsuite-bridge-desktop.desktop")

    def registrations():
        if windows:
            return {"desktop": run_table.get(autostart_probe.DESKTOP_RUN_VALUE),
                    "cli": run_table.get(autostart_probe.CLI_RUN_VALUE)}
        return {"desktop": autostart_probe._file_text(desktop_path), "cli": autostart_probe._digest(cli_path)}

    def add_cli_registration():  # after owner startup, like autostart_probe
        if windows:
            run_table[autostart_probe.CLI_RUN_VALUE] = '"C:\\synthetic\\silentsuite-bridge.exe"'
            return
        os.makedirs(os.path.dirname(cli_path), exist_ok=True)
        Path(cli_path).write_text("# synthetic CLI registration added after owner startup\n", encoding="utf-8")

    # --- the one rejected registration write (scoped, restored) ------------
    boundary = {"active": False, "restored": None, "detail": None}

    def reject_next_write():
        if windows:
            import winreg

            boundary["saved"] = winreg.SetValueEx

            def refuse(*_a, **_kw):
                traps.append("t4ui-injected-SetValueEx")
                raise PermissionError("T4 UI fixture: injected Run-table write failure")

            winreg.SetValueEx = refuse
            boundary.update({"active": True, "detail": "SetValueEx refuses"})
            return True
        directory = os.path.dirname(desktop_path)
        if not os.path.isdir(directory) or os.path.islink(directory):
            return False
        boundary["mode"] = stat.S_IMODE(os.lstat(directory).st_mode)
        boundary["inode"] = os.lstat(directory).st_ino
        os.chmod(directory, 0o500)
        boundary.update({"active": True, "detail": "isolated autostart directory read-only"})
        if os.access(directory, os.W_OK):  # e.g. running as root: the write would not fail
            restore_boundary()
            boundary["effective"] = False
            return False
        boundary["effective"] = True
        return True

    def restore_boundary():
        if not boundary["active"]:
            return
        boundary["active"] = False
        try:
            if windows:
                import winreg

                winreg.SetValueEx = boundary.pop("saved")
                boundary["restored"] = winreg.SetValueEx is not None
            else:
                directory = os.path.dirname(desktop_path)
                st = os.lstat(directory)
                if st.st_ino == boundary["inode"] and not stat.S_ISLNK(st.st_mode):
                    os.chmod(directory, boundary["mode"])
                st = os.lstat(directory)
                boundary["restored"] = stat.S_IMODE(st.st_mode) == boundary["mode"] and os.access(directory, os.W_OK)
        except Exception as exc:  # noqa: BLE001
            boundary["restored"] = False
            boundary["restore_error"] = type(exc).__name__

    # --- witnesses ---------------------------------------------------------
    def http_get_settings(base):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(base + "/.web/api/settings", timeout=10) as response:
                return [response.status, json.loads(response.read())]
        except urllib.error.HTTPError as exc:
            return [exc.code, None]
        except (OSError, ValueError) as exc:
            return [None, type(exc).__name__]

    def lock_state():
        try:
            done = subprocess.run(
                [REAL_PYTHON, "-c", LOCK_PROBE_CODE, os.path.join(config.DATA_DIR, "instance.lock")],
                capture_output=True, text=True, timeout=30,
            )
            return done.stdout.strip() or f"rc={done.returncode}"
        except (OSError, subprocess.SubprocessError) as exc:
            return type(exc).__name__

    def server_thread():
        return next((t for t in threading.enumerate() if t.name == "silentsuite-bridge-server"), None)

    def identity():
        """PID, registry URL, the SAME server Thread object as at baseline, and the lock seen from a child."""
        registry = get_registry()
        thread = server_thread()
        baseline = state.get("server_thread")
        return {
            "pid": os.getpid(),
            "dashboard_url": registry.dashboard_url(False),
            "registry_stopped": bool(registry.is_stopped),
            "server_thread_ident": thread.ident if thread is not None else None,
            "server_thread_alive": bool(thread is not None and thread.is_alive()),
            "same_server_thread_object": baseline is not None and thread is baseline,
            "lock": lock_state(),
        }

    def visible_labels():
        window = state["window"]
        return [label.text()[:300] for label in window.findChildren(QLabel) if label.isVisible() and label.text()]

    # --- generator-driven journey (as server_url_ui_probe) ------------------
    steps = result["steps"]
    state = {"phase": "wait", "started": time.monotonic(), "window": None, "view": None, "gen": None,
             "busy": False, "busy_since": 0.0, "value": None, "wake": 0.0}

    def parse(value):
        try:
            return json.loads(value) if isinstance(value, str) else None
        except ValueError:
            return None

    def wait_js(code, done, seconds=STEP_SECONDS):
        deadline = time.monotonic() + seconds
        while True:
            parsed = parse((yield ("js", code)))
            if parsed is not None and done(parsed):
                return parsed, True
            if time.monotonic() > deadline:
                return parsed, False
            yield ("sleep", 0.2)

    def wait_notice(expected):
        deadline = time.monotonic() + NOTICE_SECONDS
        while True:
            texts = visible_labels()
            if expected in texts or time.monotonic() > deadline:
                return {"texts": texts, "matched": expected in texts}
            yield ("sleep", 0.25)

    def toggle(name, base):
        """One real click, then the page's own startAtLogin POST(s) made after it, the
        acknowledged status, API, registrations and identity."""
        mark = parse((yield ("js", FETCH_LOG_JS)))
        if mark is None:
            raise RuntimeError("the fetch observer is gone")
        click = parse((yield ("js", CLICK_JS)))
        before = (click or {}).get("statusBefore", "")
        after, met = yield from wait_js(
            TOGGLE_STATE_JS, lambda s: ui._settled(s["status"]) and s["status"] != before)
        boundary_active = boundary["active"]  # still armed when the page settled (rejected case)
        # Only records made after the mark count; wait briefly for their responses.
        log, _answered = yield from wait_js(
            FETCH_LOG_JS,
            lambda s: all(r["status"] is not None for r in s["log"] if r["seq"] > mark["seq"]),
            seconds=3,
        )
        if log is None:
            raise RuntimeError("the fetch observer is gone")
        steps[name] = {
            "click": click, "after": after, "settled": met,
            "requests": [r for r in log["log"] if r["seq"] > mark["seq"]],
            "boundary_active_at_settle": boundary_active,
            "get": http_get_settings(base), "registrations": registrations(), "identity": identity(),
        }
        return steps[name]

    def journey(base):
        page, met = yield from wait_js(
            ui.PAGE_STATE_JS, lambda s: s["ready"] == "complete" and s["marker"] is None and s["title"] == BRAND,
            DASHBOARD_DEADLINE_SECONDS)
        if not met:
            steps["driver_error"] = "the dashboard page never reached a complete state"
            return
        yield ("js", ui.INSTALL_DRIVER_JS % json.dumps("t4ui-1"))
        page = parse((yield ("js", ui.PAGE_STATE_JS)))
        if page is None:
            steps["driver_error"] = "the dashboard state could not be read"
            return
        page["origin_is_dashboard"] = page.get("origin") == base
        steps["page"] = page
        steps["web_channel_absent"] = state["view"].page().webChannel() is None
        steps["fetch_observer"] = parse((yield ("js", INSTALL_FETCH_OBSERVER_JS)))
        if not (steps["fetch_observer"] or {}).get("installed"):
            steps["driver_error"] = "the operator-side fetch observer could not be installed"
            return
        steps["get_before"] = http_get_settings(base)

        # Positive admission control: same-value interval save through the page.
        steps["interval_trigger"] = parse((yield ("js", ui.INTERVAL_SAVE_JS)))
        status, met = yield from wait_js(ui.INTERVAL_STATUS_JS, lambda s: ui._settled(s["status"]))
        steps["interval_status"] = {"status": (status or {}).get("status"), "settled": met}
        steps["interval_get"] = http_get_settings(base)

        add_cli_registration()
        steps["registrations_before"] = registrations()
        state["server_thread"] = server_thread()  # baseline Thread object, compared by identity later
        steps["identity_before"] = identity()
        steps["notice_before"] = visible_labels()

        discovery = parse((yield ("js", DISCOVER_JS)))
        if discovery is None:
            steps["driver_error"] = "the control discovery script returned no result"
            return
        steps["discovery"] = discovery
        if not (discovery.get("controlFound") and discovery.get("statusFound")):
            return  # the parent decides RED / NOT REACHED

        if args.scenario == "source":
            yield from toggle("source_click", base)
            return

        on = yield from toggle("toggle_on", base)
        steps["notice_on"] = yield from wait_notice(desktop.CLOSE_HIDES_NOTICE)
        if not (on["get"][0] == 200 and (on["get"][1] or {}).get("startAtLogin", {}).get("value") is True):
            return  # not on: OFF and the rejected write are not reached
        yield from toggle("toggle_off", base)
        steps["notice_off"] = yield from wait_notice(desktop.CLOSE_STOPS_NOTICE)
        if steps["toggle_off"]["registrations"]["desktop"] is not None:
            return

        steps["rejection_armed"] = reject_next_write()
        steps["rejection_boundary"] = {k: v for k, v in boundary.items() if k != "saved"}
        if not steps["rejection_armed"]:
            return
        try:
            yield from toggle("toggle_rejected", base)
        finally:
            restore_boundary()
        steps["rejection_restored"] = {k: v for k, v in boundary.items() if k != "saved"}
        steps["after_rejection"] = {
            "state": parse((yield ("js", TOGGLE_STATE_JS))),
            "get": http_get_settings(base),
            "registrations": registrations(),
        }

    def finish():
        """Ordinary close when no desktop entry is left; else the real Quit action (never app.quit)."""
        restore_boundary()
        state["phase"] = "closing"
        steps["registrations_at_end"] = registrations()
        if steps["registrations_at_end"]["desktop"] is None:
            steps["teardown"] = "close"
            state["window"].close()
            return
        matches = [a for a in state["window"].findChildren(QAction) if a.text().replace("&", "") == QUIT_ACTION_TEXT]
        if not matches or not matches[0].isEnabled():
            steps["teardown"] = "quit-action-unavailable"
            result["stage"] = "entrypoint:teardown-impossible"
            ui._write(out, result)
            os._exit(EXIT_TEARDOWN)  # fixture failure (not RED); never a faked quit
        steps["teardown"] = "quit-action"
        matches[0].trigger()

    def on_js(value):
        state["value"] = value
        state["busy"] = False

    def advance():
        try:
            kind, arg = state["gen"].send(state.pop("value", None))
        except StopIteration:
            finish()
            return
        except Exception as exc:  # noqa: BLE001 - fixture failure, never a UI result
            steps["driver_error"] = f"{type(exc).__name__}: {str(exc)[:200]}"
            finish()
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
                    state.update({"busy": False, "value": None})
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
    ui._write(out, result)
    try:
        bridge_main.main(flavor="desktop")
    except SystemExit as exc:
        exit_code = exc.code
    except Exception as exc:  # noqa: BLE001
        frames = [f"{os.path.basename(f.filename)}:{f.lineno}" for f in traceback.extract_tb(exc.__traceback__)][-6:]
        result["entry_error"] = {"class": type(exc).__name__, "frames": frames}
    poll.stop()
    restore_boundary()

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
        "journey_finished": state["phase"] == "closing",
        "lock_free_after": lock_free,
        "registry_stopped_after": bool(get_registry().is_stopped),
        "registrations_after": registrations(),
        "boundary_after": {k: v for k, v in boundary.items() if k != "saved"},
        "service_manager_traps": [t for t in traps if not t.startswith("t4ui-injected")],
        "injected_refusals": [t for t in traps if t.startswith("t4ui-injected")],
        "launch_attempts": launches,
        "run_key_writes": run_writes,
    })
    ui._write(out, result)
    timer.cancel()
    return EXIT_WRITTEN


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="T4 start-at-login UI fixture (non-product)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--scenario", required=True, choices=["installed", "source"])
    parser.add_argument("--executable", default="")
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
