"""SilentSuite Bridge configuration.

Platform-appropriate paths for data storage and credentials.
All defaults point to server.silentsuite.io.
"""

import json
import os
import sys
from ipaddress import ip_address

from appdirs import user_data_dir

# --- Server ---
ETEBASE_SERVER_URL = os.environ.get(
    "SILENTSUITE_SERVER_URL",
    "https://server.silentsuite.io",
)

# --- Network ---
LISTEN_ADDRESS = os.environ.get("SILENTSUITE_LISTEN_ADDRESS", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("SILENTSUITE_LISTEN_PORT", "37358"))


def _format_host_port(host: str, port: int) -> str:
    """Format host:port for Radicale, bracketing IPv6 literals."""
    return f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"


DEFAULT_SERVER_HOSTS = _format_host_port(LISTEN_ADDRESS, LISTEN_PORT)
SERVER_HOSTS = os.environ.get(
    "SILENTSUITE_SERVER_HOSTS",
    DEFAULT_SERVER_HOSTS,
)
ALLOW_REMOTE = os.environ.get("SILENTSUITE_ALLOW_REMOTE", "").lower() in {"1", "true", "yes", "on"}

# --- Data directories ---
APP_NAME = "silentsuite-bridge"
APP_AUTHOR = "silentsuite"

DATA_DIR = os.environ.get(
    "SILENTSUITE_DATA_DIR",
    user_data_dir(APP_NAME, APP_AUTHOR),
)

# --- Database ---
DATABASE_FILE = os.environ.get(
    "SILENTSUITE_DATABASE_FILE",
    os.path.join(DATA_DIR, "bridge_data.db"),
)

# --- Credentials ---
CREDS_FILE = os.path.join(DATA_DIR, "credentials.json")
HTPASSWD_FILE = os.path.join(DATA_DIR, "htpasswd")

# --- Sync ---
_DEFAULT_SYNC_INTERVAL = int(os.environ.get("SILENTSUITE_SYNC_INTERVAL", str(15 * 60)))  # 15 minutes
SYNC_INTERVAL = _DEFAULT_SYNC_INTERVAL
SYNC_MINIMUM = int(os.environ.get("SILENTSUITE_SYNC_MINIMUM", "30"))  # 30 seconds

# --- Settings file ---
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

# --- Collection types ---
# These must match the Etebase collection types used by SilentSuite
COL_TYPES = [
    "etebase.vevent",   # Calendars
    "etebase.vtodo",    # Tasks
    "etebase.vcard",    # Contacts
]

# --- Logging ---
LOG_LEVEL = os.environ.get("SILENTSUITE_LOG_LEVEL", "INFO")
LOG_FILE = os.environ.get("SILENTSUITE_LOG_FILE", None)

# --- Dashboard diagnostics ---
DASHBOARD_DUMP_ENABLED = os.environ.get("SILENTSUITE_DASHBOARD_DUMP", "").lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def ensure_data_dir():
    """Create the data directory if it doesn't exist."""
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, mode=0o700)


def _extract_host(host_spec: str) -> str:
    """Extract the host part from a Radicale server host specification."""
    value = host_spec.strip()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end != -1 else value[1:]
    if value.count(":") == 1:
        return value.rsplit(":", 1)[0]
    if ":" in value:
        host, port = value.rsplit(":", 1)
        if port.isdigit():
            try:
                ip_address(host)
                return host
            except ValueError:
                pass
    return value


def is_loopback_host(host: str) -> bool:
    """Return true only for localhost or numeric loopback addresses."""
    normalized = host.strip().lower()
    if normalized == "localhost":
        return True
    if normalized in {"", "*"}:
        return False
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


def remote_bind_reasons() -> list[str]:
    """Describe configured bind values that would expose the bridge remotely."""
    reasons: list[str] = []
    if not is_loopback_host(LISTEN_ADDRESS):
        reasons.append(f"SILENTSUITE_LISTEN_ADDRESS={LISTEN_ADDRESS}")

    for host_spec in SERVER_HOSTS.split(","):
        host_spec = host_spec.strip()
        if not host_spec:
            continue
        host = _extract_host(host_spec)
        if not is_loopback_host(host):
            reasons.append(f"SILENTSUITE_SERVER_HOSTS includes {host_spec}")

    return reasons


def is_remote_bind_configured() -> bool:
    return bool(remote_bind_reasons())


def is_dashboard_enabled() -> bool:
    """The dashboard is unauthenticated today, so disable it on remote binds."""
    return not is_remote_bind_configured()


def validate_network_config() -> None:
    """Fail closed before exposing plaintext DAV/dashboard surfaces remotely."""
    reasons = remote_bind_reasons()
    if reasons and not ALLOW_REMOTE:
        joined = "; ".join(reasons)
        raise RuntimeError(
            "SilentSuite Bridge refuses non-loopback bind without SILENTSUITE_ALLOW_REMOTE=1. "
            f"Remote bind setting(s): {joined}. The bridge exposes decrypted DAV data over HTTP."
        )


def load_settings():
    """Load settings from settings.json, applying overrides to module globals."""
    global SYNC_INTERVAL
    try:
        with open(SETTINGS_FILE, "r") as f:
            settings = json.load(f)
        if "syncInterval" in settings:
            SYNC_INTERVAL = int(settings["syncInterval"])
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass


def save_settings(settings):
    """Save settings dict to settings.json."""
    ensure_data_dir()
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


def get_settings():
    """Read current settings from settings.json."""
    try:
        with open(SETTINGS_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def get_platform() -> str:
    """Return normalized platform name."""
    if sys.platform == "darwin":
        return "macos"
    elif sys.platform == "win32":
        return "windows"
    else:
        return "linux"


# Load settings on import to apply overrides
load_settings()
