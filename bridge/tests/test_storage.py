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
from silentsuite_bridge.radicale.rights import Rights as BridgeRights
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


class TestFavoriteStoragePrivacy:
    def test_cache_schema_has_no_favorite_plaintext_fields_or_indexes(self):
        forbidden = {"favorite", "starred", "x-silentsuite-favorite"}
        for model in (CollectionEntity, ItemEntity, HrefMapper):
            field_names = {name.lower() for name in model._meta.fields}
            index_text = repr(model._meta.indexes).lower()
            assert forbidden.isdisjoint(field_names)
            assert not any(key in index_text for key in forbidden)

    def test_collection_metadata_mapping_has_no_favorite_key(self):
        keys = {str(key).lower() for key in MetaMappingContacts._mappings}
        values = {str(value[0]).lower() for value in MetaMappingContacts._mappings.values()}
        assert not ({"favorite", "starred", "x-silentsuite-favorite"} & (keys | values))


class TestFavoriteCardDavRoundTrip:
    @staticmethod
    def _collection(mem_db, user, content, *, uid="fav-1", href="favorite.vcf"):
        cache_col = CollectionEntity.create(
            local_user=user, uid="contacts", eb_col=b"encrypted-collection"
        )
        cache_item = ItemEntity.create(
            collection=cache_col, uid=uid, eb_item=b"encrypted-item"
        )
        HrefMapper.create(content=cache_item, href=href)

        item = MagicMock()
        item.cache_item = cache_item
        item.content = content
        item.etag = "etag-favorite"
        item.meta = {"mtime": 1700000000000}

        cached_collection = MagicMock()
        cached_collection.col_type = "etebase.vcard"
        cached_collection.cache_col = cache_col
        cached_collection.stoken = "stoken-favorite"
        cached_collection.get.side_effect = lambda requested_uid: item if requested_uid == uid else None
        cached_collection.list.return_value = [item]

        storage = MagicMock()
        storage.etesync.get.return_value = cached_collection
        collection = Collection(storage, "/test@example.com/contacts")
        return collection, cached_collection, item

    def test_get_update_and_removal_preserve_favorite_href_and_etag(self, mem_db, user):
        content = "\r\n".join([
            "BEGIN:VCARD", "VERSION:4.0", "UID:fav-1", "FN:Favorite",
            "X-SILENTSUITE-FAVORITE:1", "END:VCARD",
        ])
        collection, _, item = self._collection(mem_db, user, content)

        fetched = collection._get("favorite.vcf")
        assert fetched.href == "favorite.vcf"
        assert fetched.etag == '"etag-favorite"'
        assert "X-SILENTSUITE-FAVORITE:1" in fetched.serialize()

        replacement = MagicMock()
        replacement.vobject_item = vobject.readOne(content.replace("X-SILENTSUITE-FAVORITE:1\r\n", ""))
        updated = collection.upload("favorite.vcf", replacement)
        assert "X-SILENTSUITE-FAVORITE" not in item.content
        assert updated.href == "favorite.vcf"
        item.save.assert_called_once()

        collection.delete("favorite.vcf")
        item.delete.assert_called_once()

    def test_get_preserves_grouped_folded_duplicate_semantics_through_v4_to_v3(self, mem_db, user):
        content = "\r\n".join([
            "BEGIN:VCARD", "VERSION:4.0", "UID:fav-1", "FN:Favorite",
            "item1.X-SILENTSUITE-FAVORITE;TYPE=pref:0",
            "X-SILENTSUITE-FAVORITE:", " 1", "END:VCARD",
        ])
        collection, _, _ = self._collection(mem_db, user, content)
        serialized = collection._get("favorite.vcf").serialize()
        assert "VERSION:3.0" in serialized
        assert "X-SILENTSUITE-FAVORITE" in serialized
        assert ":1" in serialized

    def test_create_persists_favorite_and_href(self, mem_db, user):
        collection, cached_collection, _ = self._collection(mem_db, user, "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:fav-1\r\nFN:Existing\r\nEND:VCARD")
        new_cache_item = ItemEntity.create(
            collection=cached_collection.cache_col, uid="fav-new", eb_item=b"encrypted-new-item"
        )
        new_item = MagicMock()
        new_item.cache_item = new_cache_item
        new_item.content = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:fav-new\r\nFN:New\r\nX-SILENTSUITE-FAVORITE:1\r\nEND:VCARD"
        new_item.etag = "etag-new"
        new_item.meta = {"mtime": 1700000000000}
        cached_collection.create.return_value = new_item
        original_get = cached_collection.get.side_effect
        cached_collection.get.side_effect = lambda uid: new_item if uid == "fav-new" else original_get(uid)

        incoming = MagicMock()
        incoming.vobject_item = vobject.readOne(new_item.content)
        created = collection.upload("new-name.vcf", incoming)

        assert created.href == "new-name.vcf"
        assert created.etag == '"etag-new"'
        assert "X-SILENTSUITE-FAVORITE:1" in created.serialize()
        assert HrefMapper.get_by_id(new_cache_item.id).href == "new-name.vcf"

    def test_recreate_at_tombstone_href_replaces_stale_mapping(self, mem_db, user):
        collection, cached_collection, _ = self._collection(
            mem_db,
            user,
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:fav-1\r\nFN:Existing\r\nEND:VCARD",
        )
        tombstone = ItemEntity.create(
            collection=cached_collection.cache_col,
            uid="restored-contact",
            eb_item=b"deleted-cache",
            deleted=True,
        )
        HrefMapper.create(content=tombstone, href="restored.vcf")
        new_item = MagicMock()
        new_item.content = (
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:restored-contact\r\n"
            "FN:Restored\r\nEND:VCARD"
        )
        new_item.etag = "etag-restored"
        new_item.meta = {"mtime": 1700000000000}

        def create(_vobject_item):
            new_item.cache_item = ItemEntity.create(
                collection=cached_collection.cache_col,
                uid="restored-contact",
                eb_item=b"restored-cache",
            )
            return new_item

        cached_collection.create.side_effect = create
        original_get = cached_collection.get.side_effect
        cached_collection.get.side_effect = (
            lambda uid: new_item if uid == "restored-contact" else original_get(uid)
        )
        incoming = MagicMock(vobject_item=vobject.readOne(new_item.content))

        restored = collection.upload("restored.vcf", incoming)

        assert restored.href == "restored.vcf"
        restored_cache = ItemEntity.get(
            (ItemEntity.collection == cached_collection.cache_col)
            & (ItemEntity.uid == "restored-contact")
        )
        assert restored_cache.deleted is False
        preserved_tombstone = ItemEntity.get_by_id(tombstone.id)
        assert preserved_tombstone.deleted is True
        assert preserved_tombstone.uid.startswith("dav-tombstone:")
        assert HrefMapper.get_or_none(HrefMapper.content == preserved_tombstone) is None
        assert HrefMapper.get_by_id(restored_cache.id).href == "restored.vcf"
        assert HrefMapper.select().where(HrefMapper.href == "restored.vcf").count() == 1


