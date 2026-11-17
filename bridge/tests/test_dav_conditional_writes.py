"""Conditional DAV mutations and bounded SQLite contention."""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import peewee as pw
import pytest
from radicale.app import Application as RadicaleApplication

from silentsuite_bridge import local_cache
from silentsuite_bridge.local_cache import models
from silentsuite_bridge.radicale import storage
from silentsuite_bridge.radicale import etesync_cache
from tests.dav_fixtures import SdkItem, dav_world  # noqa: F401
from tests.test_carddav_remote_delete_convergence import _vcard
from tests.test_dav_collection_paths import PATCH, PROPS
from tests.test_macos_dav_discovery import USERNAME


@pytest.mark.parametrize("first,second,create", [
    ("PUT", "PUT", False), ("DELETE", "DELETE", False),
    ("DELETE", "PUT", False), ("PUT", "DELETE", False),
    ("PUT", "PUT", True),
])
def test_conditional_writes_serialize(dav_world, monkeypatch, first, second, create):
    world = dav_world
    col = world.add_collection()
    if not create:
        world.add_item(col)
    etag = None if create else world.collection()._get("contact-1.vcf").etag
    headers = {"HTTP_IF_NONE_MATCH": "*"} if create else {"HTTP_IF_MATCH": etag}
    first_ready, second_begin, allow_second = (threading.Event() for _ in range(3))
    original_begin = world.database.begin
    original_upload, original_delete = storage.Collection.upload, storage.Collection.delete

    def begin(*args, **kwargs):
        kind = args[0] if args else kwargs.get("lock_type")
        if threading.current_thread().name == "second-writer" and kind == "IMMEDIATE":
            second_begin.set()
            assert allow_second.wait(10), "second writer was not released"
        return original_begin(*args, **kwargs)

    def gate(original, collection, *args, **kwargs):
        if threading.current_thread().name == "first-writer":
            first_ready.set()
            assert second_begin.wait(10), "second writer did not attempt its transaction"
        return original(collection, *args, **kwargs)

    monkeypatch.setattr(world.database, "begin", begin)
    monkeypatch.setattr(storage.Collection, "upload",
                        lambda self, *a, **kw: gate(original_upload, self, *a, **kw))
    monkeypatch.setattr(storage.Collection, "delete",
                        lambda self, *a, **kw: gate(original_delete, self, *a, **kw))

    def request(name, method):
        threading.current_thread().name = name
        return world.request(method, f"/{USERNAME}/contacts/contact-1.vcf",
                             _vcard("contact-1", name) if method == "PUT" else b"", headers)

    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(request, "first-writer", first)
        b = None
        try:
            assert first_ready.wait(10), "first request did not reach its checked mutation"
            b = pool.submit(request, "second-writer", second)
            assert second_begin.wait(10), "second request never reached BEGIN"
            result_a = a.result(timeout=10)
        finally:
            allow_second.set()
            second_begin.set()
        result_b = b.result(timeout=10) if b is not None else None
    assert result_a.status == (201 if first == "PUT" else 200), result_a.body
    assert result_b is not None and result_b.status == 412, result_b
    rows = list(models.ItemEntity.select())
    assert len(rows) == 1
    assert rows[0].deleted == (first == "DELETE")
    assert models.CollectionEntity.get_by_id(col.id).dav_revision == (1 if create else 2)


