"""Account-management helpers for SilentSuite Bridge."""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from dataclasses import dataclass

from . import config
from .local_cache import clear_cached_user
from .radicale.creds import CREDENTIALS_LOCK, Credentials
from .radicale.etesync_cache import account_maintenance, forget_etesync_user
from .radicale.storage import stop_sync_thread

_account_lock = threading.RLock()
_pending_cache_cleanups = set()
_account_epochs = {}
logger = logging.getLogger("silentsuite-bridge.accounts")


def _clear_cache_cleanup_marker(username, creds_path):
    if not creds_path:
        return
    with CREDENTIALS_LOCK:
        creds = Credentials(creds_path)
        if username in creds.list_cache_cleanups():
            creds.clear_cache_cleanup(username)
            creds.save()


def _schedule_deferred_cache_cleanup(username, *, creds_path=None):
    with _account_lock:
        epoch = _account_epochs.get(username, 0)
        cleanup_key = (username, epoch)
        if cleanup_key in _pending_cache_cleanups:
            return
        _pending_cache_cleanups.add(cleanup_key)

    def cleanup():
        try:
            while True:
                with _account_lock:
                    if _account_epochs.get(username, 0) != epoch:
                        return
                try:
                    with account_maintenance(username, timeout=1) as available:
                        if not available:
                            time.sleep(1)
                            continue
                        with _account_lock:
                            if _account_epochs.get(username, 0) != epoch:
                                return
                            clear_cached_user(username)
                            _clear_cache_cleanup_marker(username, creds_path)
                            return
                except Exception as exc:
                    logger.warning(
                        "Deferred cache cleanup failed (%s); retrying",
                        exc.__class__.__name__,
                    )
                    time.sleep(1)
        finally:
            with _account_lock:
                _pending_cache_cleanups.discard(cleanup_key)

    threading.Thread(
        target=cleanup,
        name="silentsuite-cache-cleanup",
        daemon=True,
    ).start()


def resume_pending_cache_cleanups(*, credentials=None):
    """Resume durable cache deletion intents after process restart."""
    creds = credentials or Credentials()
    for username in creds.list_cache_cleanups():
        _schedule_deferred_cache_cleanup(
            username,
            creds_path=getattr(creds, "filename", None),
        )


@dataclass(frozen=True)
class AccountOperationResult:
    """Result for local account mutations."""

    username: str
    existed: bool
    sync_stopped: bool = True
    cache_cleared: bool = False
    cache_cleanup: str = "not_requested"


def _normalize_username(username: str) -> str:
    normalized = (username or "").strip()
    if not normalized:
        raise ValueError("Account username is required")
    return normalized


def _password_hash(password: str) -> tuple[str, str]:
    salt = os.urandom(32)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, 600000,
    ).hex()
    return salt.hex(), password_hash


def _reload_credentials(credentials: Credentials) -> None:
    if getattr(credentials, "filename", None):
        credentials.load()


def store_authenticated_account(
    username: str,
    password: str,
    stored_session: str,
    server_url: str | None = None,
    *,
    credentials: Credentials | None = None,
) -> AccountOperationResult:
    """Add or update one authenticated account without touching others."""
    normalized = _normalize_username(username)
    if not password:
        raise ValueError("Account password is required")
    if server_url is None:
        server_url = config.ETEBASE_SERVER_URL

    with _account_lock:
        creds = credentials or Credentials()
        with CREDENTIALS_LOCK:
            _reload_credentials(creds)
            existed = normalized in creds.list_users()
            if existed:
                existing_server = creds.get_server_url(normalized)
                if existing_server and existing_server.rstrip("/") != server_url.rstrip("/"):
                    raise ValueError(
                        "An existing account cannot be moved to a different server"
                    )
        salt_hex, password_hash = _password_hash(password)
        if existed:
            stop_sync_thread(normalized)
        with CREDENTIALS_LOCK:
            _reload_credentials(creds)
            creds.set_etebase(normalized, stored_session, server_url)
            creds.set_password_salt(normalized, salt_hex)
            creds.set_password_hash(normalized, password_hash)
            creds.clear_cache_cleanup(normalized)
            creds.save()
            if existed:
                forget_etesync_user(normalized)
        _account_epochs[normalized] = _account_epochs.get(normalized, 0) + 1

    return AccountOperationResult(username=normalized, existed=existed)


def list_accounts(*, credentials: Credentials | None = None) -> list[str]:
    """Return configured account usernames."""
    with _account_lock:
        creds = credentials or Credentials()
        return creds.list_users()


def logout_account(
    username: str,
    *,
    credentials: Credentials | None = None,
    cache_cleanup_pending: bool = False,
) -> AccountOperationResult:
    """Remove local credential/session material while retaining cache rows."""
    normalized = _normalize_username(username)

    with _account_lock:
        creds = credentials or Credentials()
        with CREDENTIALS_LOCK:
            _reload_credentials(creds)
            existed = normalized in creds.list_users()

        sync_stopped = stop_sync_thread(normalized)
        from .web import forget_account_status

        forget_account_status(normalized)

        with CREDENTIALS_LOCK:
            _reload_credentials(creds)
            existed = normalized in creds.list_users()
            if existed:
                creds.delete(normalized)
            if cache_cleanup_pending:
                creds.mark_cache_cleanup(normalized)
            if existed or cache_cleanup_pending:
                creds.save()
            forget_etesync_user(normalized)

    return AccountOperationResult(
        username=normalized,
        existed=existed,
        sync_stopped=sync_stopped,
    )


def remove_account(
    username: str,
    *,
    credentials: Credentials | None = None,
) -> AccountOperationResult:
    """Remove local credentials plus that account's local decrypted cache."""
    normalized = _normalize_username(username)
    with _account_lock:
        creds_path = (
            getattr(credentials, "filename", None)
            if credentials is not None
            else config.CREDS_FILE
        )
        logout_result = logout_account(
            normalized,
            credentials=credentials,
            cache_cleanup_pending=True,
        )
        _account_epochs[normalized] = _account_epochs.get(normalized, 0) + 1
        with account_maintenance(normalized, timeout=0) as available:
            if available:
                try:
                    cache_cleared = clear_cached_user(normalized)
                except Exception as exc:
                    logger.warning(
                        "Immediate cache cleanup failed (%s); deferring",
                        exc.__class__.__name__,
                    )
                    cache_cleared = False
                    cache_cleanup = "deferred"
                    _schedule_deferred_cache_cleanup(
                        normalized,
                        creds_path=creds_path,
                    )
                else:
                    cache_cleanup = "cleared" if cache_cleared else "not_found"
                    _clear_cache_cleanup_marker(normalized, creds_path)
            else:
                cache_cleared = False
                cache_cleanup = "deferred"
                _schedule_deferred_cache_cleanup(
                    normalized,
                    creds_path=creds_path,
                )

    return AccountOperationResult(
        username=normalized,
        existed=logout_result.existed or cache_cleared or cache_cleanup == "deferred",
        sync_stopped=logout_result.sync_stopped,
        cache_cleared=cache_cleared,
        cache_cleanup=cache_cleanup,
    )
