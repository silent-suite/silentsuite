"""Hosted login email change: signed request, Billing accept/commit/cancel/ack, name holds,
identity snapshots and retention (SQLite; PostgreSQL overlap tests live in
test_login_email_change_postgres.py).

There is no Etebase Python client in the server's test dependencies, so the "client" here is the
same emulation the authentication tests use: a nacl signing key standing in for the
password-derived login key, signing msgpack responses to server-issued challenges.
"""

from __future__ import annotations

from datetime import timedelta
from io import StringIO

import nacl.signing
import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from fastapi.testclient import TestClient

from etebase_server.django import models
from etebase_server.django.models import HeldUsername, LoginEmailChange, UserInfo, sha256_hex
from etebase_server.django.token_auth.models import AuthToken
from etebase_server.fastapi.conftest import (
    AUTH_PREFIX,
    build_signed_response,
    decode_response,
    login_challenge,
    msgpack_post,
    perform_login,
)
from etebase_server.fastapi.utils import canonical_login_email, identity_snapshot, msgpack_encode
from etebase_server.myauth.models import get_typed_user_model

pytestmark = pytest.mark.django_db(transaction=True)
User = get_typed_user_model()
MACHINE_KEY = "test-machine-key"
BILLING = "/api/v1/billing/login-email"


@pytest.fixture
def client(settings, tmp_path, monkeypatch):
    return make_app_client(settings, tmp_path, monkeypatch)


def make_app_client(settings, tmp_path, monkeypatch):
    """The real application with its production exception handlers."""
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    settings.DEBUG = False
    settings.ALLOWED_HOSTS = ["testserver"]
    (tmp_path / "static").mkdir()
    settings.STATIC_ROOT = str(tmp_path / "static")
    settings.MEDIA_ROOT = str(tmp_path / "media")
    from etebase_server.fastapi.main import create_application

    return TestClient(create_application(), raise_server_exceptions=False)


def token_for(user) -> str:
    return AuthToken.objects.create(user=user).key


def signed_request_body(client, username, signing_key, new_username, *, action="changeLoginEmail", challenge=None):
    if challenge is None:
        response, data = login_challenge(client, username)
        assert response.status_code == 200, response.content[:200]
        challenge = data["challenge"]
    body = build_signed_response(
        username=username,
        challenge_bytes=challenge,
        signing_key=signing_key,
        action=action,
        extra={"newUsername": new_username},
    )
    return msgpack_encode(body)


def post_request(client, token, body: bytes):
    return client.post(
        f"{BILLING}/request/",
        content=body,
        headers={"Authorization": f"Token {token}", "Content-Type": "application/msgpack"},
    )


def request_change(client, user, signing_key, new_username):
    response = post_request(client, token_for(user), signed_request_body(client, user.username, signing_key, new_username))
    assert response.status_code == 200, response.content[:300]
    return response.json()["handoff"]


def machine_post(client, path, body, key=MACHINE_KEY):
    headers = {"X-Etebase-Billing-Key": key} if key is not None else {}
    return client.post(f"{BILLING}/{path}/", json=body, headers=headers)


def accept(client, handoff, destination, *, expected_id=None, bootstrap=None):
    return machine_post(
        client,
        "accept",
        {
            "handoff": handoff,
            "destination": destination,
            "expectedId": expected_id,
            "expectedBootstrapUsername": bootstrap,
        },
    )


def accepted_change(client, user, signing_key, new_username):
    response = accept(client, request_change(client, user, signing_key, new_username), new_username, expected_id=user.pk)
    assert response.status_code == 200, response.content[:300]
    return response.json()


def commit(client, grant):
    return machine_post(client, "commit", {"grant": grant})


def rename(client, user, signing_key, new_username):
    response = commit(client, accepted_change(client, user, signing_key, new_username)["grant"])
    assert response.status_code == 200, response.content[:300]
    return response.json()


def assert_refused(response, reason):
    assert response.status_code == 409, response.content[:300]
    assert response.json() == {"code": "refused", "reason": reason}


# ---------------------------------------------------------------------------
# Schema, snapshot and whoami
# ---------------------------------------------------------------------------


def test_migration_0040_extends_the_app_graph():
    loader = MigrationLoader(connection)
    target = ("django_etebase", "0040_login_email_change")

    assert target in loader.graph.nodes
    assert ("django_etebase", "0039_collectionmember_collectiontype_restrict") in loader.graph.forwards_plan(target)


def test_identity_snapshot_reads_user_and_login_version_in_one_query(user_factory):
    user = user_factory(username="snap@example.com", email="snap@example.com")
    UserInfo.objects.filter(owner=user).update(login_version=3)

    with CaptureQueriesContext(connection) as queries:
        snapshot = identity_snapshot(user.pk)

    selects = [q["sql"] for q in queries.captured_queries if q["sql"].lstrip().upper().startswith("SELECT")]
    assert len(selects) == 1
    assert "userinfo" in selects[0].lower()
    assert snapshot == {"id": user.pk, "username": "snap@example.com", "loginVersion": 3}


