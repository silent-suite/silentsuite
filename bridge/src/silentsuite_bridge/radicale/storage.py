"""Radicale storage backend for SilentSuite Bridge.

Bridges between Radicale's CalDAV/CardDAV engine and the Etebase
protocol via the local cache layer. This is the core translation
layer that makes standard CalDAV clients work with E2EE data.

Forked and adapted from etesync-dav (AGPL-3.0).
Original: https://github.com/etesync/etesync-dav
"""

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
from ..local_cache.models import HrefMapper
from .etesync_cache import etesync_for_user

logger = logging.getLogger("silentsuite-bridge.storage")


# --- Sync Thread ---

SYNC_INTERVAL = config.SYNC_INTERVAL
SYNC_MINIMUM = config.SYNC_MINIMUM


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

    def force_sync(self):
        self._force_sync.set()
        self._done_syncing.clear()

    def request_sync(self):
        if self.last_sync and time.time() - self.last_sync >= SYNC_MINIMUM:
            self.force_sync()

    @property
    def forced_sync(self):
        return self._force_sync.is_set()

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
                    etesync.sync()
                    logger.debug("Sync completed for user %s", self.user)
            except Exception as e:
                logger.exception("Sync error for user %s: %s", self.user, e)
                self._exception = e
            finally:
                self._force_sync.clear()
                self._done_syncing.set()

            self._force_sync.wait(SYNC_INTERVAL)


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
                self.set_meta({"tag": "VCALENDAR"})
                self.content_suffix = ".ics"
            elif col_type == "etebase.vtodo":
                self.meta_mappings = MetaMappingTaskList()
                self.set_meta({"tag": "VCALENDAR"})
                self.content_suffix = ".ics"
            elif col_type == "etebase.vcard":
                self.meta_mappings = MetaMappingContacts()
                self.set_meta({"tag": "VADDRESSBOOK"})
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
        return self.get_meta("tag") or ""

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
            try:
                href_mapper = item.cache_item.href.get()
            except HrefMapper.DoesNotExist:
                href = item.item.uid + self.content_suffix
                href_mapper = HrefMapper(content=item.cache_item, href=href)
                href_mapper.save(force_insert=True)

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
            href_mapper = HrefMapper.get(HrefMapper.href == href)
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

        return EteSyncItem(
            collection=self,
            vobject_item=item,
            href=href,
            last_modified="",
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
        else:
            etesync_item = self.collection.create(vobject_item)
            etesync_item.save()
            href_mapper = HrefMapper(
                content=etesync_item.cache_item, href=href
            )
            href_mapper.save(force_insert=True)

        return self._get(href)

    def delete(self, href=None):
        """Delete an item. When href is None, delete the collection."""
        if self.is_fake:
            return

        if href is None:
            self.collection.delete()
            return

        item = self._get(href)
        if item is None:
            raise ComponentNotFoundError(href)

        item.etesync_item.delete()

    def get_meta(self, key=None):
        if self.is_fake:
            return {}

        if key is None:
            ret = {}
            meta = self.collection.meta
            for key in meta.keys():
                ret[key] = self.meta_mappings.map_get(meta, key)[1]
            return ret
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

    _sync_thread_lock = threading.RLock()
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
                yield collection._get(item)
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
        raise NotImplementedError

    @contextmanager
    def acquire_lock(self, mode, user=""):
        """Acquire storage lock and sync with Etebase server."""
        if not user:
            yield
            return

        with etesync_for_user(user) as (etesync, _):
            with self.__class__._sync_thread_lock:
                if not hasattr(etesync, "sync_thread"):
                    etesync.sync_thread = SyncThread(user, daemon=True)
                    etesync.sync_thread.start()
                else:
                    etesync.sync_thread.request_sync()

        etesync.sync_thread.wait_for_sync(5)

        with self._etesync_user_lock, etesync_for_user(user) as (etesync, _):
            self.user = user
            self.etesync = etesync

            yield

            if mode == "w":
                etesync.sync_thread.force_sync()

            self.etesync = None
            self.user = None
