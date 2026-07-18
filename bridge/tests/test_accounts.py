"""Tests for bridge account-management helpers."""

import threading
from contextlib import contextmanager

from silentsuite_bridge import accounts, config
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    HrefMapper,
    ItemEntity,
    User,
)
from silentsuite_bridge.radicale.auth import Auth
from silentsuite_bridge.radicale.creds import Credentials

PASSWORD = "correct horse battery staple"


def _radicale_config_stub():
    from unittest.mock import MagicMock

    cfg = MagicMock()
    cfg.get.side_effect = lambda section, key: False
    return cfg


def _configure_creds(tmp_path, monkeypatch):
    path = tmp_path / "creds.json"
    monkeypatch.setattr(config, "CREDS_FILE", str(path))
    return path


def _seed_cache(username):
    user = User.create(username=username)
    col = CollectionEntity.create(local_user=user, uid=f"{username}-col", eb_col=b"col")
    item = ItemEntity.create(collection=col, uid=f"{username}-item", eb_item=b"item")
    HrefMapper.create(content=item, href=f"{username}.ics")
    return user


def test_store_authenticated_account_adds_second_account(tmp_path, monkeypatch):
    _configure_creds(tmp_path, monkeypatch)

    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server-a.test",
    )
    accounts.store_authenticated_account(
        "bob@example.com", PASSWORD, "bob-session", "https://server-b.test",
    )

    creds = Credentials()
    assert creds.list_users() == ["alice@example.com", "bob@example.com"]
    assert creds.get_etebase("alice@example.com") == "alice-session"
    assert creds.get_etebase("bob@example.com") == "bob-session"
    assert creds.get_server_url("bob@example.com") == "https://server-b.test"


def test_store_authenticated_account_reauth_updates_one_account(tmp_path, monkeypatch):
    _configure_creds(tmp_path, monkeypatch)

    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "old-session", "https://old.test",
    )
    old_hash = Credentials().get_password_hash("alice@example.com")

    result = accounts.store_authenticated_account(
        " alice@example.com ", "new password", "new-session", "https://new.test",
    )

    creds = Credentials()
    assert result.existed is True
    assert creds.list_users() == ["alice@example.com"]
    assert creds.get_etebase("alice@example.com") == "new-session"
    assert creds.get_server_url("alice@example.com") == "https://new.test"
    assert creds.get_password_hash("alice@example.com") != old_hash


def test_logout_one_of_two_preserves_other_credentials_and_cache(
    tmp_path, monkeypatch, mem_db,
):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: True)
    forgotten = []
    monkeypatch.setattr(accounts, "forget_etesync_user", forgotten.append)

    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server.test",
    )
    accounts.store_authenticated_account(
        "bob@example.com", PASSWORD, "bob-session", "https://server.test",
    )
    _seed_cache("alice@example.com")

    result = accounts.logout_account("alice@example.com")

    creds = Credentials()
    assert result.existed is True
    assert creds.list_users() == ["bob@example.com"]
    assert User.get_or_none(User.username == "alice@example.com") is not None
    assert forgotten == ["alice@example.com"]


def test_remove_account_deletes_only_that_users_cache(tmp_path, monkeypatch, mem_db):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)

    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server.test",
    )
    accounts.store_authenticated_account(
        "bob@example.com", PASSWORD, "bob-session", "https://server.test",
    )
    _seed_cache("alice@example.com")
    _seed_cache("bob@example.com")

    result = accounts.remove_account("alice@example.com")

    creds = Credentials()
    assert result.existed is True
    assert result.cache_cleared is True
    assert creds.list_users() == ["bob@example.com"]
    assert User.get_or_none(User.username == "alice@example.com") is None
    assert User.get_or_none(User.username == "bob@example.com") is not None
    assert Auth(_radicale_config_stub()).login("bob@example.com", PASSWORD) == "bob@example.com"


