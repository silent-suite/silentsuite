"""Bridge Birthdays calendar (#738): tests-first checkpoint.

Each test is labelled:
  INTENDED-RED  must fail on its assertion against the neutral scaffold in
                silentsuite_bridge/birthdays.py and the unchanged local_cache/web code.
  CONTROL       expected to pass at this checkpoint (baseline behaviour that the
                production change must keep).

SDK objects are faked at the Python SDK boundary the production code will use
(etebase 0.31.5: CollectionManager.list/get_item_manager/get_member_manager/
transaction, ItemManager.list/create/transaction(items, deps), Collection.content/
.item/.access_level/.uid/.collection_type, MemberListResponse.data[].username).
No network, no real accounts.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from etebase import CollectionAccessLevel
from playhouse.sqlite_ext import SqliteExtDatabase

from silentsuite_bridge import birthdays
from silentsuite_bridge.local_cache import (
    Collection,
    DavUnresolvedItemsError,
    Etebase,
    db,
    models,
)
from silentsuite_bridge.local_cache.models import CollectionEntity
from silentsuite_bridge.web import Web, _dashboard_csrf_token
from tests.conftest import _make_mock_collection

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "birthday-calendar" / "v1-vectors.json").read_text(
        encoding="utf-8"
    )
)
ACTIVE = b'{"type":"silentsuite.birthdays","v":1,"state":"active"}'
RETIRED = b'{"type":"silentsuite.birthdays","v":1,"state":"retired"}'
USERNAME = "alice@example.com"


# ---------------------------------------------------------------------------
# Shared contract vectors (pure helpers)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["marker"], ids=lambda v: repr(v["content"])[:40])
def test_marker_vectors(vector):
    """INTENDED-RED for active/retired vectors; CONTROL for vectors whose state is null."""
    assert birthdays.parse_birthday_marker(vector["content"].encode("utf-8")) == vector["state"]


@pytest.mark.parametrize("vector", VECTORS["birthdays"], ids=lambda v: v["case"])
def test_birthday_vectors(vector):
    """INTENDED-RED for vectors with an expected birthday; CONTROL for null vectors."""
    expected = vector["expected"]
    want = None if expected is None else (expected["name"], expected["month"], expected["day"])
    assert birthdays.birthday_from_vcard(vector["vcard"]) == want


@pytest.mark.parametrize("vector", VECTORS["identity"], ids=lambda v: v["uid"])
def test_identity_vectors(vector):
    """INTENDED-RED: platform SHA-256 identity matches the shared vectors."""
    assert birthdays.birthday_event_uid(vector["bookUid"], vector["itemUid"]) == vector["uid"]


# ---------------------------------------------------------------------------
# SDK boundary fakes
# ---------------------------------------------------------------------------


def _response(data, *, stoken="token-1"):
    return MagicMock(data=list(data), done=True, stoken=stoken, iterator=None, removed_memberships=[])


def _sdk_collection(uid, col_type, *, content=b"", access=CollectionAccessLevel.Admin):
    collection = MagicMock(name=f"collection:{uid}")
    collection.uid = uid
    collection.collection_type = col_type
    collection.content = content
    collection.access_level = access
    collection.deleted = False
    collection.meta = {"name": uid}
    collection.item = MagicMock(name=f"root:{uid}")
    return collection


def _sdk_item(uid, content):
    item = MagicMock(name=f"item:{uid}")
    item.uid = uid
    item.content = content.encode("utf-8") if isinstance(content, str) else content
    item.deleted = False
    return item


class FakeAccount:
    """One account's collections, items and members, with every write recorded."""

    def __init__(self, collections, items, members):
        self.collections = collections
        self.items = items
        self.members = members
        self.created = []
        self.item_managers = {}
        self.col_mgr = MagicMock(name="collection-manager")
        self.col_mgr.list.side_effect = self._list_collections
        self.col_mgr.get_item_manager.side_effect = self._item_manager
        self.col_mgr.get_member_manager.side_effect = self._member_manager

    def get_collection_manager(self):
        return self.col_mgr

    def _list_collections(self, col_type, fetch_options=None):
        types = [col_type] if isinstance(col_type, str) else list(col_type)
        return _response(c for c in self.collections if c.collection_type in types)

    def _item_manager(self, collection):
        if collection.uid not in self.item_managers:
            manager = MagicMock(name=f"item-manager:{collection.uid}")
            manager.list.side_effect = lambda fetch_options=None, uid=collection.uid: _response(self.items.get(uid, []))

            def create(meta, content, uid=collection.uid):
                created = _sdk_item(f"created-{len(self.created) + 1}", content)
                self.created.append((uid, created))
                return created

            manager.create.side_effect = create
            self.item_managers[collection.uid] = manager
        return self.item_managers[collection.uid]

    def _member_manager(self, collection):
        manager = MagicMock(name=f"member-manager:{collection.uid}")
        manager.list.return_value = _response(
            [MagicMock(username=name) for name in self.members.get(collection.uid, [USERNAME])]
        )
        return manager

    def transactions(self, collection_uid):
        """Every ItemManager.transaction call for a collection as (items, deps), position or keyword."""
        manager = self.item_managers.get(collection_uid)
        if manager is None:
            return []
        calls = []
        for call in manager.transaction.call_args_list:
            items = call.kwargs.get("items", call.args[0] if call.args else None)
            deps = call.kwargs.get("deps", call.args[1] if len(call.args) > 1 else None)
            calls.append((list(items or []), list(deps or [])))
        return calls


