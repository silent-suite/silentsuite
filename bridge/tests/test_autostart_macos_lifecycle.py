"""Black-box macOS launchd lifecycle tests for ``--install-autostart`` / ``--remove-autostart``.

A stateful fake launchd models one user's ``gui/<uid>`` domain and accepts both
the legacy (``load``/``unload``/``list``/``start``) and the modern
(``bootstrap``/``bootout``/``kickstart``/``print``) command families, so these
tests constrain observable outcomes rather than one command sequence. Expected
job and child states are fixed by each test, never derived from the code under
test.

Contract (process level only; a running child is NOT CalDAV/CardDAV readiness
or lasting health):

* install and reinstall explicitly request startup and return 0 only after a
  bounded check observes a child running from the current agent file;
* reinstall recovers a registered job whose child has stopped and applies
  changed launch arguments instead of trusting a repeated registration;
* a missing launchctl, timeouts, registration/teardown/start/query failures
  and a child that does not stay running return non-zero with fixed stage
  messages and never echo raw launchctl output (it can carry private paths,
  argv and environment);
* recoverable failures keep the agent file, settings.json and an existing
  job; removal keeps working and retains the persisted network profile.

The fake runs on a virtual clock: implementations must call ``time.monotonic``
and ``time.sleep`` through the ``time`` module, pass ``timeout=`` and capture
output on every ``subprocess.run`` call, and target ``gui/<uid>`` (the service
target the self-update restart kickstarts).
"""

import json
import logging
import os
import plistlib
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from silentsuite_bridge import autostart, config
from silentsuite_bridge.update import restart as update_restart

TEST_UID = os.getuid() if hasattr(os, "getuid") else 501
DOMAIN = f"gui/{TEST_UID}"
PRODUCTION_LABEL = "io.silentsuite.bridge"
UNRELATED_LABEL = "com.example.unrelated-agent"
FIRST_ARGS = ["/Applications/Silent Suite/first/silentsuite-bridge"]
SECOND_ARGS = ["/Applications/Silent Suite/second/silentsuite-bridge", "--no-tray"]

# Every fake launchctl response embeds this marker next to private-looking
# paths and environment; none of it may reach user-facing output or logs.
RAW_MARKER = "tok-lctl-5e2b"
RAW_NOISE = f"{RAW_MARKER} path=/Users/private-owner/{RAW_MARKER} SECRET_ENV={RAW_MARKER}-env"

# Fixed, content-free outcome messages the implementation must print (stdout or
# stderr). Failures also say the bridge is not confirmed running.
NOT_CONFIRMED = "not confirmed running"
STARTED = "launchd started the bridge process"
STAGE_MESSAGES = {
    "missing": "launchctl is not available",
    "timeout": "launchctl did not respond in time",
    "teardown": "could not stop the existing agent",
    "register": "could not register the agent",
    "start": "could not start the agent",
    "query": "could not read the agent state",
    "not_running": "the bridge process is not running",
}

NETWORK_ENV = tuple(config.NETWORK_PROFILE_ENV.values())
OTHER_ENV = (
    "SILENTSUITE_DATA_DIR",
    "XDG_DATA_HOME",
    "SILENTSUITE_BRIDGE_SSL",
    "SILENTSUITE_SSL",
    "SILENTSUITE_BRIDGE_SSL_CERT",
    "SILENTSUITE_SSL_CERT",
    "SILENTSUITE_BRIDGE_SSL_KEY",
    "SILENTSUITE_SSL_KEY",
)
RESOLVED_GLOBALS = (
    "LISTEN_ADDRESS",
    "LISTEN_PORT",
    "DEFAULT_SERVER_HOSTS",
    "SERVER_HOSTS",
    "ALLOW_REMOTE",
    "NETWORK_PROFILE_ERROR",
    "SSL_ENABLED",
    "SSL_CERT_FILE",
    "SSL_KEY_FILE",
    "SYNC_INTERVAL",
)


class UnboundedVerificationError(BaseException):
    """Raised by the fakes when startup verification has no bound (not an Exception, so it cannot be swallowed)."""


class VirtualClock:
    """Monotonic clock advanced by ``sleep`` and by each fake launchctl call."""

    LIMIT_SECONDS = 90.0
    MAX_SLEEPS = 1000

    def __init__(self):
        self.now = 1000.0
        self.begin_command()

    def begin_command(self):
        self.budget_start = self.now
        self.sleeps = 0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps += 1
        if self.sleeps > self.MAX_SLEEPS:
            raise UnboundedVerificationError("more than 1000 sleeps in one command")
        self.advance(max(float(seconds), 0.001))

    def advance(self, seconds):
        self.now += seconds
        if self.now - self.budget_start > self.LIMIT_SECONDS:
            raise UnboundedVerificationError("one command waited longer than 90 virtual seconds")


class _Job:
    def __init__(self, label, args, plist_path):
        self.label = label
        # Snapshot taken at registration: launchd never re-reads the file for a loaded job.
        self.args = list(args)
        self.plist_path = plist_path
        self.pid = None
        self.exit_at = None
        self.last_exit = None


