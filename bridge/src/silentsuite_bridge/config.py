"""SilentSuite Bridge configuration.

Platform-appropriate paths for data storage and credentials.
All defaults point to server.silentsuite.io.
"""

import json
import os
import sys

from appdirs import user_data_dir

# --- Server ---
ETEBASE_SERVER_URL = os.environ.get(
    "SILENTSUITE_SERVER_URL",
    "https://server.silentsuite.io",
)

# --- Network ---
LISTEN_ADDRESS = os.environ.get("SILENTSUITE_LISTEN_ADDRESS", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("SILENTSUITE_LISTEN_PORT", "37358"))
SERVER_HOSTS = os.environ.get(
    "SILENTSUITE_SERVER_HOSTS",
    f"{LISTEN_ADDRESS}:{LISTEN_PORT}",
)

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


def ensure_data_dir():
    """Create the data directory if it doesn't exist."""
    if not os.path.exists(DATA_DIR):
        os.makedirs(DATA_DIR, mode=0o700)


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
