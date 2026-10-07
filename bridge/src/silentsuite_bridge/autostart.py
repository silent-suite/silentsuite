"""Auto-start configuration for SilentSuite Bridge.

Installs/removes auto-start entries so the bridge starts
when the system boots:
- Linux: systemd user service
- macOS: launchd agent
- Windows: startup registry entry

Auto-start entries execute the bridge with a clean environment, so the
listener profile that was explicitly configured through
``SILENTSUITE_LISTEN_ADDRESS`` / ``SILENTSUITE_LISTEN_PORT`` /
``SILENTSUITE_SERVER_HOSTS`` / ``SILENTSUITE_ALLOW_REMOTE`` is persisted into
``settings.json`` (validated, closed-world) before any entry is written. All
three platform entries then consume that same durable profile.

Usage:
    silentsuite-bridge --install-autostart
    silentsuite-bridge --remove-autostart
"""

import logging
import os
import plistlib
import posixpath
import shutil
import subprocess
import sys
import time

from . import config

logger = logging.getLogger("silentsuite-bridge.autostart")

LAUNCHD_LABEL = "io.silentsuite.bridge"
SYSTEMD_UNIT = "silentsuite-bridge.service"
WINDOWS_RUN_VALUE = "SilentSuiteBridge"

_PROFILE_RETAINED_NOTE = (
    "The persisted network profile in settings.json was kept; delete its "
    f'"{config.NETWORK_PROFILE_KEY}" section to reset the bridge to its loopback defaults.'
)


def _get_binary_path():
    """Get the path to the silentsuite-bridge executable as a list of args."""
    # If running from a PyInstaller bundle
    if getattr(sys, "frozen", False):
        return [sys.executable]

    # If running from installed package, find the console script
    bridge_path = shutil.which("silentsuite-bridge")
    if bridge_path:
        return [bridge_path]

    # Fallback: use python -m
    return [sys.executable, "-m", "silentsuite_bridge"]


# --- Durable network profile ---


# Environment variables that relocate settings.json for the installing shell
# only. Auto-start entries carry no shell environment, so a profile persisted
# under a relocated directory would never be read by the restarted bridge.
# Linux resolves the default data directory through XDG_DATA_HOME; macOS and
# Windows do not consult it.
_LOCATION_OVERRIDES = {
    "linux": ("SILENTSUITE_DATA_DIR", "XDG_DATA_HOME"),
    "macos": ("SILENTSUITE_DATA_DIR",),
    "windows": ("SILENTSUITE_DATA_DIR",),
}


def unsupported_location_overrides(platform: str, environ=None) -> list[str]:
    """Return the settings-location overrides present in ``environ`` for ``platform``."""
    environ = os.environ if environ is None else environ
    names = _LOCATION_OVERRIDES.get(platform, _LOCATION_OVERRIDES["linux"])
    return [name for name in names if name in environ]


def persist_network_profile(platform: str | None = None) -> int:
    """Validate and persist the explicit network profile before any autostart write.

    Returns 0 on success, 1 on failure. On a validation failure or a write
    failure before the replace nothing has been changed; when the replace
    succeeded but its directory sync did not, the message says so rather than
    claiming the file was left unchanged.
    """
    platform = config.get_platform() if platform is None else platform
    overrides = unsupported_location_overrides(platform)
    if overrides:
        names = " and ".join(overrides)
        print(
            f"Error: --install-autostart does not support {names}. Auto-start entries run "
            "with a clean environment and would read the default data directory (different settings, "
            f"credentials, and cache) instead of the configured one. Unset {names} and retry. "
            "Nothing was changed.",
            file=sys.stderr,
        )
        return 1

    # Read, merge, validate and replace happen in one locked transaction so an
    # overlapping --install-autostart cannot be merged over a stale profile.
    try:
        profile, written = config.install_network_profile()
    except config.SettingsFileError as exc:
        print(f"Error: {exc}; auto-start was not installed and nothing was changed.", file=sys.stderr)
        return 1
    except RuntimeError as exc:
        # NetworkProfileError and the remote-bind refusal name settings and
        # rules only; supplied values are never echoed. Validation failures
        # inside the lock happen before the replace: nothing was written.
        print(f"Error: {exc}", file=sys.stderr)
        print("Auto-start was not installed and nothing was changed.", file=sys.stderr)
        return 1
    except config.SettingsDurabilityError as exc:
        # os.replace completed: settings.json already shows the new profile.
        print(
            f"Error: {exc}. Auto-start was not installed; check the data directory's filesystem and "
            "re-run --install-autostart to confirm the persisted profile.",
            file=sys.stderr,
        )
        return 1
    except config.SettingsLockError as exc:
        # Raised before any read or write: another writer held settings.json.
        print(
            f"Error: {exc}. The existing settings.json was left unchanged and auto-start was not installed.",
            file=sys.stderr,
        )
        return 1
    except OSError:
        print(
            "Error: could not write the bridge settings file; the existing settings.json was left "
            "unchanged and auto-start was not installed.",
            file=sys.stderr,
        )
        return 1

    if written:
        print("Persisted explicit network settings to settings.json: " + ", ".join(sorted(profile)))
    else:
        print(
            "No explicit network settings to persist; auto-start keeps the default loopback bind "
            f"({config.DEFAULT_LISTEN_ADDRESS}:{config.DEFAULT_LISTEN_PORT})."
        )
    return 0


