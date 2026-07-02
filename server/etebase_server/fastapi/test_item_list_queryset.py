"""Regression test for N+1 query bug in item-list serialization (PR-D1).

The 2026-03-25 attempt to add `prefetch_related` to `get_item_queryset` was
reverted (commit 4d7893f3) because it used the wrong relation names and broke
sync. This test pins the fix in place: query count for a full item-list
serialization must not scale linearly with the number of items.
"""

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "etebase_server.settings")

import django  # noqa: E402

django.setup()

from django.contrib.auth import get_user_model  # noqa: E402
from django.core.files.base import ContentFile  # noqa: E402
from django.test import TestCase, TransactionTestCase  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from etebase_server.django import models  # noqa: E402
from etebase_server.django.token_auth.models import AuthToken  # noqa: E402
from etebase_server.fastapi.dependencies import build_item_queryset  # noqa: E402
from etebase_server.fastapi.exceptions import CustomHttpException  # noqa: E402
from etebase_server.fastapi.msgpack import MsgpackResponse  # noqa: E402
from etebase_server.fastapi.routers.collection import item_router  # noqa: E402
from etebase_server.fastapi.utils import msgpack_decode  # noqa: E402

User = get_user_model()


_FIXTURE_COUNTER = {"n": 0}


def _make_collection_with_items(n_items: int):
    _FIXTURE_COUNTER["n"] += 1
    nonce = _FIXTURE_COUNTER["n"]
    user = User.objects.create_user(username=f"test_user_n1_{nonce}", email=f"t{nonce}@t.t", password="x")
    col = models.Collection.objects.create(uid=f"col{nonce:03d}" + "a" * 37, owner=user)
    collection_type = models.CollectionType.objects.create(uid=f"type{nonce:03d}".encode(), owner=user)
    models.CollectionMember.objects.create(
        collection=col,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=collection_type,
        stoken=models.Stoken.objects.create(),
    )
    for i in range(n_items):
        item = models.CollectionItem.objects.create(
            uid=f"item{nonce:03d}{i:036d}",
            collection=col,
            version=1,
        )
        stoken = models.Stoken.objects.create()
        rev = models.CollectionItemRevision.objects.create(
            uid=f"rev_{nonce:03d}_{i:034d}",
            stoken=stoken,
            item=item,
            meta=b"{}",
            current=True,
        )
        chunk = models.CollectionItemChunk(uid=f"chk_{nonce:03d}_{i:034d}", collection=col)
        chunk.chunkFile.save("IGNORED", ContentFile(b"\x00\x01\x02"))
        chunk.save()
        models.RevisionChunkRelation.objects.create(chunk=chunk, revision=rev)
    return user, col


def _item_list_app(user):
    app = FastAPI()
    app.include_router(item_router, prefix="/api/v1/collection/{collection_uid}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(_request, exc: RequestValidationError):  # noqa: RUF029
        return MsgpackResponse(status_code=422, content={"detail": exc.errors()})

    return app


class ItemListQuerysetTests(TestCase):
    """`build_item_queryset` must serialize in O(1) queries regardless of item count."""

    def test_query_count_does_not_scale_with_items(self):
        _, col_small = _make_collection_with_items(5)
        _, col_large = _make_collection_with_items(25)

        small_count = self._count_serialization_queries(col_small)
        large_count = self._count_serialization_queries(col_large)

        # Allow a small constant difference for prefetch result-set size, but the
        # count must not grow proportionally with item count.
        self.assertLess(
            large_count,
            small_count + 5,
            f"Item-list query count grew from {small_count} to {large_count} when "
            f"item count went from 5 to 25 — N+1 has regressed.",
        )

    def test_query_count_is_bounded_for_large_collection(self):
        _, col = _make_collection_with_items(50)
        count = self._count_serialization_queries(col)
        # With prefetch in place this is 3 queries (items + revisions + chunks_relation
        # joined to chunks via select_related). Bound at 8 to catch any regression
        # without being so tight it breaks on Django version bumps.
        self.assertLessEqual(count, 8, f"Item-list serialization issued {count} queries for 50 items")

    def _count_serialization_queries(self, collection: models.Collection) -> int:
        """Mimic the access pattern in `CollectionItemRevisionInOut.from_orm_context`
        and return how many DB queries it issues.
        """
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            for item in build_item_queryset(collection):
                rev = item.content
                for chunk_relation in rev.chunks_relation.all():
                    _ = chunk_relation.chunk.uid
        return len(ctx.captured_queries)


class ItemListRouteTests(TransactionTestCase):
    def test_item_list_uses_collection_uid_from_router_prefix(self):
        user, col = _make_collection_with_items(1)
        token = AuthToken.objects.create(user=user)
        client = TestClient(_item_list_app(user))

        response = client.get(
            f"/api/v1/collection/{col.uid}/item/",
            headers={
                "Accept": "application/msgpack",
                "Content-Type": "application/msgpack",
                "Authorization": f"Token {token.key}",
            },
        )

        assert response.status_code == 200, response.text
        data = msgpack_decode(response.content)
        assert len(data["data"]) == 1
