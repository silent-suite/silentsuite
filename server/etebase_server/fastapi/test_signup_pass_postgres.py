"""Overlapping-transaction tests for hosted signup passes (PostgreSQL row and advisory locks; skipped
on SQLite). Same pattern as test_login_email_change_postgres.py: pause the first transaction after
its collision check while it holds the name lock, prove the competitor waits, then finish both.
"""

from __future__ import annotations

import pytest
from django.db import connection

from etebase_server.django.models import SignupPass, sha256_hex
from etebase_server.fastapi.conftest import decode_response
from etebase_server.fastapi.test_login_email_change import accepted_change, commit, make_app_client
from etebase_server.fastapi.test_login_email_change_postgres import Pause, fresh, overlap
from etebase_server.fastapi.test_signup_pass import EMAIL, SIGNED_UP, issue, issued, signup
from etebase_server.myauth.models import get_typed_user_model

pytestmark = [
    pytest.mark.postgres_only,
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(connection.vendor != "postgresql", reason="needs PostgreSQL row and advisory locks"),
]
User = get_typed_user_model()


@pytest.fixture
def client(settings, tmp_path, monkeypatch):
    settings.ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED = True
    settings.ETEBASE_REGISTRATION_TOKEN = ""
    settings.ETEBASE_OWNER_PASSWORD = ""
    return make_app_client(settings, tmp_path, monkeypatch)


def consumed() -> int:
    return SignupPass.objects.filter(consumed_at__isnull=False).count()


@pytest.mark.parametrize("passes", ["one pass twice", "two passes"])
def test_two_signups_for_one_address_create_one_account(client, login_pubkey, user_salt, monkeypatch, passes):
    from etebase_server.fastapi.routers import authentication

    first_pass = issued(client)
    second_pass = first_pass if passes == "one pass twice" else issued(client)

    won, lost = overlap(
        monkeypatch,
        Pause(authentication, "signup_identity_taken"),
        lambda: signup(fresh(client), login_pubkey, user_salt, passes=[first_pass]),
        lambda: signup(fresh(client), login_pubkey, user_salt, passes=[second_pass]),
    )

    assert won.status_code == SIGNED_UP, won.content[:300]
    assert lost.status_code == 409
    assert decode_response(lost)["code"] == "user_exists"
    assert User.objects.filter(username=EMAIL).count() == 1
    assert consumed() == 1
    assert SignupPass.objects.get(pass_hash=sha256_hex(first_pass)).consumed_at is not None


def test_issue_waits_for_a_signup_holding_the_name_and_then_refuses(client, login_pubkey, user_salt, monkeypatch):
    from etebase_server.fastapi.routers import authentication

    value = issued(client)

    signed_up, refused = overlap(
        monkeypatch,
        Pause(authentication, "signup_identity_taken"),
        lambda: signup(fresh(client), login_pubkey, user_salt, passes=[value]),
        lambda: issue(fresh(client), EMAIL),
    )

    assert signed_up.status_code == SIGNED_UP
    assert refused.status_code == 409
    assert refused.json() == {"code": "name_taken"}


def test_rename_first_then_pass_signup_for_the_destination_is_refused(
    client, user_factory, signing_key, login_pubkey, user_salt, monkeypatch
):
    from etebase_server.fastapi.routers import billing_link

    value = issued(client)
    user = user_factory(username="mover@example.com", email="mover@example.com")
    grant = accepted_change(client, user, signing_key, EMAIL)["grant"]

    committed, signed_up = overlap(
        monkeypatch,
        Pause(billing_link, "destination_taken"),
        lambda: commit(fresh(client), grant),
        lambda: signup(fresh(client), login_pubkey, user_salt, passes=[value]),
    )

    assert committed.status_code == 200
    assert signed_up.status_code == 409
    assert consumed() == 0


def test_pass_signup_first_then_rename_to_its_address_is_refused(
    client, user_factory, signing_key, login_pubkey, user_salt, monkeypatch
):
    from etebase_server.fastapi.routers import authentication

    value = issued(client)
    user = user_factory(username="mover@example.com", email="mover@example.com")
    grant = accepted_change(client, user, signing_key, EMAIL)["grant"]

    signed_up, committed = overlap(
        monkeypatch,
        Pause(authentication, "signup_identity_taken"),
        lambda: signup(fresh(client), login_pubkey, user_salt, passes=[value]),
        lambda: commit(fresh(client), grant),
    )

    assert signed_up.status_code == SIGNED_UP
    assert committed.json() == {"code": "refused", "reason": "taken"}
    assert consumed() == 1
