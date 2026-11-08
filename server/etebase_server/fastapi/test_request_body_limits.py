"""Request-body limit contracts, written tests-first (PLAN-r4 S1).

The application does not bound request bodies yet, so the request-limit,
configuration-safety and setting-existence tests below are expected to fail on
the current source; the healthy controls must pass both before and after the
implementation. Every test only imports modules that already exist and drives
the production application (`create_application`) or the real routers over
HTTP/ASGI, so the module collects on the unmodified tree.

Limits are selected through pytest-django's `settings` fixture. On the current
source nothing reads `ETEBASE_MAX_AUTH_REQUEST_BYTES` or
`ETEBASE_MAX_REQUEST_BYTES`, so those overrides are inert there.

Evidence classes (see S1-MANIFEST.json for the literal node IDs):
- behavioural RED: HTTP/ASGI request-limit cases;
- config-safety RED: `test_invalid_limit_settings_fail_closed`;
- existence RED: `test_default_limits_are_documented_values`,
  `test_valid_overrides_are_applied`;
- healthy controls: everything named `*_succeeds`, `*_preserved`, `*_still_*`,
  `*_unchanged`, `*_not_413` and the nested-error characterization.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.django import models
from etebase_server.django.token_auth.models import AuthToken
from etebase_server.fastapi import msgpack as msgpack_module
from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    build_signed_response,
    decode_response,
    login_challenge,
    msgpack_post,
    perform_login,
)
from etebase_server.fastapi.routers import collection as collection_module
from etebase_server.fastapi.routers.billing_link import billing_link_router
from etebase_server.fastapi.utils import msgpack_decode, msgpack_encode
from etebase_server.myauth.models import get_typed_user_model

pytestmark = pytest.mark.django_db(transaction=True)

SERVER_DIR = Path(__file__).resolve().parents[2]
AUTH_SETTING = "ETEBASE_MAX_AUTH_REQUEST_BYTES"
DEFAULT_SETTING = "ETEBASE_MAX_REQUEST_BYTES"
AUTH_LIMIT = 65536  # documented default for the authentication tier
SELECTED_DEFAULT = 1048576  # a valid (floor) DEFAULT selection, used to keep fixtures small
COLLECTION_PREFIX = "/api/v1/collection"
LOGIN_CHALLENGE = f"{AUTH_PREFIX}/login_challenge/"
BILLING_CONSUME = "/api/v1/billing/link-proof/consume/"
PARSE_ERROR_DETAIL = "There was an error parsing the body"
KIB = 1024
MIB = 1024 * 1024


# ---------------------------------------------------------------------------
# Production application and data fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def prod_app(settings, tmp_path):
    """The real FastAPI application with its production exception handlers."""
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["testserver"]
    static_root = tmp_path / "static"
    static_root.mkdir()
    settings.STATIC_ROOT = str(static_root)
    settings.MEDIA_ROOT = str(tmp_path / "media")
    from etebase_server.fastapi.main import create_application

    return create_application()


@pytest.fixture
def client(prod_app):
    return TestClient(prod_app, raise_server_exceptions=False)


def _uid(prefix: str) -> str:
    """A model-valid uid (`^[a-zA-Z0-9\\-_]{20,}$`, max 43) unique per prefix."""
    return (prefix + "-" + "x" * 43)[:40]


@pytest.fixture
def owner(user_factory):
    """A user with a token and one collection they administer."""
    user = user_factory(username="limits_owner", email="limits-owner@example.com")
    token = AuthToken.objects.create(user=user).key
    collection = models.Collection.objects.create(uid=_uid("col-limits"), owner=user)
    main_item = models.CollectionItem.objects.create(uid=collection.uid, collection=collection, version=1)
    models.CollectionItemRevision.objects.create(
        uid=_uid("rev-limits-main"),
        stoken=models.Stoken.objects.create(),
        item=main_item,
        meta=b"{}",
        current=True,
    )
    collection.main_item = main_item
    collection.save()
    collection_type = models.CollectionType.objects.create(uid=_uid("type-limits").encode(), owner=user)
    models.CollectionMember.objects.create(
        collection=collection,
        user=user,
        encryptionKey=b"\x01" * 32,
        accessLevel=models.AccessLevels.ADMIN,
        collectionType=collection_type,
        stoken=models.Stoken.objects.create(),
    )
    return SimpleNamespace(user=user, token=token, collection=collection)


def _item_body(item_uid: str, revision_uid: str, chunks=()) -> dict:
    return {
        "uid": item_uid,
        "version": 1,
        "encryptionKey": None,
        "etag": None,
        "content": {"uid": revision_uid, "meta": b"{}", "deleted": False, "chunks": list(chunks)},
    }


def _batch_body(item_uid: str, revision_uid: str, chunks=()) -> dict:
    """The SDK's batch/transaction envelope with inline chunk content."""
    return {"items": [_item_body(item_uid, revision_uid, chunks)], "deps": None}


