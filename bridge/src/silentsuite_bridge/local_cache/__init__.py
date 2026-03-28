"""Local cache layer for Etebase data.

Manages a local SQLite database that caches Etebase collections
and items for fast CalDAV/CardDAV responses. Handles bidirectional
sync with the Etebase server.

Forked and adapted from etesync-dav (AGPL-3.0).
Original: https://github.com/etesync/etesync-dav
"""

import logging
import os
import time

import msgpack
from etebase import Account, Client, CollectionAccessLevel, FetchOptions

from .. import config
from . import db, models

logger = logging.getLogger("silentsuite-bridge.cache")


def _extract_uid(vobject_item):
    """Extract UID from a vobject item, handling wrapper components.

    For VCALENDAR wrappers, the UID is on the child (VEVENT, VTODO, VJOURNAL).
    For VCARD, the UID is directly on the item.
    """
    if hasattr(vobject_item, "uid"):
        return vobject_item.uid.value if hasattr(vobject_item.uid, "value") else str(vobject_item.uid)
    # Try child components for VCALENDAR
    for child_name in ("vevent", "vtodo", "vjournal"):
        child = getattr(vobject_item, child_name, None)
        if child is not None and hasattr(child, "uid"):
            return child.uid.value if hasattr(child.uid, "value") else str(child.uid)
    raise ValueError(f"Cannot extract UID from vobject item: {vobject_item.name}")


def msgpack_encode(content):
    return msgpack.packb(content, use_bin_type=True)


def msgpack_decode(content):
    return msgpack.unpackb(content, raw=False)


def batch(iterable, n=1):
    length = len(iterable)
    for ndx in range(0, length, n):
        yield iterable[ndx : min(ndx + n, length)]


def get_millis():
    return int(round(time.time() * 1000))


class StorageException(Exception):
    pass


class DoesNotExist(StorageException):
    pass