class FakeLaunchd:
    """Stateful launchd model of one user's ``gui/<uid>`` domain.

    Knobs: ``failing`` maps a stage (register/teardown/start/query) to the exit
    code its commands return without changing state; ``timeouts`` holds stages
    whose commands raise ``subprocess.TimeoutExpired``; ``missing`` makes every
    call raise ``FileNotFoundError``; ``repeat_load_returncode`` is what a legacy
    ``load`` of an already-registered job returns (it never re-reads the file
    or starts the child); ``honours_run_at_load`` controls whether registration
    alone starts the child; ``child_mode`` is ``"runs"``,
    ``"exits-immediately"`` or ``"exits-shortly"``.

    Unknown services answer 113, a second ``bootstrap`` of a registered job
    answers 5; these are properties of this model, not cited launchctl facts.

    Domains: ``bootstrap``/``bootout``/``kickstart``/``print`` address the
    target ``gui/<uid>`` map (``jobs``). The installed man page says legacy
    subcommands (``list``/``load``/``unload``/``remove``/``start``/``stop``)
    select their domain from the caller (system when run as root). By default
    the caller context is that same GUI domain; ``caller_domain_is_gui =
    False`` routes legacy subcommands to a distinct ``caller_jobs`` map, which
    may omit the GUI job or hold a same-label decoy. ``manageruid`` and
    ``managername`` (stage ``context``) report ``manager_uid`` /
    ``manager_name``, defaulting to the current UID and ``Aqua``.
    ``caller_decoy_on_bootstrap`` starts a running same-label decoy in the
    caller map when the GUI job is bootstrapped.
    """

    MUTATING = (
        "bootstrap", "bootout", "load", "unload", "remove", "kickstart", "start", "stop", "kill", "enable", "disable",
    )

    STAGES = {
        "bootstrap": "register",
        "load": "register",
        "bootout": "teardown",
        "unload": "teardown",
        "remove": "teardown",
        "kickstart": "start",
        "start": "start",
        "print": "query",
        "list": "query",
        "manageruid": "context",
        "managername": "context",
    }
    COMMANDS = tuple(STAGES) + ("stop", "kill", "enable", "disable")
    NOT_FOUND = 113
    ALREADY_BOOTSTRAPPED = 5
    MAX_CALLS = 400

    def __init__(self, clock):
        self.clock = clock
        self.jobs = {}
        self.spawn_counts = {}
        self.disabled = set()
        self.calls = []
        self.unbounded_calls = []
        self.uncaptured_calls = []
        self.failing = {}
        self.timeouts = set()
        self.missing = False
        self.repeat_load_returncode = 0
        self.honours_run_at_load = True
        self.child_mode = "runs"
        self.caller_jobs = {}
        self.caller_domain_is_gui = True
        self.caller_decoy_on_bootstrap = False
        self.manager_uid = TEST_UID
        self.manager_name = "Aqua"
        self._next_pid = 4100

    # -- test-side inspection (never goes through launchctl) --

    def mutations(self):
        """Recorded launchctl calls that could change any launchd state."""
        return [call for call in self.calls if len(call) > 1 and call[1] in self.MUTATING]

    def add_caller_decoy(self, label=PRODUCTION_LABEL):
        """A running same-label job in the caller's (non-target) domain."""
        job = _Job(label, [f"/private/{RAW_MARKER}/decoy"], f"/Library/{RAW_MARKER}/decoy.plist")
        self.caller_jobs[label] = job
        self._next_pid += 1
        job.pid = self._next_pid
        return job.pid

    def caller_pid(self, label=PRODUCTION_LABEL):
        job = self.caller_jobs.get(label)
        return job.pid if job else None

    def is_registered(self, label=PRODUCTION_LABEL):
        return label in self.jobs

    def pid(self, label=PRODUCTION_LABEL):
        job = self.jobs.get(label)
        if job is None:
            return None
        self._refresh(job)
        return job.pid

    def running_args(self, label=PRODUCTION_LABEL):
        """Launch arguments of the running child, or None when no child is running."""
        return self.jobs[label].args if self.pid(label) else None

    def spawns(self, label=PRODUCTION_LABEL):
        """Children launched for ``label`` across all registrations."""
        return self.spawn_counts.get(label, 0)

    def stop_child(self, label=PRODUCTION_LABEL):
        """The child exits on its own; the job stays registered."""
        job = self.jobs[label]
        job.pid, job.exit_at, job.last_exit = None, None, 0

    def add_unrelated_job(self, label=UNRELATED_LABEL):
        job = _Job(label, [f"/Library/{RAW_MARKER}/agent"], f"/Library/LaunchAgents/{label}.plist")
        self.jobs[label] = job
        self._next_pid += 1
        job.pid = self._next_pid
        return job.pid

    # -- subprocess.run replacement --

    def __call__(self, argv, *args, **kwargs):
        argv = [os.fsdecode(token) for token in argv]
        self.calls.append(argv)
        if len(self.calls) > self.MAX_CALLS:
            raise UnboundedVerificationError("launchctl was polled without bound")
        self.clock.advance(0.01)
        sub = argv[1] if len(argv) > 1 else ""
        if kwargs.get("timeout") is None:
            self.unbounded_calls.append(sub)
        piped = kwargs.get("stdout") is not None and kwargs.get("stderr") is not None
        if not (kwargs.get("capture_output") or piped):
            self.uncaptured_calls.append(sub)
        if os.path.basename(argv[0]) != "launchctl":
            return self._result(argv, kwargs, 127, stderr=RAW_NOISE)
        if self.missing:
            raise FileNotFoundError(2, "No such file or directory", argv[0])
        stage = self.STAGES.get(sub)
        if stage in self.timeouts:
            limit = kwargs.get("timeout") or 30
            self.clock.advance(float(limit))
            raise subprocess.TimeoutExpired(argv, limit, output=RAW_NOISE.encode(), stderr=RAW_NOISE.encode())
        if stage in self.failing:
            noise = f"{sub} failed: {RAW_NOISE}\nservice already loaded\n"
            return self._result(argv, kwargs, self.failing[stage], noise, noise)
        if sub not in self.COMMANDS:
            return self._result(argv, kwargs, 64, stderr=f"Unrecognized subcommand: {RAW_NOISE}")
        return getattr(self, f"_cmd_{sub}")(argv, kwargs)

    # -- model internals --

    @staticmethod
    def _result(argv, kwargs, returncode, stdout="", stderr=""):
        if not (kwargs.get("text") or kwargs.get("universal_newlines") or kwargs.get("encoding")):
            stdout, stderr = stdout.encode(), stderr.encode()
        return subprocess.CompletedProcess(argv, returncode, stdout=stdout, stderr=stderr)

    def _ok(self, argv, kwargs, stdout=""):
        return self._result(argv, kwargs, 0, stdout, "")

    def _not_found(self, argv, kwargs):
        return self._result(argv, kwargs, self.NOT_FOUND, stderr=f"Could not find service: {RAW_NOISE}")

    @staticmethod
    def _operands(argv):
        return [token for token in argv[2:] if not token.startswith("-")]

    @staticmethod
    def _read_plist(path):
        try:
            with open(path, "rb") as handle:
                payload = plistlib.load(handle)
        except (OSError, ValueError):
            return None, None
        return payload.get("Label"), payload

    def _caller_map(self):
        """Jobs visible to legacy subcommands: the GUI map unless the caller context is elsewhere."""
        return self.jobs if self.caller_domain_is_gui else self.caller_jobs

    def _label_for_path(self, path, jobs=None):
        label, _ = self._read_plist(path)
        if label is not None:
            return label
        for job in (self.jobs if jobs is None else jobs).values():
            if job.plist_path == path:
                return job.label
        return None

    @staticmethod
    def _service_label(target):
        prefix = DOMAIN + "/"
        return target[len(prefix):] if target.startswith(prefix) else None

    def _refresh(self, job):
        if job.pid and job.exit_at is not None and self.clock.now >= job.exit_at:
            job.pid, job.exit_at, job.last_exit = None, None, 1

    def _spawn(self, job):
        self.spawn_counts[job.label] = self.spawn_counts.get(job.label, 0) + 1
        self._next_pid += 1
        if self.child_mode == "exits-immediately":
            job.pid, job.exit_at, job.last_exit = None, None, 78
            return
        job.pid = self._next_pid
        job.exit_at = self.clock.now + 0.2 if self.child_mode == "exits-shortly" else None

    def _kill(self, job):
        if job.pid:
            job.pid, job.exit_at, job.last_exit = None, None, -15

    def _register(self, label, payload, path, jobs=None):
        job = _Job(label, payload.get("ProgramArguments") or [payload.get("Program", "")], path)
        (self.jobs if jobs is None else jobs)[label] = job
        if self.honours_run_at_load and payload.get("RunAtLoad") and label not in self.disabled:
            self._spawn(job)

    def _unregister(self, label, jobs=None):
        self._kill((self.jobs if jobs is None else jobs).pop(label))

    def _cmd_bootstrap(self, argv, kwargs):
        operands = self._operands(argv)
        if len(operands) != 2 or operands[0] != DOMAIN:
            return self._result(argv, kwargs, 125, stderr=f"Domain does not support action: {RAW_NOISE}")
        label, payload = self._read_plist(operands[1])
        if label is None:
            return self._result(argv, kwargs, 2, stderr=f"Bootstrap failed: {RAW_NOISE}")
        if label in self.jobs:
            return self._result(argv, kwargs, self.ALREADY_BOOTSTRAPPED, stderr=f"Bootstrap failed: 5 {RAW_NOISE}")
        self._register(label, payload, operands[1])
        if self.caller_decoy_on_bootstrap and not self.caller_domain_is_gui:
            self.add_caller_decoy(label)
        return self._ok(argv, kwargs)

    def _cmd_load(self, argv, kwargs):
        operands = self._operands(argv)
        if len(operands) != 1:
            return self._result(argv, kwargs, 64, stderr=f"Usage: {RAW_NOISE}")
        label, payload = self._read_plist(operands[0])
        if label is None:
            return self._result(argv, kwargs, 1, stderr=f"Load failed: {RAW_NOISE}")
        jobs = self._caller_map()
        if label in jobs:
            noise = f"service already loaded {RAW_NOISE}"
            return self._result(argv, kwargs, self.repeat_load_returncode, stderr=noise)
        self._register(label, payload, operands[0], jobs)
        return self._ok(argv, kwargs)

    def _cmd_bootout(self, argv, kwargs):
        operands = self._operands(argv)
        if operands == [DOMAIN]:
            for label in list(self.jobs):
                self._unregister(label)
            return self._ok(argv, kwargs)
        if len(operands) == 1:
            label = self._service_label(operands[0])
        elif len(operands) == 2 and operands[0] == DOMAIN:
            label = self._label_for_path(operands[1])
        else:
            return self._result(argv, kwargs, 64, stderr=f"Usage: {RAW_NOISE}")
        if label not in self.jobs:
            return self._not_found(argv, kwargs)
        self._unregister(label)
        return self._ok(argv, kwargs)

    def _cmd_unload(self, argv, kwargs):
        operands = self._operands(argv)
        jobs = self._caller_map()
        label = self._label_for_path(operands[0], jobs) if len(operands) == 1 else None
        if label not in jobs:
            return self._not_found(argv, kwargs)
        self._unregister(label, jobs)
        return self._ok(argv, kwargs)

    def _cmd_remove(self, argv, kwargs):
        operands = self._operands(argv)
        jobs = self._caller_map()
        if len(operands) != 1 or operands[0] not in jobs:
            return self._not_found(argv, kwargs)
        self._unregister(operands[0], jobs)
        return self._ok(argv, kwargs)

    def _cmd_kickstart(self, argv, kwargs):
        operands = self._operands(argv)
        label = self._service_label(operands[0]) if len(operands) == 1 else None
        if label not in self.jobs:
            return self._not_found(argv, kwargs)
        if label in self.disabled:
            return self._result(argv, kwargs, 119, stderr=f"Service is disabled: {RAW_NOISE}")
        job = self.jobs[label]
        self._refresh(job)
        if job.pid and "-k" in argv:
            self._kill(job)
        if not job.pid:
            self._spawn(job)
        stdout = f"{DOMAIN}/{label}: service spawned with pid: {job.pid}\n" if "-p" in argv and job.pid else ""
        return self._ok(argv, kwargs, stdout)

    def _cmd_start(self, argv, kwargs):
        operands = self._operands(argv)
        jobs = self._caller_map()
        if len(operands) != 1 or operands[0] not in jobs:
            return self._not_found(argv, kwargs)
        job = jobs[operands[0]]
        self._refresh(job)
        if not job.pid:
            self._spawn(job)
        return self._ok(argv, kwargs)

    def _cmd_stop(self, argv, kwargs):
        operands = self._operands(argv)
        jobs = self._caller_map()
        if len(operands) != 1 or operands[0] not in jobs:
            return self._not_found(argv, kwargs)
        self._kill(jobs[operands[0]])
        return self._ok(argv, kwargs)

    def _cmd_manageruid(self, argv, kwargs):
        return self._result(argv, kwargs, 0, f"{self.manager_uid}\n", RAW_NOISE)

    def _cmd_managername(self, argv, kwargs):
        return self._result(argv, kwargs, 0, f"{self.manager_name}\n", RAW_NOISE)

    def _cmd_kill(self, argv, kwargs):
        operands = self._operands(argv)
        label = self._service_label(operands[1]) if len(operands) == 2 else None
        if label not in self.jobs:
            return self._not_found(argv, kwargs)
        self._kill(self.jobs[label])
        return self._ok(argv, kwargs)

    def _cmd_enable(self, argv, kwargs):
        operands = self._operands(argv)
        label = self._service_label(operands[0]) if len(operands) == 1 else None
        if label is None:
            return self._result(argv, kwargs, 64, stderr=f"Usage: {RAW_NOISE}")
        self.disabled.discard(label)
        return self._ok(argv, kwargs)

    def _cmd_disable(self, argv, kwargs):
        operands = self._operands(argv)
        label = self._service_label(operands[0]) if len(operands) == 1 else None
        if label is None:
            return self._result(argv, kwargs, 64, stderr=f"Usage: {RAW_NOISE}")
        self.disabled.add(label)
        return self._ok(argv, kwargs)

    def _cmd_print(self, argv, kwargs):
        operands = self._operands(argv)
        if operands == [DOMAIN]:
            lines = [f"{DOMAIN} = {{", "\tservices = {", f"\t\t0\t-\t{RAW_MARKER}.private.agent"]
            for job in self.jobs.values():
                self._refresh(job)
                status = "-" if job.last_exit is None else job.last_exit
                lines.append(f"\t\t{job.pid or 0}\t{status}\t{job.label}")
            return self._ok(argv, kwargs, "\n".join(lines + ["\t}", "}"]) + "\n")
        label = self._service_label(operands[0]) if len(operands) == 1 else None
        if label not in self.jobs:
            return self._not_found(argv, kwargs)
        job = self.jobs[label]
        self._refresh(job)
        lines = [
            f"{DOMAIN}/{label} = {{",
            f"\tactive count = {1 if job.pid else 0}",
            f"\tpath = {job.plist_path}",
            f"\tstate = {'running' if job.pid else 'not running'}",
            f"\tprogram = {job.args[0] if job.args else ''}",
            "\targuments = {",
            *[f"\t\t{arg}" for arg in job.args],
            "\t}",
            "\tenvironment = {",
            f"\t\tSECRET_ENV => {RAW_NOISE}",
            "\t}",
        ]
        if job.pid:
            lines.append(f"\tpid = {job.pid}")
        lines.append(f"\tlast exit code = {'(never exited)' if job.last_exit is None else job.last_exit}")
        return self._ok(argv, kwargs, "\n".join(lines + ["}"]) + "\n")

    def _cmd_list(self, argv, kwargs):
        operands = self._operands(argv)
        jobs = self._caller_map()
        if not operands:
            rows = ["PID\tStatus\tLabel", f"-\t0\t{RAW_MARKER}.private.agent"]
            for job in jobs.values():
                self._refresh(job)
                rows.append(f"{job.pid or '-'}\t{job.last_exit or 0}\t{job.label}")
            return self._ok(argv, kwargs, "\n".join(rows) + "\n")
        job = jobs.get(operands[0])
        if job is None:
            return self._not_found(argv, kwargs)
        self._refresh(job)
        lines = ["{", f'\t"Label" = "{job.label}";', f'\t"LastExitStatus" = {job.last_exit or 0};']
        if job.pid:
            lines.append(f'\t"PID" = {job.pid};')
        lines += [f'\t"Program" = "{job.args[0] if job.args else ""}";', '\t"ProgramArguments" = (']
        lines += [f'\t\t"{arg}";' for arg in job.args]
        lines += ["\t);", f'\t"EnvironmentVariables" = {{ "SECRET_ENV" = "{RAW_NOISE}"; }};', "};"]
        return self._ok(argv, kwargs, "\n".join(lines) + "\n")


