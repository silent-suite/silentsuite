"""Push conflicts: the server version wins and a local edit is kept as a copy.

Drives the real sync service and the real Radicale WSGI application with the
scripted SDK managers from ``test_carddav_remote_delete_convergence``, plus a
small fake server that models Etebase etags: every SDK item carries ``base``
(the server revision it was last saved against), ``fetch_updates`` returns the
server items whose revision differs from that base, and ``transaction``
rejects the whole request (409) when any base is stale. All literals are
synthetic.
"""

import hashlib
import logging

import pytest
import vobject

from silentsuite_bridge import local_cache as local_cache_module
from silentsuite_bridge.local_cache import models, opaque_dav_href
from silentsuite_bridge.radicale.storage import Collection
from tests.test_carddav_remote_delete_convergence import (
    COLLECTION_UID,
    _bridge,
    _cache_col,
    _production_logging_boundary,
    _remote_item,
    _report,
    _seed,
    _service,
    _vcard,
)
from tests.test_macos_dav_discovery import USERNAME

LABEL = " (conflict copy)"


class Conflict(Exception):
    """Stands in for the SDK error raised on a 409 transaction."""


def _clone(item, **changes):
    values = {
        "uid": item.uid,
        "content": item.content.decode(),
        "meta": dict(item.meta),
        "deleted": item.deleted,
        "etag": item.etag,
    }
    values.update(changes)
    uid = values.pop("uid")
    content = values.pop("content")
    clone = _remote_item(uid, content, **values)
    clone.base = clone.etag
    return clone


class FakeServer:
    def __init__(self, remote):
        self.items = {}
        self.uploads = []
        self.fail_next_transaction = None
        self.before_fetch_result = None
        remote.item_mgr.fetch_updates.side_effect = self.fetch_updates
        remote.item_mgr.transaction.side_effect = self.transaction
        remote.item_mgr.batch.side_effect = AssertionError("unconditional batch")

    def fetch_updates(self, items, _options=None):
        changed = [
            _clone(self.items[item.uid])
            for item in items
            if item.uid in self.items
            and self.items[item.uid].etag != _base(item)
        ]
        if self.before_fetch_result is not None:
            hook, self.before_fetch_result = self.before_fetch_result, None
            hook()
        return type("Page", (), {"data": changed})()

    def transaction(self, items, _deps=None, _options=None):
        if self.fail_next_transaction is not None:
            hook, self.fail_next_transaction = self.fail_next_transaction, None
            hook()
            raise Conflict("synthetic")
        for item in items:
            current = self.items.get(item.uid)
            if (current.etag if current else None) != _base(item):
                raise Conflict("synthetic")
        for item in items:
            self.items[item.uid] = _clone(item)
            item.base = item.etag
            self.uploads.append(item.uid)


def _base(item):
    # Only an explicitly set base counts; MagicMock invents missing attributes.
    return vars(item).get("base")


def _content_sensitive_envelopes(remote):
    """Like the real SDK, re-saving an edited item yields different bytes."""
    objects = remote.store._objects

    def save(obj):
        objects[id(obj)] = obj
        state = repr((obj.content, obj.etag, obj.deleted, sorted(dict(obj.meta).items())))
        return id(obj).to_bytes(8, "big") + hashlib.sha256(state.encode()).digest()[:8]

    def load(blob):
        return objects[int.from_bytes(bytes(blob)[:8], "big")]

    # Test helpers read envelopes through the store as well.
    remote.store.save = save
    remote.store.load = load
    remote.item_mgr.cache_save.side_effect = save
    remote.item_mgr.cache_load.side_effect = load
    create = remote.item_mgr.create.side_effect

    def create_unsaved(meta, content):
        item = create(meta, content)
        item.base = None
        return item

    remote.item_mgr.create.side_effect = create_unsaved


def _world(tmp_path, monkeypatch):
    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    _content_sensitive_envelopes(remote)
    service = _service(database, user, remote)
    contact_a, contact_b = _seed(remote, service)
    for contact in (contact_a, contact_b):
        contact.base = contact.etag
    server = FakeServer(remote)
    server.items = {c.uid: _clone(c) for c in (contact_a, contact_b)}
    direct = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")
    return app, user, remote, service, server, direct


