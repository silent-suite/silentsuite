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
        # Expiry (`ex`, seconds) passed with each SET; expiry itself is not modelled.
        self.expiries: dict[bytes, t.Optional[int]] = {}
        # Command names of each executed pipeline, with its transaction flag.
        self.transactions: list[t.Tuple[bool, t.List[str]]] = []
        # Published payloads per channel. deque append/popleft are thread-safe,
        # so the test thread can publish while the websocket runs in its own.
        self.channels: t.DefaultDict[str, t.Deque[bytes]] = collections.defaultdict(collections.deque)
        # Every pub/sub handed out, so tests can check each one was closed.
        self.pubsubs: list[FakePubSub] = []

    @staticmethod
    def _key(name) -> bytes:
        return name.encode() if isinstance(name, str) else bytes(name)

    async def set(self, name, value, ex=None):
        self.store[self._key(name)] = value
        self.expiries[self._key(name)] = ex
        return True

    async def get(self, name):
        return self.store.get(self._key(name))

    async def delete(self, *names):
        return sum(self.store.pop(self._key(name), None) is not None for name in names)

    def pubsub(self):
        pubsub = FakePubSub(self)
        self.pubsubs.append(pubsub)
        return pubsub

    def deliver(self, channel: str, data: bytes) -> None:
        """Publish from the (synchronous) test thread."""
        self.channels[channel].append(data)

    def pipeline(self, transaction=True):
        return FakePipeline(self, transaction)


class FakePipeline:
    """Queues commands and runs them back to back on `execute()`, like MULTI/EXEC.
    Nothing else runs on the event loop in between, so the queued commands are
    atomic with respect to other coroutines."""

    def __init__(self, redis: FakeRedis, transaction: bool):
        self._redis = redis
        self._transaction = transaction
        self._queue: list[t.Tuple[str, tuple]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        self._queue = []

    def get(self, name):
        self._queue.append(("get", (name,)))
        return self

    def delete(self, *names):
        self._queue.append(("delete", names))
        return self

    async def execute(self):
        queue, self._queue = self._queue, []
        self._redis.transactions.append((self._transaction, [command for command, _ in queue]))
        results = []
        for command, args in queue:
            results.append(await getattr(self._redis, command)(*args))
        return results


class FakePubSub:
    def __init__(self, redis: FakeRedis):
        self._redis = redis
        self._channels: list[str] = []
        self.closed = False

    async def aclose(self):
        # redis-py drops the connection, which ends every subscription on it.
        self._channels = []
        self.closed = True

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
    try:
        return None, ws.receive_bytes()
    finally:
        session.__exit__(None, None, None)


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
class TestWebsocketTicketLifetime:
    def test_ticket_expires_after_ten_seconds(self, ws_client, fake_redis, membership):
        from etebase_server.fastapi.routers.websocket import TICKET_VALIDITY_SECONDS

        ticket = _issue_ticket(ws_client, membership)

        # Redis `ex` is in seconds: the ticket must live ten seconds, not ten
        # thousand.
        assert TICKET_VALIDITY_SECONDS == 10
        assert fake_redis.expiries == {ticket.encode(): 10}

    def test_ticket_is_redeemed_once_atomically(self, ws_client, fake_redis, membership):
        ticket = _issue_ticket(ws_client, membership)

        close_code, frame = _connect(ws_client, ticket)
        assert close_code is None
        assert frame is not None

        # Read and delete ran together in one MULTI/EXEC transaction.
        assert fake_redis.transactions == [(True, ["get", "delete"])]
        assert fake_redis.store == {}

        # A second connection with the same ticket is refused before accept.
        close_code, frame = _connect(ws_client, ticket)
        assert frame is None
        assert close_code == status.WS_1008_POLICY_VIOLATION
        assert fake_redis.subscriptions == [f"col.{membership.collection_uid}"]

    def test_unknown_ticket_is_refused(self, ws_client, fake_redis, membership):
        close_code, frame = _connect(ws_client, _uid("never-issued"))

        assert frame is None
        assert close_code == status.WS_1008_POLICY_VIOLATION
        assert fake_redis.subscriptions == []


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


@pytest.mark.django_db(transaction=True)
class TestWebsocketSubscriptionCleanup:
    """Each websocket opens its own Redis pub/sub connection. It must be closed
    when the socket ends, or every finished session keeps one Redis connection
    and subscription open."""

    def test_pubsub_is_closed_after_client_disconnects(self, ws_client, fake_redis, membership):
        ticket = _issue_ticket(ws_client, membership)

        with ws_client.websocket_connect(f"{WS_PREFIX}/{ticket}/") as ws:
            assert _frame_item_uids(ws.receive_bytes()) == [membership.item_uid]
            # Still subscribed while the live loop runs.
            assert [pubsub.closed for pubsub in fake_redis.pubsubs] == [False]

        assert fake_redis.subscriptions == [f"col.{membership.collection_uid}"]
        assert [pubsub.closed for pubsub in fake_redis.pubsubs] == [True]

    def test_pubsub_is_closed_when_collection_is_not_found(self, ws_client, fake_redis, membership):
        from etebase_server.django import models

        ticket = _issue_ticket(ws_client, membership)
        # Membership removed after the ticket was issued: the collection lookup
        # finds nothing and the handler returns before catch-up.
        models.CollectionMember.objects.filter(user=membership.user).delete()

        with ws_client.websocket_connect(f"{WS_PREFIX}/{ticket}/") as ws:
            with pytest.raises(WebSocketDisconnect) as closed:
                ws.receive_bytes()

        assert closed.value.code == status.WS_1008_POLICY_VIOLATION
        assert fake_redis.subscriptions == [f"col.{membership.collection_uid}"]
        assert [pubsub.closed for pubsub in fake_redis.pubsubs] == [True]

    def test_disconnect_during_catch_up_ends_quietly_and_closes_pubsub(self, fake_redis, membership):
        from etebase_server.fastapi.routers.websocket import TicketInner, TicketRequest, redis_connector

        class DisconnectedWebSocket:
            """Stands in for a socket whose client left before catch-up was sent:
            Starlette raises WebSocketDisconnect when sending to it."""

            sent = 0

            async def send_bytes(self, data):
                self.sent += 1
                raise WebSocketDisconnect(code=1006)

            async def receive(self):  # pragma: no cover - never reached
                raise AssertionError("live loop started after a failed catch-up")

            async def close(self, code=1000):  # pragma: no cover - never reached
                raise AssertionError("closed a socket that was already gone")

        ws = DisconnectedWebSocket()
        ticket_model = TicketInner(user=membership.user.id, req=TicketRequest(collection=membership.collection_uid))

        # Returns without raising WebSocketDisconnect.
        asyncio.run(redis_connector(ws, ticket_model, membership.user, None))

        assert ws.sent == 1
        assert fake_redis.subscriptions == [f"col.{membership.collection_uid}"]
        assert [pubsub.closed for pubsub in fake_redis.pubsubs] == [True]
