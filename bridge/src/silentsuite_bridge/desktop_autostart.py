"""Desktop start-at-login (#171): registration only, for a stable installed app.

The desktop app may register itself to start at sign-in, and only when the
running executable is a frozen build at a stable installed location
(implementation-plan-v2 sections 5-7):

- Windows: under %LOCALAPPDATA%\\Programs, HKCU Run value
  ``SilentSuiteBridgeDesktop``;
- macOS: under /Applications or ~/Applications inside a .app bundle, never
  from /Volumes or an AppTranslocation path, LaunchAgent plist
  ``io.silentsuite.bridge.desktop`` with RunAtLoad and no KeepAlive;
- Linux: under /opt/silentsuite-bridge, XDG autostart entry
  ``silentsuite-bridge-desktop.desktop`` with TryExec.

The command is always the installed executable plus ``--background``.
Turning it on or off only writes or removes that one entry: no service
manager is called, nothing is started or stopped, and the command-line
bridge's own entries (``autostart.py``) are never touched.

A ``DesktopStartAtLogin`` exists only inside a running desktop app, which
hands it to its own server (see ``__main__._serve_radicale_with_bridge_application``).
A headless or command-line bridge never has one, whatever binary it runs from.
"""

import os
import plistlib
import sys
import tempfile

from . import autostart, config

DESKTOP_RUN_VALUE = "SilentSuiteBridgeDesktop"
DESKTOP_LAUNCHD_LABEL = "io.silentsuite.bridge.desktop"
DESKTOP_XDG_ENTRY = "silentsuite-bridge-desktop.desktop"
BACKGROUND_ARG = "--background"
LINUX_INSTALL_ROOT = "/opt/silentsuite-bridge"

# Characters the Desktop Entry Exec rules reserve (quoted argument needed).
_EXEC_RESERVED = set(" \t\n\"'\\><~|&;$*?#()`")


def _within(path, root) -> bool:
    """True if resolved ``path`` lies strictly inside resolved ``root``."""
    path = os.path.normcase(os.path.realpath(path))
    root = os.path.normcase(os.path.realpath(root))
    try:
        return path != root and os.path.commonpath([path, root]) == root
    except ValueError:  # different drives on Windows
        return False


def stable_installed_executable():
    """The running executable if it is a frozen build at a stable install root, else None."""
    if not getattr(sys, "frozen", False):
        return None
    executable = sys.executable
    if not executable or not os.path.isabs(executable) or not os.path.isfile(executable):
        return None
    platform = config.get_platform()
    if platform == "windows":
        base = os.environ.get("LOCALAPPDATA")
        if not base or not os.path.isabs(base):
            return None
        return executable if _within(executable, os.path.join(base, "Programs")) else None
    if not os.access(executable, os.X_OK):
        return None
    resolved = os.path.realpath(executable)
    if platform == "macos":
        if resolved.startswith("/Volumes/") or "/AppTranslocation/" in resolved:
            return None
        if ".app/Contents/MacOS/" not in resolved:
            return None
        roots = ("/Applications", os.path.expanduser("~/Applications"))
        return executable if any(_within(executable, root) for root in roots) else None
    return executable if _within(executable, LINUX_INSTALL_ROOT) else None


# --- entry locations -----------------------------------------------------


def _launchd_plist_path():
    return os.path.expanduser(f"~/Library/LaunchAgents/{DESKTOP_LAUNCHD_LABEL}.plist")


def _xdg_entry_path():
    base = os.environ.get("XDG_CONFIG_HOME")
    if not base or not os.path.isabs(base):
        base = os.path.expanduser("~/.config")
    return os.path.join(base, "autostart", DESKTOP_XDG_ENTRY)


# --- entry content -------------------------------------------------------