def test_whoami_returns_json_snapshot_and_requires_a_token(client, user_factory):
    user = user_factory(username="who@example.com", email="who@example.com")

    response = client.get(f"{AUTH_PREFIX}/whoami/", headers={"Authorization": f"Token {token_for(user)}"})
    anonymous = client.get(f"{AUTH_PREFIX}/whoami/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"id": user.pk, "username": "who@example.com", "loginVersion": 0}
    assert anonymous.status_code in (401, 403)


def test_consume_endpoints_return_id_and_login_version_of_the_current_login(client, user_factory, signing_key):
    user = user_factory(username="consume@example.com", email="consume@example.com")
    rename(client, user, signing_key, "renamed@example.com")
    headers = {"Authorization": f"Token {token_for(user)}"}

    link = client.post("/api/v1/billing/link-proof/", headers=headers).json()["etebaseLinkProof"]
    linked = client.post(
        "/api/v1/billing/link-proof/consume/",
        json={"etebaseLinkProof": link},
        headers={"X-Etebase-Billing-Key": MACHINE_KEY},
    )
    status_proof = client.post("/api/v1/billing/status-proof/", headers=headers).json()["statusProof"]
    status_identity = client.post(
        "/api/v1/billing/status-proof/consume/",
        json={"statusProof": status_proof},
        headers={"X-Etebase-Billing-Key": MACHINE_KEY},
    )

    assert linked.json() == {
        "username": "renamed@example.com",
        "email": "renamed@example.com",
        "id": user.pk,
        "loginVersion": 1,
    }
    assert status_identity.json() == {"username": "renamed@example.com", "id": user.pk, "loginVersion": 1}


# ---------------------------------------------------------------------------
# Signed request
# ---------------------------------------------------------------------------


def test_request_stores_only_digests_and_returns_a_short_handoff(client, user_factory, signing_key):
    user = user_factory(username="req@example.com", email="req@example.com")
    body = signed_request_body(client, user.username, signing_key, "  New@Example.com ")

    response = post_request(client, token_for(user), body)

    assert response.status_code == 200, response.content[:300]
    payload = response.json()
    assert set(payload) == {"handoff", "expiresIn"}
    assert payload["expiresIn"] == 120
    assert 43 <= len(payload["handoff"]) <= 256
    row = LoginEmailChange.objects.get()
    assert row.status == LoginEmailChange.PENDING
    assert (row.old_username, row.new_username, row.from_version) == ("req@example.com", "new@example.com", 0)
    assert row.handoff_hash == sha256_hex(payload["handoff"])
    assert row.grant_hash is None
    assert row.login_pubkey_hash == sha256_hex(bytes(signing_key.verify_key))
    assert timezone.now() < row.expires_at <= timezone.now() + timedelta(seconds=120)


def test_request_challenge_is_single_use(client, user_factory, signing_key):
    user = user_factory(username="once@example.com", email="once@example.com")
    token = token_for(user)
    body = signed_request_body(client, user.username, signing_key, "new@example.com")

    assert post_request(client, token, body).status_code == 200
    replay = post_request(client, token, body)

    assert replay.status_code == 401
    assert replay.json() == {"code": "invalid_signature"}
    assert LoginEmailChange.objects.count() == 1


def test_request_refuses_wrong_action_wrong_key_wrong_user_and_garbage(client, user_factory, signing_key):
    user = user_factory(username="sig@example.com", email="sig@example.com")
    other = user_factory(username="other@example.com", email="other@example.com")
    token = token_for(user)
    _, other_challenge = login_challenge(client, other.username)

    attempts = [
        signed_request_body(client, user.username, signing_key, "new@example.com", action="changePassword"),
        signed_request_body(client, user.username, signing_key, "new@example.com", action="login"),
        signed_request_body(client, user.username, nacl.signing.SigningKey.generate(), "new@example.com"),
        signed_request_body(
            client, user.username, signing_key, "new@example.com", challenge=other_challenge["challenge"]
        ),
        signed_request_body(client, user.username, signing_key, "new@example.com", challenge=b"\x00" * 64),
        b"\xc1 not msgpack",
        msgpack_encode({"response": b"x"}),
    ]

    for body in attempts:
        response = post_request(client, token, body)
        assert response.status_code == 401, response.content[:300]
        assert response.json() == {"code": "invalid_signature"}
    assert LoginEmailChange.objects.count() == 0


def test_request_requires_a_session_token(client, user_factory, signing_key):
    user = user_factory(username="anon@example.com", email="anon@example.com")
    body = signed_request_body(client, user.username, signing_key, "new@example.com")

    response = client.post(f"{BILLING}/request/", content=body, headers={"Content-Type": "application/msgpack"})

    assert response.status_code in (401, 403)
    assert LoginEmailChange.objects.count() == 0


@pytest.mark.parametrize(
    "destination",
    [
        "not-an-email",
        "two@at@example.com",
        "space here@example.com",
        "slash/name@example.com",
        "user@",
        "@example.com",
        "",
        "   ",
        "a" * 140 + "@example.com",
    ],
)
def test_request_refuses_destinations_that_cannot_be_a_login_email(client, user_factory, signing_key, destination):
    user = user_factory(username="dest@example.com", email="dest@example.com")

    response = post_request(client, token_for(user), signed_request_body(client, user.username, signing_key, destination))

    assert response.status_code == 400
    assert response.json() == {"code": "invalid_destination"}
    assert LoginEmailChange.objects.count() == 0


def test_canonical_login_email_trims_nfkc_folds_and_lowercases():
    assert canonical_login_email("  Alice@Example.COM\t") == "alice@example.com"
    # Fullwidth letters fold to ASCII under NFKC.
    assert canonical_login_email("Ａlice@example.com") == "alice@example.com"
    assert canonical_login_email(None) is None
    assert canonical_login_email("a" * 139 + "@example.com") is None  # 151 characters
    assert canonical_login_email("a" * 138 + "@example.com") == "a" * 138 + "@example.com"


def test_request_refuses_the_current_login_as_destination(client, user_factory, signing_key):
    user = user_factory(username="same@example.com", email="same@example.com")

    response = post_request(
        client, token_for(user), signed_request_body(client, user.username, signing_key, "SAME@example.com")
    )

    assert response.status_code == 400
    assert response.json() == {"code": "same_destination"}


def test_request_is_limited_to_five_per_hour_per_user(client, user_factory, signing_key):
    user = user_factory(username="limit@example.com", email="limit@example.com")
    token = token_for(user)

    statuses = [
        post_request(client, token, signed_request_body(client, user.username, signing_key, f"n{i}@example.com"))
        for i in range(6)
    ]

    assert [r.status_code for r in statuses] == [200] * 5 + [429]
    assert statuses[-1].json() == {"code": "rate_limited"}
    LoginEmailChange.objects.update(created_at=timezone.now() - timedelta(hours=1, seconds=1))
    later = post_request(client, token, signed_request_body(client, user.username, signing_key, "n6@example.com"))
    assert later.status_code == 200


def test_request_does_not_reveal_whether_the_destination_is_taken(client, user_factory, signing_key):
    user = user_factory(username="probe@example.com", email="probe@example.com")
    user_factory(username="taken@example.com", email="taken@example.com")

    response = post_request(
        client, token_for(user), signed_request_body(client, user.username, signing_key, "taken@example.com")
    )

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Accept
# ---------------------------------------------------------------------------


def test_accept_binds_account_and_destination_and_issues_a_grant(client, user_factory, signing_key):
    user = user_factory(username="acc@example.com", email="acc@example.com")
    handoff = request_change(client, user, signing_key, "acc-new@example.com")

    response = accept(client, handoff, "ACC-new@example.com ", expected_id=user.pk)

    assert response.status_code == 200, response.content[:300]
    body = response.json()
    row = LoginEmailChange.objects.get()
    assert body == {
        "changeId": str(row.id),
        "grant": body["grant"],
        "id": user.pk,
        "oldUsername": "acc@example.com",
        "newUsername": "acc-new@example.com",
        "fromVersion": 0,
    }
    assert row.status == LoginEmailChange.ACCEPTED
    assert row.grant_hash == sha256_hex(body["grant"])
    assert row.handoff_hash is None
    assert row.expires_at > timezone.now() + timedelta(hours=24)
    assert accept(client, handoff, "acc-new@example.com", expected_id=user.pk).json() == {"code": "invalid_handoff"}


def test_accept_bootstrap_requires_the_signup_name_at_login_version_zero(client, user_factory, signing_key):
    user = user_factory(username="boot@example.com", email="boot@example.com")

    ok = accept(client, request_change(client, user, signing_key, "b1@example.com"), "b1@example.com", bootstrap="Boot@example.com")
    wrong_name = accept(
        client, request_change(client, user, signing_key, "b2@example.com"), "b2@example.com", bootstrap="x@example.com"
    )
    UserInfo.objects.filter(owner=user).update(login_version=1)
    LoginEmailChange.objects.filter(status=LoginEmailChange.ACCEPTED).update(status=LoginEmailChange.CANCELLED)
    handoff = request_change(client, user, signing_key, "b3@example.com")
    renamed_before = accept(client, handoff, "b3@example.com", bootstrap="boot@example.com")

    assert ok.status_code == 200
    assert ok.json()["id"] == user.pk
    assert wrong_name.status_code == 409
    assert wrong_name.json() == {"code": "identity_mismatch"}
    assert renamed_before.status_code == 409
    assert renamed_before.json() == {"code": "identity_mismatch"}


def test_accept_refuses_mismatches_and_burns_the_handoff(client, user_factory, signing_key):
    user = user_factory(username="mm@example.com", email="mm@example.com")
    other = user_factory(username="mm-other@example.com", email="mm-other@example.com")

    wrong_id_handoff = request_change(client, user, signing_key, "mm1@example.com")
    wrong_id = accept(client, wrong_id_handoff, "mm1@example.com", expected_id=other.pk)
    wrong_dest_handoff = request_change(client, user, signing_key, "mm2@example.com")
    wrong_dest = accept(client, wrong_dest_handoff, "attacker@example.com", expected_id=user.pk)

    assert (wrong_id.status_code, wrong_id.json()) == (409, {"code": "identity_mismatch"})
    assert (wrong_dest.status_code, wrong_dest.json()) == (409, {"code": "destination_mismatch"})
    assert accept(client, wrong_id_handoff, "mm1@example.com", expected_id=user.pk).status_code == 401
    assert accept(client, wrong_dest_handoff, "mm2@example.com", expected_id=user.pk).status_code == 401
    assert set(LoginEmailChange.objects.values_list("status", flat=True)) == {LoginEmailChange.CANCELLED}
    assert LoginEmailChange.objects.filter(grant_hash__isnull=False).count() == 0


def test_accept_refuses_expired_unknown_and_unkeyed_handoffs(client, user_factory, signing_key):
    user = user_factory(username="exp@example.com", email="exp@example.com")
    handoff = request_change(client, user, signing_key, "exp-new@example.com")

    unkeyed = machine_post(
        client, "accept", {"handoff": handoff, "destination": "exp-new@example.com", "expectedId": user.pk}, key=None
    )
    wrong_key = machine_post(
        client, "accept", {"handoff": handoff, "destination": "exp-new@example.com", "expectedId": user.pk}, key="bad"
    )
    both = accept(client, handoff, "exp-new@example.com", expected_id=user.pk, bootstrap="exp@example.com")
    neither = accept(client, handoff, "exp-new@example.com")
    unknown = accept(client, "u" * 43, "exp-new@example.com", expected_id=user.pk)
    LoginEmailChange.objects.update(expires_at=timezone.now() - timedelta(seconds=1))
    expired = accept(client, handoff, "exp-new@example.com", expected_id=user.pk)

    assert unkeyed.status_code == wrong_key.status_code == 401
    assert both.status_code == neither.status_code == 400
    assert unknown.json() == expired.json() == {"code": "invalid_handoff"}
    assert LoginEmailChange.objects.get().status == LoginEmailChange.PENDING


def test_accept_supersedes_nothing(client, user_factory, signing_key):
    user = user_factory(username="many@example.com", email="many@example.com")

    first = accepted_change(client, user, signing_key, "first@example.com")
    second = accepted_change(client, user, signing_key, "second@example.com")

    assert first["changeId"] != second["changeId"]
    assert LoginEmailChange.objects.filter(status=LoginEmailChange.ACCEPTED).count() == 2


# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------


def test_commit_renames_login_bumps_version_and_holds_the_old_name(client, user_factory, signing_key):
    user = user_factory(username="old@example.com", email="old@example.com")
    accepted = accepted_change(client, user, signing_key, "new@example.com")

    response = commit(client, accepted["grant"])

    assert response.status_code == 200
    assert response.json() == {
        "status": "committed",
        "changeId": accepted["changeId"],
        "id": user.pk,
        "oldUsername": "old@example.com",
        "newUsername": "new@example.com",
        "loginVersion": 1,
    }
    user.refresh_from_db()
    assert (user.username, user.email, user.first_name) == ("new@example.com",) * 3
    assert UserInfo.objects.get(owner=user).login_version == 1
    hold = HeldUsername.objects.get()
    assert (hold.name, hold.user_id) == ("old@example.com", user.pk)
    row = LoginEmailChange.objects.get()
    assert (row.status, row.committed_version) == (LoginEmailChange.COMMITTED, 1)


def test_commit_retry_returns_the_stored_result_at_any_age(client, user_factory, signing_key):
    user = user_factory(username="retry@example.com", email="retry@example.com")
    accepted = accepted_change(client, user, signing_key, "retry-new@example.com")
    first = commit(client, accepted["grant"])
    # Long after: the accepted window and a later rename change nothing for the result.
    LoginEmailChange.objects.update(
        expires_at=timezone.now() - timedelta(days=40), committed_at=timezone.now() - timedelta(days=40)
    )
    rename(client, User.objects.get(pk=user.pk), signing_key, "retry-later@example.com")

    again = commit(client, accepted["grant"])

    assert again.status_code == 200
    assert again.json() == first.json()


@pytest.mark.parametrize("winner", ["first", "second"])
def test_two_accepted_changes_first_commit_wins_and_the_other_is_stale(client, user_factory, signing_key, winner):
    user = user_factory(username="race@example.com", email="race@example.com")
    first = accepted_change(client, user, signing_key, "race-1@example.com")
    second = accepted_change(client, user, signing_key, "race-2@example.com")
    win, lose = (first, second) if winner == "first" else (second, first)

    assert commit(client, win["grant"]).status_code == 200
    assert_refused(commit(client, lose["grant"]), "stale")
    assert_refused(commit(client, lose["grant"]), "stale")
    assert User.objects.get(pk=user.pk).username == win["newUsername"]


def test_cancelled_later_change_leaves_an_earlier_accepted_change_usable(client, user_factory, signing_key):
    user = user_factory(username="keep@example.com", email="keep@example.com")
    earlier = accepted_change(client, user, signing_key, "keep-1@example.com")
    later = accepted_change(client, user, signing_key, "keep-2@example.com")

    cancelled = machine_post(client, "cancel", {"changeId": later["changeId"]})

    assert cancelled.json() == {"status": "cancelled"}
    assert_refused(commit(client, later["grant"]), "cancelled")
    assert commit(client, earlier["grant"]).status_code == 200
    assert machine_post(client, "cancel", {"changeId": earlier["changeId"]}).json() == {"status": "committed"}
    assert machine_post(client, "cancel", {"changeId": "00000000-0000-0000-0000-000000000000"}).status_code == 404


def test_commit_refuses_expired_changed_credentials_and_unknown_grants(client, user_factory, signing_key):
    user = user_factory(username="ref@example.com", email="ref@example.com")
    expired = accepted_change(client, user, signing_key, "ref-1@example.com")
    LoginEmailChange.objects.filter(pk=expired["changeId"]).update(expires_at=timezone.now() - timedelta(seconds=1))
    credentials = accepted_change(client, user, signing_key, "ref-2@example.com")
    UserInfo.objects.filter(owner=user).update(loginPubkey=b"\x01" * 32)

    assert_refused(commit(client, expired["grant"]), "expired")
    assert_refused(commit(client, credentials["grant"]), "credentials_changed")
    assert_refused(commit(client, "g" * 43), "unknown_grant")
    assert LoginEmailChange.objects.get(pk=expired["changeId"]).refusal == "expired"
    assert User.objects.get(pk=user.pk).username == "ref@example.com"


@pytest.mark.parametrize("holder", ["username", "email", "held"])
def test_commit_refuses_a_destination_another_user_holds(client, user_factory, signing_key, holder):
    user = user_factory(username="mover@example.com", email="mover@example.com")
    if holder == "username":
        user_factory(username="dest@example.com", email="someone@example.com")
    elif holder == "email":
        user_factory(username="someone", email="Dest@example.com")
    else:
        owner = user_factory(username="someone", email="someone@example.com")
        HeldUsername.objects.create(name="dest@example.com", user=owner)
    accepted = accepted_change(client, user, signing_key, "dest@example.com")

    response = commit(client, accepted["grant"])

    assert_refused(response, "taken")
    assert_refused(commit(client, accepted["grant"]), "taken")
    assert User.objects.get(pk=user.pk).username == "mover@example.com"
    assert UserInfo.objects.get(owner=user).login_version == 0


def test_commit_refuses_a_name_held_by_another_user_at_any_age(client, user_factory, signing_key):
    first = user_factory(username="ancient@example.com", email="ancient@example.com")
    rename(client, first, signing_key, "first-new@example.com")
    call_command("cleanup_billing_link_proofs", stdout=StringIO())
    second = user_factory(username="taker@example.com", email="taker@example.com")

    response = commit(client, accepted_change(client, second, signing_key, "ancient@example.com")["grant"])

    assert_refused(response, "taken")
    assert HeldUsername.objects.get(name="ancient@example.com").user_id == first.pk


def test_commit_may_take_a_name_after_an_operator_released_it(client, user_factory, signing_key):
    first = user_factory(username="freed@example.com", email="freed@example.com")
    rename(client, first, signing_key, "first-new@example.com")
    call_command("release_held_username", "freed@example.com", "--confirm-old-devices-retired", stdout=StringIO())
    second = user_factory(username="taker@example.com", email="taker@example.com")

    result = rename(client, second, signing_key, "freed@example.com")

    assert result["newUsername"] == "freed@example.com"

def test_commit_never_answers_anything_but_committed_or_a_terminal_refusal(client, user_factory, signing_key):
    user = user_factory(username="term@example.com", email="term@example.com")
    pending_handoff = request_change(client, user, signing_key, "term-p@example.com")
    accepted = accepted_change(client, user, signing_key, "term-a@example.com")

    responses = [commit(client, accepted["grant"]), commit(client, accepted["grant"]), commit(client, pending_handoff)]

    for response in responses:
        assert response.status_code in (200, 409)
        body = response.json()
        if response.status_code == 200:
            assert body["status"] == "committed"
        else:
            assert body["code"] == "refused"


def test_change_password_supersedes_open_login_changes(client, user_factory, signing_key):
    user = user_factory(username="pw@example.com", email="pw@example.com")
    pending_handoff = request_change(client, user, signing_key, "pw-1@example.com")
    accepted = accepted_change(client, user, signing_key, "pw-2@example.com")
    token = token_for(user)
    _, challenge = login_challenge(client, user.username)
    body = build_signed_response(
        username=user.username,
        challenge_bytes=challenge["challenge"],
        signing_key=signing_key,
        action="changePassword",
        extra={"loginPubkey": bytes(signing_key.verify_key), "encryptedContent": b"\x02" * 64},
    )

    changed = msgpack_post(client, f"{AUTH_PREFIX}/change_password/", body, headers={"Authorization": f"Token {token}"})

    assert changed.status_code == 204
    assert set(LoginEmailChange.objects.values_list("status", flat=True)) == {LoginEmailChange.SUPERSEDED}
    assert_refused(commit(client, accepted["grant"]), "superseded")
    assert accept(client, pending_handoff, "pw-1@example.com", expected_id=user.pk).status_code == 401


def test_ack_marks_committed_changes_and_answers_ok_for_unknown_ids(client, user_factory, signing_key):
    user = user_factory(username="ack@example.com", email="ack@example.com")
    accepted = accepted_change(client, user, signing_key, "ack-new@example.com")
    commit(client, accepted["grant"])

    acked = machine_post(client, "ack", {"changeId": accepted["changeId"]})
    unknown = machine_post(client, "ack", {"changeId": "00000000-0000-0000-0000-000000000000"})
    unkeyed = machine_post(client, "ack", {"changeId": accepted["changeId"]}, key=None)

    assert acked.json() == unknown.json() == {"status": "ok"}
    assert unkeyed.status_code == 401
    assert LoginEmailChange.objects.get().acknowledged_at is not None


# ---------------------------------------------------------------------------
# Name holds and lookups
# ---------------------------------------------------------------------------


def test_held_name_is_not_found_by_login_or_invitation_lookup(client, user_factory, signing_key):
    user = user_factory(username="held@example.com", email="held@example.com")
    inviter = user_factory(username="inviter@example.com", email="inviter@example.com")
    rename(client, user, signing_key, "moved@example.com")
    inviter_headers = {"Authorization": f"Token {token_for(inviter)}", "Accept": "application/msgpack"}

    old_challenge, _ = login_challenge(client, "held@example.com")
    new_challenge, _ = login_challenge(client, "moved@example.com")
    old_profile = client.get(
        "/api/v1/invitation/outgoing/fetch_user_profile/", params={"username": "held@example.com"}, headers=inviter_headers
    )
    new_profile = client.get(
        "/api/v1/invitation/outgoing/fetch_user_profile/", params={"username": "moved@example.com"}, headers=inviter_headers
    )

    assert old_challenge.status_code == 401
    assert decode_response(old_challenge)["code"] == "user_not_found"
    assert new_challenge.status_code == 200
    assert old_profile.status_code == 404
    assert new_profile.status_code == 200


def test_signup_refuses_a_held_name_as_username_or_email(client, user_factory, signing_key, login_pubkey, user_salt):
    user = user_factory(username="gone@example.com", email="gone@example.com")
    rename(client, user, signing_key, "here@example.com")

    def signup(username, email):
        body = {
            "user": {"username": username, "email": email},
            "salt": user_salt,
            "loginPubkey": login_pubkey,
            "pubkey": login_pubkey,
            "encryptedContent": b"\x00" * 64,
        }
        return msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)

    as_username = signup("Gone@example.com", "x@example.com")
    as_email = signup("someone-new", "gone@example.com")

    assert as_username.status_code == as_email.status_code == 409
    assert decode_response(as_username)["code"] == decode_response(as_email)["code"] == "user_exists"


