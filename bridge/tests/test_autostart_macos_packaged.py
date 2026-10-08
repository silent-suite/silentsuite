"""Packaged macOS acceptance: the frozen binary's real launchd autostart lifecycle.

This module drives the ACTUAL just-built frozen ``silentsuite-bridge``
executable (never a harmless substitute) through the real ``launchctl`` of a
fresh GitHub-hosted macOS runner, on the production label and the default
data paths, as one explicitly ordered lifecycle:

1. admission - a positively admitted hosted macOS runner
   (``GITHUB_ACTIONS``/``RUNNER_ENVIRONMENT``/``RUNNER_OS``/architecture), a
   confirmed Aqua launchd session (``manageruid`` is the runner UID,
   ``managername`` is ``Aqua``), and the supplied binary's file identity,
   identical owned copies, architecture (``lipo``) and version identity;
2. freshness - the production service ``gui/<uid>/io.silentsuite.bridge``,
   its agent file, and the default Bridge data/log directories must all be
   positively absent BEFORE the first install may claim them;
3. initial install - the first owned copy under ``RUNNER_TEMP`` runs
   ``--install-autostart`` with one explicit synthetic loopback port; the
   persisted ``settings.json``, the agent file arguments, the launchd job,
   the running child's PID/parent/executable path, and a bounded loopback
   listener probe are observed independently;
4. registered-but-stopped recovery - the first copy's executable path is
   retired and only its verified child is stopped, leaving a genuinely
   registered, stopped job with stale arguments; a second copy with
   identical bytes at a differently named owned path then runs
   ``--install-autostart`` and must replace that stale entry;
5. running replacement - with the recovered child independently confirmed
   running and owned (it is not stopped), a third identical-hash copy at
   another owned path runs ``--install-autostart``; the agent file must point
   at it, a distinct owned child must run from it, the previous child must
   exit, and the listener, settings bytes and zero-account state must hold;
6. removal - the third copy's ``--remove-autostart`` unregisters the agent
   and stops its child while the exact synthetic network profile bytes and
   the zero-account state stay preserved.

Freshness and other "must be absent" filesystem checks use ``lstat``: any
existing entry, a dangling symlink included, is present, and an inspection
error is uncertainty that refuses. Cleanup requires bounded positive exit
confirmation for every recorded owned child; only a pid re-verified as that
exact launchd child is ever signalled.

Isolation: the subject is the runner user's own default, disposable state.
No launchd environment is set, no other service is read or booted out, only
verified owned child PIDs are ever signalled, the synthetic port is a
loopback ephemeral port, and no default data is deleted or reset. Raw
launchctl/ps/binary output is captured but never printed; assertions use
fixed stage messages, exit codes, counts and digests only.

Limits, stated explicitly: a running child and an accepting loopback socket
prove process start and listener bind only; they are not CalDAV/CardDAV
readiness, account resolution, or lasting health.

Fail-closed policy: whenever this module is explicitly enabled by
``SILENTSUITE_PACKAGED_BINARY``, every missing piece of evidence - binary,
runner admission, GUI context, absence, query agreement, version or
architecture - fails the test. Ordinary source-suite runs without the
variable skip exactly this packaged-only case.
"""

import hashlib
import json
import os
import platform
import plistlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from appdirs import user_data_dir

BINARY_ENV = "SILENTSUITE_PACKAGED_BINARY"
ARCH_ENV = "SILENTSUITE_PACKAGED_ARCH"
VERSION_ENV = "SILENTSUITE_PACKAGED_VERSION"

# The production service this acceptance test owns on the disposable runner.
SERVICE_LABEL = "io.silentsuite.bridge"

# Exit status of ``launchctl print`` for a service that is not loaded, as
# validated by tests/test_autostart_macos_native.py on the hosted runner. Only
# this exact status counts as positive absence; every other non-zero status or
# a timeout stays "unknown" and fails closed.
SERVICE_ABSENT_STATUS = 113

LAUNCHCTL_TIMEOUT = 30.0
BINARY_TIMEOUT = 180.0
STATE_WAIT_SECONDS = 60.0
LISTENER_WAIT_SECONDS = 120.0
TEARDOWN_WAIT_SECONDS = 45.0
# Cleanup waits this long for a recorded child to exit on its own before the
# re-verified owned pid may be signalled.
CHILD_GRACE_SECONDS = 10.0
POLL_SECONDS = 0.5

# Fixed, content-free messages the frozen binary prints on the paths under
# test; assertions use these strings, never raw output.
INSTALL_CONFIRMED = "launchd started the bridge process"
PROCESS_ONLY_NOTE = "confirms the process start only"
PROFILE_PERSISTED = "Persisted explicit network settings"
REMOVE_CONFIRMED = "Auto-start removed."
PROFILE_RETAINED = "was kept"
NO_ACCOUNTS = "No accounts configured."

