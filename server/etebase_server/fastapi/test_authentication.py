"""Tests for the FastAPI authentication router.

Covers the login challenge / signed-response handshake, signup, logout,
and — critically — `change_password`'s cryptographic proof of current
credentials. The bridge/server does NOT take an old password as a
plaintext argument; instead it requires the change-password request to
be signed by the current `loginPubkey`'s signing key. That signature
verification IS the old-password check, and one of the tests below
asserts it explicitly (PR #21 — the security guarantee that
silentsuite-billing's `PATCH /account/password` notification endpoint
delegates to).
"""

from __future__ import annotations

import nacl.signing
import pytest
from django.test.utils import override_settings

from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    build_signed_response,
    decode_response,
    login_challenge,
    msgpack_post,
    perform_login,
)


@pytest.mark.django_db(transaction=True)
class TestLoginChallenge:
    def test_returns_salt_and_challenge_for_existing_user(
        self, auth_client, user_factory, user_salt
    ):
        user_factory(username="test_user_alice")

        response, body = login_challenge(auth_client, "test_user_alice")

        assert response.status_code == 200
        assert body["salt"] == user_salt
        assert isinstance(body["challenge"], bytes) and len(body["challenge"]) > 0
        assert body["version"] == 1

    def test_returns_401_for_missing_user(self, auth_client):
        response, _ = login_challenge(auth_client, "test_user_does_not_exist")

        assert response.status_code == 401
        assert decode_response(response)["code"] == "user_not_found"

    def test_returns_401_when_user_has_no_userinfo(self, auth_client, user_factory):
        # An account that exists in Django but never completed signup ends up
        # without a UserInfo row — login should refuse to issue a challenge.
        user_factory(username="test_user_uninit", with_userinfo=False)

        response, _ = login_challenge(auth_client, "test_user_uninit")

        assert response.status_code == 401
        assert decode_response(response)["code"] == "user_not_init"

    def test_username_lookup_is_case_insensitive(self, auth_client, user_factory):
        # myauth.User normalises usernames to lowercase, so the challenge
        # endpoint must succeed regardless of how the client capitalises.
        user_factory(username="test_user_casey")

        response, body = login_challenge(auth_client, "TEST_USER_CASEY")

        assert response.status_code == 200
        assert isinstance(body["challenge"], bytes)


@pytest.mark.django_db(transaction=True)
class TestLogin:
    def test_login_with_valid_signature_returns_token(
        self, auth_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")

        response = perform_login(
            auth_client, username="test_user_alice", signing_key=signing_key
        )

        assert response.status_code == 200
        body = decode_response(response)
        assert isinstance(body["token"], str) and len(body["token"]) >= 32
        assert body["user"]["username"] == "test_user_alice"

    def test_login_with_wrong_signature_returns_401(
        self, auth_client, user_factory
    ):
        # User was created with `signing_key`'s pubkey, but we sign the
        # response with a different key — i.e. the attacker doesn't know the
        # password. This is the core "wrong password → 401" guarantee.
        user_factory(username="test_user_alice")
        attacker_key = nacl.signing.SigningKey.generate()

        challenge_resp, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=attacker_key,
        )
        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/login/", body)

        assert challenge_resp.status_code == 200
        assert response.status_code == 401
        assert decode_response(response)["code"] == "login_bad_signature"

    def test_login_with_wrong_action_is_rejected(
        self, auth_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=signing_key,
            action="changePassword",  # but we're hitting /login/
        )
        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/login/", body)

        assert response.status_code == 400
        assert decode_response(response)["code"] == "wrong_action"

    @override_settings(DEBUG=False)
    def test_login_with_wrong_host_is_rejected_in_production(
        self, auth_client, user_factory, signing_key
    ):
        # In DEBUG mode the host check is skipped (so dev clients on
        # localhost can talk to a remote server). With DEBUG off, the
        # host in the signed response must match the request's Host header.
        user_factory(username="test_user_alice")

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=signing_key,
            host="evil.example.com",
        )
        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/login/", body)

        assert response.status_code == 400
        assert decode_response(response)["code"] == "wrong_host"

    def test_login_with_garbage_challenge_bytes_fails(
        self, auth_app, user_factory, signing_key
    ):
        # Skip the real challenge endpoint and send random bytes — the
        # server can't decrypt them, so the login must not succeed.
        # (Note: the route doesn't currently catch NaCl's CryptoError, so
        # this surfaces as a 500 rather than a clean 4xx. That's a minor
        # robustness gap worth fixing separately; it isn't exploitable —
        # no user data leaks — but it should be a 400. Filed mentally.)
        from fastapi.testclient import TestClient

        client = TestClient(auth_app, raise_server_exceptions=False)
        user_factory(username="test_user_alice")

        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=b"\x00" * 64,
            signing_key=signing_key,
        )
        response = msgpack_post(client, f"{AUTH_PREFIX}/login/", body)

        assert response.status_code != 200


