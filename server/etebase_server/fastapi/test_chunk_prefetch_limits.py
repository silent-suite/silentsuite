"""Bound stored-file repetition across every response, without truncating normal history."""

import asyncio
import builtins
import itertools
from types import SimpleNamespace

import pytest
from django.core.files.base import ContentFile
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.django import models
from etebase_server.django.token_auth.models import AuthToken
from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.routers import collection as routes
from etebase_server.fastapi.utils import Context, msgpack_decode

pytestmark = pytest.mark.django_db(transaction=True)
API = "/api/v1/collection"
BODY = b"01234567"
_ids = itertools.count()


def uid():
    return f"synthetic-chunk-limit-{next(_ids):020d}"


def revision(item, chunk, copies=1, current=True):
    rev = models.CollectionItemRevision.objects.create(
        uid=uid(), item=item, stoken=models.Stoken.objects.create(), meta=b"synthetic-meta", current=current
    )
    for _ in range(copies):
        models.RevisionChunkRelation.objects.create(chunk=chunk, revision=rev)
    return rev


def collection(owner):
    col = models.Collection.objects.create(uid=uid(), owner=owner)
    item = models.CollectionItem.objects.create(uid=col.uid, collection=col, version=1)
    col.main_item = item
    col.save(update_fields=["main_item"])
    kind = models.CollectionType.objects.create(owner=owner, uid=uid().encode())
    models.CollectionMember.objects.create(
        user=owner, collection=col, collectionType=kind, encryptionKey=b"synthetic-key",
        accessLevel=models.AccessLevels.ADMIN, stoken=models.Stoken.objects.create(),
    )
    return col, item


@pytest.fixture
def stored(user_factory, settings, tmp_path, monkeypatch):
    from etebase_server.fastapi import utils

    settings.MEDIA_ROOT = str(tmp_path)
    settings.SENDFILE_ROOT = str(tmp_path)
    monkeypatch.setattr(utils, "MAX_REPEATED_CHUNK_BYTES", len(BODY))
    user = user_factory(username="test_user_chunk_budget")
    col, item = collection(user)
    chunk = models.CollectionItemChunk(uid=uid(), collection=col)
    chunk.chunkFile.save("IGNORED", ContentFile(BODY))
    chunk.save()
    rev = revision(item, chunk, copies=6)
    return SimpleNamespace(user=user, col=col, item=item, chunk=chunk, rev=rev, token=AuthToken.objects.create(user=user))


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(routes.collection_router, prefix=API)
    app.include_router(routes.item_router, prefix=API + "/{collection_uid}")

    @app.exception_handler(CustomHttpException)
    async def handler(_request, exc):
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


def headers(stored):
    return {"Authorization": f"Token {stored.token.key}", "Accept": "application/msgpack"}


def bodies(rev):
    return [entry[1] for entry in rev["chunks"]]


def test_single_revision_and_download(client, stored):
    path = f"{API}/{stored.col.uid}/item/{stored.item.uid}/"
    reply = client.get(path, headers=headers(stored))
    assert reply.status_code == 200
    assert bodies(msgpack_decode(reply.content)["content"]) == [BODY, BODY, BODY, None, None, None]
    download = client.get(path + f"chunk/{stored.chunk.uid}/download/", headers=headers(stored))
    assert download.status_code == 200
    assert download.content == BODY


