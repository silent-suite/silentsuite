"""Tests for the Radicale storage backend."""

import threading
from contextlib import contextmanager
from unittest.mock import MagicMock, patch, PropertyMock

import pytest
from radicale.storage import ComponentNotFoundError
import vobject

from silentsuite_bridge.local_cache import models, db
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    ItemEntity,
    HrefMapper,
    User,
)
from silentsuite_bridge.radicale.storage import (
    Collection,
    MetaMapping,
    MetaMappingCalendar,
    MetaMappingContacts,
    MetaMappingTaskList,
    Storage,
    _get_attributes_from_path,
)
from tests.conftest import (
    SAMPLE_VCALENDAR_VEVENT,
    SAMPLE_VCALENDAR_VTODO,
    SAMPLE_VCARD,
    _make_mock_collection,
    _make_mock_item,
)


# ---------------------------------------------------------------------------
# Path utilities
# ---------------------------------------------------------------------------


class TestPathAttributes:
    def test_root(self):
        assert _get_attributes_from_path("/") == []

    def test_user(self):
        assert _get_attributes_from_path("/user@test.com") == ["user@test.com"]

    def test_collection(self):
        assert _get_attributes_from_path("/user@test.com/col-uid") == [
            "user@test.com",
            "col-uid",
        ]

    def test_item(self):
        assert _get_attributes_from_path("/user@test.com/col-uid/item.ics") == [
            "user@test.com",
            "col-uid",
            "item.ics",
        ]


# ---------------------------------------------------------------------------
# MetaMapping
# ---------------------------------------------------------------------------


class TestMetaMapping:
    def test_displayname_mapping(self):
        m = MetaMappingCalendar()
        key, val = m.map_get({"name": "My Calendar"}, "D:displayname")
        assert val == "My Calendar"

    def test_calendar_description(self):
        m = MetaMappingCalendar()
        key, val = m.map_get({"description": "Work events"}, "C:calendar-description")
        assert val == "Work events"

    def test_calendar_color(self):
        m = MetaMappingCalendar()
        key, val = m.map_get({"color": "#FF0000"}, "ICAL:calendar-color")
        assert val == "#FF0000"

    def test_contacts_description(self):
        m = MetaMappingContacts()
        key, val = m.map_get({"description": "My contacts"}, "CR:addressbook-description")
        assert val == "My contacts"

    def test_supported_component_vevent(self):
        m = MetaMappingCalendar()
        _, val = m.map_get({}, "C:supported-calendar-component-set")
        assert val == "VEVENT"

    def test_supported_component_vtodo(self):
        m = MetaMappingTaskList()
        _, val = m.map_get({}, "C:supported-calendar-component-set")
        assert val == "VTODO"

    def test_map_set_displayname(self):
        m = MetaMappingCalendar()
        key, val = m.map_set("D:displayname", "New Name")
        assert key == "name"
        assert val == "New Name"

    def test_map_set_color(self):
        m = MetaMappingCalendar()
        key, val = m.map_set("ICAL:calendar-color", "#00FF00")
        assert key == "color"
        assert val == "#00FF00"


# ---------------------------------------------------------------------------
# acquire_lock — sync is forced on every client request
# ---------------------------------------------------------------------------


class TestAcquireLockForcesSync:
    """Verify that acquire_lock calls force_sync, not request_sync."""

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_acquire_lock_calls_force_sync(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user="test@example.com"):
            pass

        mock_thread.force_sync.assert_called()
        mock_thread.request_sync.assert_not_called()

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_acquire_lock_wait_timeout_is_20(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user="test@example.com"):
            pass

        mock_thread.wait_for_sync.assert_called_with(20)

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_acquire_lock_write_pushes_inline_after_yield(self, mock_start, mock_etesync_ctx):
        """Write mode: pull via force_sync on entry, then push INLINE on
        exit — not a second force_sync. The SyncThread can't acquire the
        etesync lock while we hold it (storage.py:665-677), so push runs
        directly here. The previous version of this test asserted
        force_sync.call_count == 2 against an older "request another sync"
        contract; it had been red since the inline-push refactor.
        """
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        # No dirty collections to iterate — keeps the test focused on
        # "is push_collection_list called?" without faking per-collection
        # push paths.
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="test@example.com"):
            pass

        # Pre-yield: one force_sync() to pull the latest server state.
        assert mock_thread.force_sync.call_count == 1
        # Post-yield: inline push of the collection list (write mode only).
        mock_etesync.push_collection_list.assert_called_once()

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_acquire_lock_no_user_skips_sync(self, mock_start, mock_etesync_ctx):
        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user=""):
            pass

        mock_start.assert_not_called()


# ---------------------------------------------------------------------------
# Collection — discover
# ---------------------------------------------------------------------------