# --- Linux (systemd) ---

SYSTEMD_SERVICE = """[Unit]
Description=SilentSuite Bridge — E2EE CalDAV/CardDAV Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exec_start}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"""


def _systemd_exec_start(args) -> str:
    """Quote an argv for a systemd ExecStart= line.

    Each argument is double-quoted; backslashes and double quotes are
    backslash-escaped, ``$`` and ``%`` are doubled so systemd performs no
    variable or specifier expansion on installation paths.
    """
    quoted = []
    for arg in args:
        escaped = (
            arg.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("$", "$$")
            .replace("%", "%%")
        )
        quoted.append(f'"{escaped}"')
    return " ".join(quoted)


def render_systemd_service(binary_args) -> str:
    return SYSTEMD_SERVICE.format(exec_start=_systemd_exec_start(binary_args))


def _systemd_service_path():
    return os.path.expanduser(f"~/.config/systemd/user/{SYSTEMD_UNIT}")


def _run_reported(argv, action) -> bool:
    """Run a service-manager command; report and return False on non-zero exit or a missing tool."""
    try:
        result = subprocess.run(argv, check=False, capture_output=True)
    except OSError:
        logger.warning("%s failed (service manager not available)", action)
        print(f"  Warning: {action} could not run ({argv[0]} is not available)")
        return False
    if result.returncode != 0:
        logger.warning("%s failed (exit %d)", action, result.returncode)
        print(f"  Warning: {action} exited with code {result.returncode}")
        return False
    return True


def install_autostart_linux() -> int:
    """Install systemd user service for auto-start."""
    binary_args = _get_binary_path()
    service_path = _systemd_service_path()
    service_dir = os.path.dirname(service_path)

    try:
        os.makedirs(service_dir, exist_ok=True)
        # systemd reads unit files as UTF-8; never depend on the locale encoding.
        with open(service_path, "w", encoding="utf-8") as f:
            f.write(render_systemd_service(binary_args))
    except OSError:
        print("Error: could not write the systemd user service file.", file=sys.stderr)
        return 1

    logger.info("Installed systemd service")

    # Enable and start the service
    ok = _run_reported(["systemctl", "--user", "daemon-reload"], "systemctl daemon-reload")
    ok = _run_reported(["systemctl", "--user", "enable", SYSTEMD_UNIT], "systemctl enable") and ok
    ok = _run_reported(["systemctl", "--user", "start", SYSTEMD_UNIT], "systemctl start") and ok

    print(f"Auto-start installed: {service_path}")
    if ok:
        print("systemd accepted the enable/start request.")
    else:
        print("The service file is installed, but systemd reported a failure; the bridge is not confirmed running.")
    print("Check status: systemctl --user status silentsuite-bridge")

    if ok:
        _enable_linger()
    return 0 if ok else 1


def _enable_linger() -> None:
    # systemd user units don't survive reboot unless the user has lingering enabled.
    # Try it non-interactively with sudo -n; if that needs a password we just tell
    # the user how to run it themselves. This is best-effort — the service still
    # works for the current session either way.
    user = os.environ.get("USER", "")
    linger_check = subprocess.run(
        ["loginctl", "show-user", user, "--property=Linger"],
        check=False, capture_output=True,
    )
    if b"Linger=yes" in linger_check.stdout:
        return
    r = subprocess.run(
        ["sudo", "-n", "loginctl", "enable-linger", user],
        check=False, capture_output=True,
    )
    if r.returncode == 0:
        print(f"Enabled linger for {user} so the bridge survives logout/reboot.")
    else:
        print("")
        print("Note: to keep the bridge running after logout/reboot, run:")
        print(f"  sudo loginctl enable-linger {user}")


