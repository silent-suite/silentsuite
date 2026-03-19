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


class EteSyncCache:
    """Thread-safe cache of Etebase sessions per user."""

    def __init__(self, creds_path, db_path):
        self._etesync_cache = {}
        self.creds = None
        self.creds_path = os.path.expanduser(creds_path)
        self.db_path = os.path.expanduser(db_path)

    def etesync_for_user(self, user):
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
                f'User "{user}" not found in credentials file. '
                "Please authenticate via the browser first."
            )

        etesync = Etebase(user, stored_session, remote_url)
        self._etesync_cache[user] = etesync

        return etesync, True


_etesync_cache = EteSyncCache(
    creds_path=config.CREDS_FILE,
    db_path=config.DATABASE_FILE,
)

_get_etesync_lock = threading.RLock()


@contextmanager
def etesync_for_user(user):
    """Get an Etebase session for a user (thread-safe, cached)."""
    with _get_etesync_lock:
        ret = _etesync_cache.etesync_for_user(user)

    yield ret
