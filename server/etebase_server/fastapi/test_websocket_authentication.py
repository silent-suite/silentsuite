"""Tests for websocket ticket authentication.

A subscription ticket is issued over HTTP to an authenticated member and
redeemed later on the websocket route. HTTP token auth refuses inactive users
(`dependencies.py`), so a user deactivated between getting a ticket and
connecting must be refused at the websocket handshake too — before `accept()`,
before the Redis subscription and before any catch-up frame carrying the
collection's encrypted items. An active user must keep connecting and
receiving catch-up data.

Redis is replaced by a deterministic in-memory transport on the real `redisw`
wrapper. Ticket issuance, ticket consumption, the configured user-queryset
lookup and the websocket endpoint itself all run unmodified.
"""

from __future__ import annotations

import asyncio
import contextlib
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


class FakePubSub:
    def __init__(self, redis: FakeRedis):
        self._redis = redis

    async def subscribe(self, *channels):
        self._redis.subscriptions.extend(channels)

    async def get_message(self, ignore_subscribe_messages=False, timeout=0.0):
        # Nothing publishes in these tests: idle for the poll like an empty channel.
        await asyncio.sleep(timeout)
        return None


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
    `first_frame` is the first catch-up frame of an accepted connection.
    """
    session = client.websocket_connect(f"{WS_PREFIX}/{ticket}/")
    try:
        ws = session.__enter__()
    except WebSocketDisconnect as exc:
        return exc.code, None
    try:
        return None, ws.receive_bytes()
    finally:
        # Only the handshake and the first catch-up frame are under test. The
        # live-update loop that follows is out of scope; on Python 3.11+ its
        # `asyncio.wait()` rejects the bare coroutine it is given, so an error
        # while tearing down an accepted session is not this test's signal.
        with contextlib.suppress(Exception):
            session.__exit__(None, None, None)


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