def _semantic_fields(ics):
    """UID/DTSTART/DTEND/RRULE/SUMMARY as the shared contract compares them."""
    text = ics.decode("utf-8") if isinstance(ics, bytes) else ics
    lines = text.replace("\r\n ", "").replace("\n ", "").replace("\r\n\t", "").splitlines()
    found = {}
    in_event = False
    for line in lines:
        name_part, _, value = line.partition(":")
        name, *params = name_part.split(";")
        name = name.upper()
        if name == "BEGIN" and value.upper() == "VEVENT":
            in_event = True
            continue
        if not in_event or name in found:
            continue
        if name in ("DTSTART", "DTEND"):
            is_date = any(p.upper() == "VALUE=DATE" for p in params)
            found[name] = f"DATE:{value}" if is_date else value
        elif name == "SUMMARY":
            found[name] = value.replace("\\,", ",").replace("\\;", ";").replace("\\n", "\n").replace("\\\\", "\\")
        elif name in ("UID", "RRULE"):
            found[name] = value
    return {
        "uid": found.get("UID", ""),
        "dtstart": found.get("DTSTART", ""),
        "dtend": found.get("DTEND", ""),
        "rrule": found.get("RRULE", ""),
        "summary": found.get("SUMMARY", ""),
    }


BOOK = VECTORS["identity"][0]["bookUid"]
CONTACT = VECTORS["identity"][0]["itemUid"]
ALEX_VCARD = VECTORS["birthdays"][0]["vcard"]
ALEX_FIELDS = VECTORS["events"][0]["fields"]


def _account(calendar_content=ACTIVE, calendar_members=None, calendar_items=None):
    calendar = _sdk_collection("cal-birthdays", "etebase.vevent", content=calendar_content)
    book = _sdk_collection(BOOK, "etebase.vcard")
    members = {"cal-birthdays": calendar_members or [USERNAME], BOOK: [USERNAME]}
    items = {BOOK: [_sdk_item(CONTACT, ALEX_VCARD)], "cal-birthdays": calendar_items or []}
    return calendar, FakeAccount([calendar, book], items, members)


# ---------------------------------------------------------------------------
# Generator tracer
# ---------------------------------------------------------------------------


def test_generates_annual_all_day_event_fenced_on_the_calendar_root():
    """INTENDED-RED: one event from the fixture contact, written in one transaction whose
    dependency list is exactly the destination collection's root item (col.item)."""
    calendar, account = _account()

    birthdays.reconcile_birthdays(account, USERNAME)

    assert [(uid, _semantic_fields(item.content)) for uid, item in account.created] == [("cal-birthdays", ALEX_FIELDS)]
    created_items = [item for _, item in account.created]
    assert account.transactions("cal-birthdays") == [(created_items, [calendar.item])]
    assert account.transactions(BOOK) == []


