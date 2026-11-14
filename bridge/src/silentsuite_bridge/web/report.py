"""Bridge "Report a problem": payload builder, strict validation and relay POST.

Report format v1 is the public contract ``contracts/problem-report.schema.json``
(surface ``bridge``). Diagnostics are allowlisted and reduced in-process:
accounts are counted, never named; server URLs become a hosted/custom flag;
error codes come only from an explicit table lookup, anything else is
``other``. Nothing in this module logs or prints report content, and nothing
is sent until the user presses Send on the dashboard report page.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

REPORT_URL = "https://silentsuite.io/api/report"
_ALLOWED_HOSTS = frozenset({"silentsuite.io"})
_USER_AGENT = "SilentSuite-Bridge-Report"

SUPPORT_EMAIL = "support@silentsuite.io"
PRIVACY_URL = "https://silentsuite.io/privacy#problem-reports"
DISCLOSURE_TEXT = (
    "Your report is sent through Cloudflare and delivered by email (via Resend) "
    "to the SilentSuite support inbox. It is not end-to-end encrypted and not "
    "linked to your account. We keep it for as long as we need it to deal "
    "with your report; to have it deleted, email "
    f"{SUPPORT_EMAIL}."
)

HOSTED_SERVER_URL = "https://server.silentsuite.io"

SEND_TIMEOUT = 15
MAX_BODY_BYTES = 32 * 1024
MAX_RESPONSE_BYTES = 4096

SUMMARY_MAX_CHARS = 120
SUMMARY_MAX_BYTES = 480
DESCRIPTION_MAX_CHARS = 4000
DESCRIPTION_MAX_BYTES = 16000
CONTACT_MAX_CHARS = 254

OUTCOME_SENT = "sent"
OUTCOME_FAILED = "failed"
OUTCOME_UNKNOWN = "unknown"

KINDS = ("problem", "feature")

# Bounded status codes the bridge records (privacy_logging._BOUNDED_DIAGNOSTIC_CODES
# plus the sync worker's SyncTimeout/SyncStopped) mapped to the schema's
# bridgeErrorCode enum. Explicit table: values are never derived from input.
_ERROR_CODES = {
    "CacheBackfillIntegrityError": "cache_backfill_integrity_error",
    "CachePullItemIntegrityError": "cache_pull_item_integrity_error",
    "CacheRevisionIntegrityError": "cache_revision_integrity_error",
    "CacheSchemaRemoteUidIntegrityError": "cache_schema_remote_uid_integrity_error",
    "CacheSchemaTokenRevisionIntegrityError": "cache_schema_token_revision_integrity_error",
    "CacheSyncTokenIntegrityError": "cache_sync_token_integrity_error",
    "CacheUnresolvedRetryIntegrityError": "cache_unresolved_retry_integrity_error",
    "SyncTimeout": "sync_timeout",
    "SyncStopped": "sync_stopped",
}
ERROR_CODES = frozenset(_ERROR_CODES.values()) | {"other"}

_SYNC_STATUS = {
    "connected": "synced",
    "syncing": "syncing",
    "starting": "syncing",
    "error": "error",
    "disconnected": "offline",
}
_SYNC_STATUSES = frozenset({"synced", "syncing", "offline", "error", "unknown"})
_LAST_SUCCESS = frozenset({"under_1h", "under_1d", "under_7d", "over_7d", "never", "unknown"})
_SERVERS = frozenset({"hosted", "custom"})
_YES_NO = frozenset({"yes", "no"})
_INSTALLS = frozenset({"frozen", "python"})

_DIAGNOSTIC_KEYS = (
    "app_version", "platform", "server", "sync_status", "last_success",
    "error_codes", "fields",
)
_FIELD_KEYS = ("install", "accounts", "tray", "ssl")
_REQUEST_KEYS = frozenset({"kind", "summary", "description", "contact_email", "diagnostics"})

_APP_VERSION_RE = re.compile(r"[A-Za-z0-9._+-]{1,32}")
_PLATFORM_RE = re.compile(r"[a-z0-9._-]{1,32}")
# Schema pattern; always used with fullmatch (``$`` would admit a trailing newline).
_CONTACT_RE = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,189}")
# C0 and C1 controls except tab (0x09) and newline (0x0A).
_CONTROL_RE = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# Lone surrogate code points (Python str can hold them, e.g. surrogateescape).
_SURROGATE_RE = re.compile("[\ud800-\udfff]")

_STATUS_TIME_FORMAT = "%Y-%m-%d %H:%M:%S"

_tray_active = False


class ReportError(ValueError):
    """User input or diagnostics failed validation. The message is fixed text."""


class ReportSendError(ValueError):
    """The POST helper refused a request before any network access."""


def mark_tray_active():
    """Record that the system tray icon was started (reported as yes/no only)."""
    global _tray_active
    _tray_active = True


def error_code_for(error):
    """Map a recorded bridge status code to the report enum by exact lookup."""
    if isinstance(error, str):
        return _ERROR_CODES.get(error, "other")
    return "other"


# ---------------------------------------------------------------------------
# Diagnostics builder
# ---------------------------------------------------------------------------


def _last_success_bucket(last_sync_values, now):
    parsed = []
    for value in last_sync_values:
        if value is None:
            continue
        try:
            parsed.append(time.mktime(time.strptime(value, _STATUS_TIME_FORMAT)))
        except (TypeError, ValueError, OverflowError):
            return "unknown"
    if not parsed:
        return "never"
    age = now - max(parsed)
    if age < -60:
        return "unknown"
    if age < 3600:
        return "under_1h"
    if age < 86400:
        return "under_1d"
    if age < 7 * 86400:
        return "under_7d"
    return "over_7d"


def _normalised_server(url):
    return url.strip().rstrip("/").lower() if isinstance(url, str) else None


def build_diagnostics(
    *,
    state,
    last_sync,
    account_entries,
    account_count,
    server_urls,
    app_version,
    platform,
    frozen,
    tray,
    ssl,
    now,
):
    """Return the allowlisted diagnostics object from already-reduced inputs.

    ``account_entries`` holds per-account ``state``, ``report_code`` and
    ``last_sync`` only; account names and free-text error fields never reach
    this function. ``server_urls`` are compared to the hosted URL and dropped.
    """
    codes = set()
    last_syncs = [last_sync]
    for entry in account_entries:
        last_syncs.append(entry.get("last_sync"))
        if entry.get("state") == "error":
            code = entry.get("report_code")
            codes.add(code if code in ERROR_CODES else "other")
    sync_status = _SYNC_STATUS.get(state, "unknown") if isinstance(state, str) else "unknown"
    if sync_status == "error" and not codes:
        codes.add("other")

    hosted = _normalised_server(HOSTED_SERVER_URL)
    server = "hosted"
    for url in server_urls:
        if _normalised_server(url) != hosted:
            server = "custom"
            break

    if not (isinstance(app_version, str) and _APP_VERSION_RE.fullmatch(app_version)):
        app_version = "unknown"
    if not (isinstance(platform, str) and _PLATFORM_RE.fullmatch(platform)):
        platform = "unknown"

    try:
        count = int(account_count)
    except (TypeError, ValueError):
        count = 0
    count = max(0, min(999, count))

    return {
        "app_version": app_version,
        "platform": platform,
        "server": server,
        "sync_status": sync_status,
        "last_success": _last_success_bucket(last_syncs, now),
        "error_codes": sorted(codes)[:10],
        "fields": {
            "install": "frozen" if frozen else "python",
            "accounts": count,
            "tray": "yes" if tray else "no",
            "ssl": "yes" if ssl else "no",
        },
    }


def platform_label():
    """Return the update/platform.py label pair, e.g. ``macos-arm64``."""
    from ..update.platform import PlatformMapping

    try:
        return f"{PlatformMapping.get_os_label()}-{PlatformMapping.get_arch_label()}"
    except Exception:
        return "unknown"


def preview_text(diagnostics):
    """The exact diagnostics text shown in the preview and used by Email/Copy."""
    return json.dumps(diagnostics, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Strict validation (the page posts the frozen snapshot back)
# ---------------------------------------------------------------------------


def _is_one_of(value, allowed):
    return isinstance(value, str) and value in allowed


def validate_diagnostics(value):
    """Return a canonical copy of ``value`` or raise ReportError.

    Every key and value must be on the allowlist; this runs on the snapshot
    the page received at render time, so the sent diagnostics can only ever
    be allowlisted values.
    """
    invalid = ReportError("Diagnostic info is not valid; reload the page and try again.")
    if not isinstance(value, dict) or set(value) != set(_DIAGNOSTIC_KEYS):
        raise invalid
    app_version = value["app_version"]
    platform = value["platform"]
    if not (isinstance(app_version, str) and _APP_VERSION_RE.fullmatch(app_version)):
        raise invalid
    if not (isinstance(platform, str) and _PLATFORM_RE.fullmatch(platform)):
        raise invalid
    if not _is_one_of(value["server"], _SERVERS):
        raise invalid
    if not _is_one_of(value["sync_status"], _SYNC_STATUSES):
        raise invalid
    if not _is_one_of(value["last_success"], _LAST_SUCCESS):
        raise invalid
    codes = value["error_codes"]
    if not isinstance(codes, list) or len(codes) > 10:
        raise invalid
    if any(not isinstance(code, str) or code not in ERROR_CODES for code in codes):
        raise invalid
    if len(set(codes)) != len(codes):
        raise invalid
    fields = value["fields"]
    if not isinstance(fields, dict) or not set(fields) <= set(_FIELD_KEYS):
        raise invalid
    clean_fields = {}
    for key in _FIELD_KEYS:
        if key not in fields:
            continue
        field = fields[key]
        if key == "install":
            ok = _is_one_of(field, _INSTALLS)
        elif key == "accounts":
            ok = type(field) is int and 0 <= field <= 999
        else:
            ok = _is_one_of(field, _YES_NO)
        if not ok:
            raise invalid
        clean_fields[key] = field
    return {
        "app_version": app_version,
        "platform": platform,
        "server": value["server"],
        "sync_status": value["sync_status"],
        "last_success": value["last_success"],
        "error_codes": list(codes),
        "fields": clean_fields,
    }


def _clean_text(value, label, max_chars, max_bytes):
    if not isinstance(value, str):
        raise ReportError(f"{label} is required.")
    text = value.replace("\r\n", "\n")
    if _CONTROL_RE.search(text):
        raise ReportError(f"{label} contains unsupported control characters.")
    if _SURROGATE_RE.search(text):
        raise ReportError(f"{label} contains unsupported characters.")
    encoded = text.encode("utf-8")
    if not text.strip():
        raise ReportError(f"{label} is required.")
    if len(text) > max_chars or len(encoded) > max_bytes:
        raise ReportError(f"{label} is too long (at most {max_chars} characters).")
    return text


def build_payload(request):
    """Validate the page's request object and return the v1 report payload."""
    if not isinstance(request, dict) or not set(request) <= _REQUEST_KEYS:
        raise ReportError("The report could not be read; reload the page and try again.")
    kind = request.get("kind")
    if not _is_one_of(kind, KINDS):
        raise ReportError("Choose Problem or Feature request.")
    payload = {
        "schema": 1,
        "kind": kind,
        "surface": "bridge",
        "summary": _clean_text(
            request.get("summary"), "Summary", SUMMARY_MAX_CHARS, SUMMARY_MAX_BYTES,
        ),
        "description": _clean_text(
            request.get("description"), "Description", DESCRIPTION_MAX_CHARS, DESCRIPTION_MAX_BYTES,
        ),
    }
    contact = request.get("contact_email")
    if contact is not None:
        if not isinstance(contact, str):
            raise ReportError("Reply email is not valid.")
        # No stripping: the value must fullmatch the schema pattern as sent,
        # so CR/LF/tab or a trailing newline is rejected, not trimmed away.
        if contact:
            if len(contact) > CONTACT_MAX_CHARS or not _CONTACT_RE.fullmatch(contact):
                raise ReportError("Reply email is not valid.")
            payload["contact_email"] = contact
    diagnostics = request.get("diagnostics")
    if diagnostics is not None:
        payload["diagnostics"] = validate_diagnostics(diagnostics)
    return payload


