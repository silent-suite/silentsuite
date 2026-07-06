"""Route-level contract tests for `{collection_uid}` path-parameter binding (issue #465).

The restore incident showed that helper/queryset tests can stay green while the
real FastAPI route wiring breaks: `{collection_uid}` is supplied by the *router
prefix* (see `create_application` in main.py), so a change to the prefix, to the
dependency chain (`get_collection` / `get_item_queryset` / member `get_queryset`),
or to a handler's bare `collection_uid` parameter can silently unbind the path
parameter. PR #463 pinned GET /api/v1/collection/{collection_uid}/item/; this
module extends that to at least one test per dependency class:

- ``Depends(get_collection)`` resolved from the item-router prefix
  (chunk upload / download)
- ``Depends(get_item_queryset)`` (item get / item revisions / fetch_updates)
- bare ``collection_uid: str`` handler parameters (item batch / transaction)
- member-router dependencies mounted under the same prefix (member list / leave)
- ``{collection_uid}`` in collection_router's own path (collection get)

Each test drives a production-style app (same prefixes as main.py) through
TestClient with token auth and msgpack request/response bodies, and asserts
per-collection results — so it fails if the uid stops binding from the path.
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "etebase_server.settings")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TransactionTestCase  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from etebase_server.django import models  # noqa: E402
from etebase_server.django.token_auth.models import AuthToken  # noqa: E402
from etebase_server.fastapi.exceptions import CustomHttpException  # noqa: E402
from etebase_server.fastapi.msgpack import MsgpackResponse  # noqa: E402
from etebase_server.fastapi.routers.collection import collection_router, item_router  # noqa: E402
from etebase_server.fastapi.routers.member import member_router  # noqa: E402
from etebase_server.fastapi.utils import msgpack_decode, msgpack_encode  # noqa: E402

User = get_user_model()

COLLECTION_PREFIX = "/api/v1/collection"


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43) unique per prefix."""
    return (prefix + "-" + "x" * 43)[:40]


