"""Protocol-level CardDAV sync REPORT regressions."""
import logging
import xml.etree.ElementTree as ET
from unittest.mock import MagicMock

from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge import config
from silentsuite_bridge import local_cache as local_cache_module
from silentsuite_bridge.local_cache import db, models, record_dav_change
from silentsuite_bridge.radicale import application as bridge_application
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


def test_sync_collection_report_emits_literal_404_for_remote_deletion(
    tmp_path,
    monkeypatch,
    caplog,
):
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
    cache_col = models.CollectionEntity.create(
        local_user=user,
        uid="contacts",
        eb_col=b"collection-cache",
    )
    cache_item = models.ItemEntity.create(
        collection=cache_col,
        uid="contact-1",
        remote_uid="remote-contact-1",
        eb_item=b"item-cache",
    )
    models.HrefMapper.create(content=cache_item, href="contact-1.vcf")

    item = MagicMock()
    item.item.uid = "contact-1"
    item.cache_item = cache_item
    item.uid = "contact-1"
    item.etag = "etag-1"
    item.content = (
        "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:contact-1\r\n"
        "FN:Contact One\r\nEND:VCARD"
    )
    item.meta = {"mtime": 1700000000000}

    cached_collection = MagicMock()
    cached_collection.cache_col = cache_col
    cached_collection.col_type = "etebase.vcard"
    cached_collection.stoken = "remote-stoken"
    cached_collection.list.return_value = [item]
    cached_collection.get.return_value = item
    etesync = MagicMock()
    etesync.get.return_value = cached_collection
    etesync.list.return_value = [cached_collection]

    direct_storage = MagicMock()
    direct_storage.etesync = etesync
    direct_collection = Collection(
        direct_storage,
        f"/{USERNAME}/contacts",
    )
    old_token, initial_hrefs = direct_collection.sync(None)
    assert list(initial_hrefs) == ["contact-1.vcf"]

    previous_state_hash = local_cache_module.dav_collection_state_hash(cache_col)
    cache_item.deleted = True
    cache_item.save()
    cached_collection.get.return_value = None
    cached_collection.list.return_value = []
    record_dav_change(
        cache_col,
        "contact-1.vcf",
        previous_state_hash=previous_state_hash,
        etag="etag-1",
        deleted=True,
    )

    context = MagicMock()
    context.__enter__.return_value = (etesync, False)
    context.__exit__.return_value = False
    monkeypatch.setattr(
        bridge_storage,
        "etesync_for_user",
        lambda _user: context,
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
    root = ET.fromstring(body)
    deleted_response = next(
        response
        for response in root.findall(f"{DAV}response")
        if response.findtext(f"{DAV}href", "").endswith("/contact-1.vcf")
    )
    assert deleted_response.findtext(f"{DAV}status") == "HTTP/1.1 404 Not Found"

    private_token = "http://radicale.org/ns/sync/private-client-token"
    _request(
        app,
        f"/{USERNAME}/contacts/",
        method="REPORT",
        body=SYNC_REPORT.replace(b"{token}", private_token.encode()),
        depth="1",
        auth=_basic_auth(),
    )
    assert private_token not in caplog.text
    assert "private-client-token" not in caplog.text

    caplog.clear()
    caplog.set_level(logging.DEBUG, logger="radicale")
    private_payload = b"<private-report-payload"
    private_collection = "private-collection-identifier"
    status, _headers, _body = _request(
        app,
        f"/{USERNAME}/{private_collection}/",
        method="REPORT",
        body=private_payload,
        depth="1",
        auth=_basic_auth(),
    )
    assert status == "400 Bad Request"
    assert private_payload.decode() not in caplog.text
    assert private_collection not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_radicale_filter_redacts_exception_free_server_diagnostics():
    record = logging.LogRecord(
        name="radicale",
        level=logging.ERROR,
        pathname="/site-packages/radicale/server.py",
        lineno=1,
        msg="Server worker failed (%s)",
        args=("RuntimeError",),
        exc_info=None,
    )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    assert record.msg == "Radicale server request failed"
    assert record.args == ()


def test_radicale_filter_redacts_server_request_exception():
    private_value = "private-contact-href.vcf"
    error = RuntimeError(private_value)
    record = logging.LogRecord(
        name="radicale.server",
        level=logging.ERROR,
        pathname="/site-packages/radicale/server.py",
        lineno=1,
        msg="An exception occurred during request: %s",
        args=(error,),
        exc_info=(RuntimeError, error, None),
    )

    bridge_application._DavDiagnosticRedactionFilter().filter(record)

    assert record.msg == "Radicale server request failed"
    assert record.args == ()
    assert record.exc_info is None
    assert private_value not in record.getMessage()
