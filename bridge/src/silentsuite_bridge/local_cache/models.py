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

    class Meta:
        indexes = ((("collection", "uid"), True),)


class HrefMapper(db.BaseModel):
    """Maps Etebase item UIDs to CalDAV/CardDAV hrefs.

    CalDAV clients use hrefs (filenames like 'abc123.ics') to
    identify items. Etebase uses UIDs. This table bridges the two.
    """

    content = pw.ForeignKeyField(
        ItemEntity, primary_key=True, backref="href", on_delete="CASCADE"
    )
    href = pw.CharField(null=False, index=True)