def remove_autostart_linux() -> int:
    """Remove the systemd user service. The persisted network profile is retained.

    Order: stop, disable, delete the unit file, daemon-reload. If stop or
    disable is not confirmed the unit file is kept so the command can be
    retried; a non-zero return never claims the bridge was removed or stopped.
    """
    service_path = _systemd_service_path()

    if not os.path.exists(service_path):
        print("Auto-start was not installed.")
        print(_PROFILE_RETAINED_NOTE)
        return 0

    ok = _run_reported(["systemctl", "--user", "stop", SYSTEMD_UNIT], "systemctl stop")
    ok = _run_reported(["systemctl", "--user", "disable", SYSTEMD_UNIT], "systemctl disable") and ok
    if not ok:
        print(
            "Auto-start was not removed: systemd did not confirm stop/disable, so the service file "
            "was kept and the bridge may still be running. Retry after checking "
            "`systemctl --user status silentsuite-bridge`.",
            file=sys.stderr,
        )
        return 1

    try:
        os.remove(service_path)
    except OSError:
        print("Error: could not remove the systemd user service file.", file=sys.stderr)
        return 1
    logger.info("Removed systemd service")

    if not _run_reported(["systemctl", "--user", "daemon-reload"], "systemctl daemon-reload"):
        print(
            "The service file was removed, but systemd did not confirm the reload; run "
            "`systemctl --user daemon-reload` to finish removal.",
            file=sys.stderr,
        )
        return 1

    print("Auto-start removed.")
    print(_PROFILE_RETAINED_NOTE)
    return 0


# --- macOS (launchd) ---


def _launchd_plist_path():
    return os.path.expanduser(f"~/Library/LaunchAgents/{LAUNCHD_LABEL}.plist")


def _launchd_log_dir():
    return os.path.expanduser("~/Library/Logs/SilentSuiteBridge")


def render_launchd_plist(binary_args, log_dir: str) -> bytes:
    """Render the launchd agent with plistlib so paths are XML-escaped correctly."""
    payload = {
        "Label": LAUNCHD_LABEL,
        "ProgramArguments": list(binary_args),
        "RunAtLoad": True,
        "KeepAlive": {"NetworkState": True},
        # launchd paths are always POSIX; posixpath keeps rendering portable when
        # the plist is generated or tested on Windows.
        "StandardOutPath": posixpath.join(log_dir, "bridge.log"),
        "StandardErrorPath": posixpath.join(log_dir, "bridge.error.log"),
    }
    return plistlib.dumps(payload, sort_keys=False)


# Every launchctl call is bounded and its output captured but never shown:
# it can carry private paths, arguments and environment.
_LAUNCHCTL_TIMEOUT = 15.0
_LAUNCHD_POLL_SECONDS = 0.25
# Startup is confirmed only when the same PID is still listed after this long.
_LAUNCHD_STABLE_SECONDS = 1.0
_LAUNCHD_START_TIMEOUT = 10.0
_LAUNCHD_TEARDOWN_TIMEOUT = 10.0

_LAUNCHD_STAGE_TEXT = {
    "query": "could not read the agent state",
    "teardown": "could not stop the existing agent",
    "register": "could not register the agent",
    "start": "could not start the agent",
    "verify": "the bridge process is not running",
}
_LAUNCHCTL_REASON_TEXT = {
    "missing": "launchctl is not available",
    "timeout": "launchctl did not respond in time",
}


def _launchd_service_target() -> str:
    # Same gui/<uid>/<label> target the self-update restart kickstarts.
    return f"gui/{os.getuid()}/{LAUNCHD_LABEL}"


def _launchctl(*args) -> str:
    """Run launchctl; return "ok", "failed", "missing" or "timeout". Output is discarded."""
    return _launchctl_output(*args)[0]


