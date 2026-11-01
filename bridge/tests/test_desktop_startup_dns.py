"""T2 supporting regression (#171): desktop startup must not wait on reverse DNS.

Evidence: on the hosted macOS runner the desktop's server thread sat for
about 35 s in ``socket.getfqdn`` inside the upstream ``HTTPServer.server_bind``
while binding its loopback literal, past the desktop's 30 s dashboard
deadline (t1b-migration-dns-stall-evidence.txt). Upstream calls
``getfqdn(host)`` only to fill ``server_name`` for the WSGI ``SERVER_NAME``;
the Bridge gates never read it.

Contract tested here:
- the desktop launch binds its loopback listener without any reverse lookup
  (``getfqdn``/``gethostbyaddr``) of a loopback literal, while the window,
  dashboard and clean close still work;
- the default CLI serve wrapper keeps the upstream behaviour unchanged.

The desktop case runs the unchanged T2 journey (``product_probe``) in a child
process with a recording resolver spy that answers instantly, so baseline
latency on the runner cannot decide the result; the call record does.
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "startup_dns_probe.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
LOOPBACK_LITERALS = {"127.0.0.1", "::1"}
CHILD_TIMEOUT = 180


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def desktop_launch(tmp_path_factory):
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")

    root = tmp_path_factory.mktemp("t2-dns")
    data_dir, home = root / "data", root / "home"
    data_dir.mkdir()
    home.mkdir()
    out = root / "result.json"
    port = _free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data_dir),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(port),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    if sys.platform != "win32":
        env.update({
            "HOME": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
        })
    try:
        completed = subprocess.run(
            [sys.executable, str(PROBE), "--out", str(out)],
            capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env,
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): the desktop launch exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    result["describe"] = (
        f"rc={completed.returncode} journey_stage={result.get('journey', {}).get('stage')!r}\n"
        f"stderr tail:\n{completed.stderr[-3000:]}"
    )
    result["rc"] = completed.returncode
    result["port"] = port
    return result


def test_desktop_launch_completes_with_an_instant_resolver(desktop_launch):
    # Control: native prerequisites, the real entrypoint, window and clean close.
    journey = desktop_launch.get("journey", {})
    assert desktop_launch["rc"] == 0 and journey.get("stage") == "done", (
        f"fixture did not complete (not RED): {desktop_launch['describe']}"
    )
    assert journey.get("entry_error") is None, desktop_launch["describe"]
    observed = journey.get("observed", {})
    assert not observed.get("window_deadline_missed"), (
        f"no dashboard window; last seen {observed.get('last_seen')!r}: {desktop_launch['describe']}"
    )
    assert observed.get("requested_url") == observed.get("registry_dashboard_url")
    assert observed.get("requested_url") == f"http://127.0.0.1:{desktop_launch['port']}/"
    after = journey.get("after", {})
    assert after.get("lock_free") is True
    assert after.get("listener_closed") is True
    assert after.get("registry_stopped") is True


def test_desktop_launch_binds_its_loopback_listener_without_reverse_dns(desktop_launch):
    calls = desktop_launch.get("resolver_calls", [])
    assert desktop_launch.get("journey", {}).get("stage") == "done", (
        f"NOT REACHED: the desktop launch did not complete. {desktop_launch['describe']}"
    )
    loopback_lookups = [call for call in calls if call["arg"] in LOOPBACK_LITERALS]
    # The fixture's own foreign recorder (an http.server bound on the main
    # thread before main() runs) makes at most one such lookup itself; every
    # other loopback lookup belongs to the product.
    fixture_lookups = [call for call in loopback_lookups if call["thread"] == "MainThread"]
    product_lookups = [call for call in loopback_lookups if call["thread"] != "MainThread"]
    assert len(fixture_lookups) <= 1, f"unexpected main-thread loopback lookups: {fixture_lookups!r}"
    assert product_lookups == [], (
        "desktop startup performed a reverse DNS lookup of its loopback literal while binding: "
        f"{product_lookups!r}"
    )


def test_cli_serve_wrapper_keeps_the_upstream_server_name_lookup(monkeypatch):
    # Control (no Qt): the default serve path still runs upstream server_bind,
    # including getfqdn() of the bound literal, exactly as before.
    port = _free_port()
    hosts = f"127.0.0.1:{port}"
    for name in ("SERVER_HOSTS", "LISTEN_ADDRESS", "LISTEN_PORT", "ALLOW_REMOTE", "SSL_ENABLED",
                 "NETWORK_PROFILE_ERROR"):
        monkeypatch.setattr(config, name, getattr(config, name))
    monkeypatch.setattr(config, "SERVER_HOSTS", hosts)
    monkeypatch.setattr(config, "LISTEN_ADDRESS", "127.0.0.1")
    monkeypatch.setattr(config, "LISTEN_PORT", port)
    monkeypatch.setattr(config, "ALLOW_REMOTE", False)
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "NETWORK_PROFILE_ERROR", None)

    calls = []

    def spy_getfqdn(name=""):
        calls.append((str(name), threading.current_thread().name))
        return "t2-synthetic-resolver.invalid"

    monkeypatch.setattr(socket, "getfqdn", spy_getfqdn)

    from silentsuite_bridge.radicale.server import get_registry

    registry = get_registry()
    configuration = bridge_main.build_radicale_configuration()
    serve_end, shutdown_end = socket.socketpair()
    errors = []

    def serve():
        try:
            bridge_main._serve_radicale_with_bridge_application(configuration, shutdown_socket=serve_end)
        except Exception as exc:  # reported below
            errors.append(exc)

    thread = threading.Thread(target=serve, name="t2-cli-serve", daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline and not registry.bound_listeners() and not registry.failed_count():
            time.sleep(0.05)
        assert registry.bound_listeners(), f"CLI serve path did not bind (fixture problem, not RED): {errors!r}"
    finally:
        shutdown_end.close()
        thread.join(timeout=10)
        serve_end.close()
    assert not thread.is_alive()
    assert errors == []
    assert ("127.0.0.1", "t2-cli-serve") in calls