def test_rename_back_consumes_the_hold_and_repeated_renames_reuse_hold_rows(client, user_factory, signing_key):
    user = user_factory(username="x@example.com", email="x@example.com")

    rename(client, user, signing_key, "y@example.com")
    rename(client, User.objects.get(pk=user.pk), signing_key, "z@example.com")
    assert set(HeldUsername.objects.values_list("name", flat=True)) == {"x@example.com", "y@example.com"}

    back = rename(client, User.objects.get(pk=user.pk), signing_key, "x@example.com")
    assert back["loginVersion"] == 3
    assert set(HeldUsername.objects.values_list("name", flat=True)) == {"y@example.com", "z@example.com"}

    rename(client, User.objects.get(pk=user.pk), signing_key, "y@example.com")
    assert set(HeldUsername.objects.values_list("name", flat=True)) == {"x@example.com", "z@example.com"}
    assert HeldUsername.objects.filter(user=user).count() == 2


def test_another_users_held_name_reused_after_release_replaces_the_hold_row(client, user_factory, signing_key):
    first = user_factory(username="shared@example.com", email="shared@example.com")
    rename(client, first, signing_key, "first-new@example.com")
    call_command("release_held_username", "shared@example.com", "--confirm-old-devices-retired", stdout=StringIO())
    second = user_factory(username="second@example.com", email="second@example.com")

    rename(client, second, signing_key, "shared@example.com")
    rename(client, User.objects.get(pk=second.pk), signing_key, "second-new@example.com")

    hold = HeldUsername.objects.get(name="shared@example.com")
    assert hold.user_id == second.pk


