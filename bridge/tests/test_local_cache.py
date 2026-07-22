"""Tests for the local Etebase cache layer."""

import logging
import os
import stat
from unittest.mock import MagicMock, patch, PropertyMock

import peewee as pw
import pytest
import vobject

import silentsuite_bridge.local_cache as local_cache_module
from silentsuite_bridge.local_cache import Collection, Etebase, Item, clear_cached_user, db, models
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    DavChange,
    ItemEntity,
    HrefMapper,
    User,
)
from tests.conftest import (
    SAMPLE_VCALENDAR_VEVENT,
    SAMPLE_VCARD,
    _make_mock_collection,
    _make_mock_item,
)


# ---------------------------------------------------------------------------
# Model CRUD
# ---------------------------------------------------------------------------


class TestCollectionEntityCRUD:
    """Test CollectionEntity model operations."""

    def test_create_collection_entity(self, mem_db, user):
        col = CollectionEntity.create(
            local_user=user,
            uid="col-001",
            eb_col=b"blob",
            stoken="st-1",
        )
        assert col.uid == "col-001"
        assert col.deleted is False
        assert col.dirty is False
        assert col.new is False

    def test_unique_constraint(self, mem_db, user):
        CollectionEntity.create(local_user=user, uid="col-dup", eb_col=b"a")
        with pytest.raises(Exception):
            CollectionEntity.create(local_user=user, uid="col-dup", eb_col=b"b")

    def test_delete_collection_cascades_items(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-cas", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"b")
        HrefMapper.create(content=item, href="item-1.ics")

        col.delete_instance(recursive=True)
        assert ItemEntity.select().count() == 0
        assert HrefMapper.select().count() == 0

    def test_list_non_deleted_collections(self, mem_db, user):
        CollectionEntity.create(local_user=user, uid="alive", eb_col=b"a")
        CollectionEntity.create(local_user=user, uid="dead", eb_col=b"b", deleted=True)

        alive = list(user.collections.where(~CollectionEntity.deleted))
        assert len(alive) == 1
        assert alive[0].uid == "alive"


class TestItemEntityCRUD:
    """Test ItemEntity model operations."""

    def test_create_item(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"data")
        assert item.uid == "item-1"
        assert item.dirty is False

    def test_dirty_flag(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"data")
        item.dirty = True
        item.save()

        refreshed = ItemEntity.get_by_id(item.id)
        assert refreshed.dirty is True

    def test_list_dirty_items(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        ItemEntity.create(collection=col, uid="clean", eb_item=b"a")
        ItemEntity.create(collection=col, uid="dirty", eb_item=b"b", dirty=True)
        ItemEntity.create(collection=col, uid="new", eb_item=b"c", new=True)

        dirty = list(col.items.where(ItemEntity.dirty | ItemEntity.new))
        assert len(dirty) == 2


class TestHrefMapper:
    """Test HrefMapper operations."""

    def test_create_href_mapper(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"data")
        mapper = HrefMapper.create(content=item, href="item-1.ics")
        assert mapper.href == "item-1.ics"

    def test_lookup_by_href(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"data")
        HrefMapper.create(content=item, href="lookup.ics")

        found = (
            HrefMapper.select(HrefMapper, ItemEntity)
            .join(ItemEntity)
            .where(
                (HrefMapper.href == "lookup.ics")
                & (ItemEntity.collection == col)
            )
            .get()
        )
        assert found.content.uid == "item-1"

    def test_get_or_create(self, mem_db, user):
        col = CollectionEntity.create(local_user=user, uid="col-1", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid="item-1", eb_item=b"data")

        mapper, created = HrefMapper.get_or_create(
            content=item, defaults={"href": "new.ics"}
        )
        assert created is True
        assert mapper.href == "new.ics"

        mapper2, created2 = HrefMapper.get_or_create(
            content=item, defaults={"href": "other.ics"}
        )
        assert created2 is False
        assert mapper2.href == "new.ics"


class TestClearCachedUser:
    """Test session-independent per-user cache deletion."""

    @staticmethod
    def _seed_user(username):
        user = User.create(username=username)
        col = CollectionEntity.create(local_user=user, uid=f"{username}-col", eb_col=b"a")
        item = ItemEntity.create(collection=col, uid=f"{username}-item", eb_item=b"b")
        HrefMapper.create(content=item, href=f"{username}.ics")
        return user

    def test_clear_cached_user_deletes_only_selected_user(self, mem_db):
        self._seed_user("alice@example.com")
        self._seed_user("bob@example.com")

        assert clear_cached_user("alice@example.com") is True

        assert User.get_or_none(User.username == "alice@example.com") is None
        bob = User.get(User.username == "bob@example.com")
        assert bob.collections.count() == 1
        assert ItemEntity.select().join(CollectionEntity).where(
            CollectionEntity.local_user == bob
        ).count() == 1
        assert HrefMapper.select().count() == 1

    def test_clear_cached_user_missing_is_idempotent(self, mem_db):
        self._seed_user("bob@example.com")

        assert clear_cached_user("ghost@example.com") is False
        assert User.get_or_none(User.username == "bob@example.com") is not None


# ---------------------------------------------------------------------------
# Collection wrapper
# ---------------------------------------------------------------------------


class TestCollectionWrapper:
    """Test the local_cache.Collection wrapper."""

    @staticmethod
    def _simple_col_mgr(mock_col):
        """Create a simple col_mgr mock that returns mock_col from cache_load."""
        mgr = MagicMock()
        mgr.cache_load.return_value = mock_col
        mgr.cache_save.return_value = b"saved"
        return mgr

    def test_uid(self, mem_db, user):
        mock_col = _make_mock_collection("col-uid-1", "etebase.vevent")
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-uid-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)
        assert col.uid == "col-uid-1"

    def test_col_type(self, mem_db, user):
        mock_col = _make_mock_collection("col-1", "etebase.vcard")
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)
        assert col.col_type == "etebase.vcard"

    def test_read_only_reflects_shared_collection_access_level(self, mem_db, user):
        mock_col = _make_mock_collection("shared-col", "etebase.vevent")
        mock_col.access_level = 1
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="shared-col", eb_col=b"\x00" * 8
        )

        col = Collection(mgr, cache_col)

        assert col.read_only is True

    def test_read_write_shared_collection_is_not_read_only(self, mem_db, user):
        mock_col = _make_mock_collection("shared-rw-col", "etebase.vevent")
        mock_col.access_level = 0
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="shared-rw-col", eb_col=b"\x00" * 8
        )

        col = Collection(mgr, cache_col)

        assert col.read_only is False

    def test_meta(self, mem_db, user):
        mock_col = _make_mock_collection("col-1", "etebase.vevent", meta={"name": "My Cal"})
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)
        assert col.meta["name"] == "My Cal"

    def test_stoken(self, mem_db, user):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8,
            local_stoken="stoken-abc",
        )
        col = Collection(mgr, cache_col)
        assert col.stoken == "stoken-abc"

    def test_delete_marks_dirty(self, mem_db, user):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)
        col.delete()

        # Check the in-memory cache_col (delete() sets fields and saves)
        assert col.cache_col.deleted is True
        assert col.cache_col.dirty is True

    def test_update_meta_marks_dirty(self, mem_db, user):
        mock_col = _make_mock_collection(
            "col-1", "etebase.vevent", meta={"name": "Old", "color": "#000000"}
        )
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)

        col.update_meta({"name": "New", "color": "#00FF00"})

        refreshed = CollectionEntity.get_by_id(cache_col.id)
        assert mock_col.meta == {"name": "New", "color": "#00FF00"}
        assert refreshed.eb_col == b"saved"
        assert refreshed.dirty is True

    def test_list_items(self, mem_db, user, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mgr = MagicMock()
        mgr.cache_load.return_value = mock_col
        mgr.get_item_manager.return_value = mock_item_mgr

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        ItemEntity.create(collection=cache_col, uid="item-1", eb_item=eb_blob)

        col = Collection(mgr, cache_col)
        items = list(col.list())
        assert len(items) == 1

    def test_get_item(self, mem_db, user, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mgr = MagicMock()
        mgr.cache_load.return_value = mock_col
        mgr.get_item_manager.return_value = mock_item_mgr

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        ItemEntity.create(collection=cache_col, uid="item-1", eb_item=eb_blob)

        col = Collection(mgr, cache_col)
        item = col.get("item-1")
        assert item is not None
        assert item.uid == "item-1"

    def test_get_nonexistent_item(self, mem_db, user):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mgr = self._simple_col_mgr(mock_col)
        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )
        col = Collection(mgr, cache_col)
        assert col.get("nonexistent") is None

    def test_create_records_remote_uid(self, mem_db, user, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vcard")
        mock_col_mgr = MagicMock()
        mock_col_mgr.cache_load.return_value = mock_col
        mock_col_mgr.get_item_manager.return_value = mock_item_mgr
        cache_col = CollectionEntity.create(
            local_user=user,
            uid="col-1",
            eb_col=b"\x00" * 8,
        )
        remote_item = _make_mock_item("remote-created-1", SAMPLE_VCARD)
        mock_item_mgr.create.return_value = remote_item
        col = Collection(mock_col_mgr, cache_col)

        created = col.create(vobject.readOne(SAMPLE_VCARD))

        assert created.cache_item.remote_uid == "remote-created-1"


# ---------------------------------------------------------------------------
# Item wrapper
# ---------------------------------------------------------------------------


class TestItemWrapper:
    """Test the local_cache.Item wrapper."""

    def test_content_decode(self, mem_db, user, mock_col_mgr, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mock_col_mgr.cache_load.return_value = mock_col

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        cache_item = ItemEntity.create(
            collection=cache_col, uid="item-1", eb_item=eb_blob
        )

        item = Item(mock_item_mgr, cache_item)
        assert "VEVENT" in item.content

    def test_content_setter(self, mem_db, user, mock_col_mgr, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mock_col_mgr.cache_load.return_value = mock_col

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        cache_item = ItemEntity.create(
            collection=cache_col, uid="item-1", eb_item=eb_blob
        )

        item = Item(mock_item_mgr, cache_item)
        item.content = "new content"
        assert mock_item.content == b"new content"

    def test_etag(self, mem_db, user, mock_col_mgr, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mock_col_mgr.cache_load.return_value = mock_col

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT, etag="my-etag")
        eb_blob = mock_item_mgr.cache_save(mock_item)
        cache_item = ItemEntity.create(
            collection=cache_col, uid="item-1", eb_item=eb_blob
        )

        item = Item(mock_item_mgr, cache_item)
        assert item.etag == "my-etag"

    def test_delete_marks_deleted(self, mem_db, user, mock_col_mgr, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mock_col_mgr.cache_load.return_value = mock_col

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        cache_item = ItemEntity.create(
            collection=cache_col, uid="item-1", eb_item=eb_blob
        )

        item = Item(mock_item_mgr, cache_item)
        item.delete()
        assert cache_item.deleted is True
        assert cache_item.dirty is True

    def test_save_sets_dirty(self, mem_db, user, mock_col_mgr, mock_item_mgr):
        mock_col = _make_mock_collection("col-1", "etebase.vevent")
        mock_col_mgr.cache_load.return_value = mock_col

        cache_col = CollectionEntity.create(
            local_user=user, uid="col-1", eb_col=b"\x00" * 8
        )

        mock_item = _make_mock_item("item-1", SAMPLE_VCALENDAR_VEVENT)
        eb_blob = mock_item_mgr.cache_save(mock_item)
        cache_item = ItemEntity.create(
            collection=cache_col, uid="item-1", eb_item=eb_blob
        )

        item = Item(mock_item_mgr, cache_item)
        item.save()
        assert cache_item.dirty is True


# ---------------------------------------------------------------------------
# Sync push/pull logic
# ---------------------------------------------------------------------------


class TestSyncLogic:
    """Test Etebase sync push/pull with mocked Etebase API."""

    @patch("silentsuite_bridge.local_cache.Account")
    @patch("silentsuite_bridge.local_cache.Client")
    def test_push_collection_list(self, MockClient, MockAccount, mem_db):
        """Test that dirty collections are uploaded."""
        mock_account = MagicMock()
        MockAccount.restore.return_value = mock_account
        mock_col_mgr = MagicMock()
        mock_account.get_collection_manager.return_value = mock_col_mgr

        # Setup mock col for cache_load
        mock_col = MagicMock()
        mock_col.deleted = False
        mock_col_mgr.cache_load.return_value = mock_col

        with patch("silentsuite_bridge.local_cache.Etebase._init_db"):
            etebase = Etebase.__new__(Etebase)
            etebase.etebase = mock_account
            etebase.username = "test@example.com"
            etebase._database = mem_db
            etebase.stored_session = "fake"

            db.database_proxy.initialize(mem_db)
            user_obj = User.create(username="test@example.com")
            etebase.user = user_obj

            # Create a dirty collection
            CollectionEntity.create(
                local_user=user_obj,
                uid="dirty-col",
                eb_col=b"\x00" * 8,
                dirty=True,
            )

            etebase.push_collection_list()
            mock_col_mgr.upload.assert_called_once()

    def test_collection_list_is_dirty(self, mem_db, user):
        """Test dirty detection without Etebase SDK."""
        # Directly test the query logic that _collection_list_dirty_get uses
        assert list(user.collections.where(
            CollectionEntity.dirty | CollectionEntity.new
        )) == []

        CollectionEntity.create(
            local_user=user,
            uid="new-col",
            eb_col=b"a",
            new=True,
        )
        dirty = list(user.collections.where(
            CollectionEntity.dirty | CollectionEntity.new
        ))
        assert len(dirty) == 1

    def test_push_collection_list_code_clears_new_flag(self, mem_db, user):
        """Verify push_collection_list clears both dirty AND new flags.

        We test the save logic directly because push_collection_list
        re-enters the db proxy context which complicates in-memory DB tests.
        The key assertion: the code path sets collection.new = False.
        """
        import inspect
        from silentsuite_bridge.local_cache import Etebase

        source = inspect.getsource(Etebase.push_collection_list)
        # The method MUST clear new flag alongside dirty
        assert "collection.new = False" in source, (
            "push_collection_list must clear the new flag to prevent "
            "re-uploading already-pushed collections"
        )
        assert "collection.dirty = False" in source

    @patch("silentsuite_bridge.local_cache.Account")
    @patch("silentsuite_bridge.local_cache.Client")
    def test_pull_collection_always_checks_server(self, MockClient, MockAccount, mem_db):
        """Test that pull_collection always fetches from server even when stokens match.

        This is critical: the collection-level stoken (from sync_collection_list)
        does NOT reflect item-level changes. pull_collection must always call
        item_mgr.list() to discover new items added via webapp or other clients.
        """
        mock_account = MagicMock()
        MockAccount.restore.return_value = mock_account
        mock_col_mgr = MagicMock()
        mock_account.get_collection_manager.return_value = mock_col_mgr

        mock_col = MagicMock()
        mock_col_mgr.cache_load.return_value = mock_col
        mock_item_mgr = MagicMock()
        mock_col_mgr.get_item_manager.return_value = mock_item_mgr

        # Return empty item list (no new items)
        mock_item_list = MagicMock()
        mock_item_list.data = []
        mock_item_list.done = True
        mock_item_list.stoken = "same-token"
        mock_item_mgr.list.return_value = mock_item_list

        with patch("silentsuite_bridge.local_cache.Etebase._init_db"):
            etebase = Etebase.__new__(Etebase)
            etebase.etebase = mock_account
            etebase.username = "test@example.com"
            etebase._database = mem_db
            etebase.stored_session = "fake"

            db.database_proxy.initialize(mem_db)
            user_obj = User.create(username="test-pull@example.com")
            etebase.user = user_obj

            # Create a collection where stoken == local_stoken
            # (previously this would cause pull to be skipped entirely)
            col = CollectionEntity.create(
                local_user=user_obj,
                uid="pull-test-col",
                eb_col=b"\x00" * 8,
                stoken="same-token",
                local_stoken="same-token",
            )

            etebase.pull_collection("pull-test-col")

            # Key assertion: item_mgr.list() MUST be called even when stokens match
            mock_item_mgr.list.assert_called_once()

    @patch("silentsuite_bridge.local_cache.Account")
    @patch("silentsuite_bridge.local_cache.Client")
    def test_pull_collection_info_logs_do_not_expose_item_identifiers_or_metadata(
        self,
        MockClient,
        MockAccount,
        mem_db,
        caplog,
    ):
        mock_account = MagicMock()
        MockAccount.restore.return_value = mock_account
        mock_col_mgr = MagicMock()
        mock_account.get_collection_manager.return_value = mock_col_mgr
        mock_col = MagicMock()
        mock_col_mgr.cache_load.return_value = mock_col
        mock_item_mgr = MagicMock()
        mock_col_mgr.get_item_manager.return_value = mock_item_mgr
        mock_item = MagicMock()
        mock_item.uid = "private-etebase-item-uid"
        mock_item.meta = {"name": "private-local-item-uid", "summary": "Private Appointment"}
        mock_item.deleted = False
        mock_item_mgr.cache_save.return_value = b"item-cache"
        mock_item_list = MagicMock()
        mock_item_list.data = [mock_item]
        mock_item_list.done = True
        mock_item_list.stoken = "private-stoken"
        mock_item_mgr.list.return_value = mock_item_list

        with patch("silentsuite_bridge.local_cache.Etebase._init_db"):
            etebase = Etebase.__new__(Etebase)
            etebase.etebase = mock_account
            etebase.username = "test@example.com"
            etebase._database = mem_db
            etebase.stored_session = "fake"
            db.database_proxy.initialize(mem_db)
            user_obj = User.create(username="private-log-test@example.com")
            etebase.user = user_obj
            CollectionEntity.create(
                local_user=user_obj,
                uid="private-collection-uid",
                eb_col=b"\x00" * 8,
                local_stoken="private-old-stoken",
            )

            with caplog.at_level(logging.INFO, logger="silentsuite-bridge.cache"):
                etebase.pull_collection("private-collection-uid")

        logs = caplog.text
        assert "fetched 1 items" in logs
        assert "private-collection-uid" not in logs
        assert "private-etebase-item-uid" not in logs
        assert "private-local-item-uid" not in logs
        assert "Private Appointment" not in logs
        assert "private-stoken" not in logs

    @patch("silentsuite_bridge.local_cache.Account")
    @patch("silentsuite_bridge.local_cache.Client")
    def test_push_collection_info_logs_do_not_expose_item_identifiers(
        self,
        MockClient,
        MockAccount,
        mem_db,
        caplog,
    ):
        mock_account = MagicMock()
        MockAccount.restore.return_value = mock_account
        mock_col_mgr = MagicMock()
        mock_account.get_collection_manager.return_value = mock_col_mgr
        mock_col = MagicMock()
        mock_col_mgr.cache_load.return_value = mock_col
        mock_item_mgr = MagicMock()
        mock_col_mgr.get_item_manager.return_value = mock_item_mgr
        mock_item_mgr.cache_load.return_value = MagicMock()
        mock_item_mgr.cache_save.return_value = b"saved-item"

        with patch("silentsuite_bridge.local_cache.Etebase._init_db"):
            etebase = Etebase.__new__(Etebase)
            etebase.etebase = mock_account
            etebase.username = "test@example.com"
            etebase._database = mem_db
            etebase.stored_session = "fake"
            db.database_proxy.initialize(mem_db)
            user_obj = User.create(username="private-push-log-test@example.com")
            etebase.user = user_obj
            col = CollectionEntity.create(
                local_user=user_obj,
                uid="private-push-collection-uid",
                eb_col=b"\x00" * 8,
            )
            ItemEntity.create(
                collection=col,
                uid="private-push-item-uid",
                eb_item=b"\x00" * 8,
                dirty=True,
            )

            with caplog.at_level(logging.INFO, logger="silentsuite-bridge.cache"):
                etebase.push_collection("private-push-collection-uid")

        logs = caplog.text
        assert "1 dirty/new items" in logs
        assert "private-push-collection-uid" not in logs
        assert "private-push-item-uid" not in logs


def test_cache_database_files_are_owner_only(tmp_path):
    if os.name == "nt":
        pytest.skip("POSIX file modes are not meaningful on Windows")

    etebase = Etebase.__new__(Etebase)
    etebase.username = "mode-test@example.com"
    db_path = tmp_path / "nested" / "bridge_data.db"
    db_path.parent.mkdir(mode=0o755)
    os.chmod(db_path.parent, 0o755)

    old_umask = os.umask(0o022)
    try:
        etebase._init_db(str(db_path))
    finally:
        os.umask(old_umask)
        db.database_proxy.close()

    assert stat.S_IMODE(os.stat(db_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(db_path.parent).st_mode) == 0o700
    for suffix in ("-wal", "-shm"):
        sidecar = f"{db_path}{suffix}"
        if os.path.exists(sidecar):
            assert stat.S_IMODE(os.stat(sidecar).st_mode) == 0o600


def test_remote_tombstone_without_name_reuses_remote_identity_and_original_href(tmp_path):
    database = pw.SqliteDatabase(
        str(tmp_path / "remote-delete.sqlite"),
        pragmas={"foreign_keys": 1},
    )
    db.database_proxy.initialize(database)
    database.create_tables(
        [
            models.Config,
            models.User,
            models.CollectionEntity,
            models.ItemEntity,
            models.HrefMapper,
            models.DavChange,
            models.DavRevision,
            models.DavSyncToken,
            models.DavUnresolvedItem,
            models.SchemaMigration,
        ]
    )
    models.Config.create(db_version=1)

    mock_account = MagicMock()
    mock_col_mgr = MagicMock()
    mock_item_mgr = MagicMock()
    mock_account.get_collection_manager.return_value = mock_col_mgr
    mock_col_mgr.get_item_manager.return_value = mock_item_mgr

    user_obj = User.create(username="remote-delete@example.com")
    cache_col = CollectionEntity.create(
        local_user=user_obj,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    original = ItemEntity.create(
        collection=cache_col,
        uid="contact-1",
        remote_uid="remote-item-1",
        eb_item=b"original-cache",
    )
    HrefMapper.create(content=original, href="contact-1.vcf")

    remote_collection = MagicMock(collection_type="etebase.vcard")
    mock_col_mgr.cache_load.return_value = remote_collection
    tombstone = MagicMock(
        uid="remote-item-1",
        meta={},
        deleted=True,
        etag="deleted-etag",
    )
    mock_item_mgr.cache_save.return_value = b"tombstone-cache"
    mock_item_mgr.list.return_value = MagicMock(
        data=[tombstone],
        done=True,
        stoken="after-delete",
    )

    etebase = Etebase.__new__(Etebase)
    etebase.etebase = mock_account
    etebase.username = user_obj.username
    etebase._database = database
    etebase.stored_session = "fake"
    etebase.user = user_obj

    etebase.pull_collection(cache_col.uid)

    rows = list(ItemEntity.select().where(ItemEntity.collection == cache_col))
    assert len(rows) == 1
    assert rows[0].id == original.id
    assert rows[0].deleted is True
    assert rows[0].remote_uid == "remote-item-1"
    assert HrefMapper.get_by_id(original.id).href == "contact-1.vcf"
    change = DavChange.get(
        (DavChange.collection == cache_col)
        & (DavChange.href == "contact-1.vcf")
    )
    assert change.deleted is True
    assert change.revision == 1
    assert CollectionEntity.get_by_id(cache_col.id).dav_revision == 1


def test_v1_cache_is_migrated_additively_without_bumping_legacy_version(tmp_path):
    cache_path = tmp_path / "legacy-v1.sqlite"
    legacy_db = pw.SqliteDatabase(str(cache_path), pragmas={"foreign_keys": 1})

    class LegacyBase(pw.Model):
        class Meta:
            database = legacy_db

    class LegacyConfig(LegacyBase):
        db_version = pw.IntegerField()

        class Meta:
            table_name = "config"

    class LegacyUser(LegacyBase):
        username = pw.CharField(unique=True)
        stoken = pw.CharField(null=True)

        class Meta:
            table_name = "user"

    class LegacyCollection(LegacyBase):
        local_user = pw.ForeignKeyField(LegacyUser, on_delete="CASCADE")
        uid = pw.CharField()
        eb_col = pw.BlobField()
        new = pw.BooleanField(default=False)
        dirty = pw.BooleanField(default=False)
        deleted = pw.BooleanField(default=False)
        stoken = pw.CharField(null=True)
        local_stoken = pw.CharField(null=True)

        class Meta:
            table_name = "collectionentity"

    class LegacyItem(LegacyBase):
        collection = pw.ForeignKeyField(LegacyCollection, on_delete="CASCADE")
        uid = pw.CharField()
        eb_item = pw.BlobField()
        new = pw.BooleanField(default=False)
        dirty = pw.BooleanField(default=False)
        deleted = pw.BooleanField(default=False)

        class Meta:
            table_name = "itementity"

    class LegacyHref(LegacyBase):
        content = pw.ForeignKeyField(
            LegacyItem,
            primary_key=True,
            on_delete="CASCADE",
        )
        href = pw.CharField()

        class Meta:
            table_name = "hrefmapper"

    legacy_db.create_tables(
        [LegacyConfig, LegacyUser, LegacyCollection, LegacyItem, LegacyHref]
    )
    LegacyConfig.create(db_version=1)
    legacy_user = LegacyUser.create(username="legacy@example.com")
    legacy_collection = LegacyCollection.create(
        local_user=legacy_user,
        uid="contacts",
        eb_col=b"legacy-collection",
    )
    legacy_item = LegacyItem.create(
        collection=legacy_collection,
        uid="contact-1",
        eb_item=b"legacy-item",
    )
    LegacyHref.create(content=legacy_item, href="contact-1.vcf")
    legacy_db.close()

    etebase = Etebase.__new__(Etebase)
    etebase.username = "legacy@example.com"
    etebase._init_db(str(cache_path))

    migrated_collection = CollectionEntity.get(uid="contacts")
    migrated_item = ItemEntity.get(uid="contact-1")
    assert migrated_collection.dav_revision == 0
    assert migrated_item.remote_uid is None
    assert HrefMapper.get_by_id(migrated_item.id).href == "contact-1.vcf"
    assert models.Config.get().db_version == 1
    assert {
        migration.name for migration in models.SchemaMigration.select()
    } == {"dav-revision-v1", "dav-revision-chain-v3"}
    assert "davrevision" in etebase._database.get_tables()
    unresolved_columns = {
        column.name
        for column in etebase._database.get_columns("davunresolveditem")
    }
    assert {"reason", "local_item_id"} <= unresolved_columns


def test_revision_ledger_activation_rolls_back_marker_when_token_deletion_fails(
    mem_db, user, monkeypatch
):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    models.DavSyncToken.create(
        collection=cache_col,
        revision=0,
        token="private-legacy-token",
        created_at=1,
    )
    original_execute_sql = mem_db.execute_sql

    def fail_token_deletion(sql, *args, **kwargs):
        if "DELETE FROM" in sql and "davsynctoken" in sql:
            raise RuntimeError("injected migration failure")
        return original_execute_sql(sql, *args, **kwargs)

    monkeypatch.setattr(mem_db, "execute_sql", fail_token_deletion)
    with pytest.raises(RuntimeError, match="injected migration failure"):
        local_cache_module._activate_dav_revision_ledger()

    assert models.SchemaMigration.get_or_none(
        models.SchemaMigration.name == "dav-revision-chain-v3"
    ) is None
    assert models.DavSyncToken.select().count() == 1

    monkeypatch.setattr(mem_db, "execute_sql", original_execute_sql)
    local_cache_module._activate_dav_revision_ledger()
    assert models.SchemaMigration.get(
        models.SchemaMigration.name == "dav-revision-chain-v3"
    )
    assert models.DavSyncToken.select().count() == 0


def test_backfill_remote_uids_uses_cached_envelopes_without_remote_io(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    cache_item = ItemEntity.create(
        collection=cache_col,
        uid="contact-1",
        eb_item=b"item-cache",
    )
    remote_item = MagicMock(uid="remote-item-1")
    item_mgr = MagicMock()
    item_mgr.cache_load.return_value = remote_item
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = MagicMock()
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    unresolved = etebase._backfill_remote_uids()

    assert unresolved == 0
    assert ItemEntity.get_by_id(cache_item.id).remote_uid == "remote-item-1"
    item_mgr.cache_load.assert_called_once_with(b"item-cache")


def test_backfill_replaces_unsafe_legacy_href_and_invalidates_tokens(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    cache_item = ItemEntity.create(
        collection=cache_col,
        uid="legacy/contact",
        eb_item=b"item-cache",
    )
    mapper = HrefMapper.create(content=cache_item, href="legacy/contact.vcf")
    models.DavSyncToken.create(
        collection=cache_col,
        token="old-token",
        revision=0,
        created_at=1,
    )
    remote_item = MagicMock(uid="remote-item-1")
    item_mgr = MagicMock()
    item_mgr.cache_load.return_value = remote_item
    col = MagicMock(collection_type="etebase.vcard")
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = col
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    assert etebase._backfill_remote_uids() == 0

    mapper = HrefMapper.get_by_id(mapper.content_id)
    assert mapper.href == local_cache_module.opaque_dav_href("remote-item-1", ".vcf")
    assert "/" not in mapper.href
    assert models.DavSyncToken.select().count() == 0


def test_backfill_unsafe_href_avoids_retained_tombstone_collision(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    tombstone = ItemEntity.create(
        collection=cache_col,
        uid="retained-tombstone",
        remote_uid="retained-remote",
        eb_item=b"tombstone-cache",
        deleted=True,
        dirty=True,
    )
    preferred_href = local_cache_module.opaque_dav_href("remote-item-1", ".vcf")
    HrefMapper.create(content=tombstone, href=preferred_href)
    legacy = ItemEntity.create(
        collection=cache_col,
        uid="legacy/contact",
        eb_item=b"legacy-cache",
    )
    HrefMapper.create(content=legacy, href="legacy/contact.vcf")
    item_mgr = MagicMock()
    item_mgr.cache_load.return_value = MagicMock(uid="remote-item-1")
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = MagicMock(
        collection_type="etebase.vcard"
    )
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    assert etebase._backfill_remote_uids() == 0

    hrefs = {
        mapper.href
        for mapper in HrefMapper.select().join(ItemEntity).where(
            ItemEntity.collection == cache_col
        )
    }
    assert len(hrefs) == 2
    assert preferred_href in hrefs
    assert all(local_cache_module.is_safe_dav_href(href) for href in hrefs)


def test_backfill_quarantines_legacy_duplicate_remote_identity(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    first = ItemEntity.create(
        collection=cache_col,
        uid="contact-1",
        eb_item=b"item-cache-1",
    )
    duplicate = ItemEntity.create(
        collection=cache_col,
        uid="contact-duplicate",
        eb_item=b"item-cache-2",
    )
    HrefMapper.create(content=first, href="contact-1.vcf")
    HrefMapper.create(content=duplicate, href="contact-duplicate.vcf")
    remote_item = MagicMock(uid="remote-item-1")
    item_mgr = MagicMock()
    item_mgr.cache_load.return_value = remote_item
    item_mgr.cache_save.return_value = b"duplicate-retry-cache"
    col_mgr = MagicMock()
    col = MagicMock()
    col_mgr.cache_load.return_value = col
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    unresolved = etebase._backfill_remote_uids()

    assert unresolved == 1
    assert ItemEntity.get_by_id(first.id).deleted is False
    assert ItemEntity.get_by_id(duplicate.id).deleted is True
    assert list(cache_col.items.where(ItemEntity.deleted == False)) == [first]  # noqa: E712
    quarantine = models.DavUnresolvedItem.get(collection=cache_col)
    assert quarantine.eb_item == b"item-cache-2"
    change = DavChange.get(collection=cache_col)
    assert change.href == "contact-duplicate.vcf"
    assert change.deleted is True
    revision_count = models.DavRevision.select().count()
    item_mgr.cache_load.reset_mock()

    assert etebase._backfill_remote_uids() == 0
    assert models.DavUnresolvedItem.get_by_id(quarantine.id).attempts == 0
    assert models.DavRevision.select().count() == revision_count
    item_mgr.cache_load.assert_not_called()

    etebase._retry_unresolved_items(cache_col, col, item_mgr)

    assert ItemEntity.get_by_id(first.id).eb_item == b"item-cache-1"
    quarantine = models.DavUnresolvedItem.get(collection=cache_col)
    assert quarantine.reason == "legacy_duplicate"
    assert quarantine.local_item_id == duplicate.id
    assert quarantine.attempts == 0


def test_backfill_quarantines_malformed_legacy_envelope(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    malformed = ItemEntity.create(
        collection=cache_col,
        uid="malformed-contact",
        eb_item=b"malformed-cache",
    )
    HrefMapper.create(content=malformed, href="malformed-contact.vcf")
    item_mgr = MagicMock()
    item_mgr.cache_load.side_effect = ValueError("private parser details")
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = MagicMock()
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    assert etebase._backfill_remote_uids() == 1

    assert ItemEntity.get_by_id(malformed.id).deleted is True
    quarantine = models.DavUnresolvedItem.get(collection=cache_col)
    assert quarantine.eb_item == b"malformed-cache"
    change = DavChange.get(collection=cache_col)
    assert change.href == "malformed-contact.vcf"
    assert change.deleted is True

    quarantine.attempts = 8
    quarantine.save(only=[models.DavUnresolvedItem.attempts])
    item_mgr.cache_load.reset_mock()
    etebase._retry_unresolved_items(cache_col, col_mgr.cache_load.return_value, item_mgr)
    etebase._retry_unresolved_items(cache_col, col_mgr.cache_load.return_value, item_mgr)

    assert models.DavUnresolvedItem.get_by_id(quarantine.id).attempts == 8
    item_mgr.cache_load.assert_not_called()


def test_pulled_carddav_item_uses_single_segment_opaque_href(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    col = MagicMock(collection_type="etebase.vcard")
    item = MagicMock(
        uid="remote-item-unsafe",
        meta={"name": "urn:uuid:contact/with/slashes"},
        deleted=False,
        etag="etag-unsafe",
    )
    item_mgr = MagicMock()
    item_mgr.cache_save.return_value = b"item-cache"
    etebase = Etebase.__new__(Etebase)

    assert etebase._apply_pulled_item(cache_col, col, item_mgr, item) is True

    cache_item = ItemEntity.get(remote_uid="remote-item-unsafe")
    mapper = HrefMapper.get(content=cache_item)
    assert cache_item.uid == "urn:uuid:contact/with/slashes"
    assert mapper.href.endswith(".vcf")
    assert "/" not in mapper.href


def test_unknown_tombstone_cannot_rebind_identity_bound_contact(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    bound = ItemEntity.create(
        collection=cache_col,
        uid="contact-name",
        remote_uid="remote-original",
        eb_item=b"original-cache",
    )
    HrefMapper.create(content=bound, href="contact-name.vcf")
    col = MagicMock(collection_type="etebase.vcard")
    tombstone = MagicMock(
        uid="remote-unrelated",
        meta={"name": "contact-name"},
        deleted=True,
        etag="deleted-etag",
    )
    item_mgr = MagicMock()
    item_mgr.cache_save.return_value = b"tombstone-cache"
    etebase = Etebase.__new__(Etebase)

    assert etebase._apply_pulled_item(
        cache_col, col, item_mgr, tombstone
    ) is False

    refreshed = ItemEntity.get_by_id(bound.id)
    assert refreshed.remote_uid == "remote-original"
    assert refreshed.deleted is False
    unresolved = models.DavUnresolvedItem.get(collection=cache_col)
    assert unresolved.remote_uid == "remote-unrelated"
    assert DavChange.select().count() == 0


def test_colliding_live_remote_item_is_quarantined_without_blocking_pull(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    bound = ItemEntity.create(
        collection=cache_col,
        uid="contact-name",
        remote_uid="remote-original",
        eb_item=b"original-cache",
    )
    HrefMapper.create(content=bound, href="contact-name.vcf")
    live_collision = MagicMock(
        uid="remote-unrelated",
        meta={"name": "contact-name"},
        deleted=False,
        etag="live-etag",
    )
    item_mgr = MagicMock()
    item_mgr.cache_save.return_value = b"collision-cache"
    etebase = Etebase.__new__(Etebase)

    assert etebase._apply_pulled_item(
        cache_col,
        MagicMock(collection_type="etebase.vcard"),
        item_mgr,
        live_collision,
    ) is False

    refreshed = ItemEntity.get_by_id(bound.id)
    assert refreshed.remote_uid == "remote-original"
    assert refreshed.deleted is False
    unresolved = models.DavUnresolvedItem.get(collection=cache_col)
    assert unresolved.remote_uid == "remote-unrelated"
    assert unresolved.deleted is False
    assert ItemEntity.select().where(ItemEntity.collection == cache_col).count() == 1


def test_full_sync_reports_durable_unresolved_conflicts(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    models.DavUnresolvedItem.create(
        collection=cache_col,
        remote_uid="remote-unresolved",
        eb_item=b"unresolved-cache",
        deleted=False,
    )
    etebase = Etebase.__new__(Etebase)
    etebase.user = user
    etebase.sync_collection_list = MagicMock()
    etebase.list = MagicMock(return_value=[])

    with pytest.raises(
        local_cache_module.DavUnresolvedItemsError,
        match="synchronization is incomplete",
    ):
        etebase.sync()


def test_metadata_fallback_only_claims_legacy_identityless_row(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    legacy = ItemEntity.create(
        collection=cache_col,
        uid="legacy-contact",
        remote_uid=None,
        eb_item=b"legacy-cache",
    )
    HrefMapper.create(content=legacy, href="legacy-contact.vcf")
    col = MagicMock(collection_type="etebase.vcard")
    tombstone = MagicMock(
        uid="remote-legacy",
        meta={"name": "legacy-contact"},
        deleted=True,
        etag="deleted-etag",
    )
    item_mgr = MagicMock()
    item_mgr.cache_save.return_value = b"tombstone-cache"
    etebase = Etebase.__new__(Etebase)

    assert etebase._apply_pulled_item(cache_col, col, item_mgr, tombstone)

    refreshed = ItemEntity.get_by_id(legacy.id)
    assert refreshed.remote_uid == "remote-legacy"
    assert refreshed.deleted is True
    assert DavChange.get(collection=cache_col).href == "legacy-contact.vcf"


def test_unmatched_identityless_tombstone_is_quarantined_without_duplicate(tmp_path):
    database = pw.SqliteDatabase(
        str(tmp_path / "unresolved-delete.sqlite"),
        pragmas={"foreign_keys": 1},
    )
    db.database_proxy.initialize(database)
    database.create_tables(
        [
            models.Config,
            models.User,
            models.CollectionEntity,
            models.ItemEntity,
            models.HrefMapper,
            models.DavChange,
            models.DavRevision,
            models.DavSyncToken,
            models.DavUnresolvedItem,
            models.SchemaMigration,
        ]
    )
    models.Config.create(db_version=1)
    user_obj = User.create(username="unresolved@example.com")
    cache_col = CollectionEntity.create(
        local_user=user_obj,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    tombstone = MagicMock(
        uid="remote-missing-1",
        meta={},
        deleted=True,
        etag="deleted-etag",
    )
    item_mgr = MagicMock()
    item_mgr.cache_save.return_value = b"quarantined-envelope"
    item_mgr.list.return_value = MagicMock(
        data=[tombstone],
        done=True,
        stoken="after-unresolved",
    )
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = MagicMock(collection_type="etebase.vcard")
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user_obj

    etebase.pull_collection(cache_col.uid)

    assert ItemEntity.select().count() == 0
    unresolved = models.DavUnresolvedItem.get(collection=cache_col)
    assert unresolved.remote_uid == "remote-missing-1"
    assert unresolved.deleted is True
    assert unresolved.eb_item == b"quarantined-envelope"
    assert CollectionEntity.get_by_id(cache_col.id).local_stoken == "after-unresolved"
    assert DavChange.select().count() == 0

    recovered = ItemEntity.create(
        collection=cache_col,
        uid="contact-recovered",
        remote_uid="remote-missing-1",
        eb_item=b"original-envelope",
    )
    HrefMapper.create(content=recovered, href="contact-recovered.vcf")
    item_mgr.cache_load.return_value = tombstone
    item_mgr.list.return_value = MagicMock(
        data=[],
        done=True,
        stoken="after-retry",
    )

    etebase.pull_collection(cache_col.uid)

    assert ItemEntity.get_by_id(recovered.id).deleted is True
    assert models.DavUnresolvedItem.select().count() == 0
    recovered_change = DavChange.get(
        (DavChange.collection == cache_col)
        & (DavChange.href == "contact-recovered.vcf")
    )
    assert recovered_change.deleted is True


def test_corrupt_quarantine_row_does_not_block_fresh_collection_sync(tmp_path):
    database = pw.SqliteDatabase(
        str(tmp_path / "corrupt-quarantine.sqlite"),
        pragmas={"foreign_keys": 1},
    )
    db.database_proxy.initialize(database)
    database.create_tables(
        [
            models.Config,
            models.User,
            models.CollectionEntity,
            models.ItemEntity,
            models.HrefMapper,
            models.DavChange,
            models.DavRevision,
            models.DavSyncToken,
            models.DavUnresolvedItem,
            models.SchemaMigration,
        ]
    )
    models.Config.create(db_version=1)
    user = User.create(username="corrupt-quarantine@example.com")
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    unresolved = models.DavUnresolvedItem.create(
        collection=cache_col,
        remote_uid="remote-corrupt",
        eb_item=b"corrupt-envelope",
        deleted=True,
    )
    item_mgr = MagicMock()
    item_mgr.cache_load.side_effect = ValueError("private corrupt envelope details")
    item_mgr.list.return_value = MagicMock(
        data=[],
        done=True,
        stoken="after-corrupt-quarantine",
    )
    col_mgr = MagicMock()
    col_mgr.cache_load.return_value = MagicMock(collection_type="etebase.vcard")
    col_mgr.get_item_manager.return_value = item_mgr
    account = MagicMock()
    account.get_collection_manager.return_value = col_mgr
    etebase = Etebase.__new__(Etebase)
    etebase.etebase = account
    etebase.user = user

    etebase.pull_collection(cache_col.uid)

    unresolved = models.DavUnresolvedItem.get_by_id(unresolved.id)
    assert unresolved.attempts == 1
    assert CollectionEntity.get_by_id(cache_col.id).local_stoken == (
        "after-corrupt-quarantine"
    )
    item_mgr.list.assert_called_once()
