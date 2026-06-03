"""Account-management helpers for SilentSuite Bridge."""

from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass

from . import config
from .local_cache import clear_cached_user
from .radicale.creds import Credentials
from .radicale.etesync_cache import forget_etesync_user
from .radicale.storage import stop_sync_thread


_account_lock = threading.RLock()


@dataclass(frozen=True)
class AccountOperationResult:
    """Result for local account mutations."""

    username: str
    existed: bool
    sync_stopped: bool = True
    cache_cleared: bool = False


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
        existed = normalized in creds.list_users()
        salt_hex, password_hash = _password_hash(password)
        creds.set_etebase(normalized, stored_session, server_url)
        creds.set_password_salt(normalized, salt_hex)
        creds.set_password_hash(normalized, password_hash)
        creds.save()

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
) -> AccountOperationResult:
    """Remove local credential/session material while retaining cache rows."""
    normalized = _normalize_username(username)

    with _account_lock:
        creds = credentials or Credentials()
        existed = normalized in creds.list_users()

        sync_stopped = stop_sync_thread(normalized)
        forget_etesync_user(normalized)

        if existed:
            creds.delete(normalized)
            creds.save()

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
    logout_result = logout_account(normalized, credentials=credentials)
    cache_cleared = clear_cached_user(normalized)

    return AccountOperationResult(
        username=normalized,
        existed=logout_result.existed or cache_cleared,
        sync_stopped=logout_result.sync_stopped,
        cache_cleared=cache_cleared,
    )
