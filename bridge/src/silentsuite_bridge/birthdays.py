"""Generated Birthdays calendar for SilentSuite Bridge (#738).

Shared contract: contracts/birthday-calendar/v1-vectors.json (also implemented by
packages/core for web and by the Android client).

Implemented: marker parsing, contact birthdays, event identity, the active-marker
check behind DAV read-only, the pure event/source/planner/post-check helpers, the SDK
engine (reconcile_birthdays, enable_birthdays, disable_birthdays), the post-sync
service hook (reconcile_after_sync) and the dashboard entry point
(set_dashboard_birthdays). Tests run against stateful SDK fakes; real Python SDK
transport and post-check token semantics are not proven by them.
"""

import hashlib
import json
import logging
import re
import threading
import time
from datetime import date, timedelta

from etebase import CollectionAccessLevel, FetchOptions

from .privacy_logging import bounded_exception_class

MARKER_TYPE = "silentsuite.birthdays"
EVENT_UID_PREFIX = "ss-bday1-"
SKIPPED = {"status": "skipped", "reason": "not-implemented"}


def _as_text(content):
    """Collection/item content as text, or None when it is not readable UTF-8 text."""
    if isinstance(content, (bytes, bytearray)):
        try:
            return bytes(content).decode("utf-8")
        except UnicodeDecodeError:
            return None
    if isinstance(content, str):
        return content
    return None


def parse_birthday_marker(content):
    """'active' or 'retired' for a Birthdays calendar's collection content; None otherwise."""
    text = _as_text(content)
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if not isinstance(parsed, dict):
        return None
    version = parsed.get("v")
    # The contract's v is the integer 1 (never "1" or true).
    if parsed.get("type") != MARKER_TYPE or type(version) is not int or version != 1:
        return None
    state = parsed.get("state")
    return state if state in ("active", "retired") else None


# ── Contact birthdays ──

_YEARLESS = re.compile(r"^--(\d{2})-?(\d{2})$")
_DATED = re.compile(r"^(\d{4})-?(\d{2})-?(\d{2})(?:T[0-9:.,+\-Z]*)?$")
_DAYS = [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]


def _is_leap(year):
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def _existing_month_day(year, month, day):
    """(month, day) when it exists in `year`, or for a year-less date in some year."""
    if month < 1 or month > 12 or day < 1:
        return None
    days = (29 if year is None or _is_leap(year) else 28) if month == 2 else _DAYS[month - 1]
    return (month, day) if day <= days else None


