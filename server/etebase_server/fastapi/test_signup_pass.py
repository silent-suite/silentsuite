"""Hosted signup pass: Billing's machine-key issuer and the signup enforcement behind
ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED (SQLite; overlap tests live in test_signup_pass_postgres.py).

The shared contract fixture (testdata/signup-pass-contract.v2.json) is pinned by checksum; Billing
and the web app carry the same file.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
import sys
from datetime import timedelta
from pathlib import Path

import pytest
from django.core.exceptions import ImproperlyConfigured, ValidationError
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone

from etebase_server.django.models import HeldUsername, SignupPass, sha256_hex
from etebase_server.fastapi.conftest import AUTH_PREFIX, decode_response
from etebase_server.fastapi.test_login_email_change import MACHINE_KEY, make_app_client
from etebase_server.fastapi.utils import canonical_login_email, msgpack_encode
from etebase_server.myauth.models import get_typed_user_model
from etebase_server.utils import signup_mode

pytestmark = pytest.mark.django_db(transaction=True)
User = get_typed_user_model()
FIXTURE = Path(__file__).parent / "testdata" / "signup-pass-contract.v2.json"
FIXTURE_SHA256 = "7edfa4d7e95ac412bb506a75f65ee8f59f571dd76e9f97dbf15de6f4ba06e6e8"
CONTRACT = json.loads(FIXTURE.read_text(encoding="utf-8"))
ISSUE = "/api/v1/billing/signup-pass/"
HEADER = "X-SilentSuite-Registration-Token"
EMAIL = "new@example.com"
SERVER_ROOT = Path(__file__).resolve().parents[2]
# The signup route returns its MsgpackResponse directly, so a created account answers 200.
SIGNED_UP = 200


@pytest.fixture
def client(settings, tmp_path, monkeypatch):
    return make_app_client(settings, tmp_path, monkeypatch)


@pytest.fixture
def required(settings):
    settings.ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED = True
    settings.ETEBASE_REGISTRATION_TOKEN = ""
    settings.ETEBASE_OWNER_PASSWORD = ""


def issue(client, email, key=MACHINE_KEY):
    headers = {"X-Etebase-Billing-Key": key} if key is not None else {}
    return client.post(ISSUE, json={"email": email}, headers=headers)


def issued(client, email=EMAIL) -> str:
    response = issue(client, email)
    assert response.status_code == 200, response.content[:300]
    return response.json()["signupPass"]


def signup(client, login_pubkey, user_salt, username=EMAIL, email=None, passes=None):
    body = {
        "user": {"username": username, "email": username if email is None else email},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": login_pubkey,
        "encryptedContent": b"\x00" * 64,
    }
    headers = [(HEADER, value) for value in (passes or [])]
    headers += [("Content-Type", "application/msgpack"), ("Accept", "application/msgpack")]
    return client.post(f"{AUTH_PREFIX}/signup/", content=msgpack_encode(body), headers=headers)


def assert_refused(response):
    assert response.status_code == 403, response.content[:300]
    assert decode_response(response)["code"] == "registration_token_required"


def pass_row(value: str) -> SignupPass:
    return SignupPass.objects.get(pass_hash=sha256_hex(value))


# ---------------------------------------------------------------------------
# Contract fixture and schema
# ---------------------------------------------------------------------------


def test_contract_fixture_is_the_pinned_shared_copy():
    assert hashlib.sha256(FIXTURE.read_bytes()).hexdigest() == FIXTURE_SHA256
    assert CONTRACT["contractVersion"] == 2
    assert CONTRACT["header"].lower() == HEADER.lower()
    assert CONTRACT["ttlSeconds"] == 600
    assert CONTRACT["server"]["route"] == ISSUE
    assert CONTRACT["server"]["requiredSetting"] == "ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED"


@pytest.mark.parametrize("vector", CONTRACT["vectors"], ids=[v["name"] for v in CONTRACT["vectors"]])
def test_vectors_match_the_server_login_email_rule(vector):
    assert (canonical_login_email(vector["input"]) == vector["input"]) is vector["supported"]


def test_migration_0041_extends_the_app_graph():
    loader = MigrationLoader(connection)
    target = ("django_etebase", "0041_signup_pass")

    assert target in loader.graph.nodes
    assert ("django_etebase", "0040_login_email_change") in loader.graph.forwards_plan(target)


# ---------------------------------------------------------------------------
# Issuer
# ---------------------------------------------------------------------------


def test_issue_returns_a_short_lived_pass_and_stores_only_its_digest(client):
    response = issue(client, EMAIL)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"signupPass", "expiresIn"}
    assert body["expiresIn"] == CONTRACT["ttlSeconds"]
    assert len(body["signupPass"]) == CONTRACT["pass"]["length"]
    row = pass_row(body["signupPass"])
    assert row.email == EMAIL and row.consumed_at is None
    assert timedelta(seconds=599) < row.expires_at - row.created_at <= timedelta(seconds=600)
    assert not SignupPass.objects.filter(pass_hash=body["signupPass"]).exists()


@pytest.mark.parametrize("key", [None, "", "wrong-key"])
def test_issue_requires_the_machine_key(client, key):
    response = issue(client, EMAIL, key=key)

    assert response.status_code == 401
    assert not SignupPass.objects.exists()


def test_issue_fails_closed_without_a_configured_machine_key(client, monkeypatch):
    monkeypatch.delenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY")

    assert issue(client, EMAIL).status_code == 401


@pytest.mark.parametrize("vector", CONTRACT["vectors"], ids=[v["name"] for v in CONTRACT["vectors"]])
def test_issue_accepts_only_addresses_that_are_already_canonical(client, vector):
    response = issue(client, vector["input"])

    if vector["supported"]:
        assert response.status_code == 200, response.content[:300]
        assert pass_row(response.json()["signupPass"]).email == vector["input"]
    else:
        assert response.status_code == 400
        assert response.json() == {"code": "unsupported_address"}
        assert not SignupPass.objects.exists()


@pytest.mark.parametrize(
    "existing",
    [
        {"username": EMAIL, "email": "other@example.com"},
        {"username": "someone", "email": EMAIL},
        {"username": "someone", "email": "NEW@example.com"},
    ],
)
def test_issue_refuses_an_address_that_identifies_an_account(client, user_factory, existing, caplog):
    user_factory(**existing)

    with caplog.at_level(logging.INFO):
        response = issue(client, EMAIL)

    assert response.status_code == 409
    assert response.json() == {"code": "name_taken"}
    assert not SignupPass.objects.exists()
    assert "reason=name_taken" in caplog.text
    assert EMAIL not in caplog.text


@pytest.mark.parametrize("holder", ["user", "deleted user"])
def test_issue_refuses_a_held_address(client, user_factory, holder):
    user = user_factory(username="mover@example.com", email="mover@example.com")
    HeldUsername.objects.create(name=EMAIL, user=user if holder == "user" else None)

    response = issue(client, EMAIL)

    assert response.status_code == 409
    assert response.json() == {"code": "name_taken"}


def test_several_live_passes_for_one_address_are_allowed(client):
    first, second = issued(client), issued(client)

    assert first != second
    assert SignupPass.objects.filter(email=EMAIL, consumed_at__isnull=True).count() == 2


def test_issue_deletes_expired_passes(client):
    old = timezone.now() - timedelta(hours=1)
    SignupPass.objects.create(pass_hash="0" * 64, email="a@example.com", created_at=old, expires_at=old)
    SignupPass.objects.create(pass_hash="1" * 64, email="b@example.com", created_at=old, expires_at=old, consumed_at=old)
    live = SignupPass.objects.create(
        pass_hash="2" * 64, email="c@example.com", expires_at=timezone.now() + timedelta(minutes=5)
    )

    issued(client)

    assert set(SignupPass.objects.values_list("pk", flat=True)) - {live.pk} == {
        SignupPass.objects.get(email=EMAIL).pk
    }


def test_issue_survives_a_failed_cleanup_and_logs_fixed_text_only(client, monkeypatch, caplog):
    from etebase_server.fastapi.routers import billing_link

    class Broken:
        def delete(self):
            raise RuntimeError("synthetic-detail victim@example.com")

    monkeypatch.setattr(billing_link.SignupPass.objects, "filter", lambda **_: Broken())

    with caplog.at_level(logging.INFO):
        assert issue(client, EMAIL).status_code == 200

    assert "expired signup pass cleanup failed" in caplog.messages
    assert "synthetic-detail" not in caplog.text
    assert "victim@example.com" not in caplog.text
    assert all(record.exc_info is None and record.exc_text is None for record in caplog.records)


@pytest.mark.parametrize("length", [513, 60000])
def test_issue_answers_unsupported_address_for_an_overlong_email(client, length):
    response = issue(client, "a" * (length - len("@example.com")) + "@example.com")

    assert response.status_code == 400
    assert response.json() == {"code": "unsupported_address"}


def test_issue_gives_the_full_lifetime_after_waiting_for_the_name_lock(client, monkeypatch):
    import time

    from etebase_server.fastapi.routers import billing_link

    original = billing_link.claim_names
    after_lock = []

    def slow_lock(names):
        original(names)
        time.sleep(0.3)  # a wait for another transaction holding the name
        after_lock.append(timezone.now())

    monkeypatch.setattr(billing_link, "claim_names", slow_lock)

    row = pass_row(issued(client))

    assert row.created_at >= after_lock[0]
    assert row.expires_at - row.created_at == timedelta(seconds=CONTRACT["ttlSeconds"])


# ---------------------------------------------------------------------------
# Signup with the setting off: today's behaviour, header ignored
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("passes", [[], ["garbage"], ["a", "b"]])
def test_setting_off_ignores_the_header(client, login_pubkey, user_salt, passes):
    response = signup(client, login_pubkey, user_salt, passes=passes)

    assert response.status_code == SIGNED_UP, response.content[:300]


def test_setting_off_leaves_an_issued_pass_unused(client, login_pubkey, user_salt):
    value = issued(client)

    assert signup(client, login_pubkey, user_salt, passes=[value]).status_code == SIGNED_UP
    assert pass_row(value).consumed_at is None


def test_the_setting_defaults_off():
    from django.conf import settings

    assert settings.ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED is False


# ---------------------------------------------------------------------------
# Signup with the setting on
# ---------------------------------------------------------------------------


def test_issue_then_signup_creates_the_account_and_uses_the_pass(client, required, login_pubkey, user_salt):
    value = issued(client)

    response = signup(client, login_pubkey, user_salt, passes=[value])

    assert response.status_code == SIGNED_UP, response.content[:300]
    user = User.objects.get(username=EMAIL)
    assert user.email == EMAIL
    assert pass_row(value).consumed_at is not None


@pytest.mark.parametrize(
    "passes,reason",
    [([], "missing"), ([""], "missing"), (["x" * 43, "y" * 43], "invalid"), (["x" * 43], "invalid")],
    ids=["no header", "empty header", "duplicate header", "unknown pass"],
)
def test_signup_refuses_a_missing_duplicate_or_unknown_pass(
    client, required, login_pubkey, user_salt, caplog, passes, reason
):
    with caplog.at_level(logging.INFO):
        response = signup(client, login_pubkey, user_salt, passes=passes)

    assert_refused(response)
    assert not User.objects.filter(username=EMAIL).exists()
    assert f"hosted signup refused: reason={reason}" in caplog.text
    assert EMAIL not in caplog.text


def test_signup_refuses_a_duplicate_header_even_with_a_valid_pass(client, required, login_pubkey, user_salt):
    value = issued(client)

    assert_refused(signup(client, login_pubkey, user_salt, passes=[value, value]))
    assert pass_row(value).consumed_at is None


def test_signup_refuses_an_expired_pass(client, required, login_pubkey, user_salt, caplog):
    value = issued(client)
    SignupPass.objects.filter(pass_hash=sha256_hex(value)).update(expires_at=timezone.now() - timedelta(seconds=1))

    with caplog.at_level(logging.INFO):
        assert_refused(signup(client, login_pubkey, user_salt, passes=[value]))
    assert "reason=expired" in caplog.text
    assert value not in caplog.text


def test_signup_refuses_a_consumed_pass(client, required, login_pubkey, user_salt, caplog):
    value = issued(client)
    SignupPass.objects.filter(pass_hash=sha256_hex(value)).update(consumed_at=timezone.now())

    with caplog.at_level(logging.INFO):
        assert_refused(signup(client, login_pubkey, user_salt, passes=[value]))
    assert "reason=consumed" in caplog.text


def test_a_pass_creates_one_account_only(client, required, login_pubkey, user_salt):
    value = issued(client)
    assert signup(client, login_pubkey, user_salt, passes=[value]).status_code == SIGNED_UP

    again = signup(client, login_pubkey, user_salt, passes=[value])

    assert again.status_code == 409
    assert decode_response(again)["code"] == "user_exists"


@pytest.mark.parametrize(
    "username,email",
    [
        ("other@example.com", "other@example.com"),
        (EMAIL, "other@example.com"),
        ("other@example.com", EMAIL),
        ("NEW@example.com", EMAIL),
        (EMAIL, "NEW@example.com"),
        (EMAIL, " new@example.com"),
        ("new", EMAIL),
    ],
)
def test_signup_refuses_names_other_than_the_pass_address(
    client, required, login_pubkey, user_salt, caplog, username, email
):
    value = issued(client)

    with caplog.at_level(logging.INFO):
        assert_refused(signup(client, login_pubkey, user_salt, username=username, email=email, passes=[value]))
    assert "reason=mismatch" in caplog.text
    assert pass_row(value).consumed_at is None
    assert User.objects.count() == 0


def test_signup_refuses_a_name_held_after_the_pass_was_issued(client, required, user_factory, login_pubkey, user_salt):
    value = issued(client)
    user = user_factory(username="mover@example.com", email="mover@example.com")
    HeldUsername.objects.create(name=EMAIL, user=user)

    response = signup(client, login_pubkey, user_salt, passes=[value])

    assert response.status_code == 409
    assert decode_response(response)["code"] == "user_exists"
    assert pass_row(value).consumed_at is None


def test_signup_conflict_leaves_the_pass_unused(client, required, user_factory, login_pubkey, user_salt):
    value = issued(client)
    user_factory(username="someone", email=EMAIL)

    response = signup(client, login_pubkey, user_salt, passes=[value])

    assert response.status_code == 409
    assert pass_row(value).consumed_at is None


def test_a_failure_after_consuming_rolls_the_pass_back(client, required, login_pubkey, user_salt, monkeypatch):
    from etebase_server.fastapi.routers import authentication

    value = issued(client)

    def invalid_user(*_args, **_kwargs):
        raise ValidationError({"username": ["invalid"]})

    monkeypatch.setattr(authentication, "create_user", invalid_user)

    response = signup(client, login_pubkey, user_salt, passes=[value])

    assert response.status_code == 400, response.content[:300]
    assert pass_row(value).consumed_at is None
    assert User.objects.count() == 0


def test_a_rolled_back_pass_can_still_sign_up(client, required, login_pubkey, user_salt, monkeypatch):
    from etebase_server.fastapi.routers import authentication

    value = issued(client)
    original = authentication.create_user
    calls = []

    def fail_once(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise ValidationError({"username": ["invalid"]})
        return original(*args, **kwargs)

    monkeypatch.setattr(authentication, "create_user", fail_once)

    assert signup(client, login_pubkey, user_salt, passes=[value]).status_code == 400
    assert signup(client, login_pubkey, user_salt, passes=[value]).status_code == SIGNED_UP
    assert pass_row(value).consumed_at is not None


# ---------------------------------------------------------------------------
# Mode and configuration
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token,owner,required_flag,mode",
    [
        ("", "", False, "open"),
        ("t", "", False, "registration-token"),
        ("t", "p", False, "owner"),
        ("", "", True, "hosted-pass"),
    ],
)
def test_signup_mode_names(token, owner, required_flag, mode):
    assert signup_mode(token, owner, required_flag) == mode


@pytest.mark.parametrize("token,owner", [("t", ""), ("", "p"), ("t", "p")])
def test_signup_mode_refuses_the_pass_with_another_signup_gate(token, owner):
    with pytest.raises(ImproperlyConfigured):
        signup_mode(token, owner, True)


def _load_settings(extra_env, settings_module_dir=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith("ETEBASE_")}
    env.pop("PYTHONPATH", None)
    env.update({"DJANGO_SETTINGS_MODULE": "etebase_server.settings", **extra_env})
    if settings_module_dir is not None:
        env["PYTHONPATH"] = str(settings_module_dir)
    return subprocess.run(
        [sys.executable, "-c", "import django; django.setup(); from django.conf import settings; print(settings.ETEBASE_SIGNUP_MODE)"],
        cwd=SERVER_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.mark.parametrize(
    "extra", [{"ETEBASE_REGISTRATION_TOKEN": "synthetic-token"}, {"ETEBASE_OWNER_PASSWORD": "synthetic-owner-password"}]
)
def test_startup_refuses_the_pass_with_another_signup_gate(extra):
    result = _load_settings({"ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED": "true", **extra})

    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr
    assert "synthetic" not in result.stderr


@pytest.mark.parametrize("value,mode", [("true", "hosted-pass"), ("false", "open")])
def test_startup_reads_the_setting(value, mode):
    result = _load_settings({"ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED": value})

    assert result.returncode == 0, result.stderr[-500:]
    assert result.stdout.strip() == mode


@pytest.mark.parametrize(
    "env_value,module_body,mode",
    [
        ("false", "ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED = True\n", "hosted-pass"),
        ("true", "ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED = False\n", "open"),
    ],
)
def test_the_mode_follows_the_settings_module_override(tmp_path, env_value, module_body, mode):
    (tmp_path / "etebase_server_settings.py").write_text(module_body)

    result = _load_settings({"ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED": env_value}, settings_module_dir=tmp_path)

    assert result.returncode == 0, result.stderr[-500:]
    assert result.stdout.strip() == mode


@pytest.mark.parametrize("name", ["ETEBASE_REGISTRATION_TOKEN", "ETEBASE_OWNER_PASSWORD"])
def test_startup_refuses_a_conflict_introduced_by_the_settings_module(tmp_path, name):
    (tmp_path / "etebase_server_settings.py").write_text(f'{name} = "synthetic-value"\n')

    result = _load_settings({"ETEBASE_HOSTED_SIGNUP_PASS_REQUIRED": "true"}, settings_module_dir=tmp_path)

    assert result.returncode != 0
    assert "ImproperlyConfigured" in result.stderr
    assert "synthetic-value" not in result.stderr


def test_startup_logs_the_mode_name_only(settings, caplog):
    from etebase_server.fastapi.main import log_signup_mode

    settings.ETEBASE_SIGNUP_MODE = "hosted-pass"
    with caplog.at_level(logging.INFO):
        log_signup_mode()

    assert caplog.messages == ["signup mode: hosted-pass"]