class Etebase:
    """Manages an Etebase account with local SQLite cache.

    Handles authentication, sync, and CRUD operations for
    collections and items.
    """

    def __init__(self, username, stored_session, remote_url=None):
        if remote_url is None:
            remote_url = config.ETEBASE_SERVER_URL

        db_path = config.DATABASE_FILE
        client = Client("silentsuite-bridge", remote_url)
        self.stored_session = stored_session
        self.etebase = Account.restore(client, stored_session, None)
        self.username = username

        self._init_db(db_path)

    def reinit(self):
        self._set_db(self._database)

    def _set_db(self, database):
        self._database = database
        db.database_proxy.initialize(database)

        with db.database_proxy:
            self._init_db_tables(database)
            self.user, created = models.User.get_or_create(username=self.username)

    def _init_db(self, db_path):
        from playhouse.sqlite_ext import SqliteExtDatabase

        directory = os.path.dirname(db_path)
        if directory != "" and not os.path.exists(directory):
            os.makedirs(directory)

        database = SqliteExtDatabase(
            db_path,
            pragmas={
                "journal_mode": "wal",
                "foreign_keys": 1,
            },
        )

        self._set_db(database)

    def _init_db_tables(self, database, additional_tables=None):
        database.create_tables(
            [models.Config, models.User, models.CollectionEntity, models.ItemEntity, models.HrefMapper],
            safe=True,
        )
        if additional_tables:
            database.create_tables(additional_tables, safe=True)

        models.Config.get_or_create(defaults={"db_version": 1})

    def sync(self):
        """Full bidirectional sync: push local changes, pull remote changes."""
        self.sync_collection_list()
        for collection in self.list():
            self.sync_collection(collection.uid)

    def sync_collection_list(self):
        """Sync the list of collections (push then pull)."""
        self.push_collection_list()

        col_mgr = self.etebase.get_collection_manager()
        stoken = self.user.stoken
        done = False

        with db.database_proxy:
            while not done:
                fetch_options = FetchOptions().stoken(stoken)
                col_list = col_mgr.list(config.COL_TYPES, fetch_options)

                for col in col_list.data:
                    collection = models.CollectionEntity.get_or_none(
                        local_user=self.user, uid=col.uid
                    )
                    if collection is None:
                        collection = models.CollectionEntity(
                            local_user=self.user,
                            uid=col.uid,
                        )
                    collection.eb_col = col_mgr.cache_save(col)
                    collection.stoken = col.stoken
                    collection.deleted = col.deleted
                    collection.save()

                for col_uid in col_list.removed_memberships:
                    try:
                        collection = models.CollectionEntity.get(
                            local_user=self.user, uid=col_uid
                        )
                        collection.deleted = True
                        collection.save()
                        # Cascade-delete orphaned ItemEntity and HrefMapper rows
                        for item in collection.items:
                            models.HrefMapper.delete().where(
                                models.HrefMapper.content == item
                            ).execute()
                        models.ItemEntity.delete().where(
                            models.ItemEntity.collection == collection
                        ).execute()
                    except models.CollectionEntity.DoesNotExist:
                        pass

                done = col_list.done
                stoken = col_list.stoken

                self.user.stoken = stoken
                self.user.save()

    def _collection_list_dirty_get(self):
        with db.database_proxy:
            return self.user.collections.where(
                models.CollectionEntity.dirty | models.CollectionEntity.new
            )

    def collection_list_is_dirty(self):
        changed = list(self._collection_list_dirty_get())
        return len(changed) > 0

    def push_collection_list(self):
        col_mgr = self.etebase.get_collection_manager()

        with db.database_proxy:
            changed = list(self._collection_list_dirty_get())

            for collection in changed:
                col = col_mgr.cache_load(collection.eb_col)

                if collection.deleted:
                    col.delete()
                col_mgr.upload(col, None)

                collection.dirty = False
                collection.new = False
                collection.save()

    def sync_collection(self, uid):
        """Sync a single collection (push then pull)."""
        self.push_collection(uid)
        self.pull_collection(uid)

    def pull_collection(self, uid):
        with db.database_proxy:
            col_mgr = self.etebase.get_collection_manager()
            cache_col = models.CollectionEntity.get(local_user=self.user, uid=uid)

            col = col_mgr.cache_load(cache_col.eb_col)
            item_mgr = col_mgr.get_item_manager(col)
            stoken = cache_col.local_stoken
            done = False

            while not done:
                fetch_options = FetchOptions().stoken(stoken)
                item_list = item_mgr.list(fetch_options)

                for item in item_list.data:
                    meta = item.meta
                    if "name" not in meta:
                        continue

                    cache_item = models.ItemEntity.get_or_none(
                        collection=cache_col, uid=meta["name"]
                    )
                    if cache_item is None:
                        cache_item = models.ItemEntity(
                            collection=cache_col,
                            uid=meta["name"],
                        )
                    cache_item.eb_item = item_mgr.cache_save(item)
                    cache_item.deleted = item.deleted
                    cache_item.save()

                done = item_list.done
                stoken = item_list.stoken

                cache_col.local_stoken = stoken
                cache_col.save()

    def _collection_dirty_get(self, collection):
        with db.database_proxy:
            return collection.items.where(
                models.ItemEntity.dirty | models.ItemEntity.new
            )

    def collection_is_dirty(self, uid):
        with db.database_proxy:
            cache_col = models.CollectionEntity.get(local_user=self.user, uid=uid)
            changed = list(self._collection_dirty_get(cache_col))
            return len(changed) > 0

    def push_collection(self, uid):
        CHUNK_PUSH = 30

        with db.database_proxy:
            col_mgr = self.etebase.get_collection_manager()
            cache_col = models.CollectionEntity.get(local_user=self.user, uid=uid)
            col = col_mgr.cache_load(cache_col.eb_col)
            item_mgr = col_mgr.get_item_manager(col)

            changed = list(self._collection_dirty_get(cache_col))

            for chunk in batch(changed, CHUNK_PUSH):
                chunk_items = list(map(lambda x: item_mgr.cache_load(x.eb_item), chunk))
                item_mgr.batch(chunk_items, None, None)
                for cache_item, item in zip(chunk, chunk_items):
                    cache_item.eb_item = item_mgr.cache_save(item)
                    cache_item.dirty = False
                    cache_item.new = False
                    cache_item.save()

    # --- CRUD operations ---

    def list(self):
        with db.database_proxy:
            col_mgr = self.etebase.get_collection_manager()
            for cache_obj in self.user.collections.where(
                ~models.CollectionEntity.deleted
            ):
                yield Collection(col_mgr, cache_obj)

    def get(self, uid):
        with db.database_proxy:
            col_mgr = self.etebase.get_collection_manager()
            try:
                return Collection(
                    col_mgr,
                    self.user.collections.where(
                        (models.CollectionEntity.uid == uid)
                        & ~models.CollectionEntity.deleted
                    ).get(),
                )
            except models.CollectionEntity.DoesNotExist as e:
                raise DoesNotExist(e)

    def clear_user(self):
        with db.database_proxy:
            for col in self.user.collections:
                for item in col.items:
                    item.delete_instance()
                col.delete_instance()
            self.user.delete_instance()
            self.user = None


