from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from io import StringIO

import pytest
from django.core.management import call_command
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.utils import timezone
from fastapi import FastAPI
from fastapi.testclient import TestClient

from etebase_server.django.models import BillingLinkProof

from .dependencies import get_authenticated_user
from .routers.billing_link import billing_link_router

pytestmark = pytest.mark.django_db(transaction=True)
MACHINE_KEY = "test-machine-key"


def test_billing_link_migration_extends_the_real_app_graph():
    loader = MigrationLoader(connection)
    target = ("django_etebase", "0038_billing_link_proof")

    assert target in loader.graph.nodes
    assert ("django_etebase", "0037_auto_20210127_1237") in loader.graph.forwards_plan(target)


def make_client(user=None):
    app = FastAPI()
    app.include_router(billing_link_router, prefix="/api/v1/billing")
    if user is not None:
        app.dependency_overrides[get_authenticated_user] = lambda: user
    return app, TestClient(app, raise_server_exceptions=False)


def issue_proof(client):
    response = client.post("/api/v1/billing/link-proof/")
    assert response.status_code == 200
    proof = response.json()["etebaseLinkProof"]
    assert len(proof) == 43
    return proof


def consume(client, proof, key=MACHINE_KEY):
    headers = {"X-Etebase-Billing-Key": key} if key is not None else {}
    return client.post(
        "/api/v1/billing/link-proof/consume/",
        json={"etebaseLinkProof": proof},
        headers=headers,
    )


def test_issue_requires_authenticated_user():
    _, client = make_client()

    response = client.post("/api/v1/billing/link-proof/")

    assert response.status_code in (401, 403)
    assert BillingLinkProof.objects.count() == 0


def test_issue_stores_only_hash_and_account_binding(user_factory):
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    proof = issue_proof(client)
    stored = BillingLinkProof.objects.get()

    assert stored.user == user
    assert stored.audience == "billing"
    assert stored.proof_hash == BillingLinkProof.digest(proof)
    assert proof not in stored.proof_hash
    assert stored.consumed_at is None
    assert stored.expires_at > timezone.now()


def test_repeated_issue_is_rate_limited_to_one_outstanding_proof_per_account(user_factory):
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    first = client.post("/api/v1/billing/link-proof/")
    repeated = [client.post("/api/v1/billing/link-proof/") for _ in range(4)]

    assert first.status_code == 200
    assert [response.status_code for response in repeated] == [429, 429, 429, 429]
    assert all(response.json() == {"detail": "Too many requests"} for response in repeated)
    assert BillingLinkProof.objects.filter(user=user, consumed_at__isnull=True).count() == 1
    stored = BillingLinkProof.objects.get(user=user)
    assert stored.proof_hash == BillingLinkProof.digest(first.json()["etebaseLinkProof"])


def test_concurrent_issue_has_exactly_one_winner_and_one_outstanding_proof(user_factory):
    user = user_factory(username="proof-user", email="proof@example.com")
    app, _ = make_client(user)

    def attempt():
        with TestClient(app, raise_server_exceptions=False) as concurrent_client:
            return concurrent_client.post("/api/v1/billing/link-proof/").status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(lambda _: attempt(), range(2)))

    assert statuses == [200, 429]
    assert BillingLinkProof.objects.filter(user=user, consumed_at__isnull=True).count() == 1


def test_consumed_reissue_is_rate_bounded_and_replaces_prior_metadata(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)
    proof = issue_proof(client)
    assert consume(client, proof).status_code == 200

    blocked = client.post("/api/v1/billing/link-proof/")
    assert blocked.status_code == 429
    assert blocked.headers["retry-after"] == "1"

    for _ in range(4):
        BillingLinkProof.objects.filter(user=user, audience="billing").update(
            expires_at=timezone.now() + timedelta(seconds=118),
        )
        replacement = client.post("/api/v1/billing/link-proof/")
        assert replacement.status_code == 200
        assert BillingLinkProof.objects.filter(user=user, audience="billing").count() == 1
        assert consume(client, replacement.json()["etebaseLinkProof"]).status_code == 200

    assert BillingLinkProof.objects.filter(user=user, audience="billing").count() == 1


