"""DAV mutation cost and persistent sync-state proofs."""

import hashlib
import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace

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


@contextmanager
def hash_work(database, monkeypatch):
    """Count real hash calls, inventory rows and SQL inside each pass."""
    counts = {"passes": 0, "rows": 0, "queries": 0, "mapper_queries": 0}
    original_hash = local_cache.dav_collection_state_hash
    original_sql = database.execute_sql
    inside = False

    def execute(sql, params=None, *args, **kwargs):
        cursor = original_sql(sql, params, *args, **kwargs)
        if inside:
            counts["queries"] += 1
            if sql.lower().lstrip().startswith("select"):
                if 'from "hrefmapper"' in sql.lower():
                    counts["mapper_queries"] += 1
                if 'from "itementity"' in sql.lower():
                    return CountedCursor(cursor, counts)
        return cursor

    def state_hash(*args, **kwargs):
        nonlocal inside
        counts["passes"] += 1
        inside = True
        try:
            return original_hash(*args, **kwargs)
        finally:
            inside = False

    with monkeypatch.context() as patch:
        patch.setattr(local_cache, "dav_collection_state_hash", state_hash)
        patch.setattr(database, "execute_sql", execute)
        # Storage imports the helper directly.
        patch.setattr("silentsuite_bridge.radicale.storage.dav_collection_state_hash", state_hash)
        yield counts


@pytest.mark.parametrize("inventory", [16, 64])
@pytest.mark.parametrize("page_size", [1, 8])
def test_pull_page_item_reads_are_linear(dav_world, monkeypatch, inventory, page_size):
    world = dav_world
    col = world.add_collection()
    for index in range(inventory):
        world.add_item(col, uid=f"existing-{index}")
    page = [SdkItem(f"remote-new-{index}",
                    {"name": f"new-{index}", "dav_href": f"new-{index}.vcf"},
                    _vcard(f"new-{index}", "New").encode())
            for index in range(page_size)]
    world.remote.queue_item_page(*page, stoken="next-page")
    with item_reads(world.database, monkeypatch) as reads:
        with hash_work(world.database, monkeypatch) as counts:
            world.service().pull_collection(col.uid)
    assert counts["passes"] == 2, counts
    assert counts["rows"] == 2 * inventory + page_size, counts
    assert counts["queries"] == 4 and counts["mapper_queries"] == 0, counts
    assert reads["rows"] <= 2 * inventory + page_size * 12, reads
    assert reads["counts"] == 0, reads
    assert models.ItemEntity.select().count() == inventory + page_size
    assert models.CollectionEntity.get_by_id(col.id).local_stoken == "next-page"


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
def test_single_wsgi_mutation_hashes_only_stored_states(dav_world, monkeypatch, method):
    world = dav_world
    col = world.add_collection()
    inventory = 16
    for index in range(inventory):
        world.add_item(col, uid=f"existing-{index}")
    with hash_work(world.database, monkeypatch) as counts:
        response = world.request(method, f"/{USERNAME}/contacts/existing-0.vcf",
                                 _vcard("existing-0", "Changed") if method == "PUT" else b"")
    assert response.status == (201 if method == "PUT" else 200), response
    assert counts["passes"] == 2, counts
    assert counts["rows"] == inventory * 2, counts
    assert counts["queries"] == 4 and counts["mapper_queries"] == 0, counts
    assert local_cache.dav_collection_state_hash(col) == legacy_hash(col)


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


def legacy_delta(cache_col, token):
    """Earlier releases' unchanged current-proof and historical-chain checks."""
    col = models.CollectionEntity.get_by_id(cache_col.id)
    state = legacy_hash(col)
    current = models.DavSyncToken.get_or_none(
        (models.DavSyncToken.collection == col) & (models.DavSyncToken.revision == col.dav_revision)
    )
    tail = current or models.DavRevision.get_or_none(
        (models.DavRevision.collection == col) & (models.DavRevision.revision == col.dav_revision)
    )
    if tail is not None and tail.state_hash != state or tail is None and col.dav_revision:
        raise ValueError("unknown sync token")
    start = models.DavSyncToken.get(
        (models.DavSyncToken.collection == col) & (models.DavSyncToken.token == token.rsplit("/", 1)[-1])
    )
    if start.revision == col.dav_revision:
        return []
    rows = list(models.DavRevision.select().where(
        (models.DavRevision.collection == col) & (models.DavRevision.revision > start.revision)
        & (models.DavRevision.revision <= col.dav_revision)
    ).order_by(models.DavRevision.revision))
    if len(rows) != col.dav_revision - start.revision:
        raise ValueError("unknown sync token")
    proof = start.state_hash
    for row in rows:
        if proof is None or row.previous_state_hash != proof:
            raise ValueError("unknown sync token")
        proof = row.state_hash
    if proof != state:
        raise ValueError("unknown sync token")
    return sorted({row.href for row in rows})


