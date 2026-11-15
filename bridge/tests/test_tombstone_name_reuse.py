"""A name freed by a remote deletion can be reused.

The Bridge keeps a tombstone row for an item it held before the item was
deleted remotely. That row still owns the item's local name (its UID), which
must not stop a later item with the same name from syncing or from being
created through DAV at another href.

Drives the real sync service with scripted SDK managers and the real Radicale
WSGI application from ``test_carddav_remote_delete_convergence``. All literals
are synthetic.
"""

import io
import logging

import pytest
import vobject

from silentsuite_bridge import local_cache as local_cache_module
from silentsuite_bridge.local_cache import (
    DAV_UNRESOLVED_RETRY_LIMIT,
    DavUnresolvedItemsError,
    models,
)
from silentsuite_bridge.radicale.storage import Collection
from tests.test_carddav_remote_delete_convergence import (
    COLLECTION_UID,
    _bridge,
    _cache_col,
    _production_logging_boundary,
    _remote_collection,
    _remote_item,
    _report,
    _seed,
    _service,
    _vcard,
)
from tests.test_macos_dav_discovery import USERNAME, _basic_auth


def _put(app, href, body):
    captured = {}

    def start_response(status, headers):
        captured["status"] = status

    payload = body.encode()
    environ = {
        "REQUEST_METHOD": "PUT",
        "PATH_INFO": f"/{USERNAME}/{COLLECTION_UID}/{href}",
        "QUERY_STRING": "",
        "SCRIPT_NAME": "",
        "HTTP_HOST": "127.0.0.1:37358",
        "SERVER_NAME": "127.0.0.1",
        "SERVER_PORT": "37358",
        "SERVER_PROTOCOL": "HTTP/1.1",
        "REMOTE_ADDR": "127.0.0.1",
        "CONTENT_LENGTH": str(len(payload)),
        "CONTENT_TYPE": "text/vcard; charset=utf-8",
        "HTTP_AUTHORIZATION": _basic_auth(),
        "wsgi.version": (1, 0),
        "wsgi.url_scheme": "http",
        "wsgi.input": io.BytesIO(payload),
        "wsgi.errors": io.StringIO(),
        "wsgi.multithread": False,
        "wsgi.multiprocess": False,
        "wsgi.run_once": False,
    }
    b"".join(app(environ, start_response))
    return captured["status"]


def _delete_remotely(remote, service, contact_a):
    tombstone = _remote_item(
        "remote-a",
        "",
        meta=dict(contact_a.meta),
        deleted=True,
        etag="etag-a-1",
    )
    remote.queue_item_page(tombstone, stoken="items-deleted")
    service.sync()


def _replacement(dav_href):
    return _remote_item(
        "remote-a-new",
        _vcard("contact-a", "Contact A Again"),
        meta={"name": "contact-a", "dav_href": dav_href},
        etag="etag-a-new",
    )


def _rows(user, **where):
    cache_col = _cache_col(user)
    query = models.ItemEntity.select().where(
        models.ItemEntity.collection == cache_col
    )
    for field, value in where.items():
        query = query.where(getattr(models.ItemEntity, field) == value)
    return list(query)


@pytest.mark.parametrize(
    "dav_href", ["contact-a.vcf", "contact-a-again.vcf"], ids=["same", "other"]
)
def test_new_remote_item_reusing_deleted_name_syncs(
    tmp_path, monkeypatch, caplog, dav_href
):
    caplog.set_level(logging.DEBUG)
    _production_logging_boundary(monkeypatch)
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    contact_a, _contact_b = _seed(remote, service)
    _delete_remotely(remote, service, contact_a)
    status, _responses, token_1 = _report(app)
    assert status == "207 Multi-Status"

    remote.queue_item_page(_replacement(dav_href), stoken="items-again")
    service.sync()

    assert models.DavUnresolvedItem.select().count() == 0
    (row,) = _rows(user, uid="contact-a")
    assert row.remote_uid == "remote-a-new"
    assert row.deleted is False
    assert _rows(user, remote_uid="remote-a") == []

    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {dav_href: ("HTTP/1.1 200 OK", '"etag-a-new"')}
    assert token_2 != token_1
    status, responses, _token = _report(app)
    assert set(responses) == {dav_href, "contact-b.vcf"}
    assert "contact-a" not in caplog.text
    assert USERNAME not in caplog.text


