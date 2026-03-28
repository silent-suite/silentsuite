"""Shared fixtures for SilentSuite Bridge tests.

Provides mock Etebase sessions, in-memory SQLite databases,
and mock credentials for testing without a real Etebase server.
"""

import sys
from unittest.mock import MagicMock

# Inject a mock etebase module before any silentsuite_bridge imports
import tests.mock_etebase as _mock_etebase
sys.modules.setdefault("etebase", _mock_etebase)

import threading
from unittest.mock import patch

import peewee as pw
import pytest

from silentsuite_bridge.local_cache import db, models


# ---------------------------------------------------------------------------
# In-memory SQLite database
# ---------------------------------------------------------------------------

@pytest.fixture()
def mem_db():
    """Initialise an in-memory Peewee database and create all tables."""
    database = pw.SqliteDatabase(":memory:", pragmas={"foreign_keys": 1})
    db.database_proxy.initialize(database)
    database.create_tables(
        [models.Config, models.User, models.CollectionEntity, models.ItemEntity, models.HrefMapper],
        safe=True,
    )
    models.Config.get_or_create(defaults={"db_version": 1})
    yield database
    database.close()


@pytest.fixture()
def user(mem_db):
    """Create a test User row."""
    return models.User.create(username="test@example.com")


# ---------------------------------------------------------------------------
# Mock Etebase objects
# ---------------------------------------------------------------------------

def _make_mock_item(uid, content, deleted=False, etag="etag-1", mtime=1700000000000):
    """Build a mock Etebase item (the SDK object, not the cache wrapper)."""
    item = MagicMock()
    item.uid = uid
    item.content = content.encode() if isinstance(content, str) else content
    item.deleted = deleted
    item.etag = etag
    item.meta = {"name": uid, "mtime": mtime}
    return item


def _make_mock_collection(uid, col_type, meta=None, stoken="stoken-1", deleted=False):
    """Build a mock Etebase collection (the SDK object)."""
    col = MagicMock()
    col.uid = uid
    col.collection_type = col_type
    col.stoken = stoken
    col.deleted = deleted
    col.meta = meta or {"name": f"Test {col_type}"}
    col.access_level = 0  # ReadWrite
    return col


@pytest.fixture()
def mock_col_mgr():
    """A mock CollectionManager that round-trips cache_save/cache_load."""
    mgr = MagicMock()
    _store = {}

    def cache_save(obj):
        key = id(obj)
        _store[key] = obj
        return key.to_bytes(8, "big")

    def cache_load(blob):
        key = int.from_bytes(blob, "big")
        return _store[key]

    mgr.cache_save.side_effect = cache_save
    mgr.cache_load.side_effect = cache_load
    return mgr


@pytest.fixture()
def mock_item_mgr(mock_col_mgr):
    """A mock ItemManager that round-trips cache_save/cache_load."""
    mgr = MagicMock()
    _store = {}

    def cache_save(obj):
        key = id(obj)
        _store[key] = obj
        return key.to_bytes(8, "big")

    def cache_load(blob):
        key = int.from_bytes(blob, "big")
        return _store[key]

    mgr.cache_save.side_effect = cache_save
    mgr.cache_load.side_effect = cache_load
    mock_col_mgr.get_item_manager.return_value = mgr
    return mgr


@pytest.fixture()
def mock_credentials():
    """Patch Credentials to return a fake stored session."""
    with patch("silentsuite_bridge.radicale.etesync_cache.Credentials") as MockCreds:
        creds = MagicMock()
        creds.get_etebase.return_value = "fake-stored-session"
        creds.get_server_url.return_value = "https://fake.server"
        creds.list_users.return_value = ["test@example.com"]
        MockCreds.return_value = creds
        yield creds


# ---------------------------------------------------------------------------
# Sample vObject data
# ---------------------------------------------------------------------------

SAMPLE_VCALENDAR_VEVENT = """\
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-uid-001
DTSTART:20240101T100000Z
DTEND:20240101T110000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR"""

SAMPLE_VCALENDAR_VTODO = """\
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTODO
UID:todo-uid-001
SUMMARY:Test Task
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR"""

SAMPLE_VCARD = """\
BEGIN:VCARD
VERSION:3.0
UID:contact-uid-001
FN:Jane Doe
N:Doe;Jane;;;
EMAIL:jane@example.com
END:VCARD"""
