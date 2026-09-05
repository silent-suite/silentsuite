"""SilentSuite Bridge configuration.

Platform-appropriate paths for data storage and credentials.
All defaults point to server.silentsuite.io.
"""

import json
import os
import re
import sys
from ipaddress import ip_address

from appdirs import user_data_dir

# --- Server ---
ETEBASE_SERVER_URL = os.environ.get(
    "SILENTSUITE_SERVER_URL",
    "https://server.silentsuite.io",
)

# --- Boolean parsing ---
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


# --- Network ---
#
# The listener profile is resolved from three layers, highest precedence first:
#   1. environment variables (SILENTSUITE_LISTEN_ADDRESS, ...),
#   2. the persisted, closed-world ``"network"`` object in settings.json,
#   3. built-in loopback defaults.
# Autostart entries (systemd/launchd/registry) run with a clean environment,
# so ``--install-autostart`` persists explicitly configured values into layer 2.
# Layer 2 is validated strictly and fails closed; nothing outside the four keys
# below is ever read from or written to it.

NETWORK_PROFILE_KEY = "network"
NETWORK_PROFILE_ENV = {
    "listenAddress": "SILENTSUITE_LISTEN_ADDRESS",
    "listenPort": "SILENTSUITE_LISTEN_PORT",
    "serverHosts": "SILENTSUITE_SERVER_HOSTS",
    "allowRemote": "SILENTSUITE_ALLOW_REMOTE",
}
DEFAULT_LISTEN_ADDRESS = "127.0.0.1"
DEFAULT_LISTEN_PORT = 37358

_HOSTNAME_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
_PORT_RULE = "must be an integer from 1 to 65535"


class NetworkConfigError(RuntimeError):
    """A network configuration refusal whose text names settings and rules, never supplied values."""


class NetworkProfileError(NetworkConfigError):
    """An invalid network profile. Messages name keys and rules, never supplied values."""


def _format_host_port(host: str, port: int) -> str:
    """Format host:port for Radicale, bracketing IPv6 literals."""
    return f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"


def _is_valid_host(host: str) -> bool:
    """Accept an IP literal or an RFC 1123 hostname; reject everything else."""
    if not host or len(host) > 253 or any(ch.isspace() for ch in host):
        return False
    try:
        ip_address(host)
        return True
    except ValueError:
        pass
    labels = host[:-1].split(".") if host.endswith(".") else host.split(".")
    return all(_HOSTNAME_LABEL.match(label) for label in labels)


