"""Radicale storage backend for SilentSuite Bridge.

Bridges between Radicale's CalDAV/CardDAV engine and the Etebase
protocol via the local cache layer. This is the core translation
layer that makes standard CalDAV clients work with E2EE data.

Forked and adapted from etesync-dav (AGPL-3.0).
Original: https://github.com/etesync/etesync-dav
"""

import email.utils
import logging
import posixpath
import re
import threading
import time
from contextlib import contextmanager

import vobject
from radicale import pathutils
from radicale.item import Item
from radicale.storage import (
    BaseCollection,
    BaseStorage,
    ComponentNotFoundError,
)

from .. import config
from ..local_cache import Etebase
from ..local_cache import models as cache_models
from ..local_cache.models import HrefMapper, ItemEntity
from ..web import log_sync_event, update_status
from .etesync_cache import etesync_for_user

logger = logging.getLogger("silentsuite-bridge.storage")


# --- Sync Thread ---

SYNC_MINIMUM = config.SYNC_MINIMUM

# Global registry of sync threads keyed by username
_sync_threads = {}
_sync_threads_lock = threading.Lock()


class SyncThread(threading.Thread):
    """Background thread that periodically syncs with the Etebase server."""

    def __init__(self, user, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._force_sync = threading.Event()
        self._done_syncing = threading.Event()
        self._done_syncing.set()
        self.user = user
        self.last_sync = None
        self._exception = None
        self.interval = config.SYNC_INTERVAL
        # Progress tracking — etebase-py doesn't expose per-item hooks, so we
        # can only report "a sync is in flight" plus the last sync's duration.
        self.is_syncing = False
        self.sync_started_at = None
        self.last_sync_duration = None

    def force_sync(self):
        self._force_sync.set()
        self._done_syncing.clear()

    def request_sync(self):
        if self.last_sync and time.time() - self.last_sync >= SYNC_MINIMUM:
            self.force_sync()

    @property
    def forced_sync(self):
        return self._force_sync.is_set()

    def set_interval(self, seconds):
        """Update the sync interval. Takes effect after the current wait."""
        self.interval = seconds
        # Wake up the wait so the new interval applies immediately
        self._force_sync.set()

    def wait_for_sync(self, timeout=None):
        ret = self._done_syncing.wait(timeout)
        e = self._exception
        self._exception = None
        if e is not None:
            raise e
        return ret

    def run(self):
        while True:
            try:
                with etesync_for_user(self.user) as (etesync, _):
                    self.last_sync = time.time()
                    self._done_syncing.clear()
                    self.is_syncing = True
                    self.sync_started_at = self.last_sync
                    etesync.sync()
                    self.last_sync_duration = time.time() - self.sync_started_at
                    self.is_syncing = False
                    logger.debug("Sync completed for user %s", self.user)

                    # Update dashboard status with collection counts
                    collections = {"calendars": 0, "contacts": 0, "tasks": 0}
                    try:
                        for col in etesync.list():
                            if col.col_type == "etebase.vevent":
                                collections["calendars"] += 1
                            elif col.col_type == "etebase.vcard":
                                collections["contacts"] += 1
                            elif col.col_type == "etebase.vtodo":
                                collections["tasks"] += 1
                    except Exception:
                        pass
                    update_status("connected", collections=collections)
                    log_sync_event("sync", f"Synced for {self.user}")
            except Exception as e:
                logger.exception("Sync error for user %s: %s", self.user, e)
                self._exception = e
                update_status("error", error=str(e))
                log_sync_event("error", f"Sync failed: {e}")
            finally:
                self.is_syncing = False
                was_re_requested = self._force_sync.is_set()
                self._force_sync.clear()
                self._done_syncing.set()

            if was_re_requested:
                continue  # immediately loop back to sync without waiting
            self._force_sync.wait(self.interval)


def start_sync_thread(user):
    """Start a SyncThread for the given user if one isn't already running.

    Returns the SyncThread instance.
    """
    with _sync_threads_lock:
        thread = _sync_threads.get(user)
        if thread is not None and thread.is_alive():
            return thread
        thread = SyncThread(user, daemon=True)
        _sync_threads[user] = thread
        thread.start()
        logger.info("Started SyncThread for user %s (interval=%ds)", user, thread.interval)
        return thread


def get_sync_thread(user):
    """Get the SyncThread for a user, or None."""
    with _sync_threads_lock:
        return _sync_threads.get(user)


# --- Meta Mapping ---


class MetaMapping:
    """Maps between Etebase collection metadata and Radicale properties."""

    _mappings = {
        "D:displayname": ("name", None, None),
    }

    @classmethod
    def _reverse_mapping(cls, mappings):
        mappings.update(
            {i[1][0]: (i[0], i[1][1], i[1][2]) for i in mappings.items()}
        )

    def _mapping_get(self, key):
        return self.__class__._mappings.get(key, (key, None, None))

    def map_get(self, info, key):
        key, get_transform, set_transform = self._mapping_get(key)
        value = info.get(key, None)
        if get_transform is not None:
            value = get_transform(value)

        if key == "C:supported-calendar-component-set":
            return key, getattr(self, "supported_calendar_component", "none")

        return key, value

    def map_set(self, key, value):
        key, get_transform, set_transform = self._mapping_get(key)
        if set_transform is not None:
            value = set_transform(value)

        return key, value


class MetaMappingCalendar(MetaMapping):
    supported_calendar_component = "VEVENT"
    _mappings = MetaMapping._mappings.copy()
    _mappings.update(
        {
            "C:calendar-description": ("description", None, None),
            "ICAL:calendar-color": ("color", None, None),
        }
    )
    MetaMapping._reverse_mapping(_mappings)


class MetaMappingTaskList(MetaMappingCalendar):
    supported_calendar_component = "VTODO"


class MetaMappingContacts(MetaMapping):
    _mappings = MetaMapping._mappings.copy()
    _mappings.update(
        {
            "CR:addressbook-description": ("description", None, None),
        }
    )
    MetaMapping._reverse_mapping(_mappings)


# --- Path Utilities ---


def _get_attributes_from_path(path):
    sane_path = pathutils.sanitize_path(path).strip("/")
    attributes = sane_path.split("/", 2)
    if not attributes[0]:
        attributes.pop()
    return attributes


# --- vCard compatibility ---

VCARD_4_TO_3_PHOTO_URI_REGEX = re.compile(
    r"^(PHOTO|LOGO):http", re.MULTILINE
)
VCARD_4_TO_3_PHOTO_INLINE_REGEX = re.compile(
    r"^(PHOTO|LOGO):data:image/([^;]*);base64,", re.MULTILINE
)


# --- Radicale Item ---


class EteSyncItem(Item):
    """Radicale item backed by an Etebase cache entry."""

    def __init__(self, *args, **kwargs):
        self.etesync_item = kwargs.pop("etesync_item")
        super().__init__(*args, **kwargs)

    @property
    def etag(self):
        return '"{}"'.format(self.etesync_item.etag)


# --- Radicale Collection ---


class Collection(BaseCollection):
    """Radicale collection backed by an Etebase collection via local cache."""

    def __init__(self, storage_, path):
        self._storage = storage_
        self._path = pathutils.sanitize_path(path).strip("/")

        attributes = _get_attributes_from_path(path)
        self.etesync = self._storage.etesync
        if len(attributes) == 2:
            self.is_fake = False
            self.uid = attributes[-1]
            self.collection = self.etesync.get(self.uid)
            col_type = self.collection.col_type

            if col_type == "etebase.vevent":
                self.meta_mappings = MetaMappingCalendar()
                self.content_suffix = ".ics"
            elif col_type == "etebase.vtodo":
                self.meta_mappings = MetaMappingTaskList()
                self.content_suffix = ".ics"
            elif col_type == "etebase.vcard":
                self.meta_mappings = MetaMappingContacts()
                self.content_suffix = ".vcf"
        else:
            self.is_fake = True

        super().__init__()

    @property
    def path(self):
        return self._path

    @property
    def etag(self):
        if self.is_fake:
            return
        return '"{}"'.format(self.collection.stoken)

    @property
    def tag(self) -> str:
        if self.is_fake:
            return ""
        col_type = self.collection.col_type
        if col_type in ("etebase.vevent", "etebase.vtodo"):
            return "VCALENDAR"
        elif col_type == "etebase.vcard":
            return "VADDRESSBOOK"
        return ""

    def sync(self, old_token=None):
        token_prefix = "http://radicale.org/ns/sync/"
        token = None
        if old_token is not None and old_token.startswith(token_prefix):
            old_token = old_token[len(token_prefix):]

        return token, self._list()

    def _list(self):
        """List collection items by their CalDAV/CardDAV hrefs."""
        if self.is_fake:
            return

        for item in self.collection.list():
            href = item.item.uid + self.content_suffix
            href_mapper, _ = HrefMapper.get_or_create(
                content=item.cache_item, defaults={"href": href}
            )
            yield href_mapper.href

    def get_multi(self, hrefs):
        return ((href, self._get(href)) for href in hrefs)

    def get_all(self):
        return (self._get(href) for href in self._list())

    def has_uid(self, uid):
        for item in self.get_all():
            if item.uid == uid:
                return True
        return False

    def _get(self, href):
        """Fetch a single item by its CalDAV/CardDAV href."""
        if self.is_fake:
            return

        try:
            href_mapper = (
                HrefMapper
                .select(HrefMapper, ItemEntity)
                .join(ItemEntity)
                .where(
                    (HrefMapper.href == href)
                    & (ItemEntity.collection == self.collection.cache_col)
                )
                .get()
            )
            uid = href_mapper.content.uid
        except HrefMapper.DoesNotExist:
            return None

        etesync_item = self.collection.get(uid)
        if etesync_item is None:
            return None

        try:
            item = vobject.readOne(etesync_item.content)

            # vCard 4.0 -> 3.0 compatibility for broader client support
            if (
                item.name == "VCARD"
                and item.contents["version"][0].value == "4.0"
            ):
                if hasattr(item, "kind") and item.kind.value.lower() == "group":
                    pass
                else:
                    if "photo" in item.contents:
                        content = etesync_item.content
                        content = VCARD_4_TO_3_PHOTO_URI_REGEX.sub(
                            r"\1;VALUE=uri:", content
                        )
                        content = VCARD_4_TO_3_PHOTO_INLINE_REGEX.sub(
                            r"\1;ENCODING=b;TYPE=\2:", content
                        )
                        item = vobject.readOne(content)
                        if content == etesync_item.content:
                            del item.contents["photo"]

                    item.contents["version"][0].value = "3.0"

            # Ensure VCARD has FN property
            if item.name == "VCARD" and not hasattr(item, "fn"):
                item.add("fn").value = str(item.n)

        except Exception as e:
            raise RuntimeError(
                "Failed to parse item %r in %r" % (href, self.path)
            ) from e

        mtime_ms = etesync_item.meta.get("mtime", 0)
        last_modified = email.utils.formatdate(mtime_ms / 1000, usegmt=True)

        return EteSyncItem(
            collection=self,
            vobject_item=item,
            href=href,
            last_modified=last_modified,
            etesync_item=etesync_item,
        )

    def upload(self, href, item):
        """Upload a new or replace an existing item.

        ``item`` is a Radicale Item (has .vobject_item property).
        """
        if self.is_fake:
            return

        vobject_item = item.vobject_item

        existing = self._get(href)
        if existing is not None:
            etesync_item = existing.etesync_item
            etesync_item.content = vobject_item.serialize()
            etesync_item.save()
            log_sync_event("sync", f"Updated item {href}")
        else:
            etesync_item = self.collection.create(vobject_item)
            etesync_item.save()
            href_mapper = HrefMapper(
                content=etesync_item.cache_item, href=href
            )
            href_mapper.save(force_insert=True)
            log_sync_event("sync", f"Created item {href}")

        return self._get(href)

    def delete(self, href=None):
        """Delete an item. When href is None, delete the collection."""
        if self.is_fake:
            return

        if href is None:
            self.collection.delete()
            log_sync_event("sync", f"Deleted collection {self._path}")
            return

        item = self._get(href)
        if item is None:
            raise ComponentNotFoundError(href)

        item.etesync_item.delete()
        log_sync_event("sync", f"Deleted item {href}")

    def get_meta(self, key=None):
        if self.is_fake:
            return {}

        if key is None:
            ret = {}
            meta = self.collection.meta
            for k in meta.keys():
                ret[k] = self.meta_mappings.map_get(meta, k)[1]
            ret["tag"] = self.tag
            return ret
        elif key == "tag":
            return self.tag
        else:
            meta = self.collection.meta
            key, value = self.meta_mappings.map_get(meta, key)
            return value

    def set_meta(self, _props):
        if self.is_fake:
            return

        props = {}
        for key, value in _props.items():
            key, value = self.meta_mappings.map_set(key, value)
            props[key] = value

        self.collection.update_meta(props)

    @property
    def last_modified(self):
        return " "


# --- Radicale Storage ---


class Storage(BaseStorage):
    """Radicale storage that serves Etebase data via local cache."""

    _etesync_user_lock = None

    def __init__(self, configuration):
        self.user = None
        self.etesync = None
        self._etesync_user_lock = threading.RLock()
        super().__init__(configuration)

    def verify(self):
        """Verify storage is accessible."""
        return True

    def discover(self, path, depth="0"):
        """Discover collections and items under the given path."""
        attributes = _get_attributes_from_path(path)

        if len(attributes) == 3:
            if path.endswith("/"):
                path = posixpath.join("/", attributes[0], attributes[1], "")
                attributes = _get_attributes_from_path(path)
            else:
                attributes[-1] = attributes[-1].replace("/", ",")
                path = posixpath.join("/", *attributes)

        try:
            if len(attributes) == 3:
                item = attributes.pop()
                path = "/".join(attributes)
                collection = Collection(self, path)
                result = collection._get(item)
                if result is not None:
                    yield result
                return

            collection = Collection(self, path)
        except Exception:
            return

        yield collection

        if depth == "0":
            return

        if len(attributes) == 0:
            if self.user:
                yield Collection(self, posixpath.join(path, self.user))
        elif len(attributes) == 1:
            for journal in self.etesync.list():
                if journal.col_type in config.COL_TYPES:
                    yield Collection(
                        self, posixpath.join(path, journal.uid)
                    )
        elif len(attributes) == 2:
            for href in collection._list():
                yield collection._get(href)
        elif len(attributes) > 2:
            raise RuntimeError(
                "Found more than one attribute. Shouldn't happen"
            )

    def move(self, item, to_collection, to_href):
        raise NotImplementedError

    def create_collection(self, href, items=None, props=None):
        """Create a new collection (calendar/address book) via CalDAV.

        Maps Radicale props to Etebase collection metadata and creates
        the collection on the server.
        """
        # Only handle creating sub-collections (user/collection-uid),
        # not the root user principal
        attributes = _get_attributes_from_path(href)
        if len(attributes) < 2:
            # Creating the user principal itself — nothing to do
            return Collection(self, href)

        props = props or {}
        tag = props.get("tag", "")

        # Determine Etebase collection type from CalDAV/CardDAV tag
        if tag == "VADDRESSBOOK":
            col_type = "etebase.vcard"
            meta_mappings = MetaMappingContacts()
        elif tag == "VCALENDAR":
            # Check for VTODO support hint
            comp_set = props.get("C:supported-calendar-component-set", "")
            if comp_set and "VTODO" in comp_set.upper():
                col_type = "etebase.vtodo"
                meta_mappings = MetaMappingTaskList()
            else:
                col_type = "etebase.vevent"
                meta_mappings = MetaMappingCalendar()
        else:
            # Default to calendar
            col_type = "etebase.vevent"
            meta_mappings = MetaMappingCalendar()

        # Map Radicale props to Etebase meta
        meta = {}
        for key, value in props.items():
            if key == "tag":
                continue
            mapped_key, mapped_value = meta_mappings.map_set(key, value)
            if mapped_value is not None:
                meta[mapped_key] = mapped_value

        if "name" not in meta:
            # Use last path component as display name fallback
            meta["name"] = attributes[-1]

        # Create the collection via Etebase
        col_mgr = self.etesync.etebase.get_collection_manager()
        col = col_mgr.create(col_type, meta, b"")
        col_mgr.upload(col)

        # Cache it locally
        from ..local_cache import models, db
        with db.database_proxy:
            cache_col = models.CollectionEntity(
                local_user=self.etesync.user,
                uid=col.uid,
            )
            cache_col.eb_col = col_mgr.cache_save(col)
            cache_col.stoken = col.stoken or ""
            cache_col.local_stoken = col.stoken or ""
            cache_col.new = False
            cache_col.dirty = False
            cache_col.save()

        logger.info("Created collection %s (type=%s, name=%s)", col.uid, col_type, meta.get("name"))
        log_sync_event("sync", f"Created collection {meta.get('name', col.uid)}")

        # Upload any items that came with the collection
        collection = Collection(self, posixpath.join("/", attributes[0], col.uid))
        if items:
            for item in items:
                collection.upload(item.href, item)

        return collection

    @contextmanager
    def acquire_lock(self, mode, user=""):
        """Acquire storage lock and sync with Etebase server."""
        if not user:
            yield
            return

        sync_thread = start_sync_thread(user)
        logger.info("acquire_lock(%s, user=%s): pre-yield sync", mode, user)
        sync_thread.force_sync()
        try:
            sync_thread.wait_for_sync(20)
        except Exception as e:
            logger.warning(
                "Sync failed for user %s, continuing with local cache: %s", user, e
            )

        with self._etesync_user_lock, etesync_for_user(user) as (etesync, _):
            self.user = user
            self.etesync = etesync

            yield

            if mode == "w":
                # Push dirty items inline — the SyncThread can't acquire
                # _get_etesync_lock while we hold it, so push here directly.
                logger.info("acquire_lock(w): post-write — pushing inline")
                try:
                    etesync.push_collection_list()
                    for col in etesync.list():
                        if etesync.collection_is_dirty(col.uid):
                            logger.info("acquire_lock: pushing dirty collection %s", col.uid[:8])
                            etesync.push_collection(col.uid)
                    logger.info("acquire_lock(w): inline push done")
                except Exception as e:
                    logger.warning("acquire_lock(w): inline push FAILED: %s", e)

            self.etesync = None
            self.user = None
