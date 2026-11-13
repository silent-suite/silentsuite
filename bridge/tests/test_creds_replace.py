"""Credential-store overwrite and account-removal lifecycle regressions (BRIDGE-02).

``Credentials.save`` writes a temporary file and moves it over ``credentials.json``.
On Windows, ``os.rename`` raises ``FileExistsError`` when the destination already
exists, so every save after the first one fails there: re-authentication, adding a
second account, logout and removal (including its durable cache-cleanup marker).

Two modes are exercised with the real production code paths:

* ``native``: no patching. On Linux/macOS this is a passing control; it is not
  Windows evidence. Run natively on Windows, it exposes the platform's actual
  overwrite behaviour.
* ``simulated_windows_overwrite``: a POSIX-portable simulation of the Windows
  ``os.rename`` rule, scoped to this fixture's credential destination only. Every
  other rename is forwarded to the real ``os.rename`` unchanged.

All accounts, sessions and passwords are synthetic, and every path lives under the
test's own temporary directory.
"""

import errno
import os
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

PASSWORD = "synthetic correct horse battery staple"
ALICE = "alice@example.com"
BOB = "bob@example.com"
SERVER = "https://server.test"

NATIVE = "native"
SIMULATED = "simulated_windows_overwrite"


def _radicale_config_stub():
    from unittest.mock import MagicMock

    cfg = MagicMock()
    cfg.get.side_effect = lambda section, key: False
    return cfg


def _seed_cache(username):
    user = User.create(username=username)
    col = CollectionEntity.create(local_user=user, uid=f"{username}-col", eb_col=b"col")
    item = ItemEntity.create(collection=col, uid=f"{username}-item", eb_item=b"item")
    HrefMapper.create(content=item, href=f"{username}.ics")
    return user


def _temporary_leftovers(directory):
    return sorted(path.name for path in directory.iterdir() if path.name.endswith(".tmp"))


@pytest.fixture()
def creds_path(tmp_path, monkeypatch):
    """Isolated credential destination, also used by production default lookups."""
    directory = tmp_path / "bridge-data"
    directory.mkdir()
    path = directory / "credentials.json"
    monkeypatch.setattr(config, "CREDS_FILE", str(path))
    return path


@pytest.fixture()
def isolated_account_state(monkeypatch):
    """Keep module-level removal bookkeeping from leaking between tests."""
    monkeypatch.setattr(accounts, "_account_epochs", {})
    monkeypatch.setattr(accounts, "_pending_cache_cleanups", set())
    monkeypatch.setattr(accounts, "stop_sync_thread", lambda _user: True)
    monkeypatch.setattr(accounts, "forget_etesync_user", lambda _user: None)


def _simulate_windows_overwrite(monkeypatch, destination):
    """POSIX-portable simulation of Windows ``os.rename`` onto an existing file.

    Only renames whose destination is this fixture's credential file are
    affected; all other renames go to the real ``os.rename``. The patch is scoped
    to the test through ``monkeypatch`` and restored afterwards.
    """
    real_rename = os.rename
    guarded = os.path.abspath(os.fspath(destination))

    def rename(src, dst, *args, **kwargs):
        if (
            os.path.abspath(os.fspath(dst)) == guarded
            and os.path.exists(guarded)
        ):
            raise FileExistsError(
                errno.EEXIST,
                "simulated Windows rename onto an existing file",
                os.fspath(dst),
            )
        return real_rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "rename", rename)


def _apply_mode(mode, monkeypatch, destination):
    if mode == SIMULATED:
        _simulate_windows_overwrite(monkeypatch, destination)


def _store_two_accounts():
    accounts.store_authenticated_account(ALICE, PASSWORD, "alice-session", SERVER)
    accounts.store_authenticated_account(BOB, PASSWORD, "bob-session", SERVER)