def _headers(token: str | None = None, content_type: str | None = "application/msgpack") -> dict:
    headers = {"Accept": "application/msgpack"}
    if content_type is not None:
        headers["Content-Type"] = content_type
    if token is not None:
        headers["Authorization"] = f"Token {token}"
    return headers


def _username_body(total: int) -> bytes:
    """A msgpack `{"username": ...}` body of exactly `total` bytes."""
    length = total - 13
    body = msgpack_encode({"username": "u" * length})
    length -= len(body) - total
    body = msgpack_encode({"username": "u" * length})
    assert len(body) == total
    return body


def _split(body: bytes, size: int) -> list[bytes]:
    return [body[offset : offset + size] for offset in range(0, len(body), size)]


def _overflow_delivery(chunks: list[bytes], limit: int) -> int:
    """1-based index of the fragment whose arrival first exceeds `limit`."""
    total = 0
    for index, chunk in enumerate(chunks, start=1):
        total += len(chunk)
        if total > limit:
            return index
    raise AssertionError("fixture never exceeds the limit")


def _stored_chunk_bytes(collection, chunk_uid: str) -> bytes:
    chunk = models.CollectionItemChunk.objects.get(uid=chunk_uid, collection=collection)
    with chunk.chunkFile.open("rb") as handle:
        return handle.read()


# ---------------------------------------------------------------------------
# Raw ASGI harness: exact control over Content-Length and body fragments
# ---------------------------------------------------------------------------


def _asgi(app, method: str, path: str, headers: list[tuple[str, str]], chunks: list[bytes]):
    """Drive one request through the ASGI app and record what it consumed.

    `deliveries` counts the `http.request` body fragments the application
    actually pulled from `receive`. Exceptions escaping the app are recorded,
    so an unexpected server error is an assertion failure, not a test error.
    """
    pending = list(chunks)
    state = {"deliveries": 0, "status": None, "headers": [], "body": b"", "exception": None}

    async def receive():
        if pending:
            state["deliveries"] += 1
            fragment = pending.pop(0)
            return {"type": "http.request", "body": fragment, "more_body": bool(pending)}
        await asyncio.sleep(0)
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            state["status"] = message["status"]
            state["headers"] = message.get("headers", [])
        elif message["type"] == "http.response.body":
            state["body"] += message.get("body", b"")

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"testserver")]
        + [(name.lower().encode("latin-1"), value.encode("latin-1")) for name, value in headers],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
    }

    async def run():
        try:
            await app(scope, receive, send)
        except Exception as error:  # noqa: BLE001 - recorded and asserted on by the caller
            state["exception"] = repr(error)

    asyncio.run(run())
    return SimpleNamespace(**state)


def _code(raw_body: bytes):
    return msgpack_decode(raw_body)["code"]


# ---------------------------------------------------------------------------
# Behavioural RED: request limits
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "case",
    [
        pytest.param("auth", id="auth-login-challenge"),
        pytest.param("default", id="default-item-batch"),
        pytest.param("raw", id="raw-upload-unauthenticated"),
    ],
)
def test_declared_oversize_rejected_without_receiving_body(prod_app, settings, owner, case):
    settings.ETEBASE_MAX_REQUEST_BYTES = SELECTED_DEFAULT
    collection_uid = owner.collection.uid
    if case == "auth":
        method, path, content_type, declared = "POST", LOGIN_CHALLENGE, "application/msgpack", AUTH_LIMIT + 1
    elif case == "default":
        method, path = "POST", f"{COLLECTION_PREFIX}/{collection_uid}/item/batch/"
        content_type, declared = "application/msgpack", SELECTED_DEFAULT + 1
    else:
        method = "PUT"
        path = f"{COLLECTION_PREFIX}/{collection_uid}/item/{collection_uid}/chunk/{_uid('chunk-declared')}/"
        content_type, declared = "application/octet-stream", SELECTED_DEFAULT + 1

    result = _asgi(
        prod_app,
        method,
        path,
        [("content-type", content_type), ("accept", "application/msgpack"), ("content-length", str(declared))],
        [b"\x00" * declared],
    )

    assert result.exception is None, result.exception
    assert result.status == 413, (result.status, result.body[:200])
    assert result.deliveries == 0, "a declared oversize body must be refused before any fragment is received"
    assert _code(result.body) == "request_too_large"