def serialize_payload(payload):
    """UTF-8 JSON without ASCII escaping, held to the relay's body limit."""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_BODY_BYTES:
        raise ReportError("The report is too large to send.")
    return body


# ---------------------------------------------------------------------------
# Relay POST helper (modelled on update/http.py)
# ---------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Return redirect responses without following them."""

    def http_error_301(self, request, response, code, message, headers):
        return response

    http_error_302 = http_error_301
    http_error_303 = http_error_301
    http_error_307 = http_error_301
    http_error_308 = http_error_301


def _check_url(url):
    try:
        parsed = urlparse(url)
        port = parsed.port
    except (TypeError, ValueError):
        raise ReportSendError("Refusing invalid report URL.") from None
    if parsed.scheme != "https":
        raise ReportSendError("Refusing non-HTTPS report URL.")
    if (parsed.hostname or "") not in _ALLOWED_HOSTS:
        raise ReportSendError("Refusing disallowed report host.")
    if port not in (None, 443) or parsed.username or parsed.password:
        raise ReportSendError("Refusing disallowed report URL.")


def _close(response):
    if response is not None and hasattr(response, "close"):
        try:
            response.close()
        except Exception:
            pass


def _read_capped(response, limit):
    """Return at most ``limit`` bytes of the response body, or None if larger."""
    content = getattr(response, "content", None)
    if content is not None:
        data = content if isinstance(content, bytes) else None
    else:
        data = response.read(limit + 1)
    if not isinstance(data, bytes) or len(data) > limit:
        return None
    return data


