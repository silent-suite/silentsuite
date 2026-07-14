"""Narrow Radicale application compatibility adapters."""

from radicale.app import Application as RadicaleApplication


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
