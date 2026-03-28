"""SilentSuite Bridge — Main entry point.

Starts the bridge daemon: Radicale CalDAV/CardDAV server with
Etebase storage backend, listening on localhost.

Usage:
    python -m silentsuite_bridge
    silentsuite-bridge
"""

import logging
import sys

from . import __version__
from . import config

logger = logging.getLogger("silentsuite-bridge")


def configure_logging():
    """Set up logging for the bridge."""
    log_format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    log_level = getattr(logging, config.LOG_LEVEL.upper(), logging.INFO)

    handlers = [logging.StreamHandler(sys.stderr)]

    if config.LOG_FILE:
        handlers.append(logging.FileHandler(config.LOG_FILE))

    logging.basicConfig(
        level=log_level,
        format=log_format,
        handlers=handlers,
    )


def build_radicale_configuration():
    """Build Radicale configuration for the bridge.

    Uses SilentSuite's custom storage and auth backends,
    configured to listen on localhost only.
    """
    from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

    configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
    configuration.update(
        {
            "server": {
                "hosts": config.SERVER_HOSTS,
            },
            "auth": {
                "type": "silentsuite_bridge.radicale.auth",
            },
            "storage": {
                "type": "silentsuite_bridge.radicale.storage",
            },
            "web": {
                "type": "silentsuite_bridge.web",
            },
            "logging": {
                "level": config.LOG_LEVEL.lower(),
            },
        },
        source="silentsuite-bridge",
        privileged=True,
    )

    return configuration


def check_credentials():
    """Check if any user credentials exist. If not, run browser login."""
    from .radicale.creds import Credentials

    creds = Credentials()
    users = creds.list_users()

    if not users:
        logger.info("No users configured — starting browser login...")
        print("\nNo account configured yet. Opening browser to sign in...\n")

        from .auth_browser import browser_login

        email = browser_login()
        if not email:
            logger.error("Login cancelled or failed.")
            return False

        # Re-check after login
        creds = Credentials()
        users = creds.list_users()
        if not users:
            return False

    logger.info("Found %d configured user(s): %s", len(users), ", ".join(users))
    return True


def start_tray():
    """Start the system tray icon if available."""
    try:
        from .tray import BridgeTray, TRAY_AVAILABLE

        if not TRAY_AVAILABLE:
            logger.info("System tray not available (pystray/Pillow not installed)")
            return None

        tray = BridgeTray(bridge_state="starting")
        tray.run_detached()
        return tray
    except Exception as e:
        logger.warning("Failed to start system tray: %s", e)
        return None


def _start_sync_threads():
    """Start a SyncThread for each configured user at boot."""
    from .radicale.creds import Credentials
    from .radicale.storage import start_sync_thread

    creds = Credentials()
    users = creds.list_users()
    for user in users:
        start_sync_thread(user)


def _initial_status_check():
    """Run an initial Etebase sync and update dashboard status at startup."""
    from .radicale.creds import Credentials
    from .radicale.etesync_cache import etesync_for_user
    from .web import log_sync_event, update_status

    creds = Credentials()
    users = creds.list_users()
    if not users:
        return

    user = users[0]
    try:
        with etesync_for_user(user) as (etesync, _):
            etesync.sync()
            collections = {"calendars": 0, "contacts": 0, "tasks": 0}
            for col in etesync.list():
                if col.col_type == "etebase.vevent":
                    collections["calendars"] += 1
                elif col.col_type == "etebase.vcard":
                    collections["contacts"] += 1
                elif col.col_type == "etebase.vtodo":
                    collections["tasks"] += 1
            update_status("connected", collections=collections)
            log_sync_event("info", f"Initial sync complete for {user}")
            logger.info(
                "Initial sync: %d calendars, %d contacts, %d tasks",
                collections["calendars"],
                collections["contacts"],
                collections["tasks"],
            )
    except Exception as e:
        logger.warning("Initial status check failed: %s", e)
        update_status("error", error=str(e))
        log_sync_event("error", f"Initial sync failed: {e}")