def install_fake_launchd(monkeypatch):
    """Route subprocess.run through a fresh FakeLaunchd on a virtual clock."""
    clock = VirtualClock()
    launchd = FakeLaunchd(clock)
    monkeypatch.setattr(time, "monotonic", clock.monotonic)
    monkeypatch.setattr(time, "sleep", clock.sleep)
    monkeypatch.setattr(os, "getuid", lambda: TEST_UID, raising=False)
    monkeypatch.setattr(os, "geteuid", lambda: TEST_UID, raising=False)
    monkeypatch.setattr(subprocess, "run", launchd)
    return launchd


def isolated_bridge_env(tmp_path, monkeypatch):
    """Point HOME, the data directory and the platform at ``tmp_path`` (mirrors test_autostart_profile.env)."""
    for variable in NETWORK_ENV + OTHER_ENV:
        monkeypatch.delenv(variable, raising=False)
    for name in RESOLVED_GLOBALS:
        monkeypatch.setattr(config, name, getattr(config, name))
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(config, "SETTINGS_FILE", str(data_dir / "settings.json"))
    monkeypatch.setattr(config, "SSL_ENABLED", False)
    monkeypatch.setattr(config, "get_platform", lambda: "macos")
    config.load_settings()
    return SimpleNamespace(
        home=home,
        data_dir=data_dir,
        settings=data_dir / "settings.json",
        plist=home / "Library" / "LaunchAgents" / f"{autostart.LAUNCHD_LABEL}.plist",
        monkeypatch=monkeypatch,
        transcript=[],
    )