# Fixed stage messages the product itself prints on failure; at most one of
# these may be echoed back in a failure report instead of raw output.
LAUNCHCTL_FAILURE_PHRASES = (
    "launchctl is not available",
    "launchctl did not respond in time",
    "is not running in this user's GUI login session",
    "could not read the agent state",
    "could not stop the existing agent",
    "could not register the agent",
    "could not start the agent",
    "the bridge process is not running",
)

# Scoped to the real packaged lifecycle only: the intercepted safety controls
# at the end of this module run in ordinary source CI as well.
packaged_only = pytest.mark.skipif(
    os.environ.get(BINARY_ENV) is None,
    reason=(
        "packaged autostart acceptance runs only when a just-built frozen binary is supplied "
        f"through {BINARY_ENV}; ordinary source runs skip this packaged-only case"
    ),
)


def _fail(reason: str) -> None:
    pytest.fail(reason, pytrace=False)


def _launchctl(*args):
    """Run launchctl with a bound and captured output; ``None`` when it could not run."""
    try:
        return subprocess.run(
            ["launchctl", *args], capture_output=True, text=True, timeout=LAUNCHCTL_TIMEOUT, check=False
        )
    except (subprocess.TimeoutExpired, OSError):
        return None


def _service_state(service):
    """\"present\", \"absent\" or \"unknown\" for the explicit service target.

    Only the documented not-loaded status is absence; output is never parsed
    here and never printed.
    """
    result = _launchctl("print", service)
    if result is None:
        return "unknown"
    if result.returncode == 0:
        return "present"
    if result.returncode == SERVICE_ABSENT_STATUS:
        return "absent"
    return "unknown"


def _list_lookup():
    """(state, pid) for the exact label from a successful ``launchctl list``.

    Mirrors the parser the bridge itself uses on this output (PID column,
    ``-`` for a loaded job that is not running). A failed query returns
    ``"unknown"``: absence is only ever concluded from a successful listing
    that does not carry the label, never from an error code.
    """
    result = _launchctl("list")
    if result is None or result.returncode != 0:
        return "unknown", None
    for line in result.stdout.splitlines():
        fields = line.split(None, 2)
        if len(fields) != 3 or fields[2].strip() != SERVICE_LABEL:
            continue
        if fields[0] == "-":
            return "stopped", None
        try:
            pid = int(fields[0])
        except ValueError:
            return "unknown", None
        return ("running", pid) if pid > 0 else ("stopped", None)
    return "absent", None


def _snapshot(service):
    """(state, pid) where state is ``absent``/``registered-running``/``registered-stopped``/``unknown``.

    The explicit-target query (``print``) and the listing the product itself
    parses (``list``) must agree; any disagreement or failed query is
    ``"unknown"`` so callers retry or fail closed instead of inferring state
    from an error.
    """
    print_state = _service_state(service)
    if print_state == "unknown":
        return "unknown", None
    list_state, pid = _list_lookup()
    if list_state == "unknown":
        return "unknown", None
    if print_state == "absent":
        return ("absent", None) if list_state == "absent" else ("unknown", None)
    if list_state == "running":
        return "registered-running", pid
    if list_state == "stopped":
        return "registered-stopped", None
    return "unknown", None


