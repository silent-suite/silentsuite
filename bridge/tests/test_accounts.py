"""Tests for bridge account-management helpers."""

import threading
from contextlib import contextmanager

import pytest

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
    stopped = []
    forgotten = []
    monkeypatch.setattr(accounts, "stop_sync_thread", stopped.append)
    monkeypatch.setattr(accounts, "forget_etesync_user", forgotten.append)

    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "old-session", "https://server.test",
    )
    old_hash = Credentials().get_password_hash("alice@example.com")

    result = accounts.store_authenticated_account(
        " alice@example.com ", "new password", "new-session", "https://server.test/",
    )

    creds = Credentials()
    assert result.existed is True
    assert creds.list_users() == ["alice@example.com"]
    assert creds.get_etebase("alice@example.com") == "new-session"
    assert creds.get_server_url("alice@example.com") == "https://server.test/"
    assert creds.get_password_hash("alice@example.com") != old_hash
    assert stopped == ["alice@example.com"]
    assert forgotten == ["alice@example.com"]


def test_reauth_hashes_replacement_before_invalidating_old_session(tmp_path, monkeypatch):
    _configure_creds(tmp_path, monkeypatch)
    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "old-session", "https://server.test",
    )
    invalidated = []
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda _user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", invalidated.append)

    def replacement_hash(_password):
        assert invalidated == []
        return "salt", "hash"

    monkeypatch.setattr(accounts, "_password_hash", replacement_hash)

    accounts.store_authenticated_account(
        "alice@example.com",
        "replacement-password",
        "new-session",
        "https://server.test",
    )

    assert invalidated == ["alice@example.com"]
    assert Credentials().get_etebase("alice@example.com") == "new-session"


def test_reauth_rejects_server_change_without_touching_existing_account(
    tmp_path, monkeypatch,
):
    _configure_creds(tmp_path, monkeypatch)
    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "old-session", "https://old.test",
    )

    with pytest.raises(ValueError, match="different server"):
        accounts.store_authenticated_account(
            "alice@example.com", "new password", "new-session", "https://new.test",
        )

    creds = Credentials()
    assert creds.get_etebase("alice@example.com") == "old-session"
    assert creds.get_server_url("alice@example.com") == "https://old.test"


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
    assert Credentials().list_cache_cleanups() == ["alice@example.com"]
    assert User.get_or_none(User.username == "alice@example.com") is not None


def test_remove_account_persists_cleanup_after_immediate_failure(
    tmp_path, monkeypatch, mem_db
):
    _configure_creds(tmp_path, monkeypatch)
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda user: None)
    monkeypatch.setattr(
        accounts,
        "clear_cached_user",
        lambda user: (_ for _ in ()).throw(RuntimeError("database unavailable")),
    )
    monkeypatch.setattr(
        accounts,
        "_schedule_deferred_cache_cleanup",
        lambda *args, **kwargs: None,
    )
    accounts.store_authenticated_account(
        "alice@example.com", PASSWORD, "alice-session", "https://server.test"
    )
    _seed_cache("alice@example.com")

    result = accounts.remove_account("alice@example.com")

    assert result.cache_cleanup == "deferred"
    assert Credentials().list_users() == []
    assert Credentials().list_cache_cleanups() == ["alice@example.com"]
    assert User.get_or_none(User.username == "alice@example.com") is not None


def test_resume_pending_cleanup_runs_synchronously_before_startup_exit(
    tmp_path, monkeypatch
):
    creds_path = _configure_creds(tmp_path, monkeypatch)
    creds = Credentials(str(creds_path))
    creds.mark_cache_cleanup("alice@example.com")
    creds.save()
    cleared = []

    @contextmanager
    def available_maintenance(username, timeout=0):
        yield True

    monkeypatch.setattr(accounts, "account_maintenance", available_maintenance)
    monkeypatch.setattr(
        accounts,
        "clear_cached_user",
        lambda username: cleared.append(username) or True,
    )

    assert accounts.resume_pending_cache_cleanups(
        credentials=Credentials(str(creds_path))
    ) is True

    assert cleared == ["alice@example.com"]
    assert Credentials(str(creds_path)).list_cache_cleanups() == []


def test_deferred_cache_cleanup_retries_after_maintenance_becomes_available(monkeypatch):
    cleaned = threading.Event()

    @contextmanager
    def available_maintenance(user, timeout=0):
        assert timeout == 1
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
    monkeypatch.setattr(
        accounts,
        "_schedule_deferred_cache_cleanup",
        lambda user, **kwargs: None,
    )

    @contextmanager
    def unavailable_maintenance(user, timeout=0):
        yield False

    monkeypatch.setattr(accounts, "account_maintenance", unavailable_maintenance)
    credentials = Credentials.__new__(Credentials)
    credentials._creds = {}
    credentials.content = {"users": {}}
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


def test_remove_and_reauthentication_share_one_lock_order(tmp_path, monkeypatch):
    _configure_creds(tmp_path, monkeypatch)
    seeded = Credentials()
    seeded.set_etebase("race@example.com", "old-session", "https://example.test")
    seeded.set_password_salt("race@example.com", "00")
    seeded.set_password_hash("race@example.com", "11")
    seeded.save()

    store_has_credentials_lock = threading.Event()
    remove_reached_logout = threading.Event()
    original_normalize = accounts._normalize_username
    original_logout = accounts.logout_account

    def normalize_with_store_pause(username):
        if threading.current_thread().name == "store-account":
            store_has_credentials_lock.set()
            remove_reached_logout.wait(0.25)
        return original_normalize(username)

    def logout_probe(*args, **kwargs):
        remove_reached_logout.set()
        return original_logout(*args, **kwargs)

    @contextmanager
    def maintenance_available(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(accounts, "_normalize_username", normalize_with_store_pause)
    monkeypatch.setattr(accounts, "logout_account", logout_probe)
    monkeypatch.setattr(accounts, "_password_hash", lambda _password: ("22", "33"))
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda _username: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda _username: None)
    monkeypatch.setattr(accounts, "clear_cached_user", lambda _username: False)
    monkeypatch.setattr(accounts, "account_maintenance", maintenance_available)

    store_thread = threading.Thread(
        name="store-account",
        daemon=True,
        target=accounts.store_authenticated_account,
        args=(
            "race@example.com",
            "new-password",
            "new-session",
            "https://example.test",
        ),
    )
    remove_thread = threading.Thread(
        name="remove-account",
        daemon=True,
        target=accounts.remove_account,
        args=("race@example.com",),
    )

    store_thread.start()
    assert store_has_credentials_lock.wait(1)
    remove_thread.start()
    store_thread.join(2)
    remove_thread.join(2)

    assert not store_thread.is_alive()
    assert not remove_thread.is_alive()