def test_content_hash_keeps_exact_legacy_bytes(dav_world):
    world = dav_world
    col = models.CollectionEntity.create(local_user=world.user, uid="fixed", eb_col=b"\x00col",
                                         dirty=True, dav_revision=3)
    mapped = models.ItemEntity.create(id=2, collection=col, uid="alpha", remote_uid="remote-2",
                                      eb_item=b"item\x00", dirty=True)
    models.HrefMapper.create(content=mapped, href="")
    models.ItemEntity.create(id=9, collection=col, uid="zêta", eb_item=b"\x00\xff", new=True, deleted=True)
    expected = "2d8bb8c3c7abf201568e573a90b61bcc945b92736d55621a15cd0e080cb3ee7e"
    assert legacy_hash(col) == expected
    assert local_cache.dav_collection_state_hash(col) == expected


def test_initialization_preserves_legacy_tokens_and_hashes(dav_world):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    collection = world.collection()
    token, _ = collection.sync()
    models.DavSyncToken.update(state_hash=legacy_hash(col)).execute()
    before = list(models.DavSyncToken.select().tuples())
    local_cache._ensure_cache_tables(world.database)
    assert list(models.DavSyncToken.select().tuples()) == before
    assert collection.sync(token) == (token, [])
    assert list(models.DavSyncToken.select().tuples()) == before


def _new_items(count=2):
    return [SdkItem(f"remote-new-{index}", {"name": f"new-{index}", "dav_href": f"new-{index}.vcf"},
                    _vcard(f"new-{index}", "New").encode()) for index in range(count)]


def test_page_keeps_pre_page_token_and_both_readers_agree(dav_world):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    collection = world.collection()
    token, _ = collection.sync()
    world.remote.queue_item_page(*_new_items(3), stoken="after-page")
    world.service().pull_collection(col.uid)
    expected = [f"new-{index}.vcf" for index in range(3)]
    assert legacy_delta(col, token) == expected
    new_token, changed = collection.sync(token)
    assert changed == expected and new_token != token
    assert models.DavRevision.get(collection=col, revision=models.CollectionEntity.get_by_id(col.id).dav_revision).state_hash == legacy_hash(col)


@pytest.mark.parametrize("position", ["alone", "before", "after"])
@pytest.mark.parametrize("identical", [False, True], ids=["changed", "identical-resave"])
@pytest.mark.parametrize("follow_reanchor", [False, True])
def test_mapperless_tombstone_keeps_baseline_token_outcome(dav_world, position, identical, follow_reanchor):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    tombstone = SdkItem("unmapped", {"name": "unmapped"}, _vcard("unmapped", "Deleted").encode(), deleted=True)
    old = tombstone if identical else SdkItem("unmapped", {"name": "unmapped"}, b"older", deleted=True)
    models.ItemEntity.create(collection=col, uid="unmapped", remote_uid=old.uid,
                             eb_item=world.remote.store.save(old), deleted=True)
    intent = None
    if follow_reanchor:
        row = world.add_item(col, uid="local-intent")
        intent = world.remote.store.load(row.eb_item)
        models.ItemEntity.update(remote_uid=None, dirty=True).where(models.ItemEntity.id == row.id).execute()
    collection = world.collection()
    token, _ = collection.sync()
    page = [tombstone]
    if position == "before":
        page += _new_items(1)
    elif position == "after":
        page = _new_items(1) + page
    if intent is not None:
        page.append(intent)
    world.remote.queue_item_page(*page, stoken="tombstone-page")
    world.service().pull_collection(col.uid)
    if identical:
        expected = [] if position == "alone" else ["new-0.vcf"]
        assert legacy_delta(col, token) == expected
        assert collection.sync(token)[1] == expected
    else:
        with pytest.raises(ValueError, match="sync token"):
            legacy_delta(col, token)
        with pytest.raises(ValueError, match="sync token"):
            collection.sync(token)
        assert models.DavSyncToken.select().count() == 0


@pytest.mark.parametrize("visible", [False, True])
@pytest.mark.parametrize("stale", [False, True])
def test_page_reanchors_only_proven_local_intent(dav_world, visible, stale):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    models.ItemEntity.update(remote_uid=None, dirty=True).where(models.ItemEntity.id == row.id).execute()
    collection = world.collection()
    token, _ = collection.sync()
    if stale:
        models.ItemEntity.update(new=True).where(models.ItemEntity.id == row.id).execute()
    incoming = world.remote.store.load(row.eb_item)
    page = [incoming] + (_new_items(1) if visible else [])
    world.remote.queue_item_page(*page, stoken="intent-page")
    world.service().pull_collection(col.uid)
    if stale:
        with pytest.raises(ValueError, match="sync token"):
            legacy_delta(col, token)
        with pytest.raises(ValueError, match="sync token"):
            collection.sync(token)
    else:
        expected = ["new-0.vcf"] if visible else []
        assert legacy_delta(col, token) == expected
        assert collection.sync(token)[1] == expected
    assert models.ItemEntity.get_by_id(row.id).dirty


