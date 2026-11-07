"""BRIDGE-02: credential replacement and account removal on an existing file.

Real ``Credentials.save`` (temp file + ``os.rename``) and the real
``accounts.remove_account`` -> ``logout_account`` path. Rename and save are not
mocked. Each persisted outcome is observed through a fresh ``Credentials(path)``
read. Cache deletion is the real ``clear_cached_user`` against the conftest
``mem_db`` in-memory SQLite database.

Call order inside ``logout_account``: ``stop_sync_thread`` and
``forget_account_status`` run before the save; ``forget_etesync_user`` runs
after it. No live sync thread is registered, so the real helpers are used
unstubbed.

Platform: this one file runs on both Windows (selected explicitly by the
Windows workflow) and Linux (collected from ``tests/``). On Linux, POSIX
``os.rename`` overwrites, so the expected-correct assertions are the passing
control there. The platform is recorded in every test id. No skip, no xfail.

The ``etebase`` SDK is the conftest mock (``tests/mock_etebase.py``); this case
does not exercise the SDK.
"""

import os
import sys

import pytest

from silentsuite_bridge import accounts, config
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    HrefMapper,
    ItemEntity,
    User,
)
from silentsuite_bridge.radicale.creds import Credentials

PLATFORM_RECEIPT = (
    f"BRIDGE-02-{os.name}-{sys.platform}-py{sys.version_info[0]}.{sys.version_info[1]}"
)
platform_receipt = pytest.mark.parametrize(
    "receipt", [PLATFORM_RECEIPT], ids=[PLATFORM_RECEIPT]
)

USER_U = "u-remove@example.test"
USER_V = "v-keep@example.test"
SERVER = "https://server.invalid"


def _credentials_path(tmp_path):
    # The directory does not exist yet, so the first save also creates it.
    return str(tmp_path / "bridge-data" / "credentials.json")


def _tmp_leftovers(path):
    directory = os.path.dirname(path)
    if not os.path.isdir(directory):
        return []
    return sorted(name for name in os.listdir(directory) if name.endswith(".tmp"))


def _seed_both_and_save_once(path):
    """Seed U and V in memory, then persist them with ONE initial save."""
    creds = Credentials(path)
    for username, session in ((USER_U, "u1"), (USER_V, "v1")):
        creds.set_etebase(username, session, SERVER)
        creds.set_password_salt(username, "00" * 32)
        creds.set_password_hash(username, "11" * 32)
    creds.save()
    return creds


def _seed_cache_rows(username):
    user = User.create(username=username)
    col = CollectionEntity.create(local_user=user, uid=f"{username}-col", eb_col=b"col")
    item = ItemEntity.create(collection=col, uid=f"{username}-item", eb_item=b"item")
    HrefMapper.create(content=item, href=f"{username}.ics")


def _cache_user_rows(username):
    return User.select().where(User.username == username).count()


def _error(exc):
    return None if exc is None else type(exc).__name__


@platform_receipt
def test_BRIDGE_02_first_save_creates_file_control(tmp_path, receipt):
    path = _credentials_path(tmp_path)
    error = None
    try:
        _seed_both_and_save_once(path)
    except Exception as exc:  # recorded, never swallowed: asserted below
        error = exc

    fresh = Credentials(path)
    observed = {
        "error": _error(error),
        "u_session": fresh.get_etebase(USER_U),
        "v_session": fresh.get_etebase(USER_V),
        "tmp_leftovers": _tmp_leftovers(path),
    }
    assert observed == {
        "error": None,
        "u_session": "u1",
        "v_session": "v1",
        "tmp_leftovers": [],
    }, f"{receipt}: {observed!r} ({error!r})"


@platform_receipt
def test_BRIDGE_02_second_save_replaces_existing_file(tmp_path, receipt):
    path = _credentials_path(tmp_path)
    creds = _seed_both_and_save_once(path)
    assert os.path.isfile(path), f"{receipt}: fixture precondition: initial save did not create the file"

    creds.set_etebase(USER_U, "s2", SERVER)
    error = None
    try:
        creds.save()
    except Exception as exc:  # recorded, never swallowed: asserted below
        error = exc

    fresh = Credentials(path)
    observed = {
        "error": _error(error),
        "u_session": fresh.get_etebase(USER_U),
        "v_session": fresh.get_etebase(USER_V),
        "tmp_leftovers": _tmp_leftovers(path),
    }
    assert observed == {
        "error": None,
        "u_session": "s2",
        "v_session": "v1",
        "tmp_leftovers": [],
    }, f"{receipt}: {observed!r} ({error!r})"


@platform_receipt
def test_BRIDGE_02_remove_account_clears_credentials_and_cache(
    tmp_path, monkeypatch, mem_db, receipt
):
    path = _credentials_path(tmp_path)
    monkeypatch.setattr(config, "CREDS_FILE", path)
    monkeypatch.setattr(config, "DATABASE_FILE", str(tmp_path / "unused-cache.sqlite"))

    _seed_cache_rows(USER_U)
    _seed_cache_rows(USER_V)
    _seed_both_and_save_once(path)
    assert os.path.isfile(path), f"{receipt}: fixture precondition: initial save did not create the file"
    assert (_cache_user_rows(USER_U), _cache_user_rows(USER_V)) == (1, 1), (
        f"{receipt}: fixture precondition: synthetic cache rows not seeded"
    )

    error = None
    try:
        accounts.remove_account(USER_U, credentials=Credentials(path))
    except Exception as exc:  # recorded, never swallowed: asserted below
        error = exc

    fresh = Credentials(path)
    observed = {
        "error": _error(error),
        "users": fresh.list_users(),
        "pending_cleanup": fresh.list_cache_cleanups(),
        "u_cache_rows": _cache_user_rows(USER_U),
        "v_cache_rows": _cache_user_rows(USER_V),
        "tmp_leftovers": _tmp_leftovers(path),
    }
    assert observed == {
        "error": None,
        "users": [USER_V],
        "pending_cleanup": [],
        "u_cache_rows": 0,
        "v_cache_rows": 1,
        "tmp_leftovers": [],
    }, f"{receipt}: {observed!r} ({error!r})"