def _launchctl_output(*args):
    try:
        result = subprocess.run(
            ["launchctl", *args], check=False, capture_output=True, timeout=_LAUNCHCTL_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        return "timeout", None
    except OSError:
        return "missing", None
    if result.returncode != 0:
        return "failed", None
    stdout = result.stdout
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")
    return "ok", stdout or ""


def _query_launchd_job():
    """Return (outcome, registered, pid) for LAUNCHD_LABEL from ``launchctl list``.

    ``launchctl list`` without arguments prints PID / last exit status / label
    columns; a ``-`` PID means the job is loaded but not running. Absence is
    concluded only from a successful listing without the exact label, never
    from an error code. An unparsable PID fails closed as a query failure.
    """
    outcome, stdout = _launchctl_output("list")
    if outcome != "ok":
        return outcome, False, None
    for line in stdout.splitlines():
        fields = line.split(None, 2)
        if len(fields) != 3 or fields[2].strip() != LAUNCHD_LABEL:
            continue
        if fields[0] == "-":
            return "ok", True, None
        try:
            pid = int(fields[0])
        except ValueError:
            return "failed", False, None
        return "ok", True, (pid if pid > 0 else None)
    return "ok", False, None


def _wait_until_launchd_job_absent() -> str:
    deadline = time.monotonic() + _LAUNCHD_TEARDOWN_TIMEOUT
    while True:
        outcome, registered, _ = _query_launchd_job()
        if outcome != "ok":
            return outcome
        if not registered:
            return "ok"
        if time.monotonic() >= deadline:
            return "failed"
        time.sleep(_LAUNCHD_POLL_SECONDS)


def _teardown_launchd_job():
    """Boot out the registered job and confirm it is gone; return (stage, outcome)."""
    outcome = _launchctl("bootout", _launchd_service_target())
    if outcome != "ok":
        return "teardown", outcome
    outcome = _wait_until_launchd_job_absent()
    if outcome == "failed":
        return "teardown", outcome
    return "query", outcome


def _verify_launchd_child_running():
    """Wait (bounded) until one PID stays listed for the stability window; return (stage, outcome)."""
    deadline = time.monotonic() + _LAUNCHD_START_TIMEOUT
    candidate = None
    since = 0.0
    while True:
        outcome, _, pid = _query_launchd_job()
        if outcome != "ok":
            return "query", outcome
        now = time.monotonic()
        if pid is None:
            candidate = None
        elif pid != candidate:
            candidate, since = pid, now
        elif now - since >= _LAUNCHD_STABLE_SECONDS:
            return "verify", "ok"
        if now >= deadline:
            return "verify", "failed"
        time.sleep(_LAUNCHD_POLL_SECONDS)


def _launchd_failure_text(stage: str, outcome: str) -> str:
    text = _LAUNCHD_STAGE_TEXT[stage]
    reason = _LAUNCHCTL_REASON_TEXT.get(outcome)
    return f"{text} ({reason})" if reason else text


def _report_launchd_failure(stage: str, outcome: str, detail: str) -> int:
    logger.warning("launchd %s stage failed (%s)", stage, outcome)
    print(
        f"Error: {_launchd_failure_text(stage, outcome)}; the bridge is not confirmed running. {detail}",
        file=sys.stderr,
    )
    print(f"Check status: launchctl print {_launchd_service_target()}", file=sys.stderr)
    return 1


def install_autostart_macos() -> int:
    """Install the launchd agent and confirm launchd started its process.

    Order: query; if the job is registered, boot it out and confirm it is gone
    before the agent file is replaced (otherwise the file is kept unchanged);
    write the file; bootstrap; kickstart; then wait, bounded, for a stable
    child PID. Success means the process started, not that sync works.
    """
    binary_args = _get_binary_path()
    plist_path = _launchd_plist_path()
    log_dir = _launchd_log_dir()
    unchanged = "No agent file was changed."

    outcome, registered, _ = _query_launchd_job()
    if outcome != "ok":
        return _report_launchd_failure("query", outcome, unchanged)
    if registered:
        stage, outcome = _teardown_launchd_job()
        if outcome != "ok":
            return _report_launchd_failure(stage, outcome, "The existing agent file was kept unchanged.")

    try:
        os.makedirs(log_dir, exist_ok=True)
        os.makedirs(os.path.dirname(plist_path), exist_ok=True)
        with open(plist_path, "wb") as f:
            f.write(render_launchd_plist(binary_args, log_dir))
    except OSError:
        print("Error: could not write the launchd agent file.", file=sys.stderr)
        return 1

    logger.info("Installed launchd agent")
    print(f"Auto-start installed: {plist_path}")
    kept = "The agent file was kept; retry --install-autostart or run --remove-autostart."

    domain = _launchd_service_target().rsplit("/", 1)[0]
    outcome = _launchctl("bootstrap", domain, plist_path)
    if outcome != "ok":
        return _report_launchd_failure("register", outcome, kept)
    outcome = _launchctl("kickstart", _launchd_service_target())
    if outcome != "ok":
        return _report_launchd_failure("start", outcome, kept)
    stage, outcome = _verify_launchd_child_running()
    if outcome != "ok":
        return _report_launchd_failure(stage, outcome, kept)

    print(
        "launchd started the bridge process; it will also start at login. "
        "This confirms the process start only, not CalDAV/CardDAV sync."
    )
    print(f"Check status: launchctl print {_launchd_service_target()}")
    print(f"Logs: {log_dir}/")
    return 0


def remove_autostart_macos() -> int:
    """Remove the launchd agent. The persisted network profile is retained.

    If the job's state cannot be read or its bootout is not confirmed, the
    plist is kept so the command can be retried; a non-zero return never
    claims the agent was removed. A plist without a registered job (for
    example after a failed install) is simply deleted.
    """
    plist_path = _launchd_plist_path()

    if not os.path.exists(plist_path):
        print("Auto-start was not installed.")
        print(_PROFILE_RETAINED_NOTE)
        return 0

    outcome, registered, _ = _query_launchd_job()
    stage = "query"
    if outcome == "ok" and registered:
        stage, outcome = _teardown_launchd_job()
    if outcome != "ok":
        logger.warning("launchd %s stage failed (%s)", stage, outcome)
        print(
            f"Auto-start was not removed: {_launchd_failure_text(stage, outcome)}, so the agent file "
            "was kept and the bridge may still be running. Retry after checking "
            f"`launchctl print {_launchd_service_target()}`.",
            file=sys.stderr,
        )
        return 1
    try:
        os.remove(plist_path)
    except OSError:
        print("Error: could not remove the launchd agent file.", file=sys.stderr)
        return 1
    logger.info("Removed launchd agent")
    print("Auto-start removed.")
    print(_PROFILE_RETAINED_NOTE)
    return 0


# --- Windows (Registry) ---


def _windows_registry_key():
    return r"Software\Microsoft\Windows\CurrentVersion\Run"


def render_windows_command(binary_args) -> str:
    """Quote the Run value with Windows command-line rules (paths with spaces)."""
    return subprocess.list2cmdline(list(binary_args))


def install_autostart_windows() -> int:
    """Install Windows startup registry entry."""
    try:
        import winreg
    except ImportError:
        print("Error: winreg not available (not on Windows)", file=sys.stderr)
        return 1

    binary_cmd = render_windows_command(_get_binary_path())

    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _windows_registry_key(),
            0,
            winreg.KEY_SET_VALUE,
        )
        try:
            winreg.SetValueEx(key, WINDOWS_RUN_VALUE, 0, winreg.REG_SZ, binary_cmd)
        finally:
            winreg.CloseKey(key)
    except OSError:
        print("Error: could not write the startup registry entry.", file=sys.stderr)
        return 1

    logger.info("Installed Windows startup entry")
    print("Auto-start installed (Windows Registry).")
    print("Bridge will start at your next sign-in.")
    return 0


