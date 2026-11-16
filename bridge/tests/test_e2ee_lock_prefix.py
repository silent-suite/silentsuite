"""DAV display locks must not drift into (or out of) stored titles."""

from unittest.mock import MagicMock

import pytest
import vobject
from radicale.item import Item

from silentsuite_bridge import config
from silentsuite_bridge.local_cache.models import HrefMapper, ItemEntity
from silentsuite_bridge.radicale.storage import Collection, _unlock_for_store
from tests.test_storage import TestFavoriteCardDavRoundTrip as _StorageFixture

PREFIX = "\U0001f512 "
KINDS = ("VEVENT", "VTODO", "VCARD")


def _content(kind, title="Original", uid="lock-1"):
    if kind == "VCARD":
        lines = ["BEGIN:VCARD", "VERSION:3.0", f"UID:{uid}",
                 f"FN:{title}", "N:Person;Test;;;", "TEL:123", "END:VCARD"]
    else:
        lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN",
                 f"BEGIN:{kind}", f"UID:{uid}", "DTSTAMP:20260101T090000Z",
                 "DTSTART:20260101T100000Z", f"SUMMARY:{title}",
                 "DESCRIPTION:Original description", f"END:{kind}", "END:VCALENDAR"]
    return vobject.readOne("\r\n".join(lines) + "\r\n").serialize()


def _component(item, kind):
    return item if kind == "VCARD" else getattr(item, kind.lower())


def _title(item, kind):
    component = _component(item, kind)
    return component.fn.value if kind == "VCARD" else component.summary.value


@pytest.fixture
def make_collection(mem_db, user, monkeypatch):
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", True)

    def make(kind, content):
        href = "item.vcf" if kind == "VCARD" else "item.ics"
        old_collection, cached, stored = _StorageFixture._collection(
            mem_db, user, content, uid="lock-1", href=href,
        )
        cached.col_type = "etebase." + kind.lower()
        stored.meta["dav_href"] = href
        collection = Collection(old_collection._storage, "/test@example.com/contacts")
        return collection, cached, stored, href

    return make


@pytest.mark.parametrize("kind", KINDS)
def test_get_only_decorates_the_served_copy(make_collection, kind):
    content = _content(kind)
    collection, _, stored, href = make_collection(kind, content)

    fetched = collection._get(href)

    assert _title(fetched.vobject_item, kind) == PREFIX + "Original"
    assert stored.content == content
    stored.save.assert_not_called()
    assert fetched.etag == '"etag-favorite"'
    if kind == "VCARD":
        assert str(fetched.vobject_item.n.value) == str(vobject.readOne(content).n.value)


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("title", ["Original", PREFIX + "X", PREFIX * 2 + "X"])
@pytest.mark.parametrize("enabled", [True, False])
def test_three_get_put_cycles_preserve_stored_bytes(make_collection, monkeypatch, kind, title, enabled):
    original = _content(kind, title)
    collection, _, stored, href = make_collection(kind, original)
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", enabled)

    for _ in range(3):
        fetched = collection._get(href)
        assert _title(fetched.vobject_item, kind) == (PREFIX if enabled else "") + title
        wire = fetched.serialize()
        incoming = Item(vobject_item=vobject.readOne(wire))
        collection.upload(href, incoming)
        assert stored.content == original
        assert incoming.serialize() == wire


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("fetched_on,saved_on", [(False, False), (False, True), (True, False)])
def test_unrelated_edit_preserves_real_lock_across_setting_changes(
    make_collection, monkeypatch, kind, fetched_on, saved_on,
):
    collection, _, stored, href = make_collection(kind, _content(kind, PREFIX + "X"))
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", fetched_on)
    incoming = vobject.readOne(collection._get(href).serialize())
    component = _component(incoming, kind)
    if kind == "VCARD":
        component.tel.value = "456"
    else:
        component.description.value = "Changed description"
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", saved_on)

    collection.upload(href, Item(vobject_item=incoming))

    saved = vobject.readOne(stored.content)
    assert _title(saved, kind) == PREFIX + "X"
    component = _component(saved, kind)
    assert (component.tel.value if kind == "VCARD" else component.description.value) == (
        "456" if kind == "VCARD" else "Changed description"
    )


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("enabled", [True, False])
def test_changed_title_loses_exactly_one_prefix(make_collection, monkeypatch, kind, enabled):
    collection, _, stored, href = make_collection(kind, _content(kind, PREFIX + "X"))
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", enabled)
    collection.upload(href, Item(vobject_item=vobject.readOne(_content(kind, PREFIX + "Y"))))
    assert _title(vobject.readOne(stored.content), kind) == "Y"


