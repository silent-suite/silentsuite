"""Route-level collection route contracts (issue #465).

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

from django.conf import settings  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.db.models import F  # noqa: E402
from django.test import TransactionTestCase  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.routing import APIRoute, APIWebSocketRoute, iter_route_contexts  # noqa: E402
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

# `create_application()` mounts these routers in production. Keep this as a
# complete inventory rather than a smoke-test sentinel: `iter_route_contexts`
# expands included routers lazily, so seeing one route of each kind would not
# detect a branch that stopped expanding. The 18 HTTP routes are collection
# (1), item (9), member (4), and invitation (4); the WebSocket router adds 1.
EXPECTED_TEMPLATED_HTTP_ROUTES = (
    (("GET",), "/api/v1/collection/{collection_uid}/", ("collection_uid",)),
    (("GET",), "/api/v1/collection/{collection_uid}/item/", ("collection_uid",)),
    (("POST",), "/api/v1/collection/{collection_uid}/item/batch/", ("collection_uid",)),
    (("POST",), "/api/v1/collection/{collection_uid}/item/fetch_updates/", ("collection_uid",)),
    (("POST",), "/api/v1/collection/{collection_uid}/item/subscription-ticket/", ("collection_uid",)),
    (("POST",), "/api/v1/collection/{collection_uid}/item/transaction/", ("collection_uid",)),
    (("GET",), "/api/v1/collection/{collection_uid}/item/{item_uid}/", ("collection_uid", "item_uid")),
    (("GET",), "/api/v1/collection/{collection_uid}/item/{item_uid}/revision/", ("collection_uid", "item_uid")),
    (("PUT",), "/api/v1/collection/{collection_uid}/item/{item_uid}/chunk/{chunk_uid}/", ("chunk_uid", "collection_uid", "item_uid")),
    (("GET",), "/api/v1/collection/{collection_uid}/item/{item_uid}/chunk/{chunk_uid}/download/", ("chunk_uid", "collection_uid", "item_uid")),
    (("POST",), "/api/v1/collection/{collection_uid}/member/leave/", ("collection_uid",)),
    (("GET",), "/api/v1/collection/{collection_uid}/member/", ("collection_uid",)),
    (("DELETE",), "/api/v1/collection/{collection_uid}/member/{username}/", ("collection_uid", "username")),
    (("PATCH",), "/api/v1/collection/{collection_uid}/member/{username}/", ("collection_uid", "username")),
    (("POST",), "/api/v1/invitation/incoming/{invitation_uid}/accept/", ("invitation_uid",)),
    (("DELETE",), "/api/v1/invitation/incoming/{invitation_uid}/", ("invitation_uid",)),
    (("GET",), "/api/v1/invitation/incoming/{invitation_uid}/", ("invitation_uid",)),
    (("DELETE",), "/api/v1/invitation/outgoing/{invitation_uid}/", ("invitation_uid",)),
)
EXPECTED_TEMPLATED_WEBSOCKET_ROUTES = (
    ("/api/v1/ws/{ticket}/", ("ticket",)),
)


def _format_route_inventory(routes) -> str:
    return "\n".join(f"  {route}" for route in sorted(routes)) or "  (none)"


def _request_field_name(field) -> str:
    """Return the runtime request-field alias, falling back to its Python name."""
    return getattr(field, "alias", None) or field.name


def _dependency_query_parameter_names(dependant) -> set[str]:
    """Collect query request-field names throughout a dependency tree."""
    query_names: set[str] = set()
    pending = [dependant]

    while pending:
        current = pending.pop()
        query_names.update(_request_field_name(field) for field in current.query_params)
        pending.extend(current.dependencies)

    return query_names


def _effective_websocket_route(route_context) -> APIWebSocketRoute:
    """Return FastAPI 0.138.2's rebuilt WebSocket route for an included router.

    ``iter_route_contexts`` is the public API for expanding lazy
    ``_IncludedRouter`` branches.  In this pinned FastAPI version, however,
    its WebSocket ``RouteContext`` proxies an ``_EffectiveRouteContext`` whose
    path and dependant are placeholders; the actual prefixed route and its
    rebuilt dependency tree are on ``starlette_route``.  Keep this private
    compatibility access here, and fail clearly if FastAPI changes that shape.
    """
    effective_context = getattr(route_context, "_route_context", None)
    if effective_context is None:
        effective_route = route_context.route
    else:
        effective_route = getattr(effective_context, "starlette_route", None)

    if not isinstance(effective_route, APIWebSocketRoute):
        raise AssertionError(
            "FastAPI route-context compatibility error: expected an "
            "APIWebSocketRoute at RouteContext._route_context.starlette_route "
            "for an effective WebSocket route; update this pinned-version shim."
        )
    return effective_route


def test_mounted_route_template_parameters_are_not_query_parameters(monkeypatch, tmp_path):
    """Ensure mounted FastAPI template parameters are absent from query metadata.

    Inspect the final production-style application and each complete dependency
    graph.  Some routes intentionally expose a template parameter that no
    dependency consumes, but no template parameter may also be a query field.
    """
    monkeypatch.setattr(settings, "STATIC_ROOT", str(tmp_path))

    from etebase_server.fastapi.main import create_application

    app = create_application()
    violations = []
    templated_http_routes = []
    templated_websocket_routes = []

    for route_context in iter_route_contexts(app.routes):
        original_route = route_context.original_route
        if not isinstance(original_route, (APIRoute, APIWebSocketRoute)):
            continue

        if isinstance(original_route, APIRoute):
            # RouteContext publicly proxies the effective HTTP route metadata.
            effective_route = route_context
        else:
            effective_route = _effective_websocket_route(route_context)

        path = effective_route.path
        path_format = effective_route.path_format
        template_names = set(effective_route.path_regex.groupindex)
        if not template_names:
            continue

        query_names = _dependency_query_parameter_names(effective_route.dependant)
        conflicting_query_names = template_names & query_names
        if isinstance(original_route, APIRoute):
            methods = tuple(sorted(effective_route.methods))
            templated_http_routes.append((methods, path_format, tuple(sorted(template_names))))
            diagnostic = ", ".join(methods)
        else:
            templated_websocket_routes.append((path_format, tuple(sorted(template_names))))
            diagnostic = "WebSocket"

        if conflicting_query_names:
            violations.append(
                f"{diagnostic} {path} (template {path_format}): "
                f"template parameters in query metadata: {sorted(conflicting_query_names)}"
            )

    assert len(templated_http_routes) == 18, (
        "Expected 18 templated HTTP routes from the production application; observed:\n"
        + _format_route_inventory(templated_http_routes)
    )
    assert sorted(templated_http_routes) == sorted(EXPECTED_TEMPLATED_HTTP_ROUTES), (
        "Templated HTTP route inventory changed.\n"
        "Expected:\n"
        + _format_route_inventory(EXPECTED_TEMPLATED_HTTP_ROUTES)
        + "\nObserved:\n"
        + _format_route_inventory(templated_http_routes)
    )
    assert len(templated_websocket_routes) == 1, (
        "Expected 1 templated WebSocket route from the production application; observed:\n"
        + _format_route_inventory(templated_websocket_routes)
    )
    assert sorted(templated_websocket_routes) == sorted(EXPECTED_TEMPLATED_WEBSOCKET_ROUTES), (
        "Templated WebSocket route inventory changed.\n"
        "Expected:\n"
        + _format_route_inventory(EXPECTED_TEMPLATED_WEBSOCKET_ROUTES)
        + "\nObserved:\n"
        + _format_route_inventory(templated_websocket_routes)
    )
    assert not violations, "Mounted route query-metadata contract violations:\n" + "\n".join(violations)


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

    def _item_body(self, item_uid: str, revision_uid: str, chunks=()) -> dict:
        return {
            "uid": item_uid,
            "version": 1,
            "encryptionKey": None,
            "etag": None,
            "content": {"uid": revision_uid, "meta": b"{}", "deleted": False, "chunks": list(chunks)},
        }

    def _batch_body(self, item_uid: str, revision_uid: str, chunks=()) -> dict:
        return {"items": [self._item_body(item_uid, revision_uid, chunks)], "deps": None}

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

    # --- revision chunk references: scoped to the destination collection ----
    #
    # A revision may reference an existing chunk by uid alone (no content). That
    # lookup must only match chunks of the collection being written: a uid that
    # exists only in another collection is unknown here, so a content-less
    # reference to it is refused and the whole request leaves nothing behind.

    def _upload_chunk(self, col: models.Collection, chunk_uid: str, content: bytes):
        response = self._put_raw(
            f"{COLLECTION_PREFIX}/{col.uid}/item/{self.shared_item_uid}/chunk/{chunk_uid}/",
            self.alice_token,
            content,
        )
        assert response.status_code == 201, response.content

    def _assert_item_failed_for_missing_chunk_content(self, response):
        assert response.status_code == 409, response.content
        data = msgpack_decode(response.content)
        assert data["code"] == "item_failed"
        assert [error["code"] for error in data["errors"]] == ["chunk_no_content"]

    def _assert_no_cross_collection_chunk_relations(self):
        crossing = models.RevisionChunkRelation.objects.exclude(chunk__collection=F("revision__item__collection"))
        assert not crossing.exists()

    def test_item_writes_reject_a_contentless_reference_to_another_collections_chunk(self):
        foreign_uid = _uid("chunk-foreign-write")
        marker = b"\x00foreign-ciphertext-write-col-b"
        self._upload_chunk(self.col_b, foreign_uid, marker)

        for route in ("batch", "transaction"):
            item_uids = [_uid(f"item-valid-{route}"), _uid(f"item-foreign-{route}")]
            revision_uids = [_uid(f"rev-valid-{route}"), _uid(f"rev-foreign-{route}")]
            body = {
                "items": [
                    self._item_body(item_uids[0], revision_uids[0]),
                    self._item_body(item_uids[1], revision_uids[1], [(foreign_uid, None)]),
                ],
                "deps": None,
            }
            response = self._post(f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{route}/", self.alice_token, body)
            self._assert_item_failed_for_missing_chunk_content(response)

            # The whole request rolls back, including the valid sibling item.
            assert not self.col_a.items.filter(uid__in=item_uids).exists()
            assert not models.CollectionItemRevision.objects.filter(uid__in=revision_uids).exists()
            assert not self.col_a.chunks.filter(uid=foreign_uid).exists()
            self._assert_no_cross_collection_chunk_relations()

        # The source collection's chunk is untouched.
        response = self._get(
            f"{COLLECTION_PREFIX}/{self.col_b.uid}/item/{self.shared_item_uid}/chunk/{foreign_uid}/download/",
            self.alice_token,
        )
        assert response.status_code == 200, response.content
        assert response.content == marker

    def test_rejected_foreign_chunk_reference_leaves_the_destination_item_unchanged(self):
        foreign_uid = _uid("chunk-foreign-update")
        marker = b"\x00foreign-ciphertext-update-col-b"
        self._upload_chunk(self.col_b, foreign_uid, marker)
        new_revision_uid = _uid("rev-foreign-update")

        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/batch/",
            self.alice_token,
            self._batch_body(self.shared_item_uid, new_revision_uid, [(foreign_uid, None)]),
        )
        self._assert_item_failed_for_missing_chunk_content(response)
        assert not models.CollectionItemRevision.objects.filter(uid=new_revision_uid).exists()
        self._assert_no_cross_collection_chunk_relations()

        item_url = f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{self.shared_item_uid}/"
        response = self._get(item_url, self.alice_token)
        assert response.status_code == 200, response.content
        content = msgpack_decode(response.content)["content"]
        assert content["uid"] == self.rev_a
        assert content["chunks"] == []

        response = self._get(f"{item_url}revision/", self.alice_token)
        assert response.status_code == 200, response.content
        assert [revision["uid"] for revision in msgpack_decode(response.content)["data"]] == [self.rev_a]

        for url in (item_url, f"{item_url}revision/", f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/"):
            response = self._get(url, self.alice_token)
            assert response.status_code == 200, response.content
            assert marker not in response.content

    def test_item_write_reuses_a_contentless_chunk_from_the_same_collection(self):
        chunk_uid = _uid("chunk-same-collection")
        chunk_bytes = b"\x00same-collection-ciphertext"
        self._upload_chunk(self.col_a, chunk_uid, chunk_bytes)
        new_uid = _uid("item-same-collection")

        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/batch/",
            self.alice_token,
            self._batch_body(new_uid, _uid("rev-same-collection"), [(chunk_uid, None)]),
        )
        assert response.status_code == 200, response.content
        assert self.col_a.chunks.filter(uid=chunk_uid).count() == 1
        self._assert_no_cross_collection_chunk_relations()

        response = self._get(f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{new_uid}/", self.alice_token)
        assert response.status_code == 200, response.content
        assert msgpack_decode(response.content)["content"]["chunks"] == [[chunk_uid, chunk_bytes]]

    def test_item_write_with_content_keeps_an_equal_chunk_uid_per_collection(self):
        chunk_uid = _uid("chunk-equal-uid")
        foreign_bytes = b"\x00equal-uid-ciphertext-col-b"
        own_bytes = b"\x00equal-uid-ciphertext-col-a"
        self._upload_chunk(self.col_b, chunk_uid, foreign_bytes)
        new_uid = _uid("item-equal-uid")

        response = self._post(
            f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/batch/",
            self.alice_token,
            self._batch_body(new_uid, _uid("rev-equal-uid"), [(chunk_uid, own_bytes)]),
        )
        assert response.status_code == 200, response.content

        response = self._get(f"{COLLECTION_PREFIX}/{self.col_a.uid}/item/{new_uid}/", self.alice_token)
        assert response.status_code == 200, response.content
        assert foreign_bytes not in response.content
        assert msgpack_decode(response.content)["content"]["chunks"] == [[chunk_uid, own_bytes]]

        assert self.col_a.chunks.filter(uid=chunk_uid).count() == 1
        assert self.col_b.chunks.filter(uid=chunk_uid).count() == 1
        self._assert_no_cross_collection_chunk_relations()

        expected = {self.col_a.uid: own_bytes, self.col_b.uid: foreign_bytes}
        for col_uid, chunk_bytes in expected.items():
            response = self._get(
                f"{COLLECTION_PREFIX}/{col_uid}/item/{self.shared_item_uid}/chunk/{chunk_uid}/download/",
                self.alice_token,
            )
            assert response.status_code == 200, response.content
            assert response.content == chunk_bytes

    def test_former_member_gets_no_foreign_ciphertext_in_their_own_collection(self):
        # Bob could see col_b's chunk uids while he was a member.
        foreign_uid = _uid("chunk-former-member")
        marker = b"\x00former-member-ciphertext-col-b"
        self._upload_chunk(self.col_b, foreign_uid, marker)
        response = self._post(f"{COLLECTION_PREFIX}/{self.col_b.uid}/member/leave/", self.bob_token, None)
        assert response.status_code == 204, response.content

        col_bob = _make_collection(self.bob, "cccc")
        new_uid = _uid("item-former-member")
        response = self._post(
            f"{COLLECTION_PREFIX}/{col_bob.uid}/item/batch/",
            self.bob_token,
            self._batch_body(new_uid, _uid("rev-former-member"), [(foreign_uid, None)]),
        )
        self._assert_item_failed_for_missing_chunk_content(response)
        assert not col_bob.items.filter(uid=new_uid).exists()
        self._assert_no_cross_collection_chunk_relations()

        response = self._get(f"{COLLECTION_PREFIX}/{col_bob.uid}/item/", self.bob_token)
        assert response.status_code == 200, response.content
        assert marker not in response.content

    def test_collection_create_rejects_a_contentless_reference_to_another_collections_chunk(self):
        foreign_uid = _uid("chunk-foreign-create")
        self._upload_chunk(self.col_b, foreign_uid, b"\x00foreign-ciphertext-create-col-b")
        new_col_uid = _uid("col-foreign-create")
        new_revision_uid = _uid("rev-foreign-create")

        response = self._post(
            f"{COLLECTION_PREFIX}/",
            self.bob_token,
            {
                "collectionType": _uid("type-foreign-create").encode(),
                "collectionKey": b"\x03" * 32,
                "item": self._item_body(new_col_uid, new_revision_uid, [(foreign_uid, None)]),
            },
        )
        assert response.status_code == 400, response.content
        assert msgpack_decode(response.content)["code"] == "chunk_no_content"

        assert not models.Collection.objects.filter(uid=new_col_uid).exists()
        assert not models.CollectionItemRevision.objects.filter(uid=new_revision_uid).exists()
        self._assert_no_cross_collection_chunk_relations()

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
