"""Local cache layer for Etebase data.

Manages a local SQLite database that caches Etebase collections
and items for fast CalDAV/CardDAV responses. Handles bidirectional
sync with the Etebase server.

Forked and adapted from etesync-dav (AGPL-3.0).
Original: https://github.com/etesync/etesync-dav
"""

import hashlib
import logging
import os
import re
import threading
import time
from contextlib import contextmanager

import msgpack
import peewee as pw
from etebase import Account, Client, CollectionAccessLevel, FetchOptions

from .. import config
from . import db, models

logger = logging.getLogger("silentsuite-bridge.cache")
_cache_database_init_lock = threading.RLock()
DAV_UNRESOLVED_RETRY_LIMIT = 8


class DavUnresolvedItemsError(RuntimeError):
    """A sync applied safe changes but retained unresolved DAV conflicts."""


@contextmanager
def _private_umask():
    old_umask = os.umask(0o077)
    try:
        yield
    finally:
        os.umask(old_umask)


def _ensure_private_cache_dir(path):
    directory = os.path.dirname(path)
    if directory != "":
        if not os.path.exists(directory):
            os.makedirs(directory, mode=0o700)
        os.chmod(directory, 0o700)


def _restrict_cache_database_files(path):
    if not path or path == ":memory:":
        return
    for cache_path in (path, f"{path}-wal", f"{path}-shm"):
        if os.path.exists(cache_path):
            os.chmod(cache_path, 0o600)


def _init_cache_database(db_path=None):
    """Initialize the cache DB proxy only when it is not already initialized.

    Reuse the initialized database only when it targets the requested cache path.
    """
    path = db_path or config.DATABASE_FILE
    database = getattr(db.database_proxy, "obj", None)
    if database is not None:
        if db_path is None:
            return database, False
        current_path = getattr(database, "database", None)
        normalized_current = (
            current_path
            if current_path == ":memory:"
            else os.path.abspath(os.path.expanduser(str(current_path)))
        )
        normalized_requested = (
            path
            if path == ":memory:"
            else os.path.abspath(os.path.expanduser(str(path)))
        )
        if normalized_current == normalized_requested:
            return database, False

    from playhouse.sqlite_ext import SqliteExtDatabase

    _ensure_private_cache_dir(path)

    with _private_umask():
        database = SqliteExtDatabase(
            path,
            pragmas={
                "journal_mode": "wal",
                "foreign_keys": 1,
            },
        )
    db.database_proxy.initialize(database)
    return database, True


def _ensure_cache_tables(database):
    with _private_umask():
        database.create_tables(
            [
                models.Config,
                models.User,
                models.CollectionEntity,
                models.ItemEntity,
                models.HrefMapper,
            ],
            safe=True,
        )
        _migrate_cache_schema(database)
        database.create_tables(
            [
                models.DavChange,
                models.DavRevision,
                models.DavSyncToken,
                models.DavUnresolvedItem,
                models.SchemaMigration,
            ],
            safe=True,
        )
        models.Config.get_or_create(defaults={"db_version": 1})
        models.SchemaMigration.get_or_create(
            name="dav-revision-v1",
            defaults={"applied_at": get_millis()},
        )
        _activate_dav_revision_ledger()
    _restrict_cache_database_files(getattr(database, "database", None))


