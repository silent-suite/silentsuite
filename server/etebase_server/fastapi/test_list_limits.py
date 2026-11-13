"""The collection and item lists cap the page size a client can request.

A requested `limit` above `MAX_LIST_LIMIT` is clamped, not refused: the
response is a normal page with `done=False` and an stoken, and the client
fetches the rest the way it already pages. A limit at or below the cap is
honoured unchanged.

The cap is patched down to a small value so a handful of synthetic rows
exercises it; the shipped value is asserted separately.
"""

from __future__ import annotations

import itertools
import typing as t

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.utils import msgpack_decode

COLLECTION_PREFIX = "/api/v1/collection"
PATCHED_CAP = 3
ROWS = 5

_counter = itertools.count()


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43), unique per call."""
    return f"{prefix}-{next(_counter):04d}-" + "x" * 30


@pytest.fixture
def capped(monkeypatch):
    from etebase_server.fastapi.routers import collection

    monkeypatch.setattr(collection, "MAX_LIST_LIMIT", PATCHED_CAP)


@pytest.fixture
def client() -> TestClient:
    from etebase_server.fastapi.routers.collection import collection_router, item_router

    app = FastAPI()
    app.include_router(collection_router, prefix=COLLECTION_PREFIX)
    app.include_router(item_router, prefix=f"{COLLECTION_PREFIX}/{{collection_uid}}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


class Owner(t.NamedTuple):
    user: t.Any
    token: str


@pytest.fixture
def owner(user_factory) -> Owner:
    from etebase_server.django.token_auth.models import AuthToken

    user = user_factory(username="test_user_limits", email="limits@example.com")
    return Owner(user=user, token=AuthToken.objects.create(user=user).key)


def _add_item(collection, uid: str):
    from etebase_server.django import models

    item = models.CollectionItem.objects.create(uid=uid, collection=collection, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("rev"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=True
    )
    return item


def _add_collection(user):
    """A collection with its main item and an ADMIN membership for `user`."""
    from etebase_server.django import models

    uid = _uid("col")
    collection = models.Collection.objects.create(uid=uid, owner=user)
    collection.main_item = _add_item(collection, uid)
    collection.save(update_fields=["main_item"])
    models.CollectionMember.objects.create(
        collection=collection,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=models.CollectionType.objects.create(uid=_uid("type").encode(), owner=user),
        stoken=models.Stoken.objects.create(),
    )
    return collection


def _get(client: TestClient, owner: Owner, path: str, **params):
    response = client.get(
        path,
        params={key: value for key, value in params.items() if value is not None},
        headers={"Accept": "application/msgpack", "Authorization": f"Token {owner.token}"},
    )
    assert response.status_code == 200, msgpack_decode(response.content)
    return msgpack_decode(response.content)


def _page_through(client: TestClient, owner: Owner, path: str, limit: int) -> t.List[t.List[str]]:
    """Follow stokens until `done`, returning the uids of each page."""
    pages: t.List[t.List[str]] = []
    stoken = None
    while True:
        page = _get(client, owner, path, limit=limit, stoken=stoken, prefetch="auto")
        pages.append([entry["item"]["uid"] if "item" in entry else entry["uid"] for entry in page["data"]])
        if page["done"]:
            return pages
        stoken = page["stoken"]
        assert len(pages) <= ROWS, "paging did not terminate"


def test_shipped_cap_covers_client_page_sizes():
    from etebase_server.fastapi.routers.collection import MAX_LIST_LIMIT

    # Android asks for 100 per page during setup; other clients use the default 50.
    assert MAX_LIST_LIMIT == 500


@pytest.mark.django_db(transaction=True)
class TestItemListLimit:
    @pytest.fixture
    def items_path(self, owner) -> t.Tuple[str, t.List[str]]:
        collection = _add_collection(owner.user)
        uids = [_add_item(collection, _uid("item")).uid for _ in range(ROWS)]
        return f"{COLLECTION_PREFIX}/{collection.uid}/item/", uids

    def test_limit_above_cap_is_clamped(self, capped, client, owner, items_path):
        path, uids = items_path

        pages = _page_through(client, owner, path, limit=10_000)

        assert [len(page) for page in pages] == [PATCHED_CAP, ROWS - PATCHED_CAP]
        assert sorted(itertools.chain(*pages)) == sorted(uids)

    def test_limit_below_cap_is_honoured(self, capped, client, owner, items_path):
        path, uids = items_path

        pages = _page_through(client, owner, path, limit=2)

        assert [len(page) for page in pages] == [2, 2, 1]
        assert sorted(itertools.chain(*pages)) == sorted(uids)


@pytest.mark.django_db(transaction=True)
class TestCollectionListLimit:
    @pytest.fixture
    def collection_uids(self, owner) -> t.List[str]:
        return [_add_collection(owner.user).uid for _ in range(ROWS)]

    def test_limit_above_cap_is_clamped(self, capped, client, owner, collection_uids):
        pages = _page_through(client, owner, f"{COLLECTION_PREFIX}/", limit=10_000)

        assert [len(page) for page in pages] == [PATCHED_CAP, ROWS - PATCHED_CAP]
        assert sorted(itertools.chain(*pages)) == sorted(collection_uids)

    def test_limit_below_cap_is_honoured(self, capped, client, owner, collection_uids):
        pages = _page_through(client, owner, f"{COLLECTION_PREFIX}/", limit=2)

        assert [len(page) for page in pages] == [2, 2, 1]
        assert sorted(itertools.chain(*pages)) == sorted(collection_uids)