def test_pulled_revision_precedes_conditional_mutation(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    etag = world.collection()._get("contact-1.vcf").etag
    mutation_ready, pull_done = threading.Event(), threading.Event()
    original_begin = world.database.begin

    def begin(*args, **kwargs):
        kind = args[0] if args else kwargs.get("lock_type")
        if threading.current_thread().name == "dav-writer" and kind == "IMMEDIATE":
            mutation_ready.set()
            assert pull_done.wait(10)
        return original_begin(*args, **kwargs)

    monkeypatch.setattr(world.database, "begin", begin)
    incoming = SdkItem("remote-contact-1", {"name": "contact-1", "dav_href": "contact-1.vcf"},
                       _vcard("contact-1", "Remote revision").encode())

    def request():
        threading.current_thread().name = "dav-writer"
        return world.request("PUT", f"/{USERNAME}/contacts/contact-1.vcf",
                             _vcard("contact-1", "Local revision"), {"HTTP_IF_MATCH": etag})

    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(request)
        try:
            assert mutation_ready.wait(10)
            world.service()._apply_pulled_item(
                col, world.remote.store.load(col.eb_col), world.remote.item_mgr, incoming
            )
        finally:
            pull_done.set()
        response = pending.result(timeout=10)
    assert response.status == 412, response.body
    assert "Remote revision" in world.collection()._get("contact-1.vcf").serialize()


def test_fully_migrated_session_can_open_while_another_writer_is_active(dav_world):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    # Complete the token-index migration that follows first creation of DAV tables.
    local_cache._ensure_cache_tables(world.database)
    world.database.timeout = 0.025
    with ThreadPoolExecutor(max_workers=1) as pool:
        with world.database.atomic("IMMEDIATE"):
            pending = pool.submit(etesync_cache._etesync_cache.fresh_for_user,
                                  USERNAME, read_only=False)
            session, created = pending.result(timeout=5)
            assert created and session.user.id == world.user.id
            assert session._session_is_current()


def test_current_schema_migration_issues_only_reads(dav_world, monkeypatch):
    world = dav_world
    local_cache._ensure_cache_tables(world.database)
    execute = world.database.execute_sql

    def read_sql(sql, *args, **kwargs):
        assert sql.lstrip().split(None, 1)[0].upper() in {"SELECT", "PRAGMA"}, sql
        return execute(sql, *args, **kwargs)

    monkeypatch.setattr(world.database, "execute_sql", read_sql)
    local_cache._migrate_cache_schema(world.database)


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
@pytest.mark.parametrize("tail, expected", [
    ("", False), ("/", False), ("/contacts", False), ("/contacts/", False),
    ("/contacts/one.vcf", True), ("/contacts/one.vcf/", True),
])
def test_write_adapter_distinguishes_collection_and_item_depth(dav_world, monkeypatch, method, tail, expected):
    world = dav_world
    world.add_collection()
    observed = []

    def parent(app, environ, base_prefix, path, user):
        with app._storage.acquire_lock("w", user):
            observed.append(world.database.in_transaction())
        return 200, {}, None

    monkeypatch.setattr(RadicaleApplication, "do_" + method, parent)
    handler = getattr(world.app, "do_" + method)
    result = handler({}, "", f"/{USERNAME}" + tail, USERNAME)
    assert result[0] == 200
    assert observed == [expected], "depth <= 2 is collection-wide; depth 3 is one item"
    assert not world.database.in_transaction()


@pytest.mark.parametrize("method", [
    "GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT", "PUT", "DELETE",
    "MKCOL", "MKCALENDAR", "PROPPATCH", "MOVE",
])
def test_every_method_returns_retryable_503_under_sqlite_contention(dav_world, monkeypatch, method):
    world = dav_world
    col = world.add_collection()
    world.database.timeout = 0.025

    def write_in_handler(app, environ, base_prefix, path, user):
        models.CollectionEntity.update(dav_revision=models.CollectionEntity.dav_revision + 1).where(
            models.CollectionEntity.id == col.id
        ).execute()
        return 200, {}, None

    monkeypatch.setattr(RadicaleApplication, "do_" + method, write_in_handler)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with world.database.atomic("IMMEDIATE"):
            response = pool.submit(world.request, method, f"/{USERNAME}/contacts/").result(timeout=5)
            assert response.status == 503, response.body
            assert response.headers.get("Retry-After") == "1"
            assert models.CollectionEntity.get_by_id(col.id).dav_revision == 0
        response = pool.submit(world.request, method, f"/{USERNAME}/contacts/").result(timeout=5)
    assert response.status == 200
    assert models.CollectionEntity.get_by_id(col.id).dav_revision == 1


def test_unrelated_operational_error_is_not_reported_as_busy(dav_world, monkeypatch):
    def broken(*_args):
        raise pw.OperationalError("synthetic unrelated failure")

    monkeypatch.setattr(RadicaleApplication, "do_GET", broken)
    assert dav_world.request("GET", f"/{USERNAME}/contacts/").status == 500


def test_busy_pull_page_rolls_back_and_next_generation_recovers(dav_world):
    world = dav_world
    col = world.add_collection()
    world.database.timeout = 0.025
    incoming = SdkItem("remote-new", {"name": "new", "dav_href": "new.vcf"}, _vcard("new", "New").encode())
    world.remote.queue_item_page(incoming, stoken="page-after")
    with ThreadPoolExecutor(max_workers=1) as pool:
        with world.database.atomic("IMMEDIATE"):
            pending = pool.submit(world.service().pull_collection, col.uid)
            with pytest.raises(pw.OperationalError):
                pending.result(timeout=5)
            assert models.ItemEntity.select().count() == 0
            assert models.DavRevision.select().count() == 0
            assert models.CollectionEntity.get_by_id(col.id).local_stoken is None
        world.remote.queue_item_page(incoming, stoken="page-after")
        pool.submit(world.service().pull_collection, col.uid).result(timeout=5)
    assert models.ItemEntity.select().count() == 1
    assert models.CollectionEntity.get_by_id(col.id).local_stoken == "page-after"


def test_write_presync_wait_has_no_database_transaction(dav_world, monkeypatch):
    world = dav_world
    world.add_collection()
    entered, release = threading.Event(), threading.Event()
    thread = MagicMock()

    def wait(timeout):
        assert timeout == 20
        assert not world.database.in_transaction()
        entered.set()
        assert release.wait(10)
        return True

    thread.wait_for_sync.side_effect = wait
    monkeypatch.setattr(storage, "start_sync_thread", lambda _user: thread)
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(world.request, "PUT", f"/{USERNAME}/contacts/new.vcf", _vcard("new", "New"))
        try:
            assert entered.wait(10)
            response = world.request("PROPFIND", f"/{USERNAME}/contacts/", PROPS)
            assert response.status == 207
        finally:
            release.set()
        assert request.result(timeout=10).status == 201


def test_mapped_propfind_does_not_reserve_writer_behind_another_collection(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    world.add_item(col, uid="second")
    other = world.add_collection(uid="other")
    world.database.timeout = 0.025
    begins = []
    original = world.database.begin

    def begin(*args, **kwargs):
        kind = args[0] if args else kwargs.get("lock_type")
        if kind == "IMMEDIATE":
            begins.append(kind)
        return original(*args, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with world.database.atomic("IMMEDIATE"):
            models.CollectionEntity.update(dirty=True).where(models.CollectionEntity.id == other.id).execute()
            monkeypatch.setattr(world.database, "begin", begin)
            response = pool.submit(world.request, "PROPFIND", f"/{USERNAME}/contacts/", PROPS,
                                   {"HTTP_DEPTH": "1"}).result(timeout=5)
            assert response.status == 207, response.body
            assert b"contact-1.vcf" in response.body and b"second.vcf" in response.body
            assert begins == [], "mapped WAL readers must not reserve SQLite's writer"


def test_proppatch_uses_nested_savepoint_and_rolls_back_late_failure(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    before = col.eb_col
    depth = []
    original = local_cache.Collection.update_meta

    def update(collection, values):
        depth.append(world.database.transaction_depth())
        original(collection, values)
        raise RuntimeError("late metadata failure")

    monkeypatch.setattr(local_cache.Collection, "update_meta", update)
    result = world.request("PROPPATCH", f"/{USERNAME}/contacts/", PATCH)
    assert result.status == 500
    assert depth and depth[0] >= 1, "the request must own the outer writer transaction"
    assert models.CollectionEntity.get_by_id(col.id).eb_col == before
    assert not world.database.in_transaction()


def test_collection_delete_enumerates_outside_request_transaction(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    original = storage.Collection.get_all
    observed = []

    def inventory(collection):
        observed.append(world.database.in_transaction())
        yield from original(collection)

    monkeypatch.setattr(storage.Collection, "get_all", inventory)
    response = world.request("DELETE", f"/{USERNAME}/contacts/")
    assert response.status == 200
    assert observed == [False]
    assert models.CollectionEntity.get_by_id(col.id).deleted


@pytest.mark.parametrize("borrowed", [False, True])
def test_href_allocation_reserves_sqlite_before_python_lock(dav_world, monkeypatch, borrowed):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    before = local_cache.dav_collection_state_hash(col)
    observed = []
    lock = threading.RLock()

    def competing_update():
        connection = sqlite3.connect(world.database.database, timeout=0.025)
        try:
            connection.execute("UPDATE collectionentity SET dav_revision=dav_revision WHERE id=?", (col.id,))
            connection.commit()
            return "unreserved"
        except sqlite3.OperationalError as exc:
            assert exc.sqlite_errorcode & 255 == sqlite3.SQLITE_BUSY
            return "reserved"
        finally:
            connection.close()

    class OrderedLock:
        def __enter__(self):
            with ThreadPoolExecutor(max_workers=1) as pool:
                observed.append(pool.submit(competing_update).result(timeout=5))
            lock.acquire()
            return self

        def __exit__(self, *_args):
            lock.release()

    monkeypatch.setattr(local_cache, "_dav_href_allocation_lock", OrderedLock())
    from contextlib import nullcontext
    with world.database.atomic() if borrowed else nullcontext():
        if borrowed:
            models.CollectionEntity.get_by_id(col.id)
        # Stable listing reads bypass the lock; explicitly exercise replacement.
        local_cache.ensure_dav_href(row, "contact-1.vcf", ".vcf", replace_existing=True)
    assert observed == ["reserved"]
    assert local_cache.dav_collection_state_hash(col) == before


@pytest.mark.parametrize("trailing", ["", "/"])
def test_collection_import_uses_independent_item_transactions(dav_world, monkeypatch, trailing):
    import vobject
    from radicale.item import Item

    world = dav_world
    depths = []
    original = storage.Collection.upload

    def upload(collection, href, item):
        depths.append(world.database.transaction_depth())
        if href == "second.vcf":
            raise ValueError("second item refused")
        return original(collection, href, item)

    def parent(app, environ, base_prefix, path, user):
        items = [Item(vobject_item=vobject.readOne(_vcard(uid, uid)), href=uid + ".vcf",
                      collection_path=path.strip("/"))
                 for uid in ("first", "second")]
        with app._storage.acquire_lock("w", user):
            try:
                app._storage.create_collection(path, items, {"tag": "VADDRESSBOOK"})
            except ValueError:
                return 400, {}, None
        return 201, {}, None

    monkeypatch.setattr(storage.Collection, "upload", upload)
    monkeypatch.setattr(RadicaleApplication, "do_PUT", parent)
    result = world.app.do_PUT({}, "", f"/{USERNAME}/imported" + trailing, USERNAME)
    assert result[0] == 400
    assert depths == [0, 0], "collection imports must not hold a request-wide writer transaction"
    assert [row.uid for row in models.ItemEntity.select()] == ["first"]
    assert models.DavRevision.select().count() == 1
