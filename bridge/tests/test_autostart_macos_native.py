"""Native macOS launchd lifecycle for --install-autostart / --remove-autostart (real launchctl).

Runs only on macOS and invokes the real ``launchctl`` against the runner user's
``gui/<uid>`` domain. Isolation:

* the job label is a unique ``io.silentsuite.autostart-test.<random>`` value
  patched into ``autostart.LAUNCHD_LABEL``; HOME, the data directory, the
  agent file and logs live under ``tmp_path``;
* a guard refuses any subprocess call that names the production
  ``io.silentsuite.bridge`` label or agent file, so the real agent is never
  touched, and no other job is addressed;
* teardown boots out only the test label and kills only the test's own
  harmless child (checked by parent pid and its unique argv).

Limit, stated explicitly: the launched program is a harmless ``/bin/sh``
child that records its pid and sleeps. These tests prove the launchd manager
lifecycle (registration, explicit start, recovery of a stopped job with
changed arguments, verification, removal). They do not start the bridge and
prove nothing about CalDAV/CardDAV readiness, authentication or lasting health.

If ``launchctl`` or the gui domain is unavailable on macOS the tests fail with
a fixed reason instead of skipping. Raw launchctl output is never printed or
asserted on; only exit codes and the child's own marker files are inspected.
"""

import os
import secrets
import shutil
import signal
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

from silentsuite_bridge import autostart, config
from tests.test_autostart_macos_lifecycle import (
    NOT_CONFIRMED,
    PRODUCTION_LABEL,
    RAW_MARKER,
    RAW_NOISE,
    STAGE_MESSAGES,
    TEST_UID,
    UnboundedVerificationError,
    VirtualClock,
    isolated_bridge_env,
    read_settings,
)

pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="real launchd lifecycle runs on macOS only")

LAUNCHCTL_TIMEOUT = 30

# Harmless child: records "<pid> <parent pid>" then sleeps under its unique
# token. Variant "fail" exits non-zero at once; a variant with a ".stop" marker
# exits 0 at once so a relaunch cannot keep it running.
CHILD_SCRIPT = """#!/bin/sh
variant="$1"
markers="$2"
token="$3"
if [ "$variant" = "fail" ]; then
  : > "$markers/fail.$$.attempt"
  exit 3
fi
if [ -e "$markers/$variant.stop" ]; then
  exit 0
fi
echo "$$ $PPID" > "$markers/$variant.tmp"
mv "$markers/$variant.tmp" "$markers/$variant.pid"
exec /bin/sleep "$token"
"""

_REAL_RUN = subprocess.run


class ProductionAgentTouchedError(BaseException):
    """Raised before executing any command that names the production agent."""


def _guarded_run(argv, *args, **kwargs):
    tokens = [argv] if isinstance(argv, (str, bytes)) else list(argv)
    if any(PRODUCTION_LABEL in os.fsdecode(token) for token in tokens):
        raise ProductionAgentTouchedError("refused a command addressing the production launchd agent")
    return _REAL_RUN(argv, *args, **kwargs)


