"""One stored card the Bridge cannot parse must not fail a whole CardDAV response."""
import logging
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock

from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge import config
from silentsuite_bridge import local_cache as local_cache_module
from silentsuite_bridge.local_cache import db, models, record_dav_change
from silentsuite_bridge.radicale import storage as bridge_storage
from silentsuite_bridge.radicale.storage import Collection
from tests.test_macos_dav_discovery import (
    CARDDAV,
    DAV,
    USERNAME,
    _application,
    _basic_auth,
    _request,
)

GOOD_UIDS = ("contact-good-1", "contact-good-2")
BAD_UID = "contact-unreadable"
BAD_NAME = "Private Unreadable Name"
# A legacy file: photo the web import wrote as inline base64; vobject cannot decode it.
BAD_CONTENT = (
    "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:" + BAD_UID + "\r\nFN:" + BAD_NAME + "\r\n"
    "PHOTO;ENCODING=b;TYPE=JPEG:file:///home/u/x.jpg\r\nEND:VCARD"
)

SYNC_REPORT = b"""<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>{token}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop><d:getetag /></d:prop>
</d:sync-collection>
"""

PROPFIND_ETAGS = b"""<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype /><d:getetag /></d:prop></d:propfind>
"""


def _good_content(uid):
    return f"BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:Name {uid}\r\nEND:VCARD"


def _dav_setup(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    database = SqliteExtDatabase(config.DATABASE_FILE, pragmas={"foreign_keys": 1})
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
    local_cache_module._ensure_cache_tables(database)
    user = models.User.create(username=USERNAME)
    cache_col = models.CollectionEntity.create(
        local_user=user, uid="contacts", eb_col=b"collection-cache"
    )

    items = {}
    for uid, content in [(uid, _good_content(uid)) for uid in GOOD_UIDS] + [(BAD_UID, BAD_CONTENT)]:
        cache_item = models.ItemEntity.create(
            collection=cache_col, uid=uid, remote_uid=f"remote-{uid}", eb_item=b"item-cache"
        )
        models.HrefMapper.create(content=cache_item, href=f"{uid}.vcf")
        item = MagicMock()
        item.item.uid = uid
        item.cache_item = cache_item
        item.uid = uid
        item.etag = f"etag-{uid}"
        item.content = content
        item.meta = {"mtime": 1700000000000}
        items[uid] = item

    cached_collection = MagicMock()
    cached_collection.cache_col = cache_col
    cached_collection.col_type = "etebase.vcard"
    cached_collection.stoken = "remote-stoken"
    cached_collection.list.return_value = list(items.values())
    cached_collection.get.side_effect = items.get
    etesync = MagicMock()
    etesync.get.return_value = cached_collection
    etesync.list.return_value = [cached_collection]

    context = MagicMock()
    context.__enter__.return_value = (etesync, False)
    context.__exit__.return_value = False
    monkeypatch.setattr(bridge_storage, "etesync_for_user", lambda _user, **_kwargs: context)

    direct_storage = MagicMock()
    direct_storage.etesync = etesync
    direct_collection = Collection(direct_storage, f"/{USERNAME}/contacts")
    return app, cache_col, items, direct_collection


def _responses(body):
    return {
        response.findtext(f"{DAV}href", "").rsplit("/", 1)[-1]: response
        for response in ET.fromstring(body).findall(f"{DAV}response")
    }


def _assert_private_log(caplog):
    assert "DAV response left out 1 unreadable item(s)" in caplog.text
    for private in (BAD_UID, BAD_NAME, "x.jpg"):
        assert private not in caplog.text


def test_propfind_listing_leaves_out_unreadable_card(tmp_path, monkeypatch, caplog):
    app, _cache_col, _items, _direct = _dav_setup(tmp_path, monkeypatch)
    caplog.set_level(logging.WARNING)

    status, _headers, body = _request(
        app, f"/{USERNAME}/contacts/", body=PROPFIND_ETAGS, depth="1", auth=_basic_auth()
    )

    assert status == "207 Multi-Status"
    responses = _responses(body)
    assert {f"{uid}.vcf" for uid in GOOD_UIDS} <= set(responses)
    assert f"{BAD_UID}.vcf" not in responses
    _assert_private_log(caplog)


def test_multiget_returns_readable_cards_and_omits_unreadable(tmp_path, monkeypatch, caplog):
    app, _cache_col, _items, _direct = _dav_setup(tmp_path, monkeypatch)
    caplog.set_level(logging.WARNING)
    hrefs = "".join(
        f"<d:href>/{USERNAME}/contacts/{uid}.vcf</d:href>" for uid in (*GOOD_UIDS, BAD_UID)
    )
    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<cr:addressbook-multiget xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav">'
        f"<d:prop><d:getetag /><cr:address-data /></d:prop>{hrefs}</cr:addressbook-multiget>"
    ).encode()

    status, _headers, response_body = _request(
        app, f"/{USERNAME}/contacts/", method="REPORT", body=body, depth="1", auth=_basic_auth()
    )

    assert status == "207 Multi-Status"
    responses = _responses(response_body)
    assert set(responses) == {f"{uid}.vcf" for uid in GOOD_UIDS}
    for response in responses.values():
        assert "BEGIN:VCARD" in response.findtext(f".//{CARDDAV}address-data", "")
    _assert_private_log(caplog)


def test_sync_collection_omits_unreadable_card_without_deletion(tmp_path, monkeypatch, caplog):
    app, cache_col, _items, direct_collection = _dav_setup(tmp_path, monkeypatch)
    caplog.set_level(logging.WARNING)

    status, _headers, body = _request(
        app,
        f"/{USERNAME}/contacts/",
        method="REPORT",
        body=SYNC_REPORT.replace(b"{token}", b""),
        depth="1",
        auth=_basic_auth(),
    )
    assert status == "207 Multi-Status"
    assert set(_responses(body)) == {f"{uid}.vcf" for uid in GOOD_UIDS}

    # Delta: the unreadable card and one readable card change after the token.
    old_token, _initial = direct_collection.sync(None)
    for uid in (BAD_UID, GOOD_UIDS[0]):
        previous_state_hash = local_cache_module.dav_collection_state_hash(cache_col)
        record_dav_change(
            cache_col,
            f"{uid}.vcf",
            previous_state_hash=previous_state_hash,
            etag=f"etag-{uid}-2",
            deleted=False,
        )

    status, _headers, body = _request(
        app,
        f"/{USERNAME}/contacts/",
        method="REPORT",
        body=SYNC_REPORT.replace(b"{token}", old_token.encode()),
        depth="1",
        auth=_basic_auth(),
    )

    assert status == "207 Multi-Status"
    responses = _responses(body)
    assert set(responses) == {f"{GOOD_UIDS[0]}.vcf"}
    assert all(
        response.findtext(f"{DAV}status") != "HTTP/1.1 404 Not Found"
        for response in responses.values()
    )
    _assert_private_log(caplog)


def test_direct_get_of_unreadable_card_fails_alone(tmp_path, monkeypatch):
    app, _cache_col, _items, _direct = _dav_setup(tmp_path, monkeypatch)

    status, _headers, _body = _request(
        app, f"/{USERNAME}/contacts/{BAD_UID}.vcf", method="GET", depth=None, auth=_basic_auth()
    )
    assert status.startswith("5")

    status, _headers, body = _request(
        app, f"/{USERNAME}/contacts/", body=PROPFIND_ETAGS, depth="1", auth=_basic_auth()
    )
    assert status == "207 Multi-Status"
    assert {f"{uid}.vcf" for uid in GOOD_UIDS} <= set(_responses(body))