# ---------------------------------------------------------------------------
# Signup through claim_names (SQLite)
# ---------------------------------------------------------------------------


def test_sqlite_signup_succeeds_through_claim_names(client, monkeypatch, login_pubkey, encryption_pubkey, user_salt):
    from etebase_server.fastapi.routers import authentication
    from etebase_server.fastapi.utils import claim_names

    calls = []

    def recording_claim(names):
        names = list(names)
        calls.append(names)
        with CaptureQueriesContext(connection) as queries:
            claim_names(names)
        assert queries.captured_queries == []  # a no-op outside PostgreSQL

    monkeypatch.setattr(authentication, "claim_names", recording_claim)
    body = {
        "user": {"username": "fresh@example.com", "email": "fresh@example.com"},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": encryption_pubkey,
        "encryptedContent": b"\x00" * 64,
    }

    response = msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)

    assert response.status_code in (200, 201), response.content[:300]
    assert calls == [["fresh@example.com", "fresh@example.com"]]
    assert User.objects.filter(username="fresh@example.com").exists()


# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------


def _change(user, status, *, ended_days_ago=None, acknowledged=False, expires_in=timedelta(hours=1)):
    now = timezone.now()
    return LoginEmailChange.objects.create(
        user=user,
        old_username=user.username,
        new_username="n@example.com",
        from_version=0,
        login_pubkey_hash="0" * 64,
        challenge_hash=sha256_hex(f"{status}-{ended_days_ago}-{acknowledged}-{expires_in}"),
        status=status,
        expires_at=now + expires_in,
        ended_at=None if ended_days_ago is None else now - timedelta(days=ended_days_ago),
        acknowledged_at=now if acknowledged else None,
    )