def read_settings(path):
    return json.loads(path.read_text(encoding="utf-8"))


def persist_port(bridge, port="45123"):
    bridge.monkeypatch.setenv("SILENTSUITE_LISTEN_PORT", port)
    config.load_settings()


@pytest.fixture
def mac(tmp_path, monkeypatch, caplog):
    bridge = isolated_bridge_env(tmp_path, monkeypatch)
    bridge.launchd = install_fake_launchd(monkeypatch)
    caplog.set_level(logging.DEBUG, logger="silentsuite-bridge")
    use_binary(bridge, FIRST_ARGS)
    return bridge


def use_binary(bridge, args):
    bridge.monkeypatch.setattr(autostart, "_get_binary_path", lambda: list(args))


def plist_args(bridge):
    return plistlib.loads(bridge.plist.read_bytes())["ProgramArguments"]


def run_cli(launchd, action):
    """Run install/remove with a fresh verification budget; a crash is a failure, not an exit code."""
    launchd.clock.begin_command()
    try:
        return action()
    except Exception as exc:
        pytest.fail(f"{action.__name__} raised {type(exc).__name__} instead of returning an exit code", pytrace=False)


def install(bridge):
    return run_cli(bridge.launchd, autostart.install_autostart)


def remove(bridge):
    return run_cli(bridge.launchd, autostart.remove_autostart)