def run_server():
    """Start the Radicale server with SilentSuite backends."""
    from radicale.server import serve

    configuration = build_radicale_configuration()

    logger.info(
        "SilentSuite Bridge v%s starting on %s",
        __version__,
        config.SERVER_HOSTS,
    )
    logger.info("Etebase server: %s", config.ETEBASE_SERVER_URL)
    logger.info("Data directory: %s", config.DATA_DIR)
    logger.info(
        "CalDAV/CardDAV URL: http://%s:%d/<username>/",
        config.LISTEN_ADDRESS,
        config.LISTEN_PORT,
    )

    # Run initial sync so dashboard shows correct status immediately
    _initial_status_check()

    # Start periodic SyncThread for all configured users
    _start_sync_threads()

    # Start system tray (non-blocking)
    tray = None
    if "--no-tray" not in sys.argv:
        tray = start_tray()

    try:
        serve(configuration)
    except KeyboardInterrupt:
        logger.info("Bridge stopped by user")
    except Exception:
        logger.exception("Bridge crashed")
        if tray:
            tray.update_state("error", "Bridge crashed")
        sys.exit(1)


def main():
    """Main entry point for the bridge CLI."""
    # Handle --version and --help before any side effects
    if "--version" in sys.argv:
        print(f"SilentSuite Bridge v{__version__}")
        sys.exit(0)

    if "--help" in sys.argv or "-h" in sys.argv:
        print(f"SilentSuite Bridge v{__version__}")
        print("E2EE CalDAV/CardDAV sync daemon\n")
        print("Usage: silentsuite-bridge [OPTIONS]\n")
        print("Options:")
        print("  --help, -h            Show this help message and exit")
        print("  --version             Show version and exit")
        print("  --login               Run browser-based login flow")
        print("  --server URL          Etebase server URL (for self-hosters)")
        print("  --manual-login        Run CLI login (for development/testing)")
        print("  --install-autostart   Install auto-start for current platform")
        print("  --remove-autostart    Remove auto-start for current platform")
        print("  --no-tray             Start without system tray icon")
        print()
        print("Environment variables:")
        print("  SILENTSUITE_SERVER_URL       Etebase server URL")
        print("  SILENTSUITE_LISTEN_ADDRESS   Listen address (default: 127.0.0.1)")
        print("  SILENTSUITE_LISTEN_PORT      Listen port (default: 37358)")
        print("  SILENTSUITE_DATA_DIR         Data directory path")
        print("  SILENTSUITE_LOG_LEVEL        Log level (default: INFO)")
        print("  SILENTSUITE_LOG_FILE         Log file path")
        print("  SILENTSUITE_SYNC_INTERVAL    Sync interval in seconds (default: 900)")
        sys.exit(0)

    # Handle --server before anything that uses config.ETEBASE_SERVER_URL
    if "--server" in sys.argv:
        idx = sys.argv.index("--server")
        if idx + 1 < len(sys.argv):
            config.ETEBASE_SERVER_URL = sys.argv[idx + 1]
        else:
            print("Error: --server requires a URL argument")
            sys.exit(1)

    configure_logging()
    config.ensure_data_dir()

    # Handle --login (browser-based auth)
    if "--login" in sys.argv:
        from .auth_browser import browser_login

        email = browser_login()
        sys.exit(0 if email else 1)

    # Handle --manual-login (temporary CLI auth for development/testing)
    if "--manual-login" in sys.argv:
        from .auth_cli import manual_login

        manual_login()
        sys.exit(0)

    # Handle --install-autostart
    if "--install-autostart" in sys.argv:
        from .autostart import install_autostart

        install_autostart()
        sys.exit(0)

    # Handle --remove-autostart
    if "--remove-autostart" in sys.argv:
        from .autostart import remove_autostart

        remove_autostart()
        sys.exit(0)

    # Check credentials exist
    if not check_credentials():
        sys.exit(1)

    # Start the server
    run_server()


if __name__ == "__main__":
    main()
