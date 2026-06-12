"""Radicale rights backend for SilentSuite Bridge.

This keeps the normal owner-only DAV model, but removes write permission for
already-accepted shared collections that the Etebase account exposes as
read-only. Invitation handling itself still belongs to native/web clients; DAV
clients only see accepted collections.
"""

import logging

from radicale import pathutils
from radicale.rights.owner_only import Rights as OwnerOnlyRights

from .etesync_cache import etesync_for_user

logger = logging.getLogger("silentsuite-bridge.rights")


class Rights(OwnerOnlyRights):
    """Owner-only rights with read-only shared collection write gating."""

    def authorization(self, user: str, path: str) -> str:
        permissions = super().authorization(user, path)
        if "w" not in permissions:
            return permissions

        sane_path = pathutils.strip_path(path)
        parts = sane_path.split("/", maxsplit=2)
        if len(parts) < 2 or not user or parts[0] != user:
            return permissions

        collection_uid = parts[1]
        try:
            with etesync_for_user(user) as (etesync, _):
                collection = etesync.get(collection_uid)
        except Exception as exc:
            # Missing collections include legitimate creates. Preserve the base
            # owner-only answer and let storage/server code decide.
            logger.debug(
                "Could not resolve collection permissions for %s: %s",
                collection_uid[:8],
                exc.__class__.__name__,
            )
            return permissions

        if getattr(collection, "read_only", False):
            logger.debug("Granting read-only DAV access to shared collection %s", collection_uid[:8])
            return permissions.replace("w", "")

        return permissions
