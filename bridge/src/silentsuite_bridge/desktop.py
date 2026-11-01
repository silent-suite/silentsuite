"""SilentSuite Bridge desktop window (#171).

The desktop app owns its Bridge server: Radicale runs on a worker thread with
the existing socketpair shutdown, and the Qt event loop runs on the calling
(main) thread. The window shows the existing dashboard, and only once this
process's listener registry has confirmed a bound loopback dashboard URL. No
URL ever comes from a file, IPC or another process.

Browser boundary (implementation-plan-v2 section 4, proven feasible by T0):
- one off-the-record profile per process; startup refuses if it is not;
- navigation (main frame and frames) and every request are allowed only for
  the exact bound origin and the dashboard paths ``/``, ``/.web`` and
  ``/.web/...``; everything else is refused before any request is sent;
- popups never open a window; only an https link to a fixed documentation
  host is handed to the system browser;
- downloads are cancelled; no web channel or other application bridge is
  exposed to page script; remote debugging and sandbox-disabling Chromium
  flags refuse startup.

The server-side loopback, Host and CSRF gates are unchanged; the window is
just another loopback client.
"""

import logging
import os
import socket
import sys
import threading
import time
import urllib.parse

from . import config
from .privacy_logging import log_bounded_failure

logger = logging.getLogger("silentsuite-bridge.desktop")

WINDOW_TITLE = "SilentSuite Bridge"
EXTERNAL_HTTPS_HOSTS = frozenset({"docs.silentsuite.io", "caldavsynchronizer.org"})
_UNSAFE_CHROMIUM_FLAGS = ("--no-sandbox", "--disable-web-security", "--remote-debugging")
_URL_POLL_MS = 100
_DASHBOARD_DEADLINE_SECONDS = 30.0
_SERVER_STOP_TIMEOUT = 10.0

UNSAFE_ENVIRONMENT_MESSAGE = (
    "Error: the desktop window does not start with remote debugging or a disabled browser sandbox."
)
QT_MISSING_MESSAGE = (
    "Error: the desktop window needs the 'desktop' extra (PySide6); the command-line bridge is unaffected."
)
PRIVATE_PROFILE_MESSAGE = "Error: the desktop window could not create a private browser profile."
NO_DASHBOARD_MESSAGE = "Error: the bridge could not bind its loopback dashboard listener; the window was closed."


def _default_port(scheme: str, port):
    if port is not None:
        return port
    return 443 if scheme == "https" else 80


class DashboardOrigin:
    """Navigation and request policy bound to this process's confirmed dashboard URL.

    Denies everything until ``bind`` is called with the registry's bound URL.
    """

    def __init__(self):
        self._origin = None  # (scheme, host, port); replaced atomically

    def bind(self, dashboard_url: str) -> None:
        parts = urllib.parse.urlsplit(dashboard_url)
        self._origin = (parts.scheme, parts.hostname, _default_port(parts.scheme, parts.port))

    def allows(self, url: str) -> bool:
        origin = self._origin
        if origin is None:
            return False
        try:
            parts = urllib.parse.urlsplit(url)
            port = _default_port(parts.scheme, parts.port)
        except ValueError:
            return False
        if (parts.scheme, parts.hostname, port) != origin:
            return False
        path = parts.path or "/"
        return path in ("/", "/.web") or path.startswith("/.web/")


