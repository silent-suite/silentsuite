"""One collection that can no longer be written must not stop the account.

A shared collection can be downgraded to read-only, or its membership removed,
while the Bridge still holds unsynced edits for it. Uploading those edits then
fails on every cycle. The other collections must keep syncing, the pending
edits must stay pending, and the failure must still be reported.

Real code under test: file-backed SQLite, ``Etebase.sync`` with its collection
list push/pull, per-collection push and pull. Stubbed: the SDK collection and
item managers. All literals are synthetic.
"""

import logging
from unittest.mock import MagicMock

import pytest
from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge.local_cache import (
    Etebase,
    SessionSuperseded,
    db,
    models,
)

BROKEN = "collection-broken"
HEALTHY = "collection-healthy"


class PermissionDenied(Exception):
    """Stands in for the SDK error raised on a 403 write."""


class NotFound(Exception):
    """Stands in for the SDK error raised for a collection left behind."""


class _Store:
    def __init__(self):
        self._objects = {}

    def save(self, obj):
        self._objects[id(obj)] = obj
        return id(obj).to_bytes(8, "big")

    def load(self, blob):
        return self._objects[int.from_bytes(bytes(blob), "big")]


def _idle_page(stoken, *, memberships=False):
    page = MagicMock(data=[], done=True, stoken=stoken)
    if memberships:
        page.removed_memberships = []
    return page


