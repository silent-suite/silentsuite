"""CardDAV sync-token and deletion convergence regressions."""

from unittest.mock import MagicMock

import pytest
import vobject

from silentsuite_bridge import config
from silentsuite_bridge.local_cache import record_dav_change
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    DavRevision,
    DavSyncToken,
    HrefMapper,
    ItemEntity,
)
from silentsuite_bridge.radicale import storage as storage_module
from silentsuite_bridge.radicale.storage import Collection


def _carddav_collection(mem_db, user):
    cache_col = CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"encrypted-collection",
    )
    cache_item = ItemEntity.create(
        collection=cache_col,
        uid="contact-1",
        eb_item=b"encrypted-item",
    )
    HrefMapper.create(content=cache_item, href="contact-1.vcf")

    item = MagicMock()
    item.cache_item = cache_item
    item.uid = "contact-1"
    item.etag = "etag-1"
    item.content = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\nFN:Contact One\r\nEND:VCARD"
    item.meta = {"mtime": 1700000000000}

    def delete_item():
        cache_item.deleted = True
        cache_item.save()

    item.delete.side_effect = delete_item

    cached_collection = MagicMock()
    cached_collection.cache_col = cache_col
    cached_collection.col_type = "etebase.vcard"
    cached_collection.stoken = "remote-stoken"
    cached_collection.list.return_value = [item]
    cached_collection.get.side_effect = (
        lambda uid: item if uid == "contact-1" and not cache_item.deleted else None
    )

    storage = MagicMock()
    storage.etesync.get.return_value = cached_collection
    return Collection(storage, "/test@example.com/contacts")


def test_initial_carddav_sync_returns_opaque_token_and_current_href(mem_db, user):
    collection = _carddav_collection(mem_db, user)

    token, hrefs = collection.sync(None)

    assert token.startswith("http://radicale.org/ns/sync/")
    assert "remote-stoken" not in token
    assert "remote-stoken" not in collection.etag
    assert list(hrefs) == ["contact-1.vcf"]


def test_carddav_sync_returns_changed_href_since_retained_token(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)
    cache_col = collection.collection.cache_col
    record_dav_change(
        cache_col,
        "contact-1.vcf",
        etag="etag-2",
        deleted=False,
    )

    new_token, hrefs = collection.sync(old_token)

    assert new_token != old_token
    assert list(hrefs) == ["contact-1.vcf"]


