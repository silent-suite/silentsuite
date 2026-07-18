"""Etebase session cache for Radicale storage backend.

Manages per-user Etebase sessions, loading credentials from
the local credential store and caching sessions for reuse.

Forked and adapted from etesync-dav (AGPL-3.0).
"""

import logging
import os
import threading
from contextlib import contextmanager

from .. import config
from ..local_cache import Etebase
from .creds import Credentials

logger = logging.getLogger("silentsuite-bridge.cache")


class EteSyncBusyError(RuntimeError):
    """Raised when an exclusive account session is already busy."""


class EteSyncCache:
    """Thread-safe cache of Etebase sessions per user."""

    def __init__(self, creds_path, db_path):
        self._etesync_cache = {}
        self._cache_lock = threading.RLock()
        self.creds = None
        self.creds_path = os.path.expanduser(creds_path)
        self.db_path = os.path.expanduser(db_path)

    def etesync_for_user(self, user):
        with self._cache_lock:
            if self.creds:
                self.creds.load()

                if user in self._etesync_cache:
                    etesync = self._etesync_cache[user]
                    if isinstance(etesync, Etebase) and (
                        etesync.stored_session == self.creds.get_etebase(user)
                    ):
                        return etesync, False
                    else:
                        del self._etesync_cache[user]
            else:
                self.creds = Credentials(self.creds_path)

            remote_url = self.creds.get_server_url(user)
            stored_session = self.creds.get_etebase(user)
        if stored_session is None:
            raise Exception(
                "Configured account not found in credentials file. "
                "Please authenticate via the browser first."
            )

        etesync = Etebase(user, stored_session, remote_url)
        with self._cache_lock:
            self._etesync_cache[user] = etesync

        return etesync, True

    def forget_user(self, user):
        with self._cache_lock:
            self._etesync_cache.pop(user, None)

    def fresh_for_user(self, user):
        """Restore an independent session for local-cache reads."""
        with self._cache_lock:
            if self.creds:
                self.creds.load()
            else:
                self.creds = Credentials(self.creds_path)
            remote_url = self.creds.get_server_url(user)
            stored_session = self.creds.get_etebase(user)
        if stored_session is None:
            raise Exception(
                "Configured account not found in credentials file. "
                "Please authenticate via the browser first."
            )
        return Etebase(
            user,
            stored_session,
            remote_url,
            read_only=True,
        ), True


_etesync_cache = EteSyncCache(
    creds_path=config.CREDS_FILE,
    db_path=config.DATABASE_FILE,
)

_user_locks = {}
_user_locks_guard = threading.Lock()
_reader_condition = threading.Condition(_user_locks_guard)
_active_readers = {}
_users_closing = set()


def _lock_for_user(user):
    with _user_locks_guard:
        return _user_locks.setdefault(user, threading.RLock())


@contextmanager
def etesync_for_user(user, *, exclusive=True, timeout=None):
    """Get an Etebase session for a user (thread-safe, cached)."""
    if not exclusive:
        with _reader_condition:
            if user in _users_closing:
                raise EteSyncBusyError("Account session is closing")
            _active_readers[user] = _active_readers.get(user, 0) + 1
        try:
            yield _etesync_cache.fresh_for_user(user)
            return
        finally:
            with _reader_condition:
                remaining = _active_readers.get(user, 1) - 1
                if remaining:
                    _active_readers[user] = remaining
                else:
                    _active_readers.pop(user, None)
                _reader_condition.notify_all()
    lock = _lock_for_user(user)
    acquired = lock.acquire() if timeout is None else lock.acquire(timeout=timeout)
    if not acquired:
        raise EteSyncBusyError("Account session is busy")
    try:
        ret = _etesync_cache.etesync_for_user(user)
        yield ret
    finally:
        lock.release()


def forget_etesync_user(user):
    """Evict one user's restored session without waiting on a wedged sync."""
    _etesync_cache.forget_user(user)


@contextmanager
def account_maintenance(user, *, timeout=0):
    """Enter bounded exclusive maintenance only when no readers are active."""
    lock = _lock_for_user(user)
    acquired = lock.acquire(timeout=timeout)
    if not acquired:
        yield False
        return
    try:
        with _reader_condition:
            _users_closing.add(user)
            available = _active_readers.get(user, 0) == 0
        yield available
    finally:
        with _reader_condition:
            _users_closing.discard(user)
            _reader_condition.notify_all()
        lock.release()