def remove_autostart_windows() -> int:
    """Remove the Windows Run registry entry. The persisted network profile is retained.

    This only disables future sign-in startup; a bridge process that is
    already running is not stopped (there is no service manager to ask).
    """
    try:
        import winreg
    except ImportError:
        print("Error: winreg not available (not on Windows)", file=sys.stderr)
        return 1

    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _windows_registry_key(),
            0,
            winreg.KEY_SET_VALUE,
        )
        try:
            winreg.DeleteValue(key, WINDOWS_RUN_VALUE)
        finally:
            winreg.CloseKey(key)
        logger.info("Removed Windows startup entry")
        print("Auto-start removed: the bridge will no longer start at sign-in.")
        print("A bridge process that is currently running was not stopped.")
    except FileNotFoundError:
        print("Auto-start was not installed.")
    except OSError:
        print("Error: could not remove the startup registry entry.", file=sys.stderr)
        return 1
    print(_PROFILE_RETAINED_NOTE)
    return 0


# --- Public API ---


def install_autostart() -> int:
    """Install auto-start for the current platform; return a process exit code.

    The explicit network profile is validated and persisted first, so an
    auto-start entry never exists without the profile it depends on. A
    non-zero return means either nothing was changed (validation/settings
    failure) or the entry exists but the service manager did not confirm it.
    """
    platform = config.get_platform()
    if platform not in ("linux", "macos", "windows"):
        print(f"Auto-start not supported on platform: {platform}")
        return 1

    status = persist_network_profile(platform)
    if status != 0:
        return status

    if platform == "linux":
        return install_autostart_linux()
    if platform == "macos":
        return install_autostart_macos()
    return install_autostart_windows()


def remove_autostart() -> int:
    """Remove auto-start for the current platform; return a process exit code.

    Never starts a listener or writes settings, so it is safe to run with an
    invalid persisted profile. Linux/macOS return non-zero when the service
    manager did not confirm stop/unload (the entry is kept for a retry);
    Windows only removes the sign-in entry and never stops a running bridge.
    """
    platform = config.get_platform()
    if platform == "linux":
        return remove_autostart_linux()
    if platform == "macos":
        return remove_autostart_macos()
    if platform == "windows":
        return remove_autostart_windows()
    print(f"Auto-start not supported on platform: {platform}")
    return 1
