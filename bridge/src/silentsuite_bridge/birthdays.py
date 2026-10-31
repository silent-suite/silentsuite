"""Generated Birthdays calendar for SilentSuite Bridge (#738).

Shared contract: contracts/birthday-calendar/v1-vectors.json (also implemented by
packages/core for web and by the Android client).

Implemented (hosted-RED qualified): marker parsing, contact birthdays, event
identity, the active-marker check behind DAV read-only, and the post-sync hook.

Still NEUTRAL scaffolds (no SDK reads, no writes, no cache changes) until their own
hosted RED is qualified: reconcile_birthdays, disable_birthdays,
set_dashboard_birthdays, and the pure event/planner helpers below them.
"""

import hashlib
import json
import re

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


# ── Pure event and planner helpers (NEUTRAL until their hosted RED) ──


def birthday_event_fields(event):
    """Comparable fields a generated event must have (contract `fields`)."""
    return None


def birthday_event_content(event):
    """The iCalendar text Bridge writes for a birthday event."""
    return None


def parse_birthday_event_fields(ics):
    """Comparable fields of the first VEVENT, or None without a VEVENT UID."""
    return None


def is_current_birthday_event(ics, event):
    """Whether stored iCalendar text already means exactly this event."""
    return False


def birthday_events_from_source(snapshot):
    """Desired events from a complete source snapshot (contract `sources`)."""
    return None


def plan_birthday_calendar(events, calendars):
    """What to write so the calendars hold exactly `events` (contract `plans`)."""
    return None


def decide_after_birthday_run(check, reruns_so_far):
    """'done', 'rerun' or 'pending' after a committed run (contract `postChecks`)."""
    return None


# ── SDK-facing entry points (NEUTRAL until their hosted RED) ──


def reconcile_birthdays(account, username):
    """Fresh-read reconcile of the generated calendar for one account. Never raises."""
    return dict(SKIPPED)


def disable_birthdays(account, username):
    """Turn off: retire every qualifying active calendar, then remove only generated items."""
    return dict(SKIPPED)


def reconcile_after_sync(service):
    """Called by local_cache.Etebase.sync() after a cycle with no unresolved DAV conflicts."""
    return reconcile_birthdays(getattr(service, "etebase", None), getattr(service, "username", None))


def set_dashboard_birthdays(username, action):
    """Dashboard turn on ('on') or turn off ('off') for one configured account."""
    return dict(SKIPPED)
