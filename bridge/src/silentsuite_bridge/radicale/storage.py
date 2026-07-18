"""Radicale storage backend for SilentSuite Bridge.

Bridges between Radicale's CalDAV/CardDAV engine and the Etebase
protocol via the local cache layer. This is the core translation
layer that makes standard CalDAV clients work with E2EE data.

Forked and adapted from etesync-dav (AGPL-3.0).
Original: https://github.com/etesync/etesync-dav
"""

import email.utils
import hashlib
import logging
import posixpath
import re
import secrets
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
from ..local_cache import (
    dav_collection_state_hash,
    db,
    is_safe_dav_href,
    opaque_dav_href,
    record_dav_change,
)
from ..local_cache.models import (
    CollectionEntity,
    DavChange,
    DavRevision,
    DavSyncToken,
    HrefMapper,
    ItemEntity,
)
from ..web import log_sync_event, update_status
from .etesync_cache import etesync_for_user, forget_etesync_user

logger = logging.getLogger("silentsuite-bridge.storage")
_DAV_SESSION_LOCK_TIMEOUT = 2.0


# --- Sync Thread ---

SYNC_MINIMUM = config.SYNC_MINIMUM
_GENERATION_STATUS_RETENTION = 100

# Global registry of sync threads keyed by username
_sync_threads = {}
_sync_threads_lock = threading.Lock()
_dav_token_locks = {}
_dav_token_locks_lock = threading.Lock()


def _dav_token_lock(collection_id):
    with _dav_token_locks_lock:
        return _dav_token_locks.setdefault(collection_id, threading.Lock())