def test_cleanup_expires_open_changes_prunes_after_thirty_days_and_keeps_every_hold(user_factory):
    user = user_factory(username="clean@example.com", email="clean@example.com")
    stale_pending = _change(user, LoginEmailChange.PENDING, expires_in=-timedelta(seconds=1))
    stale_accepted = _change(user, LoginEmailChange.ACCEPTED, expires_in=-timedelta(seconds=1))
    live_accepted = _change(user, LoginEmailChange.ACCEPTED)
    recent_refused = _change(user, LoginEmailChange.REFUSED, ended_days_ago=29)
    old_refused = _change(user, LoginEmailChange.REFUSED, ended_days_ago=31)
    old_cancelled = _change(user, LoginEmailChange.CANCELLED, ended_days_ago=31)
    old_unacked = _change(user, LoginEmailChange.COMMITTED, ended_days_ago=400)
    old_acked = _change(user, LoginEmailChange.COMMITTED, ended_days_ago=31, acknowledged=True)
    recent_acked = _change(user, LoginEmailChange.COMMITTED, ended_days_ago=29, acknowledged=True)
    holds = [HeldUsername.objects.create(name=f"{n}@example.com", user=user).pk for n in ("a", "b")]
    stdout = StringIO()

    call_command("cleanup_billing_link_proofs", stdout=stdout)

    remaining = set(LoginEmailChange.objects.values_list("pk", flat=True))
    assert remaining == {stale_pending.pk, stale_accepted.pk, live_accepted.pk, recent_refused.pk, old_unacked.pk, recent_acked.pk}
    assert not ({old_refused.pk, old_cancelled.pk, old_acked.pk} & remaining)
    assert LoginEmailChange.objects.get(pk=stale_pending.pk).status == LoginEmailChange.EXPIRED
    assert LoginEmailChange.objects.get(pk=stale_accepted.pk).status == LoginEmailChange.EXPIRED
    assert LoginEmailChange.objects.get(pk=live_accepted.pk).status == LoginEmailChange.ACCEPTED
    assert sorted(HeldUsername.objects.values_list("pk", flat=True)) == sorted(holds)
    assert stdout.getvalue().splitlines()[1] == "Expired 2 login email change(s), deleted 3 login email change(s)."


