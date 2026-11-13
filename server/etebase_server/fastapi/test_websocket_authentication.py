"""Tests for websocket ticket authentication and update delivery.

A subscription ticket is issued over HTTP to an authenticated member and
redeemed later on the websocket route. HTTP token auth refuses inactive users
(`dependencies.py`), so a user deactivated between getting a ticket and
connecting must be refused at the websocket handshake too — before `accept()`,
before the Redis subscription and before any catch-up frame carrying the
collection's encrypted items. An active user must keep connecting and
receiving catch-up data, paged until done, and then live updates published
on the collection's Redis channel.

Redis is replaced by a deterministic in-memory transport on the real `redisw`
wrapper. Ticket issuance, ticket consumption, the configured user-queryset
lookup and the websocket endpoint itself all run unmodified.
"""

from __future__ import annotations

import asyncio
import collections
import time
import typing as t

import pytest
from fastapi import FastAPI, WebSocketDisconnect, status
from fastapi.testclient import TestClient

from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.utils import msgpack_decode

COLLECTION_PREFIX = "/api/v1/collection"
WS_PREFIX = "/api/v1/ws"

# Synthetic, obviously fake encrypted item metadata.
SYNTHETIC_META = b"synthetic-encrypted-item-meta"


# ---------------------------------------------------------------------------
# Deterministic Redis transport
# ---------------------------------------------------------------------------


class FakeRedis:
    """In-memory stand-in for the aioredis calls made by the ticket and websocket
    code. Keys are normalised to bytes like Redis does: the ticket is stored under
    the issued bytes uid and looked up by its str form from the websocket path."""

    def __init__(self):
        self.store: dict[bytes, bytes] = {}
        self.subscriptions: list[str] = []
        # Published payloads per channel. deque append/popleft are thread-safe,
        # so the test thread can publish while the websocket runs in its own.
        self.channels: t.DefaultDict[str, t.Deque[bytes]] = collections.defaultdict(collections.deque)

    @staticmethod
    def _key(name) -> bytes:
        return name.encode() if isinstance(name, str) else bytes(name)

    async def set(self, name, value, ex=None):
        # Ticket expiry is not under test here.
        self.store[self._key(name)] = value
        return True

    async def get(self, name):
        return self.store.get(self._key(name))

    async def delete(self, *names):
        return sum(self.store.pop(self._key(name), None) is not None for name in names)

    def pubsub(self):
        return FakePubSub(self)

    def deliver(self, channel: str, data: bytes) -> None:
        """Publish from the (synchronous) test thread."""
        self.channels[channel].append(data)


class FakePubSub:
    def __init__(self, redis: FakeRedis):
        self._redis = redis
        self._channels: list[str] = []

    async def subscribe(self, *channels):
        self._redis.subscriptions.extend(channels)
        self._channels.extend(channels)

    async def get_message(self, ignore_subscribe_messages=False, timeout=0.0):
        # Same shape as redis-py's asyncio PubSub: a dict per published
        # message, or None when nothing arrived within the timeout.
        deadline = time.monotonic() + timeout
        while True:
            for channel in self._channels:
                pending = self._redis.channels[channel]
                if pending:
                    return {"type": "message", "pattern": None, "channel": channel.encode(), "data": pending.popleft()}
            if time.monotonic() >= deadline:
                return None
            await asyncio.sleep(0.01)


@pytest.fixture
def fake_redis(monkeypatch) -> FakeRedis:
    from etebase_server.fastapi.redis import redisw

    fake = FakeRedis()
    # A non-None uri makes `redisw.is_active` true; nothing ever connects to it.
    monkeypatch.setattr(redisw, "redis_uri", "synthetic-fake-transport")
    monkeypatch.setattr(redisw, "redis", fake, raising=False)
    return fake


# ---------------------------------------------------------------------------
# App / client
# ---------------------------------------------------------------------------


@pytest.fixture
def ws_client(fake_redis) -> TestClient:
    """Mount the item and websocket routers with the same prefixes as
    `create_application` in main.py, plus the production `CustomHttpException`
    handler. `create_application` itself is not used: its startup hook would
    replace the fake transport with a real Redis client."""
    from etebase_server.fastapi.routers.collection import item_router
    from etebase_server.fastapi.routers.websocket import websocket_router

    app = FastAPI()
    app.include_router(item_router, prefix=f"{COLLECTION_PREFIX}/{{collection_uid}}")
    app.include_router(websocket_router, prefix=WS_PREFIX)

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


# ---------------------------------------------------------------------------
# Synthetic membership
# ---------------------------------------------------------------------------