@pytest.mark.parametrize(
    "case",
    [
        pytest.param("auth", id="auth-login-challenge"),
        pytest.param("default", id="default-item-batch-unauthenticated"),
    ],
)
def test_streamed_overflow_stops_receiving_and_never_decodes(prod_app, settings, owner, case):
    settings.ETEBASE_MAX_REQUEST_BYTES = SELECTED_DEFAULT
    if case == "auth":
        path, limit = LOGIN_CHALLENGE, AUTH_LIMIT
        chunks = _split(_username_body(8 * 16 * KIB), 16 * KIB)
    else:
        path, limit = f"{COLLECTION_PREFIX}/{owner.collection.uid}/item/batch/", SELECTED_DEFAULT
        body = msgpack_encode(
            _batch_body(_uid("item-stream"), _uid("rev-stream"), [(_uid("chunk-stream"), b"\x07" * (1536 * KIB))])
        )
        chunks = _split(body, 256 * KIB)
    expected_deliveries = _overflow_delivery(chunks, limit)

    with patch.object(msgpack_module, "msgpack_decode", wraps=msgpack_module.msgpack_decode) as decode_spy:
        result = _asgi(
            prod_app,
            "POST",
            path,
            [("content-type", "application/msgpack"), ("accept", "application/msgpack")],
            chunks,
        )

    assert result.exception is None, result.exception
    assert result.status == 413, (result.status, result.body[:200])
    assert result.deliveries == expected_deliveries, "receiving must stop at the fragment that crosses the limit"
    assert decode_spy.call_count == 0, "an oversize body must never reach the msgpack decoder"
    assert _code(result.body) == "request_too_large"


def test_false_small_content_length_counts_actual_bytes(prod_app):
    chunks = _split(_username_body(5 * 16 * KIB), 16 * KIB)
    expected_deliveries = _overflow_delivery(chunks, AUTH_LIMIT)

    with patch.object(msgpack_module, "msgpack_decode", wraps=msgpack_module.msgpack_decode) as decode_spy:
        result = _asgi(
            prod_app,
            "POST",
            LOGIN_CHALLENGE,
            [("content-type", "application/msgpack"), ("accept", "application/msgpack"), ("content-length", "16")],
            chunks,
        )

    assert result.exception is None, result.exception
    assert result.status == 413, (result.status, result.body[:200])
    assert result.deliveries == expected_deliveries
    assert decode_spy.call_count == 0
    assert _code(result.body) == "request_too_large"


@pytest.mark.parametrize(
    "length_headers",
    [
        pytest.param([("content-length", "abc")], id="non-digit"),
        pytest.param([("content-length", "-1")], id="negative"),
        pytest.param([("content-length", "1e3")], id="exponent"),
        pytest.param([("content-length", "²")], id="superscript-digit"),
        pytest.param([("content-length", "24"), ("content-length", "24")], id="duplicate-headers"),
    ],
)
def test_invalid_or_duplicate_content_length_is_400(prod_app, length_headers):
    body = msgpack_encode({"username": "nobody-request-limits"})

    result = _asgi(
        prod_app,
        "POST",
        LOGIN_CHALLENGE,
        [("content-type", "application/msgpack"), ("accept", "application/msgpack"), *length_headers],
        [body],
    )

    assert result.exception is None, result.exception
    assert result.status == 400, (result.status, result.body[:200])
    assert result.deliveries == 0
    assert _code(result.body) == "invalid_content_length"


def test_auth_default_limit_plus_one_is_413_msgpack_media(client):
    response = client.post(LOGIN_CHALLENGE, content=_username_body(AUTH_LIMIT + 1), headers=_headers())

    assert response.status_code == 413, response.content[:200]
    assert response.headers["content-type"].startswith("application/msgpack")
    assert decode_response(response)["code"] == "request_too_large"


