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

import logging
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

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
from silentsuite_bridge import local_cache
from silentsuite_bridge.radicale import storage

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


class _Envelope:
    """Synthetic SDK item; records whether metadata was read in a transaction."""

    def __init__(
        self, *, uid="remote-gone", deleted=True, meta=None, fail=None, on_meta=None
    ):
        self._uid = uid
        self._deleted = deleted
        self._meta = {"name": "gone-name"} if meta is None else meta
        self._fail = fail
        self._on_meta = on_meta
        self.meta_reads_in_transaction = []

    def _read(self, name, value):
        if self._fail == name:
            raise ValueError("synthetic envelope failure")
        return value

    @property
    def meta(self):
        self.meta_reads_in_transaction.append(
            db.database_proxy.obj.in_transaction()
        )
        value = self._read("meta", self._meta)
        if self._on_meta is not None:
            # One-shot concurrent writer while the SDK parse is in progress.
            callback, self._on_meta = self._on_meta, None
            callback()
        return value

    @property
    def uid(self):
        return self._read("uid", self._uid)

    @property
    def deleted(self):
        return self._read("deleted", self._deleted)

    @property
    def etag(self):
        return "etag-" + self._uid


def _seed_capped(world, envelope, **fields):
    row = models.DavUnresolvedItem.create(
        collection=world.cache_col,
        remote_uid="remote-gone",
        eb_item=world.item_mgr.cache_save(envelope),
        deleted=True,
        attempts=DAV_UNRESOLVED_RETRY_LIMIT,
        **fields,
    )
    world.item_mgr.cache_save.reset_mock()
    return row


@COLLECTION_TYPES
@pytest.mark.parametrize(
    "kind", ["capped_live", "capped_legacy_duplicate", "capped_attached_no_intent"]
)
def test_capped_protected_quarantine_is_not_parsed(
    make_world, col_type, suffix, kind
):
    """A15: protected exhausted rows stay byte-identical and are not loaded."""
    world = make_world(col_type)
    if kind == "capped_live":
        row = _seed_quarantine(
            world, "remote-gone", _remote("remote-gone"),
            attempts=DAV_UNRESOLVED_RETRY_LIMIT,
        )
    elif kind == "capped_legacy_duplicate":
        row = _seed_capped(
            world, _Envelope(), reason="legacy_duplicate"
        )
    else:
        attached = _seed_row(world, "attached-name", "remote-attached-local")
        row = _seed_capped(world, _Envelope(), local_item=attached)
    before = _row(models.DavUnresolvedItem, row.id)
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert _row(models.DavUnresolvedItem, row.id) == before
    world.item_mgr.cache_load.assert_not_called()


@COLLECTION_TYPES
@pytest.mark.parametrize(
    "probe",
    [
        "cache_load_raises",
        {"fail": "meta"},
        {"fail": "uid"},
        {"fail": "deleted"},
        {"meta": "gone-name"},
        {"meta": []},
        {"meta": [("name", "gone-name")]},
        {"uid": "remote-other"},
        {"deleted": False},
    ],
    ids=[
        "cache_load_raises", "meta_raises", "uid_raises", "deleted_raises",
        "meta_string", "meta_empty_list", "meta_pair_list",
        "wrong_uid", "live_envelope",
    ],
)
def test_capped_unusable_envelope_is_left_byte_identical(
    make_world, caplog, col_type, suffix, probe
):
    """A16: no settlement, write, warning or apply across three cycles."""
    caplog.set_level(logging.WARNING)
    world = make_world(col_type)
    envelope = _Envelope(**({} if probe == "cache_load_raises" else probe))
    row = _seed_capped(world, envelope)
    if probe == "cache_load_raises":
        world.item_mgr.cache_load.side_effect = ValueError("synthetic load failure")
    before = _row(models.DavUnresolvedItem, row.id)
    _serve(world, _page("s1"), _page("s2"), _page("s3"))

    for _cycle in range(3):
        world.service.pull_collection(COL_UID)
        assert _row(models.DavUnresolvedItem, row.id) == before

    assert world.item_mgr.cache_load.call_count == 3
    assert world.item_mgr.list.call_count == 3
    world.item_mgr.cache_save.assert_not_called()
    world.item_mgr.create.assert_not_called()
    world.item_mgr.batch.assert_not_called()
    world.item_mgr.upload.assert_not_called()
    assert models.ItemEntity.select().count() == 0
    assert models.DavChange.select().count() == 0
    assert not any(record.levelno >= logging.WARNING for record in caplog.records)
    assert True not in envelope.meta_reads_in_transaction


