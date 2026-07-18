"""Narrow Radicale application compatibility adapters."""

import logging

from radicale.app import Application as RadicaleApplication


class _SyncTokenRedactionFilter(logging.Filter):
    """Remove client sync tokens and exception chains from Radicale diagnostics."""

    def filter(self, record):
        template = str(record.msg)
        if template.startswith("Client provided sync token:"):
            record.msg = "Client provided a sync token"
            record.args = ()
        elif template.startswith("Client provided invalid sync token"):
            record.msg = "Client provided an invalid sync token"
            record.args = ()
            record.exc_info = None
            record.exc_text = None
        return True


logging.getLogger("radicale").addFilter(_SyncTokenRedactionFilter())


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
