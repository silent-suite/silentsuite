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

Custody: cleanup is registered before any spawn. Every owned process is
recorded and verified by run token and start time before any signal; nothing
is killed by name or by an unverified PID. Waits are bounded. Owned processes
are terminated (with escalation), the installer child is reaped, and the
listener must be closed at teardown, on every exit path.

Bind evidence: the listening socket's inode in /proc/net/tcp is matched to the
owned daemon's /proc/<pid>/fd. Daemon invocations are counted separately from
serving daemons.

Linux-only platform selection; the platform is recorded in every test id.
"""

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


def _starttime(pid):
    """Return /proc start time, or None when gone or a zombie."""
    try:
        data = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    fields = data.rsplit(")", 1)[1].split()
    if not fields or fields[0] == "Z":
        return None
    return fields[19]


def _has_token(pid, token):
    try:
        environ = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return False
    return f"AUDIT_RUN_TOKEN={token}".encode() in environ.split(b"\0")


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
    """Owned-process registry; created before any spawn."""

    def __init__(self, token, state_dir, port):
        self.token = token
        self.state_dir = state_dir
        self.port = port
        self.records = {}  # pid -> {"origin", "kind", "starttime"}
        self.popens = []
        self.report = {}

    def adopt_popen(self, popen, origin):
        self.popens.append(popen)
        self._register(popen.pid, origin, "popen")

    def _register(self, pid, origin, kind):
        if pid in self.records:
            return
        starttime = _starttime(pid)
        if starttime is not None and _has_token(pid, self.token):
            self.records[pid] = {"origin": origin, "kind": kind, "starttime": starttime}

    def invocation_lines(self):
        path = self.state_dir / "invocations.log"
        if not path.exists():
            return []
        return [line.split() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def sync(self):
        for parts in self.invocation_lines():
            if parts[0] == "daemon" and len(parts) == 3:
                self._register(int(parts[1]), parts[2], "wrapper")
            elif parts[0] == "child" and len(parts) == 4:
                self._register(int(parts[2]), parts[3], "daemon")
            elif parts[0] == "manager-spawn" and len(parts) == 3:
                self._register(int(parts[1]), parts[2], "wrapper")

    def verified_alive(self, pid):
        record = self.records.get(pid)
        return (
            record is not None
            and _starttime(pid) == record["starttime"]
            and _has_token(pid, self.token)
        )

    def daemon_pids(self, origin=None):
        return [
            pid for pid, record in self.records.items()
            if record["kind"] == "daemon" and (origin is None or record["origin"] == origin)
        ]

    def serving(self):
        """Origins of owned daemons holding the LISTEN socket, plus unowned inodes."""
        inodes = _listen_inodes(self.port)
        live = [pid for pid in self.daemon_pids() if self.verified_alive(pid)]
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
            "owners": sorted((self.records[pid]["origin"], pid) for pid in owners),
            "unowned_listen_inodes": sorted(inodes - owned_inodes),
        }

    def _signal(self, pid, sig):
        # Only verified owned PIDs are signalled; a race with a natural exit is tolerated.
        if self.verified_alive(pid):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass

    def teardown(self):
        """Terminate, escalate, reap and verify on every exit path."""
        self.sync()
        for popen in self.popens:
            if popen.poll() is None and self.verified_alive(popen.pid):
                try:
                    if os.getpgid(popen.pid) == popen.pid:
                        os.killpg(popen.pid, signal.SIGTERM)
                    else:
                        popen.terminate()
                except ProcessLookupError:
                    pass
        for pid in list(self.records):
            self._signal(pid, signal.SIGTERM)
        deadline = time.monotonic() + TERM_GRACE
        while time.monotonic() < deadline:
            self.sync()
            if not [pid for pid in self.records if self.verified_alive(pid)] and all(
                popen.poll() is not None for popen in self.popens
            ):
                break
            time.sleep(0.2)
        escalated = []
        for pid in list(self.records):
            if self.verified_alive(pid):
                escalated.append(pid)
                self._signal(pid, signal.SIGKILL)
        for popen in self.popens:
            if popen.poll() is None:
                popen.kill()
            popen.wait(timeout=TERM_GRACE)
        deadline = time.monotonic() + LISTENER_CLOSE_TIMEOUT
        while time.monotonic() < deadline and (_listen_inodes(self.port) or _port_accepts(self.port)):
            time.sleep(0.2)
        survivors = [pid for pid in self.records if self.verified_alive(pid)]
        listener_open = bool(_listen_inodes(self.port)) or _port_accepts(self.port)
        self.report = {"escalated": escalated, "survivors": survivors, "listener_open": listener_open}
        if survivors or listener_open:
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
        rc = installer.wait(timeout=INSTALLER_TIMEOUT)

    # Resolve every installer-launched daemon: exit receipt or owned listener (bounded).
    deadline = time.monotonic() + RESOLVE_TIMEOUT
    while True:
        custody.sync()
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
