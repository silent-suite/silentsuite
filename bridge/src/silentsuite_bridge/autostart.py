"""Auto-start configuration for SilentSuite Bridge.

Installs/removes auto-start entries so the bridge starts
when the system boots:
- Linux: systemd user service
- macOS: launchd agent
- Windows: startup registry entry

Usage:
    silentsuite-bridge --install-autostart
    silentsuite-bridge --remove-autostart
"""

import logging
import os
import shutil
import sys

from . import config

logger = logging.getLogger("silentsuite-bridge.autostart")


def _get_binary_path():
    """Get the path to the silentsuite-bridge executable."""
    # If running from a PyInstaller bundle
    if getattr(sys, "frozen", False):
        return sys.executable

    # If running from installed package, find the console script
    bridge_path = shutil.which("silentsuite-bridge")
    if bridge_path:
        return bridge_path

    # Fallback: use python -m
    return f"{sys.executable} -m silentsuite_bridge"


# --- Linux (systemd) ---

SYSTEMD_SERVICE = """[Unit]
Description=SilentSuite Bridge — E2EE CalDAV/CardDAV Sync
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={binary_path}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
"""


def _systemd_service_path():
    return os.path.expanduser("~/.config/systemd/user/silentsuite-bridge.service")


def install_autostart_linux():
    """Install systemd user service for auto-start."""
    binary = _get_binary_path()
    service_path = _systemd_service_path()
    service_dir = os.path.dirname(service_path)

    os.makedirs(service_dir, exist_ok=True)

    content = SYSTEMD_SERVICE.format(binary_path=binary)
    with open(service_path, "w") as f:
        f.write(content)

    logger.info("Installed systemd service: %s", service_path)

    # Enable and start the service
    os.system("systemctl --user daemon-reload")
    os.system("systemctl --user enable silentsuite-bridge.service")
    os.system("systemctl --user start silentsuite-bridge.service")

    print(f"Auto-start installed: {service_path}")
    print("Service enabled and started.")
    print("Check status: systemctl --user status silentsuite-bridge")


def remove_autostart_linux():
    """Remove systemd user service."""
    service_path = _systemd_service_path()

    os.system("systemctl --user stop silentsuite-bridge.service")
    os.system("systemctl --user disable silentsuite-bridge.service")

    if os.path.exists(service_path):
        os.remove(service_path)
        os.system("systemctl --user daemon-reload")
        logger.info("Removed systemd service: %s", service_path)
        print("Auto-start removed.")
    else:
        print("Auto-start was not installed.")


# --- macOS (launchd) ---

LAUNCHD_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.silentsuite.bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>{binary_path}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>NetworkState</key>
        <true/>
    </dict>
    <key>StandardOutPath</key>
    <string>{log_dir}/bridge.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/bridge.error.log</string>
</dict>
</plist>
"""


def _launchd_plist_path():
    return os.path.expanduser("~/Library/LaunchAgents/io.silentsuite.bridge.plist")


def install_autostart_macos():
    """Install launchd agent for auto-start."""
    binary = _get_binary_path()
    plist_path = _launchd_plist_path()
    log_dir = os.path.expanduser("~/Library/Logs/SilentSuiteBridge")
    os.makedirs(log_dir, exist_ok=True)

    content = LAUNCHD_PLIST.format(binary_path=binary, log_dir=log_dir)
    with open(plist_path, "w") as f:
        f.write(content)

    logger.info("Installed launchd agent: %s", plist_path)

    os.system(f"launchctl load {plist_path}")

    print(f"Auto-start installed: {plist_path}")
    print("Agent loaded. Bridge will start on login.")
    print(f"Logs: {log_dir}/")


def remove_autostart_macos():
    """Remove launchd agent."""
    plist_path = _launchd_plist_path()

    if os.path.exists(plist_path):
        os.system(f"launchctl unload {plist_path}")
        os.remove(plist_path)
        logger.info("Removed launchd agent: %s", plist_path)
        print("Auto-start removed.")
    else:
        print("Auto-start was not installed.")


# --- Windows (Registry) ---


def _windows_registry_key():
    return r"Software\Microsoft\Windows\CurrentVersion\Run"


def install_autostart_windows():
    """Install Windows startup registry entry."""
    try:
        import winreg
    except ImportError:
        print("Error: winreg not available (not on Windows)")
        return

    binary = _get_binary_path()

    key = winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        _windows_registry_key(),
        0,
        winreg.KEY_SET_VALUE,
    )
    winreg.SetValueEx(key, "SilentSuiteBridge", 0, winreg.REG_SZ, binary)
    winreg.CloseKey(key)

    logger.info("Installed Windows startup entry")
    print("Auto-start installed (Windows Registry).")
    print("Bridge will start on login.")


def remove_autostart_windows():
    """Remove Windows startup registry entry."""
    try:
        import winreg
    except ImportError:
        print("Error: winreg not available (not on Windows)")
        return

    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            _windows_registry_key(),
            0,
            winreg.KEY_SET_VALUE,
        )
        winreg.DeleteValue(key, "SilentSuiteBridge")
        winreg.CloseKey(key)
        logger.info("Removed Windows startup entry")
        print("Auto-start removed.")
    except FileNotFoundError:
        print("Auto-start was not installed.")


# --- Public API ---


def install_autostart():
    """Install auto-start for the current platform."""
    platform = config.get_platform()
    if platform == "linux":
        install_autostart_linux()
    elif platform == "macos":
        install_autostart_macos()
    elif platform == "windows":
        install_autostart_windows()
    else:
        print(f"Auto-start not supported on platform: {platform}")


def remove_autostart():
    """Remove auto-start for the current platform."""
    platform = config.get_platform()
    if platform == "linux":
        remove_autostart_linux()
    elif platform == "macos":
        remove_autostart_macos()
    elif platform == "windows":
        remove_autostart_windows()
    else:
        print(f"Auto-start not supported on platform: {platform}")