def read_output(bridge, capsys):
    captured = capsys.readouterr()
    bridge.transcript.append(captured.out + captured.err)
    return captured


def assert_content_free(bridge, capsys, caplog):
    read_output(bridge, capsys)
    shown = "".join(bridge.transcript) + caplog.text
    assert RAW_MARKER not in shown, "raw launchctl output reached user-facing output or logs"
    assert "private-owner" not in shown
    assert "Traceback" not in shown
    assert bridge.launchd.uncaptured_calls == [], "launchctl output must be captured, never inherited"


def inject(launchd, kind, stage):
    if kind == "missing":
        launchd.missing = True
    elif kind == "failing":
        launchd.failing[stage] = 5
    else:
        launchd.timeouts.add(stage)


# --- Install / reinstall startup ---------------------------------------------


@pytest.mark.parametrize("honours_run_at_load", [True, False], ids=["run-at-load", "registration-only"])
def test_install_explicitly_starts_and_confirms_a_running_child(mac, capsys, caplog, honours_run_at_load):
    mac.launchd.honours_run_at_load = honours_run_at_load
    persist_port(mac)

    assert install(mac) == 0

    assert mac.launchd.running_args() == FIRST_ARGS, "install must leave a child running from the agent file"
    assert plist_args(mac) == FIRST_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    out = read_output(mac, capsys).out
    assert STARTED in out
    # Process start only: never a CalDAV/CardDAV readiness or health claim.
    assert "is ready" not in out
    assert "is running" not in out
    assert_content_free(mac, capsys, caplog)


