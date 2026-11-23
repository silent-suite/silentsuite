"""Only a collection admin may delete a collection.

A client deletes an existing collection by uploading a deleted revision of its
main item through the item batch or transaction route. Those routes accept any
member with write access, so without a separate check a read/write member
could delete a shared collection for its owner and every other member.
Read/write members keep their write access to the collection's other items.
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


def _add_item(collection, uid: str):
    from etebase_server.django import models

    item = models.CollectionItem.objects.create(uid=uid, collection=collection, version=1)
    rev = models.CollectionItemRevision.objects.create(
        uid=_uid("rev"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=True
    )
    return item, rev


def _add_member(collection, user, access_level):
    from etebase_server.django import models

    models.CollectionMember.objects.create(
        collection=collection,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=access_level,
        collectionType=models.CollectionType.objects.create(uid=_uid("type").encode(), owner=user),
        stoken=models.Stoken.objects.create(),
    )


@pytest.fixture
def shared(user_factory):
    """A collection owned by an admin and shared read/write with a member."""
    from etebase_server.django import models

    owner = user_factory("delete-access-owner", "owner@example.com")
    member = user_factory("delete-access-member", "member@example.com")
    uid = _uid("col")
    collection = models.Collection.objects.create(uid=uid, owner=owner)
    main_item, main_rev = _add_item(collection, uid)
    collection.main_item = main_item
    collection.save(update_fields=["main_item"])
    _add_member(collection, owner, models.AccessLevels.ADMIN)
    _add_member(collection, member, models.AccessLevels.READ_WRITE)
    other_item, other_rev = _add_item(collection, _uid("item"))
    return {
        "collection": collection,
        "owner": owner,
        "member": member,
        "main_etag": main_rev.uid,
        "other_uid": other_item.uid,
        "other_etag": other_rev.uid,
    }


def _post(client, user, collection, route: str, item_uid: str, etag: str, deleted: bool):
    from etebase_server.django.token_auth.models import AuthToken

    item = {
        "uid": item_uid,
        "version": 1,
        "encryptionKey": None,
        "etag": etag,
        "content": {"uid": _uid("rev"), "meta": b"{}", "deleted": deleted, "chunks": []},
    }
    return client.post(
        f"{COLLECTION_PREFIX}/{collection.uid}/item/{route}/",
        content=msgpack_encode({"items": [item], "deps": None}),
        headers={
            "Accept": "application/msgpack",
            "Content-Type": "application/msgpack",
            "Authorization": f"Token {AuthToken.objects.create(user=user).key}",
        },
    )


def _main_item_deleted(collection) -> bool:
    collection.refresh_from_db()
    return collection.main_item.revisions.get(current=True).deleted


@pytest.mark.parametrize("route", ROUTES)
def test_read_write_member_cannot_delete_the_collection(client, shared, route):
    col = shared["collection"]
    response = _post(client, shared["member"], col, route, col.uid, shared["main_etag"], deleted=True)
    assert response.status_code == 403, response.content
    assert msgpack_decode(response.content)["code"] == "admin_access_required"
    assert not _main_item_deleted(col)


@pytest.mark.parametrize("route", ROUTES)
def test_admin_can_delete_the_collection(client, shared, route):
    col = shared["collection"]
    response = _post(client, shared["owner"], col, route, col.uid, shared["main_etag"], deleted=True)
    assert response.status_code == 200, response.content
    assert _main_item_deleted(col)


@pytest.mark.parametrize("route", ROUTES)
def test_read_write_member_can_still_delete_other_items(client, shared, route):
    col = shared["collection"]
    response = _post(client, shared["member"], col, route, shared["other_uid"], shared["other_etag"], deleted=True)
    assert response.status_code == 200, response.content
    assert col.items.get(uid=shared["other_uid"]).revisions.get(current=True).deleted


@pytest.mark.parametrize("route", ROUTES)
def test_read_write_member_can_still_update_the_collection_item(client, shared, route):
    col = shared["collection"]
    response = _post(client, shared["member"], col, route, col.uid, shared["main_etag"], deleted=False)
    assert response.status_code == 200, response.content
    assert not _main_item_deleted(col)