class SyncThread(threading.Thread):
    """Background thread that periodically syncs with the Etebase server."""

    def __init__(self, user, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._force_sync = threading.Event()
        self._stop_sync = threading.Event()
        self._done_syncing = threading.Event()
        self._done_syncing.set()
        self._generation_condition = threading.Condition()
        self._next_generation = 0
        self._requested_generation = None
        self._active_generation = None
        self._generation_statuses = {}
        self.user = user
        self.last_sync = None
        self.interval = config.SYNC_INTERVAL
        # Progress tracking — etebase-py doesn't expose per-item hooks, so we
        # can only report "a sync is in flight" plus the last sync's duration.
        self.is_syncing = False
        self.sync_started_at = None
        self.last_sync_duration = None

    def force_sync(self, *, deadline=None, after_generation=None):
        with self._generation_condition:
            if self._stop_sync.is_set():
                self._next_generation += 1
                generation = self._next_generation
                self._generation_statuses[generation] = {
                    "generation": generation,
                    "state": "failed",
                    "started_at": None,
                    "completed_at": time.time(),
                    "error_code": "SyncStopped",
                    "deadline": deadline,
                }
                self._generation_condition.notify_all()
                return generation
            if (
                self._active_generation is not None
                and (
                    after_generation is None
                    or self._active_generation > after_generation
                )
            ):
                status = self._generation_statuses[self._active_generation]
                if deadline is not None and status.get("deadline") is None:
                    status["deadline"] = deadline
                return self._active_generation
            if (
                self._requested_generation is not None
                and (
                    after_generation is None
                    or self._requested_generation > after_generation
                )
            ):
                status = self._generation_statuses[self._requested_generation]
                if deadline is not None and status.get("deadline") is None:
                    status["deadline"] = deadline
                return self._requested_generation
            self._next_generation += 1
            generation = self._next_generation
            self._requested_generation = generation
            self._generation_statuses[generation] = {
                "generation": generation,
                "state": "pending",
                "started_at": None,
                "completed_at": None,
                "error_code": None,
                "deadline": deadline,
            }
            self._force_sync.set()
            self._done_syncing.clear()
            return generation

    def stop(self):
        """Request a clean shutdown and wake any interval wait."""
        self._stop_sync.set()
        with self._generation_condition:
            generation = self._requested_generation
            if generation is not None and generation != self._active_generation:
                self._generation_statuses[generation].update({
                    "state": "failed",
                    "completed_at": time.time(),
                    "error_code": "SyncStopped",
                })
                self._requested_generation = None
                self._generation_condition.notify_all()
        self._force_sync.set()

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
        with self._generation_condition:
            generation = (
                self._requested_generation
                or self._active_generation
                or (self._next_generation if self._next_generation else None)
            )
        if generation is None:
            return True
        if not self.wait_for_generation(generation, timeout):
            return False
        status = self.generation_status(generation)
        if status["state"] == "failed":
            raise RuntimeError(status["error_code"] or "SyncFailure")
        return status["state"] == "succeeded"

    def generation_status(self, generation):
        with self._generation_condition:
            status = self._generation_statuses.get(generation)
            return self._generation_status_snapshot(status)

    def generation_handle(self, generation):
        """Return a stable in-process handle retained by dashboard requests."""
        with self._generation_condition:
            return self._generation_statuses.get(generation)

    def generation_status_for_handle(self, status):
        with self._generation_condition:
            return self._generation_status_snapshot(status)

    def _generation_status_snapshot(self, status):
        if (
            status is not None
            and status["state"] in {"pending", "running"}
            and status.get("deadline") is not None
            and time.time() >= status["deadline"]
        ):
            status.update({
                "state": "timed_out",
                "completed_at": status["deadline"],
                "error_code": "SyncTimeout",
            })
        return dict(status) if status is not None else None

    def wait_for_generation(self, generation, timeout=None):
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._generation_condition:
            while True:
                status = self._generation_statuses.get(generation)
                if status is None:
                    return False
                self._generation_status_snapshot(status)
                if status["state"] in {"succeeded", "failed", "timed_out"}:
                    return True
                caller_remaining = (
                    None if deadline is None else deadline - time.monotonic()
                )
                if caller_remaining is not None and caller_remaining <= 0:
                    return False
                remaining = caller_remaining
                if status.get("deadline") is not None:
                    wall_remaining = status["deadline"] - time.time()
                    if wall_remaining <= 0:
                        continue
                    remaining = (
                        wall_remaining
                        if remaining is None
                        else min(remaining, wall_remaining)
                    )
                self._generation_condition.wait(remaining)

    def _begin_generation(self):
        with self._generation_condition:
            self._force_sync.clear()
            generation = self._requested_generation
            if generation is None:
                self._next_generation += 1
                generation = self._next_generation
                self._generation_statuses[generation] = {
                    "generation": generation,
                    "state": "pending",
                    "started_at": None,
                    "completed_at": None,
                    "error_code": None,
                    "deadline": None,
                }
            self._requested_generation = None
            self._active_generation = generation
            started_at = time.time()
            status = self._generation_statuses[generation]
            if status["state"] != "timed_out":
                status.update({
                    "state": "running",
                    "started_at": started_at,
                })
            self._done_syncing.clear()
            return generation, started_at

    def _complete_generation(self, generation, state, completed_at, error_code=None):
        with self._generation_condition:
            status = self._generation_statuses[generation]
            deadline = status.get("deadline")
            if (
                status["state"] != "timed_out"
                and deadline is not None
                and completed_at >= deadline
            ):
                status.update({
                    "state": "timed_out",
                    "completed_at": deadline,
                    "error_code": "SyncTimeout",
                })
            elif status["state"] != "timed_out":
                status.update({
                    "state": state,
                    "completed_at": completed_at,
                    "error_code": error_code,
                })
            if self._requested_generation == generation:
                self._requested_generation = None
            if self._active_generation == generation:
                self._active_generation = None
            if self._requested_generation is None:
                self._done_syncing.set()
            else:
                self._done_syncing.clear()
            self._generation_condition.notify_all()
            terminal = [
                key
                for key, value in self._generation_statuses.items()
                if value["state"] in {"succeeded", "failed", "timed_out"}
            ]
            for expired in terminal[:-_GENERATION_STATUS_RETENTION]:
                del self._generation_statuses[expired]

    def run(self):
        while not self._stop_sync.is_set():
            generation, started_at = self._begin_generation()
            state = "failed"
            error_code = None
            try:
                if self._stop_sync.is_set():
                    break
                with etesync_for_user(self.user) as (etesync, _):
                    if self._stop_sync.is_set():
                        break
                    self.is_syncing = True
                    self.sync_started_at = started_at
                    etesync.sync()
                    completed_at = time.time()
                    self.last_sync_duration = completed_at - self.sync_started_at
                    self.is_syncing = False
                    with self._generation_condition:
                        status = self._generation_status_snapshot(
                            self._generation_statuses[generation]
                        )
                    if status["state"] == "timed_out":
                        state = "timed_out"
                        error_code = "SyncTimeout"
                        logger.warning("Sync returned after its generation deadline")
                        update_status("error", error="SyncTimeout", account=self.user)
                        log_sync_event("error", "Sync timed out")
                    else:
                        state = "succeeded"
                        logger.debug("Sync completed for configured account")

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
                    if state == "succeeded":
                        update_status(
                            "connected",
                            collections=collections,
                            account=self.user,
                        )
                        log_sync_event("sync", "Synced account")
            except Exception as e:
                error_code = e.__class__.__name__
                logger.warning(
                    "Sync failed for configured account (%s)",
                    error_code,
                )
                update_status("error", error=error_code)
                log_sync_event("error", "Sync failed")
            finally:
                completed_at = time.time()
                if self.sync_started_at is not None:
                    self.last_sync_duration = completed_at - self.sync_started_at
                if state == "succeeded":
                    self.last_sync = completed_at
                self.is_syncing = False
                self._complete_generation(
                    generation,
                    state,
                    completed_at,
                    error_code,
                )

            if self._stop_sync.is_set():
                break
            self._force_sync.wait(self.interval)


def start_sync_thread(user):
    """Start a SyncThread for the given user if one isn't already running.

    Returns the SyncThread instance.
    """
    with _sync_threads_lock:
        thread = _sync_threads.get(user)
        stop_event = getattr(thread, "_stop_sync", None)
        is_stopping = stop_event is not None and stop_event.is_set() is True
        if (
            thread is not None
            and thread.is_alive()
            and not is_stopping
        ):
            return thread
        thread = SyncThread(user, daemon=True)
        _sync_threads[user] = thread
        thread.start()
        logger.info("Started SyncThread (interval=%ds)", thread.interval)
        return thread


def refresh_sync_thread(user):
    """Start or wake one user's SyncThread after credentials changed."""
    with _sync_threads_lock:
        existing = _sync_threads.get(user)
        had_live_thread = existing is not None and existing.is_alive()

    forget_etesync_user(user)
    thread = start_sync_thread(user)
    if had_live_thread and thread.is_alive():
        thread.force_sync()
    return thread


def get_sync_thread(user):
    """Get the SyncThread for a user, or None."""
    with _sync_threads_lock:
        return _sync_threads.get(user)


def stop_sync_thread(user, timeout=2.0):
    """Stop and remove one user's SyncThread.

    Returns True when no live thread remains. If shutdown times out, the old
    thread stays registered so start_sync_thread will not create a duplicate.
    """
    with _sync_threads_lock:
        thread = _sync_threads.get(user)

    if thread is None:
        return True

    thread.stop()
    if thread is threading.current_thread():
        logger.warning("SyncThread cannot join itself")
        return False
    thread.join(timeout)

    with _sync_threads_lock:
        current = _sync_threads.get(user)
        if current is not thread:
            return True
        if thread.is_alive():
            logger.warning("Timed out stopping SyncThread")
            return False
        del _sync_threads[user]
        logger.info("Stopped SyncThread")
        return True


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
        return f'"dav-{self.collection.cache_col.dav_revision}"'

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
        collection_id = self.collection.cache_col.id
        with _dav_token_lock(collection_id):
            with db.database_proxy.atomic("IMMEDIATE"):
                return self._sync_locked(old_token)

    def _sync_locked(self, old_token=None):
        token_prefix = "http://radicale.org/ns/sync/"
        self._sanitize_href_mappings()
        self.collection.cache_col = CollectionEntity.get_by_id(
            self.collection.cache_col.id
        )
        revision = self.collection.cache_col.dav_revision
        token_cutoff = int(time.time()) - config.DAV_SYNC_TOKEN_MAX_AGE
        DavSyncToken.delete().where(
            (DavSyncToken.collection == self.collection.cache_col)
            & (DavSyncToken.created_at < token_cutoff)
        ).execute()
        state_hash = dav_collection_state_hash(self.collection.cache_col)
        current_token_row = DavSyncToken.get_or_none(
            (DavSyncToken.collection == self.collection.cache_col)
            & (DavSyncToken.revision == revision)
        )
        if current_token_row is not None:
            state_is_proven = current_token_row.state_hash == state_hash
        elif revision:
            current_revision_row = DavRevision.get_or_none(
                (DavRevision.collection == self.collection.cache_col)
                & (DavRevision.revision == revision)
            )
            state_is_proven = (
                current_revision_row is not None
                and current_revision_row.state_hash == state_hash
            )
        else:
            state_is_proven = True
        if not state_is_proven:
            DavSyncToken.delete().where(
                DavSyncToken.collection == self.collection.cache_col
            ).execute()
            current_token_row = None
        if current_token_row is None:
            current_token_row = DavSyncToken.create(
                collection=self.collection.cache_col,
                revision=revision,
                token=secrets.token_urlsafe(24),
                created_at=int(time.time()),
                state_hash=state_hash,
            )
        self._prune_sync_history()
        token = token_prefix + current_token_row.token

        if not old_token:
            return token, self._list()
        if not old_token.startswith(token_prefix):
            raise ValueError("invalid sync token")
        old_token_value = old_token[len(token_prefix):]
        token_row = DavSyncToken.get_or_none(
            (DavSyncToken.collection == self.collection.cache_col)
            & (DavSyncToken.token == old_token_value)
        )
        if token_row is None or token_row.revision > revision:
            raise ValueError("unknown sync token")
        if old_token == token:
            return token, []
        changed_revisions = (
            DavRevision.select(DavRevision.href)
            .where(
                (DavRevision.collection == self.collection.cache_col)
                & (DavRevision.revision > token_row.revision)
                & (DavRevision.revision <= revision)
            )
            .order_by(DavRevision.revision)
        )
        expected_revisions = revision - token_row.revision
        if changed_revisions.count() != expected_revisions:
            raise ValueError("unknown sync token")
        changed_hrefs = sorted({change.href for change in changed_revisions})
        return token, changed_hrefs

    def _sanitize_href_mappings(self):
        cache_col = self.collection.cache_col
        replaced = False
        for cache_item in cache_col.items:
            mapper = HrefMapper.get_or_none(HrefMapper.content == cache_item)
            if mapper is None or is_safe_dav_href(mapper.href):
                continue
            identity = cache_item.remote_uid or cache_item.uid
            mapper.href = opaque_dav_href(identity, self.content_suffix)
            mapper.save(only=[HrefMapper.href])
            replaced = True
        if replaced:
            DavSyncToken.delete().where(
                DavSyncToken.collection == cache_col
            ).execute()

    def _prune_sync_history(self):
        cache_col = self.collection.cache_col
        retained_tokens = (
            DavSyncToken.select(DavSyncToken.id, DavSyncToken.revision)
            .where(DavSyncToken.collection == cache_col)
            .order_by(DavSyncToken.revision.desc(), DavSyncToken.id.desc())
        )
        expired_ids = [
            row.id
            for row in retained_tokens.offset(config.DAV_SYNC_TOKEN_RETENTION)
        ]
        if expired_ids:
            DavSyncToken.delete().where(DavSyncToken.id.in_(expired_ids)).execute()

        oldest_token = (
            DavSyncToken.select(DavSyncToken.revision)
            .where(DavSyncToken.collection == cache_col)
            .order_by(DavSyncToken.revision)
            .first()
        )
        if oldest_token is not None:
            DavChange.delete().where(
                (DavChange.collection == cache_col)
                & (DavChange.revision <= oldest_token.revision)
            ).execute()
            DavRevision.delete().where(
                (DavRevision.collection == cache_col)
                & (DavRevision.revision <= oldest_token.revision)
            ).execute()

        revision_count = DavRevision.select().where(
            DavRevision.collection == cache_col
        ).count()
        if revision_count > config.DAV_CHANGE_RETENTION:
            cutoff = (
                DavRevision.select(DavRevision.revision)
                .where(DavRevision.collection == cache_col)
                .order_by(DavRevision.revision.desc())
                .offset(config.DAV_CHANGE_RETENTION - 1)
                .first()
            )
            if cutoff is not None:
                DavChange.delete().where(
                    (DavChange.collection == cache_col)
                    & (DavChange.revision < cutoff.revision)
                ).execute()
                DavRevision.delete().where(
                    (DavRevision.collection == cache_col)
                    & (DavRevision.revision < cutoff.revision)
                ).execute()
                DavSyncToken.delete().where(
                    (DavSyncToken.collection == cache_col)
                    & (DavSyncToken.revision < cutoff.revision)
                ).execute()

    def _list(self):
        """List collection items by their CalDAV/CardDAV hrefs."""
        if self.is_fake:
            return

        for item in self.collection.list():
            remote_identity = item.cache_item.remote_uid or str(item.item.uid)
            href = (
                hashlib.sha256(remote_identity.encode()).hexdigest()
                + self.content_suffix
            )
            href_mapper, _ = HrefMapper.get_or_create(
                content=item.cache_item, defaults={"href": href}
            )
            if not is_safe_dav_href(href_mapper.href):
                href_mapper.href = href
                href_mapper.save(only=[HrefMapper.href])
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

        href_mapper = (
            HrefMapper
            .select(HrefMapper, ItemEntity)
            .join(ItemEntity)
            .where(
                (HrefMapper.href == href)
                & (ItemEntity.collection == self.collection.cache_col)
                & (ItemEntity.deleted == False)  # noqa: E712
            )
            .first()
        )
        if href_mapper is None:
            return None
        uid = href_mapper.content.uid

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

        except Exception:
            raise RuntimeError("Failed to parse DAV item") from None

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

        with db.database_proxy.atomic():
            existing = self._get(href)
            if existing is not None:
                etesync_item = existing.etesync_item
                etesync_item.content = vobject_item.serialize()
                etesync_item.save()
                event = "Updated item"
            else:
                stale_mappers = list(
                    HrefMapper
                    .select(HrefMapper, ItemEntity)
                    .join(ItemEntity)
                    .where(
                        (HrefMapper.href == href)
                        & (ItemEntity.collection == self.collection.cache_col)
                        & (ItemEntity.deleted == True)  # noqa: E712
                    )
                )
                for stale_mapper in stale_mappers:
                    stale_item = stale_mapper.content
                    stale_mapper.delete_instance()
                    tombstone_identity = stale_item.remote_uid or stale_item.eb_item.hex()
                    stale_item.uid = (
                        "dav-tombstone:"
                        + hashlib.sha256(str(tombstone_identity).encode()).hexdigest()
                    )
                    stale_item.save(only=[ItemEntity.uid])
                etesync_item = self.collection.create(vobject_item)
                etesync_item.save()
                href_mapper = HrefMapper(
                    content=etesync_item.cache_item, href=href
                )
                href_mapper.save(force_insert=True)
                event = "Created item"

            record_dav_change(
                self.collection.cache_col,
                href,
                etag=etesync_item.etag,
                deleted=False,
            )
        log_sync_event("sync", event)
        return self._get(href)

    def delete(self, href=None):
        """Delete an item. When href is None, delete the collection."""
        if self.is_fake:
            return

        if href is None:
            self.collection.delete()
            log_sync_event("sync", "Deleted collection")
            return

        item = self._get(href)
        if item is None:
            raise ComponentNotFoundError(href)

        with db.database_proxy.atomic():
            etag = item.etesync_item.etag
            item.etesync_item.delete()
            record_dav_change(
                self.collection.cache_col,
                href,
                etag=etag,
                deleted=True,
            )
        log_sync_event("sync", "Deleted item")

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


class PrincipalDiscoveryCollection(Collection):
    """Static authenticated DAV discovery container with no account children."""

    @property
    def is_principal(self) -> bool:
        return False

    @property
    def owner(self) -> str:
        return ""


# --- Radicale Storage ---


class Storage(BaseStorage):
    """Radicale storage that serves Etebase data via local cache."""

    @property
    def user(self):
        return getattr(self._request_context, "user", None)

    @user.setter
    def user(self, value):
        self._request_context.user = value

    @property
    def etesync(self):
        return getattr(self._request_context, "etesync", None)

    @etesync.setter
    def etesync(self, value):
        self._request_context.etesync = value

    def __init__(self, configuration):
        self._request_context = threading.local()
        super().__init__(configuration)

    def verify(self):
        """Verify storage is accessible."""
        return True

    def _path_belongs_to_user(self, path):
        attributes = _get_attributes_from_path(path)
        return not self.user or not attributes or attributes[0] == self.user

    def discover(self, path, depth="0"):
        """Discover collections and items under the given path."""
        attributes = _get_attributes_from_path(path)
        if self.user and attributes == ["principals"]:
            yield PrincipalDiscoveryCollection(self, "/principals/")
            return

        if (
            self.user
            and self.etesync is None
            and (not attributes or attributes == [self.user])
        ):
            yield Collection(self, path)
            if depth == "0":
                return
            if self.etesync is None:
                with self._acquire_read_backend():
                    discovered = self.discover(path, depth)
                    next(discovered, None)
                    yield from discovered
                return

        if self.user and self.etesync is None:
            with self._acquire_read_backend():
                yield from self.discover(path, depth)
            return

        if not self._path_belongs_to_user(path):
            logger.warning("Rejecting DAV path for configured account")
            return

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
                if journal.col_type not in config.COL_TYPES:
                    continue
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
        if not self._path_belongs_to_user(href):
            logger.warning(
                "Rejecting collection create path for configured account"
            )
            raise ComponentNotFoundError(href)

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

        # Create and cache locally. The background generation queued by the
        # write lock performs the potentially unbounded upstream upload.
        col_mgr = self.etesync.etebase.get_collection_manager()
        col = col_mgr.create(col_type, meta, b"")

        # Cache it locally
        from ..local_cache import db, models
        with db.database_proxy:
            cache_col = models.CollectionEntity(
                local_user=self.etesync.user,
                uid=col.uid,
            )
            cache_col.eb_col = col_mgr.cache_save(col)
            cache_col.stoken = col.stoken or ""
            cache_col.local_stoken = col.stoken or ""
            cache_col.new = True
            cache_col.dirty = False
            cache_col.save()

        logger.info("Created collection (type=%s)", col_type)
        log_sync_event("sync", "Created collection")

        # Upload any items that came with the collection
        collection = Collection(self, posixpath.join("/", attributes[0], col.uid))
        if items:
            for item in items:
                collection.upload(item.href, item)

        return collection

    @contextmanager
    def acquire_lock(self, mode, user=""):
        """Acquire request-local storage context and sync when required."""
        if not user:
            yield
            return

        if mode == "r":
            self.user = user
            try:
                yield
            finally:
                self.etesync = None
                self.user = None
            return

        sync_thread = start_sync_thread(user)
        logger.info("acquire_lock(%s): pre-yield sync", mode)
        initial_generation = sync_thread.force_sync()
        try:
            if not sync_thread.wait_for_sync(20):
                logger.warning(
                    "Sync timed out for configured account; continuing with local cache"
                )
        except Exception as exc:
            logger.warning(
                "Sync failed for configured account; continuing with local cache (%s)",
                exc.__class__.__name__,
            )

        session_options = (
            {"exclusive": False, "read_only": False}
            if mode == "w"
            else {"timeout": _DAV_SESSION_LOCK_TIMEOUT}
        )
        with etesync_for_user(user, **session_options) as (etesync, _):
            self.user = user
            self.etesync = etesync
            try:
                yield
            finally:
                self.etesync = None
                self.user = None

        if mode == "w":
            logger.info("acquire_lock(w): queued background push")
            sync_thread.force_sync(after_generation=initial_generation)

    @contextmanager
    def _acquire_read_backend(self):
        """Open an independent local-cache reader without waiting on remote sync."""
        user = self.user
        sync_thread = start_sync_thread(user)
        logger.info("acquire_lock(r): requesting background sync")
        sync_thread.force_sync()

        with etesync_for_user(user, exclusive=False) as (etesync, _):
            self.etesync = etesync
            try:
                yield
            finally:
                self.etesync = None
