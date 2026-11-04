"""T3 network settings (#171): reported values, sources and the advanced-profile refusal.

Contract (implementation-plan-v2 section 6, lines 138 and 147):
- GET /.web/api/settings reports each network field as {value, source,
  editable}, like serverUrl does. Planned field shape (not in the source yet):
    "listenAddress": {"value": "<literal>", "source": "env|saved|default", "editable": bool}
    "listenPort":    {"value": <int>,       "source": "env|saved|default", "editable": bool}
  where "source" says which layer the effective value came from
  (SILENTSUITE_LISTEN_ADDRESS/PORT > settings.json "network" > built-in);
- the fields are editable ONLY when no network environment variable is set
  (any of SILENTSUITE_LISTEN_ADDRESS, _LISTEN_PORT, _SERVER_HOSTS,
  _ALLOW_REMOTE, even ALLOW_REMOTE=0), no serverHosts is saved and saved
  allowRemote is not true. A simple saved loopback address/port stays editable;
- for a read-only profile, POST {"listenAddress": ..., "listenPort": ...} (the
  planned envelope) returns 409 and changes nothing: settings.json bytes, the
  process, its requested and bound listeners, and the reported metadata.

Each profile is a REAL headless CLI start (no account) in a child process with
an isolated DATA_DIR. The child's environment starts with every SILENTSUITE_*
variable removed, so the reported sources are true. The only fixture change in
the child is that webbrowser.open records the call instead of opening a
browser. The parent talks to the child over real loopback HTTP: the real
source gate, Host check and CSRF token from the served page. All listeners are
loopback; no remote address is used. Successful network changes, activation,
rollback and UI are NOT part of this slice.
"""

import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.test_desktop_ipc import _connectable, _free_port, _read_json, _tail, _wait_until

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
CANONICAL_PORT = 37358  # config.DEFAULT_LISTEN_PORT
READY_TIMEOUT = 60
CSRF_PATTERN = re.compile(r"SILENTSUITE_DASHBOARD_CSRF\s*=\s*(\"[^\"]*\")")  # as autostart_probe reads it

# A real headless CLI start; webbrowser.open only records (no browser opens).
CHILD = r"""
import json, os, sys, threading, time, webbrowser

opened = []
webbrowser.open = lambda url, *args, **kwargs: opened.append(1) or True

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge.radicale.server import get_registry

ready_path = sys.argv[1]


def report_when_bound():
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        url = get_registry().dashboard_url(False)
        if url:
            tmp = ready_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump({"pid": os.getpid(), "dashboard_url": url}, handle)
            os.replace(tmp, ready_path)
            return
        time.sleep(0.05)


threading.Thread(target=report_when_bound, name="t3net-ready", daemon=True).start()
sys.argv = ["silentsuite-bridge", "--no-tray"]
bridge_main.main()
"""

# Policy table. "port" names which port the dashboard listens on: P is a free
# loopback port chosen per run, CANONICAL is the built-in 37358.
PROFILES = {
    "default": {
        "saved": None, "env": {}, "listen": "CANONICAL",
        "address": ("127.0.0.1", "default"), "port": ("CANONICAL", "default"), "editable": True,
    },
    "saved-loopback": {
        "saved": {"listenAddress": "127.0.0.1", "listenPort": "P"}, "env": {}, "listen": "P",
        "address": ("127.0.0.1", "saved"), "port": ("P", "saved"), "editable": True,
    },
    "env-listen": {
        "saved": None, "env": {"SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1", "SILENTSUITE_LISTEN_PORT": "P"},
        "listen": "P",
        "address": ("127.0.0.1", "env"), "port": ("P", "env"), "editable": False,
    },
    "env-allow-remote-false": {
        "saved": {"listenAddress": "127.0.0.1", "listenPort": "P"}, "env": {"SILENTSUITE_ALLOW_REMOTE": "0"},
        "listen": "P",
        "address": ("127.0.0.1", "saved"), "port": ("P", "saved"), "editable": False,
    },
    "saved-server-hosts": {
        "saved": {"serverHosts": ("127.0.0.1", "P")}, "env": {}, "listen": "P",  # host spec "127.0.0.1:<P>"
        "address": ("127.0.0.1", "default"), "port": ("CANONICAL", "default"), "editable": False,
    },
    "saved-allow-remote": {
        "saved": {"listenPort": "P", "allowRemote": True}, "env": {}, "listen": "P",
        "address": ("127.0.0.1", "default"), "port": ("P", "saved"), "editable": False,
    },
}
MANAGED = [name for name, profile in PROFILES.items() if not profile["editable"]]


