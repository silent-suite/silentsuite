"""Narrow Radicale application compatibility adapters."""

import logging
import re

from radicale.app import Application as RadicaleApplication

from ..privacy_logging import bounded_exception_class, bounded_identifier

_MAX_DIAGNOSTIC_LENGTH = 320


def _safe_exception_diagnostic(exc_info):
    """Return an exception class and product-owned frame without private values."""
    if not exc_info or not exc_info[0]:
        return "Radicale server request failed"

    exception = exc_info[1] if len(exc_info) > 1 else None
    exception_class = (
        bounded_exception_class(exception)
        if exception is not None
        else bounded_identifier(getattr(exc_info[0], "__name__", None))
    )

    product_origin = None
    traceback = exc_info[2]
    while traceback is not None:
        filename = str(traceback.tb_frame.f_code.co_filename).replace("\\", "/")
        marker = "silentsuite_bridge/"
        if marker in filename:
            relative_path = filename.rsplit(marker, 1)[1]
            function = traceback.tb_frame.f_code.co_name
            if (
                len(relative_path) <= 160
                and len(function) <= 64
                and re.fullmatch(r"[A-Za-z0-9_./-]+", relative_path)
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", function)
            ):
                product_origin = (
                    f"{relative_path}:{traceback.tb_lineno} in {function}"
                )
        traceback = traceback.tb_next

    if product_origin:
        diagnostic = (
            "Radicale server request failed "
            f"({exception_class} at {product_origin})"
        )
        if len(diagnostic) <= _MAX_DIAGNOSTIC_LENGTH:
            return diagnostic
    return f"Radicale server request failed ({exception_class})"


def _safe_put_diagnostic(template, exc_info):
    """Classify a fixed Radicale PUT stage without retaining request values."""
    stage = "processing"
    for candidate in (
        "read_request_body",
        "read_components",
        "prepare",
        "create_collection",
        "upload",
    ):
        if f"({candidate})" in template:
            stage = candidate
            break
    exception_diagnostic = _safe_exception_diagnostic(exc_info)
    suffix = exception_diagnostic.removeprefix("Radicale server request failed")
    diagnostic = f"Radicale PUT rejected during {stage}{suffix}"
    if len(diagnostic) <= _MAX_DIAGNOSTIC_LENGTH:
        return diagnostic
    return f"Radicale PUT rejected during {stage}"


# Templates and argument shapes of radicale/app/__init__.py in the pinned
# Radicale 3.2.3. Anything that does not match exactly stays suppressed.
_REQUEST_LOG_ORIGIN = "/radicale/app/__init__.py"
_REQUEST_ARRIVAL = "%s request for %r%s received from %s%s"
_REQUEST_OUTCOME = "%s response status for %r%s in %.3f seconds: %s"
_REQUEST_FAILURE = "An exception occurred during %s request on %r: %s"
_LOGIN_SUCCEEDED = "Successful login: %r"
_LOGIN_SUCCEEDED_MAPPED = "Successful login: %r -> %r"
_LOGIN_FAILED = "Failed login attempt from %s: %r"
_LOGIN_REFUSED = "Refused unsafe username: %r"
_DAV_METHODS = frozenset(
    {
        "DELETE",
        "GET",
        "HEAD",
        "MKCALENDAR",
        "MKCOL",
        "MOVE",
        "OPTIONS",
        "POST",
        "PROPFIND",
        "PROPPATCH",
        "PUT",
        "REPORT",
    }
)
_STATUS_TEXT = re.compile(r"([1-5][0-9]{2}) [A-Za-z][A-Za-z' -]{0,63}")


def _method_category(method):
    if type(method) is str and method in _DAV_METHODS:
        return method
    return "OTHER"


def _status_category(status_text):
    if type(status_text) is str:
        match = _STATUS_TEXT.fullmatch(status_text)
        if match:
            return match.group(1)
    return "unknown"


def _all_text(values):
    return all(type(value) is str for value in values)


def _request_diagnostic(record):
    """Return a fixed request/auth diagnostic, or None to keep it suppressed."""
    template = record.msg
    args = record.args
    if type(template) is not str or type(args) is not tuple:
        return None
    level = record.levelno
    count = len(args)
    if template == _REQUEST_ARRIVAL:
        if level == logging.INFO and count == 5 and _all_text(args[1:]):
            return f"DAV request received (method={_method_category(args[0])})"
    elif template == _REQUEST_OUTCOME:
        if (
            level == logging.INFO
            and count == 5
            and _all_text(args[1:3])
            and type(args[3]) is float
        ):
            return (
                "DAV request completed "
                f"(method={_method_category(args[0])} "
                f"status={_status_category(args[4])})"
            )
    elif template == _REQUEST_FAILURE:
        if (
            level == logging.ERROR
            and count == 3
            and type(args[1]) is str
            and isinstance(args[2], BaseException)
        ):
            return f"DAV request failed (method={_method_category(args[0])})"
    elif template == _LOGIN_SUCCEEDED:
        if level == logging.INFO and count == 1 and _all_text(args):
            return "Local authentication succeeded"
    elif template == _LOGIN_SUCCEEDED_MAPPED:
        if level == logging.INFO and count == 2 and _all_text(args):
            return "Local authentication succeeded"
    elif template == _LOGIN_FAILED:
        if level == logging.WARNING and count == 2 and _all_text(args):
            return "Local authentication failed"
    elif template == _LOGIN_REFUSED:
        if level == logging.INFO and count == 1 and _all_text(args):
            return "Local authentication refused"
    return None


