"""File-backed DAV fixtures with independent SDK envelope snapshots."""

import copy
import hashlib
import io
import json
from contextlib import nullcontext
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from etebase import CollectionAccessLevel
from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge import config, local_cache
from silentsuite_bridge.local_cache import db, models
from silentsuite_bridge.radicale import etesync_cache
from silentsuite_bridge.radicale.storage import Collection
from tests.test_carddav_remote_delete_convergence import _RemoteAccount, _service, _vcard
from tests.test_macos_dav_discovery import USERNAME, _application, _basic_auth


class SdkItem:
    def __init__(self, uid, meta, content, deleted=False):
        self.uid = uid
        self.meta = dict(meta)
        self.content = bytes(content)
        self.deleted = deleted

    @property
    def etag(self):
        state = self.content + json.dumps(self.meta, sort_keys=True).encode()
        return hashlib.sha256(state + bytes([self.deleted])).hexdigest()

    def delete(self):
        self.deleted = True


class SdkCollection:
    def __init__(self, uid, kind, meta):
        self.uid = uid
        self.collection_type = kind
        self.meta = dict(meta)
        self.stoken = ""
        self.deleted = False
        self.access_level = 0
        self.item = SdkItem(uid + "-root", {}, b"")

    @property
    def content(self):
        return self.item.content

    @content.setter
    def content(self, value):
        self.item.content = bytes(value)


class SnapshotStore:
    def __init__(self):
        self.entries = {}

    def save(self, obj):
        if isinstance(obj, SdkItem):
            state = (obj.uid, obj.meta, obj.content.hex(), obj.deleted)
        else:
            state = (obj.uid, obj.collection_type, obj.meta, obj.stoken,
                     obj.deleted, obj.access_level, obj.content.hex())
        blob = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).digest()
        self.entries[blob] = copy.deepcopy(obj)
        return blob

    def load(self, blob):
        return copy.deepcopy(self.entries[bytes(blob)])


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes


class DavWorld:
    def __init__(self, app, database, user, remote):
        self.app = app
        self.database = database
        self.user = user
        self.remote = remote
        self.created_collections = []
        self.created_items = []
        remote.col_mgr.create.side_effect = self._create_collection
        remote.item_mgr.create.side_effect = self._create_item

    def _create_collection(self, kind, meta, content):
        obj = SdkCollection(f"sdk-collection-{len(self.created_collections)}", kind, meta)
        obj.access_level = CollectionAccessLevel.Admin  # the creator administers it
        obj.item.content = bytes(content)
        self.created_collections.append(obj)
        return obj

    def _create_item(self, meta, content):
        obj = SdkItem(f"sdk-item-{len(self.created_items)}", meta, content)
        self.created_items.append(obj)
        return obj

    def service(self):
        return _service(self.database, self.user, self.remote)

    def add_collection(self, uid="contacts", kind="etebase.vcard",
                       access_level=CollectionAccessLevel.Admin, **metadata):
        obj = SdkCollection(uid, kind, {"name": "Contacts", **metadata})
        obj.access_level = access_level
        return models.CollectionEntity.create(
            local_user=self.user, uid=uid, eb_col=self.remote.store.save(obj)
        )

    def add_item(self, collection, uid="contact-1", href=None, name=None):
        href = href or uid + ".vcf"
        obj = SdkItem("remote-" + uid, {"name": name or uid, "dav_href": href},
                      _vcard(uid, "Contact " + uid).encode())
        sdk_col = self.remote.store.load(collection.eb_col)
        self.service()._apply_pulled_item(
            collection, sdk_col, self.remote.item_mgr, obj
        )
        return models.ItemEntity.get(
            (models.ItemEntity.collection == collection)
            & (models.ItemEntity.remote_uid == obj.uid)
        )

    def collection(self, uid="contacts"):
        return Collection(SimpleNamespace(etesync=self.service()), f"/{USERNAME}/{uid}")

    def request(self, method, path, body=b"", headers=None, content_type=None):
        if isinstance(body, str):
            body = body.encode()
        captured = {}

        def start_response(status, response_headers):
            captured.update(status=int(status.split()[0]), headers=dict(response_headers))

        environ = {
            "REQUEST_METHOD": method, "PATH_INFO": path,
            "QUERY_STRING": "", "SCRIPT_NAME": "",
            "HTTP_HOST": "127.0.0.1:37358", "SERVER_NAME": "127.0.0.1",
            "SERVER_PORT": "37358", "SERVER_PROTOCOL": "HTTP/1.1",
            "REMOTE_ADDR": "127.0.0.1", "CONTENT_LENGTH": str(len(body)),
            "CONTENT_TYPE": content_type or (
                "text/vcard" if method == "PUT" else "application/xml"
            ),
            "HTTP_AUTHORIZATION": _basic_auth(),
            "wsgi.version": (1, 0), "wsgi.url_scheme": "http",
            "wsgi.input": io.BytesIO(body), "wsgi.errors": io.StringIO(),
            "wsgi.multithread": True, "wsgi.multiprocess": False,
            "wsgi.run_once": False,
        }
        environ.update(headers or {})
        owned = self.database.is_closed()
        context = self.database.connection_context() if owned else nullcontext()
        with context:
            result = b"".join(self.app(environ, start_response))
        return Response(captured["status"], captured["headers"], result)


@pytest.fixture
def dav_world(tmp_path, monkeypatch):
    app = _application(tmp_path, monkeypatch)
    database = SqliteExtDatabase(
        config.DATABASE_FILE, timeout=5.0,
        pragmas={"foreign_keys": 1, "journal_mode": "wal"},
    )
    db.database_proxy.initialize(database)
    local_cache._ensure_cache_tables(database)
    user = models.User.create(username=USERNAME)
    remote = _RemoteAccount()
    remote.store = SnapshotStore()
    for manager in (remote.col_mgr, remote.item_mgr):
        manager.cache_save.side_effect = remote.store.save
        manager.cache_load.side_effect = remote.store.load
    world = DavWorld(app, database, user, remote)
    account = SimpleNamespace(get_collection_manager=lambda: remote.col_mgr)
    monkeypatch.setattr(local_cache, "Account", SimpleNamespace(restore=lambda *_: account))
    monkeypatch.setattr(local_cache, "Client", lambda *_: object())
    cache = etesync_cache.EteSyncCache(config.CREDS_FILE, config.DATABASE_FILE)
    monkeypatch.setattr(etesync_cache, "_etesync_cache", cache)
    # Undo only the storage-session double installed by the existing app helper.
    monkeypatch.setattr(
        "silentsuite_bridge.radicale.storage.etesync_for_user",
        etesync_cache.etesync_for_user,
    )
    yield world
    if not database.is_closed():
        database.close()