def _resolve(value, port):
    if value == "P":
        return port
    if value == "CANONICAL":
        return CANONICAL_PORT
    if isinstance(value, dict):
        return {k: _resolve(v, port) for k, v in value.items()}
    if isinstance(value, tuple):  # (loopback host, port macro) -> one explicit "host:port" spec
        host, port_value = value
        return f"{host}:{_resolve(port_value, port)}"
    return value


def _unresolved(value):
    """True if a P/CANONICAL macro survived resolution (a fixture bug, never a policy result)."""
    if isinstance(value, dict):
        return any(_unresolved(v) for v in value.values())
    return value in ("P", "CANONICAL") or (isinstance(value, str) and value.endswith((":P", ":CANONICAL")))


def _canonical_port_free():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", CANONICAL_PORT))
            return True
        except OSError:
            return False


def _http(base, method, path, csrf=None, body=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if csrf:
        request.add_header("X-SilentSuite-CSRF", csrf)
    try:
        with opener.open(request, timeout=15) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as exc:
        raw, status = exc.read(), exc.code
    except (OSError, ValueError) as exc:
        return [None, type(exc).__name__]
    try:
        return [status, json.loads(raw)]
    except ValueError:
        return [status, {"non_json_length": len(raw)}]


def _page_csrf(base):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(base + "/.web", timeout=15) as response:
            page = response.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        return None
    match = CSRF_PATTERN.search(page)
    return json.loads(match.group(1)) if match else None


def _settings_bytes(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def _journey(tmp_path_factory, name):
    profile = PROFILES[name]
    root = tmp_path_factory.mktemp(f"t3net-{name}")
    data = root / "data"
    data.mkdir()
    settings_path = data / "settings.json"
    port = _free_port()
    if profile["listen"] == "CANONICAL" and not _canonical_port_free():
        pytest.fail(f"prerequisite missing (not RED): the built-in port {CANONICAL_PORT} is in use on this runner")
    saved = _resolve(profile["saved"], port) if profile["saved"] is not None else None
    env_values = {k: _resolve(v, port) for k, v in profile["env"].items()}
    if _unresolved(saved) or _unresolved(env_values):
        pytest.fail(f"prerequisite missing (not RED): {name} fixture left a port macro unresolved")
    if saved is not None:
        settings_path.write_text(json.dumps({"network": saved}, indent=2), encoding="utf-8")

    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({"SILENTSUITE_DATA_DIR": str(data), "PYTHONPATH": pythonpath, "PYTHONDONTWRITEBYTECODE": "1"})
    env.update({k: str(v) for k, v in env_values.items()})

    ready_path = root / "ready.json"
    logs = [open(root / "child.stdout", "w", encoding="utf-8"), open(root / "child.stderr", "w", encoding="utf-8")]
    child = subprocess.Popen([sys.executable, "-c", CHILD, str(ready_path)],
                             stdout=logs[0], stderr=logs[1], env=env, text=True)
    journey = {"name": name, "port": port, "settings_path": settings_path}
    try:
        ready = _wait_until(lambda: _read_json(ready_path) or (child.poll() is not None and {"gone": True}),
                            READY_TIMEOUT)
        if not ready or ready.get("gone"):
            pytest.fail(f"fixture did not complete (not RED): {name} never bound its dashboard "
                        f"(rc={child.poll()!r})\n{_tail(root / 'child.stderr')}")
        base = ready["dashboard_url"].rstrip("/")
        expected_port = _resolve(profile["listen"], port)
        if not base.endswith(f"127.0.0.1:{expected_port}"):
            pytest.fail(f"fixture did not complete (not RED): {name} bound an unexpected dashboard ({base!r})")
        journey.update({"base": base, "pid": ready["pid"], "child_pid": child.pid})

        # Admission: real page, CSRF, GET, status and a same-value interval save.
        csrf = _page_csrf(base)
        journey["csrf_found"] = bool(csrf)
        journey["get"] = _http(base, "GET", "/.web/api/settings")
        journey["status"] = _http(base, "GET", "/.web/api/status")
        interval = (journey["get"][1] or {}).get("syncInterval") if journey["get"][0] == 200 else None
        journey["interval"] = interval
        if csrf and isinstance(interval, int):
            journey["interval_post"] = _http(base, "POST", "/.web/api/settings", csrf, {"syncInterval": interval})

        # Managed refusal: only once the metadata exists, never with a remote address.
        body = journey["get"][1] or {}
        if not profile["editable"] and csrf and "listenAddress" in body and "listenPort" in body:
            candidate = {"listenAddress": "127.0.0.1", "listenPort": _free_port()}
            journey["bytes_before"] = _settings_bytes(settings_path)
            journey["refusal"] = {
                "candidate_port": candidate["listenPort"],
                "post": _http(base, "POST", "/.web/api/settings", csrf, candidate),
                "bytes_after": _settings_bytes(settings_path),
                "get_after": _http(base, "GET", "/.web/api/settings"),
                "status_after": _http(base, "GET", "/.web/api/status"),
                "alive_after": child.poll() is None,
                "connectable_after": _connectable(expected_port),
            }
    finally:
        if child.poll() is None:
            child.terminate()  # shutdown is not under test here
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=20)
        for handle in logs:
            handle.close()
    return journey


@pytest.fixture(scope="module")
def journeys(tmp_path_factory):
    """One real CLI start per profile, shared by that profile's cases (failures are remembered too)."""
    cache = {}

    def get(name):
        if name not in cache:
            try:
                cache[name] = _journey(tmp_path_factory, name)
            except pytest.fail.Exception as exc:
                cache[name] = exc
        if isinstance(cache[name], BaseException):
            pytest.fail(str(cache[name]))
        return cache[name]

    return get


def _assert_admitted(journey):
    get_status, body = journey["get"]
    assert journey["csrf_found"] is True, journey
    assert get_status == 200 and isinstance(body.get("syncInterval"), int), journey
    assert isinstance(body.get("serverUrl"), dict) and set(body["serverUrl"]) == {"value", "source", "editable"}, journey
    assert journey["status"][0] == 200 and journey["status"][1]["network"]["bound"], journey
    assert journey.get("interval_post") == [200, {"ok": True, "syncInterval": journey["interval"]}], journey


def _require_admitted(journey):
    try:
        _assert_admitted(journey)
    except (AssertionError, KeyError, TypeError) as exc:
        pytest.fail(f"admission control failed (not RED): {exc!r}")


def _expected(name, port):
    profile = PROFILES[name]
    address, address_source = profile["address"]
    port_value, port_source = profile["port"]
    return {
        "listenAddress": {"value": address, "source": address_source, "editable": profile["editable"]},
        "listenPort": {"value": _resolve(port_value, port), "source": port_source, "editable": profile["editable"]},
    }


@pytest.mark.parametrize("name", list(PROFILES))
def test_network_profile_admission_control(journeys, name):
    # Control: a real start of this profile serves its own dashboard, the real
    # Host/CSRF path admits a same-value interval save, and GET keeps its fields.
    _assert_admitted(journeys(name))


@pytest.mark.parametrize("name", list(PROFILES))
def test_network_settings_report_value_source_and_editability(journeys, name):
    journey = journeys(name)
    _require_admitted(journey)
    body = journey["get"][1]
    reported = {key: body.get(key) for key in ("listenAddress", "listenPort")}
    assert reported == _expected(name, journey["port"]), (
        f"{name}: network metadata is missing or wrong: {reported!r}, expected {_expected(name, journey['port'])!r}"
    )


@pytest.mark.parametrize("name", MANAGED)
def test_managed_network_change_is_refused_without_side_effects(journeys, name):
    journey = journeys(name)
    _require_admitted(journey)
    if "refusal" not in journey:
        pytest.fail("NOT REACHED: no network metadata, so the read-only refusal was not driven")
    refusal = journey["refusal"]
    status, response = refusal["post"]
    assert status == 409 and isinstance(response, dict) and "error" in response, refusal
    assert refusal["bytes_after"] == journey["bytes_before"], f"{name}: settings.json changed: {refusal!r}"
    assert refusal["alive_after"] is True and refusal["connectable_after"] is True, refusal
    assert refusal["status_after"][1]["network"] == journey["status"][1]["network"], refusal
    assert {k: refusal["get_after"][1].get(k) for k in ("listenAddress", "listenPort")} == _expected(
        name, journey["port"]), refusal
