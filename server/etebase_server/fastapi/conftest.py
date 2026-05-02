"""Shared fixtures for FastAPI auth tests.

Provides:
  - A minimal FastAPI app + TestClient that exposes only the routers under
    test (no static files, no Redis, no CORS — just what we need to drive
    the request lifecycle through the real exception handler).
  - Crypto helpers that mimic an Etebase client: signing key, login pubkey,
    salt, and a `login_flow` helper that performs the full
    challenge → sign → submit handshake the way a real client does.
"""

from __future__ import annotations

import os
from typing import Any

import nacl.public
import nacl.signing
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.utils import msgpack_decode, msgpack_encode

AUTH_PREFIX = "/api/v1/authentication"


# ---------------------------------------------------------------------------
# App / client
# ---------------------------------------------------------------------------


@pytest.fixture
def auth_app() -> FastAPI:
    """A minimal FastAPI app that mounts the authentication router and the
    same `CustomHttpException` handler that production registers — so error
    bodies are msgpack-encoded `{code, detail}` exactly like the real server."""
    from etebase_server.fastapi.routers.authentication import authentication_router

    app = FastAPI()
    app.include_router(authentication_router, prefix=AUTH_PREFIX)

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return app


@pytest.fixture
def auth_client(auth_app: FastAPI) -> TestClient:
    return TestClient(auth_app)


# ---------------------------------------------------------------------------
# Msgpack request/response helpers
# ---------------------------------------------------------------------------


def msgpack_post(client: TestClient, url: str, body: Any, **kwargs: Any):
    """POST a msgpack-encoded body and ask for a msgpack response."""
    headers = {
        "Content-Type": "application/msgpack",
        "Accept": "application/msgpack",
    }
    headers.update(kwargs.pop("headers", {}))
    return client.post(url, content=msgpack_encode(body), headers=headers, **kwargs)


def decode_response(response) -> Any:
    """Decode a msgpack response body."""
    return msgpack_decode(response.content)


# ---------------------------------------------------------------------------
# Crypto/identity fixtures — mimic what an Etebase client derives from the
# user's password.
# ---------------------------------------------------------------------------


@pytest.fixture
def signing_key() -> nacl.signing.SigningKey:
    """The "password-derived" signing key. In real clients this is derived
    from the user's password via a KDF; in tests we just generate one."""
    return nacl.signing.SigningKey.generate()


@pytest.fixture
def login_pubkey(signing_key: nacl.signing.SigningKey) -> bytes:
    """The verify-key bytes that get stored in `UserInfo.loginPubkey`."""
    return bytes(signing_key.verify_key)


@pytest.fixture
def encryption_pubkey() -> bytes:
    """A separate per-account encryption pubkey stored in `UserInfo.pubkey`.
    The auth flow doesn't use it — it's only needed to satisfy the NOT NULL
    constraint when we create UserInfo rows."""
    return bytes(nacl.public.PrivateKey.generate().public_key)


@pytest.fixture
def user_salt() -> bytes:
    """A fresh random salt for the test user."""
    return os.urandom(32)


# ---------------------------------------------------------------------------
# User factory
# ---------------------------------------------------------------------------


@pytest.fixture
def user_factory(transactional_db, user_salt, login_pubkey, encryption_pubkey):
    """Factory for creating Django User + UserInfo rows.

    Uses `transactional_db` rather than `db` because the route handlers go
    through `django_db_cleanup_decorator`, which calls `close_old_connections()`
    and breaks the per-test transaction wrapper that `db` relies on.
    """
    from etebase_server.django.models import UserInfo
    from etebase_server.myauth.models import get_typed_user_model

    User = get_typed_user_model()

    def _make(
        username: str = "test_user_alice",
        email: str = "alice@example.com",
        salt: bytes | None = None,
        login_pubkey_override: bytes | None = None,
        with_userinfo: bool = True,
    ):
        user = User.objects.create_user(username=username, email=email, password=None)
        if with_userinfo:
            UserInfo.objects.create(
                owner=user,
                salt=salt if salt is not None else user_salt,
                loginPubkey=login_pubkey_override if login_pubkey_override is not None else login_pubkey,
                pubkey=encryption_pubkey,
                encryptedContent=b"\x00" * 64,
            )
        return user

    return _make


# ---------------------------------------------------------------------------
# Login handshake helper — performs the same dance an Etebase client does
# ---------------------------------------------------------------------------


def login_challenge(client: TestClient, username: str):
    """Hit /login_challenge/ and return the decoded `{salt, challenge, version}`."""
    response = msgpack_post(client, f"{AUTH_PREFIX}/login_challenge/", {"username": username})
    return response, decode_response(response) if response.status_code == 200 else None


def build_signed_response(
    *,
    username: str,
    challenge_bytes: bytes,
    signing_key: nacl.signing.SigningKey,
    action: str = "login",
    host: str = "testserver",
    extra: dict | None = None,
) -> dict:
    """Build the `{response, signature}` body for /login/ or /change_password/.

    The server doesn't require the client to decrypt the challenge — it only
    needs the same encrypted bytes echoed back so it can decrypt them with
    its own key and verify the timestamp/userId. The cryptographic proof of
    password possession is in the *signature* over the msgpack-encoded
    response, verified against the user's stored loginPubkey.
    """
    payload: dict = {
        "username": username,
        "challenge": challenge_bytes,
        "host": host,
        "action": action,
    }
    if extra:
        payload.update(extra)
    encoded = msgpack_encode(payload)
    signature = signing_key.sign(encoded).signature
    return {"response": encoded, "signature": bytes(signature)}


def perform_login(
    client: TestClient,
    *,
    username: str,
    signing_key: nacl.signing.SigningKey,
    host: str = "testserver",
):
    """Full login round-trip: challenge → signed response → token."""
    challenge_resp, challenge_data = login_challenge(client, username)
    assert challenge_resp.status_code == 200, decode_response(challenge_resp)
    body = build_signed_response(
        username=username,
        challenge_bytes=challenge_data["challenge"],
        signing_key=signing_key,
        action="login",
        host=host,
    )
    return msgpack_post(client, f"{AUTH_PREFIX}/login/", body)
