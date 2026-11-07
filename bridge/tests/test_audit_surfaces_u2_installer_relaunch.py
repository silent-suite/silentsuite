"""SURFACES-U-2 (partial): installer relaunch after autostart already started Bridge.

Runs the real ``bridge/install.sh`` through the existing
``tests/test_unix_installer.installer_path()`` harness: fake curl serving a
fixture body with its exact sha256, symlinked coreutils and a fake uname.

Declared fixture boundaries (why this is PARTIAL):
- The installed "binary" is a shell wrapper that runs the real SOURCE daemon
  (``python -m silentsuite_bridge``). There is no packaged-runtime claim.
- ``--login`` (browser/provider authentication) is replaced by the wrapper and
  returns ``LOGIN_EXIT``. No provider traffic, no accounts.
- ``systemctl`` is a controlled user service-manager fixture. On ``start`` it
  parses ExecStart from the real unit written by the real
  ``--install-autostart`` code. It spawns that command in a new session with a
  manager-only environment that has no SILENTSUITE_* exports, so the service
  daemon must read the persisted settings.json. It then waits (bounded) for the
  loopback listener, standing in for the time a person spends logging in. No
  real systemd is used.
- ``loginctl`` reports ``Linger=yes``, keeping BRIDGEX-05 out of this case.
- ``BROWSER`` is a recorder script. The ``etebase`` SDK in the daemons is
  whatever is installed; with no accounts, no SDK calls are made.

Custody: cleanup is registered before any spawn. Ownership does not depend on
wrapper or manager receipts, which can lag a spawn.
- Every fixture process inherits a unique per-run ``AUDIT_RUN_TOKEN`` at fork
  and exec, before it runs any code. The manager passes it explicitly.
- Custody discovers owned processes by scanning ``/proc/*/environ`` for that
  exact token. Before any signal, it re-verifies the token and the start time.
  A verified process-group leader has its group signalled.
- Subreaper: custody reads this process's exact prior child-subreaper flag. It
  sets the flag only if it was clear, and restores that exact prior value at
  teardown. If the flag cannot be read, set or verified, custody fails BEFORE
  any fixture spawn (a fixture failure, not product evidence).
- Reaping: an adopted zombie is reaped only if its (pid, start time) pair was
  previously observed live carrying this run's token. A zombie keeps its PID
  and start time until it is reaped, so the match proves ownership. Zombies
  that cannot be attributed this way, and pre-existing children, are never
  waited on, reaped or claimed; they are only reported.

Teardown terminates (SIGTERM, then SIGKILL) with bounded rescans, reaps the
installer and proven-owned adopted zombies, and fails loudly if any
token-bearing process survives, a proven-owned zombie stays unreaped, or the
listener is still open. Nothing is killed by name or by an unverified PID.
Receipts are used only to attribute invocations and exit codes.

Bind evidence: the listening socket's inode in /proc/net/tcp is matched to the
owned daemon's /proc/<pid>/fd. Daemon invocations are counted separately from
serving daemons.

Linux-only platform selection; the platform is recorded in every test id.
"""

import ctypes
import hashlib
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

from tests.test_unix_installer import INSTALLER, installer_path

pytestmark = pytest.mark.skipif(
    sys.platform != "linux",
    reason="Linux-only platform selection (install.sh + /proc listener evidence); receipt in test ids",
)

BRIDGE_SRC = Path(__file__).resolve().parents[1] / "src"
RECEIPT = f"SURFACES-U-2-{sys.platform}-py{sys.version_info[0]}.{sys.version_info[1]}"
platform_receipt = pytest.mark.parametrize("receipt", [RECEIPT], ids=[RECEIPT])

ASSET = "silentsuite-bridge-linux-x86_64"
INSTALLER_TIMEOUT = 120
RESOLVE_TIMEOUT = 30
TERM_GRACE = 10
LISTENER_CLOSE_TIMEOUT = 10
LOG_TAIL = 1500

