"""BRIDGEX-05: an optional linger step must stay best-effort when tools are missing.

Runs the real CLI ``python -m silentsuite_bridge --install-autostart`` in a
subprocess. The path is ``install_autostart`` -> ``install_autostart_linux`` ->
``_enable_linger``.

The environment is built from scratch, never copied from ``os.environ``:
- HOME, XDG_CONFIG_HOME and TMPDIR live under ``tmp_path``.
- USER is synthetic.
- No SILENTSUITE_* variables are set, and there are no location overrides
  (SILENTSUITE_DATA_DIR, XDG_DATA_HOME) and no BROWSER.

PATH is an isolated directory holding only the stub tools named per case. The
host's systemctl, loginctl and sudo are never reachable. Stubs append argv and
their exit code to ``$HOME/calls.log``.

The fixture boundary is the stub service tools, which declare success or
failure. A tool's absence is real: it is simply not on PATH.

Linux-only platform selection; the platform is recorded in every test id.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    sys.platform != "linux",
    reason="Linux-only platform selection (systemd user autostart path); receipt in test ids",
)

BRIDGE_SRC = Path(__file__).resolve().parents[1] / "src"
SYNTHETIC_USER = "audit-ci-user"
RECEIPT = f"BRIDGEX-05-{sys.platform}-py{sys.version_info[0]}.{sys.version_info[1]}"
platform_receipt = pytest.mark.parametrize("receipt", [RECEIPT], ids=[RECEIPT])


def _write_tool(fake_bin: Path, name: str, body: str) -> None:
    tool = fake_bin / name
    tool.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    tool.chmod(0o755)


def _systemctl(fake_bin: Path, *, start_rc: int = 0) -> None:
    _write_tool(
        fake_bin,
        "systemctl",
        "rc=0\n"
        f'if [ "$2" = "start" ]; then rc={start_rc}; fi\n'
        'echo "systemctl $* rc=$rc" >> "$HOME/calls.log"\n'
        "exit $rc\n",
    )


def _loginctl(fake_bin: Path, *, linger_yes: bool) -> None:
    output = 'echo "Linger=yes"\n' if linger_yes else ""
    _write_tool(
        fake_bin,
        "loginctl",
        'echo "loginctl $* rc=0" >> "$HOME/calls.log"\n' + output + "exit 0\n",
    )


def _sudo(fake_bin: Path, *, rc: int) -> None:
    _write_tool(
        fake_bin,
        "sudo",
        f'echo "sudo $* rc={rc}" >> "$HOME/calls.log"\nexit {rc}\n',
    )


def _run_install(tmp_path: Path, configure_tools) -> dict:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    configure_tools(fake_bin)
    home = tmp_path / "home"
    home.mkdir()
    env = {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "TMPDIR": str(tmp_path),
        "PATH": str(fake_bin),
        "PYTHONPATH": str(BRIDGE_SRC),
        "PYTHONDONTWRITEBYTECODE": "1",
        "USER": SYNTHETIC_USER,
    }
    for passthrough in ("SYSTEMROOT", "PYTHONHOME", "VIRTUAL_ENV", "LANG", "LC_ALL"):
        if passthrough in os.environ:
            env[passthrough] = os.environ[passthrough]

    result = subprocess.run(
        [sys.executable, "-m", "silentsuite_bridge", "--install-autostart"],
        cwd=str(tmp_path),
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=120,
    )
    calls_log = home / "calls.log"
    calls = calls_log.read_text(encoding="utf-8").splitlines() if calls_log.exists() else []
    units = sorted((home / ".config" / "systemd" / "user").glob("*.service"))
    return {
        "rc": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "calls": calls,
        "units": units,
    }


def _call(calls, prefix):
    return [line for line in calls if line.startswith(prefix)]


def _require_service_preconditions(run: dict, *, start_rc: int = 0) -> None:
    """Explicit preconditions: preceding systemctl calls ran with the declared results; unit exists."""
    expected = {
        "systemctl --user daemon-reload": "rc=0",
        "systemctl --user enable ": "rc=0",
        "systemctl --user start ": f"rc={start_rc}",
    }
    problems = []
    for prefix, suffix in expected.items():
        lines = _call(run["calls"], prefix)
        if len(lines) != 1 or not lines[0].endswith(suffix):
            problems.append((prefix, lines))
    if len(run["units"]) != 1:
        problems.append(("unit file", [str(path) for path in run["units"]]))
    if problems:
        pytest.fail(
            f"{RECEIPT} fixture precondition failed: {problems!r}\n"
            f"stdout={run['stdout'][-1500:]}\nstderr={run['stderr'][-1500:]}"
        )


def _verdict(run: dict) -> dict:
    return {
        "rc": run["rc"],
        "traceback": "Traceback" in run["stderr"],
        "linger_guidance": "enable-linger" in run["stdout"],
    }


def _detail(run: dict) -> str:
    return f"calls={run['calls']!r}\nstdout={run['stdout'][-1500:]}\nstderr={run['stderr'][-1500:]}"


@platform_receipt
def test_BRIDGEX_05_missing_loginctl_is_best_effort(tmp_path, receipt):
    run = _run_install(tmp_path, lambda fake_bin: _systemctl(fake_bin))
    _require_service_preconditions(run)
    assert _verdict(run) == {"rc": 0, "traceback": False, "linger_guidance": True}, (
        f"{receipt}: {_detail(run)}"
    )


@platform_receipt
def test_BRIDGEX_05_missing_sudo_is_best_effort(tmp_path, receipt):
    def tools(fake_bin):
        _systemctl(fake_bin)
        _loginctl(fake_bin, linger_yes=False)

    run = _run_install(tmp_path, tools)
    _require_service_preconditions(run)
    assert _verdict(run) == {"rc": 0, "traceback": False, "linger_guidance": True}, (
        f"{receipt}: {_detail(run)}"
    )


@platform_receipt
def test_BRIDGEX_05_all_tools_available_control(tmp_path, receipt):
    def tools(fake_bin):
        _systemctl(fake_bin)
        _loginctl(fake_bin, linger_yes=False)
        _sudo(fake_bin, rc=0)

    run = _run_install(tmp_path, tools)
    _require_service_preconditions(run)
    observed = {
        "rc": run["rc"],
        "traceback": "Traceback" in run["stderr"],
        "linger_enabled_message": "Enabled linger" in run["stdout"],
        "sudo_calls": _call(run["calls"], "sudo "),
    }
    assert observed == {
        "rc": 0,
        "traceback": False,
        "linger_enabled_message": True,
        "sudo_calls": [f"sudo -n loginctl enable-linger {SYNTHETIC_USER} rc=0"],
    }, f"{receipt}: {_detail(run)}"


@platform_receipt
def test_BRIDGEX_05_existing_linger_control(tmp_path, receipt):
    def tools(fake_bin):
        _systemctl(fake_bin)
        _loginctl(fake_bin, linger_yes=True)

    run = _run_install(tmp_path, tools)
    _require_service_preconditions(run)
    observed = {
        "rc": run["rc"],
        "traceback": "Traceback" in run["stderr"],
        "linger_checked": len(_call(run["calls"], "loginctl show-user ")) == 1,
    }
    assert observed == {"rc": 0, "traceback": False, "linger_checked": True}, (
        f"{receipt}: {_detail(run)}"
    )


@platform_receipt
def test_BRIDGEX_05_sudo_refused_control(tmp_path, receipt):
    def tools(fake_bin):
        _systemctl(fake_bin)
        _loginctl(fake_bin, linger_yes=False)
        _sudo(fake_bin, rc=1)

    run = _run_install(tmp_path, tools)
    _require_service_preconditions(run)
    assert _verdict(run) == {"rc": 0, "traceback": False, "linger_guidance": True}, (
        f"{receipt}: {_detail(run)}"
    )


@platform_receipt
def test_BRIDGEX_05_systemctl_start_failure_control(tmp_path, receipt):
    run = _run_install(tmp_path, lambda fake_bin: _systemctl(fake_bin, start_rc=1))
    _require_service_preconditions(run, start_rc=1)
    observed = {
        "rc": run["rc"],
        "traceback": "Traceback" in run["stderr"],
        "loginctl_calls": _call(run["calls"], "loginctl "),
    }
    assert observed == {"rc": 1, "traceback": False, "loginctl_calls": []}, (
        f"{receipt}: {_detail(run)}"
    )
