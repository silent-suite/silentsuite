"""SilentSuite Bridge — Main entry point.

Starts the bridge daemon: Radicale CalDAV/CardDAV server with
Etebase storage backend, listening on localhost.

Usage:
    python -m silentsuite_bridge
    silentsuite-bridge
"""

import logging
import os
import subprocess
import sys
import tempfile
import threading

from . import __version__, config
from .privacy_logging import log_bounded_failure

logger = logging.getLogger("silentsuite-bridge")

_ACCOUNT_ACTION_FLAGS = (
    "--login",
    "--manual-login",
    "--list-accounts",
    "--logout",
    "--remove-account",
)
_RADICALE_SERVER_APPLICATION_LOCK = threading.Lock()


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

    # Dependency DEBUG records can include SQL parameters, URLs, headers,
    # account identifiers, sync tokens, and DAV metadata. They must not inherit
    # the Bridge's opt-in product DEBUG level.
    for logger_name in (
        "peewee",
        "etebase",
        "requests",
        "urllib3",
        "httpx",
        "httpcore",
    ):
        logging.getLogger(logger_name).setLevel(max(log_level, logging.WARNING))


def build_radicale_configuration():
    """Build Radicale configuration for the bridge.

    Uses SilentSuite's custom storage and auth backends,
    configured to listen on localhost only.
    """
    from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration

    config.validate_network_config()
    _verify_radicale_ssl_schema(DEFAULT_CONFIG_SCHEMA)

    configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
    web_type = "silentsuite_bridge.web" if config.is_dashboard_enabled() else "none"
    server_cfg = {
        "hosts": config.SERVER_HOSTS,
    }
    if config.SSL_ENABLED:
        server_cfg["ssl"] = True
        server_cfg["certificate"] = config.SSL_CERT_FILE
        server_cfg["key"] = config.SSL_KEY_FILE
    configuration.update(
        {
            "server": server_cfg,
            "auth": {
                "type": "silentsuite_bridge.radicale.auth",
            },
            "storage": {
                "type": "silentsuite_bridge.radicale.storage",
            },
            "rights": {
                "type": "silentsuite_bridge.radicale.rights",
            },
            "web": {
                "type": web_type,
            },
            "logging": {
                "level": config.LOG_LEVEL.lower(),
            },
        },
        source="silentsuite-bridge",
        privileged=True,
    )

    return configuration


def _verify_radicale_ssl_schema(schema) -> None:
    """Verify Radicale exposes the SSL keys this bridge config relies on."""
    server_schema = schema.get("server", {})
    missing = [key for key in ("ssl", "certificate", "key") if key not in server_schema]
    if missing:
        raise RuntimeError(
            "Installed Radicale does not expose required SSL server config key(s): " + ", ".join(missing)
        )


def validate_radicale_ssl_schema() -> None:
    """Validate the installed Radicale SSL schema inside main()'s clean guard."""
    from radicale.config import DEFAULT_CONFIG_SCHEMA

    _verify_radicale_ssl_schema(DEFAULT_CONFIG_SCHEMA)


def effective_dav_scheme() -> str:
    """Test-visible helper reporting the DAV scheme fed into Radicale."""
    return "https" if config.SSL_ENABLED else "http"


def _dashboard_url():
    return f"{config.local_base_url()}/"


def _open_dashboard_later(url, delay=1.0):
    """Open the dashboard after Radicale has had a moment to bind."""
    import threading
    import webbrowser

    def open_dashboard():
        try:
            webbrowser.open(url)
        except Exception:
            logger.debug("Could not open dashboard automatically")

    threading.Timer(delay, open_dashboard).start()


def check_credentials(open_browser=True):
    """Check whether startup can proceed with current account state."""
    from .radicale.creds import Credentials

    creds = Credentials()
    users = creds.list_users()

    if not users:
        if config.is_dashboard_enabled():
            dashboard_url = _dashboard_url()
            logger.info("No users configured; starting bridge dashboard setup")
            print("\nNo account configured yet. Open the bridge dashboard to sign in:")
            print(f"  {dashboard_url}\n")
            if open_browser:
                _open_dashboard_later(dashboard_url)
            return True

        logger.error("No users configured and bridge dashboard is disabled")
        print("\nNo account configured and the bridge dashboard is disabled for this bind.")
        print("Run `silentsuite-bridge --login` or `silentsuite-bridge --manual-login` first.\n")
        return False

    logger.info("Found %d configured user(s)", len(users))
    return True


