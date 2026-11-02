"""Desktop single-instance hand-over (#171): a second launch asks the owner to show.

The process that holds ``<DATA_DIR>/instance.lock`` listens on a local
endpoint (QLocalServer) for its whole life. A later desktop launch for the
same user and data directory cannot take the lock; it connects, writes the
fixed bytes ``b"show"``, reads nothing and exits. If no owner answers within
a short budget it shows a fixed native message instead.

The endpoint carries one meaning only. The owner acts solely on a client that
sent exactly ``b"show"`` and then disconnected; anything else is drained into
nothing and ignored, no reply is ever written, and nothing received is
treated as a URL or command. Qt's per-client read buffer is capped and every
read is bounded by that cap; each client is dropped after a fixed time or a
fixed total byte budget, and only a fixed number of clients are tracked at
once (extra connections are refused unread). A slow or flooding client
therefore cannot hold the main thread or grow memory without bound.

Endpoint scope:
- Unix: a socket in ``/tmp/silentsuite-bridge-<uid>``, a directory that must
  be a real directory (not a symlink) owned by this user with no group or
  other permissions. macOS ignores socket-file permissions, so this private
  directory is the protection there. The name is a short hash of the user and
  the resolved DATA_DIR, which keeps it under the Unix address length.
- Windows: a named pipe whose name is the same hash, created with
  ``UserAccessOption``.
"""

import getpass
import hashlib
import logging
import os
import stat
import sys
import time

from . import config

logger = logging.getLogger("silentsuite-bridge.desktop")

SHOW_MESSAGE = b"show"
ALREADY_RUNNING_TEXT = "SilentSuite Bridge is already running (possibly from the command line)."
ALREADY_RUNNING_MESSAGE = "Error: " + ALREADY_RUNNING_TEXT
HANDOVER_SECONDS = 2.0
_CLIENT_SECONDS = 2.0
_READ_CHUNK = 4096  # Qt read-buffer cap per client and the most one read() allocates
_MAX_CLIENT_BYTES = 256 * 1024  # total a client may send before it is dropped
_MAX_CLIENTS = 8  # live clients tracked at once; also the server's pending-queue cap
_RETRY_SECONDS = 0.1


def _endpoint_key() -> str:
    try:
        user = str(os.getuid()) if hasattr(os, "getuid") else getpass.getuser()
    except Exception:  # noqa: BLE001 - an unknown user still gets a per-DATA_DIR key
        user = ""
    data_dir = os.path.realpath(config.DATA_DIR)
    return hashlib.sha256(f"{user}\0{data_dir}".encode("utf-8", "surrogatepass")).hexdigest()[:24]


def _private_dir(create: bool):
    """The per-user endpoint directory, or None if it is not provably private."""
    uid = os.getuid()
    path = f"/tmp/silentsuite-bridge-{uid}"
    if create:
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        except OSError:
            return None
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid:
        return None
    if st.st_mode & 0o077:
        if not create:
            return None
        try:
            os.chmod(path, 0o700)  # tighten only, on our own real directory
            st = os.lstat(path)
        except OSError:
            return None
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
            return None
    return path


def endpoint_name(create: bool = False):
    """The owner endpoint for this user and DATA_DIR, or None when unsafe."""
    key = _endpoint_key()
    if os.name == "nt":
        return f"silentsuite-bridge-{key}"
    directory = _private_dir(create)
    return os.path.join(directory, key[:16] + ".sock") if directory else None