@pytest.mark.parametrize(
    "content_kind",
    [pytest.param("json", id="json"), pytest.param("missing", id="missing-content-type")],
)
def test_json_and_missing_content_type_bounded_on_auth(client, content_kind):
    if content_kind == "json":
        prefix, suffix = b'{"username": "', b'"}'
        payload = prefix + b"u" * (AUTH_LIMIT + 1 - len(prefix) - len(suffix)) + suffix
        headers = {"Content-Type": "application/json"}
    else:
        payload = _username_body(AUTH_LIMIT + 1)
        headers = {}
    assert len(payload) == AUTH_LIMIT + 1

    response = client.post(LOGIN_CHALLENGE, content=payload, headers=headers)

    assert response.status_code == 413, response.content[:200]
    assert decode_response(response)["code"] == "request_too_large"


def test_raised_auth_limit_admits_larger_change_password_and_rejects_beyond(
    client, settings, user_factory, signing_key
):
    """An account whose stored opaque `encryptedContent` is large can still
    change its password once the operator raises the authentication limit."""
    from etebase_server.django.models import UserInfo

    settings.ETEBASE_MAX_AUTH_REQUEST_BYTES = 256 * KIB
    username = "limits_large_account"
    user = user_factory(username=username, email="limits-large@example.com")
    stored = b"\x5a" * (200 * KIB)
    UserInfo.objects.filter(owner=user).update(encryptedContent=stored)
    token = AuthToken.objects.create(user=user).key

    def change_password(encrypted_content: bytes):
        challenge_response, challenge = login_challenge(client, username)
        assert challenge_response.status_code == 200, challenge_response.content[:200]
        body = build_signed_response(
            username=username,
            challenge_bytes=challenge["challenge"],
            signing_key=signing_key,
            action="changePassword",
            extra={"loginPubkey": bytes(signing_key.verify_key), "encryptedContent": encrypted_content},
        )
        return msgpack_post(
            client, f"{AUTH_PREFIX}/change_password/", body, headers={"Authorization": f"Token {token}"}
        )

    admitted = change_password(stored)
    assert admitted.status_code == 204, admitted.content[:200]

    refused = change_password(b"\x5b" * (300 * KIB))
    assert refused.status_code == 413, refused.content[:200]
    assert decode_response(refused)["code"] == "request_too_large"
    assert bytes(UserInfo.objects.get(owner=user).encryptedContent) == stored


def test_raised_auth_limit_admits_larger_signup_and_rejects_beyond(
    client, settings, login_pubkey, encryption_pubkey
):
    settings.ETEBASE_MAX_AUTH_REQUEST_BYTES = 256 * KIB

    def signup(username: str, encrypted_content: bytes):
        body = {
            "user": {"username": username, "email": f"{username}@example.com"},
            "salt": os.urandom(32),
            "loginPubkey": login_pubkey,
            "pubkey": encryption_pubkey,
            "encryptedContent": encrypted_content,
        }
        return msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)

    admitted = signup("limits_large_signup", b"\x11" * (200 * KIB))
    assert admitted.status_code in (200, 201), admitted.content[:200]

    refused = signup("limits_oversize_signup", b"\x12" * (300 * KIB))
    assert refused.status_code == 413, refused.content[:200]
    assert decode_response(refused)["code"] == "request_too_large"
    assert not get_typed_user_model().objects.filter(username__iexact="limits_oversize_signup").exists()


def test_selected_default_limit_rejects_batch_before_auth_dependency(client, settings, owner):
    settings.ETEBASE_MAX_REQUEST_BYTES = SELECTED_DEFAULT
    item_uid = _uid("item-preauth")
    body = msgpack_encode(
        _batch_body(item_uid, _uid("rev-preauth"), [(_uid("chunk-preauth"), b"\x09" * (1100 * KIB))])
    )
    assert len(body) > SELECTED_DEFAULT

    response = client.post(
        f"{COLLECTION_PREFIX}/{owner.collection.uid}/item/batch/", content=body, headers=_headers()
    )

    assert response.status_code == 413, response.content[:200]
    assert decode_response(response)["code"] == "request_too_large"
    assert not owner.collection.items.filter(uid=item_uid).exists()


