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
    """Check if any user credentials exist."""
    from .radicale.creds import Credentials

    creds = Credentials()
    users = creds.list_users()

    if not users:
        logger.warning(
            "No users configured. "
            "Please authenticate first via: silentsuite-bridge --manual-login"
        )
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
    configure_logging()
    config.ensure_data_dir()

    # Handle --version
    if "--version" in sys.argv:
        print(f"SilentSuite Bridge v{__version__}")
        sys.exit(0)

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