def _cached(remote, user, remote_uid):
    row = models.ItemEntity.get(
        (models.ItemEntity.collection == _cache_col(user))
        & (models.ItemEntity.remote_uid == remote_uid)
    )
    return row, remote.store.load(row.eb_item)


def _edit_locally(direct, remote, user, fn, *, etag):
    incoming = type(
        "Incoming", (), {"vobject_item": vobject.readOne(_vcard("contact-a", fn))}
    )()
    direct.upload("contact-a.vcf", incoming)
    _row, local = _cached(remote, user, "remote-a")
    local.etag = etag  # a local edit is a new revision of the same item
    return local


def _delete_locally(direct, remote, user, *, etag):
    direct.delete("contact-a.vcf")
    _row, local = _cached(remote, user, "remote-a")
    local.etag = etag


def _edit_remotely(server, fn, *, etag="etag-a-2", deleted=False):
    server.items["remote-a"] = _clone(
        server.items["remote-a"],
        content="" if deleted else _vcard("contact-a", fn),
        etag=etag,
        deleted=deleted,
    )


def _copies(user):
    return list(
        models.ItemEntity.select().where(
            (models.ItemEntity.collection == _cache_col(user))
            & models.ItemEntity.uid.contains("-conflict-")
        )
    )


def _copy_base(local_etag, remote_uid="remote-a"):
    digest = hashlib.sha256(f"{remote_uid}:{local_etag}".encode()).hexdigest()
    return f"contact-a-conflict-{digest[:12]}"


def _sync(service):
    try:
        service.sync()
    except Exception as exc:  # noqa: BLE001 - the outcome is the class
        return type(exc).__name__
    return "success"


def _assert_copy(remote, copy_row, uid, fn):
    copy_item = remote.store.load(copy_row.eb_item)
    card = vobject.readOne(copy_item.content.decode())
    assert copy_row.uid == uid
    assert copy_item.meta["name"] == uid
    assert card.uid.value == uid
    assert card.fn.value == fn + LABEL
    return copy_item


def _tokens(user):
    return models.DavSyncToken.select().where(
        models.DavSyncToken.collection == _cache_col(user)
    ).count()


def test_local_edit_vs_remote_edit_keeps_server_and_a_copy(
    tmp_path, monkeypatch, caplog
):
    caplog.set_level(logging.DEBUG)
    _production_logging_boundary(monkeypatch)
    app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    status, _responses, token_1 = _report(app)
    tokens_before = _tokens(user)

    assert _sync(service) == "success"

    original, server_version = _cached(remote, user, "remote-a")
    assert not original.dirty and not original.new and not original.deleted
    assert vobject.readOne(server_version.content.decode()).fn.value == "Server Edit"
    (copy_row,) = _copies(user)
    uid = _copy_base("etag-a-local")
    copy_item = _assert_copy(remote, copy_row, uid, "Local Edit")
    assert not copy_row.dirty and not copy_row.new
    assert server.items[copy_item.uid].etag == copy_item.etag
    assert server.items["remote-a"].etag == "etag-a-2"
    copy_href = opaque_dav_href(uid, ".vcf")
    assert copy_item.meta["dav_href"] == copy_href

    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {
        "contact-a.vcf": ("HTTP/1.1 200 OK", '"etag-a-2"'),
        copy_href: ("HTTP/1.1 200 OK", f'"{copy_item.etag}"'),
    }
    assert token_2 != token_1
    assert _tokens(user) >= tokens_before
    revisions = list(
        models.DavRevision.select()
        .where(models.DavRevision.collection == _cache_col(user))
        .order_by(models.DavRevision.revision)
    )
    for previous, current in zip(revisions, revisions[1:]):
        assert current.previous_state_hash == previous.state_hash
    for secret in ("contact-a", uid, "Local Edit", "Server Edit", USERNAME):
        assert secret not in caplog.text


def test_local_edit_vs_remote_delete_keeps_the_edit_as_a_copy(tmp_path, monkeypatch):
    app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, None, deleted=True)
    _status, _responses, token_1 = _report(app)

    assert _sync(service) == "success"

    original, _server_version = _cached(remote, user, "remote-a")
    assert original.deleted and not original.dirty
    (copy_row,) = _copies(user)
    copy_item = _assert_copy(remote, copy_row, _copy_base("etag-a-local"), "Local Edit")
    status, responses, _token = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses["contact-a.vcf"] == ("HTTP/1.1 404 Not Found", None)
    assert responses[copy_item.meta["dav_href"]][0] == "HTTP/1.1 200 OK"


