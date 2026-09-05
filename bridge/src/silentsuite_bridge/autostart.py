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
import shutil
import subprocess
import sys

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


def persist_network_profile() -> int:
    """Validate and persist the explicit network profile before any autostart write.

    Returns 0 on success, 1 when validation or the settings write failed. On
    failure nothing has been changed.
    """
    if "SILENTSUITE_DATA_DIR" in os.environ:
        print(
            "Error: --install-autostart does not support SILENTSUITE_DATA_DIR. Auto-start entries run "
            "with a clean environment and would read the default data directory (different settings, "
            "credentials, and cache) instead of the configured one. Unset SILENTSUITE_DATA_DIR and retry. "
            "Nothing was changed.",
            file=sys.stderr,
        )
        return 1

    try:
        profile = config.network_profile_for_autostart()
    except RuntimeError as exc:
        # NetworkProfileError and the remote-bind refusal name settings and
        # rules only; supplied values are never echoed.
        print(f"Error: {exc}", file=sys.stderr)
        print("Auto-start was not installed and nothing was changed.", file=sys.stderr)
        return 1

    try:
        written = config.save_network_profile(profile)
    except OSError:
        print(
            "Error: could not write the bridge settings file; auto-start was not installed.",
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
    """Run a service-manager command; report and return False on non-zero exit."""
    result = subprocess.run(argv, check=False, capture_output=True)
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
        with open(service_path, "w") as f:
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
    """Remove systemd user service. The persisted network profile is retained."""
    service_path = _systemd_service_path()

    subprocess.run(
        ["systemctl", "--user", "stop", SYSTEMD_UNIT],
        check=False, capture_output=True,
    )
    subprocess.run(
        ["systemctl", "--user", "disable", SYSTEMD_UNIT],
        check=False, capture_output=True,
    )

    if os.path.exists(service_path):
        try:
            os.remove(service_path)
        except OSError:
            print("Error: could not remove the systemd user service file.", file=sys.stderr)
            return 1
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"],
            check=False, capture_output=True,
        )
        logger.info("Removed systemd service")
        print("Auto-start removed.")
    else:
        print("Auto-start was not installed.")
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
        "StandardOutPath": os.path.join(log_dir, "bridge.log"),
        "StandardErrorPath": os.path.join(log_dir, "bridge.error.log"),
    }
    return plistlib.dumps(payload, sort_keys=False)


def install_autostart_macos() -> int:
    """Install launchd agent for auto-start."""
    binary_args = _get_binary_path()
    plist_path = _launchd_plist_path()
    log_dir = _launchd_log_dir()

    try:
        os.makedirs(log_dir, exist_ok=True)
        os.makedirs(os.path.dirname(plist_path), exist_ok=True)
        with open(plist_path, "wb") as f:
            f.write(render_launchd_plist(binary_args, log_dir))
    except OSError:
        print("Error: could not write the launchd agent file.", file=sys.stderr)
        return 1

    logger.info("Installed launchd agent")

    ok = _run_reported(["launchctl", "load", plist_path], "launchctl load")

    print(f"Auto-start installed: {plist_path}")
    if ok:
        print("Agent loaded; launchd will start the bridge now and at login.")
    else:
        print("The agent file is installed, but launchctl load failed; the bridge is not confirmed running.")
    print(f"Verify: launchctl list {LAUNCHD_LABEL}")
    print(f"Logs: {log_dir}/")
    return 0 if ok else 1


def remove_autostart_macos() -> int:
    """Remove launchd agent. The persisted network profile is retained."""
    plist_path = _launchd_plist_path()

    if os.path.exists(plist_path):
        subprocess.run(
            ["launchctl", "unload", plist_path],
            check=False, capture_output=True,
        )
        try:
            os.remove(plist_path)
        except OSError:
            print("Error: could not remove the launchd agent file.", file=sys.stderr)
            return 1
        logger.info("Removed launchd agent")
        print("Auto-start removed.")
    else:
        print("Auto-start was not installed.")
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
    """Remove Windows startup registry entry. The persisted network profile is retained."""
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
        print("Auto-start removed.")
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

    status = persist_network_profile()
    if status != 0:
        return status

    if platform == "linux":
        return install_autostart_linux()
    if platform == "macos":
        return install_autostart_macos()
    return install_autostart_windows()


def remove_autostart() -> int:
    """Remove auto-start for the current platform; return a process exit code."""
    platform = config.get_platform()
    if platform == "linux":
        return remove_autostart_linux()
    if platform == "macos":
        return remove_autostart_macos()
    if platform == "windows":
        return remove_autostart_windows()
    print(f"Auto-start not supported on platform: {platform}")
    return 1
