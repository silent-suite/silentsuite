"""Historical tombstones for never-held items must not block a full sync.

Real code under test: file-backed SQLite under ``tmp_path``, ``Etebase.sync``,
``list``, ``sync_collection``, ``push_collection``, ``pull_collection``, the
unresolved-item retry and the full-cycle unresolved gate.

Stubbed seams, and nothing else:
- the account's collection and item managers (``mock_col_mgr`` and
  ``mock_item_mgr`` from ``conftest``; their ``cache_save`` / ``cache_load``
  round-trip synthetic SDK objects through fake cache bytes);
- ``Etebase.sync_collection_list`` (the collection row is seeded directly).

Only ``DavUnresolvedItemsError`` is translated into a sync outcome; any other
exception propagates. Tests named ``test_char_*`` characterize behaviour that
is unchanged by the fix and pass before and after it. All literals are
synthetic.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge.local_cache import (
    DAV_UNRESOLVED_RETRY_LIMIT,
    DavUnresolvedItemsError,
    Etebase,
    dav_collection_state_hash,
    db,
    models,
    record_dav_change,
)

COL_UID = "collection-under-test"

COLLECTION_TYPES = pytest.mark.parametrize(
    "col_type, suffix",
    [
        ("etebase.vcard", ".vcf"),
        ("etebase.vevent", ".ics"),
        ("etebase.vtodo", ".ics"),
    ],
)


@pytest.fixture()
def cache_db(tmp_path):
    database = SqliteExtDatabase(
        str(tmp_path / "tombstone-bootstrap.sqlite"),
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
    models.SchemaMigration.create(name="dav-revision-v1", applied_at=0)
    yield database
    database.close()


@pytest.fixture()
def make_world(cache_db, mock_col_mgr, mock_item_mgr):
    def make(col_type):
        user = models.User.create(username="tombstone@example.test")
        remote_col = MagicMock(
            uid=COL_UID,
            collection_type=col_type,
            deleted=False,
            stoken="collection-stoken",
        )
        cache_col = models.CollectionEntity.create(
            local_user=user,
            uid=COL_UID,
            eb_col=mock_col_mgr.cache_save(remote_col),
        )
        account = MagicMock()
        account.get_collection_manager.return_value = mock_col_mgr
        service = Etebase.__new__(Etebase)
        service.etebase = account
        service.user = user
        service.sync_collection_list = MagicMock()
        return SimpleNamespace(
            service=service, cache_col=cache_col, item_mgr=mock_item_mgr
        )

    return make


# ---------------------------------------------------------------------------
# Synthetic fixture helpers
# ---------------------------------------------------------------------------

def _remote(uid, *, name=None, deleted=False, meta=None):
    """A synthetic SDK item; ``meta`` overrides the default name metadata."""
    item = MagicMock(
        uid=uid,
        deleted=deleted,
        etag="etag-" + uid,
        content=b"synthetic-content",
    )
    if meta is None:
        meta = {"name": name or uid, "mtime": 1700000000000}
    item.meta = meta
    return item


def _page(stoken, *items, done=True):
    return MagicMock(data=list(items), done=done, stoken=stoken)


def _serve(world, *pages):
    """Serve pages in order; record the persisted stoken seen by each list."""
    seen = []
    queue = list(pages)

    def list_page(_fetch_options):
        seen.append(
            models.CollectionEntity.get_by_id(world.cache_col.id).local_stoken
        )
        return queue.pop(0)

    world.item_mgr.list.side_effect = list_page
    return seen


def _sync_outcome(world):
    try:
        world.service.sync()
    except DavUnresolvedItemsError:
        return "unresolved"
    return "success"


def _seed_row(
    world, uid, remote_uid, *, href=None, envelope_uid=None,
    dirty=False, new=False,
):
    """A cached item; with ``href`` it is mapped and its change ledgered."""
    previous = dav_collection_state_hash(world.cache_col)
    row = models.ItemEntity.create(
        collection=world.cache_col,
        uid=uid,
        remote_uid=remote_uid,
        eb_item=world.item_mgr.cache_save(
            _remote(envelope_uid or remote_uid or uid, name=uid)
        ),
        dirty=dirty,
        new=new,
    )
    if href is not None:
        models.HrefMapper.create(content=row, href=href)
        record_dav_change(
            world.cache_col, href, previous_state_hash=previous, etag="etag-" + uid
        )
    return row


def _seed_token(world):
    current = models.CollectionEntity.get_by_id(world.cache_col.id)
    models.DavSyncToken.create(
        collection=current,
        token="token-retained",
        revision=current.dav_revision,
        created_at=0,
        state_hash=dav_collection_state_hash(current),
    )


def _seed_quarantine(
    world, remote_uid, envelope, *, attempts=0,
    reason="remote_unresolved", local_item=None,
):
    return models.DavUnresolvedItem.create(
        collection=world.cache_col,
        remote_uid=remote_uid,
        eb_item=world.item_mgr.cache_save(envelope),
        deleted=envelope.deleted,
        attempts=attempts,
        reason=reason,
        local_item=local_item,
    )


def _row(model, pk):
    return list(model.select().where(model.id == pk).tuples())


def _quarantined(world):
    return [
        q.remote_uid
        for q in models.DavUnresolvedItem.select()
        .where(models.DavUnresolvedItem.collection == world.cache_col)
        .order_by(models.DavUnresolvedItem.remote_uid)
    ]


def _snapshot(world):
    """Every persisted item, mapper, ledger and token row of the collection."""
    col = models.CollectionEntity.get_by_id(world.cache_col.id)
    per_collection = [
        list(
            model.select()
            .where(model.collection == col)
            .order_by(model.id)
            .tuples()
        )
        for model in (
            models.ItemEntity,
            models.DavChange,
            models.DavRevision,
            models.DavSyncToken,
        )
    ]
    mappers = list(
        models.HrefMapper.select()
        .join(models.ItemEntity)
        .where(models.ItemEntity.collection == col)
        .order_by(models.HrefMapper.content)
        .tuples()
    )
    return (
        (col.eb_col, col.new, col.dirty, col.deleted, col.dav_revision),
        per_collection,
        mappers,
    )


def _local_stoken(world):
    return models.CollectionEntity.get_by_id(world.cache_col.id).local_stoken


# ---------------------------------------------------------------------------
# Ordinary pull settlement (RED until settlement exists)
# ---------------------------------------------------------------------------

@COLLECTION_TYPES
def test_fresh_cache_live_and_historical_tombstone_syncs(make_world, col_type, suffix):
    """A1: a never-held tombstone beside a live item does not block sync."""
    world = make_world(col_type)
    _serve(
        world,
        _page(
            "s1",
            _remote("remote-live", name="live-name"),
            _remote("remote-gone", name="gone-name", deleted=True),
        ),
    )

    outcome = _sync_outcome(world)

    live = models.ItemEntity.get(models.ItemEntity.remote_uid == "remote-live")
    assert live.deleted is False
    assert models.HrefMapper.get(models.HrefMapper.content == live).href.endswith(
        suffix
    )
    assert _local_stoken(world) == "s1"
    assert _quarantined(world) == [], "historical tombstone was quarantined"
    assert outcome == "success"


@COLLECTION_TYPES
def test_fresh_cache_tombstone_only_without_metadata_syncs(
    make_world, col_type, suffix
):
    """A2: a tombstone-only page with empty metadata settles."""
    world = make_world(col_type)
    _serve(world, _page("s1", _remote("remote-gone", deleted=True, meta={})))

    outcome = _sync_outcome(world)

    assert models.ItemEntity.select().count() == 0
    assert models.DavChange.select().count() == 0
    assert _local_stoken(world) == "s1"
    assert _quarantined(world) == [], "historical tombstone was quarantined"
    assert outcome == "success"


@COLLECTION_TYPES
@pytest.mark.parametrize("order", ["tombstone_first", "live_first"])
@pytest.mark.parametrize("split", [False, True], ids=["one_page", "two_pages"])
def test_same_name_delete_recreate_settles_old_tombstone(
    make_world, col_type, suffix, order, split
):
    """A4 (tombstone first), A5(a) (live first), A6 (both split over pages)."""
    world = make_world(col_type)
    tombstone = _remote("remote-a", name="n-name", deleted=True)
    live = _remote("remote-b", name="n-name")
    items = [tombstone, live] if order == "tombstone_first" else [live, tombstone]
    if split:
        seen = _serve(
            world,
            _page("s1", items[0], done=False),
            _page("s2", items[1]),
        )
    else:
        seen = _serve(world, _page("s2", *items))

    outcome = _sync_outcome(world)

    row = models.ItemEntity.get(
        (models.ItemEntity.collection == world.cache_col)
        & (models.ItemEntity.uid == "n-name")
    )
    assert row.remote_uid == "remote-b"
    assert row.deleted is False
    assert models.ItemEntity.select().count() == 1
    assert seen == ([None, "s1"] if split else [None])
    assert _local_stoken(world) == "s2"
    assert _quarantined(world) == [], "superseded tombstone was quarantined"
    assert outcome == "success"


@COLLECTION_TYPES
def test_later_old_tombstone_leaves_recreated_item_and_ledger_untouched(
    make_world, col_type, suffix
):
    """A5(b): B applied, ledger and token retained; tombstone A arrives later."""
    world = make_world(col_type)
    _serve(world, _page("s1", _remote("remote-b", name="n-name")))
    assert _sync_outcome(world) == "success"
    _seed_token(world)
    before = _snapshot(world)
    _serve(world, _page("s2", _remote("remote-a", name="n-name", deleted=True)))

    outcome = _sync_outcome(world)

    assert _snapshot(world) == before
    assert _local_stoken(world) == "s2"
    assert _quarantined(world) == [], "superseded tombstone was quarantined"
    assert outcome == "success"


@COLLECTION_TYPES
@pytest.mark.parametrize("intent", ["dirty", "new"])
def test_tombstone_does_not_touch_same_name_row_bound_to_other_uid(
    make_world, col_type, suffix, intent
):
    """A24: bound different-UID local intent is preserved; pull alone."""
    world = make_world(col_type)
    _seed_row(
        world, "n-name", "remote-b", href="n-name" + suffix,
        dirty=intent == "dirty", new=intent == "new",
    )
    _seed_token(world)
    before = _snapshot(world)
    _serve(world, _page("s1", _remote("remote-a", name="n-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    assert _snapshot(world) == before
    assert _quarantined(world) == [], "unrelated tombstone was quarantined"


@COLLECTION_TYPES
def test_existing_below_cap_tombstone_quarantine_recovers(
    make_world, col_type, suffix
):
    """A12: a persisted unattached tombstone quarantine is removed in place."""
    world = make_world(col_type)
    _seed_row(world, "kept-name", "remote-kept", href="kept-name" + suffix)
    _seed_token(world)
    _seed_quarantine(
        world,
        "remote-gone",
        _remote("remote-gone", name="gone-name", deleted=True),
        attempts=3,
    )
    before = _snapshot(world)
    _serve(world, _page("s1"))

    outcome = _sync_outcome(world)

    assert _snapshot(world) == before
    assert _quarantined(world) == [], "historical tombstone quarantine retained"
    assert outcome == "success"


def _protected_neighbour(world, kind):
    """A capped quarantine with no local intent, for another UID."""
    if kind is None:
        return None, None
    envelope = _remote("remote-adjacent", name="adjacent-name")
    if kind == "capped_live":
        quarantine = _seed_quarantine(
            world, "remote-adjacent", envelope, attempts=DAV_UNRESOLVED_RETRY_LIMIT
        )
        return quarantine, None
    if kind == "capped_legacy_duplicate":
        quarantine = _seed_quarantine(
            world, "remote-adjacent", envelope,
            attempts=DAV_UNRESOLVED_RETRY_LIMIT, reason="legacy_duplicate",
        )
        return quarantine, None
    attached = _seed_row(world, "attached-name", "remote-attached-local")
    quarantine = _seed_quarantine(
        world, "remote-adjacent", envelope,
        attempts=DAV_UNRESOLVED_RETRY_LIMIT, local_item=attached,
    )
    return quarantine, attached


@COLLECTION_TYPES
@pytest.mark.parametrize(
    "neighbour",
    [None, "capped_live", "capped_legacy_duplicate", "capped_attached_no_intent"],
)
def test_tombstone_supersedes_live_quarantine_for_same_uid(
    make_world, col_type, suffix, neighbour
):
    """A25: tombstone A removes A's live quarantine; neighbours byte-identical."""
    world = make_world(col_type)
    bound = _seed_row(world, "n-name", "remote-b", href="n-name" + suffix)
    _seed_quarantine(world, "remote-a", _remote("remote-a", name="n-name"))
    adjacent, attached = _protected_neighbour(world, neighbour)
    bound_before = _row(models.ItemEntity, bound.id)
    adjacent_before = adjacent and _row(models.DavUnresolvedItem, adjacent.id)
    attached_before = attached and _row(models.ItemEntity, attached.id)
    _serve(world, _page("s1", _remote("remote-a", name="n-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    assert _row(models.ItemEntity, bound.id) == bound_before
    if adjacent is not None:
        assert _row(models.DavUnresolvedItem, adjacent.id) == adjacent_before
    if attached is not None:
        assert _row(models.ItemEntity, attached.id) == attached_before
    assert "remote-a" not in _quarantined(world), "superseded quarantine retained"


# ---------------------------------------------------------------------------
# Unchanged boundaries (characterization: pass before and after the fix)
# ---------------------------------------------------------------------------

@COLLECTION_TYPES
@pytest.mark.parametrize("own_row", ["capped_attached_no_intent", "legacy_duplicate"])
def test_char_protected_own_quarantine_is_retained_on_tombstone(
    make_world, col_type, suffix, own_row
):
    """A25 own-row variant: reason and attachment of A's row are unchanged."""
    world = make_world(col_type)
    _seed_row(world, "n-name", "remote-b", href="n-name" + suffix)
    attached = (
        _seed_row(world, "attached-name", "remote-attached-local")
        if own_row == "capped_attached_no_intent"
        else None
    )
    own = _seed_quarantine(
        world, "remote-a", _remote("remote-a", name="n-name"),
        attempts=DAV_UNRESOLVED_RETRY_LIMIT,
        reason="legacy_duplicate" if attached is None else "remote_unresolved",
        local_item=attached,
    )
    _serve(world, _page("s1", _remote("remote-a", name="n-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    retained = models.DavUnresolvedItem.get_by_id(own.id)
    assert retained.reason == own.reason
    assert retained.local_item_id == own.local_item_id


@COLLECTION_TYPES
def test_char_live_same_name_collision_stays_unresolved(make_world, col_type, suffix):
    """A7: a live different-UID item colliding on name is quarantined."""
    world = make_world(col_type)
    bound = _seed_row(world, "n-name", "remote-b", href="n-name" + suffix)
    before = _row(models.ItemEntity, bound.id)
    _serve(world, _page("s1", _remote("remote-c", name="n-name")))

    assert _sync_outcome(world) == "unresolved"
    assert _quarantined(world) == ["remote-c"]
    assert _row(models.ItemEntity, bound.id) == before


@COLLECTION_TYPES
@pytest.mark.parametrize(
    "meta", [{"name": "gone-name"}, {}], ids=["metadata", "no_metadata"]
)
def test_char_unrelated_identityless_row_keeps_tombstone_ambiguous(
    make_world, col_type, suffix, meta
):
    """A8: any NULL remote_uid row leaves a never-held tombstone unresolved."""
    world = make_world(col_type)
    legacy = _seed_row(world, "legacy-other", None, href="legacy-other" + suffix)
    before = _row(models.ItemEntity, legacy.id)
    _serve(world, _page("s1", _remote("remote-gone", deleted=True, meta=meta)))

    assert _sync_outcome(world) == "unresolved"
    assert _quarantined(world) == ["remote-gone"]
    assert _row(models.ItemEntity, legacy.id) == before


@COLLECTION_TYPES
def test_char_metadata_fallback_claims_matching_legacy_row(
    make_world, col_type, suffix
):
    """A9: the legacy row named like the tombstone is bound and deleted."""
    world = make_world(col_type)
    href = "legacy-name" + suffix
    legacy = _seed_row(world, "legacy-name", None, href=href)
    _serve(
        world, _page("s1", _remote("remote-legacy", name="legacy-name", deleted=True))
    )

    assert _sync_outcome(world) == "success"
    claimed = models.ItemEntity.get_by_id(legacy.id)
    assert claimed.remote_uid == "remote-legacy"
    assert claimed.deleted is True
    assert models.HrefMapper.get(models.HrefMapper.content == claimed).href == href
    change = models.DavChange.get(models.DavChange.href == href)
    assert change.deleted is True
    assert _quarantined(world) == []


@COLLECTION_TYPES
def test_char_matching_dirty_intent_is_preserved(make_world, col_type, suffix):
    """A10: a dirty row bound to the tombstone UID keeps its content."""
    world = make_world(col_type)
    row = _seed_row(
        world, "n-name", "remote-a", href="n-name" + suffix, dirty=True
    )
    before = _snapshot(world)
    _serve(world, _page("s1", _remote("remote-a", name="n-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    assert _snapshot(world) == before
    assert models.ItemEntity.get_by_id(row.id).dirty is True
    assert _quarantined(world) == []


@COLLECTION_TYPES
def test_char_matching_unbound_new_intent_is_bound_and_preserved(
    make_world, col_type, suffix
):
    """A10: an unbound new row named like the tombstone is bound, not deleted."""
    world = make_world(col_type)
    row = _seed_row(world, "n-name", None, new=True)
    _serve(world, _page("s1", _remote("remote-a", name="n-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    preserved = models.ItemEntity.get_by_id(row.id)
    assert preserved.remote_uid == "remote-a"
    assert preserved.eb_item == row.eb_item
    assert preserved.new is True
    assert preserved.deleted is False
    assert _quarantined(world) == []


@COLLECTION_TYPES
def test_char_tombstone_uid_recorded_as_local_name_stays_unresolved(
    make_world, col_type, suffix
):
    """A11: a row whose local name is the tombstone UID keeps it quarantined."""
    world = make_world(col_type)
    row = _seed_row(world, "remote-gone", "remote-other", href="other" + suffix)
    before = _row(models.ItemEntity, row.id)
    _serve(
        world, _page("s1", _remote("remote-gone", name="elsewhere", deleted=True))
    )

    assert _sync_outcome(world) == "unresolved"
    assert _quarantined(world) == ["remote-gone"]
    assert _row(models.ItemEntity, row.id) == before


@COLLECTION_TYPES
def test_char_known_deletion_keeps_row_mapper_and_publishes_ledger(
    make_world, col_type, suffix
):
    """A19: a matched tombstone marks the same row deleted on its old href."""
    world = make_world(col_type)
    href = "x" + suffix
    row = _seed_row(world, "x-name", "remote-x", href=href)
    _serve(world, _page("s1", _remote("remote-x", name="x-name", deleted=True)))

    assert _sync_outcome(world) == "success"
    deleted = models.ItemEntity.get_by_id(row.id)
    assert deleted.remote_uid == "remote-x"
    assert deleted.deleted is True
    assert models.HrefMapper.get(models.HrefMapper.content == deleted).href == href
    assert models.DavChange.get(models.DavChange.href == href).deleted is True
    assert (
        models.DavRevision.select()
        .where(
            (models.DavRevision.href == href)
            & (models.DavRevision.deleted == True)  # noqa: E712
        )
        .count()
        == 1
    )
    assert _quarantined(world) == []


@COLLECTION_TYPES
@pytest.mark.parametrize("intent", ["dirty", "new"])
@pytest.mark.parametrize("reason", ["remote_unresolved", "legacy_duplicate"])
def test_char_capped_quarantine_with_attached_intent_still_retries(
    make_world, col_type, suffix, intent, reason
):
    """A23: attached dirty/new intent bypasses the cap and resolves."""
    world = make_world(col_type)
    local = _seed_row(
        world, "local-name", None, envelope_uid="remote-local-intent",
        dirty=intent == "dirty", new=intent == "new",
    )
    _seed_quarantine(
        world, "remote-attached", _remote("remote-attached", name="local-name"),
        attempts=DAV_UNRESOLVED_RETRY_LIMIT, reason=reason, local_item=local,
    )
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    world.item_mgr.cache_load.assert_any_call(local.eb_item)
    resolved = models.ItemEntity.get_by_id(local.id)
    assert resolved.remote_uid == "remote-local-intent"
    assert resolved.eb_item == local.eb_item
    assert (resolved.dirty, resolved.new) == (local.dirty, local.new)
    assert resolved.deleted is False
    assert _quarantined(world) == []


@COLLECTION_TYPES
def test_char_inconsistent_envelope_applies_through_matched_path(
    make_world, col_type, suffix
):
    """A26(a): A's row holding B's tombstone envelope applies B and clears A."""
    world = make_world(col_type)
    href = "b-name" + suffix
    bound = _seed_row(world, "b-name", "remote-b", href=href)
    _seed_quarantine(
        world, "remote-a", _remote("remote-b", name="b-name", deleted=True)
    )
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert models.ItemEntity.get_by_id(bound.id).deleted is True
    assert models.DavChange.get(models.DavChange.href == href).deleted is True
    assert _quarantined(world) == []


@COLLECTION_TYPES
def test_char_inconsistent_envelope_without_target_is_not_settled(
    make_world, col_type, suffix
):
    """A26(b): with no B row, A's row holding B's envelope only counts a retry."""
    world = make_world(col_type)
    quarantine = _seed_quarantine(
        world, "remote-a", _remote("remote-b", name="b-name", deleted=True)
    )
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert _quarantined(world) == ["remote-a"]
    assert models.DavUnresolvedItem.get_by_id(quarantine.id).attempts == 1


# ---------------------------------------------------------------------------
# Exhausted quarantines (RED until capped settlement exists)
# ---------------------------------------------------------------------------

@COLLECTION_TYPES
@pytest.mark.parametrize("over_limit", [0, 5], ids=["at_limit", "limit_plus_5"])
def test_capped_tombstone_quarantine_recovers(
    make_world, col_type, suffix, over_limit
):
    """A13: an exhausted unattached tombstone quarantine is removed in place."""
    world = make_world(col_type)
    _seed_row(world, "kept-name", "remote-kept", href="kept-name" + suffix)
    _seed_token(world)
    _seed_quarantine(
        world,
        "remote-gone",
        _remote("remote-gone", name="gone-name", deleted=True),
        attempts=DAV_UNRESOLVED_RETRY_LIMIT + over_limit,
    )
    before = _snapshot(world)
    _serve(world, _page("s1"))

    outcome = _sync_outcome(world)

    assert _snapshot(world) == before
    assert _quarantined(world) == [], "exhausted tombstone quarantine retained"
    assert outcome == "success"


@COLLECTION_TYPES
def test_capped_tombstone_quarantine_settles_once_identityless_row_is_bound(
    make_world, col_type, suffix
):
    """A14: retained while a NULL row exists; removed after it is bound."""
    world = make_world(col_type)
    legacy = _seed_row(world, "legacy-other", None, href="legacy-other" + suffix)
    quarantine = _seed_quarantine(
        world,
        "remote-gone",
        _remote("remote-gone", name="gone-name", deleted=True),
        attempts=DAV_UNRESOLVED_RETRY_LIMIT,
    )
    quarantine_before = _row(models.DavUnresolvedItem, quarantine.id)
    _serve(world, _page("s1"), _page("s2"))

    assert _sync_outcome(world) == "unresolved"
    assert _row(models.DavUnresolvedItem, quarantine.id) == quarantine_before

    models.ItemEntity.update(remote_uid="remote-legacy-bound").where(
        models.ItemEntity.id == legacy.id
    ).execute()
    outcome = _sync_outcome(world)

    assert _local_stoken(world) == "s2"
    assert _quarantined(world) == [], "exhausted tombstone quarantine retained"
    assert outcome == "success"