def test_consume_requires_correct_machine_key_without_burning_proof(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)
    proof = issue_proof(client)

    assert consume(client, proof, key=None).status_code == 401
    assert consume(client, proof, key="wrong-machine-key").status_code == 401

    response = consume(client, proof)
    assert response.status_code == 200
    assert response.json() == {"username": "proof-user", "email": "proof@example.com"}


def test_consumption_is_one_time(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)
    proof = issue_proof(client)

    assert consume(client, proof).status_code == 200
    assert consume(client, proof).status_code == 401
    assert BillingLinkProof.objects.get().consumed_at is not None


def test_concurrent_consumers_have_exactly_one_winner(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    app, client = make_client(user)
    proof = issue_proof(client)

    def attempt():
        with TestClient(app, raise_server_exceptions=False) as concurrent_client:
            return consume(concurrent_client, proof).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = sorted(pool.map(lambda _: attempt(), range(2)))

    assert statuses == [200, 401]


def test_expired_and_wrong_audience_proofs_fail_closed(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    expired = "e" * 43
    BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest(expired),
        audience="billing",
        expires_at=timezone.now() - timedelta(seconds=1),
    )
    wrong_audience = "a" * 43
    BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest(wrong_audience),
        audience="another-service",
        expires_at=timezone.now() + timedelta(minutes=5),
    )

    assert consume(client, expired).status_code == 401
    assert consume(client, wrong_audience).status_code == 401
    assert BillingLinkProof.objects.filter(consumed_at__isnull=False).count() == 0


def test_cleanup_command_removes_consumed_and_expired_metadata_after_retention(user_factory):
    user = user_factory(username="proof-user", email="proof@example.com")
    now = timezone.now()
    stale_consumed = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("c" * 43),
        expires_at=now + timedelta(days=1),
        consumed_at=now - timedelta(minutes=6),
    )
    stale_expired = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("e" * 43),
        expires_at=now - timedelta(minutes=6),
    )

    call_command("cleanup_billing_link_proofs")

    assert not BillingLinkProof.objects.filter(pk__in=[stale_consumed.pk, stale_expired.pk]).exists()


def test_cleanup_command_preserves_metadata_within_retention_and_reports_deletions(user_factory):
    user = user_factory(username="proof-user", email="proof@example.com")
    now = timezone.now()
    recent_consumed = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("c" * 43),
        expires_at=now + timedelta(minutes=2),
        consumed_at=now - timedelta(minutes=4),
    )
    recent_expired = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("e" * 43),
        expires_at=now - timedelta(minutes=4),
    )
    active = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("a" * 43),
        expires_at=now + timedelta(minutes=2),
    )
    stale_expired = BillingLinkProof.objects.create(
        user=user,
        proof_hash=BillingLinkProof.digest("s" * 43),
        expires_at=now - timedelta(minutes=6),
    )
    stdout = StringIO()

    call_command("cleanup_billing_link_proofs", stdout=stdout)

    assert BillingLinkProof.objects.filter(pk__in=[recent_consumed.pk, recent_expired.pk, active.pk]).count() == 3
    assert not BillingLinkProof.objects.filter(pk=stale_expired.pk).exists()
    assert stdout.getvalue() == "Deleted 1 Billing link proof(s).\n"


def test_malformed_proof_is_rejected_before_database_lookup(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    response = consume(client, "too-short")

    assert response.status_code == 422
    assert BillingLinkProof.objects.count() == 0


def test_readiness_requires_machine_key(monkeypatch):
    monkeypatch.setenv("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY", MACHINE_KEY)
    _, client = make_client()

    assert client.get("/api/v1/billing/link-proof/ready/").status_code == 401
    assert client.get(
        "/api/v1/billing/link-proof/ready/",
        headers={"X-Etebase-Billing-Key": MACHINE_KEY},
    ).json() == {"ready": True}


def test_legacy_identity_is_disabled_by_default(user_factory, monkeypatch):
    monkeypatch.delenv("ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED", raising=False)
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    assert client.get("/api/v1/billing/billing-identity/").status_code == 404


def test_legacy_identity_requires_explicit_rollout_flag(user_factory, monkeypatch):
    monkeypatch.setenv("ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED", "true")
    user = user_factory(username="proof-user", email="proof@example.com")
    _, client = make_client(user)

    response = client.get("/api/v1/billing/billing-identity/")

    assert response.status_code == 200
    assert response.json() == {"username": "proof-user", "email": "proof@example.com"}