# ---------------------------------------------------------------------------
# acquire_lock — sync is forced on every client request
# ---------------------------------------------------------------------------


class TestBackendDiscoveryForcesSync:
    """Verify backend-backed reads force sync lazily."""

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_read_backend_requests_sync_without_waiting(self, mock_start, mock_etesync_ctx):
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
            list(storage.discover("/test@example.com", depth="1"))

        mock_thread.force_sync.assert_called()
        mock_thread.wait_for_sync.assert_not_called()
        mock_thread.request_sync.assert_not_called()

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_read_backend_uses_independent_local_session(self, mock_start, mock_etesync_ctx):
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
            list(storage.discover("/test@example.com", depth="1"))

        mock_etesync_ctx.assert_called_with("test@example.com", exclusive=False)
        mock_thread.wait_for_sync.assert_not_called()

    def test_read_context_is_request_local_across_accounts(self):
        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        storage = Storage(Configuration(DEFAULT_CONFIG_SCHEMA))
        barrier = threading.Barrier(2)
        observed = {}
        errors = []

        def read_as(user):
            try:
                with storage.acquire_lock("r", user=user):
                    barrier.wait(timeout=1)
                    observed[user] = storage.user
            except Exception as exc:
                errors.append(exc)

        first = threading.Thread(target=read_as, args=("first@example.com",))
        second = threading.Thread(target=read_as, args=("second@example.com",))
        first.start()
        second.start()
        first.join(2)
        second.join(2)

        assert errors == []
        assert observed == {
            "first@example.com": "first@example.com",
            "second@example.com": "second@example.com",
        }

    @patch("silentsuite_bridge.radicale.storage.etesync_for_user")
    @patch("silentsuite_bridge.radicale.storage.start_sync_thread")
    def test_acquire_lock_write_queues_push_after_releasing_session(
        self, mock_start, mock_etesync_ctx
    ):
        """Write requests never perform an unbounded upstream push inline."""
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

        assert mock_thread.force_sync.call_count == 2
        mock_etesync.push_collection_list.assert_not_called()
        mock_etesync.push_collection.assert_not_called()

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
# Rights
# ---------------------------------------------------------------------------


class TestBridgeRights:
    def _rights(self):
        from radicale.config import Configuration, DEFAULT_CONFIG_SCHEMA

        configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
        configuration.update(
            {"auth": {"type": "silentsuite_bridge.radicale.auth"}},
            source="test",
            privileged=True,
        )
        return BridgeRights(configuration)

    @patch("silentsuite_bridge.radicale.rights.etesync_for_user")
    def test_read_only_shared_collection_grants_read_without_write(self, mock_etesync_ctx):
        mock_collection = MagicMock(read_only=True)
        mock_etesync = MagicMock()
        mock_etesync.get.return_value = mock_collection
        mock_etesync_ctx.return_value.__enter__ = MagicMock(return_value=(mock_etesync, False))
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        rights = self._rights()

        assert rights.authorization("user@example.com", "/user@example.com/shared-col") == "r"
        mock_etesync_ctx.assert_called_once_with(
            "user@example.com", exclusive=False
        )

    @patch("silentsuite_bridge.radicale.rights.etesync_for_user")
    def test_writable_collection_keeps_owner_write_permission(self, mock_etesync_ctx):
        mock_collection = MagicMock(read_only=False)
        mock_etesync = MagicMock()
        mock_etesync.get.return_value = mock_collection
        mock_etesync_ctx.return_value.__enter__ = MagicMock(return_value=(mock_etesync, False))
        mock_etesync_ctx.return_value.__exit__ = MagicMock(return_value=False)

        rights = self._rights()

        assert rights.authorization("user@example.com", "/user@example.com/owned-col") == "rw"

    @patch("silentsuite_bridge.radicale.rights.etesync_for_user")
    def test_new_collection_paths_preserve_base_permission(self, mock_etesync_ctx):
        mock_etesync_ctx.side_effect = RuntimeError("missing cache")
        rights = self._rights()

        assert rights.authorization("user@example.com", "/user@example.com/new-col") == "rw"


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
        mock_col_mgr.upload.assert_not_called()
        assert mock_thread.force_sync.call_count == 2

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