def _exec_argument(argument: str) -> str:
    """Quote one Exec argument per the Desktop Entry Exec rules, then string-escape it."""
    if not argument or "\n" in argument or "\r" in argument:
        raise ValueError("unsupported Exec argument")
    argument = argument.replace("%", "%%")
    if any(char in _EXEC_RESERVED for char in argument):
        escaped = "".join("\\" + c if c in '"`$\\' else c for c in argument)
        argument = '"' + escaped + '"'
    return argument.replace("\\", "\\\\")  # the general string escape applies last in the file


def _string_value(value: str) -> str:
    if "\n" in value or "\r" in value:
        raise ValueError("unsupported Desktop Entry value")
    return value.replace("\\", "\\\\").replace("\t", "\\t")


def render_xdg_entry(executable: str) -> str:
    if "=" in executable:
        raise ValueError("the Exec program path may not contain '='")
    command = " ".join(_exec_argument(arg) for arg in (executable, BACKGROUND_ARG))
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=SilentSuite Bridge\n"
        f"Exec={command}\n"
        f"TryExec={_string_value(executable)}\n"
        "Terminal=false\n"
    )


def render_launchd_plist(executable: str) -> bytes:
    payload = {
        "Label": DESKTOP_LAUNCHD_LABEL,
        "ProgramArguments": [executable, BACKGROUND_ARG],
        "RunAtLoad": True,
    }
    return plistlib.dumps(payload, sort_keys=False)


def _write_file_atomically(path: str, data: bytes) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".silentsuite-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o644)  # owner-writable only, like other user login entries
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _remove_file(path: str) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


# --- the runtime-owned capability ----------------------------------------


class DesktopStartAtLogin:
    """Start-at-login control owned by one running desktop app."""

    def __init__(self, executable):
        self._executable = executable  # None unless a stable frozen install

    @classmethod
    def for_running_app(cls):
        return cls(stable_installed_executable())

    @property
    def editable(self) -> bool:
        return self._executable is not None

    def registered(self) -> bool:
        platform = config.get_platform()
        if platform == "windows":
            import winreg

            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, autostart._windows_registry_key(), 0, winreg.KEY_READ)
            except FileNotFoundError:
                return False
            try:
                winreg.QueryValueEx(key, DESKTOP_RUN_VALUE)
                return True
            except FileNotFoundError:
                return False
            finally:
                winreg.CloseKey(key)
        path = _launchd_plist_path() if platform == "macos" else _xdg_entry_path()
        return os.path.lexists(path)

    def state(self) -> dict:
        try:
            value = self.registered()
        except OSError:
            value = False
        return {"value": value, "editable": self.editable}

    def enable(self) -> None:
        """Write this app's entry. Raises OSError/ValueError; caller checks ``editable`` first."""
        if self._executable is None:
            raise PermissionError("not a stable installed desktop app")
        platform = config.get_platform()
        if platform == "windows":
            import winreg

            command = autostart.render_windows_command([self._executable, BACKGROUND_ARG])
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, autostart._windows_registry_key(), 0, winreg.KEY_SET_VALUE)
            try:
                winreg.SetValueEx(key, DESKTOP_RUN_VALUE, 0, winreg.REG_SZ, command)
            finally:
                winreg.CloseKey(key)
            return
        if platform == "macos":
            _write_file_atomically(_launchd_plist_path(), render_launchd_plist(self._executable))
            return
        _write_file_atomically(_xdg_entry_path(), render_xdg_entry(self._executable).encode("utf-8"))

    def disable(self) -> None:
        """Remove only this app's entry; already absent is fine. Allowed off a stable install too."""
        platform = config.get_platform()
        if platform == "windows":
            import winreg

            try:
                key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, autostart._windows_registry_key(), 0, winreg.KEY_SET_VALUE)
            except FileNotFoundError:
                return
            try:
                winreg.DeleteValue(key, DESKTOP_RUN_VALUE)
            except FileNotFoundError:
                pass
            finally:
                winreg.CloseKey(key)
            return
        _remove_file(_launchd_plist_path() if platform == "macos" else _xdg_entry_path())
