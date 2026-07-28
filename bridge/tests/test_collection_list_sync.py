"""Collection-list convergence and multi-address-book safety regressions."""

from unittest.mock import MagicMock

from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge.local_cache import Etebase, db, models


def _database(path):
    database = SqliteExtDatabase(str(path), pragmas={"foreign_keys": 1})
    db.database_proxy.initialize(database)
    database.create_tables(
        [
            models.Config,
            models.User,
            models.CollectionEntity,
            models.ItemEntity,
            models.HrefMapper,
            models.DavChange,
            models.DavSyncToken,
            models.DavUnresolvedItem,
            models.SchemaMigration,
        ]
    )
    models.Config.create(db_version=1)
    models.SchemaMigration.create(name="dav-revision-v1", applied_at=0)
    return database


def _service(database, user, collection_manager):
    account = MagicMock()
    account.get_collection_manager.return_value = collection_manager
    service = Etebase.__new__(Etebase)
    service.etebase = account
    service.username = user.username
    service._database = database
    service.stored_session = "fake"
    service.user = user
    return service


def _remote_collection(uid, *, stoken, name="Contacts"):
    collection = MagicMock()
    collection.uid = uid
    collection.stoken = stoken
    collection.deleted = False
    collection.meta = {"name": name}
    return collection


def test_paginated_collection_list_adds_second_address_book_without_hiding_first(tmp_path):
    database = _database(tmp_path / "collection-list.sqlite")
    user = models.User.create(username="books@example.test", stoken="before")
    models.CollectionEntity.create(
        local_user=user,
        uid="contacts-a",
        eb_col=b"existing-cache",
    )
    first = _remote_collection("contacts-a", stoken="a-2", name="Contacts")
    second = _remote_collection("contacts-b", stoken="b-1", name="Contacts")
    page_one = MagicMock(
        data=[first],
        removed_memberships=[],
        done=False,
        stoken="page-one",
    )
    page_two = MagicMock(
        data=[second],
        removed_memberships=[],
        done=True,
        stoken="page-two",
    )
    manager = MagicMock()
    manager.list.side_effect = [page_one, page_two]
    manager.cache_save.side_effect = [b"first-cache", b"second-cache"]
    service = _service(database, user, manager)

    service.sync_collection_list()

    collections = {
        row.uid: row
        for row in models.CollectionEntity.select().where(
            models.CollectionEntity.local_user == user
        )
    }
    assert set(collections) == {"contacts-a", "contacts-b"}
    assert all(not row.deleted for row in collections.values())
    assert models.User.get_by_id(user.id).stoken == "page-two"
    assert manager.list.call_count == 2


def test_remote_tombstone_preserves_pending_child_for_restoration(tmp_path):
    database = _database(tmp_path / "remote-tombstone-pending.sqlite")
    user = models.User.create(username="books@example.test", stoken="before")
    collection = models.CollectionEntity.create(
        local_user=user,
        uid="contacts-pending",
        eb_col=b"local-collection-cache",
    )
    pending_item = models.ItemEntity.create(
        collection=collection,
        uid="pending-contact",
        eb_item=b"pending-item",
        dirty=True,
    )
    models.HrefMapper.create(content=pending_item, href="pending-contact.vcf")
    tombstone = _remote_collection("contacts-pending", stoken="remote-tombstone")
    tombstone.deleted = True
    manager = MagicMock()
    manager.list.return_value = MagicMock(
        data=[tombstone],
        removed_memberships=[],
        done=True,
        stoken="after-tombstone",
    )
    manager.cache_save.return_value = b"remote-tombstone-cache"
    service = _service(database, user, manager)

    service.sync_collection_list()

    persisted = models.CollectionEntity.get_by_id(collection.id)
    assert persisted.deleted is False
    assert persisted.dirty is True
    assert persisted.eb_col == b"local-collection-cache"
    assert models.ItemEntity.get_by_id(pending_item.id).dirty is True


def test_removed_membership_tombstones_only_exact_collection(tmp_path):
    database = _database(tmp_path / "removed-membership.sqlite")
    user = models.User.create(username="books@example.test", stoken="before")
    keep = models.CollectionEntity.create(
        local_user=user,
        uid="contacts-keep",
        eb_col=b"keep-cache",
    )
    retired = models.CollectionEntity.create(
        local_user=user,
        uid="contacts-retired",
        eb_col=b"retired-cache",
    )
    keep_item = models.ItemEntity.create(
        collection=keep,
        uid="keep-contact",
        eb_item=b"keep-item",
    )
    retired_item = models.ItemEntity.create(
        collection=retired,
        uid="retired-contact",
        eb_item=b"retired-item",
    )
    models.HrefMapper.create(content=keep_item, href="keep-contact.vcf")
    models.HrefMapper.create(content=retired_item, href="retired-contact.vcf")
    models.DavUnresolvedItem.create(
        collection=retired,
        remote_uid="remote-retired",
        eb_item=b"unresolved-item",
    )
    page = MagicMock(
        data=[],
        removed_memberships=["contacts-retired"],
        done=True,
        stoken="after-removal",
    )
    manager = MagicMock()
    manager.list.return_value = page
    service = _service(database, user, manager)

    service.sync_collection_list()

    assert models.CollectionEntity.get_by_id(keep.id).deleted is False
    assert models.ItemEntity.get_by_id(keep_item.id).deleted is False
    assert models.HrefMapper.get_by_id(keep_item.id).href == "keep-contact.vcf"
    assert models.CollectionEntity.get_by_id(retired.id).deleted is True
    assert models.ItemEntity.get_or_none(models.ItemEntity.id == retired_item.id) is None
    assert models.DavUnresolvedItem.select().where(
        models.DavUnresolvedItem.collection == retired
    ).count() == 0


def test_removed_membership_preserves_pending_child_mutation(tmp_path):
    database = _database(tmp_path / "pending-removed-membership.sqlite")
    user = models.User.create(username="books@example.test", stoken="before")
    collection = models.CollectionEntity.create(
        local_user=user,
        uid="contacts-pending",
        eb_col=b"collection-cache",
    )
    pending_item = models.ItemEntity.create(
        collection=collection,
        uid="pending-contact",
        eb_item=b"pending-item",
        dirty=True,
        deleted=True,
    )
    models.HrefMapper.create(content=pending_item, href="pending-contact.vcf")
    manager = MagicMock()
    manager.list.return_value = MagicMock(
        data=[],
        removed_memberships=["contacts-pending"],
        done=True,
        stoken="after-removal",
    )
    service = _service(database, user, manager)

    service.sync_collection_list()

    persisted_collection = models.CollectionEntity.get_by_id(collection.id)
    assert persisted_collection.deleted is False
    assert persisted_collection.dirty is True
    assert models.ItemEntity.get_by_id(pending_item.id).dirty is True
    assert models.HrefMapper.get(content=pending_item).href == "pending-contact.vcf"