def _launchctl(*args):
    """Run real launchctl; return only the exit code (output is captured and discarded)."""
    try:
        result = _guarded_run(["launchctl", *args], capture_output=True, timeout=LAUNCHCTL_TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        return None
    return result.returncode


def _registered(service):
    return _launchctl("print", service) == 0


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return predicate()


def _read_marker(markers, variant):
    try:
        pid, parent = (markers / f"{variant}.pid").read_text(encoding="utf-8").split()
        return int(pid), int(parent)
    except (OSError, ValueError):
        return None


def _is_own_child(pid, token):
    result = _REAL_RUN(
        ["ps", "-o", "ppid=", "-o", "command=", "-p", str(pid)],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    fields = result.stdout.split(None, 1)
    if result.returncode != 0 or len(fields) != 2:
        return False
    return fields[0] == "1" and fields[1].strip() == f"/bin/sleep {token}"


def _cleanup(native):
    if _registered(native.service):
        _launchctl("bootout", native.service)
        _wait_until(lambda: not _registered(native.service), 10)
    if _registered(native.service) and native.plist.exists():
        _launchctl("unload", str(native.plist))
    for marker in native.markers.glob("*.pid"):
        recorded = _read_marker(native.markers, marker.stem)
        if recorded and _is_own_child(recorded[0], native.token):
            os.kill(recorded[0], signal.SIGKILL)
    assert not _registered(native.service), "the isolated test agent is still registered after cleanup"


@pytest.fixture
def native(tmp_path, monkeypatch):
    if shutil.which("launchctl") is None:
        pytest.fail("launchctl is not available on this macOS runner; the native lifecycle test cannot run",
                    pytrace=False)
    domain = f"gui/{os.getuid()}"
    if _launchctl("print", domain) != 0:
        pytest.fail("no launchd gui domain for the runner user; the native lifecycle test cannot run", pytrace=False)

    label = f"io.silentsuite.autostart-test.{secrets.token_hex(6)}"
    service = f"{domain}/{label}"
    assert PRODUCTION_LABEL not in label
    if _registered(service):
        pytest.fail("the unique test label is already registered; refusing to continue", pytrace=False)

    monkeypatch.setattr(autostart, "LAUNCHD_LABEL", label)
    bridge = isolated_bridge_env(tmp_path, monkeypatch)
    monkeypatch.setattr(subprocess, "run", _guarded_run)
    markers = tmp_path / "markers"
    markers.mkdir()
    script = tmp_path / "child.sh"
    script.write_text(CHILD_SCRIPT, encoding="utf-8")
    script.chmod(0o755)
    token = str(3000 + secrets.randbelow(900))

    def use_child(variant):
        argv = ["/bin/sh", str(script), variant, str(markers), token]
        monkeypatch.setattr(autostart, "_get_binary_path", lambda: list(argv))

    state = SimpleNamespace(**vars(bridge), service=service, markers=markers, token=token, use_child=use_child)
    try:
        yield state
    finally:
        _cleanup(state)


def _persist_port(native):
    native.monkeypatch.setenv("SILENTSUITE_LISTEN_PORT", "45123")
    config.load_settings()


def test_native_reinstall_recovers_stopped_job_with_changed_arguments_then_removes(native, capsys):
    _persist_port(native)
    native.use_child("first")

    assert autostart.install_autostart() == 0, "initial install did not confirm a running launchd child"
    assert _wait_until(lambda: _read_marker(native.markers, "first") is not None, 15), (
        "launchd did not start the first child"
    )
    first_pid, first_parent = _read_marker(native.markers, "first")
    assert first_parent == 1, "the first child was not launched by launchd"
    assert _alive(first_pid)
    assert _registered(native.service), "the job is not registered in the gui domain"

    # Stop the actual child while the job stays registered; any relaunch of
    # this variant exits at once, so the job is left registered but not running.
    (native.markers / "first.stop").touch()
    (native.markers / "first.pid").unlink()
    os.kill(first_pid, signal.SIGTERM)
    assert _wait_until(lambda: not _alive(first_pid), 15), "the first child did not stop"
    time.sleep(1.5)
    assert _registered(native.service), "the job must stay registered while its child is stopped"
    assert _read_marker(native.markers, "first") is None

    native.use_child("second")
    assert autostart.install_autostart() == 0, "reinstall did not recover the registered, stopped job"
    assert _wait_until(lambda: _read_marker(native.markers, "second") is not None, 10), (
        "reinstall did not start a child with the changed launch arguments"
    )
    second_pid, second_parent = _read_marker(native.markers, "second")
    assert second_parent == 1, "the second child was not launched by launchd"
    assert _alive(second_pid)
    assert _read_marker(native.markers, "first") is None

    capsys.readouterr()
    assert autostart.remove_autostart() == 0
    assert _wait_until(lambda: not _registered(native.service), 15), "removal left the test job registered"
    assert _wait_until(lambda: not _alive(second_pid), 15), "removal did not stop the child"
    assert not native.plist.exists()
    assert read_settings(native.settings) == {"network": {"listenPort": 45123}}
    assert "was kept" in capsys.readouterr().out


def test_native_child_that_exits_is_not_reported_as_started(native, capsys):
    _persist_port(native)
    native.use_child("fail")

    status = autostart.install_autostart()

    captured = capsys.readouterr()
    assert status != 0, "launchctl accepted the job but its child exited; install must not report success"
    assert _wait_until(lambda: any(native.markers.glob("fail.*.attempt")), 10), (
        "launchd never launched the failing child, so startup was not exercised"
    )
    shown = captured.out + captured.err
    assert STAGE_MESSAGES["not_running"] in shown
    assert NOT_CONFIRMED in shown
    # Recoverable failure: agent file and persisted profile stay for a retry.
    assert native.plist.exists()
    assert read_settings(native.settings) == {"network": {"listenPort": 45123}}

    assert autostart.remove_autostart() == 0
    assert _wait_until(lambda: not _registered(native.service), 15), "removal left the test job registered"
    assert not native.plist.exists()


# --- Cleanup safety with an intercepted subprocess boundary ----------------------
#
# Synthetic controls, NOT additional real-launchd acceptance: _REAL_RUN and
# subprocess.run are replaced by a scripted launchctl, os.kill refuses, and the
# clock is virtual, so no real launchctl, ps or signal is used. The marker
# directory is empty and the service is a unique test label. A print that
# times out or fails is not proof the test job is gone: cleanup must still
# attempt a bounded bootout of its own service and then fail with a
# content-free AssertionError unless absence is positively established.


class RealSignalAttemptedError(BaseException):
    """Raised if a synthetic cleanup case tries to signal a real process."""


def _refuse_kill(pid, sig):
    raise RealSignalAttemptedError("synthetic cleanup must not signal real processes")


class _ScriptedLaunchctl:
    """Answer the native helpers' launchctl calls from a script; nothing real runs."""

    MAX_CALLS = 200

    def __init__(self, clock, scenario):
        self.clock = clock
        self.scenario = scenario
        self.calls = []
        self.kwargs = []
        self.booted_out = False

    def _answer(self, argv, returncode, stdout=""):
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout.encode(), stderr=RAW_NOISE.encode())

    def _timeout(self, argv, kwargs):
        raise subprocess.TimeoutExpired(
            argv, kwargs.get("timeout") or LAUNCHCTL_TIMEOUT, output=RAW_NOISE.encode(), stderr=RAW_NOISE.encode()
        )

    def __call__(self, argv, *args, **kwargs):
        argv = [os.fsdecode(token) for token in argv]
        self.calls.append(argv)
        self.kwargs.append(kwargs)
        if len(self.calls) > self.MAX_CALLS:
            raise UnboundedVerificationError("cleanup polled launchctl without bound")
        self.clock.advance(0.01)
        if argv[0] != "launchctl" or len(argv) < 2:
            return self._answer(argv, 127)
        if argv[1] == "bootout":
            self.booted_out = True
            return self._answer(argv, 0)
        if argv[1] != "print":
            return self._answer(argv, 64)
        if self.scenario == "print-times-out":
            self._timeout(argv, kwargs)
        if self.scenario == "print-unexpected-nonzero":
            return self._answer(argv, 5, RAW_NOISE)
        # Registered until the bootout, then every query fails.
        if not self.booted_out:
            return self._answer(argv, 0, RAW_NOISE)
        if self.scenario == "query-times-out-after-bootout":
            self._timeout(argv, kwargs)
        return self._answer(argv, 5, RAW_NOISE)


@pytest.mark.parametrize(
    "scenario",
    [
        "print-times-out",
        "print-unexpected-nonzero",
        "query-fails-after-bootout",
        "query-times-out-after-bootout",
    ],
)
def test_cleanup_never_treats_a_failed_query_as_absence(tmp_path, monkeypatch, scenario):
    domain = f"gui/{TEST_UID}"
    service = f"{domain}/io.silentsuite.autostart-test.{secrets.token_hex(6)}"
    markers = tmp_path / "markers"
    markers.mkdir()
    plist = tmp_path / "home" / "agent.plist"
    plist.parent.mkdir()
    plist.write_bytes(b"synthetic agent file")
    state = SimpleNamespace(service=service, plist=plist, markers=markers, token="3333")
    clock = VirtualClock()
    scripted = _ScriptedLaunchctl(clock, scenario)
    monkeypatch.setattr(time, "monotonic", clock.monotonic)
    monkeypatch.setattr(time, "sleep", clock.sleep)
    monkeypatch.setitem(globals(), "_REAL_RUN", scripted)
    monkeypatch.setattr(subprocess, "run", scripted)
    monkeypatch.setattr(os, "kill", _refuse_kill)

    with pytest.raises(AssertionError) as failure:
        _cleanup(state)

    assert RAW_MARKER not in str(failure.value)
    assert "private-owner" not in str(failure.value)
    bootouts = [argv for argv in scripted.calls if argv[1:2] == ["bootout"]]
    assert bootouts, "cleanup must attempt a bootout of its own service while absence is unproven"
    owned = ([service], [domain, str(plist)], [str(plist)])
    for argv in scripted.calls:
        assert argv[0] == "launchctl", "synthetic cleanup ran something other than launchctl"
        operands = [token for token in argv[2:] if not token.startswith("-")]
        assert operands in owned, "cleanup addressed something other than its own test service"
    assert all(kwargs.get("timeout") for kwargs in scripted.kwargs), "every cleanup launchctl call needs a timeout"
    assert all(
        kwargs.get("capture_output") or (kwargs.get("stdout") is not None and kwargs.get("stderr") is not None)
        for kwargs in scripted.kwargs
    ), "cleanup launchctl output must be captured"