@pytest.mark.parametrize("kind", KINDS)
def test_new_item_is_unlocked_before_cache_create(make_collection, kind):
    collection, cached, _, _ = make_collection(kind, _content(kind))
    new_uid = "lock-new"
    href = "new.vcf" if kind == "VCARD" else "new.ics"
    created = MagicMock()
    created.cache_item = ItemEntity.create(collection=cached.cache_col, uid=new_uid, eb_item=b"new")
    created.etag = "new-etag"
    created.meta = {"mtime": 1700000000000, "dav_href": href}

    def create(item, **kwargs):
        created.content = item.serialize()
        return created

    cached.create.side_effect = create
    previous_get = cached.get.side_effect
    cached.get.side_effect = lambda uid: created if uid == new_uid else previous_get(uid)
    incoming = Item(vobject_item=vobject.readOne(_content(kind, PREFIX * 2 + "New", uid=new_uid)))
    wire = incoming.serialize()

    returned = collection.upload(href, incoming)

    assert _title(vobject.readOne(created.content), kind) == PREFIX + "New"
    assert _title(returned.vobject_item, kind) == PREFIX * 2 + "New"
    assert incoming.serialize() == wire
    assert HrefMapper.get(content=created.cache_item).href == href
    assert cached.create.call_args.kwargs == {"dav_href": href}


@pytest.mark.parametrize("kind", KINDS)
def test_toggling_changes_neither_etags_nor_sync_token(make_collection, monkeypatch, kind):
    collection, _, stored, href = make_collection(kind, _content(kind))
    before = stored.content
    token, hrefs = collection.sync()
    assert hrefs == [href]
    item_etag, collection_etag = collection._get(href).etag, collection.etag

    for enabled in (False, True):
        monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", enabled)
        assert collection._get(href).etag == item_etag
        assert collection.etag == collection_etag
        assert collection.sync(token) == (token, [])
        assert stored.content == before