def test_no_active_birthdays_calendar_writes_nothing():
    """CONTROL: without an active marked calendar the feature is off."""
    _, account = _account(calendar_content=b"")
    birthdays.reconcile_birthdays(account, USERNAME)
    assert account.created == []
    assert account.transactions("cal-birthdays") == []


def test_shared_birthdays_calendar_is_not_written():
    """CONTROL: a marked calendar with another current member is not a destination."""
    _, account = _account(calendar_members=[USERNAME, "bob@example.com"])
    birthdays.reconcile_birthdays(account, USERNAME)
    assert account.created == []
    assert account.transactions("cal-birthdays") == []


def test_turn_off_retires_first_then_removes_only_generated_items():
    """INTENDED-RED: the calendar root is updated to the retired marker before a fenced
    item transaction deletes only the generated birthday; the user's own event stays."""
    generated_ics = (
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:" + ALEX_FIELDS["uid"]
        + "\r\nDTSTART;VALUE=DATE:19720315\r\nDTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\n"
        + "SUMMARY:\U0001F382 Alex Example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    user_ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-event@example.com\r\nDTSTART;VALUE=DATE:20261031\r\nSUMMARY:Party\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    generated = _sdk_item("gen-1", generated_ics)
    user_event = _sdk_item("user-1", user_ics)
    calendar, account = _account(calendar_items=[generated, user_event])
    order = MagicMock()
    order.attach_mock(account.col_mgr.transaction, "retire")
    cal_manager = account._item_manager(calendar)
    order.attach_mock(cal_manager.transaction, "cleanup")

    birthdays.disable_birthdays(account, USERNAME)

    assert [c[0] for c in order.mock_calls if c[0] in ("retire", "cleanup")] == ["retire", "cleanup"]
    assert [list(c.args[:1]) for c in account.col_mgr.transaction.call_args_list] == [[calendar]]
    assert calendar.content == RETIRED
    assert account.transactions("cal-birthdays") == [([generated], [calendar.item])]
    generated.delete.assert_called_once()
    user_event.delete.assert_not_called()


# ---------------------------------------------------------------------------
# DAV read-only follows the active marker in the cached collection
# ---------------------------------------------------------------------------


def _cached_collection(mock_col_mgr, user, uid, content, access):
    remote = _make_mock_collection(uid, "etebase.vevent")
    remote.content = content
    remote.access_level = access
    cache_col = CollectionEntity.create(local_user=user, uid=uid, eb_col=mock_col_mgr.cache_save(remote))
    return Collection(mock_col_mgr, cache_col)


def test_active_birthdays_calendar_is_read_only_even_for_its_admin(mem_db, user, mock_col_mgr):
    """INTENDED-RED: DAV clients cannot write a generated calendar."""
    col = _cached_collection(mock_col_mgr, user, "cal-active", ACTIVE, CollectionAccessLevel.Admin)
    assert col.read_only is True


@pytest.mark.parametrize("content", [RETIRED, b"", b'{"type":"other","v":1,"state":"active"}'], ids=["retired", "ordinary", "foreign"])
def test_retired_or_ordinary_admin_calendar_stays_writable(mem_db, user, mock_col_mgr, content):
    """CONTROL: only an active marker makes a calendar read-only."""
    col = _cached_collection(mock_col_mgr, user, "cal-ordinary", content, CollectionAccessLevel.Admin)
    assert col.read_only is False


# ---------------------------------------------------------------------------
# Trigger: after a clean sync cycle, including an empty inventory
# ---------------------------------------------------------------------------


def _database(path):
    database = SqliteExtDatabase(str(path), pragmas={"foreign_keys": 1})
    db.database_proxy.initialize(database)
    database.create_tables([
        models.Config, models.User, models.CollectionEntity, models.ItemEntity, models.HrefMapper,
        models.DavChange, models.DavRevision, models.DavSyncToken, models.DavUnresolvedItem, models.SchemaMigration,
    ])
    models.Config.create(db_version=1)
    models.SchemaMigration.create(name="dav-revision-v1", applied_at=0)
    return database


def _service(database, user, manager):
    account = MagicMock()
    account.get_collection_manager.return_value = manager
    service = Etebase.__new__(Etebase)
    service.etebase = account
    service.username = user.username
    service._database = database
    service.stored_session = "fake"
    service.user = user
    service.sync_collection_list = MagicMock()
    service.push_collection = MagicMock()
    service.pull_collection = MagicMock()
    return service


def test_clean_sync_with_zero_address_books_requests_a_birthday_run(tmp_path, monkeypatch):
    """INTENDED-RED: an authoritative empty inventory is a successful cycle and must trigger."""
    database = _database(tmp_path / "birthdays-trigger.sqlite")
    user = models.User.create(username=USERNAME)
    service = _service(database, user, MagicMock())
    calls = []
    monkeypatch.setattr(birthdays, "reconcile_after_sync", lambda svc: calls.append(svc))

    service.sync()

    assert calls == [service]


def test_unresolved_dav_conflicts_do_not_trigger(tmp_path, monkeypatch):
    """CONTROL: a cycle that ends with unresolved conflicts is not a successful contact sync."""
    database = _database(tmp_path / "birthdays-unresolved.sqlite")
    user = models.User.create(username=USERNAME)
    manager = MagicMock()
    manager.cache_load.return_value = _make_mock_collection("contacts-1", "etebase.vcard")
    service = _service(database, user, manager)
    collection = models.CollectionEntity.create(local_user=user, uid="contacts-1", eb_col=b"contacts-1")
    models.DavUnresolvedItem.create(collection=collection, remote_uid="remote-1", eb_item=b"unresolved")
    calls = []
    monkeypatch.setattr(birthdays, "reconcile_after_sync", lambda svc: calls.append(svc))

    with pytest.raises(DavUnresolvedItemsError):
        service.sync()

    assert calls == []


def test_failed_collection_sync_does_not_trigger(tmp_path, monkeypatch):
    """CONTROL: a failed cycle never triggers generation."""
    database = _database(tmp_path / "birthdays-failed.sqlite")
    user = models.User.create(username=USERNAME)
    service = _service(database, user, MagicMock())
    service.sync_collection_list.side_effect = RuntimeError("server unavailable")
    calls = []
    monkeypatch.setattr(birthdays, "reconcile_after_sync", lambda svc: calls.append(svc))

    with pytest.raises(RuntimeError):
        service.sync()

    assert calls == []


def test_birthday_failure_does_not_fail_the_sync(tmp_path, monkeypatch):
    """CONTROL now (hook not yet called); must stay green once the hook is wired."""
    database = _database(tmp_path / "birthdays-isolated.sqlite")
    user = models.User.create(username=USERNAME)
    service = _service(database, user, MagicMock())

    def boom(_svc):
        raise RuntimeError("birthday failure")

    monkeypatch.setattr(birthdays, "reconcile_after_sync", boom)

    service.sync()


# ---------------------------------------------------------------------------
# Dashboard turn on / turn off (existing CSRF + local-access pattern)
# ---------------------------------------------------------------------------


def _post(body, csrf=True):
    from tests.test_web_dashboard import _post_environ

    raw = json.dumps(body).encode("utf-8")
    environ = _post_environ(raw, csrf_token=_dashboard_csrf_token if csrf else None)
    web = Web.__new__(Web)
    return web.post(environ, "", "/.web/api/accounts/birthdays", None)


@pytest.mark.parametrize("action", ["on", "off"])
def test_dashboard_turns_birthdays_on_and_off(monkeypatch, action):
    """INTENDED-RED: the route exists and hands the account and action to the generator."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)) or {"status": "done"})

    status, headers, body = _post({"username": USERNAME, "action": action})

    assert (status, json.loads(body)) == (200, {"ok": True, "status": "done"})
    assert calls == [(USERNAME, action)]


def test_dashboard_birthdays_requires_csrf(monkeypatch):
    """INTENDED-RED (route-specific): without the CSRF header the action is refused with 403."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)))

    status, _headers, body = _post({"username": USERNAME, "action": "on"}, csrf=False)

    assert (status, json.loads(body)["error"]) == (403, "Invalid dashboard CSRF token")
    assert calls == []


@pytest.mark.parametrize("body", [{"username": USERNAME, "action": "delete"}, {"action": "on"}])
def test_dashboard_birthdays_rejects_bad_requests(monkeypatch, body):
    """INTENDED-RED (route-specific 400): unknown action or missing account does nothing."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)))

    status, _headers, _body = _post(body)

    assert status == 400
    assert calls == []