def test_released_name_is_found_again_and_can_be_signed_up(client, user_factory, signing_key, login_pubkey, user_salt):
    user = user_factory(username="release@example.com", email="release@example.com")
    rename(client, user, signing_key, "kept@example.com")
    body = {
        "user": {"username": "release@example.com", "email": "release@example.com"},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": login_pubkey,
        "encryptedContent": b"\x00" * 64,
    }
    call_command("cleanup_billing_link_proofs", stdout=StringIO())
    while_held = msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)
    assert while_held.status_code == 409

    with pytest.raises(CommandError):
        call_command("release_held_username", "Release@Example.com", stdout=StringIO())
    assert HeldUsername.objects.filter(name="release@example.com", user=user).exists()

    stdout = StringIO()
    call_command("release_held_username", "Release@Example.com", "--confirm-old-devices-retired", stdout=stdout)
    signup = msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)
    lookup, _ = login_challenge(client, "release@example.com")

    assert stdout.getvalue() == "Released held name release@example.com.\n"
    assert HeldUsername.objects.count() == 0
    assert lookup.status_code == 200
    assert signup.status_code in (200, 201), signup.content[:300]
    assert User.objects.get(username="release@example.com").pk != user.pk


def test_release_command_reports_a_missing_hold_and_changes_nothing(user_factory):
    user = user_factory(username="keeper@example.com", email="keeper@example.com")
    HeldUsername.objects.create(name="other-held@example.com", user=user)
    stdout = StringIO()

    call_command("release_held_username", "never-held@example.com", stdout=stdout)

    assert stdout.getvalue() == "No hold for never-held@example.com; nothing changed.\n"
    assert HeldUsername.objects.count() == 1


