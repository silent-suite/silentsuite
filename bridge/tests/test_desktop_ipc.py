"""T2 IPC (#171): reopening a running desktop owner, and I10 ordering.

Contract (implementation-plan-v2 section 5 plus the v3 amendment):
- the owner holds instance.lock, serves its own confirmed dashboard and runs
  a local IPC server (a QLocalServer) for the rest of its life;
- a second desktop launch for the same DATA_DIR takes the busy-lock path: it
  sends exactly b"show", reads nothing, exits 0, and the owner's window comes
  back. The second launch never runs legacy detection, removal, preparation,
  workers, serving or a web view;
- a healthy owner's bound port and a CLI registration that appears after the
  owner started must not make a second launch prompt (lock before legacy);
- the second launch keeps trying the owner's endpoint until a fixed 3-second
  deadline, so an owner that starts listening slightly late still gets "show";
- if no owner answers by then, the second launch shows the fixed native
  message "SilentSuite Bridge is already running, possibly from the command
  line or still starting. Try again in a moment." and exits non-zero;
- a relaunch while the owner's migration prompt is up must not re-prompt,
  remove or serve, and the owner still shows one prompt;
- any payload other than exactly b"show" changes nothing and gets no reply.

Every process, port and HOME is synthetic. Simulated boundaries are listed in
tests/desktop_smoke/ipc_probe.py. Endpoint checks that need a running owner
IPC server are reported as NOT REACHED while none exists.

Needs PySide6 and a display; required (SILENTSUITE_REQUIRE_DESKTOP_NATIVE=1)
in the native CI job, skipped elsewhere.
"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tests.test_instance_lock import hold_instance_lock, probe_instance_lock

BRIDGE_ROOT = Path(__file__).resolve().parents[1]
PROBE = Path(__file__).resolve().parent / "desktop_smoke" / "ipc_probe.py"
REQUIRE_ENV = "SILENTSUITE_REQUIRE_DESKTOP_NATIVE"
PREPARED_LINE = "No account configured yet"
# implementation-plan-v3-amendment.md lines 29-30: a 3-second attempt deadline
# and this exact fixed native text (v3 replaces the v2 second-launch paragraph).
BUSY_MESSAGE = (
    "SilentSuite Bridge is already running, possibly from the command line or still starting. "
    "Try again in a moment."
)
LATE_ENDPOINT_AFTER_SECONDS = 2.4  # after the 2 s an early draft allowed, safely before 3 s
LATE_ENDPOINT_WINDOW = (2.1, 2.9)  # outside this, the setup timing (not the product) decided
READY_TIMEOUT = 90
CHILD_TIMEOUT = 60
SHOW_ACK_TIMEOUT = 5.0
PAYLOAD_OBSERVE_SECONDS = 1.5  # observation window for a wrongly honoured payload
SECOND_LAUNCH_SECONDS = 5.0


def _native_required():
    if importlib.util.find_spec("PySide6") is None:
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail("prerequisite missing (not RED): PySide6 is not installed in the required native job")
        pytest.skip("optional native desktop test: PySide6 is not installed")


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _connectable(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def _layout(tmp_path_factory, name):
    root = tmp_path_factory.mktemp(name)
    data, home, control = root / "data", root / "t2ipc-home", root / "control"
    for directory in (data, home, control):
        directory.mkdir()
    return root, data, home, control


def _env(data, home, port):
    env = {k: v for k, v in os.environ.items() if not k.startswith("SILENTSUITE_")}
    pythonpath = str(BRIDGE_ROOT / "src")
    if env.get("PYTHONPATH"):
        pythonpath = pythonpath + os.pathsep + env["PYTHONPATH"]
    env.update({
        "SILENTSUITE_DATA_DIR": str(data),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(port),
        "PYTHONPATH": pythonpath,
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    if sys.platform != "win32":
        env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                    "XDG_DATA_HOME": str(home / ".local" / "share")})
    return env


def _args(role, root, control=None, ready=None, registration=False):
    out = root / f"{role}.json"
    argv = [sys.executable, str(PROBE), "--role", role, "--out", str(out)]
    if control is not None:
        argv += ["--control", str(control)]
    if ready is not None:
        argv += ["--ready", str(ready)]
    if registration:
        argv.append("--with-cli-registration")
    return argv, out


def _spawn_owner(root, env, control, registration=False):
    argv, out = _args("owner", root, control=control, ready=root / "ready.json", registration=registration)
    stdout = open(root / "owner.stdout", "w", encoding="utf-8")
    stderr = open(root / "owner.stderr", "w", encoding="utf-8")
    process = subprocess.Popen(argv, stdout=stdout, stderr=stderr, env=env, text=True)
    return process, out, (stdout, stderr)


def _tail(path, size=2500):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")[-size:]
    except OSError:
        return ""


def _wait_for(path, process, timeout, what, root):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if Path(path).exists():
            return True
        if process is not None and process.poll() is not None:
            pytest.fail(
                f"fixture did not complete (not RED): owner exited rc={process.returncode} before {what}\n"
                f"owner stderr:\n{_tail(root / 'owner.stderr')}"
            )
        time.sleep(0.1)
    return False


def _run_child(role, root, env, ready=None, registration=False):
    argv, out = _args(role, root, ready=ready, registration=registration)
    started = time.monotonic()
    try:
        completed = subprocess.run(argv, capture_output=True, text=True, timeout=CHILD_TIMEOUT, env=env)
    except subprocess.TimeoutExpired:
        pytest.fail(f"fixture timeout (not RED): {role} exceeded {CHILD_TIMEOUT}s")
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    if completed.returncode != 0 or result.get("stage") != "done":
        pytest.fail(
            f"fixture did not complete (not RED): {role} rc={completed.returncode} stage={result.get('stage')!r}\n"
            f"stderr:\n{completed.stderr[-2500:]}"
        )
    if result.get("entry_error") is not None:
        # A product crash is never a handover, a control or a semantic RED.
        pytest.fail(
            f"desktop entrypoint raised (not RED): {role} entry_error={result['entry_error']!r}\n"
            f"stderr:\n{completed.stderr[-2500:]}"
        )
    result["prepared"] = PREPARED_LINE in completed.stdout
    result["wall_seconds"] = round(time.monotonic() - started, 2)
    result["stderr_tail"] = completed.stderr[-2500:]
    return result


def _finish_owner(process, out, files, root):
    try:
        process.wait(timeout=CHILD_TIMEOUT)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=30)
    finally:
        for handle in files:
            handle.close()
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {}
    result["prepared"] = PREPARED_LINE in _tail(root / "owner.stdout", 100000)
    result["stderr_tail"] = _tail(root / "owner.stderr")
    result["rc"] = process.returncode
    return result


def _require_owner_ok(owner):
    if owner.get("rc") != 0 or owner.get("stage") != "done":
        pytest.fail(
            f"fixture did not complete (not RED): owner rc={owner.get('rc')!r} stage={owner.get('stage')!r}\n"
            f"owner stderr:\n{owner.get('stderr_tail', '')}"
        )
    if owner.get("entry_error") is not None:
        pytest.fail(
            f"desktop entrypoint raised in the owner (not RED): {owner['entry_error']!r}\n"
            f"owner stderr:\n{owner.get('stderr_tail', '')}"
        )


def _require_ack(acknowledged, what, root):
    if not acknowledged:
        pytest.fail(f"fixture timeout (not RED): owner never acknowledged {what}\n{_tail(root / 'owner.stderr')}")


def _describe(second):
    return (
        f"exit_code={second.get('exit_code')!r} seconds_in_main={second.get('seconds_in_main')!r} "
        f"observed={second.get('observed')!r} removal_calls={second.get('removal_calls')!r} "
        f"prepared={second.get('prepared')!r} serving_attempted={second.get('serving_attempted')!r} "
        f"client_socket={second.get('client_socket')!r} legacy_gate_calls={second.get('legacy_gate_calls')!r}\n"
        f"stderr tail:\n{second.get('stderr_tail', '')}"
    )


def _assert_second_did_nothing(second):
    observed = second["observed"]
    assert observed["prompts"] == [], f"a second launch ran the legacy gate: {_describe(second)}"
    assert second["removal_calls"] == 0, _describe(second)
    assert second["prepared"] is False, _describe(second)
    assert second["serving_attempted"] is False, _describe(second)
    assert observed["web_views_seen"] == 0, _describe(second)
    assert second["service_manager_traps"] == [], _describe(second)
    # Delegating call counters on the real legacy gate and its detectors
    # (desktop.resolve_legacy_conflicts / legacy_conflicts /
    # _loopback_listener_in_use, autostart.legacy_cli_registration_present):
    # a second launch must not even read legacy state.
    assert second["legacy_gate_calls"] == {}, f"a second launch read legacy state: {_describe(second)}"


# --- healthy owner reopened by a second launch ------------------------------


@pytest.fixture(scope="module")
def healthy(tmp_path_factory):
    _native_required()
    root, data, home, control = _layout(tmp_path_factory, "t2ipc-healthy")
    port = _free_port()
    env = _env(data, home, port)
    owner, owner_out, files = _spawn_owner(root, env, control)
    journey = {"port": port}
    try:
        if not _wait_for(root / "ready.json", owner, READY_TIMEOUT, "ready", root):
            pytest.fail(f"fixture timeout (not RED): owner never showed its dashboard\n{_tail(root / 'owner.stderr')}")
        journey["ready"] = json.loads((root / "ready.json").read_text(encoding="utf-8"))
        journey["lock_busy_before"] = probe_instance_lock(data) == "BUSY"
        journey["port_connectable_before"] = _connectable(port)
        # The CLI registration appears only now, after the owner started.
        journey["second"] = _run_child("second", root, env, registration=True)
        journey["shown_ack"] = _wait_for(control / "shown.ack", owner, SHOW_ACK_TIMEOUT, "show ack", root)

        (control / "rehide").write_text("1", encoding="utf-8")
        _require_ack(_wait_for(control / "rehidden.ack", owner, 10, "rehide ack", root), "the rehide", root)
        if journey["ready"].get("ipc", {}).get("found"):
            journey["payload"] = _run_child("payload", root, env, ready=root / "ready.json")
            time.sleep(PAYLOAD_OBSERVE_SECONDS)
        (control / "report").write_text("1", encoding="utf-8")
        _require_ack(_wait_for(control / "report.ack", owner, 10, "report ack", root), "the report", root)
        journey["lock_busy_after"] = probe_instance_lock(data) == "BUSY"
        journey["port_connectable_after"] = _connectable(port)
        (control / "close").write_text("1", encoding="utf-8")
    finally:
        # On any early exit, let the owner walk its remaining phases to a normal close.
        for flag in ("rehide", "report", "close"):
            (control / flag).write_text("1", encoding="utf-8")
        journey["owner"] = _finish_owner(owner, owner_out, files, root)
    _require_owner_ok(journey["owner"])
    return journey


def test_healthy_owner_is_a_real_bound_lock_holder(healthy):
    # Control: real witnesses for the I10 situation.
    assert healthy["lock_busy_before"] is True
    assert healthy["port_connectable_before"] is True
    assert healthy["ready"]["registry_dashboard_url"] == f"http://127.0.0.1:{healthy['port']}/"


def test_second_launch_never_runs_the_legacy_gate_against_a_healthy_owner(healthy):
    # Control (I10): a bound owner port and a fresh CLI registration are both
    # present, yet the second launch must not prompt, remove, prepare or serve.
    second = healthy["second"]
    _assert_second_did_nothing(second)
    assert second["seconds_in_main"] < SECOND_LAUNCH_SECONDS, _describe(second)
    assert healthy["lock_busy_after"] is True
    assert healthy["port_connectable_after"] is True


def test_second_launch_sends_show_and_exits_zero(healthy):
    second = healthy["second"]
    assert second["exit_code"] in (None, 0), f"the second launch did not hand over to the owner: {_describe(second)}"
    # Observed through a delegating subclass of the real QLocalSocket in the
    # second process: exactly b"show" leaves it, and it never tries to read.
    client = second["client_socket"]
    assert client["connects"] >= 1, _describe(second)
    assert "".join(client["writes_hex"]) == b"show".hex() and client["write_bytes"] == 4, _describe(second)
    assert client["read_attempts"] == 0, _describe(second)


def test_owner_window_comes_back_after_a_second_launch(healthy):
    assert healthy["shown_ack"] is True, (
        f"the hidden owner window was not shown by the second launch; "
        f"owner observed={healthy['owner'].get('observed')!r}"
    )


def test_owner_ipc_endpoint_is_user_scoped(healthy):
    ipc = healthy["ready"].get("ipc", {})
    if not ipc.get("found"):
        pytest.fail("NOT REACHED: the owner exposes no QLocalServer yet")
    assert ipc.get("listening") is True, ipc
    if sys.platform == "win32":
        # Windows pipe ACLs are not observable here; that acceptance stays with T5.
        assert ipc.get("full_name"), ipc
        return
    # macOS ignores socket file permissions (Qt QLocalServer docs), so the
    # protection must come from a private, non-symlink parent directory.
    assert ipc.get("socket_is_socket") is True, ipc
    assert ipc.get("socket_owner_is_me") is True, ipc
    assert ipc.get("parent_is_symlink") is False, ipc
    assert ipc.get("parent_owner_is_me") is True, ipc
    assert ipc.get("parent_group_other_bits") == "0o0", ipc


def test_non_show_payloads_change_nothing_and_get_no_reply(healthy):
    if not healthy["ready"].get("ipc", {}).get("found"):
        pytest.fail("NOT REACHED: the owner exposes no QLocalServer yet")
    sent = healthy["payload"]["payloads"]
    # Every payload was really submitted over the real socket, not just connected.
    assert len(sent) == 5, sent
    for entry in sent:
        assert entry["connected"] is True, entry
        assert entry["written"] == entry["size"], entry
        assert entry["flushed"] is True, entry
        assert entry["received"] == 0, entry
    observed = healthy["owner"]["observed"]
    assert observed.get("view_url_before_payloads"), observed
    assert observed.get("view_url_after_payloads") == observed["view_url_before_payloads"], observed
    assert observed["shown_after_rehide"] is False, observed
    assert observed.get("dialogs_after_payloads") == 0, observed
    assert healthy["owner"]["external_open_calls"] == []


def test_owner_closes_cleanly_after_the_journey(healthy):
    # Control: the owner itself was never disturbed.
    owner = healthy["owner"]
    assert owner.get("stage") == "done", owner.get("stderr_tail")
    assert owner["exit_code"] in (None, 0), owner.get("stderr_tail")
    assert owner["lock_free_after"] is True
    assert owner["removal_calls"] == 0
    assert owner["observed"]["prompts"] == []


# --- no owner answers -------------------------------------------------------


@pytest.fixture(scope="module")
def unreachable(tmp_path_factory):
    _native_required()
    root, data, home, _ = _layout(tmp_path_factory, "t2ipc-unreachable")
    env = _env(data, home, _free_port())
    with hold_instance_lock(data):  # a lock holder with no desktop IPC server
        return _run_child("second", root, env, registration=True)


def test_unreachable_owner_second_launch_does_nothing_else(unreachable):
    _assert_second_did_nothing(unreachable)


def test_unreachable_owner_shows_fixed_native_message_and_exits_nonzero(unreachable):
    dialogs = unreachable["observed"]["other_dialogs"]
    assert any(BUSY_MESSAGE in text for text in dialogs), (
        f"no native 'already running' message: {_describe(unreachable)}"
    )
    assert unreachable["exit_code"] not in (None, 0), _describe(unreachable)


# --- relaunch while the owner's migration prompt is up ---------------------


@pytest.fixture(scope="module")
def reentry(tmp_path_factory):
    _native_required()
    root, data, home, control = _layout(tmp_path_factory, "t2ipc-reentry")
    env = _env(data, home, _free_port())
    owner, owner_out, files = _spawn_owner(root, env, control, registration=True)
    journey = {}
    try:
        if not _wait_for(root / "ready.json", owner, READY_TIMEOUT, "migration prompt", root):
            pytest.fail(f"fixture timeout (not RED): owner never showed its migration prompt\n"
                        f"{_tail(root / 'owner.stderr')}")
        journey["ready"] = json.loads((root / "ready.json").read_text(encoding="utf-8"))
        journey["second"] = _run_child("second", root, env, registration=True)
    finally:
        (control / "cancel").write_text("1", encoding="utf-8")
        journey["owner"] = _finish_owner(owner, owner_out, files, root)
    _require_owner_ok(journey["owner"])
    return journey


def test_relaunch_during_migration_prompt_does_nothing_else(reentry):
    _assert_second_did_nothing(reentry["second"])
    owner = reentry["owner"]
    assert len(owner["observed"]["prompts"]) == 1, owner["observed"]
    assert owner["removal_calls"] == 0
    assert owner["prepared"] is False
    assert owner["exit_code"] not in (None, 0)


def test_relaunch_during_migration_prompt_hands_over_to_the_owner(reentry):
    second = reentry["second"]
    assert second["exit_code"] in (None, 0), f"the relaunch did not hand over to the owner: {_describe(second)}"
    client = second["client_socket"]
    assert "".join(client["writes_hex"]) == b"show".hex() and client["read_attempts"] == 0, _describe(second)


# --- startup race: the endpoint appears between 2 s and 3 s -----------------
#
# Client retry-budget check only. A real lock is held by a non-desktop holder,
# the real main(flavor="desktop") takes the busy-lock path, and a CONTROLLED Qt
# listener (ipc_probe role late_listener, not the product owner, no window)
# opens the product's own user/DATA_DIR endpoint about 2.4 s after the second
# launch entered main(). It shows the sender keeps trying past 2 s; it does not
# prove the owner's GUI startup or activation, or that attempts stop at 3 s.


def _wait_until(predicate, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return None


def _read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


@pytest.fixture(scope="module")
def late_endpoint(tmp_path_factory):
    _native_required()
    root, data, home, control = _layout(tmp_path_factory, "t2ipc-late")
    env = _env(data, home, _free_port())
    journey = {}
    logs = [open(root / name, "w", encoding="utf-8") for name in
            ("listener.stdout", "listener.stderr", "second.stdout", "second.stderr")]
    listener = second = None
    try:
        with hold_instance_lock(data):
            listener_argv, listener_out = _args("late_listener", root, control=control)
            listener = subprocess.Popen(listener_argv, stdout=logs[0], stderr=logs[1], env=env, text=True)
            if not _wait_until(lambda: (control / "listener.ready").exists() or listener.poll() is not None, 60) \
                    or not (control / "listener.ready").exists():
                pytest.fail(f"fixture did not complete (not RED): late listener never got ready\n"
                            f"{_tail(root / 'listener.stderr')}")

            second_argv, second_out = _args("second", root)
            second = subprocess.Popen(second_argv, stdout=logs[2], stderr=logs[3], env=env, text=True)
            entered = _wait_until(
                lambda: (_read_json(second_out) or {}).get("entry_wall") or (second.poll() is not None and -1), 60,
            )
            if not entered or entered == -1:
                pytest.fail(f"fixture did not complete (not RED): second launch never entered main()\n"
                            f"{_tail(root / 'second.stderr')}")
            delay = entered + LATE_ENDPOINT_AFTER_SECONDS - time.time()
            if delay > 0:
                time.sleep(delay)
            (control / "go").write_text("1", encoding="utf-8")
            listening = _wait_until(lambda: _read_json(control / "listening.json"), 10)
            if not listening:
                pytest.fail(f"fixture timeout (not RED): late listener never acknowledged listening\n"
                            f"{_tail(root / 'listener.stderr')}")
            try:
                second.wait(timeout=CHILD_TIMEOUT)
                listener.wait(timeout=30)
            except subprocess.TimeoutExpired:
                pytest.fail("fixture timeout (not RED): late-endpoint processes did not finish")
    finally:
        for process in (second, listener):
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=30)
        for handle in logs:
            handle.close()

    second_result = _read_json(second_out) or {}
    listener_result = _read_json(listener_out) or {}
    for role, process, result, log in (
        ("second", second, second_result, "second.stderr"),
        ("late_listener", listener, listener_result, "listener.stderr"),
    ):
        if process.returncode != 0 or result.get("stage") != "done":
            pytest.fail(f"fixture did not complete (not RED): {role} rc={process.returncode} "
                        f"stage={result.get('stage')!r}\n{_tail(root / log)}")
    if second_result.get("entry_error") is not None:
        pytest.fail(f"desktop entrypoint raised (not RED): {second_result['entry_error']!r}\n"
                    f"{_tail(root / 'second.stderr')}")
    if not listening.get("listening"):
        pytest.fail(f"fixture did not complete (not RED): late listener could not listen\n"
                    f"{_tail(root / 'listener.stderr')}")
    opened_after = round(listening["listen_wall"] - second_result["entry_wall"], 2)
    if not LATE_ENDPOINT_WINDOW[0] <= opened_after <= LATE_ENDPOINT_WINDOW[1]:
        pytest.fail(f"fixture timing outside {LATE_ENDPOINT_WINDOW} s (not RED): the endpoint opened "
                    f"{opened_after} s after the second launch entered main()")
    second_result["prepared"] = PREPARED_LINE in _tail(root / "second.stdout", 100000)
    second_result["stderr_tail"] = _tail(root / "second.stderr")
    journey.update({"second": second_result, "listener": listener_result, "opened_after": opened_after})
    return journey


def test_late_endpoint_second_launch_does_nothing_else(late_endpoint):
    # Control: whatever the handover outcome, the busy-lock path stays inert.
    _assert_second_did_nothing(late_endpoint["second"])


def test_second_launch_still_hands_over_to_an_endpoint_opened_between_two_and_three_seconds(late_endpoint):
    second = late_endpoint["second"]
    assert second["exit_code"] in (None, 0), (
        f"the second launch gave up before the 3-second deadline; the endpoint opened "
        f"{late_endpoint['opened_after']} s after it entered main(): {_describe(second)}"
    )
    listener = late_endpoint["listener"]
    assert listener["connected"] is True, listener
    assert listener["received_hex"] == b"show".hex(), listener
    client = second["client_socket"]
    assert "".join(client["writes_hex"]) == b"show".hex() and client["read_attempts"] == 0, _describe(second)