def send_report(body, *, url=REPORT_URL, transport=None, timeout=SEND_TIMEOUT):
    """POST one report body exactly once; return sent, failed or unknown.

    ``failed`` means the relay answered with a definite non-success status;
    ``unknown`` means the outcome cannot be confirmed (timeout, dropped
    connection, unexpected response), so the relay may already have accepted
    the report. There are no retries. Disallowed URLs and oversized bodies
    raise ReportSendError before any network access.
    """
    _check_url(url)
    if not isinstance(body, bytes) or len(body) > MAX_BODY_BYTES:
        raise ReportSendError("Refusing oversized report body.")
    headers = {"Content-Type": "application/json", "User-Agent": _USER_AGENT}

    if transport is not None:
        # Injected fake transport (tests)
        try:
            response = transport.post(url, data=body, headers=dict(headers), timeout=timeout)
        except Exception:
            return OUTCOME_UNKNOWN
    else:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        opener = urllib.request.build_opener(_NoRedirect())
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as err:
            _close(err)
            return OUTCOME_FAILED
        except Exception:
            return OUTCOME_UNKNOWN

    try:
        try:
            status = int(getattr(response, "status", 0) or 0)
        except (TypeError, ValueError):
            return OUTCOME_UNKNOWN
        if status != 201:
            return OUTCOME_FAILED
        try:
            data = _read_capped(response, MAX_RESPONSE_BYTES)
            reply = json.loads(data) if data is not None else None
        except Exception:
            return OUTCOME_UNKNOWN
        if isinstance(reply, dict) and reply.get("ok") is True:
            return OUTCOME_SENT
        return OUTCOME_UNKNOWN
    finally:
        _close(response)
