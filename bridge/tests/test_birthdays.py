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
from unittest.mock import MagicMock, PropertyMock

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
import silentsuite_bridge.web as web_module
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


def _response(data, *, stoken="token-1", done=True):
    return MagicMock(data=list(data), done=done, stoken=stoken, iterator=None, removed_memberships=[])


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

    def __init__(self, collections, items, members, *, inventory_done=True, incomplete=()):
        self.collections = collections
        self.items = items
        self.members = members
        self.inventory_done = inventory_done
        self.incomplete = set(incomplete)
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
        return _response((c for c in self.collections if c.collection_type in types), done=self.inventory_done)

    def _item_manager(self, collection):
        if collection.uid not in self.item_managers:
            manager = MagicMock(name=f"item-manager:{collection.uid}")
            manager.list.side_effect = lambda fetch_options=None, uid=collection.uid: _response(
                self.items.get(uid, []), done=uid not in self.incomplete
            )

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
# Checkpoint 2: fenced update, complete-source authority (SDK boundary)
#
# A listing page with done=False that repeats its stoken is an incomplete listing
# (as core listCollections treats a repeated stoken); it must never authorize a write.
# ---------------------------------------------------------------------------

ALEX_GENERATED_ICS = (
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:" + ALEX_FIELDS["uid"]
    + "\r\nDTSTART;VALUE=DATE:19720315\r\nDTEND;VALUE=DATE:19720316\r\nRRULE:FREQ=YEARLY\r\n"
    + "SUMMARY:\U0001F382 Alex Example\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)
ALEX_STALE_ICS = ALEX_GENERATED_ICS.replace("19720315", "19720314").replace("DTEND;VALUE=DATE:19720316", "DTEND;VALUE=DATE:19720315")


def test_stale_generated_event_is_rewritten_in_one_fenced_transaction():
    """INTENDED-RED (primary assertion: the missing fenced transaction): a stale generated event
    is updated in place, in one transaction whose deps are exactly [calendar.item]."""
    stale = _sdk_item("gen-1", ALEX_STALE_ICS)
    calendar, account = _account(calendar_items=[stale])

    birthdays.reconcile_birthdays(account, USERNAME)

    assert account.transactions("cal-birthdays") == [([stale], [calendar.item])]
    assert _semantic_fields(stale.content) == ALEX_FIELDS
    assert account.created == []


def test_last_address_book_removed_deletes_only_generated_events():
    """INTENDED-RED: a complete inventory with no address books is an empty source; the generated
    event is deleted (fenced), the user's own event and an unparseable item are kept."""
    generated = _sdk_item("gen-1", ALEX_GENERATED_ICS)
    user_event = _sdk_item("user-1", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-event@example.com\r\nDTSTART;VALUE=DATE:20261031\r\nSUMMARY:Party\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    garbage = _sdk_item("junk-1", "not a calendar")
    calendar = _sdk_collection("cal-birthdays", "etebase.vevent", content=ACTIVE)
    account = FakeAccount([calendar], {"cal-birthdays": [generated, user_event, garbage]}, {"cal-birthdays": [USERNAME]})

    birthdays.reconcile_birthdays(account, USERNAME)

    assert account.transactions("cal-birthdays") == [([generated], [calendar.item])]
    generated.delete.assert_called_once()
    user_event.delete.assert_not_called()
    garbage.delete.assert_not_called()


@pytest.mark.parametrize("failure", ["incomplete-inventory", "incomplete-book", "unreadable-contact"])
def test_partial_or_failed_source_reads_write_and_delete_nothing(failure):
    """CONTROL (passes on the neutral scaffold; must stay green): a partial or failed read is
    never treated as an absence, so the existing generated event survives."""
    generated = _sdk_item("gen-1", ALEX_STALE_ICS)
    calendar, account = _account(calendar_items=[generated])
    if failure == "incomplete-inventory":
        account.inventory_done = False
    elif failure == "incomplete-book":
        account.incomplete.add(BOOK)
    else:
        type(account.items[BOOK][0]).content = PropertyMock(side_effect=RuntimeError("decrypt"))

    birthdays.reconcile_birthdays(account, USERNAME)

    assert account.created == []
    assert account.transactions("cal-birthdays") == []
    generated.delete.assert_not_called()


# ---------------------------------------------------------------------------
# Checkpoint 2: pure event text and planner (shared vectors; scaffolds neutral)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["events"], ids=lambda v: v["case"])
def test_event_fields_vectors(vector):
    """INTENDED-RED: the fields a generated event must have."""
    assert birthdays.birthday_event_fields(vector["event"]) == vector["fields"]


@pytest.mark.parametrize("vector", VECTORS["events"], ids=lambda v: v["case"])
def test_event_text_variants_parse_to_fields(vector):
    """INTENDED-RED: every client's text variant parses to the same fields."""
    assert [birthdays.parse_birthday_event_fields(text) for text in vector["ics"]] == [vector["fields"]] * len(vector["ics"])


@pytest.mark.parametrize("vector", VECTORS["events"], ids=lambda v: v["case"])
def test_own_event_text_parses_back_folds_and_is_current(vector):
    """INTENDED-RED: Bridge's own output parses back, folds within 75 octets and counts as current."""
    content = birthdays.birthday_event_content(vector["event"])
    assert isinstance(content, str)
    assert birthdays.parse_birthday_event_fields(content) == vector["fields"]
    assert content.endswith("\r\n")
    assert [len(line.encode("utf-8")) <= 75 for line in content.split("\r\n")] == [True] * len(content.split("\r\n"))
    assert [birthdays.is_current_birthday_event(text, vector["event"]) for text in [content, *vector["ics"]]] == [True] * (1 + len(vector["ics"]))


@pytest.mark.parametrize("vector", VECTORS["eventMismatches"], ids=lambda v: v["case"])
def test_event_mismatches_are_not_current(vector):
    """CONTROL (neutral returns False): a renamed/moved/timed/non-yearly/non-event text is not current."""
    assert birthdays.is_current_birthday_event(vector["ics"], vector["event"]) is False


@pytest.mark.parametrize("vector", VECTORS["sources"], ids=lambda v: v["case"])
def test_source_vectors(vector):
    """INTENDED-RED: complete-source authority, including the authoritative empty inventory."""
    assert birthdays.birthday_events_from_source(vector["snapshot"]) == vector["expected"]


@pytest.mark.parametrize("vector", VECTORS["plans"], ids=lambda v: v["case"])
def test_plan_vectors(vector):
    """INTENDED-RED: canonical choice, duplicate retirement, generated-only cleanup, skips."""
    assert birthdays.plan_birthday_calendar(vector["events"], vector["calendars"]) == vector["expected"]


@pytest.mark.parametrize("vector", VECTORS["postChecks"], ids=lambda v: v["case"])
def test_post_check_vectors(vector):
    """INTENDED-RED: post-commit source check decides done, rerun (bounded) or pending."""
    assert birthdays.decide_after_birthday_run(vector["check"], vector["rerunsSoFar"]) == vector["decision"]


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


def _rights():
    from radicale.config import DEFAULT_CONFIG_SCHEMA, Configuration

    from silentsuite_bridge.radicale.rights import Rights

    configuration = Configuration(DEFAULT_CONFIG_SCHEMA)
    configuration.update({"auth": {"type": "silentsuite_bridge.radicale.auth"}}, source="test", privileged=True)
    return Rights(configuration)


@pytest.mark.parametrize("content, expected", [(ACTIVE, "r"), (RETIRED, "rw"), (b"", "rw")], ids=["active", "retired", "ordinary"])
def test_dav_rights_follow_the_cached_birthdays_marker(mem_db, user, mock_col_mgr, monkeypatch, content, expected):
    """CONTROL (expected to pass since stage 1's Collection.read_only): the real rights backend
    removes write for an active Birthdays calendar and keeps it for retired/ordinary ones."""
    from contextlib import contextmanager

    import silentsuite_bridge.radicale.rights as rights_module

    collection = _cached_collection(mock_col_mgr, user, "cal-x", content, CollectionAccessLevel.Admin)
    etesync = MagicMock()
    etesync.get.return_value = collection

    @contextmanager
    def fake_etesync_for_user(_user, exclusive=False):
        yield etesync, False

    monkeypatch.setattr(rights_module, "etesync_for_user", fake_etesync_for_user)

    assert _rights().authorization("user@example.com", "/user@example.com/cal-x") == expected


# ---------------------------------------------------------------------------
# Checkpoint 3: post-commit source freshness (SDK boundary, committing fake)
#
# The fake commits a transaction only when its deps are exactly the calendar's current
# root item (as the S0 server contract accepts); committed creates join the collection,
# committed deletes leave it, so later listings show what the server would hold.
# ---------------------------------------------------------------------------


class FakeRootConflict(Exception):
    """Test stand-in for the server rejecting a stale root dependency (no guessed SDK class)."""


def _committing(account, calendar, on_first_commit=None):
    manager = account._item_manager(calendar)
    commits = []

    def transaction(items, deps=None, fetch_options=None):
        deps = list(deps or [])
        if deps != [calendar.item]:
            raise FakeRootConflict("dependency is not the current calendar root")
        current = account.items.setdefault(calendar.uid, [])
        for item in items:
            if item.delete.called:
                current[:] = [entry for entry in current if entry is not item]
            elif all(entry is not item for entry in current):
                current.append(item)
        commits.append(list(items))
        if on_first_commit and len(commits) == 1:
            on_first_commit()

    manager.transaction.side_effect = transaction
    return commits


def test_contact_changed_while_writing_is_corrected_by_a_bounded_fresh_pass():
    """INTENDED-RED: A reads Alex's old birthday, B changes it, A commits; the post-commit check
    must lead to a fresh pass so the committed calendar ends with the NEW birthday, within the
    bounded number of reruns."""
    calendar, account = _account()
    new_vcard = ALEX_VCARD.replace("BDAY:1985-03-15", "BDAY:1985-04-20")

    def contact_changed_by_b():
        account.items[BOOK] = [_sdk_item(CONTACT, new_vcard)]

    commits = _committing(account, calendar, on_first_commit=contact_changed_by_b)

    birthdays.reconcile_birthdays(account, USERNAME)

    final = [_semantic_fields(item.content) for item in account.items["cal-birthdays"]]
    assert [(f["uid"], f["dtstart"]) for f in final] == [(ALEX_FIELDS["uid"], "DATE:19720420")]
    assert 1 <= len(commits) <= 1 + 2


# ---------------------------------------------------------------------------
# Checkpoint 4: retirement, root versions, uncertain outcomes, bounded churn
#
# _install_server mirrors the S0 root-fence acceptance on top of the committing fake:
# - a collection update (CollectionManager.transaction) gives the collection a NEW root
#   item object (a new root revision), as the server's root revision changes;
# - an item transaction commits only when deps are exactly the collection's CURRENT root,
#   otherwise FakeRootConflict (a test stand-in: the pinned SDK sources in evidence declare no
#   exception classes, so no SDK exception name is assumed);
# - committed creates join, committed deletes leave, so later listings show server state;
# - FakeLostResponse (stand-in) raises AFTER a commit, so the writer cannot know the outcome.
# ---------------------------------------------------------------------------


class FakeLostResponse(Exception):
    """Test stand-in: the server committed but the response never arrived."""


def _install_server(account, *, on_item_commit=None, lose_responses=0):
    item_commits = []
    collection_commits = []
    lost = {"left": lose_responses}

    def collection_transaction(collection, fetch_options=None):
        collection.item = MagicMock(name=f"root:{collection.uid}:v{len(collection_commits) + 2}")
        collection_commits.append((collection.uid, collection.content))

    account.col_mgr.transaction.side_effect = collection_transaction

    for collection in account.collections:
        if collection.collection_type != "etebase.vevent":
            continue
        manager = account._item_manager(collection)

        def transaction(items, deps=None, fetch_options=None, collection=collection):
            if list(deps or []) != [collection.item]:
                raise FakeRootConflict(f"stale root for {collection.uid}")
            current = account.items.setdefault(collection.uid, [])
            for item in items:
                if item.delete.called:
                    current[:] = [entry for entry in current if entry is not item]
                elif all(entry is not item for entry in current):
                    current.append(item)
            item_commits.append((collection.uid, list(items)))
            if on_item_commit:
                on_item_commit(len(item_commits))
            if lost["left"] > 0:
                lost["left"] -= 1
                raise FakeLostResponse("response lost after commit")

        manager.transaction.side_effect = transaction
    return item_commits, collection_commits


def _uids_in(account, collection_uid):
    return [_semantic_fields(item.content)["uid"] if _semantic_fields(item.content)["uid"] else item.uid
            for item in account.items.get(collection_uid, [])]


USER_EVENT_ICS = (
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:user-event@example.com\r\nDTSTART;VALUE=DATE:20261031\r\n"
    "SUMMARY:Party\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
)


def test_duplicate_active_calendar_is_retired_before_its_generated_items_are_cleaned():
    """INTENDED-RED: cal-A (smaller uid) stays canonical and receives the event; cal-B is retired
    first (root replaced), then only its generated item is deleted against the NEW root."""
    cal_a = _sdk_collection("cal-A", "etebase.vevent", content=ACTIVE)
    cal_b = _sdk_collection("cal-B", "etebase.vevent", content=ACTIVE)
    book = _sdk_collection(BOOK, "etebase.vcard")
    generated = _sdk_item("gen-b", ALEX_GENERATED_ICS)
    user_event = _sdk_item("user-b", USER_EVENT_ICS)
    account = FakeAccount(
        [cal_a, cal_b, book],
        {BOOK: [_sdk_item(CONTACT, ALEX_VCARD)], "cal-A": [], "cal-B": [generated, user_event]},
        {"cal-A": [USERNAME], "cal-B": [USERNAME], BOOK: [USERNAME]},
    )
    old_root_b = cal_b.item
    item_commits, collection_commits = _install_server(account)

    birthdays.reconcile_birthdays(account, USERNAME)

    assert collection_commits == [("cal-B", RETIRED)]
    assert cal_b.item is not old_root_b
    assert _uids_in(account, "cal-B") == ["user-event@example.com"]
    assert _uids_in(account, "cal-A") == [ALEX_FIELDS["uid"]]
    assert [uid for uid, _ in item_commits].count("cal-B") == 1
    user_event.delete.assert_not_called()


def test_interrupted_retirement_is_repaired_on_the_next_run():
    """INTENDED-RED: a calendar already retired (crash before cleanup) loses only its generated
    item on the next run; it is not retired again and the user's event stays."""
    cal_a = _sdk_collection("cal-A", "etebase.vevent", content=ACTIVE)
    cal_r = _sdk_collection("cal-R", "etebase.vevent", content=RETIRED)
    book = _sdk_collection(BOOK, "etebase.vcard")
    leftover = _sdk_item("gen-r", ALEX_GENERATED_ICS)
    user_event = _sdk_item("user-r", USER_EVENT_ICS)
    account = FakeAccount(
        [cal_a, cal_r, book],
        {BOOK: [_sdk_item(CONTACT, ALEX_VCARD)], "cal-A": [], "cal-R": [leftover, user_event]},
        {"cal-A": [USERNAME], "cal-R": [USERNAME], BOOK: [USERNAME]},
    )
    item_commits, collection_commits = _install_server(account)

    birthdays.reconcile_birthdays(account, USERNAME)

    assert collection_commits == []
    assert _uids_in(account, "cal-R") == ["user-event@example.com"]
    assert _uids_in(account, "cal-A") == [ALEX_FIELDS["uid"]]


def test_calendar_retired_by_another_client_mid_run_gets_no_generated_items():
    """CONTROL (no writes under the neutral scaffold; must stay green): another client retires the
    calendar (new root) after this run listed it; a write fenced on the old root is rejected and
    the run must not put generated items into the now-retired calendar."""
    calendar, account = _account()
    _install_server(account)
    manager = account._item_manager(calendar)
    listed = {"count": 0}
    original_list = manager.list.side_effect

    def list_then_retire(fetch_options=None):
        response = original_list(fetch_options)
        listed["count"] += 1
        if listed["count"] == 1:
            calendar.content = RETIRED
            calendar.item = MagicMock(name="root:cal-birthdays:retired-by-other-client")
        return response

    manager.list.side_effect = list_then_retire

    birthdays.reconcile_birthdays(account, USERNAME)

    assert [f for f in (_semantic_fields(i.content) for i in account.items["cal-birthdays"]) if f["uid"].startswith("ss-bday1-")] == []


def test_lost_response_is_followed_by_a_fresh_read_not_a_blind_resend():
    """INTENDED-RED: the create commits but its response is lost; the run must re-read and end
    with exactly ONE Alex event, never a duplicate from resending the create."""
    calendar, account = _account()
    item_commits, _ = _install_server(account, lose_responses=1)

    birthdays.reconcile_birthdays(account, USERNAME)

    assert _uids_in(account, "cal-birthdays") == [ALEX_FIELDS["uid"]]
    assert len(item_commits) == 1


def test_endless_source_churn_stops_after_the_bounded_reruns_as_pending():
    """INTENDED-RED: the contact changes after every commit; the run stops within 1 + 2 commits
    and reports pending (never done, never an unbounded loop)."""
    calendar, account = _account()
    dates = iter(["1985-04-20", "1985-05-21", "1985-06-22", "1985-07-23", "1985-08-24"])

    def churn(_count):
        account.items[BOOK] = [_sdk_item(CONTACT, ALEX_VCARD.replace("BDAY:1985-03-15", "BDAY:" + next(dates)))]

    item_commits, _ = _install_server(account, on_item_commit=churn)

    result = birthdays.reconcile_birthdays(account, USERNAME)

    assert 1 <= len(item_commits) <= 3
    assert result.get("status") == "pending"


def test_failed_post_commit_check_reports_pending_and_keeps_the_commit():
    """INTENDED-RED: the source re-check after a commit fails; the committed event stays and the
    run reports pending, not done."""
    calendar, account = _account()
    book_manager = account._item_manager(account.collections[1])
    calls = {"count": 0}
    original = book_manager.list.side_effect

    def fail_after_first(fetch_options=None):
        calls["count"] += 1
        if calls["count"] > 1:
            raise RuntimeError("network down during re-check")
        return original(fetch_options)

    book_manager.list.side_effect = fail_after_first
    _install_server(account)

    result = birthdays.reconcile_birthdays(account, USERNAME)

    assert _uids_in(account, "cal-birthdays") == [ALEX_FIELDS["uid"]]
    assert result.get("status") == "pending"


def test_birthday_hook_runs_outside_any_cache_transaction(tmp_path, monkeypatch):
    """CONTROL (boundary, expected green since stage 1): remote I/O started by the hook must never
    run inside a SQLite/cache transaction. The existing per-account sync serialization is not
    changed or asserted against here."""
    database = _database(tmp_path / "birthdays-no-transaction.sqlite")
    user = models.User.create(username=USERNAME)
    service = _service(database, user, MagicMock())
    seen = []
    monkeypatch.setattr(birthdays, "reconcile_after_sync", lambda svc: seen.append(database.in_transaction()))

    service.sync()

    assert seen == [False]


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


def _post(body, csrf=True, path="/.web/api/accounts/birthdays"):
    from tests.test_web_dashboard import _post_environ

    raw = json.dumps(body).encode("utf-8")
    environ = _post_environ(raw, csrf_token=_dashboard_csrf_token if csrf else None)
    web = Web.__new__(Web)
    return web.post(environ, "", path, None)


def test_dashboard_fixture_reaches_an_existing_csrf_protected_route(monkeypatch):
    """CONTROL: the same POST/local-access/CSRF fixture works on the existing /.web/api/sync route,
    so a failure of the birthdays route below is about the route, not the fixture."""
    from silentsuite_bridge import accounts
    from silentsuite_bridge.radicale import storage

    status, _headers, body = _post({}, csrf=False, path="/.web/api/sync")
    assert status == 403
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"

    web_module._sync_requests.clear()
    monkeypatch.setattr(accounts, "list_accounts", lambda: [USERNAME])
    thread = MagicMock()
    thread.is_alive.return_value = True
    thread.force_sync.return_value = 1
    thread.generation_status.return_value = {
        "generation": 1, "state": "pending", "started_at": None, "completed_at": None, "error_code": None,
    }
    monkeypatch.setattr(storage, "_sync_threads", {USERNAME: thread})
    status, _headers, body = _post({}, path="/.web/api/sync")
    assert status == 202
    assert json.loads(body)["ok"] is True


@pytest.mark.parametrize("action", ["on", "off"])
def test_dashboard_turns_birthdays_on_and_off(monkeypatch, action):
    """INTENDED-RED: the route exists and hands the account and action to the generator."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)) or {"status": "done"})

    status, _headers, body = _post({"username": USERNAME, "action": action})

    assert status == 200
    assert json.loads(body) == {"ok": True, "status": "done"}
    assert calls == [(USERNAME, action)]


def test_dashboard_birthdays_requires_csrf(monkeypatch):
    """INTENDED-RED (route-specific): without the CSRF header the action is refused with 403."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)))

    status, _headers, body = _post({"username": USERNAME, "action": "on"}, csrf=False)

    assert status == 403
    assert json.loads(body)["error"] == "Invalid dashboard CSRF token"
    assert calls == []


@pytest.mark.parametrize("result, http, payload", [
    ({"status": "skipped", "reason": "offline"}, 200, {"ok": False, "status": "skipped"}),
    ({"status": "pending", "reason": "post-check"}, 200, {"ok": False, "status": "pending"}),
    ({"status": "unexpected"}, 200, {"ok": False, "status": "failed"}),
    (None, 200, {"ok": False, "status": "failed"}),
])
def test_dashboard_birthdays_reports_the_result_truthfully(monkeypatch, result, http, payload):
    """CHARACTERIZATION (written with the admitted route in stage 2; not a RED): a result other
    than done is never reported as completed."""
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: result)

    status, _headers, body = _post({"username": USERNAME, "action": "on"})

    assert status == http
    assert json.loads(body) == payload


def test_dashboard_birthdays_failure_is_reported_without_details(monkeypatch):
    """CHARACTERIZATION (stage 2, with the route): an exception becomes a failed result."""
    def boom(username, act):
        raise RuntimeError("private detail " + username)

    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", boom)

    status, _headers, body = _post({"username": USERNAME, "action": "off"})

    assert status == 500
    assert json.loads(body) == {"ok": False, "status": "failed"}
    assert USERNAME not in body if isinstance(body, str) else USERNAME.encode() not in body


@pytest.mark.parametrize("body", [{"username": USERNAME, "action": "delete"}, {"action": "on"}])
def test_dashboard_birthdays_rejects_bad_requests(monkeypatch, body):
    """INTENDED-RED (route-specific 400): unknown action or missing account does nothing."""
    calls = []
    monkeypatch.setattr(birthdays, "set_dashboard_birthdays", lambda username, act: calls.append((username, act)))

    status, _headers, _body = _post(body)

    assert status == 400
    assert calls == []