def _stored_state():
    return [list(model.select().order_by(model._meta.primary_key).tuples()) for model in (
        models.CollectionEntity, models.ItemEntity, models.HrefMapper,
        models.DavRevision, models.DavChange, models.DavSyncToken,
    )]


@pytest.mark.parametrize("failure", ["item", "final-hash", "missing-row", "wrong-revision", "wrong-marker", "zero-update"])
def test_page_failure_rolls_back_every_proof_and_page_token(dav_world, monkeypatch, failure):
    world = dav_world
    col = world.add_collection()
    world.add_item(col)
    world.collection().sync()
    before = _stored_state()
    record = local_cache.record_dav_change
    state_hash = local_cache.dav_collection_state_hash
    execute = world.database.execute_sql
    hashes = 0

    def record_change(cache_col, href, **kwargs):
        result = record(cache_col, href, **kwargs)
        if href == "new-1.vcf":
            if failure == "item":
                raise RuntimeError("batch item failure")
            if failure == "missing-row":
                models.DavRevision.delete().where(models.DavRevision.revision == result).execute()
            elif failure == "wrong-revision":
                models.CollectionEntity.update(dav_revision=result + 1).where(models.CollectionEntity.id == col.id).execute()
            elif failure == "wrong-marker":
                models.DavRevision.update(state_hash="different").where(models.DavRevision.revision == result).execute()
        return result

    def hash_state(*args, **kwargs):
        nonlocal hashes
        hashes += 1
        if failure == "final-hash" and hashes == 2:
            raise RuntimeError("batch final hash failure")
        return state_hash(*args, **kwargs)

    def execute_sql(sql, *args, **kwargs):
        if failure == "zero-update" and sql.lower().startswith('update "davrevision" set "state_hash"'):
            return SimpleNamespace(rowcount=0)
        return execute(sql, *args, **kwargs)

    monkeypatch.setattr(local_cache, "record_dav_change", record_change)
    monkeypatch.setattr(local_cache, "dav_collection_state_hash", hash_state)
    monkeypatch.setattr(world.database, "execute_sql", execute_sql)
    world.remote.queue_item_page(*_new_items(), stoken="must-roll-back")
    with pytest.raises(RuntimeError, match="batch"):
        world.service().pull_collection(col.uid)
    assert _stored_state() == before


def test_conflict_original_and_copy_share_two_hash_passes(dav_world, monkeypatch):
    world = dav_world
    col = world.add_collection()
    row = world.add_item(col)
    local = world.remote.store.load(row.eb_item)
    local.content = _vcard(row.uid, "Local edit").encode()
    models.ItemEntity.update(eb_item=world.remote.store.save(local), dirty=True).where(models.ItemEntity.id == row.id).execute()
    row = models.ItemEntity.get_by_id(row.id)
    remote = world.remote.store.load(row.eb_item)
    remote.content = _vcard(row.uid, "Remote edit").encode()
    collection = world.collection()
    token, _ = collection.sync()
    with hash_work(world.database, monkeypatch) as counts:
        result = world.service()._resolve_push_conflict(
            col, world.remote.store.load(col.eb_col), world.remote.item_mgr, row,
            (row.id, row.eb_item, row.dirty, row.new), local, remote,
        )
    assert result == 1
    assert counts["passes"] == 2 and counts["queries"] == 4, counts
    assert models.ItemEntity.select().count() == 2
    expected = sorted(mapper.href for mapper in models.HrefMapper.select())
    assert legacy_delta(col, token) == expected
    assert collection.sync(token)[1] == expected


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


def test_cache_creation_sets_explicit_five_second_timeout(dav_world, monkeypatch, tmp_path):
    import playhouse.sqlite_ext

    original = playhouse.sqlite_ext.SqliteExtDatabase.__init__
    observed = []

    def create(database, *args, **kwargs):
        observed.append(kwargs.get("timeout"))
        original(database, *args, **kwargs)

    monkeypatch.setattr(playhouse.sqlite_ext.SqliteExtDatabase, "__init__", create)
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
        assert "dav_href" in columns, columns
        assert "dav_state_generation" not in columns, columns
        assert "dav_uid" not in {column.name for column in upgraded.get_columns("itementity")}
        upgraded.execute_sql("UPDATE collectionentity SET dav_href='chosen' WHERE id=1")
        # The prior release writes only columns that existed in its schema.
        upgraded.execute_sql("UPDATE collectionentity SET dirty=1 WHERE id=1")
        upgraded.close()
        service._init_db(str(path))
        assert models.CollectionEntity.get_by_id(1).dav_href == "chosen"
        assert local_cache.dav_collection_state_hash(models.CollectionEntity.get_by_id(1)) == legacy_hash(models.CollectionEntity.get_by_id(1))
    finally:
        if upgraded is not None and not upgraded.is_closed():
            upgraded.close()
        local_cache.db.database_proxy.initialize(dav_world.database)