def _migrate_cache_schema(database):
    """Add DAV revision columns without changing the legacy db_version value."""
    tables = set(database.get_tables())
    if "collectionentity" not in tables or "itementity" not in tables:
        return

    collection_columns = {column.name for column in database.get_columns("collectionentity")}
    item_columns = {column.name for column in database.get_columns("itementity")}
    if "dav_revision" not in collection_columns:
        database.execute_sql(
            "ALTER TABLE collectionentity "
            "ADD COLUMN dav_revision INTEGER NOT NULL DEFAULT 0"
        )
    if "remote_uid" not in item_columns:
        database.execute_sql(
            "ALTER TABLE itementity ADD COLUMN remote_uid VARCHAR(255)"
        )
    database.execute_sql(
        "CREATE UNIQUE INDEX IF NOT EXISTS "
        "itementity_collection_remote_uid "
        "ON itementity (collection_id, remote_uid)"
    )
    if "davsynctoken" in tables:
        token_columns = {
            column.name for column in database.get_columns("davsynctoken")
        }
        if "state_hash" not in token_columns:
            database.execute_sql(
                "ALTER TABLE davsynctoken ADD COLUMN state_hash VARCHAR(255)"
            )
        database.execute_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS "
            "davsynctoken_collection_revision "
            "ON davsynctoken (collection_id, revision)"
        )
    if "davrevision" in tables:
        revision_columns = {
            column.name for column in database.get_columns("davrevision")
        }
        if "state_hash" not in revision_columns:
            database.execute_sql(
                "ALTER TABLE davrevision ADD COLUMN state_hash VARCHAR(255)"
            )
        if "previous_state_hash" not in revision_columns:
            database.execute_sql(
                "ALTER TABLE davrevision "
                "ADD COLUMN previous_state_hash VARCHAR(255)"
            )
    if "davunresolveditem" in tables:
        unresolved_columns = {
            column.name for column in database.get_columns("davunresolveditem")
        }
        if "reason" not in unresolved_columns:
            database.execute_sql(
                "ALTER TABLE davunresolveditem "
                "ADD COLUMN reason VARCHAR(255) NOT NULL "
                "DEFAULT 'remote_unresolved'"
            )
        if "local_item_id" not in unresolved_columns:
            database.execute_sql(
                "ALTER TABLE davunresolveditem ADD COLUMN local_item_id INTEGER"
            )


def _activate_dav_revision_ledger():
    """Invalidate pre-ledger tokens once so all retained tokens are provable."""
    database = models.SchemaMigration._meta.database
    with database.atomic():
        _, created = models.SchemaMigration.get_or_create(
            name="dav-revision-chain-v3",
            defaults={"applied_at": get_millis()},
        )
        if created:
            models.DavSyncToken.delete().execute()


def clear_cached_user(username, db_path=None):
    """Delete one user's cache while serializing proxy setup and migrations."""
    with _cache_database_init_lock:
        return _clear_cached_user_locked(username, db_path)


def clear_unconfigured_cached_users(configured_users, db_path=None):
    """Clear orphaned account caches left by an interrupted deferred removal."""
    configured = {(user or "").strip() for user in configured_users}
    with _cache_database_init_lock:
        database, initialized_here = _init_cache_database(db_path)
        if database.is_closed():
            with _private_umask():
                database.connect(reuse_if_open=True)
        try:
            _ensure_cache_tables(database)
            orphaned = [
                user.username
                for user in models.User.select(models.User.username)
                if user.username not in configured
            ]
        finally:
            if initialized_here and not database.is_closed():
                database.close()
        for username in orphaned:
            _clear_cached_user_locked(username, db_path)
        return len(orphaned)


def _clear_cached_user_locked(username, db_path=None):
    """Delete one user's cached rows without needing a live Etebase session.

    Returns True when a cache user row existed and was deleted. Missing users are
    an idempotent no-op.
    """
    normalized = (username or "").strip()
    if not normalized:
        raise ValueError("Account username is required")

    database, initialized_here = _init_cache_database(db_path)
    if database.is_closed():
        with _private_umask():
            database.connect(reuse_if_open=True)

    try:
        _ensure_cache_tables(database)
        with database.atomic():
            user = models.User.get_or_none(models.User.username == normalized)
            if user is None:
                return False

            collection_ids = [
                col.id
                for col in models.CollectionEntity.select(
                    models.CollectionEntity.id
                ).where(models.CollectionEntity.local_user == user)
            ]
            if collection_ids:
                item_ids = [
                    item.id
                    for item in models.ItemEntity.select(models.ItemEntity.id).where(
                        models.ItemEntity.collection.in_(collection_ids)
                    )
                ]
                if item_ids:
                    models.HrefMapper.delete().where(
                        models.HrefMapper.content.in_(item_ids)
                    ).execute()
                models.ItemEntity.delete().where(
                    models.ItemEntity.collection.in_(collection_ids)
                ).execute()
                models.CollectionEntity.delete().where(
                    models.CollectionEntity.id.in_(collection_ids)
                ).execute()
            user.delete_instance()
            return True
    finally:
        if initialized_here and not database.is_closed():
            database.close()


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