def start_tray():
    """Start the system tray icon if available."""
    try:
        from .tray import TRAY_AVAILABLE, BridgeTray

        if not TRAY_AVAILABLE:
            logger.info("System tray not available (pystray/Pillow not installed)")
            return None

        tray = BridgeTray(bridge_state="starting")
        tray.run_detached()
        return tray
    except Exception as e:
        logger.warning("Failed to start system tray (%s)", e.__class__.__name__)
        return None


def _start_sync_threads():
    """Start a SyncThread for each configured user at boot."""
    from .radicale.creds import Credentials
    from .radicale.storage import start_sync_thread
    from .web import update_status

    creds = Credentials()
    users = creds.list_users()
    for user in users:
        update_status("syncing", account=user)
    for user in users:
        start_sync_thread(user)


def _prepare_server_start(open_browser=True):
    """Resume durable maintenance before credential-based early exits."""
    from .accounts import resume_pending_cache_cleanups

    resume_pending_cache_cleanups()
    return check_credentials(open_browser=open_browser)


def _initial_status_check():
    """Run an initial Etebase sync and update dashboard status at startup."""
    from .radicale.creds import Credentials
    from .radicale.etesync_cache import etesync_for_user
    from .web import log_sync_event, update_status

    creds = Credentials()
    users = creds.list_users()
    if not users:
        return

    totals = {"calendars": 0, "contacts": 0, "tasks": 0}
    synced = 0
    errors = []

    for user in users:
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
                for key, value in collections.items():
                    totals[key] += value
                synced += 1
                update_status("connected", collections=collections, account=user)
                log_sync_event("info", "Initial sync complete")
                logger.info(
                    "Initial sync complete: %d calendars, %d contacts, %d tasks",
                    collections["calendars"],
                    collections["contacts"],
                    collections["tasks"],
                )
        except Exception as e:
            error_code = e.__class__.__name__
            logger.warning(
                "Initial status check failed for a configured account (%s)",
                error_code,
            )
            errors.append(error_code)
            log_sync_event("error", "Initial sync failed for a configured account")

    if synced and not errors:
        update_status(
            "connected",
            collections=totals,
            scope="all configured accounts",
        )
    elif synced and errors:
        update_status(
            "error",
            error=f"Initial sync failed for {len(errors)} account(s)",
            collections=totals,
            scope="all configured accounts",
        )
        log_sync_event(
            "error",
            f"Initial sync skipped {len(errors)} account(s)",
        )
    elif errors:
        update_status("error", error=f"Initial status check failed for {len(errors)} account(s)")
    else:
        update_status("disconnected")


_OPENSSL_CONFIG_TEMPLATE = """\
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req
x509_extensions = v3_req

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
"""

_OPENSSL_CONFIG_TEMPLATE_NO_IPV6 = """\
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req
x509_extensions = v3_req

[dn]
CN = localhost

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
"""

_CERT_VALIDITY_DAYS = 398