@pytest.mark.parametrize(
    "repeat_load_returncode", [0, 5], ids=["repeat-load-reports-success", "repeat-load-reports-failure"]
)
def test_reinstall_recovers_stopped_job_and_applies_changed_arguments(mac, capsys, caplog, repeat_load_returncode):
    mac.launchd.repeat_load_returncode = repeat_load_returncode
    persist_port(mac)
    assert install(mac) == 0
    assert mac.launchd.running_args() == FIRST_ARGS
    mac.launchd.stop_child()
    assert mac.launchd.is_registered()
    assert mac.launchd.running_args() is None
    use_binary(mac, SECOND_ARGS)
    read_output(mac, capsys)

    assert install(mac) == 0, "reinstall must recover a registered job whose child stopped"

    assert mac.launchd.running_args() == SECOND_ARGS, "the running child must use the changed launch arguments"
    assert plist_args(mac) == SECOND_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert STARTED in read_output(mac, capsys).out
    assert_content_free(mac, capsys, caplog)


def test_reinstall_replaces_running_child_with_changed_arguments(mac, capsys, caplog):
    assert install(mac) == 0
    first_pid = mac.launchd.pid()
    assert first_pid
    use_binary(mac, SECOND_ARGS)

    assert install(mac) == 0

    assert mac.launchd.running_args() == SECOND_ARGS
    assert mac.launchd.pid() != first_pid
    assert_content_free(mac, capsys, caplog)


@pytest.mark.parametrize("child_mode", ["exits-immediately", "exits-shortly"])
def test_install_fails_when_child_does_not_stay_running(mac, capsys, caplog, child_mode):
    persist_port(mac)
    mac.launchd.child_mode = child_mode

    assert install(mac) != 0, "launchctl accepting the request is not proof the bridge started"

    captured = read_output(mac, capsys)
    shown = captured.out + captured.err
    assert STAGE_MESSAGES["not_running"] in shown
    assert NOT_CONFIRMED in shown
    assert STARTED not in shown
    assert mac.launchd.spawns() >= 1
    # Recoverable: the agent file and persisted profile stay for a retry.
    assert plist_args(mac) == FIRST_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert_content_free(mac, capsys, caplog)


FRESH_INSTALL_FAILURES = [
    pytest.param("missing", None, "missing", False, id="launchctl-missing"),
    pytest.param("failing", "register", "register", True, id="register-fails"),
    pytest.param("failing", "start", "start", True, id="start-fails"),
    pytest.param("failing", "query", "query", False, id="query-fails"),
    pytest.param("timeout", "register", "timeout", True, id="register-times-out"),
    pytest.param("timeout", "start", "timeout", True, id="start-times-out"),
    pytest.param("timeout", "query", "timeout", False, id="query-times-out"),
]


@pytest.mark.parametrize(("kind", "stage", "message", "plist_required"), FRESH_INSTALL_FAILURES)
def test_install_stage_failure_returns_nonzero_with_fixed_message(
    mac, capsys, caplog, kind, stage, message, plist_required
):
    persist_port(mac)
    inject(mac.launchd, kind, stage)

    assert install(mac) != 0

    captured = read_output(mac, capsys)
    shown = captured.out + captured.err
    assert STAGE_MESSAGES[message] in shown
    assert NOT_CONFIRMED in shown
    assert STARTED not in shown
    # A failure before the agent file is written may leave none; once written it is kept.
    if plist_required or mac.plist.exists():
        assert plist_args(mac) == FIRST_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert_content_free(mac, capsys, caplog)


@pytest.mark.parametrize(
    ("kind", "message"), [("failing", "teardown"), ("timeout", "timeout")], ids=["fails", "times-out"]
)
def test_reinstall_teardown_failure_keeps_existing_agent_file_and_job(mac, capsys, caplog, kind, message):
    persist_port(mac)
    assert install(mac) == 0
    original = mac.plist.read_bytes()
    use_binary(mac, SECOND_ARGS)
    inject(mac.launchd, kind, "teardown")
    read_output(mac, capsys)

    assert install(mac) != 0

    captured = read_output(mac, capsys)
    shown = captured.out + captured.err
    assert STAGE_MESSAGES[message] in shown
    assert NOT_CONFIRMED in shown
    assert STARTED not in shown
    # The existing job was not confirmed stopped, so its agent file is not replaced.
    assert mac.plist.read_bytes() == original
    assert mac.launchd.is_registered()
    assert mac.launchd.running_args() == FIRST_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert_content_free(mac, capsys, caplog)