# Fixture stand-in for the downloaded binary. It contains no per-run values, so
# its sha256 is constant. It runs the real source CLI/daemon.
WRAPPER_BODY = """#!/bin/sh
state="${AUDIT_STATE:?}"
case " $* " in
    *" --login "*)
        echo "login $$" >> "$state/invocations.log"
        exit "${LOGIN_EXIT:-0}"
        ;;
    *" --install-autostart "*)
        echo "install-autostart $$" >> "$state/invocations.log"
        exec "${PY:?}" -m silentsuite_bridge "$@"
        ;;
    *" --version "*|*" --help "*)
        exec "${PY:?}" -m silentsuite_bridge "$@"
        ;;
esac
origin="${AUDIT_ORIGIN:-installer}"
log="$state/daemon-$$.log"
echo "daemon $$ $origin" >> "$state/invocations.log"
exec </dev/null >>"$log" 2>&1
"${PY:?}" -m silentsuite_bridge "$@" &
child=$!
echo "child $$ $child $origin" >> "$state/invocations.log"
wait "$child"
rc=$?
echo "exit $$ $child $rc $origin" >> "$state/invocations.log"
exit "$rc"
"""
WRAPPER_HASH = hashlib.sha256(WRAPPER_BODY.encode()).hexdigest()

MANAGER_KEYS = (
    "HOME", "PATH", "PYTHONPATH", "PY", "AUDIT_STATE", "AUDIT_RUN_TOKEN", "BROWSER",
    "LANG", "LC_ALL", "PYTHONDONTWRITEBYTECODE", "TMPDIR", "XDG_CONFIG_HOME", "USER",
    "VIRTUAL_ENV", "PYTHONHOME",
)

FAKE_SYSTEMCTL = """#!@PYTHON@ -I
# Controlled user service-manager fixture (not systemd).
import os, shlex, socket, subprocess, sys, time
state = os.environ["AUDIT_STATE"]
argv = sys.argv[1:]
args = argv[1:] if argv[:1] == ["--user"] else argv
verb = args[0] if args else ""
rc = 0
if verb == "start":
    if os.environ.get("AUDIT_SYSTEMCTL_START_FAIL") == "1":
        rc = 1
    else:
        unit = os.path.join(os.environ["HOME"], ".config", "systemd", "user", args[1])
        exec_line = None
        with open(unit, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("ExecStart="):
                    exec_line = line[len("ExecStart="):].rstrip("\\n")
        command = shlex.split(exec_line)
        env = {key: os.environ[key] for key in @MANAGER_KEYS@ if key in os.environ}
        env["AUDIT_ORIGIN"] = "service"
        with open(os.path.join(state, "service-manager.log"), "a") as log:
            proc = subprocess.Popen(
                command, env=env, stdin=subprocess.DEVNULL, stdout=log,
                stderr=subprocess.STDOUT, start_new_session=True, close_fds=True,
            )
        with open(os.path.join(state, "invocations.log"), "a") as inv:
            inv.write(f"manager-spawn {proc.pid} service\\n")
        port = int(os.environ["AUDIT_EXPECT_PORT"])
        deadline = time.monotonic() + @READY@
        rc = 3
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                break
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    rc = 0
                    break
            except OSError:
                time.sleep(0.25)
with open(os.path.join(state, "systemctl-calls.log"), "a") as calls:
    calls.write(" ".join(argv) + f" rc={rc}\\n")
sys.exit(rc)
"""


# --- /proc helpers ---------------------------------------------------------


_PR_SET_CHILD_SUBREAPER = 36
_PR_GET_CHILD_SUBREAPER = 37


def _stat(pid):
    """Return (state, ppid, starttime) from /proc/<pid>/stat, or None when gone."""
    try:
        data = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    fields = data.rsplit(")", 1)[1].split()
    if len(fields) < 20:
        return None
    return fields[0], int(fields[1]), fields[19]


def _starttime(pid):
    """Return /proc start time, or None when gone or a zombie."""
    stat = _stat(pid)
    if stat is None or stat[0] == "Z":
        return None
    return stat[2]


def _environ(pid):
    try:
        return Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    except OSError:
        return []


def _has_token(pid, token):
    return f"AUDIT_RUN_TOKEN={token}".encode() in _environ(pid)


def _origin(pid):
    # Service daemons inherit AUDIT_ORIGIN=service from the manager fixture env;
    # installer-launched processes never carry it.
    for entry in _environ(pid):
        if entry.startswith(b"AUDIT_ORIGIN="):
            return entry.split(b"=", 1)[1].decode(errors="replace")
    return "installer"