def _generate_localhost_certificate(cert_path: str, key_path: str) -> None:
    """Generate a self-signed localhost certificate + key via system openssl.

    Raises RuntimeError with actionable text on failure. Does not print
    command output that could include secrets.
    """
    parent = os.path.dirname(cert_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    key_parent = os.path.dirname(key_path)
    if key_parent:
        os.makedirs(key_parent, exist_ok=True)

    # Try IPv6 SAN first; fall back to DNS+IPv4 if the OpenSSL build rejects ::1.
    for template in (_OPENSSL_CONFIG_TEMPLATE, _OPENSSL_CONFIG_TEMPLATE_NO_IPV6):
        with tempfile.NamedTemporaryFile("w", suffix=".cnf", delete=False) as cfg:
            cfg.write(template)
            cfg_path = cfg.name
        try:
            result = subprocess.run(
                [
                    "openssl",
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-days",
                    str(_CERT_VALIDITY_DAYS),
                    "-keyout",
                    key_path,
                    "-out",
                    cert_path,
                    "-config",
                    cfg_path,
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            try:
                os.unlink(cfg_path)
            except OSError:
                pass
        if result.returncode == 0:
            if template is _OPENSSL_CONFIG_TEMPLATE_NO_IPV6:
                logger.info(
                    "Generated localhost certificate with DNS+IPv4 SANs only; "
                    "use 'localhost' or '127.0.0.1' for Apple Internet Accounts."
                )
            _harden_key_permissions(key_path)
            return

    raise RuntimeError(
        "Failed to generate a localhost certificate with openssl. "
        "Ensure the 'openssl' command is available and the bridge data directory "
        "is writable. See `silentsuite-bridge --setup-macos-apple-accounts` docs."
    )


def _harden_key_permissions(key_path: str) -> None:
    """Best-effort chmod the private key to 0600."""
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        logger.debug("Could not chmod key file %s to 0600", key_path)


def _cert_and_key_readable(cert_path: str, key_path: str) -> bool:
    """True only when both files exist, are readable, and appear to match."""
    for path in (cert_path, key_path):
        try:
            with open(path, "rb"):
                pass
        except OSError:
            return False
    return os.path.isfile(cert_path) and os.path.isfile(key_path) and _cert_and_key_match(cert_path, key_path)


def _cert_and_key_match(cert_path: str, key_path: str) -> bool:
    """Best-effort public-key match check for an existing localhost cert/key pair.

    If openssl is unavailable, reuse readable existing files so a previously
    configured bridge is not bricked by the setup helper. If openssl is present
    and either file is invalid or mismatched, return False so both files are
    regenerated together.
    """
    try:
        cert = subprocess.run(
            ["openssl", "x509", "-in", cert_path, "-noout", "-pubkey"],
            capture_output=True,
            text=True,
            check=False,
        )
        key = subprocess.run(
            ["openssl", "pkey", "-in", key_path, "-pubout"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if cert.returncode != 0 or key.returncode != 0:
        return False
    return bool(cert.stdout.strip()) and cert.stdout == key.stdout


def _ensure_macos_localhost_certificate(cert_path: str, key_path: str) -> str:
    """Reuse existing cert/key if both are readable, else regenerate both.

    Returns 'reused' or 'generated'. Regenerating both together avoids pairing
    a stale cert with a fresh key (or vice versa).
    """
    if _cert_and_key_readable(cert_path, key_path):
        return "reused"
    _generate_localhost_certificate(cert_path, key_path)
    return "generated"


def _open_certificate_for_trust(cert_path: str) -> bool:
    """On macOS, open the certificate so the user can add it to Keychain."""
    if sys.platform != "darwin":
        return False
    try:
        subprocess.run(["open", cert_path], check=False)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _persist_ssl_settings(cert_path: str, key_path: str) -> None:
    """Persist SSL enablement + paths so launchd autostart survives."""
    settings = config.get_settings()
    settings["sslEnabled"] = True
    settings["sslCertFile"] = os.path.abspath(cert_path)
    settings["sslKeyFile"] = os.path.abspath(key_path)
    config.save_settings(settings)
    config.SSL_ENABLED = True
    config.SSL_CERT_FILE = settings["sslCertFile"]
    config.SSL_KEY_FILE = settings["sslKeyFile"]


def setup_macos_apple_accounts() -> int:
    """Generate/reuse a localhost cert and print Apple Internet Accounts setup steps.

    On macOS: persists sslEnabled=true and opens the cert for Keychain trust.
    On non-Darwin: generates/reuses cert material and prints instructions, but
    does NOT silently persist sslEnabled=true (avoids flipping a Linux bridge
    profile to HTTPS-only without explicit user action).
    """
    cert_path = config.SSL_CERT_FILE
    key_path = config.SSL_KEY_FILE
    config.ensure_data_dir()

    try:
        status = _ensure_macos_localhost_certificate(cert_path, key_path)
    except RuntimeError as exc:
        print(f"Error: {exc}")
        return 1

    if sys.platform == "darwin":
        _persist_ssl_settings(cert_path, key_path)
        print(f"Certificate: {cert_path}")
        print(f"Key: {key_path} (permissions hardened to 0600 best-effort)")
        if status == "generated":
            print("Generated a new localhost certificate (398-day validity).")
        else:
            print("Reused existing localhost certificate and key.")
        _open_certificate_for_trust(cert_path)
        print()
        print("Next steps:")
        print("  1. In Keychain Access, add the certificate to your login keychain.")
        print("     Set Trust > Secure Sockets Layer (SSL) to Always Trust.")
        print("  2. Restart the bridge: silentsuite-bridge")
        print(f"  3. Open the dashboard: {config.local_base_url()}/")
        print("  4. System Settings > Internet Accounts > Add Account > Other >")
        print("     CalDAV/CardDAV Account > Advanced:")
        print(f"       - Server Address: localhost (or 127.0.0.1), Port: {config.LISTEN_PORT}")
        print("       - Use SSL: checked")
        print("       - User Name: your account email")
        print("       - Password: your account password")
        print("       - Server Path: /your@email.com/ (or the dashboard DAV URL)")
        print("  5. If CalDAV fails, add CardDAV first to trigger certificate trust,")
        print("     then retry CalDAV.")
        return 0

    # Non-Darwin: do not silently persist sslEnabled=true.
    print(f"Certificate: {cert_path}")
    print(f"Key: {key_path} (permissions hardened to 0600 best-effort)")
    if status == "generated":
        print("Generated a new localhost certificate (398-day validity).")
    else:
        print("Reused existing localhost certificate and key.")
    print()
    print("Note: enabling SSL is all-or-nothing for the single bridge listener.")
    print("Existing HTTP clients on this bridge profile must switch to https://")
    print("and trust the local certificate. To enable SSL on this platform, set")
    print("sslEnabled=true in settings.json (or SILENTSUITE_BRIDGE_SSL=1) explicitly.")
    print()
    print("macOS setup steps (run on the Mac that hosts the bridge):")
    print("  1. Trust this certificate in Keychain with SSL set to Always Trust.")
    print("  2. Enable SSL as above, restart the bridge, and open the dashboard URL printed at startup.")
    print("  3. Use Apple Internet Accounts > Advanced with Use SSL checked.")
    return 0


def run_server():
    """Start the Radicale server with SilentSuite backends."""
    configuration = build_radicale_configuration()

    logger.info(
        "SilentSuite Bridge v%s starting on %s",
        __version__,
        config.SERVER_HOSTS,
    )
    if config.is_remote_bind_configured():
        if config.SSL_ENABLED:
            logger.warning(
                "Remote bridge bind enabled by SILENTSUITE_ALLOW_REMOTE=1 with SSL on. "
                "The bridge exposes decrypted DAV data over the network; do not expose "
                "it remotely without an intentional network/security design."
            )
        else:
            logger.warning(
                "Remote bridge bind enabled by SILENTSUITE_ALLOW_REMOTE=1. "
                "DAV traffic is plaintext HTTP unless protected by your own proxy/VPN."
            )
        logger.warning("Bridge dashboard disabled while remote bind is configured.")
    logger.info("Etebase server: %s", config.ETEBASE_SERVER_URL)
    logger.info("Data directory: %s", config.DATA_DIR)
    logger.info("CalDAV/CardDAV scheme: %s", config.dav_scheme())
    logger.info("CalDAV/CardDAV host(s): %s", config.SERVER_HOSTS)

    # Start account workers without blocking DAV/dashboard startup on provider I/O.
    _start_sync_threads()

    # Start system tray (non-blocking)
    tray = None
    if "--no-tray" not in sys.argv:
        tray = start_tray()

    try:
        _serve_radicale_with_bridge_application(configuration)
    except KeyboardInterrupt:
        logger.info("Bridge stopped by user")
    except Exception as exc:
        log_bounded_failure(logger, logging.ERROR, "Bridge crashed", exc)
        if tray:
            tray.update_state("error", "Bridge crashed")
        sys.exit(1)


def _serve_radicale_with_bridge_application(configuration) -> None:
    """Run Radicale once with the Bridge's narrowly compatible application.

    Radicale 3.2.3 constructs its module-global ``Application`` internally.
    Keep the temporary replacement single-process, non-reentrant, and
    ownership-aware so another caller cannot have its replacement overwritten.
    """
    from radicale import server as radicale_server
    from radicale.app import Application as RadicaleApplication

    from .radicale.application import Application as BridgeApplication

    if not _RADICALE_SERVER_APPLICATION_LOCK.acquire(blocking=False):
        raise RuntimeError("Radicale server application injection is already active")
    try:
        if radicale_server.Application is not RadicaleApplication:
            raise RuntimeError("Unexpected Radicale server Application entry state")
        expected_application = radicale_server.Application
        radicale_server.Application = BridgeApplication
        try:
            radicale_server.serve(configuration)
        finally:
            if radicale_server.Application is BridgeApplication:
                radicale_server.Application = expected_application
    finally:
        _RADICALE_SERVER_APPLICATION_LOCK.release()


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
        print("  --login               Add or re-authenticate an account")
        print("  --list-accounts       List configured bridge accounts")
        print("  --logout ACCOUNT      Remove local credentials; keep cache")
        print("  --remove-account ACCOUNT")
        print("                        Remove credentials plus that account's cache")
        print("  --server URL          Etebase server URL (for self-hosters)")
        print("  --manual-login        Run CLI login (for development/testing)")
        print("  --install-autostart   Install auto-start for current platform")
        print("  --remove-autostart    Remove auto-start for current platform")
        print("  --no-tray             Start without system tray icon")
        print("  --setup-macos-apple-accounts")
        print("                        Generate/reuse a localhost HTTPS certificate")
        print("                        and print Apple Internet Accounts setup steps")
        print()
        print("Environment variables:")
        print("  SILENTSUITE_SERVER_URL       Etebase server URL")
        print("  SILENTSUITE_LISTEN_ADDRESS   Listen address (default: 127.0.0.1)")
        print("  SILENTSUITE_LISTEN_PORT      Listen port (default: 37358)")
        print("  SILENTSUITE_SERVER_HOSTS     Radicale host specs (default: listen address:port)")
        print("  SILENTSUITE_ALLOW_REMOTE     Allow non-loopback bind and disable dashboard")
        print("  SILENTSUITE_DATA_DIR         Data directory path")
        print("  SILENTSUITE_LOG_LEVEL        Log level (default: INFO)")
        print("  SILENTSUITE_LOG_FILE         Log file path")
        print("  SILENTSUITE_SYNC_INTERVAL    Sync interval in seconds (default: 900)")
        print("  SILENTSUITE_BRIDGE_SSL       Enable HTTPS for the bridge listener (opt-in)")
        print("  SILENTSUITE_BRIDGE_SSL_CERT  Path to the SSL certificate file")
        print("  SILENTSUITE_BRIDGE_SSL_KEY   Path to the SSL private key file")
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

    # Handle --setup-macos-apple-accounts before validating existing SSL files:
    # this command is how users create the missing cert/key in the first place.
    if "--setup-macos-apple-accounts" in sys.argv:
        sys.exit(setup_macos_apple_accounts())

    try:
        config.validate_network_config()
        config.validate_ssl_config()
        validate_radicale_ssl_schema()
    except RuntimeError as exc:
        log_bounded_failure(
            logger,
            logging.ERROR,
            "Bridge configuration is invalid",
            exc,
        )
        sys.exit(1)

    config.ensure_data_dir()

    action_count = sum(1 for flag in _ACCOUNT_ACTION_FLAGS if flag in sys.argv)
    if action_count > 1:
        print("Error: account action flags cannot be combined")
        sys.exit(1)

    # Handle --list-accounts before any bridge startup side effects.
    if "--list-accounts" in sys.argv:
        from .accounts import list_accounts
        from .radicale.creds import Credentials

        creds = Credentials()
        users = list_accounts(credentials=creds)
        if not users:
            print("No accounts configured.")
        else:
            print("Configured accounts:")
            for user in users:
                print(f"- {user} ({creds.get_server_url(user)})")
        sys.exit(0)

    if "--logout" in sys.argv:
        idx = sys.argv.index("--logout")
        if idx + 1 >= len(sys.argv) or sys.argv[idx + 1].startswith("--"):
            print("Error: --logout requires an account argument")
            sys.exit(1)

        from .accounts import logout_account

        result = logout_account(sys.argv[idx + 1])
        if result.existed:
            print(f"Logged out {result.username}. Local cache was retained.")
            if not result.sync_stopped:
                print("Warning: sync thread is still shutting down; no duplicate will be started.")
        else:
            print(f"Account {result.username} is not configured; nothing to do.")
        sys.exit(0)

    if "--remove-account" in sys.argv:
        idx = sys.argv.index("--remove-account")
        if idx + 1 >= len(sys.argv) or sys.argv[idx + 1].startswith("--"):
            print("Error: --remove-account requires an account argument")
            sys.exit(1)

        from .accounts import remove_account

        result = remove_account(sys.argv[idx + 1])
        if result.existed:
            if result.cache_cleanup == "deferred":
                print(
                    f"Removed {result.username}. Credentials were deleted; local cache "
                    "cleanup is deferred until the active sync exits."
                )
            elif result.cache_cleared:
                print(f"Removed {result.username}. Credentials and local cache were deleted.")
            else:
                print(f"Removed {result.username}. Credentials were deleted; no cache rows were found.")
            if not result.sync_stopped:
                print("Warning: sync thread is still shutting down; no duplicate will be started.")
        else:
            print(f"Account {result.username} is not configured; nothing to do.")
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

    # Resume durable cleanup before checking whether account state allows startup.
    if not _prepare_server_start():
        sys.exit(1)

    # Start the server
    run_server()


if __name__ == "__main__":
    main()