class Membership(t.NamedTuple):
    user: t.Any
    collection_uid: str
    item_uid: str
    token: str


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43) unique per prefix."""
    return (prefix + "-" + "x" * 43)[:40]


@pytest.fixture
def membership(user_factory) -> Membership:
    """One collection holding one item, an ADMIN membership and an auth token for
    a synthetic user. No chunks, so serialization never touches media files."""
    from etebase_server.django import models
    from etebase_server.django.token_auth.models import AuthToken

    user = user_factory(username="test_user_ws", email="ws@example.com")
    collection = models.Collection.objects.create(uid=_uid("col-ws"), owner=user)
    item = models.CollectionItem.objects.create(uid=_uid("item-ws"), collection=collection, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("rev-ws"),
        stoken=models.Stoken.objects.create(),
        item=item,
        meta=SYNTHETIC_META,
        current=True,
    )
    collection_type = models.CollectionType.objects.create(uid=_uid("type-ws").encode(), owner=user)
    models.CollectionMember.objects.create(
        collection=collection,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=collection_type,
        stoken=models.Stoken.objects.create(),
    )
    token = AuthToken.objects.create(user=user).key
    return Membership(user=user, collection_uid=collection.uid, item_uid=item.uid, token=token)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _request_ticket(client: TestClient, membership: Membership):
    return client.post(
        f"{COLLECTION_PREFIX}/{membership.collection_uid}/item/subscription-ticket/",
        headers={"Accept": "application/msgpack", "Authorization": f"Token {membership.token}"},
    )


def _issue_ticket(client: TestClient, membership: Membership) -> str:
    response = _request_ticket(client, membership)
    assert response.status_code == 200, msgpack_decode(response.content)
    return msgpack_decode(response.content)["ticket"]


def _connect(client: TestClient, ticket: str) -> t.Tuple[t.Optional[int], t.Optional[bytes]]:
    """Open the websocket and return `(close_code, first_frame)`.

    `close_code` is set when the server closed the handshake without accepting.
    `first_frame` is the first catch-up frame of an accepted connection. An
    error raised by the server while the session is open (for example in the
    live-update loop that follows catch-up) is re-raised when it is closed.
    """
    session = client.websocket_connect(f"{WS_PREFIX}/{ticket}/")
    try:
        ws = session.__enter__()
    except WebSocketDisconnect as exc:
        return exc.code, None
    with session:
        return None, ws.receive_bytes()


def _add_items(membership: Membership, count: int) -> t.Set[str]:
    """Add `count` more items, each with its own current revision and stoken."""
    from etebase_server.django import models

    collection = models.Collection.objects.get(uid=membership.collection_uid)
    uids = set()
    for i in range(count):
        item = models.CollectionItem.objects.create(uid=_uid(f"item-ws-{i:03d}"), collection=collection, version=1)
        models.CollectionItemRevision.objects.create(
            uid=_uid(f"rev-ws-{i:03d}"),
            stoken=models.Stoken.objects.create(),
            item=item,
            meta=SYNTHETIC_META,
            current=True,
        )
        uids.add(item.uid)
    return uids


def _frame_item_uids(frame: bytes) -> t.List[str]:
    return [item["uid"] for item in msgpack_decode(frame)["data"]]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.django_db(transaction=True)
class TestWebsocketTicketUserState:
    def test_ticket_issued_while_active_is_refused_after_deactivation(self, ws_client, fake_redis, membership):
        ticket = _issue_ticket(ws_client, membership)

        membership.user.is_active = False
        membership.user.save(update_fields=["is_active"])

        # The HTTP boundary already refuses the deactivated user; only the
        # ticket issued while they were active is pending.
        assert _request_ticket(ws_client, membership).status_code in (401, 403)
        assert len(fake_redis.store) == 1

        close_code, frame = _connect(ws_client, ticket)

        assert frame is None, f"deactivated user received a catch-up frame for items {_frame_item_uids(frame)}"
        assert close_code == status.WS_1008_POLICY_VIOLATION
        # Refused before the connector subscribed or serialized anything, and the
        # ticket was still consumed.
        assert fake_redis.subscriptions == []
        assert fake_redis.store == {}

    def test_active_user_connects_and_receives_catch_up(self, ws_client, fake_redis, membership):
        ticket = _issue_ticket(ws_client, membership)

        close_code, frame = _connect(ws_client, ticket)

        assert close_code is None
        assert frame is not None
        payload = msgpack_decode(frame)
        assert _frame_item_uids(frame) == [membership.item_uid]
        assert bytes(payload["data"][0]["content"]["meta"]) == SYNTHETIC_META
        assert payload["done"] is True
        assert fake_redis.subscriptions == [f"col.{membership.collection_uid}"]
        assert fake_redis.store == {}


@pytest.mark.django_db(transaction=True)
class TestWebsocketUpdates:
    # Bounds the catch-up frames read, so a sender that never finishes fails
    # the test instead of hanging it.
    MAX_CATCH_UP_FRAMES = 3

    def test_catch_up_pages_past_the_first_50_items(self, ws_client, fake_redis, membership):
        expected = _add_items(membership, 50) | {membership.item_uid}
        assert len(expected) == 51
        ticket = _issue_ticket(ws_client, membership)

        frames = []
        with ws_client.websocket_connect(f"{WS_PREFIX}/{ticket}/") as ws:
            while len(frames) < self.MAX_CATCH_UP_FRAMES:
                frames.append(msgpack_decode(ws.receive_bytes()))
                if frames[-1]["done"]:
                    break

        pages = [[item["uid"] for item in frame["data"]] for frame in frames]
        assert [len(page) for page in pages] == [50, 1]
        assert [frame["done"] for frame in frames] == [False, True]
        assert set(pages[0]) | set(pages[1]) == expected
        assert frames[0]["stoken"] != frames[1]["stoken"]

    def test_live_update_is_forwarded_after_catch_up(self, ws_client, fake_redis, membership):
        live_frame = b"synthetic-live-update-frame"
        ticket = _issue_ticket(ws_client, membership)

        with ws_client.websocket_connect(f"{WS_PREFIX}/{ticket}/") as ws:
            assert _frame_item_uids(ws.receive_bytes()) == [membership.item_uid]

            fake_redis.deliver(f"col.{membership.collection_uid}", live_frame)

            assert ws.receive_bytes() == live_frame

    def test_client_data_closes_the_live_connection(self, ws_client, fake_redis, membership):
        ticket = _issue_ticket(ws_client, membership)

        with ws_client.websocket_connect(f"{WS_PREFIX}/{ticket}/") as ws:
            ws.receive_bytes()  # catch-up
            ws.send_bytes(b"unexpected")
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_bytes()

        assert closed.value.code == status.WS_1008_POLICY_VIOLATION