_expected_record_fields = [None, frozenset()]


def _drop_unexpected_record_fields(record):
    """Remove caller-supplied ``extra`` attributes a sink could format."""
    factory = logging.getLogRecordFactory()
    if _expected_record_fields[0] is not factory:
        try:
            template = factory("radicale", logging.INFO, "", 0, "", (), None)
        except Exception:
            template = logging.LogRecord("radicale", logging.INFO, "", 0, "", (), None)
        _expected_record_fields[1] = frozenset(vars(template)) | {
            "message",
            "asctime",
        }
        _expected_record_fields[0] = factory
    for field in set(vars(record)) - _expected_record_fields[1]:
        record.__dict__.pop(field, None)


class _DavDiagnosticRedactionFilter(logging.Filter):
    """Remove DAV payloads, identifiers, tokens, and exception chains."""

    def filter(self, record):
        self._redact(record)
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        record.stack_info = None
        _drop_unexpected_record_fields(record)
        return True

    def _redact(self, record):
        template = str(record.msg)
        normalized_path = "/" + str(record.pathname).replace("\\", "/").lstrip("/")
        request_diagnostic = (
            _request_diagnostic(record)
            if normalized_path.endswith(_REQUEST_LOG_ORIGIN)
            and "/silentsuite_bridge/" not in normalized_path
            else None
        )
        if request_diagnostic is not None:
            record.msg = request_diagnostic
        elif "/radicale/server.py" in normalized_path:
            if template in {
                "Starting Radicale",
                "Radicale server ready",
                "Stopping Radicale",
            }:
                record.msg = template
            elif template.startswith("Listening on "):
                record.msg = "Radicale listener started"
            elif template.startswith("cannot create server socket on "):
                record.msg = "Radicale listener bind failed"
            elif template.startswith("cannot retrieve IPv4 or IPv6 address of "):
                record.msg = "Radicale listener address resolution failed"
            elif record.exc_info or "during request" in template:
                record.msg = _safe_exception_diagnostic(record.exc_info)
            elif record.levelno >= logging.ERROR:
                record.msg = "Radicale server failure"
            else:
                record.msg = "Radicale server diagnostic suppressed"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif "/radicale/item/" in normalized_path:
            record.msg = "Radicale item diagnostic suppressed"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif (
            "/radicale/app/put.py" in normalized_path
            and template.startswith("Bad PUT request")
        ):
            record.msg = _safe_put_diagnostic(template, record.exc_info)
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif (
            "/radicale/app/" in normalized_path
            and "/silentsuite_bridge/" not in normalized_path
        ):
            record.msg = (
                "Radicale request was rejected"
                if record.levelno >= logging.WARNING
                else "Radicale diagnostic suppressed"
            )
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif template.startswith(("Request content (", "Response content (")):
            record.msg = "DAV XML diagnostic content suppressed"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif template.startswith("Client provided sync token:"):
            record.msg = "Client provided a sync token"
            record.args = ()
        elif template.startswith("Client provided invalid sync token"):
            record.msg = "Client provided an invalid sync token"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        else:
            record.msg = (
                "Radicale failure"
                if record.levelno >= logging.WARNING
                else "Radicale diagnostic suppressed"
            )
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        return True


for _logger_name in (
    "radicale",
    "radicale.app",
    "radicale.item",
    "radicale.server",
):
    logging.getLogger(_logger_name).addFilter(_DavDiagnosticRedactionFilter())


def canonical_principal_alias_path(path: str, user: str) -> str:
    """Map an exact authenticated principal alias to its canonical DAV path."""
    if user and path == f"/principals/{user}/":
        return f"/{user}/"
    return path


class Application(RadicaleApplication):
    """Radicale application with macOS's same-account principal alias support."""

    def do_PROPFIND(self, environ, base_prefix, path, user):  # noqa: N802
        return super().do_PROPFIND(
            environ,
            base_prefix,
            canonical_principal_alias_path(path, user),
            user,
        )
