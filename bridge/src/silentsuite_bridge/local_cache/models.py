"""Database models for the local Etebase cache.

Stores cached collection and item data from the Etebase server
in a local SQLite database for fast CalDAV/CardDAV serving.

Forked and adapted from etesync-dav (AGPL-3.0).
"""

import peewee as pw

from . import db


class Config(db.BaseModel):
    db_version = pw.IntegerField()


class User(db.BaseModel):
    username = pw.CharField(unique=True, null=False)
    stoken = pw.CharField(null=True, default=None)


class CollectionEntity(db.BaseModel):
    local_user = pw.ForeignKeyField(User, backref="collections", on_delete="CASCADE")
    uid = pw.CharField(null=False, index=True)
    eb_col = pw.BlobField()
    new = pw.BooleanField(null=False, default=False)
    dirty = pw.BooleanField(null=False, default=False)
    deleted = pw.BooleanField(null=False, default=False)
    stoken = pw.CharField(null=True, default=None)
    local_stoken = pw.CharField(null=True, default=None)
    dav_revision = pw.IntegerField(null=False, default=0)

    class Meta:
        indexes = ((("local_user", "uid"), True),)


class ItemEntity(db.BaseModel):
    collection = pw.ForeignKeyField(
        CollectionEntity, backref="items", on_delete="CASCADE"
    )
    uid = pw.CharField(null=False, index=True)
    eb_item = pw.BlobField()
    new = pw.BooleanField(null=False, default=False)
    dirty = pw.BooleanField(null=False, default=False)
    deleted = pw.BooleanField(null=False, default=False)
    remote_uid = pw.CharField(null=True, default=None)

    class Meta:
        indexes = (
            (("collection", "uid"), True),
            (("collection", "remote_uid"), True),
        )


class HrefMapper(db.BaseModel):
    """Maps Etebase item UIDs to CalDAV/CardDAV hrefs.

    CalDAV clients use hrefs (filenames like 'abc123.ics') to
    identify items. Etebase uses UIDs. This table bridges the two.
    """

    content = pw.ForeignKeyField(
        ItemEntity, primary_key=True, backref="href", on_delete="CASCADE"
    )
    href = pw.CharField(null=False, index=True)


class DavChange(db.BaseModel):
    """Latest DAV-visible change for one collection href."""

    collection = pw.ForeignKeyField(
        CollectionEntity, backref="dav_changes", on_delete="CASCADE"
    )
    href = pw.CharField(null=False)
    revision = pw.IntegerField(null=False)
    etag = pw.CharField(null=True, default=None)
    deleted = pw.BooleanField(null=False, default=False)

    class Meta:
        indexes = ((("collection", "href"), True),)


class DavRevision(db.BaseModel):
    """Append-only DAV mutation ledger used to prove sync history completeness."""

    collection = pw.ForeignKeyField(
        CollectionEntity, backref="dav_revisions", on_delete="CASCADE"
    )
    href = pw.CharField(null=False)
    revision = pw.IntegerField(null=False)
    etag = pw.CharField(null=True, default=None)
    deleted = pw.BooleanField(null=False, default=False)
    state_hash = pw.CharField(null=True, default=None)

    class Meta:
        indexes = ((("collection", "revision"), True),)


class DavSyncToken(db.BaseModel):
    """Opaque collection-scoped DAV token mapped to a local revision."""

    collection = pw.ForeignKeyField(
        CollectionEntity, backref="dav_sync_tokens", on_delete="CASCADE"
    )
    token = pw.CharField(null=False)
    revision = pw.IntegerField(null=False)
    created_at = pw.IntegerField(null=False)
    state_hash = pw.CharField(null=True, default=None)

    class Meta:
        indexes = (
            (("collection", "token"), True),
            (("collection", "revision"), True),
        )


class DavUnresolvedItem(db.BaseModel):
    """Durable quarantine for remote items whose local identity is unresolved."""

    collection = pw.ForeignKeyField(
        CollectionEntity, backref="dav_unresolved", on_delete="CASCADE"
    )
    remote_uid = pw.CharField(null=False)
    eb_item = pw.BlobField()
    deleted = pw.BooleanField(null=False, default=False)
    attempts = pw.IntegerField(null=False, default=0)
    reason = pw.CharField(null=False, default="remote_unresolved")
    local_item = pw.ForeignKeyField(
        ItemEntity,
        null=True,
        default=None,
        backref="dav_quarantine",
        on_delete="SET NULL",
    )

    class Meta:
        indexes = ((("collection", "remote_uid"), True),)


class SchemaMigration(db.BaseModel):
    """Additive cache feature migrations without changing legacy db_version."""

    name = pw.CharField(unique=True, null=False)
    applied_at = pw.IntegerField(null=False)