@pytest.mark.parametrize("endpoint", ["get", "list", "updates", "collection", "collections", "multi"])
def test_response_wide_repetition(client, stored, endpoint):
    # The read guard also handles existing relation graphs, independently of
    # whether today's write routes would create a particular graph.
    other = models.CollectionItem.objects.create(uid=uid(), collection=stored.col, version=1)
    revision(other, stored.chunk, copies=2)
    _col2, main2 = collection(stored.user)
    revision(main2, stored.chunk, copies=2)
    path = f"{API}/{stored.col.uid}"
    if endpoint == "get":
        reply = client.get(path + f"/item/{stored.item.uid}/", headers=headers(stored))
    elif endpoint == "list":
        reply = client.get(path + "/item/?withCollection=true", headers=headers(stored))
    elif endpoint == "updates":
        reply = client.post(path + "/item/fetch_updates/",
                            headers={**headers(stored), "Content-Type": "application/msgpack"},
                            content=routes.msgpack_encode([{"uid": item.uid} for item in [stored.item, other]]))
    elif endpoint == "collection":
        reply = client.get(path + "/", headers=headers(stored))
    elif endpoint == "collections":
        reply = client.get(API + "/", headers=headers(stored))
    else:
        reply = client.post(API + "/list_multi/", headers={**headers(stored), "Content-Type": "application/msgpack"},
                            content=routes.msgpack_encode({"collectionTypes": [bytes(m.collectionType.uid)
                                for m in models.CollectionMember.objects.filter(user=stored.user)]}))
    assert reply.status_code == 200
    data = msgpack_decode(reply.content)
    entries = data["data"] if "data" in data else [data]
    contents = [entry.get("item", entry)["content"] for entry in entries]
    actual = [body for content in contents for body in bodies(content)]
    assert sum(len(body) for body in actual if body is not None) <= 3 * len(BODY)
    assert None in actual


def test_second_reference_in_another_item_is_charged(stored):
    models.RevisionChunkRelation.objects.filter(revision=stored.rev).delete()
    models.RevisionChunkRelation.objects.create(chunk=stored.chunk, revision=stored.rev)
    other = models.CollectionItem.objects.create(uid=uid(), collection=stored.col, version=1)
    rev2 = revision(other, stored.chunk, copies=3)
    context = Context(stored.user, "auto")
    first = routes.CollectionItemRevisionInOut.from_orm_context(stored.rev, context)
    second = routes.CollectionItemRevisionInOut.from_orm_context(rev2, context)
    assert [chunk[1] for chunk in first.chunks] == [BODY]
    assert [chunk[1] for chunk in second.chunks] == [BODY, None, None]
    assert context.repeated_chunk_bytes_left == 0


def test_normal_content_header_duplicate_and_fresh_context(stored):
    models.RevisionChunkRelation.objects.filter(revision=stored.rev).delete()
    for _ in range(2):
        models.RevisionChunkRelation.objects.create(chunk=stored.chunk, revision=stored.rev)
    for _ in range(2):
        context = Context(stored.user, "auto", repeated_chunk_bytes_left=0)
        data = routes.CollectionItemRevisionInOut.from_orm_context(stored.rev, context)
        assert [body for _, body in data.chunks] == [BODY, BODY]
        assert not context.chunk_budget_omitted


def test_distinct_chunk_primary_keys_do_not_collide(stored):
    other_col, item = collection(stored.user)
    chunk = models.CollectionItemChunk(uid=stored.chunk.uid, collection=other_col)
    chunk.chunkFile.save("IGNORED", ContentFile(BODY))
    chunk.save()
    other_rev = revision(item, chunk)
    context = Context(stored.user, "auto", repeated_chunk_bytes_left=0)
    routes.CollectionItemRevisionInOut.from_orm_context(stored.rev, context)
    data = routes.CollectionItemRevisionInOut.from_orm_context(other_rev, context)
    assert data.chunks == [(chunk.uid, BODY)]


@pytest.mark.parametrize("budget,expected", [(0, 2), (7, 2), (8, 3)])
def test_boundary_and_bounded_reads(stored, monkeypatch, budget, expected):
    reads = []
    opened = []

    class TrackedFile:
        def __enter__(self):
            self.file = builtins.open(stored.chunk.chunkFile.path, "rb")
            opened.append(True)
            return self

        def __exit__(self, *args):
            self.file.close()

        def fileno(self):
            return self.file.fileno()

        def read(self, size=-1):
            reads.append(size)
            return self.file.read(size)

    monkeypatch.setattr(routes, "open", lambda *_args: TrackedFile(), raising=False)
    data = routes.CollectionItemRevisionInOut.from_orm_context(
        stored.rev, Context(stored.user, "auto", repeated_chunk_bytes_left=budget)
    )
    assert sum(body is not None for _, body in data.chunks) == expected
    assert reads[:2] == [-1, -1]
    assert reads[2:] == ([9] if budget == 8 else [])
    assert len(opened) == (2 if budget == 0 else 3)