def _make_app() -> FastAPI:
    """Mount the collection/item/member routers exactly like `create_application`
    does in main.py — the item and member routers get `{collection_uid}` only
    from their prefix — plus the production exception handlers so error bodies
    are msgpack `{code, detail}` like the real server."""
    app = FastAPI()
    app.include_router(collection_router, prefix=COLLECTION_PREFIX)
    app.include_router(item_router, prefix=COLLECTION_PREFIX + "/{collection_uid}")
    app.include_router(member_router, prefix=COLLECTION_PREFIX + "/{collection_uid}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(_request, exc: RequestValidationError):  # noqa: RUF029
        return MsgpackResponse(status_code=422, content={"detail": exc.errors()})

    return app


def _make_collection(user, seed: str) -> models.Collection:
    """A collection with a main item + current revision and an ADMIN membership
    for `user` — the minimum the routes under test serialize."""
    col = models.Collection.objects.create(uid=_uid(f"col-{seed}"), owner=user)
    main_item = models.CollectionItem.objects.create(uid=col.uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid(f"rev-main-{seed}"),
        stoken=models.Stoken.objects.create(),
        item=main_item,
        meta=b"{}",
        current=True,
    )
    col.main_item = main_item
    col.save()
    collection_type = models.CollectionType.objects.create(uid=_uid(f"type-{seed}").encode(), owner=user)
    models.CollectionMember.objects.create(
        collection=col,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=collection_type,
        stoken=models.Stoken.objects.create(),
    )
    return col


def _add_item(col: models.Collection, item_uid: str, revision_uid: str) -> models.CollectionItem:
    item = models.CollectionItem.objects.create(uid=item_uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=revision_uid,
        stoken=models.Stoken.objects.create(),
        item=item,
        meta=b"{}",
        current=True,
    )
    return item


class CollectionRouteContractTests(TransactionTestCase):
    """Uses TransactionTestCase (not TestCase) because the route handlers run
    through `django_db_cleanup_decorator`, which calls `close_old_connections()`
    and breaks the per-test transaction wrapper — same as ItemListRouteTests."""

    def setUp(self):
        self.alice = User.objects.create_user(username="route_alice", email="ra@example.com", password="x")
        self.bob = User.objects.create_user(username="route_bob", email="rb@example.com", password="x")
        self.alice_token = AuthToken.objects.create(user=self.alice).key
        self.bob_token = AuthToken.objects.create(user=self.bob).key

        self.col_a = _make_collection(self.alice, "aaaa")
        self.col_b = _make_collection(self.alice, "bbbb")

        # The same item uid exists in BOTH collections with different current
        # revisions, so any route that returns the wrong collection's data
        # (rather than 404ing) is still caught.
        self.shared_item_uid = _uid("item-shared")
        self.rev_a = _uid("rev-shared-aaaa")
        self.rev_b = _uid("rev-shared-bbbb")
        _add_item(self.col_a, self.shared_item_uid, self.rev_a)
        _add_item(self.col_b, self.shared_item_uid, self.rev_b)

        # Bob is a READ_ONLY member of col_b only.
        models.CollectionMember.objects.create(
            collection=self.col_b,
            user=self.bob,
            encryptionKey=b"\x02" * 32,
            accessLevel=models.AccessLevels.READ_ONLY,
            collectionType=None,
            stoken=models.Stoken.objects.create(),
        )

        self.client = TestClient(_make_app())

    # --- request helpers ---------------------------------------------------

    def _headers(self, token: str) -> dict:
        return {
            "Accept": "application/msgpack",
            "Content-Type": "application/msgpack",
            "Authorization": f"Token {token}",
        }

    def _get(self, url: str, token: str):
        return self.client.get(url, headers=self._headers(token))

    def _post(self, url: str, token: str, body):
        return self.client.post(url, content=msgpack_encode(body), headers=self._headers(token))

    def _put_raw(self, url: str, token: str, content: bytes):
        return self.client.put(url, content=content, headers=self._headers(token))

    # --- collection_router: {collection_uid} in the route's own path --------

    def test_collection_get_returns_the_collection_bound_from_the_path(self):
        for col in (self.col_a, self.col_b):
            response = self._get(f"{COLLECTION_PREFIX}/{col.uid}/", self.alice_token)
            assert response.status_code == 200, response.content
            data = msgpack_decode(response.content)
            assert data["item"]["uid"] == col.uid

    def test_collection_get_unknown_uid_is_404(self):
        response = self._get(f"{COLLECTION_PREFIX}/{_uid('col-missing')}/", self.alice_token)
        assert response.status_code == 404, response.content
        assert msgpack_decode(response.content)["code"] == "does_not_exist"

    def test_collection_routes_are_404_for_non_members(self):
        # Bob is not a member of col_a: get_collection_queryset must scope the
        # prefix-bound uid to his memberships.
        response = self._get(f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/", self.bob_token)
        assert response.status_code == 404, response.content
        assert msgpack_decode(response.content)["code"] == "does_not_exist"

    # --- item_router: Depends(get_item_queryset) from the router prefix -----

    def test_item_get_is_scoped_to_the_prefix_collection(self):
        expected = {self.col_a.uid: self.rev_a, self.col_b.uid: self.rev_b}
        for col_uid, revision_uid in expected.items():
            response = self._get(
                f"{COLLECTION_PREFIX}/{col_uid}/item/{self.shared_item_uid}/",
                self.alice_token,
            )
            assert response.status_code == 200, response.content
            data = msgpack_decode(response.content)
            assert data["uid"] == self.shared_item_uid
            assert data["content"]["uid"] == revision_uid

    def test_item_revisions_are_scoped_to_the_prefix_collection(self):
        only_in_a = _add_item(self.col_a, _uid("item-only-aaaa"), _uid("rev-only-aaaa"))

        response = self._get(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{only_in_a.uid}/revision/",
            self.alice_token,
        )
        assert response.status_code == 200, response.content
        data = msgpack_decode(response.content)
        assert [revision["uid"] for revision in data["data"]] == [_uid("rev-only-aaaa")]

        # The same item uid under the other collection's prefix must 404.
        response = self._get(
            f"{COLLECTION_PREFIX}/{self.col_b.uid}/item/{only_in_a.uid}/revision/",
            self.alice_token,
        )
        assert response.status_code == 404, response.content

    def test_fetch_updates_is_scoped_to_the_prefix_collection(self):
        expected = {self.col_a.uid: self.rev_a, self.col_b.uid: self.rev_b}
        for col_uid, revision_uid in expected.items():
            response = self._post(
                f"{COLLECTION_PREFIX}/{col_uid}/item/fetch_updates/",
                self.alice_token,
                [{"uid": self.shared_item_uid, "etag": None}],
            )
            assert response.status_code == 200, response.content
            data = msgpack_decode(response.content)
            assert [item["content"]["uid"] for item in data["data"]] == [revision_uid]

    # --- item_router: bare `collection_uid: str` handler parameters ---------

    def _batch_body(self, item_uid: str, revision_uid: str) -> dict:
        return {
            "items": [
                {
                    "uid": item_uid,
                    "version": 1,
                    "encryptionKey": None,
                    "etag": None,
                    "content": {"uid": revision_uid, "meta": b"{}", "deleted": False, "chunks": []},
                }
            ],
            "deps": None,
        }

    def test_item_batch_writes_into_the_prefix_collection(self):
        new_uid = _uid("item-batch-new")
        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/batch/",
            self.alice_token,
            self._batch_body(new_uid, _uid("rev-batch-new")),
        )
        assert response.status_code == 200, response.content
        assert self.col_a.items.filter(uid=new_uid).exists()
        assert not self.col_b.items.filter(uid=new_uid).exists()

    def test_item_transaction_writes_into_the_prefix_collection(self):
        new_uid = _uid("item-txn-new")
        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_b.uid}/item/transaction/",
            self.alice_token,
            self._batch_body(new_uid, _uid("rev-txn-new")),
        )
        assert response.status_code == 200, response.content
        assert self.col_b.items.filter(uid=new_uid).exists()
        assert not self.col_a.items.filter(uid=new_uid).exists()

    # --- item_router: Depends(get_collection) from the router prefix --------

    def test_chunk_upload_and_download_are_scoped_to_the_prefix_collection(self):
        chunk_uid = _uid("chunk-route-aaaa")
        chunk_bytes = b"\x00\x01\x02route-contract"

        response = self._put_raw(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{self.shared_item_uid}/chunk/{chunk_uid}/",
            self.alice_token,
            chunk_bytes,
        )
        assert response.status_code == 201, response.content
        assert self.col_a.chunks.filter(uid=chunk_uid).exists()
        assert not self.col_b.chunks.filter(uid=chunk_uid).exists()

        response = self._get(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{self.shared_item_uid}/chunk/{chunk_uid}/download/",
            self.alice_token,
        )
        assert response.status_code == 200, response.content
        assert response.content == chunk_bytes

        # The chunk must not be reachable under the other collection's prefix.
        response = self._get(
            f"{COLLECTION_PREFIX}/{self.col_b.uid}/item/{self.shared_item_uid}/chunk/{chunk_uid}/download/",
            self.alice_token,
        )
        assert response.status_code == 404, response.content

    # --- member_router: dependencies mounted under the same prefix ----------

    def test_member_list_uses_the_collection_from_the_prefix(self):
        expected = {
            self.col_a.uid: {self.alice.username},
            self.col_b.uid: {self.alice.username, self.bob.username},
        }
        for col_uid, usernames in expected.items():
            response = self._get(f"{COLLECTION_PREFIX}/{col_uid}/member/", self.alice_token)
            assert response.status_code == 200, response.content
            data = msgpack_decode(response.content)
            assert {member["username"] for member in data["data"]} == usernames

    def test_member_leave_removes_membership_in_the_prefix_collection(self):
        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_b.uid}/member/leave/",
            self.bob_token,
            None,
        )
        assert response.status_code == 204, response.content
        assert not self.col_b.members.filter(user=self.bob).exists()
        assert self.col_b.members.filter(user=self.alice).exists()
