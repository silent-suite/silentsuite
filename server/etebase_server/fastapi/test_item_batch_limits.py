"""Item batch and transaction requests carry a bounded number of items and deps.

Both routes process every item while holding the collection row lock, so an
unbounded list lets one request hold a sync worker and the lock for as long as
the request body allows. Requests over the cap are refused with the same
`too_many_items` error `fetch_updates` uses, before the lock is taken and
before anything is written. Shipped clients send at most 50 items per request.
"""

from __future__ import annotations

import itertools

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.utils import msgpack_decode, msgpack_encode

API = "/api/v1"
COLLECTION_PREFIX = f"{API}/collection"
ROUTES = ("batch", "transaction")

_counter = itertools.count()


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43), unique per call."""
    return f"{prefix}-{next(_counter):05d}-" + "x" * 25


@pytest.fixture
def client() -> TestClient:
    from etebase_server.fastapi.routers.collection import item_router

    app = FastAPI()
    app.include_router(item_router, prefix=f"{COLLECTION_PREFIX}/{{collection_uid}}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


@pytest.fixture
def owner(user_factory):
    return user_factory("batch-limit-owner")


@pytest.fixture
def collection(owner):
    from etebase_server.django import models

    uid = _uid("col")
    col = models.Collection.objects.create(uid=uid, owner=owner)
    item = models.CollectionItem.objects.create(uid=uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("rev"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=True
    )
    col.main_item = item
    col.save(update_fields=["main_item"])
    models.CollectionMember.objects.create(
        collection=col,
        user=owner,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=models.CollectionType.objects.create(uid=_uid("type").encode(), owner=owner),
        stoken=models.Stoken.objects.create(),
    )
    return col


def _headers(user) -> dict:
    from etebase_server.django.token_auth.models import AuthToken

    return {
        "Accept": "application/msgpack",
        "Content-Type": "application/msgpack",
        "Authorization": f"Token {AuthToken.objects.create(user=user).key}",
    }


def _item(uid: str) -> dict:
    return {
        "uid": uid,
        "version": 1,
        "encryptionKey": None,
        "etag": None,
        "content": {"uid": _uid("rev"), "meta": b"{}", "deleted": False, "chunks": []},
    }


def _post(client, owner, collection, route: str, items, deps=None):
    return client.post(
        f"{COLLECTION_PREFIX}/{collection.uid}/item/{route}/",
        content=msgpack_encode({"items": items, "deps": deps}),
        headers=_headers(owner),
    )


def test_shipped_cap_covers_client_batch_sizes():
    from etebase_server.fastapi.routers.collection import MAX_BULK_ITEMS

    # Web uploads 20 per batch, Android and Bridge push 30, birthday writers 50.
    assert MAX_BULK_ITEMS == 200


@pytest.mark.parametrize("route", ROUTES)
def test_items_at_the_cap_are_written(client, owner, collection, route):
    from etebase_server.fastapi.routers.collection import MAX_BULK_ITEMS

    uids = [_uid("item") for _ in range(MAX_BULK_ITEMS)]
    response = _post(client, owner, collection, route, [_item(uid) for uid in uids])
    assert response.status_code == 200, response.content
    assert collection.items.filter(uid__in=uids).count() == MAX_BULK_ITEMS


@pytest.mark.parametrize("route", ROUTES)
def test_items_over_the_cap_are_refused_and_nothing_is_written(client, owner, collection, route):
    from etebase_server.fastapi.routers.collection import MAX_BULK_ITEMS

    uids = [_uid("item") for _ in range(MAX_BULK_ITEMS + 1)]
    response = _post(client, owner, collection, route, [_item(uid) for uid in uids])
    assert response.status_code == 400, response.content
    assert msgpack_decode(response.content)["code"] == "too_many_items"
    assert not collection.items.filter(uid__in=uids).exists()


@pytest.mark.parametrize("route", ROUTES)
def test_deps_over_the_cap_are_refused_and_nothing_is_written(client, owner, collection, route):
    from etebase_server.fastapi.routers.collection import MAX_BULK_ITEMS

    new_uid = _uid("item")
    deps = [{"uid": _uid("dep"), "etag": _uid("etag")} for _ in range(MAX_BULK_ITEMS + 1)]
    response = _post(client, owner, collection, route, [_item(new_uid)], deps)
    assert response.status_code == 400, response.content
    assert msgpack_decode(response.content)["code"] == "too_many_items"
    assert not collection.items.filter(uid=new_uid).exists()
