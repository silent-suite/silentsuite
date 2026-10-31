"""Generated Birthdays calendar for SilentSuite Bridge (#738).

NEUTRAL SCAFFOLD for the tests-first checkpoint: every function below has its
final signature but performs no SDK reads, no writes and no cache changes.
Behaviour is added only after the hosted CI run shows the intended failures.

Shared contract: contracts/birthday-calendar/v1-vectors.json.
"""

SKIPPED = {"status": "skipped", "reason": "not-implemented"}


def parse_birthday_marker(content):
    """'active' or 'retired' for a Birthdays calendar's collection content; None otherwise."""
    return None


def birthday_from_vcard(vcard_text):
    """(name, month, day) a contact's birthday event gets, or None when it gets none."""
    return None


def birthday_event_uid(book_uid, item_uid):
    """Event UID from the Etebase address-book and item uids (never the vCard UID)."""
    return ""


def is_managed_collection(collection):
    """Whether an SDK collection is an active Birthdays calendar (read-only to DAV clients)."""
    return False


def reconcile_birthdays(account, username):
    """Fresh-read reconcile of the generated calendar for one account. Never raises."""
    return dict(SKIPPED)


def disable_birthdays(account, username):
    """Turn off: retire every qualifying active calendar, then remove only generated items."""
    return dict(SKIPPED)


def reconcile_after_sync(service):
    """Called by local_cache.Etebase.sync() after a cycle with no unresolved DAV conflicts."""
    return None


def set_dashboard_birthdays(username, action):
    """Dashboard turn on ('on') or turn off ('off') for one configured account."""
    return dict(SKIPPED)