def test_reinstall_after_registration_failure_recovers_on_retry(mac, capsys, caplog):
    persist_port(mac)
    assert install(mac) == 0
    use_binary(mac, SECOND_ARGS)
    mac.launchd.failing["register"] = 5

    assert install(mac) != 0

    captured = read_output(mac, capsys)
    assert STAGE_MESSAGES["register"] in captured.out + captured.err
    assert mac.plist.exists()
    assert mac.launchd.running_args() != SECOND_ARGS
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}

    mac.launchd.failing.clear()
    assert install(mac) == 0
    assert mac.launchd.running_args() == SECOND_ARGS
    assert plist_args(mac) == SECOND_ARGS
    assert_content_free(mac, capsys, caplog)


def test_every_launchctl_call_is_time_bounded_and_captured(mac, capsys, caplog):
    assert install(mac) == 0
    use_binary(mac, SECOND_ARGS)
    install(mac)
    assert remove(mac) == 0

    assert mac.launchd.calls
    assert mac.launchd.unbounded_calls == [], "every launchctl call needs a timeout"
    assert mac.launchd.uncaptured_calls == []


def test_lifecycle_never_addresses_unrelated_jobs(mac):
    unrelated_pid = mac.launchd.add_unrelated_job()
    assert install(mac) == 0
    mac.launchd.stop_child()
    use_binary(mac, SECOND_ARGS)
    install(mac)

    assert remove(mac) == 0

    assert mac.launchd.is_registered(UNRELATED_LABEL)
    assert mac.launchd.pid(UNRELATED_LABEL) == unrelated_pid
    assert not any(UNRELATED_LABEL in " ".join(call) for call in mac.launchd.calls)


def test_installed_agent_matches_self_update_restart_service_target(mac):
    # Regression guard for the sibling contract in update/restart.py, which
    # kickstarts gui/<uid>/io.silentsuite.bridge in place.
    assert install(mac) == 0
    first_pid = mac.launchd.pid()

    result = update_restart.ProcessAdapter().restart(Path(FIRST_ARGS[0]), "macos")

    assert result.success
    assert mac.launchd.running_args() == FIRST_ARGS
    assert mac.launchd.pid() != first_pid


# --- Removal -------------------------------------------------------------------


def test_remove_unregisters_job_stops_child_and_keeps_profile(mac, capsys, caplog):
    persist_port(mac)
    assert install(mac) == 0
    read_output(mac, capsys)

    assert remove(mac) == 0

    assert not mac.launchd.is_registered()
    assert not mac.plist.exists()
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    out = read_output(mac, capsys).out
    assert "Auto-start removed." in out
    assert "was kept" in out
    assert_content_free(mac, capsys, caplog)


def test_remove_finishes_when_agent_file_exists_but_job_is_not_registered(mac, capsys, caplog):
    persist_port(mac)
    mac.launchd.failing["register"] = 5
    assert install(mac) != 0
    assert mac.plist.exists()
    assert not mac.launchd.is_registered()
    mac.launchd.failing.clear()
    read_output(mac, capsys)

    assert remove(mac) == 0

    assert not mac.plist.exists()
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    out = read_output(mac, capsys).out
    assert "Auto-start removed." in out
    assert "was kept" in out
    assert_content_free(mac, capsys, caplog)


def test_remove_with_corrupt_settings_still_unregisters_job(mac, capsys, caplog):
    persist_port(mac)
    assert install(mac) == 0
    mac.settings.write_text("{tok-c3f1e9 not json", encoding="utf-8")
    config.load_settings()
    read_output(mac, capsys)

    assert remove(mac) == 0

    assert not mac.launchd.is_registered()
    assert not mac.plist.exists()
    assert mac.settings.read_text(encoding="utf-8") == "{tok-c3f1e9 not json"
    assert "Auto-start removed." in read_output(mac, capsys).out
    assert "tok-c3f1e9" not in "".join(mac.transcript)
    assert_content_free(mac, capsys, caplog)


@pytest.mark.parametrize("kind", ["failing", "timeout"], ids=["fails", "times-out"])
def test_remove_keeps_agent_file_when_teardown_is_not_confirmed(mac, capsys, caplog, kind):
    persist_port(mac)
    assert install(mac) == 0
    inject(mac.launchd, kind, "teardown")
    read_output(mac, capsys)

    assert remove(mac) != 0

    captured = read_output(mac, capsys)
    assert "Auto-start removed" not in captured.out
    assert "was not removed" in captured.err
    if kind == "timeout":
        assert STAGE_MESSAGES["timeout"] in captured.out + captured.err
    assert mac.plist.exists()
    assert mac.launchd.is_registered()
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert_content_free(mac, capsys, caplog)


# --- Caller domain vs target gui/<uid> domain ----------------------------------
#
# Legacy subcommands (list/load/unload/...) follow the caller's launchd
# context, while bootstrap/bootout/kickstart address gui/<uid>. When the caller
# context is not that GUI domain, a successful legacy listing can omit the
# registered GUI job or show a same-label decoy, so it proves nothing about the
# target. Install and remove must refuse before changing the agent file or any
# launchd state. Contexts are synthetic: a manageruid that is not the target
# UID, a non-Aqua manager, a root caller whose manageruid/managername still
# match, and manageruid/managername queries that fail or time out.

