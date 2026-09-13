"""System tray integration for SilentSuite Bridge.

Shows a system tray icon with status colors:
- Green: connected, syncing normally
- Yellow: warning (auth expiring, temporary error)
- Red: error (disconnected, auth expired)

Menu actions:
- Status text
- Copy CalDAV URL
- Copy CardDAV URL
- Open Dashboard (opens localhost in browser)
- Re-authenticate (opens browser auth flow)
- Quit

Uses pystray for cross-platform support (Linux, macOS, Windows).
Note: GNOME requires AppIndicator extension for tray support.
"""

import logging
import sys
import threading
import webbrowser

from .privacy_logging import bounded_exception_class

try:
    # pystray may fail to import if no display is available
    import pystray
    from PIL import Image, ImageDraw

    TRAY_AVAILABLE = True
except (ImportError, Exception):
    TRAY_AVAILABLE = False
    pystray = None
    Image = None
    ImageDraw = None

from . import config
from .radicale.creds import Credentials

logger = logging.getLogger("silentsuite-bridge.tray")

# Icon colors
COLOR_GREEN = "#4ade80"
COLOR_YELLOW = "#fbbf24"
COLOR_RED = "#ef4444"
COLOR_GRAY = "#666666"


def _dashboard_url():
    """Return the dashboard URL from the registry, or None when not bound.

    Falls back to the requested URL only before serving has been attempted
    (tray built before the server starts). Once serving was attempted/stopped,
    a missing bound URL means no loopback listener is bound — return None so
    the tray shows a disabled item.
    """
    from .radicale.server import get_registry

    registry = get_registry()
    registry_url = registry.dashboard_url(config.SSL_ENABLED)
    if registry_url is not None:
        return registry_url
    # Only fall back to requested URL before serving has ever been attempted.
    if registry.is_started or registry.is_stopped:
        return None
    requested = config.requested_dashboard_listener()
    if requested:
        return config.listener_base_url(requested["host"], requested["port"]) + "/"
    return None


def _account_dav_url(email):
    """Return the DAV URL for one account from a bound listener.

    Uses the registry's bound listeners when available, preferring loopback
    (so the copied URL matches the safe dashboard endpoint) and falling back
    to a bound remote literal when no loopback is bound. Falls back to the
    configured LISTEN_ADDRESS/LISTEN_PORT only before serving has been
    attempted. Once serving was attempted/stopped with no usable listener
    bound, returns None so callers can handle the absence explicitly rather
    than advertising an unbound requested address.
    """
    from .radicale.server import get_registry

    registry = get_registry()
    base = registry.dav_base_url(config.SSL_ENABLED)
    if base is not None:
        return f"{base}/{email}/"
    # Only fall back to requested URL before serving has ever been attempted.
    if registry.is_started or registry.is_stopped:
        return None
    return f"{config.local_base_url()}/{email}/"


def _create_icon_image(color, size=64):
    """Create a simple colored circle icon."""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Draw filled circle
    margin = 4
    draw.ellipse(
        [margin, margin, size - margin, size - margin],
        fill=color,
    )

    # Draw a small "S" shape in the center for branding
    center_color = "#000000" if color != COLOR_GRAY else "#333333"
    cx, cy = size // 2, size // 2
    r = size // 6
    draw.text(
        (cx - r + 2, cy - r - 1),
        "S",
        fill=center_color,
    )

    return image


def _get_accounts():
    """Get configured account emails."""
    try:
        creds = Credentials()
        return creds.list_users()
    except Exception:
        return []


