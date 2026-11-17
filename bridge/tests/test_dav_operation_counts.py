"""DAV mutation cost and persistent sync-state proofs."""

import hashlib
import sqlite3
from contextlib import contextmanager

import pytest

from silentsuite_bridge import local_cache
from silentsuite_bridge.local_cache import models
from tests.dav_fixtures import SdkItem, dav_world  # noqa: F401
from tests.test_carddav_remote_delete_convergence import _vcard
from tests.test_macos_dav_discovery import USERNAME


class CountedCursor:
    def __init__(self, cursor, counter):
        self.cursor, self.counter = cursor, counter

    def __getattr__(self, name):
        return getattr(self.cursor, name)

    def fetchone(self):
        row = self.cursor.fetchone()
        self.counter["rows"] += row is not None
        return row

    def fetchall(self):
        rows = self.cursor.fetchall()
        self.counter["rows"] += len(rows)
        return rows

    def fetchmany(self, *args):
        rows = self.cursor.fetchmany(*args)
        self.counter["rows"] += len(rows)
        return rows

    def __iter__(self):
        while (row := self.fetchone()) is not None:
            yield row


@contextmanager
def item_reads(database, monkeypatch):
    counter = {"rows": 0, "counts": 0}
    original = database.execute_sql

    def execute(sql, params=None, *args, **kwargs):
        cursor = original(sql, params, *args, **kwargs)
        text = sql.lower()
        if text.lstrip().startswith("select") and '"itementity"' in text:
            if "count(" in text:
                counter["counts"] += 1
            else:
                return CountedCursor(cursor, counter)
        return cursor

    with monkeypatch.context() as patch:
        patch.setattr(database, "execute_sql", execute)
        yield counter


@pytest.mark.parametrize("inventory", [16, 64])
def test_pull_page_item_reads_are_linear(dav_world, monkeypatch, inventory):
    world = dav_world
    col = world.add_collection()
    for index in range(inventory):
        world.add_item(col, uid=f"existing-{index}")
    page_size = 8
    page = [SdkItem(f"remote-new-{index}",
                    {"name": f"new-{index}", "dav_href": f"new-{index}.vcf"},
                    _vcard(f"new-{index}", "New").encode())
            for index in range(page_size)]
    world.remote.queue_item_page(*page, stoken="next-page")
    with item_reads(world.database, monkeypatch) as counts:
        world.service().pull_collection(col.uid)
    assert counts["rows"] <= page_size * 12, counts
    assert counts["counts"] <= 1, counts
    assert models.ItemEntity.select().count() == inventory + page_size
    assert models.CollectionEntity.get_by_id(col.id).local_stoken == "next-page"


@pytest.mark.parametrize("replace", [False, True], ids=["create", "update"])
def test_sequential_wsgi_put_item_reads_are_linear(dav_world, monkeypatch, replace):
    world = dav_world
    col = world.add_collection()
    inventory, writes = 48, 8
    for index in range(inventory):
        world.add_item(col, uid=f"existing-{index}")
    with item_reads(world.database, monkeypatch) as counts:
        for index in range(writes):
            uid = f"existing-{index}" if replace else f"new-{index}"
            response = world.request("PUT", f"/{USERNAME}/contacts/{uid}.vcf", _vcard(uid, "Changed"))
            assert response.status == 201, response.body
    assert counts["rows"] <= inventory + writes * 12, counts
    assert counts["counts"] <= 1, counts


def legacy_hash(cache_col):
    digest = hashlib.sha256()

    def add(value):
        payload = b"<null>" if value is None else value if isinstance(value, bytes) else str(value).encode()
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)

    current = models.CollectionEntity.get_by_id(cache_col.id)
    for value in (current.eb_col, current.new, current.dirty, current.deleted, current.dav_revision):
        add(value)
    for item in models.ItemEntity.select().where(models.ItemEntity.collection == current).order_by(models.ItemEntity.id):
        mapper = models.HrefMapper.get_or_none(models.HrefMapper.content == item)
        for value in (item.id, item.uid, item.remote_uid, item.eb_item,
                      item.new, item.dirty, item.deleted, mapper.href if mapper else None):
            add(value)
    return digest.hexdigest()


def test_sync_token_format_upgrade_downgrade(dav_world):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    collection = world.collection()
    token, _ = collection.sync()
    stamp = local_cache.dav_collection_state_hash(col)
    assert stamp.startswith("v2:"), "new tokens must use an identifiable state-proof format"
    assert stamp != legacy_hash(col)
    # An older writer stores only the columns and format it knows.
    world.database.execute_sql("UPDATE davsynctoken SET state_hash=? WHERE collection_id=?",
                               (legacy_hash(col), col.id))
    with pytest.raises(ValueError, match="sync token"):
        collection.sync(token)
    new_token, hrefs = collection.sync()
    assert list(hrefs) == ["contact-1.vcf"]
    assert new_token != token
    world.database.close()
    world.database.connect()
    assert local_cache.dav_collection_state_hash(col) == stamp
    assert collection.sync(new_token)[1] == []


