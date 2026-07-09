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

# --- SSL ---
_TRUTHY = {"1", "true", "yes", "on"}
_FALSEY = {"0", "false", "no", "off"}


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    return _bool_value(value, default) if value is not None else default


def _bool_value(value, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in _TRUTHY:
        return True
    if normalized in _FALSEY:
        return False
    return default


SSL_ENABLED = _env_bool("SILENTSUITE_BRIDGE_SSL", False) or _env_bool("SILENTSUITE_SSL", False)
SSL_CERT_FILE = os.environ.get(
    "SILENTSUITE_BRIDGE_SSL_CERT", os.environ.get("SILENTSUITE_SSL_CERT", "")
)
SSL_KEY_FILE = os.environ.get(
    "SILENTSUITE_BRIDGE_SSL_KEY", os.environ.get("SILENTSUITE_SSL_KEY", "")
)

# --- Data directories ---
APP_NAME = "silentsuite-bridge"
APP_AUTHOR = "silentsuite"

DATA_DIR = os.environ.get(
    "SILENTSUITE_DATA_DIR",
    user_data_dir(APP_NAME, APP_AUTHOR),
)

# Default SSL cert/key live inside the data directory so launchd autostart
# works without shell environment exports.
if not SSL_CERT_FILE:
    SSL_CERT_FILE = os.path.join(DATA_DIR, "localhost-cert.pem")
if not SSL_KEY_FILE:
    SSL_KEY_FILE = os.path.join(DATA_DIR, "localhost-key.pem")

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


def dav_scheme() -> str:
    """Return the DAV URL scheme for the current bridge config."""
    return "https" if SSL_ENABLED else "http"


def local_base_url(host: str | None = None) -> str:
    """Build scheme://host:port for dashboard/DAV URLs.

    Defaults to the configured LISTEN_ADDRESS/LISTEN_PORT. IPv6 literals are
    bracketed to keep URLs well-formed.
    """
    if host is None:
        host = LISTEN_ADDRESS
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"{dav_scheme()}://{host}:{LISTEN_PORT}"


def validate_ssl_config() -> None:
    """Fail closed with actionable text when SSL is enabled but cert/key are unusable.

    Called from the main() RuntimeError guard so missing material produces a
    clean exit rather than a Radicale traceback.
    """
    if not SSL_ENABLED:
        return
    if not os.path.isfile(SSL_CERT_FILE) or not _readable(SSL_CERT_FILE):
        raise RuntimeError(
            f"Bridge SSL is enabled but the certificate file is missing or unreadable: "
            f"{SSL_CERT_FILE}. Run `silentsuite-bridge --setup-macos-apple-accounts` "
            f"to generate a localhost certificate, or set SILENTSUITE_BRIDGE_SSL_CERT."
        )
    if not os.path.isfile(SSL_KEY_FILE) or not _readable(SSL_KEY_FILE):
        raise RuntimeError(
            f"Bridge SSL is enabled but the key file is missing or unreadable: "
            f"{SSL_KEY_FILE}. Run `silentsuite-bridge --setup-macos-apple-accounts` "
            f"to generate a localhost key, or set SILENTSUITE_BRIDGE_SSL_KEY."
        )


def _readable(path: str) -> bool:
    try:
        with open(path, "rb"):
            return True
    except OSError:
        return False


def load_settings():
    """Load settings from settings.json, applying overrides to module globals.

    Environment variables take precedence over settings file values where both
    are present, matching the env-override pattern used elsewhere in the bridge.
    """
    global SYNC_INTERVAL, SSL_ENABLED, SSL_CERT_FILE, SSL_KEY_FILE
    try:
        with open(SETTINGS_FILE, "r") as f:
            settings = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        settings = {}
    try:
        if "syncInterval" in settings:
            SYNC_INTERVAL = int(settings["syncInterval"])
    except ValueError:
        pass
    # Environment variables override settings even if tests/processes set them
    # after the module was imported.
    env_ssl = os.environ.get("SILENTSUITE_BRIDGE_SSL")
    legacy_env_ssl = os.environ.get("SILENTSUITE_SSL")
    if env_ssl is not None or legacy_env_ssl is not None:
        SSL_ENABLED = _bool_value(env_ssl, False) or _bool_value(legacy_env_ssl, False)
    elif "sslEnabled" in settings:
        SSL_ENABLED = _bool_value(settings["sslEnabled"], False)

    env_cert = os.environ.get("SILENTSUITE_BRIDGE_SSL_CERT") or os.environ.get("SILENTSUITE_SSL_CERT")
    env_key = os.environ.get("SILENTSUITE_BRIDGE_SSL_KEY") or os.environ.get("SILENTSUITE_SSL_KEY")
    if env_cert:
        SSL_CERT_FILE = env_cert
    elif "sslCertFile" in settings:
        SSL_CERT_FILE = str(settings["sslCertFile"])
    if env_key:
        SSL_KEY_FILE = env_key
    elif "sslKeyFile" in settings:
        SSL_KEY_FILE = str(settings["sslKeyFile"])


def save_settings(settings):
    """Save settings dict to settings.json, preserving caller-supplied keys."""
    ensure_data_dir()
    existing = get_settings()
    existing.update(settings)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(existing, f, indent=2)


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
