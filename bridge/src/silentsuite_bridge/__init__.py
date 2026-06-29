"""SilentSuite Bridge — Local E2EE CalDAV/CardDAV sync daemon.

Connects to server.silentsuite.io via the Etebase protocol,
decrypts/encrypts data locally, and exposes CalDAV/CardDAV
endpoints on localhost for use with any standard PIM client.

License: AGPL-3.0-only
"""

import os
from importlib import metadata as _metadata

# Kept in sync with pyproject.toml [project].version. Used only as a
# last-resort fallback when neither a build stamp nor package metadata is
# available (e.g. running straight from source without an editable install).
_FALLBACK_VERSION = "0.3.2-beta"


def _resolve_version() -> str:
    """Resolve the bridge version, preferring a release-build stamp.

    Resolution order:
      1. ``SILENTSUITE_BRIDGE_VERSION`` env var — explicit runtime/build
         override (CI tag builds set this; see silentsuite-bridge.spec).
      2. ``_version.py`` — written at build time from the git tag and frozen
         into the PyInstaller binary, which does not ship package metadata.
      3. ``_FALLBACK_VERSION`` — the exact human-facing release string. This is
         preferred over package metadata because Python normalizes
         ``0.3.0-beta`` to ``0.3.0b0`` in installed metadata.
      4. ``importlib.metadata`` — final fallback for unusual packaged installs.
    """
    override = os.environ.get("SILENTSUITE_BRIDGE_VERSION", "").strip()
    if override:
        return override.lstrip("v")

    try:
        from ._version import VERSION as _stamped  # type: ignore[attr-defined]

        if _stamped:
            return str(_stamped).lstrip("v")
    except Exception:
        pass

    if _FALLBACK_VERSION:
        return _FALLBACK_VERSION

    try:
        return _metadata.version("silentsuite-bridge")
    except _metadata.PackageNotFoundError:
        return "0.0.0-dev"


__version__ = _resolve_version()
__author__ = "SilentSuite"
__license__ = "AGPL-3.0-only"
