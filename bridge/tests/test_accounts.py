"""Tests for bridge account-management helpers."""

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