def _proc_pids():
    return [int(entry) for entry in os.listdir("/proc") if entry.isdigit()]


def _children_of(parent):
    children = {}
    for pid in _proc_pids():
        stat = _stat(pid)
        if stat is not None and stat[1] == parent:
            children[pid] = stat[0]
    return children


class CustodySetupError(RuntimeError):
    """Required custody could not be established; nothing has been spawned."""


def _libc():
    try:
        return ctypes.CDLL(None, use_errno=True)
    except OSError as exc:
        raise CustodySetupError(f"libc unavailable: {exc!r}") from exc


def _get_subreaper():
    value = ctypes.c_int(-1)
    if _libc().prctl(_PR_GET_CHILD_SUBREAPER, ctypes.byref(value), 0, 0, 0) != 0:
        raise CustodySetupError(f"PR_GET_CHILD_SUBREAPER failed: errno={ctypes.get_errno()}")
    return value.value


def _set_subreaper(value):
    if _libc().prctl(_PR_SET_CHILD_SUBREAPER, int(value), 0, 0, 0) != 0:
        raise CustodySetupError(f"PR_SET_CHILD_SUBREAPER({value}) failed: errno={ctypes.get_errno()}")
    current = _get_subreaper()
    if bool(current) != bool(value):
        raise CustodySetupError(f"subreaper flag is {current}, expected {value}")


def _listen_inodes(port):
    inodes = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            lines = Path(table).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            if parts[3] == "0A" and int(parts[1].rsplit(":", 1)[1], 16) == port:
                inodes.add(parts[9])
    return inodes


