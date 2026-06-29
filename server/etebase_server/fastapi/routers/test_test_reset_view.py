import pytest
from django.test.utils import override_settings
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.fastapi.conftest import decode_response, msgpack_post
from etebase_server.fastapi.exceptions import CustomHttpException
from etebase_server.fastapi.msgpack import MsgpackResponse
from etebase_server.fastapi.routers.test_reset_view import test_reset_view_router


@pytest.fixture
def reset_client():
    app = FastAPI()
    app.include_router(test_reset_view_router, prefix="/api/v1/test/authentication")

    @app.exception_handler(CustomHttpException)
    async def _custom_exception_handler(_request, exc: CustomHttpException):
        return MsgpackResponse(status_code=exc.status_code, content=exc.as_dict)

    return TestClient(app)


def _reset_body(username, email, login_pubkey, encryption_pubkey, user_salt):
    return {
        "user": {"username": username, "email": email},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": encryption_pubkey,
        "encryptedContent": b"\x00" * 64,
    }


@pytest.mark.django_db(transaction=True)
@override_settings(DEBUG=True)
def test_reset_reinitializes_existing_test_user(
    reset_client, user_factory, login_pubkey, encryption_pubkey, user_salt
):
    user = user_factory(username="test_user_reset", email="reset@example.com")
    body = _reset_body("test_user_reset", "reset@example.com", login_pubkey, encryption_pubkey, user_salt)

    response = msgpack_post(reset_client, "/api/v1/test/authentication/reset/", body)

    assert response.status_code in (200, 204)
    user.refresh_from_db()
    assert bytes(user.userinfo.loginPubkey) == login_pubkey
    assert bytes(user.userinfo.pubkey) == encryption_pubkey
    assert bytes(user.userinfo.salt) == user_salt


@pytest.mark.django_db(transaction=True)
@override_settings(DEBUG=True)
def test_reset_rejects_non_test_users(reset_client, user_factory, login_pubkey, encryption_pubkey, user_salt):
    user_factory(username="regular_user", email="regular@example.com")
    body = _reset_body("regular_user", "regular@example.com", login_pubkey, encryption_pubkey, user_salt)

    response = msgpack_post(reset_client, "/api/v1/test/authentication/reset/", body)

    assert response.status_code == 400
    assert decode_response(response)["code"] == "generic"


@pytest.mark.django_db(transaction=True)
@override_settings(DEBUG=False)
def test_reset_rejects_when_debug_is_disabled(reset_client, user_factory, login_pubkey, encryption_pubkey, user_salt):
    user_factory(username="test_user_reset", email="reset@example.com")
    body = _reset_body("test_user_reset", "reset@example.com", login_pubkey, encryption_pubkey, user_salt)

    response = msgpack_post(reset_client, "/api/v1/test/authentication/reset/", body)

    assert response.status_code == 400
    assert decode_response(response)["code"] == "generic"
