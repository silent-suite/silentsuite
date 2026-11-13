"""Every list endpoint clamps the requested page size to 1..MAX_LIST_LIMIT.

A requested `limit` above the cap is clamped, not refused: the response is a
normal page with `done=False` and a cursor (stoken or iterator), and the client
fetches the rest the way it already pages. A limit within range is honoured
unchanged. Zero and negative limits page one row at a time instead of returning
a non-advancing empty page or reaching invalid queryset slicing.

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

API = "/api/v1"
COLLECTION_PREFIX = f"{API}/collection"
PATCHED_CAP = 3
ROWS = 5

_counter = itertools.count()


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43), unique per call."""
    return f"{prefix}-{next(_counter):04d}-" + "x" * 30


@pytest.fixture
def capped(monkeypatch):
    from etebase_server.fastapi import utils

    monkeypatch.setattr(utils, "MAX_LIST_LIMIT", PATCHED_CAP)


@pytest.fixture
def client() -> TestClient:
    """The list routers mounted with the same prefixes as `create_application`."""
    from etebase_server.fastapi.routers.collection import collection_router, item_router
    from etebase_server.fastapi.routers.invitation import invitation_incoming_router, invitation_outgoing_router
    from etebase_server.fastapi.routers.member import member_router

    app = FastAPI()
    app.include_router(collection_router, prefix=COLLECTION_PREFIX)
    app.include_router(item_router, prefix=f"{COLLECTION_PREFIX}/{{collection_uid}}")
    app.include_router(member_router, prefix=f"{COLLECTION_PREFIX}/{{collection_uid}}")
    app.include_router(invitation_incoming_router, prefix=f"{API}/invitation/incoming")
    app.include_router(invitation_outgoing_router, prefix=f"{API}/invitation/outgoing")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


# ---------------------------------------------------------------------------
# Synthetic data
# ---------------------------------------------------------------------------


def _token(user) -> str:
    from etebase_server.django.token_auth.models import AuthToken

    return AuthToken.objects.create(user=user).key


def _add_revision(item, current: t.Optional[bool] = True):
    from etebase_server.django import models

    return models.CollectionItemRevision.objects.create(
        uid=_uid("rev"), stoken=models.Stoken.objects.create(), item=item, meta=b"{}", current=current
    )


def _add_item(collection, uid: str):
    from etebase_server.django import models

    item = models.CollectionItem.objects.create(uid=uid, collection=collection, version=1)
    _add_revision(item)
    return item


def _add_member(collection, user, access_level):
    from etebase_server.django import models

    return models.CollectionMember.objects.create(
        collection=collection,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=access_level,
        collectionType=models.CollectionType.objects.create(uid=_uid("type").encode(), owner=user),
        stoken=models.Stoken.objects.create(),
    )


def _add_collection(user):
    """A collection with its main item and an ADMIN membership for `user`."""
    from etebase_server.django import models

    uid = _uid("col")
    collection = models.Collection.objects.create(uid=uid, owner=user)
    collection.main_item = _add_item(collection, uid)
    collection.save(update_fields=["main_item"])
    _add_member(collection, user, models.AccessLevels.ADMIN)
    return collection


class Case(t.NamedTuple):
    path: str
    token: str
    cursor: str  # query parameter and response field that carries the page cursor
    key: t.Callable[[dict], str]  # identifies one entry of a page
    expected: t.List[str]


def _items_case(user_factory) -> Case:
    owner = user_factory(username="test_user_limits", email="limits@example.com")
    collection = _add_collection(owner)
    uids = [_add_item(collection, _uid("item")).uid for _ in range(ROWS)]
    return Case(f"{COLLECTION_PREFIX}/{collection.uid}/item/", _token(owner), "stoken", lambda e: e["uid"], uids)


def _collections_case(user_factory) -> Case:
    owner = user_factory(username="test_user_limits", email="limits@example.com")
    uids = [_add_collection(owner).uid for _ in range(ROWS)]
    return Case(f"{COLLECTION_PREFIX}/", _token(owner), "stoken", lambda e: e["item"]["uid"], uids)


def _revisions_case(user_factory) -> Case:
    from etebase_server.django import models

    owner = user_factory(username="test_user_limits", email="limits@example.com")
    collection = _add_collection(owner)
    item = models.CollectionItem.objects.create(uid=_uid("item"), collection=collection, version=1)
    # One current revision, the older ones superseded (`current=None`).
    uids = [_add_revision(item, current=True if i == ROWS - 1 else None).uid for i in range(ROWS)]
    path = f"{COLLECTION_PREFIX}/{collection.uid}/item/{item.uid}/revision/"
    return Case(path, _token(owner), "iterator", lambda e: e["uid"], uids)


