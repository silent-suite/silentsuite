"""SELFHOST-04 characterization only (partial): item-list page size and allocation.

Source-confirmed context: ``item_list`` (routers/collection.py) passes the caller's
``limit`` straight to ``item_list_common`` / ``filter_by_stoken_and_limit`` with no
application cap. No requirement for any particular cap on this endpoint is
established, so this module asserts NO cap, expects NO failure and makes NO
exhaustion or OOM claim. It records actual counts, pagination continuity and
allocation peaks, and keeps healthy controls for small, default, continuation
and non-member requests.

Real code under test: the collection/item/member routers mounted with the
production prefixes (as in ``create_application``), token authentication and
the production exception handlers, on a pytest-django transactional database.

Budgets: 120 eligible items with 1 KiB meta each; 7 list requests in total
(<= 10); tracemalloc active only around two measured requests; each test
< 15 s; peak traced allocation < 256 MiB. Proxy body-cap rejection and
memory-limited workers are held and not represented here.
"""

from __future__ import annotations

import time
import tracemalloc
import typing as t

import pytest
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from etebase_server.django import models
from etebase_server.django.token_auth.models import AuthToken
from etebase_server.fastapi.dependencies import build_item_queryset
from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.utils import msgpack_decode
from etebase_server.myauth.models import get_typed_user_model

COLLECTION_PREFIX = "/api/v1/collection"
ITEM_COUNT = 120
META_BYTES = 1024
PEAK_BUDGET_BYTES = 256 * 1024 * 1024
TEST_TIME_BUDGET_S = 15.0
_requests_sent = {"count": 0}
MODULE_REQUEST_BUDGET = 10


def _make_app() -> FastAPI:
    from etebase_server.fastapi.routers.collection import collection_router, item_router
    from etebase_server.fastapi.routers.member import member_router

    app = FastAPI()
    app.include_router(collection_router, prefix=COLLECTION_PREFIX)
    app.include_router(item_router, prefix=COLLECTION_PREFIX + "/{collection_uid}")
    app.include_router(member_router, prefix=COLLECTION_PREFIX + "/{collection_uid}")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request: Request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    @app.exception_handler(RequestValidationError)
    async def _validation_exception_handler(_request: Request, exc: RequestValidationError):  # noqa: RUF029
        from pydantic import TypeAdapter

        errors = TypeAdapter(t.Dict[str, t.Any])
        return MsgpackResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=errors.dump_python({"detail": exc.errors()}),
        )

    return app


def _uid(*parts: object) -> str:
    return "-".join(str(p) for p in parts).ljust(40, "x")[:40]


class _Fixture(t.NamedTuple):
    client: TestClient
    member_token: str
    nonmember_token: str
    col_uid: str
    eligible: set


@pytest.fixture
def listing(transactional_db) -> t.Iterator[_Fixture]:
    User = get_typed_user_model()
    member = User.objects.create_user(username="selfhost04_member", email="sh04m@example.com", password=None)
    nonmember = User.objects.create_user(username="selfhost04_other", email="sh04o@example.com", password=None)
    col = models.Collection.objects.create(uid=_uid("sh04col"), owner=member)
    main_item = models.CollectionItem.objects.create(uid=col.uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("sh04revmain"), stoken=models.Stoken.objects.create(), item=main_item, meta=b"{}", current=True
    )
    col.main_item = main_item
    col.save()
    models.CollectionMember.objects.create(
        collection=col,
        user=member,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=models.CollectionType.objects.create(uid=_uid("sh04type").encode(), owner=member),
        stoken=models.Stoken.objects.create(),
    )
    for i in range(ITEM_COUNT):
        item = models.CollectionItem.objects.create(uid=_uid("sh04item", f"{i:04d}"), collection=col, version=1)
        models.CollectionItemRevision.objects.create(
            uid=_uid("sh04rev", f"{i:04d}"),
            stoken=models.Stoken.objects.create(),
            item=item,
            meta=bytes([i % 251]) * META_BYTES,
            current=True,
        )
    # Exactly what the item_list route pages over (withCollection=False adds
    # parent__isnull=True; item_list_common adds revisions__current=True).
    eligible = set(
        build_item_queryset(col)
        .filter(parent__isnull=True)
        .filter(revisions__current=True)
        .values_list("uid", flat=True)
    )
    assert len(eligible) == ITEM_COUNT, len(eligible)  # receipt
    client = TestClient(_make_app())
    try:
        yield _Fixture(
            client=client,
            member_token=AuthToken.objects.create(user=member).key,
            nonmember_token=AuthToken.objects.create(user=nonmember).key,
            col_uid=col.uid,
            eligible=eligible,
        )
    finally:
        client.close()


