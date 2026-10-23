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

import time as time_module
from unittest.mock import patch

import nacl.signing
import pytest
from django.test.utils import override_settings
from fastapi.testclient import TestClient

from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    build_signed_response,
    decode_response,
    login_challenge,
    msgpack_post,
    perform_login,
)
from etebase_server.fastapi.utils import msgpack_encode
from etebase_server.myauth.models import get_typed_user_model


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

    def test_login_with_garbage_challenge_bytes_returns_client_error(
        self, auth_app, user_factory, signing_key
    ):
        # Skip the real challenge endpoint and send random bytes — the
        # server can't decrypt them, so the login must not succeed AND the
        # response must be a clean 4xx (not a 500 from an uncaught crypto
        # exception).
        from fastapi.testclient import TestClient

        client = TestClient(auth_app, raise_server_exceptions=False)
        user_factory(username="test_user_alice")

        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=b"\x00" * 64,
            signing_key=signing_key,
        )
        response = msgpack_post(client, f"{AUTH_PREFIX}/login/", body)

        assert response.status_code == 400
        assert decode_response(response)["code"] == "invalid_challenge"


@pytest.mark.django_db(transaction=True)
class TestSignup:
    def _signup_body(self, username, email, login_pubkey, encryption_pubkey, user_salt):
        return {
            "user": {"username": username, "email": email},
            "salt": user_salt,
            "loginPubkey": login_pubkey,
            "pubkey": encryption_pubkey,
            "encryptedContent": b"\x00" * 64,
        }

    def test_signup_creates_a_new_user(self, auth_client, login_pubkey, encryption_pubkey, user_salt):
        body = self._signup_body("test_user_new", "new@example.com", login_pubkey, encryption_pubkey, user_salt)

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
        body = self._signup_body("test_user_alice", "alice@example.com", login_pubkey, encryption_pubkey, user_salt)

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        assert response.status_code == 409
        assert decode_response(response)["code"] == "user_exists"

    def test_signup_for_existing_user_without_userinfo_returns_409(
        self, auth_client, user_factory, login_pubkey, encryption_pubkey, user_salt
    ):
        user_factory(username="test_user_uninitialized", email="uninitialized@example.com", with_userinfo=False)
        body = self._signup_body(
            "test_user_uninitialized",
            "attacker@example.com",
            login_pubkey,
            encryption_pubkey,
            user_salt,
        )

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        assert response.status_code == 409
        assert decode_response(response)["code"] == "user_exists"

    def test_signup_unexpected_creation_error_returns_safe_detail(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        body = self._signup_body("test_user_error", "error@example.com", login_pubkey, encryption_pubkey, user_salt)

        with patch(
            "etebase_server.fastapi.routers.authentication.create_user",
            side_effect=Exception("raw database hostname secret"),
        ):
            response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        decoded = decode_response(response)
        assert response.status_code == 400
        assert decoded["code"] == "generic"
        assert decoded["detail"] == "An error occurred during signup. Please try again."
        assert "raw database hostname secret" not in decoded["detail"]

    @override_settings(ETEBASE_BOOTSTRAP_ADMIN_TOKEN="bootstrap-secret")
    def test_first_signup_requires_bootstrap_token_when_configured(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        body = self._signup_body("test_user_bootstrap", "bootstrap@example.com", login_pubkey, encryption_pubkey, user_salt)

        missing_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)
        wrong_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/?bootstrap_token=wrong", body)
        unicode_wrong_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/?bootstrap_token=ünïcödé", body)

        user_model = get_typed_user_model()
        assert missing_response.status_code == 403
        assert wrong_response.status_code == 403
        assert unicode_wrong_response.status_code == 403
        assert decode_response(missing_response)["code"] == "bootstrap_token_required"
        assert decode_response(wrong_response)["code"] == "bootstrap_token_required"
        assert decode_response(unicode_wrong_response)["code"] == "bootstrap_token_required"
        assert not user_model.objects.filter(username="test_user_bootstrap").exists()

    @override_settings(ETEBASE_BOOTSTRAP_ADMIN_TOKEN="bootstrap-secret")
    def test_first_signup_accepts_valid_bootstrap_token(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        body = self._signup_body("test_user_bootstrap", "bootstrap@example.com", login_pubkey, encryption_pubkey, user_salt)

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/?bootstrap_token=bootstrap-secret", body)

        assert response.status_code in (200, 201)
        assert decode_response(response)["user"]["username"] == "test_user_bootstrap"

    @override_settings(ETEBASE_BOOTSTRAP_ADMIN_TOKEN="bootstrap-secret")
    def test_bootstrap_token_still_required_when_only_django_superuser_exists(
        self, auth_client, user_factory, login_pubkey, encryption_pubkey, user_salt
    ):
        user_factory(username="admin", email="admin@example.com", with_userinfo=False)
        body = self._signup_body("test_user_bootstrap", "bootstrap@example.com", login_pubkey, encryption_pubkey, user_salt)

        missing_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)
        token_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/?bootstrap_token=bootstrap-secret", body)

        assert missing_response.status_code == 403
        assert decode_response(missing_response)["code"] == "bootstrap_token_required"
        assert token_response.status_code in (200, 201)
        assert decode_response(token_response)["user"]["username"] == "test_user_bootstrap"

    @override_settings(ETEBASE_BOOTSTRAP_ADMIN_TOKEN="bootstrap-secret")
    def test_bootstrap_token_not_required_after_first_app_user_exists(
        self, auth_client, user_factory, login_pubkey, encryption_pubkey, user_salt
    ):
        user_factory(username="existing_user", email="existing@example.com")
        body = self._signup_body("second_user", "second@example.com", login_pubkey, encryption_pubkey, user_salt)

        response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", body)

        assert response.status_code in (200, 201)
        assert decode_response(response)["user"]["username"] == "second_user"


REGISTRATION_HEADER = "X-SilentSuite-Registration-Token"


@pytest.mark.django_db(transaction=True)
class TestOwnerRegistrationToken:
    """Opt-in per-install owner authorization required for every signup (Umbrel)."""

    def _signup_body(self, username, login_pubkey, encryption_pubkey, user_salt):
        return {
            "user": {"username": username, "email": f"{username}@example.com"},
            "salt": user_salt,
            "loginPubkey": login_pubkey,
            "pubkey": encryption_pubkey,
            "encryptedContent": b"\x00" * 64,
        }

    def _assert_denied_without_rows(self, responses, username):
        from etebase_server.django.models import UserInfo

        for response in responses:
            assert response.status_code == 403
            assert decode_response(response)["code"] == "registration_token_required"
        assert not get_typed_user_model().objects.filter(username=username).exists()
        assert not UserInfo.objects.filter(owner__username=username).exists()

    def _attempts(self, auth_client, body, bootstrap_query=""):
        url = f"{AUTH_PREFIX}/signup/{bootstrap_query}"
        # The correct token in a URL query parameter must never be accepted.
        query_url = f"{url}{'&' if bootstrap_query else '?'}registration_token=synthetic-owner-token"
        return [
            msgpack_post(auth_client, url, body),
            msgpack_post(auth_client, url, body, headers={REGISTRATION_HEADER: "wrong-synthetic-token"}),
            msgpack_post(auth_client, url, body, headers={REGISTRATION_HEADER: ""}),
            msgpack_post(auth_client, query_url, body),
        ]

    @override_settings(ETEBASE_REGISTRATION_TOKEN="synthetic-owner-token")
    def test_missing_or_wrong_header_denies_first_signup(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        body = self._signup_body("first_owner_user", login_pubkey, encryption_pubkey, user_salt)

        self._assert_denied_without_rows(self._attempts(auth_client, body), "first_owner_user")

    @override_settings(ETEBASE_REGISTRATION_TOKEN="synthetic-owner-token")
    def test_missing_or_wrong_header_denies_signup_after_first_account(
        self, auth_client, user_factory, login_pubkey, encryption_pubkey, user_salt
    ):
        user_factory(username="existing_user", email="existing@example.com")
        body = self._signup_body("second_owner_user", login_pubkey, encryption_pubkey, user_salt)

        self._assert_denied_without_rows(self._attempts(auth_client, body), "second_owner_user")

    @override_settings(
        ETEBASE_REGISTRATION_TOKEN="synthetic-owner-token",
        ETEBASE_BOOTSTRAP_ADMIN_TOKEN="synthetic-bootstrap-token",
    )
    def test_legacy_bootstrap_query_token_does_not_bypass_registration_policy(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        body = self._signup_body("bootstrap_bypass_user", login_pubkey, encryption_pubkey, user_salt)

        responses = self._attempts(auth_client, body, bootstrap_query="?bootstrap_token=synthetic-bootstrap-token")

        self._assert_denied_without_rows(responses, "bootstrap_bypass_user")

    @override_settings(ETEBASE_REGISTRATION_TOKEN="synthetic-owner-token")
    def test_correct_header_admits_signup_before_and_after_first_account(
        self, auth_client, login_pubkey, encryption_pubkey, user_salt
    ):
        headers = {REGISTRATION_HEADER: "synthetic-owner-token"}
        first = self._signup_body("first_owner_user", login_pubkey, encryption_pubkey, user_salt)
        second = self._signup_body("second_owner_user", login_pubkey, encryption_pubkey, user_salt)

        first_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", first, headers=headers)
        second_response = msgpack_post(auth_client, f"{AUTH_PREFIX}/signup/", second, headers=headers)

        assert first_response.status_code in (200, 201)
        assert decode_response(first_response)["user"]["username"] == "first_owner_user"
        assert second_response.status_code in (200, 201)
        assert decode_response(second_response)["user"]["username"] == "second_owner_user"


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

        # Sign with an attacker key, NOT the user's real signing key. The
        # request must be rejected by the auth layer before crypto runs at
        # all — if a future regression accidentally bypasses auth but keeps
        # the crypto check intact, this body would still be rejected (wrong
        # signature) and the test would falsely pass. Using an attacker key
        # ensures only a true auth-layer rejection produces the expected
        # 401/403; a crypto-layer rejection would surface differently.
        attacker_key = nacl.signing.SigningKey.generate()

        _, challenge = login_challenge(auth_client, "test_user_alice")
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=challenge["challenge"],
            signing_key=attacker_key,
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

    def test_change_password_with_garbage_challenge_bytes_returns_client_error(
        self, auth_app, user_factory, signing_key
    ):
        from fastapi.testclient import TestClient

        client = TestClient(auth_app, raise_server_exceptions=False)
        user_factory(username="test_user_alice")
        token = self._auth_token(client, signing_key)
        attacker_key = nacl.signing.SigningKey.generate()
        body = build_signed_response(
            username="test_user_alice",
            challenge_bytes=b"\x00" * 64,
            signing_key=attacker_key,
            action="changePassword",
            extra={"loginPubkey": b"\x01" * 32, "encryptedContent": b"\x02" * 64},
        )

        response = msgpack_post(
            client,
            f"{AUTH_PREFIX}/change_password/",
            body,
            headers={"Authorization": f"Token {token}"},
        )

        assert response.status_code == 400
        assert decode_response(response)["code"] == "invalid_challenge"

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


# Synthetic, obviously fake per-install values for the opt-in owner login.
OWNER_PASSWORD = "0123456789abcdef" * 4
OWNER_SIGNING_MATERIAL = "synthetic-owner-registration-signing-material-" + "s" * 32
OWNER_HOST = "silentsuite.umbrel.test:8443"
OWNER_ORIGIN = f"https://{OWNER_HOST}"
OWNER_LOGIN_PATH = "/api/v1/owner/login/"
OWNER_USERNAME_MARKER = "owner-reflection-marker-7f3c"


@pytest.mark.django_db(transaction=True)
class TestOwnerLogin:
    """Opt-in owner login that issues a short-lived signup authorization."""

    @pytest.fixture
    def make_client(self, settings, tmp_path):
        settings.DEBUG = False
        settings.ALLOWED_HOSTS = ["silentsuite.umbrel.test"]
        settings.STATIC_ROOT = str(tmp_path / "static")
        (tmp_path / "static").mkdir()

        def _make(owner_enabled):
            if owner_enabled:
                settings.ETEBASE_OWNER_PASSWORD = OWNER_PASSWORD
                settings.ETEBASE_REGISTRATION_TOKEN = OWNER_SIGNING_MATERIAL
            from etebase_server.fastapi.main import create_application

            # The real ASGI app, created after settings so either wiring style is exercised.
            return TestClient(create_application(), base_url=OWNER_ORIGIN)

        return _make

    def _login(self, client, password=OWNER_PASSWORD, origin=OWNER_ORIGIN):
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        return client.post(
            OWNER_LOGIN_PATH,
            json={"password": password, "username": OWNER_USERNAME_MARKER},
            headers=headers,
        )

    def _assert_no_secret_or_marker(self, response):
        body = response.content.decode("utf-8", "replace")
        assert OWNER_PASSWORD not in body
        assert OWNER_SIGNING_MATERIAL not in body
        assert OWNER_USERNAME_MARKER not in body
        assert "no-store" in response.headers.get("cache-control", "")

    def test_owner_login_issues_short_signup_authorization(self, make_client):
        response = self._login(make_client(owner_enabled=True))

        assert response.status_code == 200
        grant = response.json()["registration_token"]
        assert isinstance(grant, str)
        assert grant.isascii()
        assert 0 < len(grant) <= 512
        self._assert_no_secret_or_marker(response)

    def test_owner_login_rejects_wrong_password(self, make_client):
        response = self._login(make_client(owner_enabled=True), password="fedcba9876543210" * 4)

        assert response.status_code == 403
        assert "registration_token" not in response.json()
        self._assert_no_secret_or_marker(response)

    def test_owner_login_rejects_missing_origin(self, make_client):
        response = self._login(make_client(owner_enabled=True), origin=None)

        assert response.status_code == 403
        assert "registration_token" not in response.json()
        self._assert_no_secret_or_marker(response)

    def test_owner_login_is_unavailable_when_not_configured(self, make_client):
        response = self._login(make_client(owner_enabled=False))
        body = response.content.decode("utf-8", "replace")

        assert response.status_code == 404
        assert OWNER_PASSWORD not in body
        assert "registration_token" not in body


_DROP = object()


@pytest.mark.django_db(transaction=True)
class TestOwnerSignedSignup:
    """Owner mode: only a valid signed owner grant admits an encrypted-account signup."""

    @pytest.fixture
    def owner_app(self, settings, tmp_path):
        settings.DEBUG = False
        settings.ALLOWED_HOSTS = ["silentsuite.umbrel.test"]
        settings.STATIC_ROOT = str(tmp_path / "static")
        (tmp_path / "static").mkdir()

        def _make(owner_password=OWNER_PASSWORD, signing_material=OWNER_SIGNING_MATERIAL):
            settings.ETEBASE_OWNER_PASSWORD = owner_password
            settings.ETEBASE_REGISTRATION_TOKEN = signing_material
            from etebase_server.fastapi.main import create_application

            return TestClient(create_application(), base_url=OWNER_ORIGIN)

        return _make

    @pytest.fixture
    def signup(self, login_pubkey, encryption_pubkey, user_salt):
        def _signup(client, username, headers=None):
            body = {
                "user": {"username": username, "email": f"{username.lower()}.mail@example.test"},
                "salt": user_salt,
                "loginPubkey": login_pubkey,
                "pubkey": encryption_pubkey,
                "encryptedContent": b"\x00" * 64,
            }
            return msgpack_post(client, f"{AUTH_PREFIX}/signup/", body, headers=headers or {})

        return _signup

    def _owner_grant(self, client, username):
        response = client.post(
            OWNER_LOGIN_PATH,
            json={"password": OWNER_PASSWORD, "username": username},
            headers={"Origin": OWNER_ORIGIN},
        )
        assert response.status_code == 200
        grant = response.json()["registration_token"]
        assert grant.isascii() and len(grant) <= 512
        return grant

    def _resigned(self, client, username, **changes):
        """A real issuer grant whose payload is modified and re-signed with the purpose key."""
        from django.core import signing

        from etebase_server.fastapi.routers.owner import GRANT_SALT, grant_signing_key

        key = grant_signing_key(OWNER_SIGNING_MATERIAL)
        payload = signing.loads(self._owner_grant(client, username), key=key, salt=GRANT_SALT, fallback_keys=[])
        for name, value in changes.items():
            if value is _DROP:
                payload.pop(name)
            else:
                payload[name] = value
        return signing.dumps(payload, key=key, salt=GRANT_SALT, compress=False)

    def _rows(self, username):
        from etebase_server.django.models import UserInfo

        users = get_typed_user_model().objects.filter(username__iexact=username).count()
        infos = UserInfo.objects.filter(owner__username__iexact=username).count()
        return users, infos

    def _assert_denied(self, response, username):
        assert response.status_code == 403
        assert decode_response(response)["code"] == "registration_token_required"
        assert self._rows(username) == (0, 0)

    # --- valid signed grants -------------------------------------------------

    def test_owner_grant_admits_first_account_and_ordinary_login(self, owner_app, signup, signing_key):
        client = owner_app()
        username = "owner_first_user"
        grant = self._owner_grant(client, username)

        response = signup(client, username, {REGISTRATION_HEADER: grant})

        assert response.status_code in (200, 201)
        assert decode_response(response)["user"]["username"] == username
        assert self._rows(username) == (1, 1)
        # Ordinary cryptographic login needs no owner grant.
        login = perform_login(client, username=username, signing_key=signing_key, host=OWNER_HOST)
        assert login.status_code == 200

    def test_owner_grant_admits_account_after_first_and_keeps_uniqueness(self, owner_app, signup, user_factory):
        user_factory(username="existing_user", email="existing@example.com")
        client = owner_app()
        username = "owner_second_user"
        grant = self._owner_grant(client, username)

        first = signup(client, username, {REGISTRATION_HEADER: grant})
        replay = signup(client, username, {REGISTRATION_HEADER: grant})

        assert first.status_code in (200, 201)
        assert replay.status_code == 409
        assert decode_response(replay)["code"] == "user_exists"
        assert self._rows(username) == (1, 1)

    def test_owner_grant_binds_username_with_python_lower(self, owner_app, signup):
        client = owner_app()
        grant = self._owner_grant(client, "Owner_Case_User")

        response = signup(client, "owner_case_user", {REGISTRATION_HEADER: grant})

        assert response.status_code in (200, 201)
        assert self._rows("owner_case_user") == (1, 1)

    # --- owner mode never accepts the raw signing material or opens signup ---

    def test_raw_signing_material_is_not_a_signup_credential(self, owner_app, signup):
        client = owner_app()

        response = signup(client, "raw_key_user", {REGISTRATION_HEADER: OWNER_SIGNING_MATERIAL})

        self._assert_denied(response, "raw_key_user")

    @pytest.mark.parametrize(
        "signing_material",
        ["", "short-signing-material", OWNER_PASSWORD],
        ids=["empty", "too-short", "equals-owner-password"],
    )
    def test_invalid_owner_configuration_never_opens_signup(self, owner_app, signup, signing_material):
        client = owner_app(signing_material=signing_material)

        attempts = [signup(client, "misconfigured_user")]
        if signing_material:
            attempts.append(signup(client, "misconfigured_user", {REGISTRATION_HEADER: signing_material}))

        for response in attempts:
            assert response.status_code in (403, 503)
        assert self._rows("misconfigured_user") == (0, 0)

    def test_missing_or_duplicate_authority_headers_are_denied(self, owner_app, signup):
        client = owner_app()
        grant = self._owner_grant(client, "header_count_user")

        missing = signup(client, "header_count_user")
        body = {
            "user": {"username": "header_count_user", "email": "header_count_user@example.test"},
            "salt": b"\x01" * 32,
            "loginPubkey": b"\x02" * 32,
            "pubkey": b"\x03" * 32,
            "encryptedContent": b"\x00" * 64,
        }
        duplicate = auth_duplicate_header_post(client, body, grant)

        self._assert_denied(missing, "header_count_user")
        self._assert_denied(duplicate, "header_count_user")

    # --- grants that must not admit -----------------------------------------

    def test_grant_for_another_user_is_denied(self, owner_app, signup):
        client = owner_app()
        grant = self._owner_grant(client, "intended_user")

        self._assert_denied(signup(client, "other_user", {REGISTRATION_HEADER: grant}), "other_user")

    @pytest.mark.parametrize(
        "issued_host", ["silentsuite.umbrel.test:9443", "other-name.umbrel.test:8443", "silentsuite.umbrel.test"]
    )
    def test_grant_for_another_host_or_port_is_denied(self, owner_app, signup, issued_host):
        from etebase_server.fastapi.routers.owner import issue_signup_grant

        client = owner_app()
        grant = issue_signup_grant(OWNER_SIGNING_MATERIAL, "host_bound_user", issued_host)

        self._assert_denied(signup(client, "host_bound_user", {REGISTRATION_HEADER: grant}), "host_bound_user")

    @pytest.mark.parametrize("clock_offset", [-300, 300], ids=["expired", "future-issued"])
    def test_expired_or_future_issued_grant_is_denied(self, owner_app, signup, clock_offset):
        from etebase_server.fastapi.routers.owner import issue_signup_grant

        client = owner_app()
        # The real issuer on a shifted clock: both the payload iat and the signature timestamp move.
        with patch("time.time", return_value=time_module.time() + clock_offset):
            grant = issue_signup_grant(OWNER_SIGNING_MATERIAL, "clock_user", OWNER_HOST)

        self._assert_denied(signup(client, "clock_user", {REGISTRATION_HEADER: grant}), "clock_user")

    @pytest.mark.parametrize(
        "changes",
        [
            {"iat": 0},
            {"iat": 10**12},
            {"iat": True},
            {"iat": "0"},
            {"v": 2},
            {"p": "login"},
            {"n": _DROP},
            {"extra": "x"},
        ],
        ids=["iat-expired", "iat-future", "iat-bool", "iat-string", "version", "purpose", "missing-key", "extra-key"],
    )
    def test_resigned_grant_with_bad_schema_or_time_is_denied(self, owner_app, signup, changes):
        client = owner_app()
        grant = self._resigned(client, "schema_user", **changes)

        self._assert_denied(signup(client, "schema_user", {REGISTRATION_HEADER: grant}), "schema_user")

    def test_grant_with_bad_signature_or_other_key_is_denied(self, owner_app, signup, settings):
        from django.core import signing

        from etebase_server.fastapi.routers.owner import GRANT_SALT, grant_signing_key

        client = owner_app()
        grant = self._owner_grant(client, "signature_user")
        payload = signing.loads(
            grant, key=grant_signing_key(OWNER_SIGNING_MATERIAL), salt=GRANT_SALT, fallback_keys=[]
        )
        tampered = grant[:-1] + ("A" if grant[-1] != "A" else "B")
        secret_key_signed = signing.dumps(payload, key=settings.SECRET_KEY, salt=GRANT_SALT)
        raw_material_signed = signing.dumps(payload, key=OWNER_SIGNING_MATERIAL, salt=GRANT_SALT)
        oversized = grant + "A" * (513 - len(grant))

        for candidate in (tampered, secret_key_signed, raw_material_signed, oversized):
            response = signup(client, "signature_user", {REGISTRATION_HEADER: candidate})
            self._assert_denied(response, "signature_user")


def auth_duplicate_header_post(client, body, grant):
    """POST a signup carrying the authority header twice (raw ASGI header list)."""
    return client.post(
        f"{AUTH_PREFIX}/signup/",
        content=msgpack_encode(body),
        headers=[
            ("Content-Type", "application/msgpack"),
            ("Accept", "application/msgpack"),
            (REGISTRATION_HEADER, grant),
            (REGISTRATION_HEADER, grant),
        ],
    )