def dav_collection_state_hash(cache_col):
    """Hash DAV-relevant encrypted cache state without exposing its contents."""
    digest = hashlib.sha256()

    def add(value):
        if value is None:
            payload = b"<null>"
        elif isinstance(value, bytes):
            payload = value
        else:
            payload = str(value).encode("utf-8")
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)

    current_col = models.CollectionEntity.get_by_id(cache_col.id)
    for value in (
        current_col.eb_col,
        current_col.new,
        current_col.dirty,
        current_col.deleted,
        current_col.dav_revision,
    ):
        add(value)
    items = (
        models.ItemEntity.select()
        .where(models.ItemEntity.collection == current_col)
        .order_by(models.ItemEntity.id)
    )
    for item in items:
        href = models.HrefMapper.get_or_none(models.HrefMapper.content == item)
        for value in (
            item.id,
            item.uid,
            item.remote_uid,
            item.eb_item,
            item.new,
            item.dirty,
            item.deleted,
            href.href if href is not None else None,
        ):
            add(value)
    return digest.hexdigest()


def is_safe_dav_href(href):
    """Return whether href is one conservative, ASCII-safe DAV path segment."""
    return (
        bool(href)
        and href not in {".", ".."}
        and len(href) <= 255
        and re.fullmatch(r"[A-Za-z0-9._-]+", href) is not None
    )


def opaque_dav_href(identity, suffix):
    """Derive a stable opaque href without exposing a remote or legacy identity."""
    return hashlib.sha256(str(identity).encode("utf-8")).hexdigest() + suffix


_dav_href_allocation_lock = threading.RLock()


def ensure_dav_href(
    cache_item, preferred_href, suffix, *, strict=False, replace_existing=False
):
    """Return one collection-unique href, including retained tombstones."""
    with _dav_href_allocation_lock:
        mapper = models.HrefMapper.get_or_none(
            models.HrefMapper.content == cache_item
        )
        candidate = (
            mapper.href
            if mapper is not None and not replace_existing
            else preferred_href
        )
        if not is_safe_dav_href(candidate):
            if strict:
                raise ValueError("invalid DAV href")
            candidate = opaque_dav_href(
                f"{cache_item.collection_id}:{cache_item.remote_uid or cache_item.uid}",
                suffix,
            )

        def has_conflict(href):
            return (
                models.HrefMapper.select()
                .join(models.ItemEntity)
                .where(
                    (models.HrefMapper.href == href)
                    & (models.ItemEntity.collection == cache_item.collection_id)
                    & (models.HrefMapper.content != cache_item.id)
                )
                .exists()
            )

        if strict and has_conflict(candidate):
            raise ValueError("DAV href already exists")
        counter = 0
        while has_conflict(candidate):
            counter += 1
            candidate = opaque_dav_href(
                f"{cache_item.collection_id}:{cache_item.remote_uid or cache_item.uid}:{counter}",
                suffix,
            )

        if mapper is None:
            mapper = models.HrefMapper.create(content=cache_item, href=candidate)
        elif mapper.href != candidate:
            mapper.href = candidate
            mapper.save(only=[models.HrefMapper.href])
        return mapper


def record_dav_change(
    cache_col, href, *, previous_state_hash, etag=None, deleted=False
):
    """Atomically advance a collection revision and record its latest href change."""
    with db.database_proxy.atomic():
        (
            models.CollectionEntity.update(
                dav_revision=models.CollectionEntity.dav_revision + 1
            )
            .where(models.CollectionEntity.id == cache_col.id)
            .execute()
        )
        revision = models.CollectionEntity.get_by_id(cache_col.id).dav_revision
        (
            models.DavChange.insert(
                collection=cache_col,
                href=href,
                revision=revision,
                etag=etag,
                deleted=deleted,
            )
            .on_conflict(
                conflict_target=[
                    models.DavChange.collection,
                    models.DavChange.href,
                ],
                update={
                    models.DavChange.revision: revision,
                    models.DavChange.etag: etag,
                    models.DavChange.deleted: deleted,
                },
            )
            .execute()
        )
        models.DavRevision.create(
            collection=cache_col,
            href=href,
            revision=revision,
            etag=etag,
            deleted=deleted,
            previous_state_hash=previous_state_hash,
            state_hash=dav_collection_state_hash(cache_col),
        )
        cache_col.dav_revision = revision
        return revision


