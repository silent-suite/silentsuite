"""One Bridge server per data directory.

A server start owns ``<DATA_DIR>/instance.lock`` for its whole lifetime. The
lock is the same non-blocking OS-level lock the settings writers use
(``config._try_lock_fd``), so it is released automatically if the owner dies.
A second start against the same data directory fails fast instead of
binding listeners or starting duplicate sync workers on the same cache.

Like ``settings.json.lock``, the lock file is created on first use and never
deleted: unlinking it after unlock would let a later process lock a fresh
inode while another still holds the old one.
"""

import contextlib
import os

from . import config

INSTANCE_LOCK_NAME = "instance.lock"
ALREADY_RUNNING_MESSAGE = "Error: another SilentSuite Bridge is already running for this data directory."
LOCK_UNAVAILABLE_MESSAGE = (
    "Error: could not take the bridge instance lock in the data directory; the bridge was not started."
)


class InstanceBusyError(RuntimeError):
    """Another process already owns the instance lock for this data directory."""


def instance_lock_path(data_dir: str | None = None) -> str:
    return os.path.join(config.DATA_DIR if data_dir is None else data_dir, INSTANCE_LOCK_NAME)


@contextlib.contextmanager
def instance_ownership(data_dir: str | None = None):
    """Own the data directory's instance lock until the block exits.

    Raises InstanceBusyError at once, without waiting, when another process
    holds it. Any other failure to open or lock the file propagates as
    OSError; the caller must not start the server without ownership.
    """
    fd = os.open(instance_lock_path(data_dir), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        if not config._try_lock_fd(fd):
            raise InstanceBusyError(ALREADY_RUNNING_MESSAGE)
        try:
            yield
        finally:
            config._unlock_fd(fd)
    finally:
        os.close(fd)