CALLER_CONTEXTS = [
    pytest.param("wrong-uid", id="manager-uid-mismatch"),
    pytest.param("background", id="non-aqua-manager"),
    pytest.param("root", id="root-caller-with-matching-metadata"),
    pytest.param("context-fails", id="context-query-fails"),
    pytest.param("context-times-out", id="context-query-times-out"),
]
CALLER_LISTINGS = [
    pytest.param(False, id="caller-listing-omits-gui-job"),
    pytest.param(True, id="caller-listing-shows-decoy"),
]


def detach_caller_domain(bridge, context, decoy=False):
    launchd = bridge.launchd
    launchd.caller_domain_is_gui = False
    if context == "wrong-uid":
        launchd.manager_uid = TEST_UID + 1
    elif context == "background":
        launchd.manager_name = "Background"
    elif context == "root":
        # manageruid/managername still match; only the effective UID shows that
        # legacy subcommands would address the system domain.
        bridge.monkeypatch.setattr(os, "geteuid", lambda: 0, raising=False)
    elif context == "context-fails":
        launchd.failing["context"] = 5
    else:
        launchd.timeouts.add("context")
    return launchd.add_caller_decoy() if decoy else None


def assert_target_untouched(bridge, original_plist, gui_pid, unrelated_pid, decoy_pid):
    launchd = bridge.launchd
    assert bridge.plist.read_bytes() == original_plist, "the agent file changed before the target state was proven"
    assert launchd.is_registered(), "the registered GUI job was removed"
    assert launchd.pid() == gui_pid, "the running GUI child was stopped or replaced"
    assert launchd.running_args() == FIRST_ARGS
    assert launchd.mutations() == [], "launchd state was mutated before the caller context was proven"
    assert launchd.pid(UNRELATED_LABEL) == unrelated_pid
    assert launchd.caller_pid() == decoy_pid
    assert launchd.unbounded_calls == []
    assert read_settings(bridge.settings) == {"network": {"listenPort": 45123}}


@pytest.mark.parametrize("decoy", CALLER_LISTINGS)
@pytest.mark.parametrize("context", CALLER_CONTEXTS)
def test_reinstall_refuses_before_any_change_when_caller_domain_is_not_target_gui(
    mac, capsys, caplog, context, decoy
):
    persist_port(mac)
    unrelated_pid = mac.launchd.add_unrelated_job()
    assert install(mac) == 0
    original = mac.plist.read_bytes()
    gui_pid = mac.launchd.pid()
    decoy_pid = detach_caller_domain(mac, context, decoy)
    use_binary(mac, SECOND_ARGS)
    read_output(mac, capsys)
    mac.launchd.calls.clear()

    assert install(mac) != 0

    captured = read_output(mac, capsys)
    assert NOT_CONFIRMED in captured.out + captured.err
    assert STARTED not in captured.out + captured.err
    assert_target_untouched(mac, original, gui_pid, unrelated_pid, decoy_pid)
    assert_content_free(mac, capsys, caplog)


@pytest.mark.parametrize("decoy", CALLER_LISTINGS)
@pytest.mark.parametrize("context", CALLER_CONTEXTS)
def test_remove_refuses_and_keeps_agent_when_caller_domain_is_not_target_gui(mac, capsys, caplog, context, decoy):
    persist_port(mac)
    unrelated_pid = mac.launchd.add_unrelated_job()
    assert install(mac) == 0
    original = mac.plist.read_bytes()
    gui_pid = mac.launchd.pid()
    decoy_pid = detach_caller_domain(mac, context, decoy)
    read_output(mac, capsys)
    mac.launchd.calls.clear()

    assert remove(mac) != 0, "a caller-domain listing without the job is not proof the GUI agent is gone"

    captured = read_output(mac, capsys)
    assert "Auto-start removed" not in captured.out
    assert "was not removed" in captured.err
    assert_target_untouched(mac, original, gui_pid, unrelated_pid, decoy_pid)
    assert_content_free(mac, capsys, caplog)


def test_install_does_not_confirm_startup_from_a_wrong_domain_decoy_pid(mac, capsys, caplog):
    # The GUI child never runs; a same-label job in the caller's (non-GUI)
    # domain starts alongside the bootstrap and lists a stable PID. That PID
    # must not be taken as the target child, through the verification path or
    # otherwise.
    persist_port(mac)
    mac.launchd.child_mode = "exits-immediately"
    mac.launchd.caller_decoy_on_bootstrap = True
    detach_caller_domain(mac, "background")

    assert install(mac) != 0, "a decoy PID from another domain is not proof the bridge started"

    captured = read_output(mac, capsys)
    assert STARTED not in captured.out + captured.err
    assert NOT_CONFIRMED in captured.out + captured.err
    assert mac.launchd.running_args() is None
    assert mac.launchd.unbounded_calls == []
    assert read_settings(mac.settings) == {"network": {"listenPort": 45123}}
    assert_content_free(mac, capsys, caplog)
