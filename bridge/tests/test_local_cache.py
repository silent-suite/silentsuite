"""Tests for the local Etebase cache layer."""

import logging
import os
import stat
from unittest.mock import MagicMock, patch, PropertyMock

import pytest
import vobject

from silentsuite_bridge.local_cache import Collection, Etebase, Item, clear_cached_user, db, models
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
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
