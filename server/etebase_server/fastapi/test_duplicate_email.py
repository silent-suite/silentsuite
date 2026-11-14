"""Email lookups stay unambiguous.

SilentSuite clients sign up with username = email and log in with that email.
A login or invitation name containing '@' is looked up by username or email,
and email is not unique in the database. These tests cover both layers:
signup refuses a second account that would make that lookup ambiguous, and the
lookup itself prefers an exact username match and never turns duplicate email
rows into a server error.
"""

from __future__ import annotations

import os

import nacl.public
import nacl.signing
import pytest
from fastapi.testclient import TestClient

from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    decode_response,
    login_challenge,
    msgpack_post,
    perform_login,
)
from etebase_server.fastapi.exceptions import HttpError
from etebase_server.fastapi.routers.invitation import get_user_or_404
from etebase_server.myauth.models import get_typed_user_model

User = get_typed_user_model()

ALICE_EMAIL = "alice@example.com"


@pytest.fixture
def client(auth_app, transactional_db) -> TestClient:
    # Return 500s instead of re-raising, like a real ASGI server would.
    return TestClient(auth_app, raise_server_exceptions=False)


def _signup(client: TestClient, username: str, email: str, key: nacl.signing.SigningKey):
    body = {
        "user": {"username": username, "email": email},
        "salt": os.urandom(32),
        "loginPubkey": bytes(key.verify_key),
        "pubkey": bytes(nacl.public.PrivateKey.generate().public_key),
        "encryptedContent": b"\x00" * 64,
    }
    return msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)


class _Request:
    path_params: dict = {}


# --- signup -----------------------------------------------------------------


def test_signup_with_another_users_email_is_refused_and_login_keeps_working(client):
    alice_key = nacl.signing.SigningKey.generate()
    assert _signup(client, ALICE_EMAIL, ALICE_EMAIL, alice_key).status_code in (200, 201)

    other = _signup(client, "someone_else", ALICE_EMAIL.upper(), nacl.signing.SigningKey.generate())

    assert other.status_code == 409
    assert decode_response(other)["code"] == "user_exists"
    assert User.objects.filter(email__iexact=ALICE_EMAIL).count() == 1
    assert perform_login(client, username=ALICE_EMAIL, signing_key=alice_key).status_code == 200


def test_signup_with_username_equal_to_another_users_email_is_refused(client):
    assert _signup(client, "alice", ALICE_EMAIL, nacl.signing.SigningKey.generate()).status_code in (200, 201)

    other = _signup(client, "Alice@Example.com", "other@example.com", nacl.signing.SigningKey.generate())

    assert other.status_code == 409
    assert decode_response(other)["code"] == "user_exists"


def test_signup_with_lookalike_username_of_another_users_email_is_refused(client):
    # The username is stored NFKC-normalized, so a fullwidth '@' (U+FF20) would
    # be saved as alice@example.com and win the username-first email lookup.
    alice_key = nacl.signing.SigningKey.generate()
    assert _signup(client, "alice", ALICE_EMAIL, alice_key).status_code in (200, 201)

    other = _signup(client, "alice＠example.com", "other@example.com", nacl.signing.SigningKey.generate())

    assert other.status_code == 409
    assert decode_response(other)["code"] == "user_exists"
    assert not User.objects.filter(username=ALICE_EMAIL).exists()
    assert perform_login(client, username=ALICE_EMAIL, signing_key=alice_key).status_code == 200
    assert get_user_or_404(_Request(), ALICE_EMAIL).username == "alice"


def test_signup_with_email_equal_to_another_users_username_is_refused(client):
    assert _signup(client, ALICE_EMAIL, "contact@example.com", nacl.signing.SigningKey.generate()).status_code in (
        200,
        201,
    )

    other = _signup(client, "someone_else", ALICE_EMAIL.upper(), nacl.signing.SigningKey.generate())

    assert other.status_code == 409
    assert decode_response(other)["code"] == "user_exists"


def test_signup_with_distinct_email_still_works(client):
    alice_key = nacl.signing.SigningKey.generate()
    assert _signup(client, ALICE_EMAIL, ALICE_EMAIL, alice_key).status_code in (200, 201)
    assert _signup(client, "bob@example.com", "bob@example.com", nacl.signing.SigningKey.generate()).status_code in (
        200,
        201,
    )
    assert perform_login(client, username=ALICE_EMAIL, signing_key=alice_key).status_code == 200


# --- lookup with duplicate rows that already exist --------------------------


def test_login_prefers_exact_username_over_duplicate_email(client, user_factory, signing_key):
    # Rows created directly, as an older server could have stored them.
    user_factory(username=ALICE_EMAIL, email=ALICE_EMAIL)
    user_factory(username="someone_else", email=ALICE_EMAIL.upper(), login_pubkey_override=os.urandom(32))

    assert perform_login(client, username=ALICE_EMAIL, signing_key=signing_key).status_code == 200


def test_login_with_email_matching_several_users_fails_cleanly(client, user_factory):
    user_factory(username="first", email=ALICE_EMAIL)
    user_factory(username="second", email=ALICE_EMAIL.upper())

    response, _ = login_challenge(client, ALICE_EMAIL)

    assert response.status_code == 401
    assert decode_response(response)["code"] == "user_not_found"


def test_login_by_unique_email_still_works(client, user_factory, signing_key):
    user_factory(username="alice", email=ALICE_EMAIL)

    assert perform_login(client, username=ALICE_EMAIL.upper(), signing_key=signing_key).status_code == 200


def test_invitation_lookup_prefers_username_and_rejects_ambiguous_email(user_factory):
    owner = user_factory(username=ALICE_EMAIL, email=ALICE_EMAIL)
    user_factory(username="someone_else", email=ALICE_EMAIL)
    assert get_user_or_404(_Request(), ALICE_EMAIL.upper()) == owner

    user_factory(username="first", email="shared@example.com")
    user_factory(username="second", email="SHARED@example.com")
    with pytest.raises(HttpError) as exc:
        get_user_or_404(_Request(), "shared@example.com")
    assert exc.value.status_code == 404
    assert exc.value.code == "does_not_exist"