def _recurring(kind="VEVENT"):
    calendar = vobject.readOne(_content(kind, PREFIX + "Master"))
    getattr(calendar, kind.lower()).add("rrule").value = "FREQ=DAILY;COUNT=3"
    override = vobject.readOne(_content(kind, PREFIX + "Override"))
    component = getattr(override, kind.lower())
    recurrence = vobject.readOne("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
                               "RECURRENCE-ID:20260102T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    component.add(recurrence.vevent.recurrence_id)
    calendar.add(component)
    return calendar.serialize()


@pytest.mark.parametrize("kind", ["VEVENT", "VTODO"])
def test_master_and_override_round_trip_and_edit_independently(make_collection, kind):
    original = _recurring(kind)
    collection, _, stored, href = make_collection(kind, original)
    served = collection._get(href).vobject_item
    components = getattr(served, kind.lower() + "_list")
    assert [c.summary.value for c in components] == [PREFIX * 2 + "Master", PREFIX * 2 + "Override"]
    collection.upload(href, Item(vobject_item=served))
    assert stored.content == original

    components[1].summary.value = PREFIX + "Changed"
    collection.upload(href, Item(vobject_item=served))
    saved = getattr(vobject.readOne(stored.content), kind.lower() + "_list")
    assert [c.summary.value for c in saved] == [PREFIX + "Master", "Changed"]


def test_new_override_is_stripped_once():
    incoming = vobject.readOne(_recurring())
    incoming.vevent_list[1].summary.value = PREFIX * 2 + "New override"
    saved = _unlock_for_store(incoming, _content("VEVENT", PREFIX + "Master"))
    assert [c.summary.value for c in saved.vevent_list] == [PREFIX + "Master", PREFIX + "New override"]


def test_override_identity_matches_tzid_and_utc():
    # New York is UTC-5 in January. The title is unchanged, fetched with locks off.
    stored = _recurring().replace(
        "RECURRENCE-ID:20260102T100000Z", "RECURRENCE-ID;TZID=America/New_York:20260102T050000",
    )
    incoming = vobject.readOne(_recurring())
    saved = _unlock_for_store(incoming, stored)
    assert saved.vevent_list[1].summary.value == PREFIX + "Override"


def test_vcard4_conversion_preserves_structured_name(make_collection):
    content = _content("VCARD", "Bob").replace("VERSION:3.0", "VERSION:4.0")
    collection, _, stored, href = make_collection("VCARD", content)
    fetched = collection._get(href)
    assert fetched.vobject_item.version.value == "3.0"
    assert fetched.vobject_item.fn.value == PREFIX + "Bob"
    assert fetched.vobject_item.n.serialize() == vobject.readOne(content).n.serialize()
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert vobject.readOne(stored.content).fn.value == "Bob"
    assert vobject.readOne(stored.content).n.serialize() == vobject.readOne(content).n.serialize()


def test_synthesized_fn_is_not_decorated_or_stripped(make_collection):
    content = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:lock-1\r\nN:;🔒 Bob;;;\r\nEND:VCARD\r\n"
    collection, _, stored, href = make_collection("VCARD", content)
    expected = str(vobject.readOne(content).n)
    fetched = collection._get(href)
    assert fetched.vobject_item.fn.value == expected
    assert stored.content == content
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert vobject.readOne(stored.content).fn.value == expected


@pytest.mark.parametrize("kind", KINDS)
def test_empty_title_stays_empty(make_collection, kind):
    collection, _, stored, href = make_collection(kind, _content(kind, ""))
    fetched = collection._get(href)
    assert _title(fetched.vobject_item, kind) == ""
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert _title(vobject.readOne(stored.content), kind) == ""


@pytest.mark.parametrize("kind", ["VEVENT", "VTODO"])
def test_missing_summary_stays_missing(make_collection, kind):
    content = _content(kind).replace("SUMMARY:Original\r\n", "")
    collection, _, stored, href = make_collection(kind, content)
    fetched = collection._get(href)
    assert not hasattr(_component(fetched.vobject_item, kind), "summary")
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert not hasattr(_component(vobject.readOne(stored.content), kind), "summary")


def test_vjournal_is_untouched(make_collection):
    content = _content("VJOURNAL", PREFIX + "Journal")
    collection, _, stored, href = make_collection("VEVENT", content)
    fetched = collection._get(href)
    assert fetched.vobject_item.vjournal.summary.value == PREFIX + "Journal"
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert stored.content == content


def test_folded_non_ascii_summary_round_trips(make_collection):
    title = "Réunion 日本語 🗓️ " * 12
    content = _content("VEVENT", title)
    assert "\r\n " in content
    collection, _, stored, href = make_collection("VEVENT", content)
    fetched = collection._get(href)
    assert fetched.vobject_item.vevent.summary.value == PREFIX + title
    collection.upload(href, Item(vobject_item=vobject.readOne(fetched.serialize())))
    assert stored.content == content


@pytest.mark.parametrize("title", ["🔒\ufe0f X", "🔒X", " 🔒 X"])
def test_only_exact_lock_and_space_is_removed(title):
    saved = _unlock_for_store(vobject.readOne(_content("VEVENT", title)), None)
    assert saved.vevent.summary.value == title


def test_wsgi_get_put_preserves_title_and_returns_storage_etag(tmp_path, monkeypatch):
    from tests.test_carddav_remote_delete_convergence import COLLECTION_UID, _bridge, _seed, _service
    from tests.test_macos_dav_discovery import USERNAME
    from tests.test_vcard_nickname_list import _call

    app, database, user, remote, direct_storage = _bridge(tmp_path, monkeypatch)
    _seed(remote, _service(database, user, remote))
    monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", True)
    headers = {}
    match = None

    def capture_app(environ, start_response):
        if environ["REQUEST_METHOD"] == "PUT" and match is not None:
            environ["HTTP_IF_MATCH"] = match

        def capture(status, response_headers):
            headers.clear()
            headers.update({key.lower(): value for key, value in response_headers})
            return start_response(status, response_headers)

        return app(environ, capture)

    status, _ = _call(capture_app, "PUT", "lock.vcf", _content("VCARD", PREFIX * 2 + "X").encode())
    assert status.startswith("201")
    assert vobject.readOne(remote.created[0].content.decode()).fn.value == PREFIX + "X"

    for fetched_on, saved_on in ((True, True), (True, False), (False, True), (False, False)):
        monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", fetched_on)
        status, body = _call(capture_app, "GET", "lock.vcf")
        assert status.startswith("200")
        card = vobject.readOne(body)
        assert card.fn.value == PREFIX * (2 if fetched_on else 1) + "X"
        match = headers["etag"]
        card.tel.value += "4"
        monkeypatch.setattr(config, "E2EE_LOCK_PREFIX", saved_on)
        status, _ = _call(capture_app, "PUT", "lock.vcf", card.serialize().encode())
        assert status.startswith("201")
        direct = Collection(direct_storage, f"/{USERNAME}/{COLLECTION_UID}")._get("lock.vcf")
        assert headers["etag"] == direct.etag
        assert vobject.readOne(direct.etesync_item.content).fn.value == PREFIX + "X"