class TestDiscover:
    """Test the Storage.discover() method."""

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_discover_root(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user="test@example.com"):
            results = list(storage.discover("/", depth="1"))

        # Should yield root collection + user collection
        assert len(results) == 2

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_discover_user_yields_all_supported_collections(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        journals = [
            MagicMock(uid="cal-work", col_type="etebase.vevent"),
            MagicMock(uid="cal-home", col_type="etebase.vevent"),
            MagicMock(uid="tasks", col_type="etebase.vtodo"),
            MagicMock(uid="contacts", col_type="etebase.vcard"),
            MagicMock(uid="ignored", col_type="etebase.notes"),
        ]
        collections = {journal.uid: journal for journal in journals}

        mock_etesync = MagicMock()
        mock_etesync.list.return_value = journals
        mock_etesync.get.side_effect = lambda uid: collections[uid]
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user="test@example.com"):
            results = list(storage.discover("/test@example.com", depth="1"))

        assert [result.path for result in results] == [
            "test@example.com",
            "test@example.com/cal-work",
            "test@example.com/cal-home",
            "test@example.com/tasks",
            "test@example.com/contacts",
        ]

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_discover_rejects_authenticated_user_path_mismatch(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_etesync.list.return_value = []
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("r", user="alice@example.com"):
            results = list(storage.discover("/bob@example.com/calendar/item.ics", depth="1"))

        assert results == []
        mock_etesync.list.assert_not_called()


# ---------------------------------------------------------------------------
# Collection — create_collection
# ---------------------------------------------------------------------------


class TestCreateCollection:
    """Test Storage.create_collection for different collection types."""

    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_create_calendar(self, mock_start, mock_etesync_ctx, mock_log, mem_db):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_col_mgr = MagicMock()
        mock_col = MagicMock()
        mock_col.uid = "new-cal-uid"
        mock_col.stoken = "new-stoken"
        mock_col.collection_type = "etebase.vevent"
        mock_col.meta = {"name": "Work Calendar"}
        mock_col.access_level = 0
        mock_col_mgr.create.return_value = mock_col
        mock_col_mgr.cache_save.return_value = b"cached"
        mock_col_mgr.cache_load.return_value = mock_col
        mock_etesync.etebase.get_collection_manager.return_value = mock_col_mgr
        mock_etesync.user = User.create(username="test@example.com")

        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="test@example.com"):
            result = storage.create_collection(
                "/test@example.com/new-cal-uid",
                props={"tag": "VCALENDAR", "D:displayname": "Work Calendar"},
            )

        mock_col_mgr.create.assert_called_once()
        call_args = mock_col_mgr.create.call_args
        assert call_args[0][0] == "etebase.vevent"
        mock_col_mgr.upload.assert_called_once()

    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_create_addressbook(self, mock_start, mock_etesync_ctx, mock_log, mem_db):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_col_mgr = MagicMock()
        mock_col = MagicMock()
        mock_col.uid = "new-ab-uid"
        mock_col.stoken = "st"
        mock_col.collection_type = "etebase.vcard"
        mock_col.meta = {"name": "Contacts"}
        mock_col.access_level = 0
        mock_col_mgr.create.return_value = mock_col
        mock_col_mgr.cache_save.return_value = b"cached"
        mock_col_mgr.cache_load.return_value = mock_col
        mock_etesync.etebase.get_collection_manager.return_value = mock_col_mgr
        mock_etesync.user = User.create(username="test@example.com")

        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="test@example.com"):
            result = storage.create_collection(
                "/test@example.com/new-ab-uid",
                props={"tag": "VADDRESSBOOK", "D:displayname": "Contacts"},
            )

        call_args = mock_col_mgr.create.call_args
        assert call_args[0][0] == "etebase.vcard"

    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_create_tasklist(self, mock_start, mock_etesync_ctx, mock_log, mem_db):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_col_mgr = MagicMock()
        mock_col = MagicMock()
        mock_col.uid = "new-task-uid"
        mock_col.stoken = "st"
        mock_col.collection_type = "etebase.vtodo"
        mock_col.meta = {"name": "Tasks"}
        mock_col.access_level = 0
        mock_col_mgr.create.return_value = mock_col
        mock_col_mgr.cache_save.return_value = b"cached"
        mock_col_mgr.cache_load.return_value = mock_col
        mock_etesync.etebase.get_collection_manager.return_value = mock_col_mgr
        mock_etesync.user = User.create(username="test@example.com")

        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="test@example.com"):
            result = storage.create_collection(
                "/test@example.com/new-task-uid",
                props={
                    "tag": "VCALENDAR",
                    "C:supported-calendar-component-set": "VTODO",
                    "D:displayname": "Tasks",
                },
            )

        call_args = mock_col_mgr.create.call_args
        assert call_args[0][0] == "etebase.vtodo"

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_create_user_principal_is_noop(self, mock_start, mock_etesync_ctx):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="test@example.com"):
            result = storage.create_collection("/test@example.com")

        # Should return a fake collection without creating anything on Etebase
        assert result is not None

    @patch("silentsuite_bridge.radicale.storage.log_sync_event")
    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_create_collection_rejects_authenticated_user_path_mismatch(
        self, mock_start, mock_etesync_ctx, mock_log, mem_db,
    ):
        mock_thread = MagicMock()
        mock_thread.wait_for_sync.return_value = True
        mock_start.return_value = mock_thread

        mock_etesync = MagicMock()
        mock_col_mgr = MagicMock()
        mock_etesync.etebase.get_collection_manager.return_value = mock_col_mgr
        mock_etesync.user = User.create(username="alice@example.com")
        mock_etesync_ctx.return_value.__enter__ = MagicMock(
            return_value=(mock_etesync, False)
        )
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        storage = Storage(configuration)

        with storage.acquire_lock("w", user="alice@example.com"):
            with pytest.raises(ComponentNotFoundError):
                storage.create_collection(
                    "/bob@example.com/new-cal-uid",
                    props={"tag": "VCALENDAR", "D:displayname": "Work Calendar"},
                )

        mock_col_mgr.create.assert_not_called()