def _seed_two_accounts_with_one_first_save(destination):
    """Setup only: seed both accounts with production setters and ONE save.

    The destination does not exist yet, so this first save is valid on every
    platform, including unchanged Windows. Seeding through two
    ``store_authenticated_account`` calls would already need an overwrite and
    fail during setup on native Windows, before the removal under test runs.
    The password material comes from the production ``_password_hash`` helper,
    so ``Auth.login`` checks real stored hashes. Nothing is patched here, and
    this setup earns no credit for the overwrite behaviour under test.
    """
    assert not destination.exists()
    creds = Credentials(str(destination))
    for username, session in ((ALICE, "alice-session"), (BOB, "bob-session")):
        salt_hex, password_hash = accounts._password_hash(PASSWORD)
        creds.set_etebase(username, session, SERVER)
        creds.set_password_salt(username, salt_hex)
        creds.set_password_hash(username, password_hash)
    creds.save()
    seeded = Credentials(str(destination))
    assert seeded.list_users() == [ALICE, BOB]
    assert seeded.list_cache_cleanups() == []


# ---------------------------------------------------------------------------
# Simulation sanity: proves the simulated rule is active and narrowly scoped
# ---------------------------------------------------------------------------


def _rename_outcome(rename, directory):
    """Rename onto an existing unrelated file; return (error type, dst text, src kept)."""
    directory.mkdir()
    src = directory / "src"
    dst = directory / "dst"
    src.write_text("new")
    dst.write_text("old")
    try:
        rename(src, dst)
        error = None
    except OSError as exc:
        error = type(exc)
    return error, dst.read_text(), src.exists()


def test_simulation_rejects_only_renames_onto_existing_fixture_destination(
    tmp_path, creds_path, monkeypatch,
):
    # Reference outcome of the platform's own rename onto an existing unrelated
    # file, taken before the simulation is installed: success on POSIX,
    # FileExistsError on native Windows.
    real_outcome = _rename_outcome(os.rename, tmp_path / "real")

    _simulate_windows_overwrite(monkeypatch, creds_path)

    first = creds_path.parent / "first.tmp"
    first.write_text("first")
    os.rename(first, creds_path)
    assert creds_path.read_text() == "first"

    second = creds_path.parent / "second.tmp"
    second.write_text("second")
    with pytest.raises(FileExistsError):
        os.rename(second, creds_path)
    assert creds_path.read_text() == "first"
    second.unlink()

    # Unrelated renames are forwarded unchanged: onto a new path they succeed on
    # every platform, and onto an existing file they behave exactly as the
    # platform's real rename did above.
    fresh_src = tmp_path / "fresh-src"
    fresh_dst = tmp_path / "fresh-dst"
    fresh_src.write_text("fresh")
    os.rename(fresh_src, fresh_dst)
    assert fresh_dst.read_text() == "fresh"
    assert not fresh_src.exists()

    assert _rename_outcome(os.rename, tmp_path / "forwarded") == real_outcome


# ---------------------------------------------------------------------------
# Credentials.save overwrite
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", [NATIVE, SIMULATED])
def test_first_save_creates_credentials_without_leftovers(creds_path, monkeypatch, mode):
    _apply_mode(mode, monkeypatch, creds_path)

    creds = Credentials(str(creds_path))
    creds.set_etebase(ALICE, "alice-session", SERVER)
    creds.save()

    reloaded = Credentials(str(creds_path))
    assert reloaded.list_users() == [ALICE]
    assert reloaded.get_etebase(ALICE) == "alice-session"
    assert _temporary_leftovers(creds_path.parent) == []


@pytest.mark.parametrize("mode", [NATIVE, SIMULATED])
def test_second_save_overwrites_existing_credentials(creds_path, monkeypatch, mode):
    _apply_mode(mode, monkeypatch, creds_path)

    creds = Credentials(str(creds_path))
    creds.set_etebase(ALICE, "alice-session", SERVER)
    creds.save()
    assert Credentials(str(creds_path)).get_etebase(ALICE) == "alice-session"

    creds.set_etebase(ALICE, "alice-rotated-session", SERVER)
    creds.set_etebase(BOB, "bob-session", SERVER)
    creds.save()

    reloaded = Credentials(str(creds_path))
    assert reloaded.list_users() == [ALICE, BOB]
    assert reloaded.get_etebase(ALICE) == "alice-rotated-session"
    assert reloaded.get_etebase(BOB) == "bob-session"
    assert _temporary_leftovers(creds_path.parent) == []