def test_capped_quarantine_from_older_release_recovers(tmp_path, monkeypatch):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    contact_a, _contact_b = _seed(remote, service)
    _delete_remotely(remote, service, contact_a)

    # Reproduce the older behaviour: the tombstone could not be retired, so
    # the replacement was quarantined and retried until the cap froze it.
    with monkeypatch.context() as older:
        older.setattr(
            local_cache_module, "retire_settled_tombstone", lambda _row: False
        )
        remote.queue_item_page(
            _replacement("contact-a-again.vcf"), stoken="items-again"
        )
        for _cycle in range(DAV_UNRESOLVED_RETRY_LIMIT + 1):
            with pytest.raises(DavUnresolvedItemsError):
                service.sync()
    (capped,) = list(models.DavUnresolvedItem.select())
    assert capped.remote_uid == "remote-a-new"
    assert capped.attempts >= DAV_UNRESOLVED_RETRY_LIMIT
    assert _report(app)[1].keys() == {"contact-b.vcf"}

    service.sync()

    assert models.DavUnresolvedItem.select().count() == 0
    (row,) = _rows(user, uid="contact-a")
    assert row.remote_uid == "remote-a-new"
    status, responses, _token = _report(app)
    assert status == "207 Multi-Status"
    assert set(responses) == {"contact-a-again.vcf", "contact-b.vcf"}


def test_dav_put_of_deleted_uid_at_other_href_is_created(tmp_path, monkeypatch):
    app, database, user, remote, _direct = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    contact_a, _contact_b = _seed(remote, service)
    _delete_remotely(remote, service, contact_a)
    status, _responses, token_1 = _report(app)

    status = _put(app, "moved.vcf", _vcard("contact-a", "Contact A Moved"))

    assert status.startswith("201")
    (row,) = _rows(user, uid="contact-a")
    assert row.deleted is False and row.new is True
    assert models.HrefMapper.get(models.HrefMapper.content == row).href == (
        "moved.vcf"
    )
    status, responses, _token = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert set(responses) == {"moved.vcf"}
    assert responses["moved.vcf"][0] == "HTTP/1.1 200 OK"


def test_dav_put_of_pending_deleted_uid_is_rejected_cleanly(
    tmp_path, monkeypatch
):
    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    direct = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    direct.delete("contact-a.vcf")
    (pending,) = _rows(user, uid="contact-a")
    assert pending.deleted is True and pending.dirty is True

    status = _put(app, "moved.vcf", _vcard("contact-a", "Contact A Moved"))

    assert status.startswith("400")
    (kept,) = _rows(user, uid="contact-a")
    assert kept.id == pending.id
    assert kept.remote_uid == "remote-a"
    assert kept.deleted is True and kept.dirty is True
    assert models.HrefMapper.get(models.HrefMapper.content == kept).href == (
        "contact-a.vcf"
    )


def test_direct_upload_keeps_live_uid_owner(tmp_path, monkeypatch):
    _app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    service = _service(database, user, remote)
    _seed(remote, service)
    direct = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    incoming = type(
        "Incoming", (), {"vobject_item": vobject.readOne(_vcard("contact-a", "X"))}
    )()

    with pytest.raises(ValueError, match="already in use"):
        direct.upload("moved.vcf", incoming)

    (owner,) = _rows(user, uid="contact-a")
    assert owner.remote_uid == "remote-a" and owner.deleted is False