def _remove_own_socket(path) -> bool:
    """Remove a leftover socket file only if it is a socket owned by this user."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
        return False
    try:
        os.unlink(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return True


class OwnerIpc:
    """The lock owner's endpoint. ``window`` is what a valid "show" brings back."""

    def __init__(self, app, timer_class):
        self._app = app
        self._timer_class = timer_class
        self._server = None
        self._path = None
        self._clients = {}
        self.window = None

    def _listen(self, server_class) -> bool:
        name = endpoint_name(create=True)
        if name is None:
            logger.warning("Desktop reopen endpoint unavailable: no private endpoint directory")
            return False
        if os.name != "nt" and not _remove_own_socket(name):
            logger.warning("Desktop reopen endpoint unavailable: endpoint path is not ours")
            return False
        server = server_class(self._app)  # rooted under the QApplication
        server.setSocketOptions(server_class.SocketOption.UserAccessOption)
        server.setMaxPendingConnections(_MAX_CLIENTS)
        if not server.listen(name):
            logger.warning("Desktop reopen endpoint could not listen")
            server.deleteLater()
            return False
        server.newConnection.connect(self._accept)
        self._server = server
        self._path = name if os.name != "nt" else None
        return True

    def _accept(self):
        # At most the server's pending queue (_MAX_CLIENTS) per call.
        while self._server is not None and self._server.hasPendingConnections():
            sock = self._server.nextPendingConnection()
            if sock is None:
                break
            if len(self._clients) >= _MAX_CLIENTS:
                sock.abort()  # over the live-client cap: refused, never read
                sock.deleteLater()
                continue
            # Qt buffers no more than this before we read(), so neither the
            # native buffer nor any read() below can exceed _READ_CHUNK.
            sock.setReadBufferSize(_READ_CHUNK)
            client = {"buffer": b"", "invalid": False, "total": 0, "done": False}
            self._clients[id(sock)] = (sock, client)
            timer = self._timer_class(sock)
            timer.setSingleShot(True)
            timer.timeout.connect(lambda s=sock, c=client: self._expire(s, c))
            timer.start(int(_CLIENT_SECONDS * 1000))
            sock.readyRead.connect(lambda s=sock, c=client: self._read(s, c))
            sock.disconnected.connect(lambda s=sock, c=client: self._finish(s, c))
            if sock.bytesAvailable() > 0:
                self._read(sock, client)  # data that arrived before the signals were connected
            if sock.state() == sock.LocalSocketState.UnconnectedState:
                self._finish(sock, client)  # already gone: release it now

    def _expire(self, sock, client):
        if client["done"]:
            return
        client["invalid"] = True  # a timed-out client never activates anything
        self._release(sock, client)

    def _read(self, sock, client):
        """One bounded read per readyRead; never more than _READ_CHUNK bytes."""
        if client["done"]:
            return
        available = int(sock.bytesAvailable())
        if available <= 0:
            return
        room = len(SHOW_MESSAGE) - len(client["buffer"])
        if not client["invalid"] and available <= room:
            chunk = bytes(sock.read(available).data())  # at most len(SHOW_MESSAGE) bytes
            client["buffer"] += chunk
            client["total"] += len(chunk)
            return
        # Not the show message: discard a bounded chunk so the sender is not
        # stalled, keep nothing, and drop it once it passes the total budget.
        client["invalid"] = True
        client["buffer"] = b""
        client["total"] += len(sock.read(min(available, _READ_CHUNK)))
        if client["total"] > _MAX_CLIENT_BYTES:
            self._release(sock, client)

    def _finish(self, sock, client):
        """Peer disconnected (or socket already gone): decide once, then release."""
        if client["done"]:
            return
        if not client["invalid"]:
            remaining = int(sock.bytesAvailable())
            if remaining > len(SHOW_MESSAGE) - len(client["buffer"]):
                client["invalid"] = True
            elif remaining > 0:
                client["buffer"] += bytes(sock.read(remaining).data())
        activate = not client["invalid"] and client["buffer"] == SHOW_MESSAGE
        self._release(sock, client)
        if activate:
            self._activate()

    def _release(self, sock, client):
        """Forget, abort and delete a client socket exactly once."""
        if client["done"]:
            return
        client["done"] = True
        client["buffer"] = b""
        self._clients.pop(id(sock), None)
        sock.abort()
        sock.deleteLater()

    def _activate(self):
        from PySide6.QtWidgets import QApplication

        # A running native dialog (the migration prompt) comes first, then the
        # owner's own window. Nothing new is created and nothing is navigated.
        target = QApplication.activeModalWidget() or self.window
        if target is None:
            return
        if target.isMinimized():
            target.showNormal()
        else:
            target.show()
        target.raise_()
        target.activateWindow()  # best effort; the OS decides about focus

    def close(self):
        """Stop listening and remove our own socket file. Runs before the lock is released."""
        self.window = None
        for sock, client in list(self._clients.values()):
            client["invalid"] = True
            self._release(sock, client)
        self._clients.clear()
        if self._server is not None:
            self._server.close()
            self._server = None
        if self._path is not None:
            _remove_own_socket(self._path)
            self._path = None


def start_owner_ipc():
    """Start the owner's endpoint (the caller holds the instance lock). None without Qt."""
    try:
        from PySide6.QtCore import QTimer
        from PySide6.QtNetwork import QLocalServer
    except ImportError:
        return None
    from .desktop import _qt_application

    ipc = OwnerIpc(_qt_application(), QTimer)
    ipc._listen(QLocalServer)
    return ipc


def _send_show(socket_class, name) -> bool:
    """Deliver b"show" within HANDOVER_SECONDS in total. Never reads."""
    deadline = time.monotonic() + HANDOVER_SECONDS
    sock = None
    while True:
        remaining = int((deadline - time.monotonic()) * 1000)
        if remaining <= 0:
            return False
        sock = socket_class()
        sock.connectToServer(name)
        if sock.waitForConnected(remaining):
            break
        sock.abort()
        if time.monotonic() + _RETRY_SECONDS >= deadline:
            return False
        time.sleep(_RETRY_SECONDS)
    if sock.write(SHOW_MESSAGE) != len(SHOW_MESSAGE):
        sock.abort()
        return False
    remaining = max(1, int((deadline - time.monotonic()) * 1000))
    if sock.bytesToWrite() > 0 and not sock.waitForBytesWritten(remaining):
        sock.abort()
        return False
    sock.disconnectFromServer()
    if sock.state() != socket_class.LocalSocketState.UnconnectedState:
        sock.waitForDisconnected(max(1, int((deadline - time.monotonic()) * 1000)))
    return True


def handover_to_owner() -> int:
    """Second desktop launch: ask the owner to show itself, else say it is running.

    Returns 0 once "show" was delivered, 1 otherwise. Runs no legacy check,
    preparation, worker, server or web view, and accepts nothing back.
    """
    try:
        from PySide6.QtNetwork import QLocalSocket
        from PySide6.QtWidgets import QMessageBox
    except ImportError:
        print(ALREADY_RUNNING_MESSAGE, file=sys.stderr)
        return 1
    from .desktop import WINDOW_TITLE, _qt_application

    app = _qt_application()
    name = endpoint_name(create=False)
    if name is not None and _send_show(QLocalSocket, name):
        return 0

    print(ALREADY_RUNNING_MESSAGE, file=sys.stderr)
    quit_on_last_window = app.quitOnLastWindowClosed()
    app.setQuitOnLastWindowClosed(False)
    try:
        box = QMessageBox()
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle(WINDOW_TITLE)
        box.setText(ALREADY_RUNNING_TEXT)
        box.setStandardButtons(QMessageBox.StandardButton.Ok)
        box.exec()
    finally:
        app.setQuitOnLastWindowClosed(quit_on_last_window)
    return 1
