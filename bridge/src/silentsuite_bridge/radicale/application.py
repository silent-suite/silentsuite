"""Narrow Radicale application compatibility adapters."""

import logging
import re

from radicale.app import Application as RadicaleApplication


def _safe_exception_diagnostic(exc_info):
    """Return an exception class and product-owned frame without private values."""
    if not exc_info or not exc_info[0]:
        return "Radicale server request failed"

    exception_class = getattr(exc_info[0], "__name__", "Exception")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", exception_class):
        exception_class = "Exception"

    product_origin = None
    traceback = exc_info[2]
    while traceback is not None:
        filename = str(traceback.tb_frame.f_code.co_filename).replace("\\", "/")
        marker = "/silentsuite_bridge/"
        if marker in filename:
            relative_path = filename.rsplit(marker, 1)[1]
            function = traceback.tb_frame.f_code.co_name
            if (
                re.fullmatch(r"[A-Za-z0-9_./-]+", relative_path)
                and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", function)
            ):
                product_origin = (
                    f"{relative_path}:{traceback.tb_lineno} in {function}"
                )
        traceback = traceback.tb_next

    if product_origin:
        return (
            "Radicale server request failed "
            f"({exception_class} at {product_origin})"
        )
    return f"Radicale server request failed ({exception_class})"


class _DavDiagnosticRedactionFilter(logging.Filter):
    """Remove DAV payloads, identifiers, tokens, and exception chains."""

    def filter(self, record):
        template = str(record.msg)
        normalized_path = "/" + str(record.pathname).replace("\\", "/").lstrip("/")
        if "/radicale/server.py" in normalized_path:
            record.msg = _safe_exception_diagnostic(record.exc_info)
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        elif "/radicale/item/" in normalized_path:
            record.msg = "Radicale item diagnostic suppressed"
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
