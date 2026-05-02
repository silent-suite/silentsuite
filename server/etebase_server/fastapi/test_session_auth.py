"""Tests for session/token authentication on the FastAPI side.

Drives `get_authenticated_user` and `get_auth_data` (the dependencies that
gate every authenticated endpoint) by attaching a small protected route
to a test app and asserting how missing / invalid / revoked / expired
tokens are handled.
"""

from __future__ import annotations

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    decode_response,
    msgpack_post,
    perform_login,
)
from etebase_server.fastapi.dependencies import get_auth_data, get_authenticated_user
from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse


@pytest.fixture
def session_app():
    """A FastAPI app with both the auth router (so we can log in / log out)
    and a small protected probe endpoint that exercises `get_authenticated_user`."""
    from etebase_server.fastapi.routers.authentication import authentication_router

    app = FastAPI()
    app.include_router(authentication_router, prefix=AUTH_PREFIX)

    @app.get("/whoami")
    def whoami(user=Depends(get_authenticated_user)):
        return {"username": user.username}

    @app.get("/whoami_with_token")
    def whoami_with_token(auth=Depends(get_auth_data)):
        return {"username": auth.user.username, "token_key": auth.token.key}

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):  # noqa: RUF029
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return app


@pytest.fixture
def session_client(session_app: FastAPI) -> TestClient:
    return TestClient(session_app)


def _login_and_get_token(client, signing_key, username="test_user_alice"):
    response = perform_login(client, username=username, signing_key=signing_key)
    assert response.status_code == 200, decode_response(response)
    return decode_response(response)["token"]


@pytest.mark.django_db(transaction=True)
class TestTokenAuth:
    def test_request_with_valid_token_succeeds(
        self, session_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")
        token = _login_and_get_token(session_client, signing_key)

        response = session_client.get(
            "/whoami", headers={"Authorization": f"Token {token}"}
        )

        assert response.status_code == 200
        assert response.json() == {"username": "test_user_alice"}

    def test_request_without_authorization_header_is_rejected(self, session_client):
        response = session_client.get("/whoami")

        # FastAPI's APIKeyHeader returns 403 when the header is missing.
        assert response.status_code in (401, 403)

    def test_request_with_invalid_token_is_rejected(self, session_client):
        response = session_client.get(
            "/whoami", headers={"Authorization": "Token not-a-real-token"}
        )

        assert response.status_code == 401
        assert decode_response(response)["detail"] == "Invalid token."

    def test_logout_invalidates_the_token(
        self, session_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")
        token = _login_and_get_token(session_client, signing_key)
        auth_header = {"Authorization": f"Token {token}"}

        # First call works — token is valid.
        before = session_client.get("/whoami", headers=auth_header)
        assert before.status_code == 200

        logout = msgpack_post(
            session_client, f"{AUTH_PREFIX}/logout/", None, headers=auth_header
        )
        assert logout.status_code == 204

        # Same token, post-logout — must be rejected.
        after = session_client.get("/whoami", headers=auth_header)
        assert after.status_code == 401
        assert decode_response(after)["detail"] == "Invalid token."

    def test_each_login_issues_a_unique_token(
        self, session_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")

        first = _login_and_get_token(session_client, signing_key)
        second = _login_and_get_token(session_client, signing_key)

        # Distinct logins must mint distinct tokens — a shared key would
        # mean revoking one session revokes the other.
        assert first != second

        # And both tokens are independently valid.
        for tok in (first, second):
            response = session_client.get(
                "/whoami", headers={"Authorization": f"Token {tok}"}
            )
            assert response.status_code == 200

    def test_expired_token_is_rejected_and_deleted(
        self, session_client, user_factory, signing_key
    ):
        from django.utils import timezone

        from etebase_server.django.token_auth.models import AuthToken

        user_factory(username="test_user_alice")
        token = _login_and_get_token(session_client, signing_key)

        # Force the token to be expired in the DB.
        AuthToken.objects.filter(key=token).update(
            expiry=timezone.now() - timezone.timedelta(seconds=10)
        )

        response = session_client.get(
            "/whoami", headers={"Authorization": f"Token {token}"}
        )

        assert response.status_code == 401
        assert decode_response(response)["detail"] == "Invalid token."
        # And the expired record must be cleaned up so it can't linger in the DB.
        assert not AuthToken.objects.filter(key=token).exists()

    def test_inactive_user_cannot_use_existing_token(
        self, session_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")
        token = _login_and_get_token(session_client, signing_key)

        # Disable the account after the token was issued — outstanding
        # tokens for inactive users must stop working.
        from etebase_server.myauth.models import get_typed_user_model

        User = get_typed_user_model()
        u = User.objects.get(username="test_user_alice")
        u.is_active = False
        u.save(update_fields=["is_active"])

        response = session_client.get(
            "/whoami", headers={"Authorization": f"Token {token}"}
        )

        assert response.status_code == 401
        assert decode_response(response)["detail"] == "User inactive or deleted."


@pytest.mark.django_db(transaction=True)
class TestSessionLifecycle:
    def test_full_signup_login_logout_round_trip(
        self, session_client, signing_key, login_pubkey, encryption_pubkey, user_salt
    ):
        # Signup mints a fresh token in the response — confirm we can use it
        # immediately, then log out, then log back in with the same key, and
        # that *that* token also works.
        signup = msgpack_post(
            session_client,
            f"{AUTH_PREFIX}/signup/",
            {
                "user": {"username": "test_user_signup", "email": "signup@example.com"},
                "salt": user_salt,
                "loginPubkey": login_pubkey,
                "pubkey": encryption_pubkey,
                "encryptedContent": b"\x00" * 64,
            },
        )
        # See the matching note in test_authentication.py — declared 201,
        # actual 200 due to MsgpackRoute's response handling.
        assert signup.status_code in (200, 201)
        token1 = decode_response(signup)["token"]

        whoami1 = session_client.get(
            "/whoami_with_token", headers={"Authorization": f"Token {token1}"}
        )
        assert whoami1.status_code == 200
        assert whoami1.json()["username"] == "test_user_signup"

        logout = msgpack_post(
            session_client,
            f"{AUTH_PREFIX}/logout/",
            None,
            headers={"Authorization": f"Token {token1}"},
        )
        assert logout.status_code == 204

        token2 = _login_and_get_token(session_client, signing_key, username="test_user_signup")
        assert token2 != token1

        whoami2 = session_client.get(
            "/whoami_with_token", headers={"Authorization": f"Token {token2}"}
        )
        assert whoami2.status_code == 200
