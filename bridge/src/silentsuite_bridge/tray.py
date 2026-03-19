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

try:
    from PIL import Image, ImageDraw

    # pystray may fail to import if no display is available
    import pystray

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


def _get_user_email():
    """Get the first configured user email."""
    try:
        creds = Credentials()
        users = creds.list_users()
        return users[0] if users else None
    except Exception:
        return None


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

    def _build_menu(self):
        """Build the tray menu."""
        email = _get_user_email()
        base_url = f"http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}"

        status_text = {
            "connected": "Connected",
            "starting": "Starting...",
            "error": f"Error: {self._error}" if self._error else "Error",
            "disconnected": "Disconnected",
        }.get(self._state, self._state)

        caldav_url = f"{base_url}/{email}/" if email else "Not configured"
        carddav_url = caldav_url

        return pystray.Menu(
            pystray.MenuItem(
                f"Status: {status_text}",
                None,
                enabled=False,
            ),
            pystray.MenuItem(
                f"Account: {email or 'Not logged in'}",
                None,
                enabled=False,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Copy CalDAV URL",
                lambda: self._copy_to_clipboard(caldav_url),
                enabled=email is not None,
            ),
            pystray.MenuItem(
                "Copy CardDAV URL",
                lambda: self._copy_to_clipboard(carddav_url),
                enabled=email is not None,
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Open Dashboard",
                lambda: webbrowser.open(f"{base_url}/.web/"),
            ),
            pystray.MenuItem(
                "Re-authenticate",
                lambda: self._reauthenticate(),
            ),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(
                "Quit SilentSuite Bridge",
                lambda: self.quit(),
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
            logger.warning("Failed to copy to clipboard: %s", e)

    def _reauthenticate(self):
        """Open browser auth flow for re-authentication."""
        try:
            from .auth_browser import browser_login
            threading.Thread(target=browser_login, daemon=True).start()
        except Exception as e:
            logger.error("Failed to start re-authentication: %s", e)

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