def test_medium_never_opens_files(stored, monkeypatch):
    def forbidden(*_args):
        raise AssertionError("medium prefetch read a file")

    monkeypatch.setattr(routes, "open", forbidden, raising=False)
    context = Context(stored.user, "medium")
    data = routes.CollectionItemRevisionInOut.from_orm_context(stored.rev, context)
    assert all(body is None for _, body in data.chunks)
    assert not context.chunk_budget_omitted


def test_history_pages_keep_complete_normal_revisions(client, stored):
    models.RevisionChunkRelation.objects.filter(revision=stored.rev).delete()
    stored.rev.current = None
    stored.rev.save(update_fields=["current"])
    models.RevisionChunkRelation.objects.create(chunk=stored.chunk, revision=stored.rev)
    revisions = [stored.rev] + [revision(stored.item, stored.chunk, current=None) for _ in range(3)]
    revisions[-1].current = True
    revisions[-1].save(update_fields=["current"])
    path = f"{API}/{stored.col.uid}/item/{stored.item.uid}/revision/"
    seen, iterator, page_sizes = [], None, []
    for _ in range(5):
        params = {"iterator": iterator} if iterator else {}
        reply = client.get(path, headers=headers(stored), params=params)
        assert reply.status_code == 200
        page = msgpack_decode(reply.content)
        page_sizes.append(len(page["data"]))
        for rev in page["data"]:
            assert bodies(rev) == [BODY]
            seen.append(rev["uid"])
        if page["done"]:
            break
        assert page["iterator"] != iterator
        iterator = page["iterator"]
    else:
        pytest.fail("history never finished")
    assert seen == [rev.uid for rev in reversed(revisions)]
    assert page_sizes == [2, 2]


def test_history_first_revision_exhausts_budget_but_makes_progress(client, stored):
    # Older normal revision follows the current anomalous revision.
    older = revision(stored.item, stored.chunk, current=None)
    stored.rev.current = None
    stored.rev.save(update_fields=["current"])
    latest = revision(stored.item, stored.chunk, copies=6)
    path = f"{API}/{stored.col.uid}/item/{stored.item.uid}/revision/"
    first = msgpack_decode(client.get(path, headers=headers(stored)).content)
    assert [rev["uid"] for rev in first["data"]] == [latest.uid]
    assert None in bodies(first["data"][0])
    assert not first["done"]
    assert first["iterator"] == latest.uid
    second = msgpack_decode(client.get(path, headers=headers(stored), params={"iterator": first["iterator"]}).content)
    assert second["data"][0]["uid"] == older.uid
    assert bodies(second["data"][0]) == [BODY]


def test_catch_up_frame_shares_budget(stored):
    from etebase_server.fastapi.routers.websocket import TicketInner, TicketRequest, send_item_updates

    other = models.CollectionItem.objects.create(uid=uid(), collection=stored.col, version=1)
    revision(other, stored.chunk, copies=6)
    frames = []

    class Socket:
        path_params = {}

        async def send_bytes(self, data):
            frames.append(msgpack_decode(data))

    ticket = TicketInner(user=stored.user.pk, req=TicketRequest(collection=stored.col.uid), token_id=stored.token.pk)
    asyncio.run(send_item_updates(Socket(), stored.col, stored.user, None, ticket))
    assert len(frames) == 1
    actual = [body for item in frames[0]["data"] for body in bodies(item["content"])]
    assert sum(len(body) for body in actual if body is not None) <= 3 * len(BODY)
    assert None in actual
