"""Vertical CardDAV regression: remote deletion must survive ordinary cache writers.

Drives the real ``local_cache.Etebase`` sync service (mocked SDK managers with a
round-trip cache store) and the real Radicale WSGI application. It proves that a
collection-envelope refresh or an upload acknowledgement, which change hashed
cache bytes/flags without any DAV-visible change, do not break the sync-token
chain and hide a remote tombstone behind ``valid-sync-token``.
"""
import logging
import xml.etree.ElementTree as ET
from collections import deque
from unittest.mock import MagicMock

import pytest
import vobject
from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge import __main__ as bridge_main
from silentsuite_bridge import config
from silentsuite_bridge import local_cache as local_cache_module
from silentsuite_bridge.local_cache import Etebase, db, models
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.storage import Collection
from tests.test_macos_dav_discovery import (
    DAV,
    USERNAME,
    _application,
    _basic_auth,
    _request,
)

SYNC_REPORT = b"""<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>{token}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag /></d:prop>
</d:sync-collection>
"""
COLLECTION_UID = "contacts"
HOSTILE_NAME = "../private-remote-name/../hostile-secret"
HOSTILE_HREF = "../../private-hostile-href.vcf"


def _vcard(uid, fn):
    return (
        "BEGIN:VCARD\r\nVERSION:3.0\r\n"
        f"UID:{uid}\r\nFN:{fn}\r\nN:{fn};;;;\r\nEND:VCARD\r\n"
    )


class _CacheStore:
    """Round-trip ``cache_save``/``cache_load`` keyed by object identity.

    Re-saving a *different* SDK object (a refreshed collection envelope, a
    tombstone) yields different bytes, exactly like a real envelope refresh.
    """

    def __init__(self):
        self._objects = {}

    def save(self, obj):
        key = id(obj)
        self._objects[key] = obj
        return key.to_bytes(8, "big")

    def load(self, blob):
        return self._objects[int.from_bytes(bytes(blob), "big")]


def _remote_item(uid, content, *, meta, deleted=False, etag):
    item = MagicMock()
    item.uid = uid
    item.content = content.encode()
    item.deleted = deleted
    item.etag = etag
    item.meta = dict(meta)

    def delete():
        item.deleted = True

    item.delete.side_effect = delete
    return item


def _remote_collection(stoken):
    collection = MagicMock()
    collection.uid = COLLECTION_UID
    collection.stoken = stoken
    collection.deleted = False
    collection.meta = {"name": "Contacts"}
    collection.collection_type = "etebase.vcard"
    collection.access_level = 0
    return collection


class _RemoteAccount:
    """Scripted Etebase managers: queued list pages, idle pages afterwards."""

    def __init__(self):
        self.store = _CacheStore()
        self.col_mgr = MagicMock()
        self.item_mgr = MagicMock()
        self.col_mgr.cache_save.side_effect = self.store.save
        self.col_mgr.cache_load.side_effect = self.store.load
        self.col_mgr.get_item_manager.return_value = self.item_mgr
        self.item_mgr.cache_save.side_effect = self.store.save
        self.item_mgr.cache_load.side_effect = self.store.load
        self.item_mgr.create.side_effect = self._create
        self.collection_pages = deque()
        self.item_pages = deque()
        self.col_mgr.list.side_effect = lambda *_args: self._next(
            self.collection_pages, memberships=True
        )
        self.item_mgr.list.side_effect = lambda *_args: self._next(
            self.item_pages
        )
        self.created = []

    def _next(self, pages, *, memberships=False):
        if pages:
            return pages.popleft()
        page = MagicMock(data=[], done=True, stoken="idle")
        if memberships:
            page.removed_memberships = []
        return page

    def _create(self, meta, content):
        item = _remote_item(
            f"remote-local-{len(self.created)}",
            content.decode(),
            meta=meta,
            etag=f"etag-local-{len(self.created)}",
        )
        self.created.append(item)
        return item

    def queue_collection_page(self, *collections, stoken):
        self.collection_pages.append(
            MagicMock(
                data=list(collections),
                removed_memberships=[],
                done=True,
                stoken=stoken,
            )
        )

    def queue_item_page(self, *items, stoken):
        self.item_pages.append(
            MagicMock(data=list(items), done=True, stoken=stoken)
        )


def _service(database, user, remote):
    account = MagicMock()
    account.get_collection_manager.return_value = remote.col_mgr
    service = Etebase.__new__(Etebase)
    service.etebase = account
    service.username = user.username
    service._database = database
    service.stored_session = "fake"
    service.user = user
    return service