def test_raised_default_limit_admits_larger_atomic_transaction(client, settings, owner):
    settings.ETEBASE_MAX_REQUEST_BYTES = 2 * MIB
    url = f"{COLLECTION_PREFIX}/{owner.collection.uid}/item/transaction/"

    admitted_uid = _uid("item-txn-admitted")
    admitted = client.post(
        url,
        content=msgpack_encode(
            _batch_body(admitted_uid, _uid("rev-txn-admitted"), [(_uid("chunk-txn-admitted"), b"\x21" * (1536 * KIB))])
        ),
        headers=_headers(owner.token),
    )
    assert admitted.status_code == 200, admitted.content[:200]
    assert owner.collection.items.filter(uid=admitted_uid).exists()

    refused_uid = _uid("item-txn-refused")
    refused_chunk = _uid("chunk-txn-refused")
    refused = client.post(
        url,
        content=msgpack_encode(
            _batch_body(refused_uid, _uid("rev-txn-refused"), [(refused_chunk, b"\x22" * (2560 * KIB))])
        ),
        headers=_headers(owner.token),
    )
    assert refused.status_code == 413, refused.content[:200]
    assert decode_response(refused)["code"] == "request_too_large"
    assert not owner.collection.items.filter(uid=refused_uid).exists()
    assert not models.CollectionItemChunk.objects.filter(uid=refused_chunk).exists()


def test_streamed_raw_upload_overflow_after_valid_auth_never_stored(prod_app, settings, owner):
    """Raw uploads read their body inside the endpoint, after dependencies.

    This deliberately does not assert pre-authentication rejection: with a
    valid token and no declared length, overflow is detected while the
    endpoint reads the body, and nothing may reach `chunk_save`.
    """
    settings.ETEBASE_MAX_REQUEST_BYTES = SELECTED_DEFAULT
    collection_uid = owner.collection.uid
    chunk_uid = _uid("chunk-stream-over")
    chunks = _split(b"\x33" * (1536 * KIB), 256 * KIB)
    expected_deliveries = _overflow_delivery(chunks, SELECTED_DEFAULT)

    with patch.object(collection_module, "chunk_save", wraps=collection_module.chunk_save) as save_spy:
        result = _asgi(
            prod_app,
            "PUT",
            f"{COLLECTION_PREFIX}/{collection_uid}/item/{collection_uid}/chunk/{chunk_uid}/",
            [
                ("content-type", "application/octet-stream"),
                ("accept", "application/msgpack"),
                ("authorization", f"Token {owner.token}"),
            ],
            chunks,
        )

    assert result.exception is None, result.exception
    assert result.status == 413, (result.status, result.body[:200])
    assert result.deliveries == expected_deliveries
    assert save_spy.call_count == 0, "an oversize upload must never reach storage"
    assert not models.CollectionItemChunk.objects.filter(uid=chunk_uid).exists()
    assert _code(result.body) == "request_too_large"


@pytest.mark.parametrize(
    "app_kind",
    [pytest.param("production", id="production-app"), pytest.param("minimal", id="minimal-app")],
)
def test_billing_oversize_is_json_413(prod_app, app_kind):
    if app_kind == "production":
        app = prod_app
    else:
        app = FastAPI()
        app.include_router(billing_link_router, prefix="/api/v1/billing")
    billing_client = TestClient(app, raise_server_exceptions=False)

    response = billing_client.post(
        BILLING_CONSUME,
        json={"etebaseLinkProof": "p" * 70000},
        headers={"X-Etebase-Billing-Key": "unused-test-key"},
    )

    assert response.status_code == 413, response.content[:200]
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"detail": "Request body too large"}


# ---------------------------------------------------------------------------
# Config-safety RED and existence RED: settings parsing in a fresh interpreter
# ---------------------------------------------------------------------------