def is_allowed_external(url: str) -> bool:
    """True only for an https link to a fixed documentation host."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    return parts.scheme == "https" and parts.hostname in EXTERNAL_HTTPS_HOSTS


def _unsafe_environment() -> bool:
    if "QTWEBENGINE_REMOTE_DEBUGGING" in os.environ:
        return True
    flags = os.environ.get("QTWEBENGINE_CHROMIUM_FLAGS", "")
    return any(flag in flags for flag in _UNSAFE_CHROMIUM_FLAGS)


def _stop_sync_workers() -> None:
    from .radicale import storage

    with storage._sync_threads_lock:
        users = list(storage._sync_threads)
    for user in users:
        storage.stop_sync_thread(user)


def run_desktop(*, build_configuration, start_workers, serve) -> int:
    """Run the desktop window around this process's own Bridge server.

    ``build_configuration``, ``start_workers`` and ``serve`` are the server
    stages of ``__main__`` (passed in so the running ``__main__`` module is
    reused, never imported a second time). The caller already owns the
    instance lock and has run the start-up preparation. Returns an exit code;
    0 after a normal window close.
    """
    if _unsafe_environment():
        print(UNSAFE_ENVIRONMENT_MESSAGE, file=sys.stderr)
        return 1
    try:
        from PySide6.QtCore import QCoreApplication, QEvent, Qt, QTimer, QUrl
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtWebEngineCore import (
            QWebEnginePage,
            QWebEngineProfile,
            QWebEngineSettings,
            QWebEngineUrlRequestInterceptor,
        )
        from PySide6.QtWebEngineWidgets import QWebEngineView
        from PySide6.QtWidgets import QApplication
    except ImportError:
        print(QT_MISSING_MESSAGE, file=sys.stderr)
        return 1

    from .radicale.server import get_registry

    try:
        configuration = build_configuration()
    except RuntimeError as exc:
        log_bounded_failure(logger, logging.ERROR, "Bridge configuration is invalid", exc)
        return 1

    app = QApplication.instance()
    if app is None:
        QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
        app = QApplication(sys.argv[:1] or ["silentsuite-bridge"])
    app.setQuitOnLastWindowClosed(True)

    policy = DashboardOrigin()

    # No storage name: an off-the-record profile that keeps no data on disk.
    profile = QWebEngineProfile(app)
    if not profile.isOffTheRecord():
        profile.deleteLater()
        print(PRIVATE_PROFILE_MESSAGE, file=sys.stderr)
        return 1

    class _Interceptor(QWebEngineUrlRequestInterceptor):
        def interceptRequest(self, info):  # noqa: N802 - Qt override
            if not policy.allows(info.requestUrl().toString()):
                info.block(True)

    class _DashboardPage(QWebEnginePage):
        def acceptNavigationRequest(self, url, nav_type, is_main_frame):  # noqa: N802 - Qt override
            return policy.allows(url.toString())

        def createWindow(self, window_type):  # noqa: N802 - Qt override
            return None

    interceptor = _Interceptor(profile)
    profile.setUrlRequestInterceptor(interceptor)
    profile.downloadRequested.connect(lambda request: request.cancel())

    view = QWebEngineView()
    page = _DashboardPage(profile, view)
    view.setPage(page)
    view.setWindowTitle(WINDOW_TITLE)
    view.resize(1000, 760)

    settings = page.settings()
    for name in ("JavascriptCanOpenWindows", "LocalContentCanAccessRemoteUrls", "LocalContentCanAccessFileUrls"):
        attribute = getattr(QWebEngineSettings.WebAttribute, name, None)
        if attribute is not None:
            settings.setAttribute(attribute, False)

    def on_new_window(request):
        url = request.requestedUrl()
        if is_allowed_external(url.toString()):
            QDesktopServices.openUrl(url)

    page.newWindowRequested.connect(on_new_window)

    registry = get_registry()
    server_errors = []
    serve_end, shutdown_end = socket.socketpair()

    def serve_bridge():
        try:
            serve(configuration, shutdown_socket=serve_end)
        except Exception as exc:  # reported by the window, then by the exit code
            server_errors.append(exc)
            log_bounded_failure(logger, logging.ERROR, "Bridge server stopped with an error", exc)

    server_thread = threading.Thread(target=serve_bridge, name="silentsuite-bridge-server", daemon=True)
    outcome = {"code": 0, "deadline": time.monotonic() + _DASHBOARD_DEADLINE_SECONDS}

    def show_dashboard_when_bound():
        url = registry.dashboard_url(config.SSL_ENABLED)
        if url is not None:
            poll.stop()
            policy.bind(url)
            view.load(QUrl(url))
            return
        if server_errors or registry.is_stopped or time.monotonic() > outcome["deadline"]:
            poll.stop()
            print(NO_DASHBOARD_MESSAGE, file=sys.stderr)
            outcome["code"] = 1
            view.close()

    poll = QTimer()
    poll.setInterval(_URL_POLL_MS)
    poll.timeout.connect(show_dashboard_when_bound)

    try:
        start_workers()
        server_thread.start()
        view.show()
        poll.start()
        app.exec()
    finally:
        poll.stop()
        # Release web content first so its loopback connections close, then
        # stop the server through its shutdown socket, then the workers.
        view.close()
        view.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        profile.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        shutdown_end.close()
        if server_thread.is_alive():
            server_thread.join(_SERVER_STOP_TIMEOUT)
        serve_end.close()
        _stop_sync_workers()

    if server_thread.is_alive():
        logger.error("Bridge server did not stop after the window closed")
        return 1
    if outcome["code"]:
        return outcome["code"]
    return 1 if server_errors else 0