def test_remove_account_reports_deferred_cache_cleanup(tmp_path, monkeypatch, mem_db):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: False)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)

    @contextmanager
    def unavailable_maintenance(user, timeout=0):
        yield False

    monkeypatch.setattr(accounts, "account_maintenance", unavailable_maintenance)
    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server.test",
    )
    _seed_cache("alice@example.com")

    result = accounts.remove_account("alice@example.com")

    assert result.existed is True
    assert result.sync_stopped is False
    assert result.cache_cleared is False
    assert result.cache_cleanup == "deferred"
    assert Credentials().list_users() == []
    assert User.get_or_none(User.username == "alice@example.com") is not None


def test_deferred_cache_cleanup_retries_after_maintenance_becomes_available(monkeypatch):
    cleaned = threading.Event()

    @contextmanager
    def available_maintenance(user, timeout=0):
        assert timeout is None
        yield True

    monkeypatch.setattr(accounts, "account_maintenance", available_maintenance)
    monkeypatch.setattr(
        accounts,
        "clear_cached_user",
        lambda user: cleaned.set() or True,
    )
    accounts._pending_cache_cleanups.clear()

    accounts._schedule_deferred_cache_cleanup("alice@example.com")

    assert cleaned.wait(1)


def test_deferred_cleanup_is_cancelled_by_same_account_reauthentication(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    cleared = threading.Event()
    username = "alice@example.com"

    @contextmanager
    def blocked_maintenance(user, timeout=0):
        entered.set()
        assert release.wait(1)
        yield True

    monkeypatch.setattr(accounts, "account_maintenance", blocked_maintenance)
    monkeypatch.setattr(accounts, "clear_cached_user", lambda user: cleared.set())
    accounts._pending_cache_cleanups.clear()
    accounts._account_epochs[username] = 1
    accounts._schedule_deferred_cache_cleanup(username)
    assert entered.wait(1)

    with accounts._account_lock:
        accounts._account_epochs[username] = 2
    release.set()

    assert not cleared.wait(0.1)


def test_deferred_cleanup_retries_transient_failure(monkeypatch):
    cleaned = threading.Event()
    attempts = 0

    @contextmanager
    def available_maintenance(user, timeout=0):
        yield True

    def flaky_clear(user):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("transient")
        cleaned.set()
        return True

    monkeypatch.setattr(accounts, "account_maintenance", available_maintenance)
    monkeypatch.setattr(accounts, "clear_cached_user", flaky_clear)
    monkeypatch.setattr(accounts.time, "sleep", lambda seconds: None)
    accounts._pending_cache_cleanups.clear()
    accounts._account_epochs["retry@example.com"] = 1

    accounts._schedule_deferred_cache_cleanup("retry@example.com")

    assert cleaned.wait(1)
    assert attempts == 2


def test_repeated_remove_truthfully_reports_deferred_cleanup(monkeypatch):
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: False)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)
    monkeypatch.setattr(accounts, "_schedule_deferred_cache_cleanup", lambda user: None)

    @contextmanager
    def unavailable_maintenance(user, timeout=0):
        yield False

    monkeypatch.setattr(accounts, "account_maintenance", unavailable_maintenance)
    credentials = Credentials.__new__(Credentials)
    credentials._creds = {}
    credentials.list_users = lambda: []
    credentials.delete = lambda user: None
    credentials.save = lambda: None

    result = accounts.remove_account(
        "missing@example.com",
        credentials=credentials,
    )

    assert result.existed is True
    assert result.cache_cleanup == "deferred"


def test_remove_missing_account_is_noop(tmp_path, monkeypatch, mem_db):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)
    accounts.store_authenticated_account(
        "bob@example.com", PASSWORD, "bob-session", "https://server.test",
    )
    _seed_cache("bob@example.com")

    result = accounts.remove_account("ghost@example.com")

    assert result.existed is False
    assert Credentials().list_users() == ["bob@example.com"]
    assert User.get_or_none(User.username == "bob@example.com") is not None


def test_remove_last_account_leaves_no_configured_users(tmp_path, monkeypatch, mem_db):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)
    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server.test",
    )
    _seed_cache("alice@example.com")

    accounts.remove_account("alice@example.com")

    assert Credentials().list_users() == []
    assert User.get_or_none(User.username == "alice@example.com") is None