def test_release_command_refuses_a_current_username(user_factory):
    user = user_factory(username="current@example.com", email="current@example.com")
    # Inconsistent data an operator might meet: a hold row on a name someone currently uses.
    HeldUsername.objects.create(name="current@example.com", user=user)
    stdout = StringIO()

    with pytest.raises(CommandError):
        call_command("release_held_username", "Current@example.com", stdout=stdout)

    assert stdout.getvalue() == ""
    assert HeldUsername.objects.filter(name="current@example.com").exists()

def test_committed_change_survives_cleanup_until_acknowledged(client, user_factory, signing_key):
    user = user_factory(username="unacked@example.com", email="unacked@example.com")
    accepted = accepted_change(client, user, signing_key, "unacked-new@example.com")
    first = commit(client, accepted["grant"])
    LoginEmailChange.objects.update(ended_at=timezone.now() - timedelta(days=60))

    call_command("cleanup_billing_link_proofs", stdout=StringIO())
    retried = commit(client, accepted["grant"])
    machine_post(client, "ack", {"changeId": accepted["changeId"]})
    call_command("cleanup_billing_link_proofs", stdout=StringIO())

    assert retried.json() == first.json()
    assert not LoginEmailChange.objects.exists()
    # Billing's retry of a lost ack reply after pruning still finishes.
    assert machine_post(client, "ack", {"changeId": accepted["changeId"]}).json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# Wired flow through the whole application with an emulated client
# ---------------------------------------------------------------------------