def test_local_delete_vs_remote_edit_server_wins(tmp_path, monkeypatch):
    app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _delete_locally(direct, remote, user, etag="etag-a-deleted")
    _edit_remotely(server, "Server Edit")
    _status, _responses, token_1 = _report(app)

    assert _sync(service) == "success"

    original, server_version = _cached(remote, user, "remote-a")
    assert not original.deleted and not original.dirty
    assert _copies(user) == []
    assert server.uploads == []
    status, responses, _token = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert responses == {"contact-a.vcf": ("HTTP/1.1 200 OK", '"etag-a-2"')}


def test_local_delete_vs_remote_delete_settles_without_upload(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _delete_locally(direct, remote, user, etag="etag-a-deleted")
    _edit_remotely(server, None, deleted=True)

    assert _sync(service) == "success"

    original, _server_version = _cached(remote, user, "remote-a")
    assert original.deleted and not original.dirty
    assert _copies(user) == []
    assert server.uploads == []


def test_no_conflict_uploads_with_one_transaction(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")

    assert _sync(service) == "success"

    assert server.uploads == ["remote-a"]
    assert remote.item_mgr.transaction.call_count == 1
    assert _copies(user) == []
    original, _local = _cached(remote, user, "remote-a")
    assert not original.dirty


def test_lost_acknowledgement_is_acknowledged_without_copy(tmp_path, monkeypatch):
    app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    local = _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    # The upload reached the server but the acknowledgement was lost.
    server.items["remote-a"] = _clone(local)
    _status, _responses, token_1 = _report(app)

    assert _sync(service) == "success"

    original, stored = _cached(remote, user, "remote-a")
    assert not original.dirty and _copies(user) == []
    assert server.uploads == []
    assert stored.base == "etag-a-local"
    status, responses, token_2 = _report(app, token_1)
    assert status == "207 Multi-Status" and responses == {}
    assert token_2 == token_1

    # The stored server envelope is the base of the next edit: no conflict.
    _edit_locally(direct, remote, user, "Second Edit", etag="etag-a-local-2")
    assert _sync(service) == "success"
    assert _copies(user) == []
    assert server.uploads == ["remote-a"]
    assert server.items["remote-a"].etag == "etag-a-local-2"


def test_crash_before_resolution_creates_exactly_one_copy(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    create = remote.item_mgr.create.side_effect
    calls = []

    def crash_once(meta, content):
        calls.append(meta)
        if len(calls) == 1:
            raise RuntimeError("synthetic crash")
        return create(meta, content)

    remote.item_mgr.create.side_effect = crash_once

    assert _sync(service) == "RuntimeError"
    original, _local = _cached(remote, user, "remote-a")
    assert original.dirty and _copies(user) == []

    assert _sync(service) == "success"
    (copy_row,) = _copies(user)
    assert copy_row.uid == _copy_base("etag-a-local")
    assert len(remote.created) == 1
    assert sum(uid.startswith("remote-local-") for uid in server.items) == 1


def test_crash_before_copy_upload_uploads_the_copy_once(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    server.fail_next_transaction = lambda: None

    assert _sync(service) == "Conflict"
    (copy_row,) = _copies(user)
    assert copy_row.new and copy_row.dirty

    assert _sync(service) == "success"
    (copy_row,) = _copies(user)
    assert not copy_row.new and not copy_row.dirty
    assert len(remote.created) == 1
    assert server.uploads == [remote.created[0].uid]


def test_dav_edit_during_resolution_is_not_settled(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    server.before_fetch_result = lambda: _edit_locally(
        direct, remote, user, "Newer Edit", etag="etag-a-local-2"
    )

    assert _sync(service) == "success"
    original, _local = _cached(remote, user, "remote-a")
    assert original.dirty and _copies(user) == []

    assert _sync(service) == "success"
    (copy_row,) = _copies(user)
    _assert_copy(remote, copy_row, _copy_base("etag-a-local-2"), "Newer Edit")


def test_conflict_racing_the_upload_is_resolved_next_cycle(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    server.fail_next_transaction = lambda: _edit_remotely(server, "Server Edit")

    assert _sync(service) == "Conflict"
    original, _local = _cached(remote, user, "remote-a")
    assert original.dirty and _copies(user) == []
    assert server.items["remote-a"].etag == "etag-a-2"

    assert _sync(service) == "success"
    (copy_row,) = _copies(user)
    _assert_copy(remote, copy_row, _copy_base("etag-a-local"), "Local Edit")
    assert server.items["remote-a"].etag == "etag-a-2"


def _foreign(user, remote, uid, *, href=None, deleted=False):
    envelope = _remote_item(
        f"remote-foreign-{uid}", _vcard(uid, "Foreign"), meta={"name": uid},
        etag=f"etag-foreign-{uid}", deleted=deleted,
    )
    row = models.ItemEntity.create(
        collection=_cache_col(user),
        uid=uid,
        remote_uid=envelope.uid,
        eb_item=remote.store.save(envelope),
        deleted=deleted,
    )
    if href is not None:
        models.HrefMapper.create(content=row, href=href)
    return row


@pytest.mark.parametrize("deleted", [False, True], ids=["live", "tombstone"])
def test_occupied_copy_uid_takes_the_next_candidate(tmp_path, monkeypatch, deleted):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    base = _copy_base("etag-a-local")
    foreign = _foreign(user, remote, base, deleted=deleted)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")

    assert _sync(service) == "success"

    copy_rows = [row for row in _copies(user) if row.id != foreign.id]
    (copy_row,) = copy_rows
    _assert_copy(remote, copy_row, f"{base}-2", "Local Edit")
    assert models.ItemEntity.get_by_id(foreign.id).uid == base


def test_all_copy_uids_occupied_keeps_the_edit_pending(tmp_path, monkeypatch):
    _app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    base = _copy_base("etag-a-local")
    for index in range(1, 9):
        _foreign(user, remote, base if index == 1 else f"{base}-{index}")
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    before, _local = _cached(remote, user, "remote-a")

    assert _sync(service) == "success"

    after, local = _cached(remote, user, "remote-a")
    assert after.dirty and after.eb_item == before.eb_item
    assert vobject.readOne(local.content.decode()).fn.value == "Local Edit"
    assert len(_copies(user)) == 8
    assert remote.created == []


def test_occupied_copy_href_takes_the_next_candidate(tmp_path, monkeypatch):
    app, user, remote, service, server, direct = _world(tmp_path, monkeypatch)
    base = _copy_base("etag-a-local")
    taken = opaque_dav_href(base, ".vcf")
    foreign = _foreign(user, remote, "foreign-owner", href=taken)
    _edit_locally(direct, remote, user, "Local Edit", etag="etag-a-local")
    _edit_remotely(server, "Server Edit")
    _status, _responses, token_1 = _report(app)
    tokens_before = _tokens(user)

    assert _sync(service) == "success"

    (copy_row,) = _copies(user)
    expected = opaque_dav_href(f"{base}:1", ".vcf")
    assert models.HrefMapper.get(models.HrefMapper.content == copy_row).href == expected
    assert models.HrefMapper.get(models.HrefMapper.content == foreign).href == taken
    assert _tokens(user) >= tokens_before
    status, responses, _token = _report(app, token_1)
    assert status == "207 Multi-Status"
    assert set(responses) == {"contact-a.vcf", expected}


RECURRING = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n"
    "BEGIN:VEVENT\r\nUID:series\r\nDTSTART:20260101T100000Z\r\n"
    "RRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Standup\r\nEND:VEVENT\r\n"
    "BEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID:20260102T100000Z\r\n"
    "DTSTART:20260102T110000Z\r\nSUMMARY:Moved standup\r\nEND:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


def test_recurring_event_copy_moves_every_component():
    parsed = local_cache_module._parse_conflict_copy(RECURRING.encode())
    copied = vobject.readOne(
        local_cache_module._conflict_copy_content(parsed, "series-copy").decode()
    )
    events = copied.contents["vevent"]
    assert [event.uid.value for event in events] == ["series-copy", "series-copy"]
    assert [event.summary.value for event in events] == [
        "Standup" + LABEL,
        "Moved standup" + LABEL,
    ]
    assert hasattr(events[1], "recurrence_id")


def test_unparseable_edit_is_not_copied():
    assert local_cache_module._parse_conflict_copy(b"not a calendar") is None