@COLLECTION_TYPES
def test_capped_settlement_reads_metadata_outside_writer(
    make_world, col_type, suffix
):
    """A16 boundary: the authenticating metadata read precedes the writer."""
    world = make_world(col_type)
    envelope = _Envelope()
    _seed_capped(world, envelope)
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert envelope.meta_reads_in_transaction == [False]
    assert _quarantined(world) == []
    world.item_mgr.cache_save.assert_not_called()


@COLLECTION_TYPES
def test_settlement_leaves_retained_dav_history_and_state_hash(
    make_world, col_type, suffix
):
    """A3: settling an unrelated tombstone changes no DAV-relevant state."""
    world = make_world(col_type)
    _seed_row(world, "kept-name", "remote-kept", href="kept-name" + suffix)
    _seed_token(world)
    world.item_mgr.cache_save.reset_mock()
    before = _snapshot(world)
    state_hash = dav_collection_state_hash(world.cache_col)
    assert before[0][4] > 0
    _serve(world, _page("s1", _remote("remote-gone", name="gone-name", deleted=True)))

    world.service.pull_collection(COL_UID)

    assert _snapshot(world) == before
    assert dav_collection_state_hash(world.cache_col) == state_hash
    world.item_mgr.cache_save.assert_not_called()
    assert _local_stoken(world) == "s1"
    assert _quarantined(world) == []


def _seed_parse_race(world, capped, mutate):
    """An eligible tombstone quarantine whose metadata read runs ``mutate``."""
    observed = {}

    def concurrent_writer():
        mutate(row)
        observed["row"] = _row(models.DavUnresolvedItem, row.id)
        observed["snapshot"] = _snapshot(world)
        observed["saves"] = world.item_mgr.cache_save.call_count

    row = _seed_capped(world, _Envelope(on_meta=concurrent_writer))
    if not capped:
        row.attempts = 3
        row.save(only=[models.DavUnresolvedItem.attempts])
    return row, observed


def _field_update(**values):
    def mutate(row):
        models.DavUnresolvedItem.update(**values).where(
            models.DavUnresolvedItem.id == row.id
        ).execute()

    return mutate


@COLLECTION_TYPES
@pytest.mark.parametrize("capped", [False, True], ids=["below_cap", "at_cap"])
@pytest.mark.parametrize(
    "field",
    ["remote_uid", "eb_item", "deleted", "attempts", "reason", "local_item_id"],
)
def test_snapshot_change_during_parse_is_not_overwritten(
    make_world, col_type, suffix, capped, field
):
    """A17: a quarantine refreshed during the parse is left as refreshed."""
    world = make_world(col_type)
    attached = _seed_row(world, "attached-name", "remote-attached-local")
    values = {
        "remote_uid": {"remote_uid": "remote-refreshed"},
        "eb_item": {"eb_item": b"refreshed-envelope"},
        "deleted": {"deleted": False},
        "attempts": {"attempts": models.DavUnresolvedItem.attempts + 1},
        "reason": {"reason": "legacy_duplicate"},
        "local_item_id": {"local_item": attached.id},
    }[field]
    row, observed = _seed_parse_race(world, capped, _field_update(**values))
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert observed["row"], "concurrent writer did not run"
    assert _row(models.DavUnresolvedItem, row.id) == observed["row"]
    assert _snapshot(world) == observed["snapshot"]