def _validate_port(value, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise NetworkProfileError(f"{label} {_PORT_RULE}")
    return value


def _parse_env_port(raw: str, label: str = "SILENTSUITE_LISTEN_PORT") -> int:
    text = raw.strip()
    if not text.isascii() or not text.isdigit():
        raise NetworkProfileError(f"{label} {_PORT_RULE}")
    return _validate_port(int(text), label)


def _split_host_spec(spec: str, label: str) -> tuple[str, int]:
    """Split one Radicale host spec strictly: host:port, [ipv6]:port, or ipv6:port."""
    if spec.startswith("["):
        end = spec.find("]")
        if end == -1 or spec[end + 1 : end + 2] != ":":
            raise NetworkProfileError(f"{label} contains a malformed bracketed IPv6 entry")
        host, port_text = spec[1:end], spec[end + 2 :]
    else:
        host, separator, port_text = spec.rpartition(":")
        if not separator:
            raise NetworkProfileError(f"{label} entries must include a port")
    if not port_text.isascii() or not port_text.isdigit():
        raise NetworkProfileError(f"{label} entries {_PORT_RULE}")
    if not _is_valid_host(host):
        raise NetworkProfileError(f"{label} entries must use an IP literal or hostname")
    return host, _validate_port(int(port_text), f"{label} entries")


def _validate_host_specs(value, label: str) -> str:
    if not isinstance(value, str):
        raise NetworkProfileError(f"{label} must be a string of comma-separated host:port entries")
    specs = [spec.strip() for spec in value.split(",")]
    if any(not spec for spec in specs):
        raise NetworkProfileError(f"{label} must be a non-empty list of host:port entries")
    for spec in specs:
        _split_host_spec(spec, label)
    return ",".join(specs)


def validate_network_profile(profile, source: str = "settings") -> dict:
    """Return a normalized copy of a closed-world network profile or fail closed.

    ``source`` selects the labels used in error text: ``"settings"`` names JSON
    keys, ``"environment"`` names the environment variables. Supplied values are
    never echoed.
    """
    if not isinstance(profile, dict):
        raise NetworkProfileError("network profile must be a JSON object")
    unknown = [key for key in profile if key not in NETWORK_PROFILE_ENV]
    if unknown:
        raise NetworkProfileError(f"network profile contains {len(unknown)} unsupported key(s)")

    def label(key: str) -> str:
        return NETWORK_PROFILE_ENV[key] if source == "environment" else key

    normalized: dict = {}
    if "listenAddress" in profile:
        value = profile["listenAddress"]
        if not isinstance(value, str) or not _is_valid_host(value.strip()):
            raise NetworkProfileError(f"{label('listenAddress')} must be an IP literal or hostname")
        normalized["listenAddress"] = value.strip()
    if "listenPort" in profile:
        normalized["listenPort"] = _validate_port(profile["listenPort"], label("listenPort"))
    if "serverHosts" in profile:
        normalized["serverHosts"] = _validate_host_specs(profile["serverHosts"], label("serverHosts"))
    if "allowRemote" in profile:
        if not isinstance(profile["allowRemote"], bool):
            raise NetworkProfileError(f"{label('allowRemote')} must be true or false")
        normalized["allowRemote"] = profile["allowRemote"]
    return normalized


def explicit_network_profile_from_env(environ=None) -> dict:
    """Return only the network values explicitly present in the environment.

    This is the closed allowlist of what ``--install-autostart`` may persist.
    Unset variables are absent (never defaulted); present ones are validated
    strictly so a malformed value fails before anything is written.
    """
    environ = os.environ if environ is None else environ
    profile: dict = {}
    for key, variable in NETWORK_PROFILE_ENV.items():
        if variable not in environ:
            continue
        raw = environ[variable]
        if key == "listenPort":
            profile[key] = _parse_env_port(raw, variable)
        elif key == "allowRemote":
            normalized = raw.strip().lower()
            if normalized in _TRUTHY:
                profile[key] = True
            elif normalized in _FALSEY or normalized == "":
                profile[key] = False
            else:
                raise NetworkProfileError(f"{variable} must be true or false")
        else:
            profile[key] = raw
    return validate_network_profile(profile, source="environment")


LISTEN_ADDRESS = DEFAULT_LISTEN_ADDRESS
LISTEN_PORT = DEFAULT_LISTEN_PORT
DEFAULT_SERVER_HOSTS = _format_host_port(LISTEN_ADDRESS, LISTEN_PORT)
SERVER_HOSTS = DEFAULT_SERVER_HOSTS
ALLOW_REMOTE = False
# Bounded, value-free description of why the effective network profile is
# unusable. Checked by validate_network_config() so startup fails closed.
NETWORK_PROFILE_ERROR: str | None = None


def _resolve_network(settings: dict) -> None:
    """Apply env > persisted profile > defaults to the module-level network globals."""
    global LISTEN_ADDRESS, LISTEN_PORT, DEFAULT_SERVER_HOSTS, SERVER_HOSTS, ALLOW_REMOTE
    global NETWORK_PROFILE_ERROR

    errors: list[str] = []
    persisted: dict = {}
    if NETWORK_PROFILE_KEY in settings:
        try:
            persisted = validate_network_profile(settings[NETWORK_PROFILE_KEY])
        except NetworkProfileError as exc:
            errors.append(f"settings.json {exc}")

    env_address = os.environ.get("SILENTSUITE_LISTEN_ADDRESS")
    env_port: int | None = None
    env_port_raw = os.environ.get("SILENTSUITE_LISTEN_PORT")
    if env_port_raw is not None:
        try:
            env_port = _parse_env_port(env_port_raw)
        except NetworkProfileError as exc:
            errors.append(str(exc))
    env_hosts = os.environ.get("SILENTSUITE_SERVER_HOSTS")
    env_allow_remote = os.environ.get("SILENTSUITE_ALLOW_REMOTE")

    LISTEN_ADDRESS = env_address if env_address is not None else persisted.get("listenAddress", DEFAULT_LISTEN_ADDRESS)
    LISTEN_PORT = env_port if env_port is not None else persisted.get("listenPort", DEFAULT_LISTEN_PORT)
    DEFAULT_SERVER_HOSTS = _format_host_port(LISTEN_ADDRESS, LISTEN_PORT)
    SERVER_HOSTS = env_hosts if env_hosts is not None else persisted.get("serverHosts", DEFAULT_SERVER_HOSTS)
    if env_allow_remote is not None:
        ALLOW_REMOTE = _bool_value(env_allow_remote, False)
    else:
        ALLOW_REMOTE = persisted.get("allowRemote", False)
    NETWORK_PROFILE_ERROR = "; ".join(errors) if errors else None


_resolve_network({})

# --- SSL ---
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
DAV_SYNC_TOKEN_RETENTION = 256
DAV_SYNC_TOKEN_MAX_AGE = 30 * 24 * 60 * 60
DAV_CHANGE_RETENTION = 10_000

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


def _remote_bind_reasons_for(listen_address: str, server_hosts: str) -> list[str]:
    """Describe which bind settings would expose the bridge remotely.

    Reasons name the setting, not its value, so they are safe to print or log.
    """
    reasons: list[str] = []
    if not is_loopback_host(listen_address):
        reasons.append("SILENTSUITE_LISTEN_ADDRESS is not a loopback address")

    for host_spec in server_hosts.split(","):
        host_spec = host_spec.strip()
        if not host_spec:
            continue
        host = _extract_host(host_spec)
        if not is_loopback_host(host):
            reasons.append("SILENTSUITE_SERVER_HOSTS includes a non-loopback host")
            break

    return reasons


def remote_bind_reasons() -> list[str]:
    """Describe effective bind settings that would expose the bridge remotely."""
    return _remote_bind_reasons_for(LISTEN_ADDRESS, SERVER_HOSTS)


def is_remote_bind_configured() -> bool:
    return bool(remote_bind_reasons())


def is_dashboard_enabled() -> bool:
    """The dashboard is unauthenticated today, so disable it on remote binds."""
    return not is_remote_bind_configured()


def _remote_bind_error(reasons: list[str]) -> NetworkConfigError:
    joined = "; ".join(reasons)
    return NetworkConfigError(
        "SilentSuite Bridge refuses non-loopback bind without SILENTSUITE_ALLOW_REMOTE=1. "
        f"Remote bind setting(s): {joined}. The bridge exposes decrypted DAV data over HTTP."
    )


def validate_network_config() -> None:
    """Fail closed before exposing plaintext DAV/dashboard surfaces remotely.

    An invalid persisted profile (or malformed environment port) is rejected
    first so a corrupted settings.json can never widen the bind.
    """
    if NETWORK_PROFILE_ERROR:
        raise NetworkProfileError(f"SilentSuite Bridge network configuration is invalid: {NETWORK_PROFILE_ERROR}")
    reasons = remote_bind_reasons()
    if reasons and not ALLOW_REMOTE:
        raise _remote_bind_error(reasons)


def validate_restart_profile(profile: dict) -> dict:
    """Validate the settings-only view a clean-environment restart will use.

    Autostart processes see no shell environment, so permission for a remote
    bind must itself be persisted. Returns the normalized profile.
    """
    normalized = validate_network_profile(profile)
    address = normalized.get("listenAddress", DEFAULT_LISTEN_ADDRESS)
    port = normalized.get("listenPort", DEFAULT_LISTEN_PORT)
    hosts = normalized.get("serverHosts", _format_host_port(address, port))
    reasons = _remote_bind_reasons_for(address, hosts)
    if reasons and not normalized.get("allowRemote", False):
        raise NetworkProfileError(
            "the persisted network profile would bind remotely on restart without allowRemote permission "
            f"({'; '.join(reasons)})"
        )
    return normalized


def persisted_network_profile(settings: dict | None = None) -> dict:
    """Return the validated persisted profile from settings.json ({} when absent)."""
    if settings is None:
        settings = get_settings()
    if NETWORK_PROFILE_KEY not in settings:
        return {}
    return validate_network_profile(settings[NETWORK_PROFILE_KEY])


def network_profile_for_autostart() -> dict:
    """Compute the profile ``--install-autostart`` may persist, validating before any write.

    Explicit environment values are merged over the existing persisted profile
    (retention on reinstall); nothing is defaulted. Both the effective
    configuration and the resulting restart profile must validate.
    """
    validate_network_config()
    merged = {**persisted_network_profile(), **explicit_network_profile_from_env()}
    return validate_restart_profile(merged)


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
    if not isinstance(settings, dict):
        settings = {}
    try:
        if "syncInterval" in settings:
            SYNC_INTERVAL = int(settings["syncInterval"])
    except ValueError:
        pass
    _resolve_network(settings)
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


def save_network_profile(profile: dict) -> bool:
    """Persist a validated network profile; return whether settings.json was written.

    An empty profile writes nothing so a no-env installation never pins the
    loopback defaults into settings.json. Unrelated settings are preserved.
    """
    normalized = validate_network_profile(profile)
    if not normalized:
        return False
    save_settings({NETWORK_PROFILE_KEY: normalized})
    return True


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