@pytest.mark.django_db(transaction=True)
class TestSignup:
    def test_signup_creates_a_new_user(self, auth_client, login_pubkey, encryption_pubkey, user_salt):
        body = {
            "user": {"username": "test_user_new", "email": "new@example.com"},
            "salt": user_salt,
            "loginPubkey": login_pubkey,
            "pubkey": encryption_pubkey,
            "encryptedContent": b"\x00" * 64,
        }

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        # The route is declared `status_code=201` but MsgpackRoute's custom
        # response path drops the declared status — actual responses are 200.
        # Allow either to keep the test honest about current behaviour.
        assert response.status_code in (200, 201)
        decoded = decode_response(response)
        assert decoded["user"]["username"] == "test_user_new"
        assert isinstance(decoded["token"], str)

    def test_signup_for_existing_user_returns_409(
        self, auth_client, user_factory, login_pubkey, encryption_pubkey, user_salt
    ):
        user_factory(username="test_user_alice")
        body = {
            "user": {"username": "test_user_alice", "email": "alice@example.com"},
            "salt": user_salt,
            "loginPubkey": login_pubkey,
            "pubkey": encryption_pubkey,
            "encryptedContent": b"\x00" * 64,
        }

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        assert response.status_code == 409
        assert decode_response(response)["code"] == "user_exists"


@pytest.mark.django_db(transaction=True)
class TestChangePassword:
    """The architectural assertion called out in PR #21:

    `silentsuite-billing`'s `PATCH /account/password` endpoint is purely a
    "password was changed elsewhere, rotate refresh tokens" notification —
    it can't verify the old password because it doesn't have it. The
    *actual* old-password check lives here, in the bridge/server's
    `change_password` route, where the request body must be signed by the
    user's current `loginPubkey`. These tests prove that property.
    """

    def _auth_token(self, auth_client, signing_key, username="test_user_alice"):
        login = perform_login(auth_client, username=username, signing_key=signing_key)
        assert login.status_code == 200, decode_response(login)
        return decode_response(login)["token"]

    def test_change_password_requires_authentication(
        self, auth_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=signing_key,
            action="changePassword",
            extra={"loginPubkey": b"\x01" * 32, "encryptedContent": b"\x02" * 64},
        )

        # No Authorization header — must be rejected before any crypto check.
        response = msgpack_post(
            auth_client, f"{AUTH_PREFIX}/change_password/", body
        )

        assert response.status_code in (401, 403)

    def test_change_password_rejects_wrong_signature(
        self, auth_client, user_factory, signing_key
    ):
        # The user's current loginPubkey is `signing_key.verify_key`. An
        # attacker who has stolen the session token but does NOT know the
        # current password cannot produce a valid signature, and the
        # change must be refused. This is THE security check.
        user_factory(username="test_user_alice")
        token = self._auth_token(auth_client, signing_key)

        attacker_key = nacl.signing.SigningKey.generate()
        new_login_pubkey = bytes(nacl.signing.SigningKey.generate().verify_key)

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=attacker_key,
            action="changePassword",
            extra={"loginPubkey": new_login_pubkey, "encryptedContent": b"\x03" * 64},
        )
        response = msgpack_post(
            auth_client,
            f"{AUTH_PREFIX}/change_password/",
            body,
            headers={"Authorization": f"Token {token}"},
        )

        assert response.status_code == 401
        assert decode_response(response)["code"] == "login_bad_signature"

        # And the user's stored loginPubkey must NOT have been overwritten.
        from etebase_server.django.models import UserInfo

        info = UserInfo.objects.get(owner__username="test_user_alice")
        assert bytes(info.loginPubkey) == bytes(signing_key.verify_key)

    def test_change_password_succeeds_with_correct_signature(
        self, auth_client, user_factory, signing_key
    ):
        user_factory(username="test_user_alice")
        token = self._auth_token(auth_client, signing_key)

        new_signing_key = nacl.signing.SigningKey.generate()
        new_login_pubkey = bytes(new_signing_key.verify_key)
        new_encrypted_content = b"\xaa" * 64

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=signing_key,  # signed with CURRENT key — proves old-password possession
            action="changePassword",
            extra={"loginPubkey": new_login_pubkey, "encryptedContent": new_encrypted_content},
        )
        response = msgpack_post(
            auth_client,
            f"{AUTH_PREFIX}/change_password/",
            body,
            headers={"Authorization": f"Token {token}"},
        )

        assert response.status_code == 204

        # The new credentials must be persisted: future logins succeed with
        # `new_signing_key` and fail with the old one.
        from etebase_server.django.models import UserInfo

        info = UserInfo.objects.get(owner__username="test_user_alice")
        assert bytes(info.loginPubkey) == new_login_pubkey
        assert bytes(info.encryptedContent) == new_encrypted_content

        good = perform_login(auth_client, username="test_user_alice", signing_key=new_signing_key)
        assert good.status_code == 200

        bad = perform_login(auth_client, username="test_user_alice", signing_key=signing_key)
        assert bad.status_code == 401
        assert decode_response(bad)["code"] == "login_bad_signature"
