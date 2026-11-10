"""SELFHOST-02 partial reproduction attempt: websocket catch-up paging.

Real code under test: ``etebase_server.fastapi.routers.websocket.send_item_updates``
with the real ORM, ``build_item_queryset`` (what ``get_item_queryset`` returns) and
``item_list_common`` (limit=50, prefetch="auto").

Partial scope: the ticket route, Redis and the websocket ``accept()`` upstream are
NOT exercised. Driving the whole websocket route would leave the server-side
catch-up loop unbounded, because the endpoint never calls ``receive()`` during
catch-up. The coroutine is therefore given a recording stand-in for the websocket
that only stores the bytes it is sent and raises a private exception once a frame
budget is reached. It does not influence pagination.

Bounds per run: at most 3 frames and 20 s (``asyncio.wait_for``); 2 runs in total.
Database: pytest-django ``transactional_db``, because ``sync_to_async`` runs the
ORM in another thread (same reason the existing route tests use transactions).
"""

from __future__ import annotations

import asyncio
import time

import pytest

from etebase_server.django import models
from etebase_server.fastapi.dependencies import build_item_queryset
from etebase_server.fastapi.utils import msgpack_decode
from etebase_server.myauth.models import get_typed_user_model

FRAME_BUDGET = 3
RUN_TIMEOUT_S = 20.0


class _FrameBudgetExhausted(Exception):
    """Raised by the recording socket after FRAME_BUDGET frames."""


class _RecordingSocket:
    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.frames: list[bytes] = []

    async def send_bytes(self, data: bytes) -> None:  # noqa: RUF029 - matches WebSocket.send_bytes
        self.frames.append(bytes(data))
        if len(self.frames) >= self.budget:
            raise _FrameBudgetExhausted()


def _uid(*parts: object) -> str:
    """A model-valid uid (``^[a-zA-Z0-9\\-_]{20,}$``, max 43)."""
    return "-".join(str(p) for p in parts).ljust(40, "x")[:40]


def _make_collection(user, seed: str) -> models.Collection:
    col = models.Collection.objects.create(uid=_uid("ws02col", seed), owner=user)
    main_item = models.CollectionItem.objects.create(uid=col.uid, collection=col, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("ws02revmain", seed), stoken=models.Stoken.objects.create(), item=main_item, meta=b"{}", current=True
    )
    col.main_item = main_item
    col.save()
    collection_type = models.CollectionType.objects.create(uid=_uid("ws02type", seed).encode(), owner=user)
    models.CollectionMember.objects.create(
        collection=col,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=collection_type,
        stoken=models.Stoken.objects.create(),
    )
    return col


def _eligible_uids(col: models.Collection) -> set[str]:
    # Exactly the queryset send_item_updates pages over (item_list_common adds
    # revisions__current=True on top of build_item_queryset).
    return set(build_item_queryset(col).filter(revisions__current=True).values_list("uid", flat=True))


def _fill_to(col: models.Collection, seed: str, target: int) -> set[str]:
    i = 0
    while len(_eligible_uids(col)) < target:
        item = models.CollectionItem.objects.create(uid=_uid("ws02item", seed, f"{i:04d}"), collection=col, version=1)
        models.CollectionItemRevision.objects.create(
            uid=_uid("ws02rev", seed, f"{i:04d}"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=True
        )
        i += 1
    eligible = _eligible_uids(col)
    assert len(eligible) == target, (seed, len(eligible))
    return eligible


def _run_sender(col: models.Collection, user) -> tuple[str, list[dict], float]:
    from etebase_server.fastapi.routers.websocket import send_item_updates

    socket = _RecordingSocket(FRAME_BUDGET)
    started = time.monotonic()
    try:
        asyncio.run(asyncio.wait_for(send_item_updates(socket, col, user, None), timeout=RUN_TIMEOUT_S))
        outcome = "returned"
    except _FrameBudgetExhausted:
        outcome = "frame_budget_exhausted"
    except TimeoutError:
        outcome = "timeout"
    elapsed = time.monotonic() - started
    frames = [msgpack_decode(frame) for frame in socket.frames]
    return outcome, frames, elapsed


def _frame_uids(frame: dict) -> list[str]:
    return [item["uid"] for item in frame["data"]]


@pytest.fixture
def owner(transactional_db):
    User = get_typed_user_model()
    return User.objects.create_user(username="selfhost02_owner", email="selfhost02@example.com", password=None)


def test_selfhost02_control_50_eligible_items_finish_in_one_frame(owner):
    col = _make_collection(owner, "c50")
    eligible = _fill_to(col, "c50", 50)

    outcome, frames, elapsed = _run_sender(col, owner)
    print("[SELFHOST-02 control] outcome=%s frames=%d elapsed=%.2fs" % (outcome, len(frames), elapsed))

    observed = {
        "outcome": outcome,
        "frames": len(frames),
        "done": [f["done"] for f in frames],
        "uids_match": len(frames) == 1 and set(_frame_uids(frames[0])) == eligible,
        "distinct": len(frames) == 1 and len(set(_frame_uids(frames[0]))) == 50,
    }
    assert observed == {"outcome": "returned", "frames": 1, "done": [True], "uids_match": True, "distinct": True}
    assert elapsed < RUN_TIMEOUT_S


def test_selfhost02_51_eligible_items_page_once_each_and_finish(owner):
    col = _make_collection(owner, "c51")
    eligible = _fill_to(col, "c51", 51)
    assert len(eligible) == 51  # receipt: the real eligible count before probing

    outcome, frames, elapsed = _run_sender(col, owner)
    per_frame = [_frame_uids(f) for f in frames]
    union = set().union(*map(set, per_frame)) if per_frame else set()
    pairwise_disjoint = sum(len(u) for u in per_frame) == len(union)
    print(
        "[SELFHOST-02] outcome=%s frames=%d sizes=%s done=%s stokens=%s elapsed=%.2fs"
        % (
            outcome,
            len(frames),
            [len(u) for u in per_frame],
            [f["done"] for f in frames],
            [f.get("stoken") for f in frames],
            elapsed,
        )
    )

    # Both expected-correct observations are evaluated before asserting, so a
    # budget failure cannot hide the frame-content result (or vice versa).
    observed = {
        "terminated_within_budget": outcome == "returned",
        "frames_pairwise_disjoint_and_complete": pairwise_disjoint and union == eligible,
    }
    assert observed == {"terminated_within_budget": True, "frames_pairwise_disjoint_and_complete": True}, observed
    assert elapsed < RUN_TIMEOUT_S + 5