class _World:
    def __init__(self, tmp_path):
        self.database = SqliteExtDatabase(
            str(tmp_path / "isolation.sqlite"), pragmas={"foreign_keys": 1}
        )
        db.database_proxy.initialize(self.database)
        self.database.create_tables(
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
        models.SchemaMigration.create(name="dav-revision-v1", applied_at=0)
        self.user = models.User.create(username="isolation@example.test")
        self.store = _Store()
        self.col_mgr = MagicMock()
        self.col_mgr.cache_save.side_effect = self.store.save
        self.col_mgr.cache_load.side_effect = self.store.load
        self.collection_pages = []
        self.col_mgr.list.side_effect = lambda *_args: (
            self.collection_pages.pop(0)
            if self.collection_pages
            else _idle_page("list-idle", memberships=True)
        )
        self.item_mgrs = {}
        self.item_pages = {}
        self.col_mgr.get_item_manager.side_effect = (
            lambda col: self.item_mgrs[col.uid]
        )
        self.rows = {}
        for uid in (BROKEN, HEALTHY):
            remote = MagicMock(
                uid=uid,
                collection_type="etebase.vevent",
                deleted=False,
                stoken=uid + "-stoken",
            )
            self.rows[uid] = models.CollectionEntity.create(
                local_user=self.user, uid=uid, eb_col=self.store.save(remote)
            )
            item_mgr = MagicMock()
            item_mgr.cache_save.side_effect = self.store.save
            item_mgr.cache_load.side_effect = self.store.load
            self.item_pages[uid] = []
            item_mgr.list.side_effect = self._lister(uid)
            self.item_mgrs[uid] = item_mgr
        account = MagicMock()
        account.get_collection_manager.return_value = self.col_mgr
        self.service = Etebase.__new__(Etebase)
        self.service.etebase = account
        self.service.username = self.user.username
        self.service._database = self.database
        self.service.stored_session = "fake"
        self.service.user = self.user

    def _lister(self, uid):
        def list_page(_fetch_options):
            pages = self.item_pages[uid]
            return pages.pop(0) if pages else _idle_page(uid + "-idle")

        return list_page

    def pending_edit(self, uid):
        edited = MagicMock(uid="remote-pending", deleted=False, etag="etag-p")
        edited.meta = {"name": "pending-event", "mtime": 1700000000000}
        return models.ItemEntity.create(
            collection=self.rows[uid],
            uid="pending-event",
            remote_uid="remote-pending",
            eb_item=self.store.save(edited),
            dirty=True,
        )

    def queue_remote_event(self, uid, remote_uid, stoken):
        event = MagicMock(uid=remote_uid, deleted=False, etag="etag-" + remote_uid)
        event.meta = {"name": remote_uid + "-name", "mtime": 1700000000000}
        event.content = b"synthetic-content"
        self.item_pages[uid].append(
            MagicMock(data=[event], done=True, stoken=stoken)
        )

    def items(self, uid):
        return list(
            models.ItemEntity.select().where(
                models.ItemEntity.collection == self.rows[uid]
            )
        )

    def collection(self, uid):
        return models.CollectionEntity.get_by_id(self.rows[uid].id)


def _assert_private(caplog):
    for secret in (
        BROKEN,
        HEALTHY,
        "pending-event",
        "remote-pending",
        "isolation@example.test",
    ):
        assert secret not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_read_only_collection_with_pending_edit_does_not_stop_others(
    tmp_path, caplog
):
    caplog.set_level(logging.INFO)
    world = _World(tmp_path)
    pending = world.pending_edit(BROKEN)
    world.item_mgrs[BROKEN].transaction.side_effect = PermissionDenied("synthetic")

    for cycle in (1, 2):
        world.queue_remote_event(HEALTHY, f"remote-new-{cycle}", f"s{cycle}")
        with pytest.raises(PermissionDenied):
            world.service.sync()

        healthy_items = {row.remote_uid for row in world.items(HEALTHY)}
        assert f"remote-new-{cycle}" in healthy_items
        assert world.collection(HEALTHY).local_stoken == f"s{cycle}"

    kept = models.ItemEntity.get_by_id(pending.id)
    assert kept.dirty is True
    assert kept.eb_item == pending.eb_item
    assert world.item_mgrs[BROKEN].transaction.call_count == 2
    assert "Collection sync failed; other collections continue (PermissionDenied)" in (
        caplog.text
    )
    _assert_private(caplog)


def test_removed_membership_with_pending_edit_does_not_stop_others(
    tmp_path, caplog
):
    caplog.set_level(logging.INFO)
    world = _World(tmp_path)
    pending = world.pending_edit(BROKEN)
    removal = _idle_page("list-1")
    removal.removed_memberships = [BROKEN]
    world.collection_pages.append(removal)
    world.item_mgrs[BROKEN].transaction.side_effect = NotFound("synthetic")
    world.col_mgr.upload.side_effect = NotFound("synthetic")

    world.queue_remote_event(HEALTHY, "remote-new-1", "s1")
    with pytest.raises(NotFound):
        world.service.sync()
    # Pending edits keep the removed collection; it is marked for restoration.
    assert world.collection(BROKEN).dirty is True
    assert world.collection(BROKEN).deleted is False
    assert world.collection(HEALTHY).local_stoken == "s1"

    world.queue_remote_event(HEALTHY, "remote-new-2", "s2")
    with pytest.raises(NotFound):
        world.service.sync()

    world.col_mgr.upload.assert_called_once()
    assert {row.remote_uid for row in world.items(HEALTHY)} >= {
        "remote-new-1",
        "remote-new-2",
    }
    assert world.collection(HEALTHY).local_stoken == "s2"
    assert models.User.get_by_id(world.user.id).stoken == "list-idle"
    kept = models.ItemEntity.get_by_id(pending.id)
    assert kept.dirty is True
    assert world.collection(BROKEN).dirty is True
    assert "Collection upload failed; other collections continue (NotFound)" in (
        caplog.text
    )
    _assert_private(caplog)


def test_permission_restored_uploads_kept_edit_and_succeeds(tmp_path):
    world = _World(tmp_path)
    pending = world.pending_edit(BROKEN)
    world.item_mgrs[BROKEN].transaction.side_effect = PermissionDenied("synthetic")
    with pytest.raises(PermissionDenied):
        world.service.sync()

    world.item_mgrs[BROKEN].transaction.side_effect = None
    world.service.sync()

    uploaded = models.ItemEntity.get_by_id(pending.id)
    assert uploaded.dirty is False
    assert world.item_mgrs[BROKEN].transaction.call_count == 2


def test_superseded_session_still_stops_the_cycle(tmp_path):
    world = _World(tmp_path)
    world.service.push_collection = MagicMock(
        side_effect=SessionSuperseded("replaced")
    )
    world.service.pull_collection = MagicMock()

    with pytest.raises(SessionSuperseded):
        world.service.sync()

    world.service.push_collection.assert_called_once()
    world.service.pull_collection.assert_not_called()