class Collection:
    """Wrapper around an Etebase collection with local cache."""

    def __init__(self, col_mgr, cache_col):
        self.col_mgr = col_mgr
        self.cache_col = cache_col
        self.col = col_mgr.cache_load(cache_col.eb_col)

    @property
    def uid(self):
        return self.col.uid

    @property
    def read_only(self):
        return self.col.access_level == CollectionAccessLevel.ReadOnly

    @property
    def stoken(self):
        return self.cache_col.local_stoken

    @property
    def col_type(self):
        return self.col.collection_type

    @property
    def meta(self):
        return self.col.meta

    def update_meta(self, update_info):
        if update_info is None:
            raise RuntimeError("update_info can't be None.")
        meta = self.meta
        meta.update(update_info)
        self.col.meta = meta
        self.cache_col.eb_col = self.col_mgr.cache_save(self.col)
        self.cache_col.save()

    def create(self, vobject_item):
        with db.database_proxy:
            item_mgr = self.col_mgr.get_item_manager(self.col)
            # Extract UID from the child component (VEVENT, VTODO, VCARD)
            # vobject_item may be a VCALENDAR/VCARD wrapper
            uid = _extract_uid(vobject_item)
            item_meta = {"name": uid, "mtime": get_millis()}
            item = item_mgr.create(item_meta, vobject_item.serialize().encode())
            cache_item = models.ItemEntity(
                collection=self.cache_col, uid=uid
            )
            cache_item.eb_item = item_mgr.cache_save(item)
            cache_item.deleted = item.deleted
            cache_item.new = True
            return Item(item_mgr, cache_item)

    def get(self, uid):
        with db.database_proxy:
            item_mgr = self.col_mgr.get_item_manager(self.col)
            try:
                return Item(
                    item_mgr,
                    self.cache_col.items.where(
                        (models.ItemEntity.uid == uid)
                        & ~models.ItemEntity.deleted
                    ).get(),
                )
            except models.ItemEntity.DoesNotExist:
                return None

    def delete(self):
        """Mark this collection as deleted and dirty so push_collection_list() will handle it."""
        with db.database_proxy:
            self.cache_col.deleted = True
            self.cache_col.dirty = True
            self.cache_col.save()

    def list(self):
        with db.database_proxy:
            item_mgr = self.col_mgr.get_item_manager(self.col)
            for cache_item in self.cache_col.items.where(
                ~models.ItemEntity.deleted
            ):
                yield Item(item_mgr, cache_item)


class Item:
    """Wrapper around an Etebase item with local cache."""

    def __init__(self, item_mgr, cache_item):
        self.item_mgr = item_mgr
        self.cache_item = cache_item
        self.item = item_mgr.cache_load(cache_item.eb_item)

    @property
    def uid(self):
        return self.meta["name"]

    @property
    def meta(self):
        return self.item.meta

    @meta.setter
    def meta(self, meta):
        self.item.meta = meta

    @property
    def content(self):
        return self.item.content.decode()

    @content.setter
    def content(self, content):
        self.item.content = content.encode()

    @property
    def etag(self):
        return self.item.etag

    def delete(self):
        self.item.delete()
        self.cache_item.deleted = True
        self.save()

    def save(self):
        item_meta = self.meta
        item_meta["mtime"] = get_millis()
        self.meta = item_meta
        with db.database_proxy:
            self.cache_item.eb_item = self.item_mgr.cache_save(self.item)
            self.cache_item.dirty = True
            self.cache_item.save()