def _socket_owner_pids(pids, inodes):
    owners = set()
    for pid in pids:
        try:
            fds = os.listdir(f"/proc/{pid}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                target = os.readlink(f"/proc/{pid}/fd/{fd}")
            except OSError:
                continue
            if target.startswith("socket:[") and target[8:-1] in inodes:
                owners.add(pid)
    return owners


def _port_accepts(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


# --- custody ---------------------------------------------------------------


class Custody:
    """Owned-process supervision; opened (start()) before any spawn.

    Ownership = exact per-run token in /proc/<pid>/environ, inherited at
    fork/exec, so no spawn-to-receipt gap exists. Reaping covers orphans via
    the child-subreaper attribute held for the custody window.
    """

    def __init__(self, token, state_dir, port):
        self.token = token
        self.state_dir = state_dir
        self.port = port
        self.popens = []
        self.seen = set()  # (pid, starttime) of every token-bearing process observed live
        self.pre_children = set()
        self.prior_subreaper = None
        self.set_by_custody = False
        self.changed_subreaper = False
        self.restore_error = None
        self.reaped = []
        self.report = {}

    def start(self):
        """Establish required custody before any spawn; raise CustodySetupError otherwise."""
        prior = _get_subreaper()
        self.prior_subreaper = prior
        self.pre_children = set(_children_of(os.getpid()))
        if not prior:
            try:
                _set_subreaper(1)
            except CustodySetupError:
                try:
                    _set_subreaper(prior)  # leave the caller's flag exactly as it was
                except CustodySetupError:
                    pass
                raise
            self.set_by_custody = True
            self.changed_subreaper = True

    def _restore_subreaper(self):
        if not self.changed_subreaper:
            return
        try:
            _set_subreaper(self.prior_subreaper)
            if _get_subreaper() != self.prior_subreaper:
                raise CustodySetupError("subreaper flag not restored to its exact prior value")
            self.changed_subreaper = False
        except CustodySetupError as exc:
            self.restore_error = repr(exc)

    def adopt_popen(self, popen, origin):
        self.popens.append(popen)
        self.scan()

    def scan(self):
        """Live (non-zombie) token-bearing processes: pid -> starttime."""
        me = os.getpid()
        live = {}
        for pid in _proc_pids():
            if pid == me:
                continue
            starttime = _starttime(pid)
            if starttime is None or not _has_token(pid, self.token):
                continue
            live[pid] = starttime
            self.seen.add((pid, starttime))
        return live

    def invocation_lines(self):
        path = self.state_dir / "invocations.log"
        if not path.exists():
            return []
        return [line.split() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def serving(self):
        """Origins of owned processes holding the LISTEN socket, plus unowned inodes."""
        inodes = _listen_inodes(self.port)
        live = list(self.scan())
        owners = _socket_owner_pids(live, inodes)
        owned_inodes = set()
        for pid in owners:
            try:
                fds = os.listdir(f"/proc/{pid}/fd")
            except OSError:
                continue
            for fd in fds:
                try:
                    target = os.readlink(f"/proc/{pid}/fd/{fd}")
                except OSError:
                    continue
                if target.startswith("socket:["):
                    owned_inodes.add(target[8:-1])
        return {
            "owners": sorted((_origin(pid), pid) for pid in owners),
            "unowned_listen_inodes": sorted(inodes - owned_inodes),
        }

    def _signal_verified(self, pid, starttime, sig):
        """Signal one owned process (its group too if it leads one), re-verified just before."""
        if _starttime(pid) != starttime or not _has_token(pid, self.token):
            return False
        try:
            if os.getpgid(pid) == pid:
                os.killpg(pid, sig)  # verified owned group leader
            else:
                os.kill(pid, sig)
        except ProcessLookupError:
            return False
        return True

    def _adopted_zombies(self):
        """Split zombie children (excluding Popen-managed and pre-existing) into proven-owned/unattributed."""
        popen_pids = {popen.pid for popen in self.popens}
        owned, unattributed = [], []
        for pid in _children_of(os.getpid()):
            if pid in self.pre_children or pid in popen_pids:
                continue
            stat = _stat(pid)
            if stat is None or stat[0] != "Z":
                continue
            # An unreaped zombie keeps its PID and start time, so a match with a
            # live token-bearing observation proves fixture ownership.
            if (pid, stat[2]) in self.seen:
                owned.append(pid)
            else:
                unattributed.append(pid)
        return owned, unattributed

    def _reap_adopted(self):
        """Reap only proven-owned adopted zombies; never touch unattributed or pre-existing children."""
        owned, _unattributed = self._adopted_zombies()
        for pid in owned:
            try:
                if os.waitpid(pid, os.WNOHANG)[0] == pid:
                    self.reaped.append(pid)
            except ChildProcessError:
                pass

    def _terminate(self, sig, grace):
        """Signal every live owned process, rescanning until none remain or the bound expires."""
        signalled = set()
        deadline = time.monotonic() + grace
        while True:
            live = self.scan()
            self._reap_adopted()
            if not live or time.monotonic() >= deadline:
                return sorted(signalled)
            for pid, starttime in live.items():
                if self._signal_verified(pid, starttime, sig):
                    signalled.add(pid)
            for popen in self.popens:
                popen.poll()
            time.sleep(0.2)

    def teardown(self):
        """Terminate, escalate, reap and verify on every exit path."""
        try:
            terminated = self._terminate(signal.SIGTERM, TERM_GRACE)
            escalated = self._terminate(signal.SIGKILL, TERM_GRACE)
            unreaped_popens = []
            for popen in self.popens:
                if popen.poll() is None:
                    popen.kill()
                try:
                    popen.wait(timeout=TERM_GRACE)
                except subprocess.TimeoutExpired:
                    unreaped_popens.append(popen.pid)
            deadline = time.monotonic() + TERM_GRACE
            while True:
                self._reap_adopted()
                owned_zombies, unattributed_zombies = self._adopted_zombies()
                if not owned_zombies or time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
        finally:
            self._restore_subreaper()
        deadline = time.monotonic() + LISTENER_CLOSE_TIMEOUT
        while time.monotonic() < deadline and (_listen_inodes(self.port) or _port_accepts(self.port)):
            time.sleep(0.2)
        survivors = sorted(self.scan())
        listener_open = bool(_listen_inodes(self.port)) or _port_accepts(self.port)
        self.report = {
            "prior_subreaper": self.prior_subreaper,
            "subreaper_set_by_custody": self.set_by_custody,
            "subreaper_restored": not self.changed_subreaper and self.restore_error is None,
            "restore_error": self.restore_error,
            "owned_seen": sorted(pid for pid, _ in self.seen),
            "terminated": terminated,
            "escalated": escalated,
            "reaped_owned_adopted": sorted(self.reaped),
            "unreaped_owned_zombies": owned_zombies,
            "unattributed_zombies_not_touched": unattributed_zombies,
            "unreaped_popens": unreaped_popens,
            "survivors": survivors,
            "listener_open": listener_open,
        }
        if (
            survivors or listener_open or owned_zombies or unreaped_popens
            or self.changed_subreaper or self.restore_error
        ):
            raise AssertionError(f"{RECEIPT} teardown failed: {self.report!r}")


# --- scenario --------------------------------------------------------------


def _executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _tail(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-LOG_TAIL:]
    except OSError:
        return ""


def _drive(base: Path, custody: Custody, *, login_exit: int, start_fail: bool) -> dict:
    if " " in sys.executable or len(sys.executable) > 100:
        pytest.fail(f"{RECEIPT} fixture limitation: interpreter path unusable in shebang: {sys.executable!r}")
    home = base / "home"
    home.mkdir()
    install_dir = base / "install"
    state = custody.state_dir
    fake_bin = installer_path(base, verifier="sha256sum")
    _executable(
        fake_bin / "systemctl",
        FAKE_SYSTEMCTL.replace("@PYTHON@", sys.executable)
        .replace("@MANAGER_KEYS@", repr(MANAGER_KEYS))
        .replace("@READY@", str(RESOLVE_TIMEOUT)),
    )
    _executable(fake_bin / "loginctl", '#!/bin/sh\necho "Linger=yes"\nexit 0\n')
    browser = fake_bin / "fake-browser"
    _executable(browser, '#!/bin/sh\necho "browser $*" >> "${AUDIT_STATE:?}/browser.log"\nexit 0\n')

    port = custody.port
    env = {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "TMPDIR": str(base),
        "PATH": str(fake_bin),
        "PYTHONPATH": str(BRIDGE_SRC),
        "PYTHONDONTWRITEBYTECODE": "1",
        "USER": "audit-ci-user",
        "PY": sys.executable,
        "BROWSER": str(browser),
        "SILENTSUITE_INSTALL_DIR": str(install_dir),
        "SILENTSUITE_LISTEN_ADDRESS": "127.0.0.1",
        "SILENTSUITE_LISTEN_PORT": str(port),
        "BINARY_BODY": WRAPPER_BODY,
        "CHECKSUM_CASE": "valid",
        "CHECKSUM_BODY": f"{WRAPPER_HASH}  {ASSET}\n",
        "AUDIT_STATE": str(state),
        "AUDIT_RUN_TOKEN": custody.token,
        "AUDIT_EXPECT_PORT": str(port),
        "LOGIN_EXIT": str(login_exit),
    }
    if start_fail:
        env["AUDIT_SYSTEMCTL_START_FAIL"] = "1"
    for passthrough in ("PYTHONHOME", "VIRTUAL_ENV", "LANG", "LC_ALL"):
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]

    stdout_path = base / "installer.stdout"
    stderr_path = base / "installer.stderr"
    with open(stdout_path, "w") as out, open(stderr_path, "w") as err:
        installer = subprocess.Popen(
            ["/bin/sh", str(INSTALLER)],
            cwd=str(base),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=True,
        )
        custody.adopt_popen(installer, "installer-sh")
        # Bounded wait that keeps observing owned processes while they are live,
        # so later zombies can be attributed by (pid, start time).
        installer_deadline = time.monotonic() + INSTALLER_TIMEOUT
        while installer.poll() is None:
            if time.monotonic() >= installer_deadline:
                raise subprocess.TimeoutExpired(installer.args, INSTALLER_TIMEOUT)
            custody.scan()
            time.sleep(0.1)
        rc = installer.returncode

    # Resolve every installer-launched daemon: exit receipt or owned listener (bounded).
    deadline = time.monotonic() + RESOLVE_TIMEOUT
    while True:
        lines = custody.invocation_lines()
        launched = [p for p in lines if p[0] == "daemon" and p[2] == "installer"]
        exited = {p[1] for p in lines if p[0] == "exit" and p[4] == "installer"}
        serving_now = custody.serving()["owners"]
        serving_installer = {origin for origin, _ in serving_now if origin == "installer"}
        unresolved = [p for p in launched if p[1] not in exited] if not serving_installer else []
        if not unresolved or time.monotonic() >= deadline:
            break
        time.sleep(0.25)

    lines = custody.invocation_lines()
    serving = custody.serving()
    unit_files = sorted((home / ".config" / "systemd" / "user").glob("*.service"))
    exec_argv = None
    if len(unit_files) == 1:
        for line in unit_files[0].read_text(encoding="utf-8").splitlines():
            if line.startswith("ExecStart="):
                raw = line[len("ExecStart="):]
                exec_argv = None if ("%" in raw or "$" in raw) else shlex.split(raw)
    settings_files = sorted(home.rglob("settings.json"))
    profile = None
    if len(settings_files) == 1:
        profile = json.loads(settings_files[0].read_text(encoding="utf-8")).get("network")
    receipts = [
        {"wrapper": int(p[1]), "child": int(p[2]), "rc": int(p[3]), "origin": p[4]}
        for p in lines if p[0] == "exit"
    ]
    daemon_logs = {
        p[1]: _tail(state / f"daemon-{p[1]}.log") for p in lines if p[0] == "daemon"
    }
    return {
        "port": port,
        "rc": rc,
        "stdout": stdout_path.read_text(encoding="utf-8", errors="replace"),
        "stderr": stderr_path.read_text(encoding="utf-8", errors="replace")[-LOG_TAIL:],
        "installed": str(install_dir / "silentsuite-bridge"),
        "invocations": [" ".join(p) for p in lines],
        "install_autostart_invocations": sum(1 for p in lines if p[0] == "install-autostart"),
        "login_invocations": sum(1 for p in lines if p[0] == "login"),
        "daemon_invocations": sum(1 for p in lines if p[0] == "daemon"),
        "unresolved_installer_daemons": unresolved,
        "serving_owners": serving["owners"],
        "serving_origins": sorted(origin for origin, _ in serving["owners"]),
        "unowned_listen_inodes": serving["unowned_listen_inodes"],
        "receipts": receipts,
        "daemon_logs": daemon_logs,
        "service_manager_log": _tail(state / "service-manager.log"),
        "systemctl_calls": _tail(state / "systemctl-calls.log"),
        "exec_argv": exec_argv,
        "settings_files": [str(path) for path in settings_files],
        "profile": profile,
    }


def _scenario(base: Path, *, login_exit: int, start_fail: bool) -> dict:
    state = base / "state"
    state.mkdir()
    custody = Custody(uuid.uuid4().hex, state, _free_port())  # registered before any spawn
    try:
        custody.start()  # exact prior flag read; subreaper + snapshot established, before any spawn
    except CustodySetupError as exc:
        pytest.fail(f"{RECEIPT} fixture custody setup failed before any spawn: {exc}")
    try:
        observed = _drive(base, custody, login_exit=login_exit, start_fail=start_fail)
    finally:
        custody.teardown()
    observed["teardown"] = custody.report
    return observed


@pytest.fixture(scope="module")
def main_scenario(tmp_path_factory):
    return _scenario(tmp_path_factory.mktemp("su2-main"), login_exit=0, start_fail=False)


@pytest.fixture(scope="module")
def login_skipped_scenario(tmp_path_factory):
    return _scenario(tmp_path_factory.mktemp("su2-login-skipped"), login_exit=1, start_fail=False)


@pytest.fixture(scope="module")
def single_daemon_scenario(tmp_path_factory):
    return _scenario(tmp_path_factory.mktemp("su2-single-daemon"), login_exit=0, start_fail=True)


def _evidence(obs: dict) -> str:
    keys = (
        "rc", "invocations", "serving_owners", "unowned_listen_inodes", "receipts",
        "daemon_logs", "service_manager_log", "systemctl_calls", "exec_argv", "profile",
        "teardown", "stderr",
    )
    return json.dumps({key: obs[key] for key in keys}, indent=1, default=str) + "\nstdout:\n" + obs["stdout"][-LOG_TAIL:]


def _require(obs: dict, *, autostart_confirmed: bool) -> None:
    problems = []
    if obs["rc"] != 0:
        problems.append("installer rc != 0")
    marker = "Auto-start configured" if autostart_confirmed else "Auto-start was not confirmed"
    if marker not in obs["stdout"]:
        problems.append(f"missing {marker!r}")
    if obs["exec_argv"] != [obs["installed"]]:
        problems.append(f"ExecStart is not the installed wrapper: {obs['exec_argv']!r}")
    expected_profile = {"listenAddress": "127.0.0.1", "listenPort": obs["port"]}
    if obs["profile"] != expected_profile or len(obs["settings_files"]) != 1:
        problems.append(f"persisted profile {obs['profile']!r} != {expected_profile!r}")
    if (obs["install_autostart_invocations"], obs["login_invocations"]) != (1, 1):
        problems.append("expected one --install-autostart and one --login invocation")
    if obs["unowned_listen_inodes"]:
        problems.append("listener held by an unowned process")
    if obs["unresolved_installer_daemons"]:
        problems.append("installer-launched daemon neither exited nor served within bound")
    if problems:
        pytest.fail(f"{RECEIPT} fixture precondition failed: {problems!r}\n{_evidence(obs)}")


@platform_receipt
def test_SURFACES_U_2_preconditions(main_scenario, receipt):
    _require(main_scenario, autostart_confirmed=True)
    assert "service" in main_scenario["serving_origins"], (
        f"{receipt} fixture precondition: service daemon not serving\n{_evidence(main_scenario)}"
    )


@platform_receipt
def test_SURFACES_U_2_single_daemon_invocation_after_autostart(main_scenario, receipt):
    _require(main_scenario, autostart_confirmed=True)
    assert main_scenario["daemon_invocations"] == 1, (
        f"{receipt}: daemon_invocations={main_scenario['daemon_invocations']} "
        f"serving_origins={main_scenario['serving_origins']}\n{_evidence(main_scenario)}"
    )


@platform_receipt
def test_SURFACES_U_2_running_claim_matches_child(main_scenario, receipt):
    _require(main_scenario, autostart_confirmed=True)
    claim = "Bridge is running!" in main_scenario["stdout"]
    failed_children = [
        receipt_row for receipt_row in main_scenario["receipts"]
        if receipt_row["origin"] == "installer" and receipt_row["rc"] != 0
    ]
    # Attribution evidence (in message): exit receipt rc and the child's own log
    # tail, the listener owner at that time (service daemon) and the
    # single-daemon control, where the same command and profile bind.
    assert not (claim and failed_children), (
        f"{receipt}: installer claimed running while its launched daemon exited: "
        f"{failed_children!r} serving_owners={main_scenario['serving_owners']}\n{_evidence(main_scenario)}"
    )


@platform_receipt
def test_SURFACES_U_2_control_login_skipped(login_skipped_scenario, receipt):
    obs = login_skipped_scenario
    _require(obs, autostart_confirmed=True)
    observed = {
        "daemon_invocations": obs["daemon_invocations"],
        "serving_origins": obs["serving_origins"],
        "login_incomplete_message": "Login did not complete" in obs["stdout"],
        "running_claim": "Bridge is running!" in obs["stdout"],
    }
    assert observed == {
        "daemon_invocations": 1,
        "serving_origins": ["service"],
        "login_incomplete_message": True,
        "running_claim": False,
    }, f"{receipt}: {observed!r}\n{_evidence(obs)}"


@platform_receipt
def test_SURFACES_U_2_control_single_installer_daemon(single_daemon_scenario, receipt):
    obs = single_daemon_scenario
    _require(obs, autostart_confirmed=False)
    observed = {
        "daemon_invocations": obs["daemon_invocations"],
        "serving_origins": obs["serving_origins"],
        "installer_exit_receipts": [r for r in obs["receipts"] if r["origin"] == "installer"],
        "running_claim": "Bridge is running!" in obs["stdout"],
    }
    assert observed == {
        "daemon_invocations": 1,
        "serving_origins": ["installer"],
        "installer_exit_receipts": [],
        "running_claim": True,
    }, f"{receipt}: {observed!r}\n{_evidence(obs)}"