def _unescape(value):
    return re.sub(r"\\(.)", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _split_unescaped(value, separator):
    return re.split(r"(?<!\\)" + re.escape(separator), value)


def _properties(vcard_text):
    """(NAME, {PARAM: value}, raw value) for each unfolded content line."""
    unfolded = re.sub(r"\r\n[ \t]|\n[ \t]", "", vcard_text)
    for line in unfolded.splitlines():
        quoted = False
        colon = -1
        for index, char in enumerate(line):
            if char == '"':
                quoted = not quoted
            elif char == ":" and not quoted:
                colon = index
                break
        if colon < 0:
            continue
        head, value = line[:colon], line[colon + 1:]
        parts = head.split(";")
        name = parts[0].split(".")[-1].strip().upper()
        params = {}
        for part in parts[1:]:
            key, _, param_value = part.partition("=")
            params[key.strip().upper()] = param_value.strip().strip('"')
        yield name, params, value


def _normalize_birthday(value, params):
    if any(t.strip().lower() == "text" for t in params.get("VALUE", "").split(",")):
        return None
    text = value.strip()
    if not text:
        return None
    match = _YEARLESS.match(text)
    if match:
        return _existing_month_day(None, int(match.group(1)), int(match.group(2)))
    match = _DATED.match(text)
    if match:
        year = match.group(1)
        # A year named by X-APPLE-OMIT-YEAR is not a birth year: validate as year-less.
        effective_year = None if params.get("X-APPLE-OMIT-YEAR") == year else int(year)
        return _existing_month_day(effective_year, int(match.group(2)), int(match.group(3)))
    return None


def birthday_from_vcard(vcard_text):
    """(name, month, day) a contact's birthday event gets, or None when it gets none."""
    if not isinstance(vcard_text, str):
        vcard_text = _as_text(vcard_text)
        if vcard_text is None:
            return None
    formatted = None
    structured = None
    bday = None
    for name, params, value in _properties(vcard_text):
        if name == "FN" and formatted is None:
            formatted = _unescape(value).strip()
        elif name == "N" and structured is None:
            structured = value
        elif name == "BDAY" and bday is None:
            bday = (value, params)
    display = formatted or ""
    if not display and structured is not None:
        components = [_unescape(part).strip() for part in _split_unescaped(structured, ";")]
        family = components[0] if len(components) > 0 else ""
        given = components[1] if len(components) > 1 else ""
        display = " ".join(part for part in (given, family) if part)
    if not display or bday is None:
        return None
    month_day = _normalize_birthday(*bday)
    return (display, month_day[0], month_day[1]) if month_day else None


def birthday_event_uid(book_uid, item_uid):
    """Event UID from the Etebase address-book and item uids (never the vCard UID)."""
    digest = hashlib.sha256(f"{book_uid}/{item_uid}".encode("utf-8")).hexdigest()
    return EVENT_UID_PREFIX + digest[:32]


def is_managed_collection(collection):
    """Whether an SDK collection's own content marks it as an active Birthdays calendar."""
    try:
        content = collection.content
    except Exception:  # noqa: BLE001 - unreadable content is never treated as managed
        return False
    return parse_birthday_marker(content) == "active"


def is_generated_birthday_uid(uid):
    """Whether an event UID has the generated Birthdays form."""
    return isinstance(uid, str) and re.fullmatch(r"ss-bday1-[0-9a-f]{32}", uid) is not None


# ── Pure event and planner helpers (contract: events, sources, plans, postChecks) ──
#
# Events and plans are plain dicts with the contract's camelCase keys, so they compare
# directly with the shared vectors. Plans are data only: nothing here touches the SDK.

ANCHOR_YEAR = 1972  # leap year, so Feb 29 exists; never shown as a birth year
LAST_DAY_OF_FEBRUARY = "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1"
MAX_RERUNS = 2
_FIELDS = ("uid", "dtstart", "dtend", "rrule", "summary")


def birthday_event_fields(event):
    """Comparable fields a generated event must have: all-day on the anchor date, exclusive end."""
    start = date(ANCHOR_YEAR, event["month"], event["day"])
    end = start + timedelta(days=1)
    leap_day = event["month"] == 2 and event["day"] == 29
    return {
        "uid": event["uid"],
        "dtstart": "DATE:" + start.strftime("%Y%m%d"),
        "dtend": "DATE:" + end.strftime("%Y%m%d"),
        "rrule": LAST_DAY_OF_FEBRUARY if leap_day else "FREQ=YEARLY",
        "summary": "\U0001F382 " + event["name"],
    }


def _escape_text(value):
    value = value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return re.sub(r"\r\n|\r|\n", "\\\\n", value)


def _unescape_text(value):
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


def _fold(line):
    """RFC 5545 folding: lines of at most 75 octets, never splitting a character."""
    lines, current, octets = [], "", 0
    for char in line:
        size = len(char.encode("utf-8"))
        if octets + size > 75:
            lines.append(current)
            current, octets = " ", 1
        current += char
        octets += size
    lines.append(current)
    return "\r\n".join(lines)


def birthday_event_content(event):
    """The iCalendar text Bridge writes for a birthday event (CRLF, folded, escaped)."""
    fields = birthday_event_fields(event)
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//SilentSuite//Birthdays v1//EN",
        "BEGIN:VEVENT",
        "UID:" + fields["uid"],
        f"DTSTAMP:{ANCHOR_YEAR}0101T000000Z",
        "DTSTART;VALUE=DATE:" + fields["dtstart"][len("DATE:"):],
        "DTEND;VALUE=DATE:" + fields["dtend"][len("DATE:"):],
        "RRULE:" + fields["rrule"],
        "SUMMARY:" + _escape_text(fields["summary"]),
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def _content_line(line):
    """(NAME, [params], value) of a content line; quoted parameters may contain ':'."""
    quoted = False
    for index, char in enumerate(line):
        if char == '"':
            quoted = not quoted
        elif char == ":" and not quoted:
            name, *params = line[:index].split(";")
            return name.upper(), params, line[index + 1:]
    return None


def parse_birthday_event_fields(ics):
    """Comparable fields of the first VEVENT, or None without a VEVENT UID."""
    text = _as_text(ics)
    if text is None:
        return None
    lines = re.split(r"\r?\n", re.sub(r"\r?\n[ \t]", "", text))
    found = {}
    in_event = False
    nested = 0
    for line in lines:
        prop = _content_line(line)
        if prop is None:
            continue
        name, params, raw = prop
        value = raw.strip()
        if not in_event:
            if name == "BEGIN" and value.upper() == "VEVENT":
                in_event = True
            continue
        if name == "BEGIN":
            nested += 1
            continue
        if name == "END":
            if nested == 0:
                break
            nested -= 1
            continue
        if nested > 0 or name not in ("UID", "DTSTART", "DTEND", "RRULE", "SUMMARY") or name in found:
            continue
        is_date = any(param.upper() == "VALUE=DATE" for param in params)
        if name == "SUMMARY":
            found[name] = _unescape_text(raw)
        elif name in ("DTSTART", "DTEND") and is_date:
            found[name] = "DATE:" + value
        else:
            found[name] = value
    if not found.get("UID"):
        return None
    return {
        "uid": found["UID"],
        "dtstart": found.get("DTSTART", ""),
        "dtend": found.get("DTEND", ""),
        "rrule": found.get("RRULE", ""),
        "summary": found.get("SUMMARY", ""),
    }


def is_current_birthday_event(ics, event):
    """Whether stored iCalendar text already means exactly this event (by meaning, not bytes)."""
    stored = parse_birthday_event_fields(ics)
    if stored is None:
        return False
    expected = birthday_event_fields(event)
    return all(stored[key] == expected[key] for key in _FIELDS)


def birthday_events_from_source(snapshot):
    """Desired events from a complete source; absence is never inferred from a partial read."""
    if not snapshot.get("inventoryComplete"):
        return {"ok": False, "reason": "incomplete-inventory"}
    books = snapshot.get("books", [])
    if any(not book.get("complete") for book in books):
        return {"ok": False, "reason": "incomplete-book"}
    if any(item.get("content") is None for book in books for item in book.get("items", [])):
        return {"ok": False, "reason": "unreadable-contact"}
    events = []
    for book in books:
        for item in book.get("items", []):
            birthday = birthday_from_vcard(item["content"])
            if birthday:
                name, month, day = birthday
                events.append({
                    "uid": birthday_event_uid(book["bookUid"], item["itemUid"]),
                    "name": name,
                    "month": month,
                    "day": day,
                })
    events.sort(key=lambda event: event["uid"])
    return {"ok": True, "events": events}


def _generated_items(items):
    """Generated items by event UID, each group ordered by item uid (the first is kept)."""
    groups = {}
    for item in items:
        if item.get("content") is None:
            continue
        fields = parse_birthday_event_fields(item["content"])
        if fields is None or not is_generated_birthday_uid(fields["uid"]):
            continue
        groups.setdefault(fields["uid"], []).append(item)
    for group in groups.values():
        group.sort(key=lambda item: item["itemUid"])
    return groups


def _cleanup_of(calendar):
    """Generated item uids of a completely and readably listed calendar; none otherwise."""
    items = calendar.get("items", [])
    if not calendar.get("complete") or any(item.get("content") is None for item in items):
        return []
    return sorted(item["itemUid"] for group in _generated_items(items).values() for item in group)


def plan_birthday_calendar(events, calendars):
    """What to write so the calendars hold exactly `events`.

    Only writable calendars count; the active one with the smallest uid is canonical,
    other active ones are retired, and retired ones lose their generated items. Items
    that are not generated are never touched.
    """
    writable = sorted((c for c in calendars if c.get("writable")), key=lambda c: c["uid"])
    active = [c for c in writable if c.get("state") == "active"]
    canonical = active[0] if active else None
    plan = {
        "canonical": canonical["uid"] if canonical else None,
        "create": [],
        "update": [],
        "remove": [],
        "retire": [c["uid"] for c in active[1:]],
        "cleanup": [],
    }
    for calendar in writable:
        if calendar is canonical:
            continue
        item_uids = _cleanup_of(calendar)
        if item_uids:
            plan["cleanup"].append({"calendarUid": calendar["uid"], "itemUids": item_uids})
    if canonical is None:
        return {"kind": "plan", "plan": plan}
    if not canonical.get("complete"):
        return {"kind": "skip", "reason": "incomplete-calendar"}
    if any(item.get("content") is None for item in canonical.get("items", [])):
        return {"kind": "skip", "reason": "unreadable-calendar-item"}

    wanted = {event["uid"]: event for event in events}
    existing = _generated_items(canonical.get("items", []))
    for uid, (kept, *extra) in existing.items():
        plan["remove"].extend(item["itemUid"] for item in extra)
        event = wanted.get(uid)
        if event is None:
            plan["remove"].append(kept["itemUid"])
        elif not is_current_birthday_event(kept["content"], event):
            plan["update"].append({"itemUid": kept["itemUid"], "event": event})
    plan["create"] = sorted((e for uid, e in wanted.items() if uid not in existing), key=lambda e: e["uid"])
    plan["update"].sort(key=lambda change: change["itemUid"])
    plan["remove"].sort()
    return {"kind": "plan", "plan": plan}


def decide_after_birthday_run(check, reruns_so_far):
    """'done', 'rerun' (bounded) or 'pending' after a committed run's source re-check."""
    if not check.get("complete"):
        return "pending"
    if not check.get("inventoryChanged") and not check.get("changedBooks"):
        return "done"
    return "rerun" if reruns_so_far < MAX_RERUNS else "pending"


# ── SDK engine (pinned etebase 0.31.5) ──
#
# Every run reads everything fresh and completely, plans with the pure helpers, and writes
# each calendar's changes in transactions whose only dependency is that calendar's root
# item AS READ (re-taken only after this run's own collection commit). Any write error is
# treated as an unknown outcome: nothing is retried blindly, the next attempt re-reads.

CALENDAR_TYPE = "etebase.vevent"
ADDRESS_BOOK_TYPE = "etebase.vcard"
MAX_RESTARTS = 2
MAX_PAGES = 1000
CHUNK = 50
_logger = logging.getLogger("silentsuite-bridge.birthdays")


def marker_content(state):
    """Collection content that marks a Birthdays calendar (contract byte form)."""
    return json.dumps({"type": MARKER_TYPE, "v": 1, "state": state}, separators=(",", ":")).encode("utf-8")


class _Incomplete(Exception):
    """A listing did not finish; never evidence that something is absent."""


def _options(stoken=None, iterator=None):
    if stoken is None and iterator is None:
        return None
    options = FetchOptions()
    if stoken is not None:
        options.stoken(stoken)
    if iterator is not None:
        options.iterator(iterator)
    return options


def _list_pages(fetch, stoken=None):
    """All entries from a stoken-paged listing, and the final stoken. Raises _Incomplete."""
    entries = []
    token = stoken
    for _ in range(MAX_PAGES):
        response = fetch(_options(stoken=token))
        entries.extend(list(response.data))
        next_token = response.stoken
        if response.done:
            return entries, next_token
        if next_token is None or next_token == token:
            raise _Incomplete("listing made no progress")
        token = next_token
    raise _Incomplete("listing exceeded its page limit")


def _list_members(member_manager):
    usernames = []
    iterator = None
    for _ in range(MAX_PAGES):
        response = member_manager.list(_options(iterator=iterator))
        usernames.extend(member.username for member in response.data)
        if response.done:
            return usernames
        next_iterator = response.iterator
        if next_iterator is None or next_iterator == iterator:
            raise _Incomplete("member listing made no progress")
        iterator = next_iterator
    raise _Incomplete("member listing exceeded its page limit")


def _read_content(entry):
    """Readable text content of an SDK collection or item, or None."""
    try:
        return _as_text(entry.content)
    except Exception:  # noqa: BLE001 - unreadable is reported as None, never as empty
        return None


def _read_state(col_mgr, username, *, with_source=True):
    """Fresh, complete snapshot of calendars, address books and memberships.

    Returns (state, None) or (None, reason). Marked Admin calendars need a complete member
    list; a calendar is writable only when that list is exactly `username`.
    """
    try:
        collections, inventory_token = _list_pages(
            lambda options: col_mgr.list([CALENDAR_TYPE, ADDRESS_BOOK_TYPE], options))
    except _Incomplete:
        return None, "incomplete-inventory"
    calendars = {}
    books = {}
    for collection in collections:
        if collection.deleted:
            continue
        if collection.collection_type == ADDRESS_BOOK_TYPE:
            books[collection.uid] = collection
            continue
        if collection.collection_type != CALENDAR_TYPE:
            continue
        content = _read_content(collection)
        if content is None:
            return None, "unreadable-calendar"
        marker = parse_birthday_marker(content)
        if marker is None:
            continue  # ordinary or unmarked calendars are never adopted
        writable = False
        if collection.access_level == CollectionAccessLevel.Admin:
            try:
                members = _list_members(col_mgr.get_member_manager(collection))
            except _Incomplete:
                return None, "incomplete-members"
            writable = members == [username]
        calendars[collection.uid] = {"collection": collection, "root": collection.item, "state": marker,
                                     "writable": writable, "items": {}, "complete": True}

    for entry in calendars.values():
        if not entry["writable"]:
            continue
        item_mgr = col_mgr.get_item_manager(entry["collection"])
        try:
            items, _ = _list_pages(item_mgr.list)
        except _Incomplete:
            entry["complete"] = False
            continue
        entry["items"] = {item.uid: item for item in items if not item.deleted}

    source = {"inventoryComplete": True, "books": []}
    book_tokens = {}
    book_contents = {}
    if with_source:
        for uid, book in books.items():
            item_mgr = col_mgr.get_item_manager(book)
            try:
                items, token = _list_pages(item_mgr.list)
            except _Incomplete:
                source["books"].append({"bookUid": uid, "complete": False, "items": []})
                continue
            live = [item for item in items if not item.deleted]
            contents = {item.uid: _read_content(item) for item in live}
            source["books"].append({"bookUid": uid, "complete": True,
                                    "items": [{"itemUid": k, "content": v} for k, v in contents.items()]})
            book_tokens[uid] = token
            book_contents[uid] = contents
    return {
        "calendars": calendars,
        "books": books,
        "source": source,
        "inventory_token": inventory_token,
        "book_tokens": book_tokens,
        "book_contents": book_contents,
    }, None


def _planner_calendars(state):
    return [{
        "uid": uid,
        "state": entry["state"],
        "writable": entry["writable"],
        "complete": entry["complete"],
        "items": [{"itemUid": item_uid, "content": _read_content(item)} for item_uid, item in entry["items"].items()],
    } for uid, entry in state["calendars"].items()]


def _commit(item_mgr, items, root):
    for start in range(0, len(items), CHUNK):
        item_mgr.transaction(items[start:start + CHUNK], [root])


def _retire(col_mgr, entry, written):
    collection = entry["collection"]
    collection.content = marker_content("retired")
    # Recorded before the write: an uncertain write still needs a cache refresh.
    written.add(collection.uid)
    col_mgr.transaction(collection)
    # This run's own commit: the calendar's new root is the one later writes must name.
    entry["root"] = collection.item
    entry["state"] = "retired"


def _delete_items(col_mgr, entry, item_uids, written):
    items = [entry["items"][uid] for uid in item_uids if uid in entry["items"]]
    if not items:
        return
    for item in items:
        item.delete()
    written.add(entry["collection"].uid)
    _commit(col_mgr.get_item_manager(entry["collection"]), items, entry["root"])


def _new_meta(event_uid):
    return {"name": event_uid, "mtime": int(time.time() * 1000)}


def _apply(col_mgr, state, plan, written):
    """Write a plan; each touched calendar uid joins `written` before its write.

    Returns True when anything was written. Raises on any write error.
    """
    wrote = False
    calendars = state["calendars"]
    for uid in plan["retire"]:
        _retire(col_mgr, calendars[uid], written)
        wrote = True
    for cleanup in plan["cleanup"]:
        _delete_items(col_mgr, calendars[cleanup["calendarUid"]], cleanup["itemUids"], written)
        wrote = True
    canonical = calendars.get(plan["canonical"]) if plan["canonical"] else None
    if canonical is None:
        return wrote
    item_mgr = col_mgr.get_item_manager(canonical["collection"])
    changed = []
    for change in plan["update"]:
        item = canonical["items"][change["itemUid"]]
        item.content = birthday_event_content(change["event"]).encode("utf-8")
        changed.append(item)
    for item_uid in plan["remove"]:
        item = canonical["items"][item_uid]
        item.delete()
        changed.append(item)
    for event in plan["create"]:
        changed.append(item_mgr.create(_new_meta(event["uid"]), birthday_event_content(event).encode("utf-8")))
    if changed:
        written.add(canonical["collection"].uid)
        _commit(item_mgr, changed, canonical["root"])
        wrote = True
    return wrote


def _result(status, written, reason=None, **extra):
    result = {"status": status, "written": sorted(written)}
    if reason is not None:
        result["reason"] = reason
    result.update(extra)
    return result


def _post_check(col_mgr, state):
    """Did the source change since this run read it? (contract `postChecks` input)."""
    check = {"complete": False, "inventoryChanged": False, "changedBooks": []}
    try:
        changes, _ = _list_pages(
            lambda options: col_mgr.list([CALENDAR_TYPE, ADDRESS_BOOK_TYPE], options),
            stoken=state["inventory_token"])
        for collection in changes:
            if collection.collection_type != ADDRESS_BOOK_TYPE:
                continue
            if collection.deleted or collection.uid not in state["books"]:
                check["inventoryChanged"] = True
        for uid, book in state["books"].items():
            known = state["book_contents"].get(uid)
            if known is None:
                check["changedBooks"].append(uid)
                continue
            item_changes, _ = _list_pages(col_mgr.get_item_manager(book).list, stoken=state["book_tokens"].get(uid))
            for item in item_changes:
                if item.deleted or item.uid not in known or _read_content(item) != known[item.uid]:
                    check["changedBooks"].append(uid)
                    break
    except Exception:  # noqa: BLE001 - a failed check is incomplete, never "unchanged"
        return check
    check["complete"] = True
    return check


def reconcile_birthdays(account, username):
    """Fresh-read reconcile of the generated calendar for one account. Never raises.

    Returns {"status": "done" | "skipped" | "pending" | "failed", "written": [...], ...}; only
    "done" means the calendar matched the source at the end of the run. "written" lists every
    calendar uid this call wrote or may have written (an uncertain write counts), across retries.
    """
    written = set()
    try:
        col_mgr = account.get_collection_manager()
        reruns = 0
        restarts = 0
        while True:
            state, reason = _read_state(col_mgr, username)
            if state is None:
                return _result("skipped", written, reason)
            source = birthday_events_from_source(state["source"])
            if not source["ok"]:
                return _result("skipped", written, source["reason"])
            planned = plan_birthday_calendar(source["events"], _planner_calendars(state))
            if planned["kind"] == "skip":
                return _result("skipped", written, planned["reason"])
            try:
                wrote = _apply(col_mgr, state, planned["plan"], written)
            except Exception as exc:  # noqa: BLE001 - unknown outcome: re-read, never resend blindly
                _logger.info("Birthdays write outcome unknown (%s)", bounded_exception_class(exc))
                if restarts >= MAX_RESTARTS:
                    return _result("pending", written, "write-outcome-unknown")
                restarts += 1
                continue
            if not wrote:
                return _result("done", written)
            decision = decide_after_birthday_run(_post_check(col_mgr, state), reruns)
            if decision == "done":
                return _result("done", written)
            if decision == "pending":
                return _result("pending", written, "post-check")
            reruns += 1
    except Exception as exc:  # noqa: BLE001 - birthdays must never raise into their caller
        _logger.warning("Birthdays reconcile failed (%s)", bounded_exception_class(exc))
        return _result("failed", written, "error")


def disable_birthdays(account, username):
    """Turn off: retire every qualifying active calendar, then remove only generated items.

    Fails closed when the inventory, a calendar or a member list cannot be read completely.
    Calendars are never deleted, and items that are not generated are never touched.
    """
    written = set()
    try:
        col_mgr = account.get_collection_manager()
        state, reason = _read_state(col_mgr, username, with_source=False)
        if state is None:
            return _result("failed", written, reason)
        targets = [entry for entry in state["calendars"].values() if entry["writable"]]
        if any(not entry["complete"] for entry in targets):
            return _result("failed", written, "incomplete-calendar")
        for entry in targets:
            if any(_read_content(item) is None for item in entry["items"].values()):
                return _result("failed", written, "unreadable-calendar-item")
        try:
            for entry in sorted(targets, key=lambda e: e["collection"].uid):
                if entry["state"] == "active":
                    _retire(col_mgr, entry, written)
                generated = [uid for uid, item in entry["items"].items()
                             if is_generated_birthday_uid((parse_birthday_event_fields(_read_content(item)) or {}).get("uid"))]
                _delete_items(col_mgr, entry, sorted(generated), written)
        except Exception as exc:  # noqa: BLE001 - unknown outcome; the next run repairs
            _logger.info("Birthdays turn-off outcome unknown (%s)", bounded_exception_class(exc))
            return _result("pending", written, "write-outcome-unknown")
        return _result("done", written)
    except Exception as exc:  # noqa: BLE001
        _logger.warning("Birthdays turn-off failed (%s)", bounded_exception_class(exc))
        return _result("failed", written, "error")


BIRTHDAYS_CALENDAR_NAME = "Birthdays"


def _qualifying_active(state):
    return [entry for entry in state["calendars"].values() if entry["writable"] and entry["state"] == "active"]


def enable_birthdays(account, username):
    """Turn on: reuse a qualifying active calendar, or create ONE private marked calendar; then
    reconcile. Never infers absence from an incomplete read, never adopts an ordinary calendar,
    and never creates a second calendar after an uncertain create: it re-reads instead.
    """
    created = []
    try:
        col_mgr = account.get_collection_manager()
        state, reason = _read_state(col_mgr, username, with_source=False)
        if state is None:
            return _result("failed", set(), reason, created=created)
        if not _qualifying_active(state):
            collection = col_mgr.create(CALENDAR_TYPE, {"name": BIRTHDAYS_CALENDAR_NAME}, marker_content("active"))
            try:
                col_mgr.upload(collection)
                created.append(collection.uid)
            except Exception as exc:  # noqa: BLE001 - unknown outcome: look before doing anything else
                _logger.info("Birthdays calendar create outcome unknown (%s)", bounded_exception_class(exc))
                state, reason = _read_state(col_mgr, username, with_source=False)
                if state is None or not _qualifying_active(state):
                    return _result("pending", set(), "create-outcome-unknown", created=created)
                created.extend(entry["collection"].uid for entry in _qualifying_active(state))
        result = reconcile_birthdays(account, username)
        written = set(result.get("written") or []) | set(created)
        return {**result, "written": sorted(written), "created": created}
    except Exception as exc:  # noqa: BLE001
        _logger.warning("Birthdays turn-on failed (%s)", bounded_exception_class(exc))
        return _result("failed", set(created), "error", created=created)


def _refresh_cache(service, written):
    """Publish this run's calendar writes into the local cache through existing service methods.

    The collection list first, so a new calendar (or a retired marker) is known to the cache;
    then each written calendar, push before pull so ordinary pending DAV edits are kept.
    """
    if not written:
        return
    try:
        service._assert_session_current()
        service.sync_collection_list()
    except Exception as exc:  # noqa: BLE001 - the next regular sync publishes it
        _logger.info("Birthdays cache refresh deferred (%s)", bounded_exception_class(exc))
        return
    for uid in written:
        try:
            service.sync_collection(uid)
        except Exception as exc:  # noqa: BLE001
            _logger.info("Birthdays calendar refresh deferred (%s)", bounded_exception_class(exc))


_running_accounts = set()
_running_lock = threading.Lock()


def _claim(username):
    with _running_lock:
        if username in _running_accounts:
            return False
        _running_accounts.add(username)
        return True


def _release(username):
    with _running_lock:
        _running_accounts.discard(username)


def reconcile_after_sync(service):
    """Called by local_cache.Etebase.sync() after a cycle with no unresolved DAV conflicts.

    Runs only for the service's current session, at most once at a time per account (a call
    made while that account's run is active is coalesced), and refreshes only the calendars it
    wrote. sync_collection never calls this hook, so the refresh cannot recurse. Never raises.
    """
    username = getattr(service, "username", None)
    if not username:
        return _result("skipped", set(), "no-account")
    if not _claim(username):
        return _result("skipped", set(), "already-running")
    try:
        try:
            service._assert_session_current()
        except Exception:  # noqa: BLE001 - a replaced session never starts a run
            return _result("skipped", set(), "session-replaced")
        result = reconcile_birthdays(service.etebase, username) or {}
        _refresh_cache(service, result.get("written") or [])
        return result
    except Exception as exc:  # noqa: BLE001
        _logger.warning("Birthdays after-sync run failed (%s)", bounded_exception_class(exc))
        return _result("failed", set(), "error")
    finally:
        _release(username)


def set_dashboard_birthdays(username, action):
    """Dashboard turn on ('on') or turn off ('off') for one configured account.

    Loads the account through the existing exclusive, writable session (the same per-account
    serialization the sync thread uses), checks that session is current, runs the turn-on or
    turn-off, then publishes the written calendars into the cache. Never raises.
    """
    if action not in ("on", "off"):
        return _result("failed", set(), "unknown-action")
    try:
        from . import accounts

        if username not in accounts.list_accounts():
            return _result("skipped", set(), "not-configured")
        from .radicale import etesync_cache

        with etesync_cache.etesync_for_user(username, exclusive=True, read_only=False) as (service, _created):
            if not _claim(username):
                return _result("skipped", set(), "already-running")
            try:
                try:
                    service._assert_session_current()
                except Exception:  # noqa: BLE001
                    return _result("skipped", set(), "session-replaced")
                if action == "on":
                    result = enable_birthdays(service.etebase, username)
                else:
                    result = disable_birthdays(service.etebase, username)
                _refresh_cache(service, result.get("written") or [])
                return result
            finally:
                _release(username)
    except Exception as exc:  # noqa: BLE001 - reported as failed, never as done
        _logger.warning("Birthdays dashboard action failed (%s)", bounded_exception_class(exc))
        return _result("failed", set(), "error")