def _wait_until(predicate, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(POLL_SECONDS)
    return predicate()


def _wait_state(service, target, seconds):
    """Wait (bounded) for the agreeing snapshot to reach ``target``; return its pid or fail."""

    def reached():
        state, _ = _snapshot(service)
        return state == target

    if not _wait_until(reached, seconds):
        _fail(f"the packaged agent did not reach the {target!r} state within {int(seconds)}s")
    state, pid = _snapshot(service)
    if state != target:  # final strict re-read: a race fails closed
        _fail(f"the packaged agent left the {target!r} state immediately after it was observed")
    return pid


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_identity(pid):
    """(ppid, command) from a wide ``ps`` or ``None``; output is never printed."""
    try:
        result = subprocess.run(
            ["ps", "-ww", "-o", "ppid=", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if result.returncode != 0:
        return None
    fields = result.stdout.split(None, 1)
    if len(fields) != 2:
        return None
    return fields[0], fields[1].strip()


def _assert_owned_child(pid, path):
    """Require a launchd-started process whose parent is launchd and whose executable is exactly ``path``."""
    if pid <= 1 or pid == os.getpid():
        _fail(f"refusing to treat pid {pid} as an owned child")

    def matches():
        return _process_identity(pid) == ("1", str(path))

    if not _wait_until(matches, 30.0):
        _fail(f"pid {pid} is not an owned launchd child of the packaged copy under test")


def _listener_up(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1.0):
            return True
    except OSError:
        return False


def _free_loopback_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _clean_env(**updates):
    """The runner environment minus every SILENTSUITE_* variable.

    The installed agent runs with the clean environment launchd gives it, so
    the explicit network values under test travel only through the installer
    process environment and the persisted profile.
    """
    env = {name: value for name, value in os.environ.items() if not name.startswith("SILENTSUITE_")}
    env.update(updates)
    return env


def _run_binary(binary, args, env, timeout=BINARY_TIMEOUT):
    try:
        return subprocess.run(
            [str(binary), *args], capture_output=True, text=True, timeout=timeout, check=False, env=env
        )
    except subprocess.TimeoutExpired:
        _fail(f"the frozen binary did not finish {args[0]} within {int(timeout)}s")
    except OSError:
        _fail(f"the frozen binary could not be executed for {args[0]}")


def _combined_output(result):
    return (result.stdout or "") + (result.stderr or "")


def _expect_success(result, label):
    if result.returncode != 0:
        shown = _combined_output(result)
        reason = next(
            (phrase for phrase in LAUNCHCTL_FAILURE_PHRASES if phrase in shown), "no recognized stage message"
        )
        _fail(f"the frozen binary exited {result.returncode} for {label} ({reason})")


def _expect_text(result, phrase):
    if phrase not in _combined_output(result):
        _fail(f"the frozen binary output did not contain the fixed message {phrase!r}")


def _plist_payload(path):
    try:
        return plistlib.loads(path.read_bytes())
    except (OSError, ValueError):
        _fail("the installed agent file could not be read as a property list")


def _assert_plist_arguments(state, expected_path):
    payload = _plist_payload(state.plist)
    if payload.get("Label") != SERVICE_LABEL:
        _fail("the installed agent file does not carry the production service label")
    if payload.get("ProgramArguments") != [str(expected_path)]:
        _fail("the installed agent file does not point at the owned executable copy under test")
    if payload.get("RunAtLoad") is not True:
        _fail("the installed agent file does not request startup at login")


def _settings_bytes(state):
    try:
        return state.settings.read_bytes()
    except OSError:
        _fail("the installer did not persist a readable settings.json in the default data directory")


def _parsed_settings(state):
    try:
        return json.loads(_settings_bytes(state).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        _fail("the persisted settings.json is not readable JSON")


def _entry_state(path):
    """\"absent\" only when ``lstat`` reports a missing entry; any entry, a dangling symlink included, is \"present\".

    Every other inspection error is \"unknown\" so freshness fails closed.
    """
    try:
        os.lstat(path)
    except FileNotFoundError:
        return "absent"
    except OSError:
        return "unknown"
    return "present"


def _liveness(pid):
    """\"live\", \"exited\" or \"unknown\" from a signal-0 probe; only ESRCH proves exit."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "exited"
    except PermissionError:
        return "live"
    except OSError:
        return "unknown"
    return "live"


def _confirm_owned_child_exit(pid, path):
    """True only after bounded, positive exit confirmation of one recorded owned child.

    A child that exits within the grace window is never signalled. Otherwise
    only a pid re-confirmed immediately before the signal as the exact
    recorded launchd child of ``path`` receives one SIGKILL, and its exit must
    then be observed. An unknown or different identity is never signalled and
    can only succeed by exiting on its own within the bound.
    """
    if pid <= 1 or pid == os.getpid():
        return False

    def exited():
        return _liveness(pid) == "exited"

    if _wait_until(exited, CHILD_GRACE_SECONDS):
        return True
    if _process_identity(pid) != ("1", str(path)):
        return _wait_until(exited, TEARDOWN_WAIT_SECONDS)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # raced with its exit; the bounded probe below must still confirm it
    except OSError:
        return False
    return _wait_until(exited, TEARDOWN_WAIT_SECONDS)


def _cleanup(state):
    """Boot out only the positively claimed production-label service, then verify absence.

    Even when a state query failed, only the owned service is booted out and
    absence is retried; a query that never positively proves absence is a
    cleanup failure, never claimed as success. Every recorded owned child must
    be positively confirmed exited within a bound; only a re-verified owned
    child PID may be signalled, and never broadly.
    """
    if not state.owned:
        return
    if _service_state(state.service) != "absent":
        _launchctl("bootout", state.service)
        _wait_until(lambda: _service_state(state.service) == "absent", TEARDOWN_WAIT_SECONDS)
    unconfirmed = [pid for pid, path in state.verified_children if not _confirm_owned_child_exit(pid, path)]
    final_state = _service_state(state.service)
    if final_state != "absent":
        _fail("the packaged agent was not confirmed absent after cleanup")
    if unconfirmed:
        _fail("an owned packaged child was not confirmed stopped after cleanup")


@pytest.fixture
def packaged():
    """Admission, owned copies and cleanup for the packaged acceptance lifecycle."""
    if sys.platform != "darwin":
        _fail("packaged autostart acceptance requires macOS and real launchd")
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("RUNNER_ENVIRONMENT") != "github-hosted":
        _fail("packaged autostart acceptance requires a positively admitted GitHub-hosted runner")
    if os.environ.get("RUNNER_OS") != "macOS":
        _fail("packaged autostart acceptance requires a macOS runner")

    expected_arch = os.environ.get(ARCH_ENV, "")
    if not expected_arch:
        _fail("the packaging lane did not declare the expected architecture")
    if platform.machine() != expected_arch:
        _fail("the runner architecture does not match the declared packaging lane")

    if VERSION_ENV not in os.environ:
        _fail("the packaging lane did not declare the expected version evidence")

    runner_temp = os.environ.get("RUNNER_TEMP", "")
    if not runner_temp or not os.path.isdir(runner_temp):
        _fail("the GitHub runner temporary directory is not available for owned binary copies")

    binary = Path(os.environ.get(BINARY_ENV, ""))
    if not binary.is_file() or not os.access(binary, os.X_OK):
        _fail("the provided packaged binary is not an executable file")

    uid = os.getuid()
    domain = f"gui/{uid}"
    service = f"{domain}/{SERVICE_LABEL}"
    manager_uid = _launchctl("manageruid")
    if manager_uid is None or manager_uid.returncode != 0 or manager_uid.stdout.strip() != str(uid):
        _fail("no confirmed launchd Aqua session for the runner user; refusing to continue")
    manager_name = _launchctl("managername")
    if manager_name is None or manager_name.returncode != 0 or manager_name.stdout.strip() != "Aqua":
        _fail("the launchd manager is not Aqua; refusing to continue")

    home = Path.home()
    plist = home / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist"
    logs_dir = home / "Library" / "Logs" / "SilentSuiteBridge"
    data_dir = Path(user_data_dir("silentsuite-bridge", "silentsuite"))
    settings = data_dir / "settings.json"
    credentials = data_dir / "credentials.json"

    for path, what in (
        (plist, "agent file"),
        (data_dir, "default Bridge data directory"),
        (logs_dir, "default Bridge log directory"),
    ):
        entry = _entry_state(path)
        if entry == "unknown":
            _fail(f"the {what} could not be inspected on this runner; refusing to claim a non-fresh fixture")
        if entry != "absent":
            _fail(f"the {what} already exists on this runner; refusing to claim a non-fresh fixture")
    fresh_state, _ = _snapshot(service)
    if fresh_state == "unknown":
        _fail("the packaged bridge agent state could not be positively confirmed absent; refusing to continue")
    if fresh_state != "absent":
        _fail("the packaged bridge agent is already registered on this runner; refusing to continue")

    staging = Path(tempfile.mkdtemp(prefix="ss-packaged-autostart-", dir=runner_temp))
    stage_a = staging / "a" / "silentsuite-bridge"
    stage_b = staging / "b" / "silentsuite-bridge"
    stage_c = staging / "c" / "silentsuite-bridge"
    for stage in (stage_a, stage_b, stage_c):
        stage.parent.mkdir(parents=True)
        shutil.copyfile(binary, stage)
        os.chmod(stage, 0o755)
    if len({_sha256(path) for path in (binary, stage_a, stage_b, stage_c)}) != 1:
        _fail("the owned binary copies are not identical to the just-built frozen binary")

    try:
        arch_result = subprocess.run(
            ["lipo", "-archs", str(stage_a)], capture_output=True, text=True, timeout=60, check=False
        )
    except (subprocess.TimeoutExpired, OSError):
        _fail("lipo is not available to verify the packaged binary architecture")
    if arch_result.returncode != 0 or arch_result.stdout.split() != [expected_arch]:
        _fail("the packaged binary architecture does not match the declared packaging lane")

    version_result = _run_binary(stage_a, ["--version"], _clean_env())
    _expect_success(version_result, "--version")
    version_text = _combined_output(version_result)
    if "SilentSuite Bridge v" not in version_text:
        _fail("the packaged binary did not report its version")
    expected_version = os.environ.get(VERSION_ENV, "")
    if expected_version:
        if expected_version not in version_text:
            _fail("the packaged binary version does not match the admitted release version")
    elif "0.1.0" in version_text:
        _fail("the packaged binary reported the stale 0.1.0 version")

    port = _free_loopback_port()
    base_env = _clean_env()
    install_env = {**base_env, "SILENTSUITE_LISTEN_PORT": str(port)}

    state = SimpleNamespace(
        service=service,
        domain=domain,
        uid=uid,
        port=port,
        stage_a=stage_a,
        stage_b=stage_b,
        stage_c=stage_c,
        retired_a=stage_a.with_name(stage_a.name + ".retired"),
        plist=plist,
        logs_dir=logs_dir,
        data_dir=data_dir,
        settings=settings,
        credentials=credentials,
        base_env=base_env,
        install_env=install_env,
        owned=True,
        verified_children=[],
    )
    try:
        yield state
    finally:
        _cleanup(state)


@packaged_only
def test_packaged_macos_autostart_lifecycle(packaged):
    """Ordered journey: install -> registered-stopped stale recovery -> running replacement -> removal."""
    # --- Stage 1: initial install of the first owned copy --------------------
    install_a = _run_binary(packaged.stage_a, ["--install-autostart"], packaged.install_env)
    _expect_success(install_a, "--install-autostart (first copy)")
    _expect_text(install_a, INSTALL_CONFIRMED)
    _expect_text(install_a, PROCESS_ONLY_NOTE)
    _expect_text(install_a, PROFILE_PERSISTED)

    pid_a = _wait_state(packaged.service, "registered-running", STATE_WAIT_SECONDS)
    _assert_owned_child(pid_a, packaged.stage_a)
    packaged.verified_children.append((pid_a, packaged.stage_a))
    _assert_plist_arguments(packaged, packaged.stage_a)

    if not _wait_until(lambda: _listener_up(packaged.port), LISTENER_WAIT_SECONDS):
        _fail("the installed bridge did not accept a loopback connection on the synthetic port")
    settings_bytes = _settings_bytes(packaged)
    if _parsed_settings(packaged) != {"network": {"listenPort": packaged.port}}:
        _fail("the installer did not persist exactly the synthetic explicit network profile")

    # --- Stage 2: genuinely registered but stopped, with stale path/arguments -
    _assert_owned_child(pid_a, packaged.stage_a)
    try:
        os.rename(packaged.stage_a, packaged.retired_a)
    except OSError:
        _fail("the first owned copy could not be retired before stopping its child")
    try:
        os.kill(pid_a, signal.SIGTERM)
    except ProcessLookupError:
        pass  # the child already exited; the registered/stopped checks below still apply
    _wait_state(packaged.service, "registered-stopped", STATE_WAIT_SECONDS)
    if not _wait_until(lambda: not _alive(pid_a), TEARDOWN_WAIT_SECONDS):
        _fail("the stopped child of the first copy did not exit")
    _assert_plist_arguments(packaged, packaged.stage_a)  # the registered entry still holds the stale path

    # --- Stage 3: recovery by a second identical-hash copy at a new path ------
    install_b = _run_binary(packaged.stage_b, ["--install-autostart"], packaged.install_env)
    _expect_success(install_b, "--install-autostart (second copy)")
    _expect_text(install_b, INSTALL_CONFIRMED)
    pid_b = _wait_state(packaged.service, "registered-running", STATE_WAIT_SECONDS)
    if pid_b == pid_a:
        _fail("recovery did not start a new child process")
    _assert_owned_child(pid_b, packaged.stage_b)
    packaged.verified_children.append((pid_b, packaged.stage_b))
    _assert_plist_arguments(packaged, packaged.stage_b)
    if not _wait_until(lambda: _listener_up(packaged.port), LISTENER_WAIT_SECONDS):
        _fail("the recovered bridge did not accept a loopback connection on the synthetic port")

    # --- Stage 4: running replacement by a third identical-hash copy ----------
    # The recovered child is NOT stopped here: it must be independently
    # confirmed running and owned, and copy C's installer must replace it.
    running_state, running_pid = _snapshot(packaged.service)
    if running_state != "registered-running" or running_pid != pid_b:
        _fail("the recovered child was not confirmed running before the running replacement")
    _assert_owned_child(pid_b, packaged.stage_b)
    install_c = _run_binary(packaged.stage_c, ["--install-autostart"], packaged.install_env)
    _expect_success(install_c, "--install-autostart (third copy, running replacement)")
    _expect_text(install_c, INSTALL_CONFIRMED)
    _expect_text(install_c, PROCESS_ONLY_NOTE)
    pid_c = _wait_state(packaged.service, "registered-running", STATE_WAIT_SECONDS)
    if pid_c in (pid_a, pid_b):
        _fail("the running replacement did not start a new child process")
    _assert_owned_child(pid_c, packaged.stage_c)
    packaged.verified_children.append((pid_c, packaged.stage_c))
    _assert_plist_arguments(packaged, packaged.stage_c)
    if not _wait_until(lambda: _liveness(pid_b) == "exited", TEARDOWN_WAIT_SECONDS):
        _fail("the running replacement did not stop the previous child")
    if not _wait_until(lambda: _listener_up(packaged.port), LISTENER_WAIT_SECONDS):
        _fail("the replacement bridge did not accept a loopback connection on the synthetic port")
    if _settings_bytes(packaged) != settings_bytes:
        _fail("the running replacement changed the synthetic persisted network profile")
    if _entry_state(packaged.credentials) != "absent":
        _fail("the running replacement created account state that must remain absent")

    # --- Stage 5: removal keeps the synthetic network settings and zero accounts
    remove_c = _run_binary(packaged.stage_c, ["--remove-autostart"], packaged.base_env)
    _expect_success(remove_c, "--remove-autostart")
    _expect_text(remove_c, REMOVE_CONFIRMED)
    _expect_text(remove_c, PROFILE_RETAINED)
    _wait_state(packaged.service, "absent", STATE_WAIT_SECONDS)
    if _entry_state(packaged.plist) != "absent":
        _fail("removal left the agent file installed")
    if not _wait_until(lambda: _liveness(pid_c) == "exited", TEARDOWN_WAIT_SECONDS):
        _fail("removal did not stop the replacement child")
    if _settings_bytes(packaged) != settings_bytes:
        _fail("removal did not preserve exactly the synthetic persisted network profile")
    if _entry_state(packaged.credentials) != "absent":
        _fail("the packaged lifecycle created account state that must remain absent")
    listed = _run_binary(packaged.stage_c, ["--list-accounts"], packaged.base_env)
    _expect_success(listed, "--list-accounts")
    _expect_text(listed, NO_ACCOUNTS)


# --- Intercepted safety controls (synthetic; NOT packaged acceptance) ------------
#
# These drive the real ``packaged`` fixture admission and the real ``_cleanup``
# with every external boundary intercepted: subprocess.run (launchctl, ps,
# lipo, the binary), os.kill, the default HOME/data paths and the clock. No
# launchd job, real process, production label state or default directory is
# touched, the synthetic "binary" is never executed, and any signal in the
# admission controls aborts immediately.

_THIS = sys.modules[__name__]

posix_controls = pytest.mark.skipif(
    sys.platform == "win32", reason="intercepted controls model POSIX symlinks, UIDs and signals"
)

FRESHNESS_TARGETS = [
    pytest.param("plist", "agent file", id="agent-file"),
    pytest.param("data_dir", "default Bridge data directory", id="data-dir"),
    pytest.param("logs_dir", "default Bridge log directory", id="log-dir"),
]
FRESHNESS_EXISTS = "the {what} already exists on this runner; refusing to claim a non-fresh fixture"
FRESHNESS_UNINSPECTABLE = "the {what} could not be inspected on this runner; refusing to claim a non-fresh fixture"
ARCH_MISMATCH = "the packaged binary architecture does not match the declared packaging lane"
CHILD_UNCONFIRMED = "an owned packaged child was not confirmed stopped after cleanup"
SYNTHETIC_BINARY = b"#!/bin/sh\n# synthetic stand-in; the intercepted controls never execute it\nexit 97\n"
MAX_CLEANUP_SIGNALS = 3


class UnexpectedSignalError(BaseException):
    """Raised if an admission control would signal any process."""


class UnboundedWaitError(BaseException):
    """Raised if intercepted cleanup waits beyond a generous virtual bound."""


class _VirtualTime:
    LIMIT_SECONDS = 600.0

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(float(seconds), 0.001)
        if self.now > self.LIMIT_SECONDS:
            raise UnboundedWaitError("intercepted cleanup waited without a bound")


def _refuse_signal(pid, sig):
    raise UnexpectedSignalError("an intercepted admission control attempted to signal a process")


def _failure_text(exc):
    return getattr(exc, "msg", None) or str(exc)


def _packaged_fixture_function():
    """The undecorated ``packaged`` generator function across pytest fixture wrappers."""
    unwrap = getattr(packaged, "_get_wrapped_function", None)
    return unwrap() if unwrap is not None else packaged.__wrapped__


def _drive_admission():
    """Run the real fixture admission up to its yield: ("refused", message), ("admitted", None) or ("raised", type)."""
    generator = _packaged_fixture_function()()
    try:
        next(generator)
    except pytest.fail.Exception as exc:
        return "refused", _failure_text(exc)
    except Exception as exc:
        return "raised", type(exc).__name__
    generator.close()
    return "admitted", None


def _admission_world(tmp_path, monkeypatch):
    """A synthetic admitted hosted-Mac runner whose every external boundary is intercepted."""
    home = tmp_path / "home"
    home.mkdir()
    runner_temp = tmp_path / "runner-temp"
    runner_temp.mkdir()
    binary = tmp_path / "artifact" / "silentsuite-bridge"
    binary.parent.mkdir()
    binary.write_bytes(SYNTHETIC_BINARY)
    binary.chmod(0o755)
    world = SimpleNamespace(
        tmp_path=tmp_path,
        runner_temp=runner_temp,
        binary=binary,
        plist=home / "Library" / "LaunchAgents" / f"{SERVICE_LABEL}.plist",
        data_dir=home / "Library" / "Application Support" / "silentsuite-bridge",
        logs_dir=home / "Library" / "Logs" / "SilentSuiteBridge",
        launchctl=[],
        external=[],
        copies=[],
        chmods=[],
    )
    for name, value in (
        ("HOME", str(home)),
        ("GITHUB_ACTIONS", "true"),
        ("RUNNER_ENVIRONMENT", "github-hosted"),
        ("RUNNER_OS", "macOS"),
        ("RUNNER_TEMP", str(runner_temp)),
        (ARCH_ENV, "arm64"),
        (VERSION_ENV, ""),
        (BINARY_ENV, str(binary)),
    ):
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(_THIS, "sys", SimpleNamespace(platform="darwin"))
    monkeypatch.setattr(_THIS, "platform", SimpleNamespace(machine=lambda: "arm64"))
    monkeypatch.setattr(_THIS, "user_data_dir", lambda *args, **kwargs: str(world.data_dir))
    uid = os.getuid()

    def run(argv, *args, **kwargs):
        argv = [os.fsdecode(token) for token in argv]
        if argv[0] == "launchctl" and len(argv) > 1:
            world.launchctl.append(argv[1])
            answers = {
                "manageruid": (0, f"{uid}\n"),
                "managername": (0, "Aqua\n"),
                "print": (SERVICE_ABSENT_STATUS, ""),
                "list": (0, "PID\tStatus\tLabel\n"),
            }
            if argv[1] in answers:
                status, stdout = answers[argv[1]]
                return subprocess.CompletedProcess(argv, status, stdout=stdout, stderr="")
        # Never executed: lipo, ps, the synthetic binary or anything else.
        world.external.append(os.path.basename(argv[0]))
        return subprocess.CompletedProcess(argv, 97, stdout="", stderr="")

    real_copyfile = shutil.copyfile
    real_chmod = os.chmod

    def copyfile(src, dst, *args, **kwargs):
        world.copies.append(str(dst))
        return real_copyfile(src, dst, *args, **kwargs)

    def chmod(path, mode, *args, **kwargs):
        world.chmods.append(os.fspath(path))
        return real_chmod(path, mode, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(shutil, "copyfile", copyfile)
    monkeypatch.setattr(os, "chmod", chmod)
    monkeypatch.setattr(os, "kill", _refuse_signal)
    return world


def _assert_nothing_followed_refusal(world):
    assert world.external == [], "a binary, lipo or ps invocation followed a freshness refusal"
    assert world.copies == [], "owned binary copies were staged after a freshness refusal"
    assert world.chmods == [], "a permission change followed a freshness refusal"
    assert sorted(path.name for path in world.runner_temp.iterdir()) == [], "staging followed a freshness refusal"
    assert world.binary.read_bytes() == SYNTHETIC_BINARY


@posix_controls
@pytest.mark.parametrize(("attribute", "what"), FRESHNESS_TARGETS)
def test_packaged_admission_refuses_preexisting_dangling_symlink(tmp_path, monkeypatch, attribute, what):
    world = _admission_world(tmp_path, monkeypatch)
    target = getattr(world, attribute)
    target.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(tmp_path / "missing-symlink-target", target)

    outcome = _drive_admission()

    assert outcome == ("refused", FRESHNESS_EXISTS.format(what=what)), "a dangling symlink passed freshness"
    _assert_nothing_followed_refusal(world)
    assert os.path.islink(target) and not os.path.exists(target), "the preexisting entry was altered"
    assert not (tmp_path / "missing-symlink-target").exists()


@posix_controls
@pytest.mark.parametrize(("attribute", "what"), FRESHNESS_TARGETS)
def test_packaged_admission_refuses_uninspectable_freshness_path(tmp_path, monkeypatch, attribute, what):
    world = _admission_world(tmp_path, monkeypatch)
    target = os.fspath(getattr(world, attribute))

    def denied(path):
        return not isinstance(path, int) and os.fspath(path) == target

    def guard_path(original):
        def inspect(self, *args, **kwargs):
            if denied(self):
                raise PermissionError(13, "Permission denied")
            return original(self, *args, **kwargs)

        return inspect

    def guard_os(original):
        def inspect(path, *args, **kwargs):
            if denied(path):
                raise PermissionError(13, "Permission denied")
            return original(path, *args, **kwargs)

        return inspect

    monkeypatch.setattr(Path, "stat", guard_path(Path.stat))
    monkeypatch.setattr(Path, "lstat", guard_path(Path.lstat))
    monkeypatch.setattr(os, "stat", guard_os(os.stat))
    monkeypatch.setattr(os, "lstat", guard_os(os.lstat))

    outcome = _drive_admission()

    assert outcome == ("refused", FRESHNESS_UNINSPECTABLE.format(what=what)), (
        "an inspection error must be a fixed freshness refusal, not absence or a raw exception"
    )
    _assert_nothing_followed_refusal(world)


@posix_controls
@pytest.mark.parametrize(("attribute", "what"), FRESHNESS_TARGETS)
def test_packaged_admission_refuses_existing_ordinary_entry(tmp_path, monkeypatch, attribute, what):
    # Positive safety control: an ordinary existing entry is refused today and must stay refused.
    world = _admission_world(tmp_path, monkeypatch)
    target = getattr(world, attribute)
    target.parent.mkdir(parents=True, exist_ok=True)
    if attribute == "plist":
        target.write_bytes(b"preexisting agent file")
    else:
        target.mkdir()

    outcome = _drive_admission()

    assert outcome == ("refused", FRESHNESS_EXISTS.format(what=what))
    _assert_nothing_followed_refusal(world)


@posix_controls
def test_packaged_admission_reaches_staging_only_after_positive_freshness(tmp_path, monkeypatch):
    # Interception control: with every freshness path positively absent the real
    # fixture proceeds to owned staging and stops at the intercepted lipo check,
    # without executing the synthetic binary or signalling anything.
    world = _admission_world(tmp_path, monkeypatch)

    outcome = _drive_admission()

    assert outcome == ("refused", ARCH_MISMATCH)
    assert len(world.copies) == 3
    assert world.external == ["lipo"]
    assert set(world.launchctl) <= {"manageruid", "managername", "print", "list"}
    assert world.binary.read_bytes() == SYNTHETIC_BINARY


class _CleanupBoundary:
    """Intercepted launchctl/ps/os.kill for one recorded owned child; no real process exists.

    ``child`` is ``"exited"`` (gone before cleanup), ``"exits-on-kill"``,
    ``"survives-kill"``; ``identity`` is ``"matched"``, ``"foreign"`` (a live
    process at another executable path) or ``"unknown"`` (ps times out). The
    service is always positively absent.
    """

    def __init__(self, pid, path, child, identity):
        self.pid = pid
        self.path = path
        self.child = child
        self.identity = identity
        self.killed = False
        self.probes = 0
        self.signals = []
        self.foreign = []
        self.calls = []
        self.unexpected = []

    def alive(self):
        if self.child == "exited":
            return False
        if self.child == "exits-on-kill":
            return not self.killed
        return True

    def kill(self, pid, sig):
        if pid != self.pid:
            self.foreign.append(sig)
            raise ProcessLookupError(3, "No such process")
        if sig == 0:
            self.probes += 1
            if self.alive():
                return None
            raise ProcessLookupError(3, "No such process")
        self.signals.append(sig)
        self.killed = True
        return None

    def run(self, argv, *args, **kwargs):
        argv = [os.fsdecode(token) for token in argv]
        self.calls.append(argv)
        if argv[:2] == ["launchctl", "print"]:
            return subprocess.CompletedProcess(argv, SERVICE_ABSENT_STATUS, stdout="", stderr="")
        if argv[0] == "ps":
            if self.identity == "unknown":
                raise subprocess.TimeoutExpired(argv, kwargs.get("timeout") or 10)
            if not self.alive():
                return subprocess.CompletedProcess(argv, 1, stdout="", stderr="")
            command = "/Applications/Unrelated/agent" if self.identity == "foreign" else str(self.path)
            return subprocess.CompletedProcess(argv, 0, stdout=f"    1 {command}\n", stderr="")
        self.unexpected.append(os.path.basename(argv[0]))
        return subprocess.CompletedProcess(argv, 97, stdout="", stderr="")


def _drive_cleanup(tmp_path, monkeypatch, *, child, identity, owned=True):
    path = tmp_path / "b" / "silentsuite-bridge"
    pid = 987654
    boundary = _CleanupBoundary(pid, path, child, identity)
    clock = _VirtualTime()
    monkeypatch.setattr(subprocess, "run", boundary.run)
    monkeypatch.setattr(os, "kill", boundary.kill)
    monkeypatch.setattr(_THIS, "time", clock)
    state = SimpleNamespace(
        owned=owned,
        service=f"gui/{os.getuid()}/{SERVICE_LABEL}",
        verified_children=[(pid, path)],
    )
    try:
        _cleanup(state)
    except pytest.fail.Exception as exc:
        return ("refused", _failure_text(exc)), boundary
    except Exception as exc:
        return ("raised", type(exc).__name__), boundary
    return ("ok", None), boundary


@posix_controls
def test_packaged_cleanup_fails_when_live_owned_child_identity_is_unknown(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="survives-kill", identity="unknown")

    assert outcome == ("refused", CHILD_UNCONFIRMED), (
        "cleanup succeeded while a recorded child was live and unverified"
    )
    assert boundary.signals == [], "an unverified pid was signalled"
    assert boundary.foreign == []
    assert boundary.unexpected == []


@posix_controls
def test_packaged_cleanup_never_signals_a_live_pid_with_a_different_identity(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="survives-kill", identity="foreign")

    assert outcome == ("refused", CHILD_UNCONFIRMED), (
        "cleanup succeeded while a recorded pid was live as another program"
    )
    assert boundary.signals == [], "a pid whose identity no longer matched was signalled"
    assert boundary.foreign == []
    assert boundary.unexpected == []


@posix_controls
def test_packaged_cleanup_fails_when_verified_child_survives_the_kill(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="survives-kill", identity="matched")

    assert outcome == ("refused", CHILD_UNCONFIRMED), "cleanup succeeded without confirming the child exited"
    assert boundary.signals, "a verified owned child was never signalled"
    assert set(boundary.signals) <= {signal.SIGTERM, signal.SIGKILL}
    assert len(boundary.signals) <= MAX_CLEANUP_SIGNALS
    assert boundary.foreign == []
    assert boundary.unexpected == []


@posix_controls
def test_packaged_cleanup_succeeds_when_verified_child_exits_after_signal(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="exits-on-kill", identity="matched")

    assert outcome == ("ok", None)
    assert boundary.signals and set(boundary.signals) <= {signal.SIGTERM, signal.SIGKILL}
    assert len(boundary.signals) <= MAX_CLEANUP_SIGNALS
    assert boundary.foreign == []


@posix_controls
def test_packaged_cleanup_succeeds_without_signal_when_child_already_exited(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="exited", identity="matched")

    assert outcome == ("ok", None)
    assert boundary.signals == []
    assert boundary.foreign == []


@posix_controls
def test_packaged_cleanup_is_a_no_op_for_unowned_state(tmp_path, monkeypatch):
    outcome, boundary = _drive_cleanup(tmp_path, monkeypatch, child="survives-kill", identity="matched", owned=False)

    assert outcome == ("ok", None)
    assert boundary.calls == []
    assert boundary.probes == 0
    assert boundary.signals == []