def _get(fx: _Fixture, token: str, query: str = ""):
    assert _requests_sent["count"] < MODULE_REQUEST_BUDGET, "SELFHOST-04 request budget exceeded"
    _requests_sent["count"] += 1
    url = f"{COLLECTION_PREFIX}/{fx.col_uid}/item/{query}"
    return fx.client.get(url, headers={"Accept": "application/msgpack", "Authorization": f"Token {token}"})


def _measured_get(fx: _Fixture, query: str) -> tuple[int, dict, int]:
    tracemalloc.start(1)
    try:
        tracemalloc.reset_peak()
        response = _get(fx, fx.member_token, query)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    body = msgpack_decode(response.content) if response.status_code == 200 else {}
    return response.status_code, body, peak


def test_selfhost04_control_limit_1_returns_one_item_with_continuation(listing):
    started = time.monotonic()
    status_code, body, peak = _measured_get(listing, "?limit=1")
    print("[SELFHOST-04] limit=1 status=%d n=%d done=%s peak=%d" % (status_code, len(body.get("data", [])), body.get("done"), peak))
    assert status_code == 200
    assert len(body["data"]) == 1
    assert body["done"] is False
    assert body["stoken"]
    assert peak < PEAK_BUDGET_BYTES
    assert time.monotonic() - started < TEST_TIME_BUDGET_S


def test_selfhost04_control_default_limit_pages_through_all_items_once(listing):
    started = time.monotonic()
    pages = []
    stoken = None
    for _ in range(3):  # 50 + 50 + 20
        query = f"?stoken={stoken}" if stoken else ""
        response = _get(listing, listing.member_token, query)
        assert response.status_code == 200, response.content
        body = msgpack_decode(response.content)
        pages.append(body)
        stoken = body["stoken"]
        if body["done"]:
            break
    sizes = [len(p["data"]) for p in pages]
    uids = [item["uid"] for p in pages for item in p["data"]]
    print("[SELFHOST-04] default pagination sizes=%s done=%s" % (sizes, [p["done"] for p in pages]))
    assert sizes == [50, 50, 20]
    assert [p["done"] for p in pages] == [False, False, True]
    assert len(uids) == len(set(uids)) and set(uids) == listing.eligible
    assert time.monotonic() - started < TEST_TIME_BUDGET_S


def test_selfhost04_characterize_large_limits_return_all_eligible_items(listing):
    # Characterization only: records that the endpoint honours a caller limit
    # above the default with no application cap. Not a defect assertion.
    started = time.monotonic()
    status_120, body_120, peak_120 = _measured_get(listing, f"?limit={ITEM_COUNT}")
    response_1000 = _get(listing, listing.member_token, "?limit=1000")
    body_1000 = msgpack_decode(response_1000.content) if response_1000.status_code == 200 else {}
    uids_120 = [i["uid"] for i in body_120.get("data", [])]
    uids_1000 = [i["uid"] for i in body_1000.get("data", [])]
    print(
        "[SELFHOST-04] limit=%d status=%d n=%d done=%s peak=%d | limit=1000 status=%d n=%d done=%s"
        % (
            ITEM_COUNT,
            status_120,
            len(uids_120),
            body_120.get("done"),
            peak_120,
            response_1000.status_code,
            len(uids_1000),
            body_1000.get("done"),
        )
    )
    assert status_120 == 200 and response_1000.status_code == 200
    assert len(uids_120) == ITEM_COUNT and set(uids_120) == listing.eligible and body_120["done"] is True
    assert set(uids_1000) == listing.eligible and len(uids_1000) == ITEM_COUNT and body_1000["done"] is True
    assert peak_120 < PEAK_BUDGET_BYTES
    assert time.monotonic() - started < TEST_TIME_BUDGET_S


def test_selfhost04_control_nonmember_is_refused_without_items(listing):
    response = _get(listing, listing.nonmember_token)
    print("[SELFHOST-04] nonmember status=%d" % response.status_code)
    assert response.status_code != 200
    assert response.status_code in (401, 403, 404)
    decoded = msgpack_decode(response.content) if response.content else {}
    assert "data" not in decoded