class StorageException(Exception):
    pass


class SessionSuperseded(StorageException):
    pass


class DoesNotExist(StorageException):
    pass


class Etebase:
    """Manages an Etebase account with local SQLite cache.

    Handles authentication, sync, and CRUD operations for
    collections and items.
    """

    def _assert_session_current(self):
        checker = getattr(self, "_session_is_current", None)
        if checker is not None and not checker():
            raise SessionSuperseded("Account session was replaced")

    @contextmanager
    def _mutation_session_guard(self):
        guard = getattr(self, "_session_guard", None)
        if guard is None:
            self._assert_session_current()
            yield
            return
        with guard() as current:
            if not current:
                raise SessionSuperseded("Account session was replaced")
            yield

    def __init__(self, username, stored_session, remote_url=None, *, read_only=False):
        if remote_url is None:
            remote_url = config.ETEBASE_SERVER_URL

        db_path = config.DATABASE_FILE
        client = Client("silentsuite-bridge", remote_url)
        self.stored_session = stored_session
        self.etebase = Account.restore(client, stored_session, None)
        self.username = username

        if read_only:
            database = getattr(db.database_proxy, "obj", None)
            if database is None:
                raise RuntimeError("Local cache is not initialized")
            self._database = database
            with db.database_proxy:
                self.user = models.User.get(username=self.username)
        else:
            self._init_db(db_path)

    def reinit(self):
        self._set_db(self._database)

    def _set_db(self, database):
        self._database = database
        db.database_proxy.initialize(database)

        with _private_umask():
            with db.database_proxy:
                self._init_db_tables(database)
                self.user, created = models.User.get_or_create(username=self.username)
                if hasattr(self, "etebase"):
                    unresolved = self._backfill_remote_uids()
                    if unresolved:
                        logger.warning(
                            "Remote identity backfill left %d cached items unresolved",
                            unresolved,
                        )
        _restrict_cache_database_files(getattr(database, "database", None))

    def _init_db(self, db_path):
        _ensure_private_cache_dir(db_path)
        with _cache_database_init_lock:
            database, _ = _init_cache_database(db_path)
            self._set_db(database)

    def _init_db_tables(self, database, additional_tables=None):
        database.create_tables(
            [
                models.Config,
                models.User,
                models.CollectionEntity,
                models.ItemEntity,
                models.HrefMapper,
            ],
            safe=True,
        )
        _migrate_cache_schema(database)
        database.create_tables(
            [
                models.DavChange,
                models.DavRevision,
                models.DavSyncToken,
                models.DavUnresolvedItem,
                models.SchemaMigration,
            ],
            safe=True,
        )
        if additional_tables:
            database.create_tables(additional_tables, safe=True)

        models.Config.get_or_create(defaults={"db_version": 1})
        models.SchemaMigration.get_or_create(
            name="dav-revision-v1",
            defaults={"applied_at": get_millis()},
        )
        _activate_dav_revision_ledger()
        _restrict_cache_database_files(getattr(database, "database", None))

    def _backfill_remote_uids(self):
        """Recover stable Etebase item identities from cached envelopes only."""
        unresolved = 0
        col_mgr = self.etebase.get_collection_manager()
        for cache_col in self.user.collections:
            col = col_mgr.cache_load(cache_col.eb_col)
            item_mgr = col_mgr.get_item_manager(col)
            items = cache_col.items.where(models.ItemEntity.remote_uid.is_null(True))
            for cache_item in items:
                existing_quarantine = models.DavUnresolvedItem.get_or_none(
                    (models.DavUnresolvedItem.local_item == cache_item)
                    & models.DavUnresolvedItem.reason.in_(
                        ("legacy_corrupt", "legacy_duplicate")
                    )
                )
                if existing_quarantine is not None:
                    continue
                try:
                    remote_item = item_mgr.cache_load(cache_item.eb_item)
                except Exception:
                    self._quarantine_legacy_cache_item(
                        cache_col,
                        cache_item,
                        reason="legacy_corrupt",
                    )
                    unresolved += 1
                    continue
                try:
                    cache_item.remote_uid = remote_item.uid
                    cache_item.save(only=[models.ItemEntity.remote_uid])
                except pw.IntegrityError:
                    self._quarantine_legacy_cache_item(
                        cache_col,
                        cache_item,
                        reason="legacy_duplicate",
                    )
                    unresolved += 1
            suffix = ".vcf" if col.collection_type == "etebase.vcard" else ".ics"
            replaced_href = False
            for cache_item in cache_col.items:
                href_mapper = models.HrefMapper.get_or_none(
                    models.HrefMapper.content == cache_item
                )
                if href_mapper is None or is_safe_dav_href(href_mapper.href):
                    continue
                identity = cache_item.remote_uid or cache_item.uid
                ensure_dav_href(
                    cache_item,
                    opaque_dav_href(identity, suffix),
                    suffix,
                    replace_existing=True,
                )
                replaced_href = True
            if replaced_href:
                models.DavSyncToken.delete().where(
                    models.DavSyncToken.collection == cache_col
                ).execute()
        return unresolved

    def _quarantine_legacy_cache_item(self, cache_col, cache_item, *, reason):
        """Hide a legacy row while preserving its envelope for local retry."""
        quarantine_uid = "legacy-cache:" + hashlib.sha256(
            str(cache_item.id).encode("ascii") + b":" + cache_item.eb_item
        ).hexdigest()
        with db.database_proxy.atomic("IMMEDIATE"):
            previous_state_hash = dav_collection_state_hash(cache_col)
            (
                models.DavUnresolvedItem.insert(
                    collection=cache_col,
                    remote_uid=quarantine_uid,
                    eb_item=cache_item.eb_item,
                    deleted=cache_item.deleted,
                    attempts=0,
                    reason=reason,
                    local_item=cache_item,
                )
                .on_conflict(
                    conflict_target=[
                        models.DavUnresolvedItem.collection,
                        models.DavUnresolvedItem.remote_uid,
                    ],
                    update={
                        models.DavUnresolvedItem.eb_item: cache_item.eb_item,
                        models.DavUnresolvedItem.reason: reason,
                        models.DavUnresolvedItem.local_item: cache_item,
                        models.DavUnresolvedItem.attempts:
                            models.DavUnresolvedItem.attempts + 1,
                    },
                )
                .execute()
            )
            cache_item.remote_uid = None
            cache_item.deleted = True
            cache_item.save(
                only=[
                    models.ItemEntity.remote_uid,
                    models.ItemEntity.deleted,
                ]
            )
            href_mapper = models.HrefMapper.get_or_none(
                models.HrefMapper.content == cache_item
            )
            if href_mapper is not None:
                record_dav_change(
                    cache_col,
                    href_mapper.href,
                    previous_state_hash=previous_state_hash,
                    deleted=True,
                )

    def sync(self):
        """Full bidirectional sync: push local changes, pull remote changes."""
        logger.info("=== Starting full sync cycle ===")
        self.sync_collection_list()
        for collection in self.list():
            self.sync_collection(collection.uid)
        unresolved = (
            models.DavUnresolvedItem.select()
            .join(models.CollectionEntity)
            .where(
                (models.CollectionEntity.local_user == self.user)
                & (models.CollectionEntity.deleted == False)  # noqa: E712
            )
            .exists()
        )
        if unresolved:
            logger.warning("Sync completed with unresolved DAV conflicts")
            raise DavUnresolvedItemsError("DAV synchronization is incomplete")
        logger.info("=== Full sync cycle complete ===")

    def sync_collection_list(self):
        """Sync the list of collections (push then pull)."""
        self.push_collection_list()

        col_mgr = self.etebase.get_collection_manager()
        stoken = self.user.stoken
        done = False

        with db.database_proxy.connection_context():
            while not done:
                fetch_options = FetchOptions().stoken(stoken)
                col_list = col_mgr.list(config.COL_TYPES, fetch_options)
                self._assert_session_current()

                done, stoken = self._apply_collection_list_page(col_mgr, col_list)

    def _apply_collection_list_page(self, col_mgr, col_list):
        with self._mutation_session_guard():
            with db.database_proxy.atomic("IMMEDIATE"):
                for col in col_list.data:
                    collection = models.CollectionEntity.get_or_none(
                        local_user=self.user, uid=col.uid
                    )
                    if collection is not None and (
                        collection.dirty or collection.new
                    ):
                        continue
                    if collection is None:
                        collection = models.CollectionEntity(
                            local_user=self.user,
                            uid=col.uid,
                        )
                    collection.eb_col = col_mgr.cache_save(col)
                    collection.stoken = col.stoken
                    collection.deleted = col.deleted
                    collection.save(
                        only=[
                            models.CollectionEntity.local_user,
                            models.CollectionEntity.uid,
                            models.CollectionEntity.eb_col,
                            models.CollectionEntity.stoken,
                            models.CollectionEntity.deleted,
                        ]
                    )
                    if collection.deleted:
                        models.DavUnresolvedItem.delete().where(
                            models.DavUnresolvedItem.collection == collection
                        ).execute()

                for col_uid in col_list.removed_memberships:
                    try:
                        collection = models.CollectionEntity.get(
                            local_user=self.user, uid=col_uid
                        )
                        if collection.dirty or collection.new:
                            continue
                        has_pending_items = collection.items.where(
                            models.ItemEntity.dirty | models.ItemEntity.new
                        ).exists()
                        if has_pending_items:
                            collection.dirty = True
                            collection.save(only=[models.CollectionEntity.dirty])
                            continue
                        collection.deleted = True
                        collection.save(only=[models.CollectionEntity.deleted])
                        models.DavUnresolvedItem.delete().where(
                            models.DavUnresolvedItem.collection == collection
                        ).execute()
                        # The immediate transaction serializes this check/delete
                        # with DAV writers, which reject deleted collections.
                        for item in collection.items:
                            models.HrefMapper.delete().where(
                                models.HrefMapper.content == item
                            ).execute()
                        models.ItemEntity.delete().where(
                            models.ItemEntity.collection == collection
                        ).execute()
                    except models.CollectionEntity.DoesNotExist:
                        pass

                stoken = col_list.stoken
                (
                    models.User.update(stoken=stoken)
                    .where(models.User.id == self.user.id)
                    .execute()
                )
                self.user.stoken = stoken
                self._assert_session_current()
                return col_list.done, stoken

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
                original_envelope = collection.eb_col
                original_dirty = collection.dirty
                original_new = collection.new
                original_deleted = collection.deleted
                col = col_mgr.cache_load(collection.eb_col)

                if collection.deleted:
                    col.delete()
                col_mgr.upload(col, None)
                self._assert_session_current()

                (
                    models.CollectionEntity.update(dirty=False, new=False)
                    .where(
                        (models.CollectionEntity.id == collection.id)
                        & (models.CollectionEntity.eb_col == original_envelope)
                        & (models.CollectionEntity.dirty == original_dirty)
                        & (models.CollectionEntity.new == original_new)
                        & (models.CollectionEntity.deleted == original_deleted)
                    )
                    .execute()
                )

    def sync_collection(self, uid):
        """Sync a single collection (push then pull)."""
        self.push_collection(uid)
        self.pull_collection(uid)

    def _quarantine_unresolved_item(self, cache_col, item_mgr, item):
        cached_envelope = item_mgr.cache_save(item)
        (
            models.DavUnresolvedItem.insert(
                collection=cache_col,
                remote_uid=item.uid,
                eb_item=cached_envelope,
                deleted=item.deleted,
                attempts=0,
            )
            .on_conflict(
                conflict_target=[
                    models.DavUnresolvedItem.collection,
                    models.DavUnresolvedItem.remote_uid,
                ],
                update={
                    models.DavUnresolvedItem.eb_item: cached_envelope,
                    models.DavUnresolvedItem.deleted: item.deleted,
                    models.DavUnresolvedItem.attempts:
                        models.DavUnresolvedItem.attempts + 1,
                },
            )
            .execute()
        )

    def _apply_pulled_item(
        self,
        cache_col,
        col,
        item_mgr,
        item,
        *,
        quarantine=True,
    ):
        meta = dict(item.meta)
        with db.database_proxy.atomic("IMMEDIATE"):
            previous_state_hash = dav_collection_state_hash(cache_col)
            cache_item = models.ItemEntity.get_or_none(
                (models.ItemEntity.collection == cache_col)
                & (models.ItemEntity.remote_uid == item.uid)
            )
            if cache_item is None and meta.get("name"):
                cache_item = models.ItemEntity.get_or_none(
                    (models.ItemEntity.collection == cache_col)
                    & (models.ItemEntity.uid == meta["name"])
                    & (models.ItemEntity.remote_uid.is_null(True))
                )
                if cache_item is None:
                    identity_bound_collision = models.ItemEntity.get_or_none(
                        (models.ItemEntity.collection == cache_col)
                        & (models.ItemEntity.uid == meta["name"])
                        & (models.ItemEntity.remote_uid.is_null(False))
                    )
                    if identity_bound_collision is not None:
                        if quarantine:
                            self._quarantine_unresolved_item(
                                cache_col, item_mgr, item
                            )
                        return False
            if cache_item is None and item.deleted:
                if quarantine:
                    self._quarantine_unresolved_item(cache_col, item_mgr, item)
                return False
            if cache_item is None:
                cache_item = models.ItemEntity(
                    collection=cache_col,
                    uid=meta.get("name") or item.uid,
                )

            if cache_item.id is not None and (cache_item.dirty or cache_item.new):
                if cache_item.remote_uid is None:
                    cache_item.remote_uid = item.uid
                    cache_item.save(only=[models.ItemEntity.remote_uid])
                models.DavUnresolvedItem.delete().where(
                    (models.DavUnresolvedItem.collection == cache_col)
                    & (models.DavUnresolvedItem.local_item == cache_item)
                ).execute()
                return True

            cache_item.remote_uid = item.uid
            cache_item.eb_item = item_mgr.cache_save(item)
            cache_item.deleted = item.deleted
            cache_item.save()

            href_mapper = models.HrefMapper.get_or_none(
                models.HrefMapper.content == cache_item
            )
            if href_mapper is None and not item.deleted:
                suffix = (
                    ".vcf"
                    if col.collection_type == "etebase.vcard"
                    else ".ics"
                )
                href_stem = hashlib.sha256(item.uid.encode()).hexdigest()
                href_mapper = ensure_dav_href(
                    cache_item, f"{href_stem}{suffix}", suffix
                )
            elif href_mapper is not None:
                suffix = (
                    ".vcf"
                    if col.collection_type == "etebase.vcard"
                    else ".ics"
                )
                href_mapper = ensure_dav_href(
                    cache_item, href_mapper.href, suffix
                )
            if href_mapper is not None:
                record_dav_change(
                    cache_col,
                    href_mapper.href,
                    previous_state_hash=previous_state_hash,
                    etag=item.etag,
                    deleted=item.deleted,
                )
            models.DavUnresolvedItem.delete().where(
                (models.DavUnresolvedItem.collection == cache_col)
                & (
                    (models.DavUnresolvedItem.remote_uid == item.uid)
                    | (models.DavUnresolvedItem.local_item == cache_item)
                )
            ).execute()
            return True

    def _retry_unresolved_items(self, cache_col, col, item_mgr):
        unresolved_items = list(
            models.DavUnresolvedItem.select().where(
                models.DavUnresolvedItem.collection == cache_col
            )
        )
        for unresolved in unresolved_items:
            if unresolved.reason == "legacy_duplicate":
                continue
            if unresolved.attempts >= DAV_UNRESOLVED_RETRY_LIMIT:
                continue
            try:
                item = item_mgr.cache_load(unresolved.eb_item)
            except Exception as exc:
                unresolved.attempts += 1
                unresolved.save(only=[models.DavUnresolvedItem.attempts])
                logger.warning(
                    "Deferred unresolved DAV item after cache-load failure (%s)",
                    exc.__class__.__name__,
                )
                continue
            if unresolved.local_item_id is not None:
                remote_envelope = item_mgr.cache_save(item)
                with db.database_proxy.atomic("IMMEDIATE"):
                    local_item = models.ItemEntity.get_or_none(
                        models.ItemEntity.id == unresolved.local_item_id
                    )
                    conflict = models.ItemEntity.get_or_none(
                        (models.ItemEntity.collection == cache_col)
                        & (models.ItemEntity.remote_uid == item.uid)
                        & (models.ItemEntity.id != unresolved.local_item_id)
                    )
                    if local_item is None or conflict is not None:
                        unresolved.reason = "legacy_duplicate"
                        unresolved.attempts += 1
                        unresolved.save(
                            only=[
                                models.DavUnresolvedItem.reason,
                                models.DavUnresolvedItem.attempts,
                            ]
                        )
                        continue
                    if local_item.dirty or local_item.new:
                        if local_item.remote_uid is None:
                            local_item.remote_uid = item.uid
                            local_item.save(only=[models.ItemEntity.remote_uid])
                        unresolved.delete_instance()
                        continue
                    previous_state_hash = dav_collection_state_hash(cache_col)
                    local_item.remote_uid = item.uid
                    local_item.eb_item = remote_envelope
                    local_item.deleted = item.deleted
                    local_item.save(
                        only=[
                            models.ItemEntity.remote_uid,
                            models.ItemEntity.eb_item,
                            models.ItemEntity.deleted,
                        ]
                    )
                    href_mapper = models.HrefMapper.get_or_none(
                        models.HrefMapper.content == local_item
                    )
                    if href_mapper is not None:
                        record_dav_change(
                            cache_col,
                            href_mapper.href,
                            previous_state_hash=previous_state_hash,
                            etag=getattr(item, "etag", None),
                            deleted=item.deleted,
                        )
                    unresolved.delete_instance()
                continue
            applied = self._apply_pulled_item(
                cache_col,
                col,
                item_mgr,
                item,
                quarantine=False,
            )
            if not applied:
                unresolved.attempts += 1
                unresolved.save(only=[models.DavUnresolvedItem.attempts])
            else:
                unresolved.delete_instance()

    def pull_collection(self, uid):
        with db.database_proxy.connection_context():
            col_mgr = self.etebase.get_collection_manager()
            cache_col = models.CollectionEntity.get(local_user=self.user, uid=uid)

            col = col_mgr.cache_load(cache_col.eb_col)
            item_mgr = col_mgr.get_item_manager(col)
            with self._mutation_session_guard():
                with db.database_proxy.atomic("IMMEDIATE"):
                    self._retry_unresolved_items(cache_col, col, item_mgr)
            stoken = cache_col.local_stoken
            done = False

            while not done:
                fetch_options = FetchOptions().stoken(stoken)
                item_list = item_mgr.list(fetch_options)
                items_data = list(item_list.data)

                logger.info(
                    "PULL collection: fetched %d items",
                    len(items_data),
                )

                with self._mutation_session_guard():
                    with db.database_proxy.atomic("IMMEDIATE"):
                        for item in items_data:
                            self._apply_pulled_item(cache_col, col, item_mgr, item)

                        done = item_list.done
                        stoken = item_list.stoken
                        self._assert_session_current()
                        (
                            models.CollectionEntity.update(local_stoken=stoken)
                            .where(models.CollectionEntity.id == cache_col.id)
                            .execute()
                        )

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
            logger.info("PUSH collection: %d dirty/new items to push", len(changed))

            if not changed:
                return

            for chunk in batch(changed, CHUNK_PUSH):
                original_rows = [
                    (item.id, item.eb_item, item.dirty, item.new)
                    for item in chunk
                ]
                chunk_items = list(map(lambda x: item_mgr.cache_load(x.eb_item), chunk))
                logger.info("PUSH collection: uploading batch of %d items", len(chunk_items))
                item_mgr.batch(chunk_items, None, None)
                self._assert_session_current()
                logger.info("PUSH collection: batch upload succeeded")
                for original, item in zip(original_rows, chunk_items):
                    item_id, original_envelope, original_dirty, original_new = original
                    uploaded_envelope = item_mgr.cache_save(item)
                    (
                        models.ItemEntity.update(
                            eb_item=uploaded_envelope,
                            dirty=False,
                            new=False,
                        )
                        .where(
                            (models.ItemEntity.id == item_id)
                            & (models.ItemEntity.eb_item == original_envelope)
                            & (models.ItemEntity.dirty == original_dirty)
                            & (models.ItemEntity.new == original_new)
                        )
                        .execute()
                    )

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
        clear_cached_user(self.username)
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
        self.cache_col.dirty = True
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
                collection=self.cache_col,
                uid=uid,
                remote_uid=item.uid,
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