@COLLECTION_TYPES
@pytest.mark.parametrize("capped", [False, True], ids=["below_cap", "at_cap"])
def test_identityless_row_appearing_during_parse_blocks_settlement(
    make_world, col_type, suffix, capped
):
    """A17: a NULL-identity row inserted during the parse keeps the row."""
    world = make_world(col_type)

    def insert_identityless(_row_unused):
        models.ItemEntity.create(
            collection=world.cache_col,
            uid="legacy-appeared",
            remote_uid=None,
            eb_item=b"legacy-appeared-cache",
        )

    row, observed = _seed_parse_race(world, capped, insert_identityless)
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert _snapshot(world) == observed["snapshot"]
    assert _quarantined(world) == ["remote-gone"]
    current = models.DavUnresolvedItem.get_by_id(row.id)
    if capped:
        assert _row(models.DavUnresolvedItem, row.id) == observed["row"]
    else:
        # Ordinary unsuccessful retry bookkeeping.
        assert current.attempts == 4
        assert (current.eb_item, current.reason, current.local_item_id) == (
            row.eb_item, row.reason, None,
        )


@COLLECTION_TYPES
@pytest.mark.parametrize("capped", [False, True], ids=["below_cap", "at_cap"])
def test_target_appearing_during_parse(make_world, col_type, suffix, capped):
    """A18: below cap the real deletion applies; at cap nothing is applied."""
    world = make_world(col_type)
    href = "gone-name" + suffix
    target = {}

    def insert_target(_row_unused):
        target["row"] = _seed_row(world, "gone-name", "remote-gone", href=href)

    row, observed = _seed_parse_race(world, capped, insert_target)
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    deleted = models.ItemEntity.get_by_id(target["row"].id)
    retry_saves = world.item_mgr.cache_save.call_count - observed["saves"]
    if capped:
        assert _snapshot(world) == observed["snapshot"]
        assert _row(models.DavUnresolvedItem, row.id) == observed["row"]
        assert retry_saves == 0
        return
    assert deleted.remote_uid == "remote-gone"
    assert deleted.deleted is True
    assert models.HrefMapper.get(models.HrefMapper.content == deleted).href == href
    assert models.DavChange.get(models.DavChange.href == href).deleted is True
    assert retry_saves == 1
    assert _quarantined(world) == []


@COLLECTION_TYPES
@pytest.mark.parametrize("capped", [False, True], ids=["below_cap", "at_cap"])
def test_quarantine_vanishing_during_parse_is_not_recreated(
    make_world, col_type, suffix, capped
):
    """A17: a quarantine removed during the parse causes no write."""
    world = make_world(col_type)
    _seed_row(world, "kept-name", "remote-kept", href="kept-name" + suffix)
    _seed_token(world)

    def remove(row):
        models.DavUnresolvedItem.delete().where(
            models.DavUnresolvedItem.id == row.id
        ).execute()

    row, observed = _seed_parse_race(world, capped, remove)
    envelope = world.item_mgr.cache_load(row.eb_item)
    world.item_mgr.cache_load.reset_mock()
    _serve(world, _page("s1"))

    world.service.pull_collection(COL_UID)

    assert observed["row"] == [], "concurrent removal did not run"
    assert _row(models.DavUnresolvedItem, row.id) == []
    assert _quarantined(world) == []
    assert _snapshot(world) == observed["snapshot"]
    assert world.item_mgr.cache_save.call_count == observed["saves"]
    assert world.item_mgr.cache_load.call_count == 1
    assert envelope.meta_reads_in_transaction == [False]


# ---------------------------------------------------------------------------
# Publication through the real sync thread
# ---------------------------------------------------------------------------

_PRIVATE_MARKERS = (
    "remote-live", "live-name", "remote-gone", "gone-name", "legacy-other",
    "synthetic-content", "tombstone@example.test", COL_UID,
)