def _settings_probe(extra_env: dict[str, str], code: str) -> subprocess.CompletedProcess:
    env = {name: value for name, value in os.environ.items() if name not in (AUTH_SETTING, DEFAULT_SETTING)}
    env.update(extra_env)
    return subprocess.run(
        [sys.executable, "-c", code],
        cwd=SERVER_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


_INVALID_VALUES = (
    ("empty", "", ""),
    ("non-digit", "abc", "abc"),
    ("zero", "0", "0"),
    ("negative", "-1", "-1"),
    ("exponent", "1e6", "1e6"),
    ("fullwidth-digits", "６５５３６", "１０４８５７６"),
    ("below-floor", "65535", "1048575"),
    ("above-ceiling", "1073741825", "1073741825"),
)
_INVALID_SETTING_CASES = [
    pytest.param(setting, auth_value if setting == AUTH_SETTING else default_value, id=f"{short}-{case}")
    for setting, short in ((AUTH_SETTING, "auth"), (DEFAULT_SETTING, "default"))
    for case, auth_value, default_value in _INVALID_VALUES
]


@pytest.mark.parametrize(("setting", "value"), _INVALID_SETTING_CASES)
def test_invalid_limit_settings_fail_closed(setting, value):
    """Importing settings with an invalid value must raise ImproperlyConfigured
    naming the variable. The probe touches no new attribute, so a missing
    attribute cannot satisfy this test."""
    result = _settings_probe({setting: value}, "import etebase_server.settings")

    assert result.returncode != 0, "an invalid limit must stop startup, not fall back to unbounded"
    assert "ImproperlyConfigured" in result.stderr, result.stderr[-2000:]
    assert setting in result.stderr, result.stderr[-2000:]


_PRINT_LIMITS = (
    "import etebase_server.settings as s; "
    "print(s.ETEBASE_MAX_AUTH_REQUEST_BYTES, s.ETEBASE_MAX_REQUEST_BYTES)"
)


def test_default_limits_are_documented_values():
    result = _settings_probe({}, _PRINT_LIMITS)

    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == ["65536", "67108864"]


@pytest.mark.parametrize(
    ("auth_value", "default_value"),
    [
        pytest.param("262144", "2097152", id="raised"),
        pytest.param("65536", "1048576", id="floors"),
        pytest.param("1073741824", "1073741824", id="ceilings"),
    ],
)
def test_valid_overrides_are_applied(auth_value, default_value):
    result = _settings_probe({AUTH_SETTING: auth_value, DEFAULT_SETTING: default_value}, _PRINT_LIMITS)

    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == [auth_value, default_value]


# ---------------------------------------------------------------------------
# Healthy controls: must pass before and after the implementation
# ---------------------------------------------------------------------------


def test_auth_body_exactly_at_default_limit_not_413(client):
    response = client.post(LOGIN_CHALLENGE, content=_username_body(AUTH_LIMIT), headers=_headers())

    assert response.status_code == 401, response.content[:200]
    assert decode_response(response)["code"] == "user_not_found"


def test_sdk_shaped_signup_succeeds(client, login_pubkey, encryption_pubkey):
    """Shapes from etebase 0.43.1: 32-byte salt and keys, 104-byte encryptedContent,
    a 150-character username and the patched registration header."""
    username = "sdk_" + "a" * 146
    body = {
        "user": {"username": username, "email": "sdk-shaped@example.com"},
        "salt": os.urandom(32),
        "loginPubkey": login_pubkey,
        "pubkey": encryption_pubkey,
        "encryptedContent": os.urandom(104),
    }

    response = msgpack_post(
        client, f"{AUTH_PREFIX}/signup/", body, headers={"X-SilentSuite-Registration-Token": "unused"}
    )

    assert response.status_code in (200, 201), response.content[:200]
    assert isinstance(decode_response(response)["token"], str)


def test_sdk_shaped_login_and_change_password_succeed(client, user_factory, signing_key):
    from etebase_server.django.models import UserInfo

    username = "limits_sdk_account"
    user = user_factory(username=username, email="limits-sdk@example.com")
    UserInfo.objects.filter(owner=user).update(encryptedContent=b"\x44" * 104)

    login = perform_login(client, username=username, signing_key=signing_key)
    assert login.status_code == 200, login.content[:200]
    token = decode_response(login)["token"]

    _, challenge = login_challenge(client, username)
    body = build_signed_response(
        username=username,
        challenge_bytes=challenge["challenge"],
        signing_key=signing_key,
        action="changePassword",
        extra={"loginPubkey": bytes(signing_key.verify_key), "encryptedContent": b"\x45" * 104},
    )
    response = msgpack_post(
        client, f"{AUTH_PREFIX}/change_password/", body, headers={"Authorization": f"Token {token}"}
    )

    assert response.status_code == 204, response.content[:200]


def test_default_batch_with_inline_chunk_content_multi_mib_succeeds(client, owner):
    item_uid = _uid("item-inline-3mib")
    body = msgpack_encode(_batch_body(item_uid, _uid("rev-inline-3mib"), [(_uid("chunk-inline-3mib"), b"\x55" * (3 * MIB))]))

    response = client.post(
        f"{COLLECTION_PREFIX}/{owner.collection.uid}/item/batch/", content=body, headers=_headers(owner.token)
    )

    assert response.status_code == 200, response.content[:200]
    assert owner.collection.items.filter(uid=item_uid).exists()


def test_sdk_data_chunk_upload_131112_bytes_succeeds(client, owner):
    collection_uid = owner.collection.uid
    chunk_uid = _uid("chunk-sdk-max-data")
    content = os.urandom(131112)

    response = client.put(
        f"{COLLECTION_PREFIX}/{collection_uid}/item/{collection_uid}/chunk/{chunk_uid}/",
        content=content,
        headers=_headers(owner.token, content_type="application/octet-stream"),
    )

    assert response.status_code == 201, response.content[:200]
    assert _stored_chunk_bytes(owner.collection, chunk_uid) == content


def test_fragmented_raw_upload_bytes_preserved(prod_app, owner):
    collection_uid = owner.collection.uid
    chunk_uid = _uid("chunk-fragmented")
    content = os.urandom(7 * 16 * KIB + 123)

    result = _asgi(
        prod_app,
        "PUT",
        f"{COLLECTION_PREFIX}/{collection_uid}/item/{collection_uid}/chunk/{chunk_uid}/",
        [
            ("content-type", "application/octet-stream"),
            ("accept", "application/msgpack"),
            ("authorization", f"Token {owner.token}"),
        ],
        _split(content, 16 * KIB),
    )

    assert result.exception is None, result.exception
    assert result.status == 201, (result.status, result.body[:200])
    assert _stored_chunk_bytes(owner.collection, chunk_uid) == content


def test_malformed_outer_msgpack_still_400(client):
    response = client.post(LOGIN_CHALLENGE, content=b"\xc1", headers=_headers())

    assert response.status_code == 400, response.content[:200]
    assert response.json() == {"detail": PARSE_ERROR_DETAIL}


def test_non_string_map_key_still_rejected(client):
    response = client.post(LOGIN_CHALLENGE, content=msgpack_encode({42: b"x"}), headers=_headers())

    assert response.status_code == 400, response.content[:200]
    assert response.json() == {"detail": PARSE_ERROR_DETAIL}


def test_accept_negotiation_unchanged(client):
    msgpack_response = client.get(f"{AUTH_PREFIX}/is_etebase/", headers={"Accept": "application/msgpack"})
    assert msgpack_response.status_code == 200
    assert msgpack_response.headers["content-type"].startswith("application/msgpack")

    default_response = client.get(f"{AUTH_PREFIX}/is_etebase/")
    assert default_response.status_code == 200
    assert default_response.headers["content-type"].startswith("application/json")

    # Custom errors render as msgpack whatever the Accept header says.
    error = client.post(LOGIN_CHALLENGE, content=msgpack_encode({"username": "nobody-limits"}),
                        headers={"Content-Type": "application/msgpack"})
    assert error.status_code == 401
    assert error.headers["content-type"].startswith("application/msgpack")
    assert decode_response(error)["code"] == "user_not_found"


@pytest.mark.parametrize(
    "route",
    [pytest.param("login", id="login"), pytest.param("change_password", id="change-password")],
)
def test_nested_malformed_response_characterized(client, user_factory, route):
    """Characterization only, not a contract: an undecodable nested `response`
    is decoded inside the endpoint and is not mapped by any handler today.
    The asserted status is source-predicted and must be confirmed by the first
    hosted baseline run; this change does not alter it."""
    username = "limits_nested_user"
    user = user_factory(username=username, email="limits-nested@example.com")
    headers = {}
    if route == "change_password":
        headers["Authorization"] = f"Token {AuthToken.objects.create(user=user).key}"

    response = msgpack_post(
        client, f"{AUTH_PREFIX}/{route}/", {"response": b"\xc1", "signature": b"\x00" * 64}, headers=headers
    )

    assert response.status_code == 500