class BridgeTray:
    """System tray manager for SilentSuite Bridge."""

    def __init__(self, bridge_state=None):
        if not TRAY_AVAILABLE:
            raise RuntimeError(
                "pystray is not available. Install with: pip install pystray Pillow"
            )

        self._state = bridge_state or "starting"
        self._error = None
        self._icon = None
        self._running = False
        # The tray starts before the server binds (run_server starts it
        # first), so the menu must follow the listener registry: every bind,
        # bind failure, or stop asks pystray to re-render the menu. The hook
        # runs synchronously on the thread that changed the registry; no
        # thread is owned by the tray for this.
        from .radicale.server import get_registry

        get_registry().add_listener(self._on_registry_change)

    def _on_registry_change(self):
        """Re-render the menu after a listener registry change.

        ``Icon.update_menu()`` is pystray's documented call for a menu whose
        callable ``text``/``enabled`` values changed. Before ``run()`` has
        created the icon there is nothing to refresh; the menu built in
        ``run()`` reads the registry at that point.
        """
        icon = self._icon
        if icon is None:
            return
        try:
            icon.update_menu()
        except Exception as e:
            logger.debug("Tray menu refresh failed (%s)", bounded_exception_class(e))

    def _build_menu(self):
        """Build the tray menu.

        Dashboard and DAV URLs are resolved at click time, not at menu-build
        time, so a menu built before the server binds (or while a previous
        registry state was active) never opens or copies a stale URL. The
        callbacks defer to ``_dashboard_url()`` / ``_account_dav_url()`` which
        read the live registry on every invocation. The dashboard item's
        ``text`` and ``enabled`` values are callables that pystray evaluates
        whenever it renders the menu, and ``_on_registry_change`` asks for a
        re-render on every registry change, so the label and availability
        follow the bound state instead of a pre-start snapshot.
        """
        accounts = _get_accounts()

        status_text = {
            "connected": "Connected",
            "starting": "Starting...",
            "error": f"Error: {self._error}" if self._error else "Error",
            "disconnected": "Disconnected",
        }.get(self._state, self._state)

        if accounts:
            account_items = []
            for email in accounts:
                # Resolve the DAV URL at click time so a stale pre-start menu
                # never copies a URL that is no longer valid.
                def _copy_dav(_icon=None, _item=None, _email=email):
                    url = _account_dav_url(_email)
                    if url is not None:
                        self._copy_to_clipboard(url)

                account_items.append(pystray.MenuItem(
                    email,
                    pystray.Menu(
                        pystray.MenuItem(
                            "Copy CalDAV URL",
                            _copy_dav,
                        ),
                        pystray.MenuItem(
                            "Copy CardDAV URL",
                            _copy_dav,
                        ),
                    ),
                ))
        else:
            account_items = [
                pystray.MenuItem("No accounts configured", None, enabled=False),
            ]

        # Dashboard label and availability are evaluated by pystray each time
        # the menu is rendered (callable text/enabled), and the click handler
        # re-resolves the URL and no-ops if it is None, so an old menu cannot
        # open a stale dashboard URL after the listener state changed.
        def _dashboard_text(_item=None):
            if _dashboard_url() is not None:
                return "Open Dashboard"
            return "Dashboard not bound on a loopback listener"

        def _dashboard_enabled(_item=None):
            return _dashboard_url() is not None

        def _open_dashboard(_icon=None, _item=None):
            url = _dashboard_url()
            if url is not None:
                webbrowser.open(url)

        dashboard_item = pystray.MenuItem(
            _dashboard_text,
            _open_dashboard,
            enabled=_dashboard_enabled,
        )

        return pystray.Menu(
            pystray.MenuItem(
                f"Status: {status_text}",
                None,
                enabled=False,
            ),
            pystray.MenuItem(
                f"Accounts: {len(accounts)} configured",
                None,
                enabled=False,
            ),
            pystray.Menu.SEPARATOR,
            *account_items,
            pystray.Menu.SEPARATOR,
            dashboard_item,
            pystray.MenuItem(
                "Add / Re-authenticate Account",
                lambda _icon=None, _item=None: self._reauthenticate(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Quit SilentSuite Bridge",
                lambda _icon=None, _item=None: self.quit(),
            ),
        )

    def _get_icon_color(self):
        """Get icon color based on current state."""
        return {
            "connected": COLOR_GREEN,
            "starting": COLOR_YELLOW,
            "error": COLOR_RED,
            "disconnected": COLOR_GRAY,
        }.get(self._state, COLOR_GRAY)

    def _copy_to_clipboard(self, text):
        """Copy text to system clipboard."""
        try:
            if sys.platform == "darwin":
                import subprocess
                subprocess.run(["pbcopy"], input=text.encode(), check=True)
            elif sys.platform == "win32":
                import subprocess
                subprocess.run(
                    ["clip"], input=text.encode(), check=True
                )
            else:
                # Linux - try xclip, xsel, or wl-copy
                import subprocess
                for cmd in [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard"], ["wl-copy"]]:
                    try:
                        subprocess.run(cmd, input=text.encode(), check=True)
                        return
                    except (FileNotFoundError, subprocess.CalledProcessError):
                        continue
                logger.warning("No clipboard tool found (xclip, xsel, or wl-copy)")
        except Exception as e:
            logger.warning("Failed to copy to clipboard (%s)", bounded_exception_class(e))

    def _reauthenticate(self):
        """Open browser auth flow for re-authentication."""
        def run_login():
            try:
                from .auth_browser import browser_login
                from .radicale.storage import refresh_sync_thread

                email = browser_login(running_bridge=True)
                if email:
                    refresh_sync_thread(email)
                    logger.info("Account added or re-authenticated from tray")
            except Exception as e:
                logger.error(
                    "Failed to complete re-authentication (%s)",
                    bounded_exception_class(e),
                )

        try:
            threading.Thread(target=run_login, daemon=True).start()
        except Exception as e:
            logger.error(
                "Failed to start re-authentication (%s)",
                bounded_exception_class(e),
            )

    def update_state(self, state, error=None):
        """Update the tray icon state."""
        self._state = state
        self._error = error

        if self._icon:
            self._icon.icon = _create_icon_image(self._get_icon_color())
            self._icon.menu = self._build_menu()
            self._icon.title = f"SilentSuite Bridge - {state.capitalize()}"

    def run(self):
        """Start the system tray icon (blocking)."""
        self._icon = pystray.Icon(
            "silentsuite-bridge",
            icon=_create_icon_image(self._get_icon_color()),
            title="SilentSuite Bridge",
            menu=self._build_menu(),
        )

        self._running = True
        logger.info("System tray icon started")
        self._icon.run()

    def run_detached(self):
        """Start the system tray in a background thread."""
        thread = threading.Thread(target=self.run, daemon=True)
        thread.start()
        return thread

    def quit(self):
        """Stop the tray icon and exit the bridge."""
        logger.info("Quit requested from tray")
        self._running = False
        if self._icon:
            self._icon.stop()

        # Give the tray a moment to clean up, then exit
        import os
        os._exit(0)