@pytest.mark.parametrize("mode", [NATIVE, SIMULATED])
def test_adding_second_account_persists_both(
    creds_path, monkeypatch, isolated_account_state, mode,
):
    _apply_mode(mode, monkeypatch, creds_path)

    _store_two_accounts()

    creds = Credentials(str(creds_path))
    assert creds.list_users() == [ALICE, BOB]
    assert creds.get_etebase(ALICE) == "alice-session"
    assert creds.get_etebase(BOB) == "bob-session"
    assert _temporary_leftovers(creds_path.parent) == []


# ---------------------------------------------------------------------------
# Account removal through the real production path
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", [NATIVE, SIMULATED])
def test_remove_account_clears_target_and_preserves_sibling(
    creds_path, monkeypatch, mem_db, isolated_account_state, mode,
):
    # Setup seeds both accounts with one first save; the mode applies only to
    # the removal under test, which must overwrite the existing file.
    _seed_two_accounts_with_one_first_save(creds_path)
    _seed_cache(ALICE)
    _seed_cache(BOB)
    _apply_mode(mode, monkeypatch, creds_path)

    result = accounts.remove_account(ALICE)

    creds = Credentials(str(creds_path))
    assert result.existed is True
    assert result.cache_cleared is True
    assert result.cache_cleanup == "cleared"
    assert creds.list_users() == [BOB]
    assert creds.get_etebase(ALICE) is None
    assert creds.get_password_hash(ALICE) is None
    assert creds.list_cache_cleanups() == []
    assert User.get_or_none(User.username == ALICE) is None
    assert creds.get_etebase(BOB) == "bob-session"
    assert User.get_or_none(User.username == BOB) is not None
    assert Auth(_radicale_config_stub()).login(BOB, PASSWORD) == BOB
    assert _temporary_leftovers(creds_path.parent) == []


@pytest.mark.parametrize("mode", [NATIVE, SIMULATED])
def test_deferred_cache_cleanup_is_durable_and_resumes(
    creds_path, monkeypatch, mem_db, isolated_account_state, mode,
):
    # Same single-first-save setup; the removal and resume saves are under test.
    _seed_two_accounts_with_one_first_save(creds_path)
    _seed_cache(ALICE)
    _seed_cache(BOB)
    _apply_mode(mode, monkeypatch, creds_path)

    maintenance_available = {"value": False}
    scheduled = []

    @contextmanager
    def switchable_maintenance(_user, timeout=0):
        yield maintenance_available["value"]

    monkeypatch.setattr(accounts, "account_maintenance", switchable_maintenance)
    monkeypatch.setattr(
        accounts,
        "_schedule_deferred_cache_cleanup",
        lambda user, **kwargs: scheduled.append(user),
    )

    result = accounts.remove_account(ALICE)

    # Credentials are gone and the cleanup intent is durable on disk; the cache
    # stays until maintenance is available.
    assert result.cache_cleared is False
    assert result.cache_cleanup == "deferred"
    assert scheduled == [ALICE]
    after_remove = Credentials(str(creds_path))
    assert after_remove.list_users() == [BOB]
    assert after_remove.list_cache_cleanups() == [ALICE]
    assert User.get_or_none(User.username == ALICE) is not None
    assert User.get_or_none(User.username == BOB) is not None

    maintenance_available["value"] = True
    assert accounts.resume_pending_cache_cleanups(
        credentials=Credentials(str(creds_path))
    ) is True

    resumed = Credentials(str(creds_path))
    assert resumed.list_cache_cleanups() == []
    assert resumed.list_users() == [BOB]
    assert resumed.get_etebase(BOB) == "bob-session"
    assert User.get_or_none(User.username == ALICE) is None
    assert User.get_or_none(User.username == BOB) is not None
    assert Auth(_radicale_config_stub()).login(BOB, PASSWORD) == BOB
    assert _temporary_leftovers(creds_path.parent) == []