@pytest.mark.parametrize("field,value", [
    ("eb_item", b"different-envelope"), ("uid", "different-name"),
    ("remote_uid", "different-remote"), ("new", True), ("dirty", True), ("deleted", True),
])
def test_unledgered_item_write_invalidates_token(dav_world, field, value):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    collection = world.collection()
    token, _ = collection.sync()
    world.database.execute_sql(f'UPDATE itementity SET "{field}"=? WHERE id=?', (value, row.id))
    with pytest.raises(ValueError, match="sync token"):
        collection.sync(token)
    assert models.DavSyncToken.select().count() == 0


@pytest.mark.parametrize("mutation", ["insert", "delete", "href", "mapper-delete", "collection-envelope"])
def test_unledgered_inventory_write_breaks_retained_proof(dav_world, mutation):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    collection = world.collection()
    token, _ = collection.sync()
    if mutation == "insert":
        world.database.execute_sql(
            'INSERT INTO itementity (collection_id,uid,eb_item,"new",dirty,deleted) VALUES (?,?,?,0,0,0)',
            (col.id, "legacy-added", row.eb_item),
        )
    elif mutation == "delete":
        models.ItemEntity.delete().where(models.ItemEntity.id == row.id).execute()
    elif mutation == "href":
        world.database.execute_sql("UPDATE hrefmapper SET href=? WHERE content_id=?", ("other.vcf", row.id))
    elif mutation == "mapper-delete":
        models.HrefMapper.delete().where(models.HrefMapper.content == row).execute()
    else:
        world.database.execute_sql("UPDATE collectionentity SET eb_col=? WHERE id=?", (b"changed", col.id))
        # Keep the already-decoded wrapper; only the proof checker rereads the row.
    with pytest.raises(ValueError, match="sync token"):
        collection.sync(token)
    assert models.DavSyncToken.select().count() == 0


def test_state_fingerprint_rolls_back_and_old_inserts_get_defaults(dav_world):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    before = local_cache.dav_collection_state_hash(col)
    assert before.startswith("v2:")
    with pytest.raises(RuntimeError, match="late failure"):
        with world.database.atomic("IMMEDIATE"):
            models.ItemEntity.update(dirty=True).where(models.ItemEntity.id == row.id).execute()
            assert local_cache.dav_collection_state_hash(col) != before
            raise RuntimeError("late failure")
    assert local_cache.dav_collection_state_hash(col) == before
    world.database.execute_sql(
        'INSERT INTO collectionentity (local_user_id,uid,eb_col,"new",dirty,deleted,dav_revision) '
        "VALUES (?,?,?,0,0,0,0)", (world.user.id, "older-created", col.eb_col)
    )
    inserted = models.CollectionEntity.get(uid="older-created")
    assert local_cache.dav_collection_state_hash(inserted).startswith("v2:")
    local_cache._ensure_cache_tables(world.database)
    assert local_cache.dav_collection_state_hash(col) == before


def test_uid_conflict_uses_rendered_uid_after_older_write(dav_world):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col, uid="actual-uid", name="unrelated-metadata-name")
    result = world.request("PUT", f"/{USERNAME}/contacts/second.vcf", _vcard("actual-uid", "Duplicate"))
    assert result.status == 409 and b"no-uid-conflict" in result.body
    sdk = world.remote.store.load(row.eb_item)
    sdk.content = _vcard("changed-uid", "Changed").encode()
    world.database.execute_sql("UPDATE itementity SET eb_item=? WHERE id=?",
                               (world.remote.store.save(sdk), row.id))
    result = world.request("PUT", f"/{USERNAME}/contacts/second.vcf", _vcard("changed-uid", "Duplicate"))
    assert result.status == 409 and b"no-uid-conflict" in result.body