def _run_sync_thread(world, caplog):
    for name in (storage.logger.name, local_cache.logger.name):
        caplog.set_level(logging.DEBUG, logger=name)
    with patch.object(
        storage, "etesync_for_user",
        return_value=nullcontext((world.service, False)),
    ), patch.object(storage, "update_status") as update_status, patch.object(
        storage, "log_sync_event"
    ) as log_sync_event:
        thread = storage.SyncThread("tombstone@example.test", daemon=True)
        thread.interval = 3600
        generation = thread.force_sync()
        thread.start()
        try:
            assert thread.wait_for_generation(generation, timeout=5)
            status = thread.generation_status(generation)
        finally:
            thread.stop()
            thread.join(timeout=5)
        assert not thread.is_alive()
    diagnostics = [
        record.getMessage()
        for record in caplog.records
        if record.name in (storage.logger.name, local_cache.logger.name)
    ]
    diagnostics += [str(call.args) for call in log_sync_event.call_args_list]
    diagnostics += [
        str(call.kwargs.get("error")) for call in update_status.call_args_list
    ]
    for marker in _PRIVATE_MARKERS:
        assert not any(marker in text for text in diagnostics), marker
    return thread, status, update_status, diagnostics


@COLLECTION_TYPES
def test_sync_thread_publishes_success_after_settlement(
    make_world, caplog, col_type, suffix
):
    """A20 and A22: the real worker succeeds and logs no identifiers."""
    world = make_world(col_type)
    _serve(
        world,
        _page(
            "s1",
            _remote("remote-live", name="live-name"),
            _remote("remote-gone", name="gone-name", deleted=True),
        ),
    )

    thread, status, update_status, _ = _run_sync_thread(world, caplog)

    assert status["state"] == "succeeded"
    assert status["error_code"] is None
    assert status["completed_at"] is not None
    assert thread.last_sync is not None
    states = [call.args[0] for call in update_status.call_args_list]
    assert states == ["connected"]


@COLLECTION_TYPES
def test_char_sync_thread_reports_genuine_ambiguity(
    make_world, caplog, col_type, suffix
):
    """A21 and A22: genuine ambiguity fails with only the bounded class."""
    world = make_world(col_type)
    _seed_row(world, "legacy-other", None)
    _serve(
        world, _page("s1", _remote("remote-gone", name="gone-name", deleted=True))
    )

    thread, status, update_status, diagnostics = _run_sync_thread(world, caplog)

    assert status["state"] == "failed"
    assert status["error_code"] == "DavUnresolvedItemsError"
    assert thread.last_sync is None
    states = [call.args[0] for call in update_status.call_args_list]
    assert states == ["error"]
    assert update_status.call_args.kwargs["error"] == "DavUnresolvedItemsError"
    assert any("DavUnresolvedItemsError" in text for text in diagnostics)


@COLLECTION_TYPES
@pytest.mark.parametrize(
    "attempts", [3, DAV_UNRESOLVED_RETRY_LIMIT], ids=["below_cap", "exhausted"]
)
def test_sync_thread_recovers_persisted_tombstone_quarantine(
    make_world, caplog, col_type, suffix, attempts
):
    """A22 with A12/A13: persisted recovery succeeds without identifiers."""
    world = make_world(col_type)
    _seed_row(world, "kept-name", "remote-kept", href="kept-name" + suffix)
    row = _seed_quarantine(
        world,
        "remote-gone",
        _remote("remote-gone", name="gone-name", deleted=True),
        attempts=attempts,
    )
    _serve(world, _page("s1"))

    thread, status, update_status, _ = _run_sync_thread(world, caplog)

    assert status["state"] == "succeeded"
    assert thread.last_sync is not None
    assert _row(models.DavUnresolvedItem, row.id) == []
    assert _quarantined(world) == []
    states = [call.args[0] for call in update_status.call_args_list]
    assert states == ["connected"]