def _members_case(user_factory) -> Case:
    from etebase_server.django import models

    owner = user_factory(username="test_user_limits", email="limits@example.com")
    collection = _add_collection(owner)
    usernames = [owner.username]
    for i in range(ROWS - 1):
        member = user_factory(username=f"test_user_member_{i}", email=f"member{i}@example.com")
        _add_member(collection, member, models.AccessLevels.READ_ONLY)
        usernames.append(member.username)
    path = f"{COLLECTION_PREFIX}/{collection.uid}/member/"
    return Case(path, _token(owner), "iterator", lambda e: e["username"], usernames)


def _invitations(user_factory) -> t.Tuple[t.Any, t.Any, t.List[str]]:
    """ROWS invitations from `owner` (one per collection) to `recipient`."""
    from etebase_server.django import models

    owner = user_factory(username="test_user_limits", email="limits@example.com")
    recipient = user_factory(username="test_user_invitee", email="invitee@example.com")
    uids = []
    for _ in range(ROWS):
        collection = _add_collection(owner)
        invitation = models.CollectionInvitation.objects.create(
            uid=_uid("inv"),
            fromMember=collection.members.get(user=owner),
            user=recipient,
            signedEncryptionKey=b"\x02" * 32,
        )
        uids.append(invitation.uid)
    return owner, recipient, uids


def _outgoing_case(user_factory) -> Case:
    owner, _, uids = _invitations(user_factory)
    return Case(f"{API}/invitation/outgoing/", _token(owner), "iterator", lambda e: e["uid"], uids)


def _incoming_case(user_factory) -> Case:
    _, recipient, uids = _invitations(user_factory)
    return Case(f"{API}/invitation/incoming/", _token(recipient), "iterator", lambda e: e["uid"], uids)


CASES = {
    "items": _items_case,
    "collections": _collections_case,
    "revisions": _revisions_case,
    "members": _members_case,
    "invitations-outgoing": _outgoing_case,
    "invitations-incoming": _incoming_case,
}


def _page_through(client: TestClient, case: Case, limit: int) -> t.List[t.List[str]]:
    """Follow the cursor until `done`, returning the entries of each page."""
    pages: t.List[t.List[str]] = []
    cursor = None
    while True:
        params = {"limit": limit, "prefetch": "auto"}
        if cursor is not None:
            params[case.cursor] = cursor
        response = client.get(
            case.path,
            params=params,
            headers={"Accept": "application/msgpack", "Authorization": f"Token {case.token}"},
        )
        assert response.status_code == 200, (response.status_code, response.content[:200])
        page = msgpack_decode(response.content)
        pages.append([case.key(entry) for entry in page["data"]])
        if page["done"]:
            return pages
        cursor = page[case.cursor]
        assert len(pages) <= ROWS, f"paging did not terminate: {pages}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_shipped_cap_covers_client_page_sizes():
    from etebase_server.fastapi.utils import MAX_LIST_LIMIT

    # Android asks for 100 per page during setup and 30 for members, invitations
    # and revisions; web, bridge and the upstream Etebase clients send no limit
    # (server default 50).
    assert MAX_LIST_LIMIT == 500


@pytest.mark.parametrize(
    ("requested", "expected"),
    [(-5, 1), (0, 1), (1, 1), (50, 50), (500, 500), (501, 500), (10**9, 500)],
)
def test_clamp_list_limit(requested, expected):
    from etebase_server.fastapi.utils import clamp_list_limit

    assert clamp_list_limit(requested) == expected


@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("endpoint", list(CASES))
@pytest.mark.parametrize(
    ("limit", "page_sizes"),
    [
        pytest.param(10_000, [PATCHED_CAP, ROWS - PATCHED_CAP], id="above-cap-clamped"),
        pytest.param(2, [2, 2, 1], id="below-cap-honoured"),
        pytest.param(0, [1] * ROWS, id="zero-pages-one"),
        pytest.param(-5, [1] * ROWS, id="negative-pages-one"),
    ],
)
def test_list_page_size(capped, client, user_factory, endpoint, limit, page_sizes):
    case = CASES[endpoint](user_factory)

    pages = _page_through(client, case, limit)

    assert [len(page) for page in pages] == page_sizes
    assert sorted(itertools.chain(*pages)) == sorted(case.expected)
