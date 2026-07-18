"""CardDAV sync-token and deletion convergence regressions."""

from unittest.mock import MagicMock

import pytest
import vobject

from silentsuite_bridge import config
from silentsuite_bridge.local_cache.models import (
    CollectionEntity,
    DavChange,
    HrefMapper,
    ItemEntity,
)
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
    assert list(hrefs) == ["contact-1.vcf"]


def test_carddav_sync_returns_changed_href_since_retained_token(mem_db, user):
    collection = _carddav_collection(mem_db, user)
    old_token, _ = collection.sync(None)
    cache_col = collection.collection.cache_col
    cache_col.dav_revision = 1
    cache_col.save()
    DavChange.create(
        collection=cache_col,
        href="contact-1.vcf",
        revision=1,
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
        cache_col.dav_revision = revision
        cache_col.save()
        DavChange.create(
            collection=cache_col,
            href=f"changed-{revision}.vcf",
            revision=revision,
            deleted=False,
        )
        previous_token, _ = collection.sync(previous_token)

    with pytest.raises(ValueError, match="unknown sync token"):
        collection.sync(expired_token)