def test_uid_index_change_after_preparation_defers_the_write(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    older = SdkItem("older-remote", {"name": "older-name", "dav_href": "older.vcf"},
                    _vcard("new", "Older client").encode())
    blob = world.remote.store.save(older)
    original = world.database.begin
    injected = False

    def begin(*args, **kwargs):
        nonlocal injected
        kind = args[0] if args else kwargs.get("lock_type")
        if kind == "IMMEDIATE" and not injected:
            injected = True
            connection = sqlite3.connect(world.database.database)
            try:
                cursor = connection.execute(
                    'INSERT INTO itementity (collection_id,uid,remote_uid,eb_item,"new",dirty,deleted) '
                    "VALUES (?,?,?,?,0,0,0)", (col.id, "older-name", older.uid, blob)
                )
                connection.execute("INSERT INTO hrefmapper (content_id,href) VALUES (?,?)",
                                   (cursor.lastrowid, "older.vcf"))
                connection.commit()
            finally:
                connection.close()
        return original(*args, **kwargs)

    monkeypatch.setattr(world.database, "begin", begin)
    response = world.request("PUT", f"/{USERNAME}/contacts/new.vcf", _vcard("new", "New client"))
    assert injected
    assert response.status == 503 and response.headers.get("Retry-After") == "1", response
    assert models.ItemEntity.select().count() == 1
    response = world.request("PUT", f"/{USERNAME}/contacts/new.vcf", _vcard("new", "New client"))
    assert response.status == 409 and b"no-uid-conflict" in response.body


def test_cache_creation_sets_explicit_five_second_timeout(dav_world, monkeypatch, tmp_path):
    import playhouse.sqlite_ext

    original = playhouse.sqlite_ext.SqliteExtDatabase
    observed = []

    def create(*args, **kwargs):
        observed.append(kwargs.get("timeout"))
        return original(*args, **kwargs)

    monkeypatch.setattr(playhouse.sqlite_ext, "SqliteExtDatabase", create)
    try:
        database, initialized = local_cache._init_cache_database(str(tmp_path / "separate.sqlite"))
        assert initialized
        assert observed == [5.0], "the existing busy-wait policy must be explicit"
        assert database.timeout == 5.0
    finally:
        local_cache.db.database_proxy.initialize(dav_world.database)


def test_current_cache_schema_upgrades_without_changing_legacy_data(dav_world, tmp_path):
    path = tmp_path / "current-cache.sqlite"
    legacy = sqlite3.connect(path)
    legacy.executescript('''
        CREATE TABLE config (id INTEGER PRIMARY KEY, db_version INTEGER NOT NULL);
        INSERT INTO config VALUES (1,1);
        CREATE TABLE user (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, stoken TEXT);
        INSERT INTO user VALUES (1,'legacy@example.test',NULL);
        CREATE TABLE collectionentity (
            id INTEGER PRIMARY KEY, local_user_id INTEGER NOT NULL REFERENCES user(id),
            uid TEXT NOT NULL, eb_col BLOB NOT NULL, "new" INTEGER NOT NULL DEFAULT 0,
            dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
            stoken TEXT, local_stoken TEXT, dav_revision INTEGER NOT NULL DEFAULT 0,
            UNIQUE(local_user_id,uid));
        CREATE TABLE itementity (
            id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL REFERENCES collectionentity(id),
            uid TEXT NOT NULL, eb_item BLOB NOT NULL, "new" INTEGER NOT NULL DEFAULT 0,
            dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, remote_uid TEXT,
            UNIQUE(collection_id,uid), UNIQUE(collection_id,remote_uid));
        CREATE TABLE hrefmapper (
            content_id INTEGER PRIMARY KEY REFERENCES itementity(id) ON DELETE CASCADE,
            href TEXT NOT NULL);
        INSERT INTO collectionentity (id,local_user_id,uid,eb_col) VALUES (1,1,'contacts',X'0102');
        INSERT INTO itementity (id,collection_id,uid,eb_item,remote_uid)
            VALUES (1,1,'one',X'0304','remote-one');
        INSERT INTO hrefmapper VALUES (1,'one.vcf');
    ''')
    legacy.commit()
    legacy.close()
    service = local_cache.Etebase.__new__(local_cache.Etebase)
    service.username = "legacy@example.test"
    upgraded = None
    try:
        service._init_db(str(path))
        upgraded = service._database
        assert models.Config.get().db_version == 1
        assert models.CollectionEntity.get_by_id(1).eb_col == b"\x01\x02"
        assert models.ItemEntity.get_by_id(1).eb_item == b"\x03\x04"
        assert models.HrefMapper.get_by_id(1).href == "one.vcf"
        columns = {column.name for column in upgraded.get_columns("collectionentity")}
        assert {"dav_href", "dav_state_generation"} <= columns, columns
        assert "dav_uid" in {column.name for column in upgraded.get_columns("itementity")}
        upgraded.execute_sql("UPDATE collectionentity SET dav_href='chosen' WHERE id=1")
        # The prior release writes only columns that existed in its schema.
        upgraded.execute_sql("UPDATE collectionentity SET dirty=1 WHERE id=1")
        upgraded.close()
        service._init_db(str(path))
        assert models.CollectionEntity.get_by_id(1).dav_href == "chosen"
        assert local_cache.dav_collection_state_hash(models.CollectionEntity.get_by_id(1)).startswith("v2:")
    finally:
        if upgraded is not None and not upgraded.is_closed():
            upgraded.close()
        local_cache.db.database_proxy.initialize(dav_world.database)