def test_wired_rename_keeps_sessions_data_and_invitations(client, user_factory, signing_key, login_pubkey, user_salt):
    from etebase_server.fastapi.routers.test_invitation_lifecycle import _add_member, _invite, _make_collection

    signup_body = {
        "user": {"username": "wired@example.com", "email": "wired@example.com"},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": login_pubkey,
        "encryptedContent": b"\x33" * 64,
    }
    signed_up = msgpack_post(client, f"{AUTH_PREFIX}/signup/", signup_body)
    assert signed_up.status_code in (200, 201), signed_up.content[:300]
    old_token = decode_response(signed_up)["token"]
    user = User.objects.get(username="wired@example.com")
    own_collection = _make_collection(user)
    _add_member(user, own_collection)
    inviter = user_factory(username="wired-inviter@example.com", email="wired-inviter@example.com")
    shared = _make_collection(inviter)
    invitation = _invite(_add_member(inviter, shared), user)
    session = {"Authorization": f"Token {old_token}", "Accept": "application/msgpack"}

    # The web client signs with its session, Billing accepts and commits.
    handoff = post_request(client, old_token, signed_request_body(client, "wired@example.com", signing_key, "wired-new@example.com"))
    accepted = accept(client, handoff.json()["handoff"], "wired-new@example.com", bootstrap="wired@example.com")
    committed = commit(client, accepted.json()["grant"])
    assert committed.status_code == 200, committed.content[:300]

    # The pre-existing session keeps syncing and learns the new name.
    listed = client.get("/api/v1/collection/", headers=session)
    assert listed.status_code == 200
    assert own_collection.uid in [c["item"]["uid"] for c in decode_response(listed)["data"]]
    whoami = client.get(f"{AUTH_PREFIX}/whoami/", headers={"Authorization": f"Token {old_token}"})
    assert whoami.json() == {"id": user.pk, "username": "wired-new@example.com", "loginVersion": 1}

    # The new login works with the same password-derived key and returns the same encrypted account.
    new_login = perform_login(client, username="wired-new@example.com", signing_key=signing_key)
    assert new_login.status_code == 200, new_login.content[:300]
    login_user = decode_response(new_login)["user"]
    assert login_user["username"] == "wired-new@example.com"
    assert bytes(login_user["encryptedContent"]) == b"\x33" * 64
    assert bytes(login_user["pubkey"]) == login_pubkey
    assert login_challenge(client, "wired@example.com")[0].status_code == 401

    # An invitation sent before the rename is still accepted by the renamed account.
    accepted_invite = msgpack_post(
        client,
        f"/api/v1/invitation/incoming/{invitation.uid}/accept/",
        {"collectionType": b"etebase.vcard", "encryptionKey": b"accepted-key"},
        headers={"Authorization": f"Token {old_token}"},
    )
    assert accepted_invite.status_code < 300, accepted_invite.content[:300]
    assert models.CollectionMember.objects.filter(user=user, collection=shared).exists()


# ---------------------------------------------------------------------------
# Holds outlive their user
# ---------------------------------------------------------------------------


def test_deleting_the_holder_keeps_the_name_reserved_for_everyone(
    client, user_factory, signing_key, login_pubkey, user_salt
):
    holder = user_factory(username="orphan@example.com", email="orphan@example.com")
    rename(client, holder, signing_key, "holder-new@example.com")
    User.objects.get(pk=holder.pk).delete()
    mover = user_factory(username="mover@example.com", email="mover@example.com")
    body = {
        "user": {"username": "orphan@example.com", "email": "orphan@example.com"},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": login_pubkey,
        "encryptedContent": b"\x00" * 64,
    }

    signup = msgpack_post(client, f"{AUTH_PREFIX}/signup/", body)
    renamed = commit(client, accepted_change(client, mover, signing_key, "orphan@example.com")["grant"])
    lookup, _ = login_challenge(client, "orphan@example.com")

    hold = HeldUsername.objects.get(name="orphan@example.com")
    assert hold.user_id is None
    assert signup.status_code == 409
    assert_refused(renamed, "taken")
    assert lookup.status_code == 401


def test_release_of_a_deleted_holders_name_needs_no_flag(client, user_factory, signing_key):
    holder = user_factory(username="gone-holder@example.com", email="gone-holder@example.com")
    rename(client, holder, signing_key, "gone-holder-new@example.com")
    User.objects.get(pk=holder.pk).delete()
    stdout = StringIO()

    call_command("release_held_username", "gone-holder@example.com", stdout=stdout)

    assert stdout.getvalue() == "Released held name gone-holder@example.com.\n"
    assert not HeldUsername.objects.exists()
    mover = user_factory(username="mover@example.com", email="mover@example.com")
    assert rename(client, mover, signing_key, "gone-holder@example.com")["newUsername"] == "gone-holder@example.com"


def test_release_is_refused_while_the_holder_exists_unless_confirmed(client, user_factory, signing_key):
    holder = user_factory(username="live-holder@example.com", email="live-holder@example.com")
    rename(client, holder, signing_key, "live-holder-new@example.com")
    refused_out, confirmed_out = StringIO(), StringIO()

    with pytest.raises(CommandError, match="--confirm-old-devices-retired"):
        call_command("release_held_username", "live-holder@example.com", stdout=refused_out)
    assert refused_out.getvalue() == ""
    assert HeldUsername.objects.filter(name="live-holder@example.com", user=holder).exists()

    call_command("release_held_username", "live-holder@example.com", "--confirm-old-devices-retired", stdout=confirmed_out)

    assert confirmed_out.getvalue() == "Released held name live-holder@example.com.\n"
    assert not HeldUsername.objects.exists()