def _bridge(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    database = SqliteExtDatabase(
        config.DATABASE_FILE,
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
    user = models.User.create(username=USERNAME)
    remote = _RemoteAccount()

    def cached_collection(uid):
        return local_cache_module.Collection(
            remote.col_mgr,
            models.CollectionEntity.get(
                (models.CollectionEntity.local_user == user)
                & (models.CollectionEntity.uid == uid)
            ),
        )

    etesync = MagicMock()
    etesync.get.side_effect = cached_collection
    etesync.list.side_effect = lambda: [cached_collection(COLLECTION_UID)]
    context = MagicMock()
    context.__enter__.return_value = (etesync, False)
    context.__exit__.return_value = False
    monkeypatch.setattr(
        bridge_storage,
        "etesync_for_user",
        lambda _user, **_kwargs: context,
    )
    direct_storage = MagicMock()
    direct_storage.etesync = etesync
    return app, database, user, remote, direct_storage


def _seed(remote, service):
    contact_a = _remote_item(
        "remote-a",
        _vcard("contact-a", "Contact A"),
        meta={"name": "contact-a", "dav_href": "contact-a.vcf"},
        etag="etag-a-1",
    )
    contact_b = _remote_item(
        "remote-b",
        _vcard("contact-b", "Contact B"),
        meta={"name": "contact-b", "dav_href": "contact-b.vcf"},
        etag="etag-b-1",
    )
    remote.queue_collection_page(_remote_collection("col-1"), stoken="list-1")
    remote.queue_item_page(contact_a, contact_b, stoken="items-1")
    service.sync()
    return contact_a, contact_b


def _report(app, token=None):
    body = SYNC_REPORT.replace(b"{token}", (token or "").encode())
    status, _headers, response_body = _request(
        app,
        f"/{USERNAME}/{COLLECTION_UID}/",
        method="REPORT",
        body=body,
        depth="1",
        auth=_basic_auth(),
    )
    if status != "207 Multi-Status":
        return status, {}, None
    root = ET.fromstring(response_body)
    responses = {}
    for response in root.findall(f"{DAV}response"):
        href = response.findtext(f"{DAV}href", "").rsplit("/", 1)[-1]
        direct_status = response.findtext(f"{DAV}status")
        if direct_status is not None:
            responses[href] = (direct_status, None)
            continue
        propstat = response.find(f"{DAV}propstat")
        responses[href] = (
            propstat.findtext(f"{DAV}status"),
            propstat.findtext(f"{DAV}prop/{DAV}getetag"),
        )
    return status, responses, root.findtext(f"{DAV}sync-token")


def _production_logging_boundary(monkeypatch):
    """Apply the Bridge's real dependency log boundary under DEBUG capture.

    ``caplog.set_level(DEBUG)`` raises the root logger, so peewee would emit
    SQL parameters (hrefs, tokens) that production never logs: the Bridge's
    ``configure_logging`` pins dependency loggers above CRITICAL regardless of
    the product level. Exercise that function rather than re-listing the
    loggers here, and restore every touched level at teardown.
    """
    for name in ("peewee", "etebase", "requests", "urllib3", "httpx", "httpcore"):
        dependency_logger = logging.getLogger(name)
        monkeypatch.setattr(dependency_logger, "level", dependency_logger.level)
    monkeypatch.setattr(config, "LOG_FILE", None)
    # Same precedent as test_main_startup: keep pytest's capture handler as the
    # only root handler instead of letting basicConfig add a stderr handler.
    monkeypatch.setattr(logging, "basicConfig", MagicMock())
    bridge_main.configure_logging()


def _cache_col(user):
    return models.CollectionEntity.get(
        (models.CollectionEntity.local_user == user)
        & (models.CollectionEntity.uid == COLLECTION_UID)
    )


@pytest.mark.parametrize("tombstone_meta", [
    pytest.param({"name": "contact-a", "dav_href": "contact-a.vcf"}, id="named"),
    pytest.param({}, id="nameless"),
    pytest.param({"name": HOSTILE_NAME, "dav_href": HOSTILE_HREF}, id="hostile"),
])
def test_remote_deletion_survives_collection_refresh_and_reports_404(
    tmp_path,
    monkeypatch,
    caplog,
    tombstone_meta,
):
    caplog.set_level(logging.DEBUG)
    _production_logging_boundary(monkeypatch)
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    contact_a, contact_b = _seed(remote, service)

    status, responses, token_1 = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == {"contact-a.vcf", "contact-b.vcf"}
    assert token_1
    cache_col = _cache_col(user)
    revision_before = cache_col.dav_revision

    # Another device deleted A, updated B and created C. The collection's
    # stoken advanced, so the next collection-list page refreshes the cached
    # collection envelope before the item pull applies the tombstone.
    tombstone_a = _remote_item(
        "remote-a", "", meta=tombstone_meta, deleted=True, etag="etag-a-1"
    )
    updated_b = _remote_item(
        "remote-b",
        _vcard("contact-b", "Contact B Updated"),
        meta={"name": "contact-b", "dav_href": "contact-b.vcf"},
        etag="etag-b-2",
    )
    created_c = _remote_item(
        "remote-c",
        _vcard("contact-c", "Contact C"),
        meta={"name": "contact-c", "dav_href": "contact-c.vcf"},
        etag="etag-c-1",
    )
    remote.queue_collection_page(_remote_collection("col-2"), stoken="list-2")
    remote.queue_item_page(tombstone_a, updated_b, created_c, stoken="items-2")
    service.sync()

    cache_col = _cache_col(user)
    assert cache_col.dav_revision == revision_before + 3
    rows_a = list(
        models.ItemEntity.select().where(
            (models.ItemEntity.collection == cache_col)
            & (models.ItemEntity.remote_uid == "remote-a")
        )
    )
    assert len(rows_a) == 1 and rows_a[0].deleted
    assert models.ItemEntity.select().where(
        models.ItemEntity.collection == cache_col
    ).count() == 3
    assert models.DavUnresolvedItem.select().count() == 0

    # The client that still holds token_1 must learn about the deletion as a
    # literal 404 on the original href, not lose its token to valid-sync-token.
    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses["contact-a.vcf"] == ("HTTP/1.1 404 Not Found", None)
    assert responses["contact-b.vcf"] == ("HTTP/1.1 200 OK", '"etag-b-2"')
    assert responses["contact-c.vcf"] == ("HTTP/1.1 200 OK", '"etag-c-1"')
    assert token_2 and token_2 != token_1

    tokens = {
        row.token: row
        for row in models.DavSyncToken.select().where(
            models.DavSyncToken.collection == cache_col
        )
    }
    prefix = "http://radicale.org/ns/sync/"
    assert token_1[len(prefix):] in tokens
    assert token_2[len(prefix):] in tokens
    token_1_row = tokens[token_1[len(prefix):]]
    token_2_row = tokens[token_2[len(prefix):]]
    assert token_1_row.revision == revision_before
    assert token_2_row.revision == cache_col.dav_revision
    # `_prune_sync_history` drops ledger rows at or before the oldest
    # retained token. Seed revisions are not needed to serve deltas from
    # token_1; the retained interval is (oldest_token, current].
    retained = list(
        models.DavRevision.select()
        .where(models.DavRevision.collection == cache_col)
        .order_by(models.DavRevision.revision)
    )
    assert [row.revision for row in retained] == list(
        range(token_1_row.revision + 1, cache_col.dav_revision + 1)
    )
    assert [(row.href, row.deleted, row.etag) for row in retained] == [
        ("contact-a.vcf", True, "etag-a-1"),
        ("contact-b.vcf", False, "etag-b-2"),
        ("contact-c.vcf", False, "etag-c-1"),
    ]
    proven = token_1_row.state_hash
    for change in retained:
        assert change.previous_state_hash == proven
        proven = change.state_hash
    assert proven == token_2_row.state_hash

    # Restart / sibling instance: retained tokens stay valid and idempotent.
    restarted = _service(database, models.User.get_by_id(user.id), remote)
    restarted.sync()
    status, responses, token_3 = _report(app, token_2)
    assert status == "207 Multi-Status"
    assert responses == {}
    assert token_3 == token_2
    status, responses, _token = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses["contact-a.vcf"] == ("HTTP/1.1 404 Not Found", None)
    status, responses, _token = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == {"contact-b.vcf", "contact-c.vcf"}

    # Privacy: no token value, href, hostile metadata or account path in logs.
    assert token_1[len(prefix):] not in caplog.text
    assert token_2[len(prefix):] not in caplog.text
    assert HOSTILE_NAME not in caplog.text
    assert "private-hostile-href" not in caplog.text
    assert "private-remote-name" not in caplog.text
    assert "contact-a.vcf" not in caplog.text
    assert USERNAME not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_local_create_token_survives_upload_acknowledgement(
    tmp_path,
    monkeypatch,
    caplog,
):
    caplog.set_level(logging.DEBUG)
    _production_logging_boundary(monkeypatch)
    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    status, _responses, token_1 = _report(app)
    assert status == "207 Multi-Status"

    # A macOS client creates a contact through the Bridge.
    local_item = MagicMock()
    local_item.vobject_item = vobject.readOne(_vcard("contact-local", "Local C"))
    direct_collection = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    direct_collection.upload("contact-local.vcf", local_item)
    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {"contact-local.vcf": ("HTTP/1.1 200 OK", '"etag-local-0"')}
    assert token_2 != token_1

    # Background sync pushes it (acknowledgement clears dirty/new and re-saves
    # the envelope) and the pull echoes the same item back.
    created = remote.created[0]
    remote.queue_item_page(created, stoken="items-2")
    service.sync()
    cache_col = _cache_col(user)
    local_row = models.ItemEntity.get(
        (models.ItemEntity.collection == cache_col)
        & (models.ItemEntity.remote_uid == created.uid)
    )
    assert not local_row.dirty and not local_row.new

    status, responses, token_3 = _report(app, token_2)
    assert status == "207 Multi-Status"
    assert responses == {"contact-local.vcf": ("HTTP/1.1 200 OK", '"etag-local-0"')}
    assert token_3 != token_2
    status, responses, token_4 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {"contact-local.vcf": ("HTTP/1.1 200 OK", '"etag-local-0"')}
    assert token_4 == token_3
    assert "contact-local" not in caplog.text
    assert USERNAME not in caplog.text


def test_unproven_mutation_after_refresh_still_fails_closed(
    tmp_path,
    monkeypatch,
):
    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    status, _responses, token_1 = _report(app)
    assert status == "207 Multi-Status"

    # Legitimate envelope refresh, then a downgrade-era writer mutates an item
    # without a ledger row. The integrity guard must still reject the token.
    remote.queue_collection_page(_remote_collection("col-2"), stoken="list-2")
    service.sync()
    cache_col = _cache_col(user)
    row = models.ItemEntity.get(
        (models.ItemEntity.collection == cache_col)
        & (models.ItemEntity.remote_uid == "remote-b")
    )
    # Faithful old-writer mutation: a valid, loadable envelope for the same
    # remote item with different content, written without advancing the ledger.
    stale_b = _remote_item(
        "remote-b",
        _vcard("contact-b", "Contact B Stale Writer"),
        meta={"name": "contact-b", "dav_href": "contact-b.vcf"},
        etag="etag-b-stale",
    )
    row.eb_item = remote.store.save(stale_b)
    row.save(only=[models.ItemEntity.eb_item])

    direct_collection = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    with pytest.raises(ValueError, match="unknown sync token"):
        direct_collection.sync(token_1)
    assert models.DavSyncToken.select().count() == 0
    status, _responses, _token = _report(app, token_1)
    assert status != "207 Multi-Status"
    status, responses, replacement = _report(app)
    assert status == "207 Multi-Status"
    assert replacement != token_1
    assert set(responses) == {"contact-a.vcf", "contact-b.vcf"}


def test_unproven_mutation_before_refresh_still_fails_closed(
    tmp_path,
    monkeypatch,
):
    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    status, _responses, token_1 = _report(app)
    assert status == "207 Multi-Status"

    cache_col = _cache_col(user)
    row = models.ItemEntity.get(
        (models.ItemEntity.collection == cache_col)
        & (models.ItemEntity.remote_uid == "remote-b")
    )
    stale_b = _remote_item(
        "remote-b",
        _vcard("contact-b", "Contact B Stale Writer"),
        meta={"name": "contact-b", "dav_href": "contact-b.vcf"},
        etag="etag-b-stale",
    )
    row.eb_item = remote.store.save(stale_b)
    row.save(only=[models.ItemEntity.eb_item])

    remote.queue_collection_page(_remote_collection("col-2"), stoken="list-2")
    service.sync()

    direct_collection = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    with pytest.raises(ValueError, match="unknown sync token"):
        direct_collection.sync(token_1)
    assert models.DavSyncToken.select().count() == 0
    status, responses, replacement = _report(app)
    assert status == "207 Multi-Status"
    assert replacement != token_1
    assert set(responses) == {"contact-a.vcf", "contact-b.vcf"}


def _inject_deleted_duplicate(user, remote):
    cache_col = _cache_col(user)
    deleted_item = _remote_item(
        "remote-b",
        "",
        meta={"name": "contact-duplicate"},
        deleted=True,
        etag="etag-dup-deleted",
    )
    pending = models.ItemEntity.create(
        collection=cache_col,
        uid="contact-duplicate",
        eb_item=remote.store.save(deleted_item),
        deleted=True,
        dirty=True,
        new=True,
    )
    models.DavUnresolvedItem.create(
        collection=cache_col,
        remote_uid="legacy-cache:pending",
        eb_item=remote.store.save(deleted_item),
        deleted=True,
        reason="legacy_duplicate",
        local_item=pending,
    )
    return pending


def _inject_attached_dirty_new(user, remote):
    cache_col = _cache_col(user)
    pending_remote = _remote_item(
        "remote-pending",
        _vcard("contact-pending", "Pending"),
        meta={"name": "contact-pending", "dav_href": "contact-pending.vcf"},
        etag="etag-pending-1",
    )
    pending = models.ItemEntity.create(
        collection=cache_col,
        uid="contact-pending",
        eb_item=remote.store.save(pending_remote),
        dirty=True,
        new=True,
    )
    models.HrefMapper.create(content=pending, href="contact-pending.vcf")
    models.DavUnresolvedItem.create(
        collection=cache_col,
        remote_uid="legacy-cache:pending",
        eb_item=remote.store.save(pending_remote),
        reason="legacy_corrupt",
        local_item=pending,
    )
    return pending


def _recover_idle_then_unrelated_deletion_reports_404(
    app,
    user,
    remote,
    service,
    token_1,
    live_hrefs,
):
    cache_col = _cache_col(user)
    revision_before = cache_col.dav_revision
    service.pull_collection(COLLECTION_UID)
    cache_col = _cache_col(user)
    assert cache_col.dav_revision == revision_before
    assert models.DavUnresolvedItem.select().count() == 0

    status, responses, token_idle = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {}
    assert token_idle == token_1

    status, responses, token_same_revision = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == live_hrefs
    assert token_same_revision == token_1

    tombstone_a = _remote_item(
        "remote-a",
        "",
        meta={"name": "contact-a", "dav_href": "contact-a.vcf"},
        deleted=True,
        etag="etag-a-1",
    )
    remote.queue_item_page(tombstone_a, stoken="items-tombstone")
    service.pull_collection(COLLECTION_UID)

    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses["contact-a.vcf"] == ("HTTP/1.1 404 Not Found", None)
    assert token_2 and token_2 != token_1

    status, responses, token_from_prior = _report(app, token_same_revision)
    assert status == "207 Multi-Status"
    assert responses["contact-a.vcf"] == ("HTTP/1.1 404 Not Found", None)
    assert token_from_prior == token_2

    prefix = "http://radicale.org/ns/sync/"
    cache_col = _cache_col(user)
    tokens = {
        row.token: row
        for row in models.DavSyncToken.select().where(
            models.DavSyncToken.collection == cache_col
        )
    }
    assert token_1[len(prefix):] in tokens
    assert token_2[len(prefix):] in tokens
    assert tokens[token_1[len(prefix):]].revision == revision_before
    assert tokens[token_2[len(prefix):]].revision == cache_col.dav_revision
    assert cache_col.dav_revision == revision_before + 1


def test_deleted_duplicate_recovery_keeps_token_through_idle_page_and_later_404(
    tmp_path,
    monkeypatch,
):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    pending = _inject_deleted_duplicate(user, remote)

    status, responses, token_1 = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == {"contact-a.vcf", "contact-b.vcf"}
    assert token_1
    assert models.DavUnresolvedItem.select().count() == 1

    _recover_idle_then_unrelated_deletion_reports_404(
        app,
        user,
        remote,
        service,
        token_1,
        {"contact-a.vcf", "contact-b.vcf"},
    )
    resolved = models.ItemEntity.get_by_id(pending.id)
    assert resolved.deleted is True
    assert resolved.dirty is False
    assert resolved.new is False


def test_attached_dirty_new_recovery_keeps_token_through_idle_page_and_later_404(
    tmp_path,
    monkeypatch,
):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    pending = _inject_attached_dirty_new(user, remote)

    status, responses, token_1 = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == {
        "contact-a.vcf",
        "contact-b.vcf",
        "contact-pending.vcf",
    }
    assert token_1
    assert models.DavUnresolvedItem.select().count() == 1

    _recover_idle_then_unrelated_deletion_reports_404(
        app,
        user,
        remote,
        service,
        token_1,
        {"contact-a.vcf", "contact-b.vcf", "contact-pending.vcf"},
    )
    recovered = models.ItemEntity.get_by_id(pending.id)
    assert recovered.remote_uid == "remote-pending"
    assert recovered.dirty is True
    assert recovered.new is True