def test_carddav_sync_returns_no_hrefs_for_current_token(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    current_token, _ = collection.sync(None)

    same_token, hrefs = collection.sync(current_token)

    assert same_token == current_token
    assert list(hrefs) == []


def test_local_carddav_delete_advances_token_and_reports_original_href(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)

    collection.delete("contact-1.vcf")
    new_token, hrefs = collection.sync(old_token)

    assert new_token != old_token
    assert list(hrefs) == ["contact-1.vcf"]
    assert collection._get("contact-1.vcf") is None


def test_local_carddav_update_advances_token_and_reports_href(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)
    replacement = MagicMock()
    replacement.vobject_item = vobject.readOne(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\n"
        "FN:Updated Contact\r\nEND:VCARD"
    )

    collection.upload("contact-1.vcf", replacement)
    new_token, hrefs = collection.sync(old_token)

    assert new_token != old_token
    assert list(hrefs) == ["contact-1.vcf"]


def test_expired_carddav_token_requires_safe_full_resync(mem_db, user, monkeypatch):
    monkeypatch.setattr(config, "DAV_SYNC_TOKEN_RETENTION", 2, raising=False)
    collection = _carddav_collection(mem_db, user)
    expired_token, _ = collection.sync(None)
    cache_col = collection.collection.cache_col

    previous_token = expired_token
    for revision in (1, 2):
        record_dav_change(
            cache_col,
            f"changed-{revision}.vcf",
            deleted=False,
        )
        previous_token, _ = collection.sync(previous_token)

    with pytest.raises(ValueError, match="unknown sync token"):
        collection.sync(expired_token)


def test_empty_carddav_token_requests_safe_full_sync(mem_db, user):
    collection = _carddav_collection(mem_db, user)

    token, hrefs = collection.sync("")

    assert token.startswith("http://radicale.org/ns/sync/")
    assert list(hrefs) == ["contact-1.vcf"]


def test_carddav_sync_refreshes_revision_from_sibling_database_instance(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)
    sibling = CollectionEntity.get_by_id(collection.collection.cache_col.id)
    record_dav_change(
        sibling,
        "contact-1.vcf",
        etag="etag-2",
        deleted=False,
    )

    new_token, hrefs = collection.sync(old_token)

    assert new_token != old_token
    assert list(hrefs) == ["contact-1.vcf"]


def test_local_update_rolls_back_when_dav_change_recording_fails(
    mem_db, user, monkeypatch
):
    collection = _carddav_collection(mem_db, user)
    cache_item = ItemEntity.get(uid="contact-1")
    etesync_item = collection.collection.list.return_value[0]

    def persist_local_update():
        cache_item.dirty = True
        cache_item.eb_item = b"updated-envelope"
        cache_item.save()

    etesync_item.save.side_effect = persist_local_update
    monkeypatch.setattr(
        storage_module,
        "record_dav_change",
        MagicMock(side_effect=RuntimeError("change write failed")),
    )
    replacement = MagicMock()
    replacement.vobject_item = vobject.readOne(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\n"
        "FN:Updated Contact\r\nEND:VCARD"
    )

    with pytest.raises(RuntimeError, match="change write failed"):
        collection.upload("contact-1.vcf", replacement)

    persisted = ItemEntity.get_by_id(cache_item.id)
    assert persisted.dirty is False
    assert persisted.eb_item == b"encrypted-item"


def test_local_delete_rolls_back_when_dav_change_recording_fails(
    mem_db, user, monkeypatch
):
    collection = _carddav_collection(mem_db, user)
    cache_item = ItemEntity.get(uid="contact-1")
    monkeypatch.setattr(
        storage_module,
        "record_dav_change",
        MagicMock(side_effect=RuntimeError("change write failed")),
    )

    with pytest.raises(RuntimeError, match="change write failed"):
        collection.delete("contact-1.vcf")

    assert ItemEntity.get_by_id(cache_item.id).deleted is False


def test_local_item_events_do_not_log_raw_hrefs(mem_db, user, monkeypatch):
    collection = _carddav_collection(mem_db, user)
    events = []
    monkeypatch.setattr(
        storage_module,
        "log_sync_event",
        lambda level, message: events.append((level, message)),
    )
    replacement = MagicMock()
    replacement.vobject_item = vobject.readOne(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\n"
        "FN:Updated Contact\r\nEND:VCARD"
    )

    collection.upload("contact-1.vcf", replacement)
    collection.delete("contact-1.vcf")

    assert events
    assert "contact-1.vcf" not in " ".join(message for _, message in events)


def test_current_token_from_lost_history_is_rejected(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    token, _ = collection.sync(None)
    DavSyncToken.delete().execute()

    with pytest.raises(ValueError, match="unknown sync token"):
        collection.sync(token)


def test_token_is_rejected_when_revision_ledger_is_incomplete(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    token, _ = collection.sync(None)
    record_dav_change(
        collection.collection.cache_col,
        "contact-1.vcf",
        etag="etag-2",
    )
    DavRevision.delete().execute()

    with pytest.raises(ValueError, match="unknown sync token"):
        collection.sync(token)


def test_carddav_report_is_bounded_by_returned_token_revision(
    mem_db, user, monkeypatch
):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)
    cache_col = collection.collection.cache_col
    record_dav_change(cache_col, "contact-1.vcf", etag="etag-2")

    original_prune = collection._prune_sync_history

    def concurrent_change_after_snapshot():
        original_prune()
        record_dav_change(cache_col, "contact-2.vcf", etag="etag-3")

    monkeypatch.setattr(
        collection,
        "_prune_sync_history",
        concurrent_change_after_snapshot,
    )
    token_at_revision_one, hrefs = collection.sync(old_token)

    assert list(hrefs) == ["contact-1.vcf"]
    monkeypatch.setattr(collection, "_prune_sync_history", original_prune)
    _, next_hrefs = collection.sync(token_at_revision_one)
    assert list(next_hrefs) == ["contact-2.vcf"]


def test_carddav_token_expires_by_age(mem_db, user, monkeypatch):
    monkeypatch.setattr(config, "DAV_SYNC_TOKEN_MAX_AGE", 60, raising=False)
    collection = _carddav_collection(mem_db, user)
    token, _ = collection.sync(None)
    DavSyncToken.update(created_at=0).execute()

    with pytest.raises(ValueError, match="unknown sync token"):
        collection.sync(token)


def test_parse_failure_does_not_expose_href_or_collection_path(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    collection.collection.list.return_value[0].content = "not a vcard"

    with pytest.raises(RuntimeError) as exc_info:
        collection._get("contact-1.vcf")

    message = str(exc_info.value)
    assert "contact-1.vcf" not in message
    assert "contacts" not in message
    assert "not a vcard" not in message
    assert exc_info.value.__cause__ is None


def test_missing_href_mapping_uses_safe_opaque_single_segment(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    item = collection.collection.list.return_value[0]
    item.item.uid = "urn:uuid:unsafe/uid"
    HrefMapper.delete().execute()

    hrefs = list(collection._list())

    assert len(hrefs) == 1
    assert hrefs[0].endswith(".vcf")
    assert "/" not in hrefs[0]
    assert "urn:uuid" not in hrefs[0]
