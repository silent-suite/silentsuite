"""Narrow Billing linkage endpoints.  Remove the legacy identity route after cutover."""
import hmac
import os
import secrets
from datetime import timedelta
from threading import Lock

from django.db import transaction
from django.utils import timezone
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import Field

from etebase_server.django.models import BillingLinkProof
from etebase_server.myauth.models import UserType

from ..db_hack import django_db_cleanup_decorator
from ..dependencies import get_authenticated_user
from ..utils import BaseModel

billing_link_router = APIRouter()
PROOF_TTL_SECONDS = 120
PROOF_ISSUE_INTERVAL_SECONDS = 1
PROOF_OPERATION_LOCK = Lock()
LOGIN_PURPOSE = "billing"
# Status proofs only let Billing read the account's informational subscription notice. They have
# their own routes and body field, so neither purpose can be issued, rate limited or consumed as
# the other, and a server without these routes answers 404 instead of a login proof.
STATUS_PURPOSE = "billing_status"


class ProofOut(BaseModel):
    etebaseLinkProof: str = Field(min_length=43, max_length=256)


class ConsumeIn(BaseModel):
    etebaseLinkProof: str = Field(min_length=43, max_length=256)


class IdentityOut(BaseModel):
    username: str
    email: str


class StatusProofOut(BaseModel):
    statusProof: str = Field(min_length=43, max_length=256)


class StatusConsumeIn(BaseModel):
    statusProof: str = Field(min_length=43, max_length=256)


class StatusIdentityOut(BaseModel):
    username: str


def forbidden() -> None:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication failed")


def require_machine_key(x_etebase_billing_key: str | None) -> None:
    configured = os.environ.get("ETEBASE_BILLING_LINK_PROOF_MACHINE_KEY")
    if not configured or not x_etebase_billing_key or not hmac.compare_digest(configured, x_etebase_billing_key):
        forbidden()


def issue_for_purpose(user: UserType, audience: str) -> str:
    proof = secrets.token_urlsafe(32)
    issued_at = timezone.now()
    # One process lock covers issuance and consumption even on databases without
    # row locking. Database predicates remain the cross-process production authority.
    with PROOF_OPERATION_LOCK:
        with transaction.atomic():
            UserType.objects.select_for_update().only("pk").get(pk=user.pk)
            prior = BillingLinkProof.objects.filter(user=user, audience=audience).order_by("-expires_at").first()
            retry_boundary = issued_at + timedelta(
                seconds=PROOF_TTL_SECONDS - PROOF_ISSUE_INTERVAL_SECONDS,
            )
            if prior and prior.expires_at > retry_boundary:
                raise HTTPException(
                    status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                    detail="Too many requests",
                    headers={"Retry-After": str(PROOF_ISSUE_INTERVAL_SECONDS)},
                )
            BillingLinkProof.objects.filter(user=user, audience=audience).delete()
            BillingLinkProof.objects.create(
                proof_hash=BillingLinkProof.digest(proof), user=user, audience=audience,
                expires_at=issued_at + timedelta(seconds=PROOF_TTL_SECONDS),
            )
    return proof


def consume_for_purpose(proof: str, audience: str) -> UserType:
    digest = BillingLinkProof.digest(proof)
    consumed_at = timezone.now()
    with PROOF_OPERATION_LOCK:
        with transaction.atomic():
            claimed = BillingLinkProof.objects.filter(
                proof_hash=digest,
                audience=audience,
                consumed_at__isnull=True,
                expires_at__gt=consumed_at,
            ).update(consumed_at=consumed_at)
            if claimed != 1:
                forbidden()
            try:
                return BillingLinkProof.objects.select_related("user").get(proof_hash=digest).user
            except BillingLinkProof.DoesNotExist:
                forbidden()


@billing_link_router.post("/link-proof/", response_model=ProofOut)
@django_db_cleanup_decorator
def issue_proof(user: UserType = Depends(get_authenticated_user)):
    return ProofOut(etebaseLinkProof=issue_for_purpose(user, LOGIN_PURPOSE))


@billing_link_router.post("/link-proof/consume/", response_model=IdentityOut)
@django_db_cleanup_decorator
def consume_proof(payload: ConsumeIn, x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    user = consume_for_purpose(payload.etebaseLinkProof, LOGIN_PURPOSE)
    return IdentityOut(username=user.username, email=user.email)


@billing_link_router.post("/status-proof/", response_model=StatusProofOut)
@django_db_cleanup_decorator
def issue_status_proof(user: UserType = Depends(get_authenticated_user)):
    return StatusProofOut(statusProof=issue_for_purpose(user, STATUS_PURPOSE))


@billing_link_router.post("/status-proof/consume/", response_model=StatusIdentityOut)
@django_db_cleanup_decorator
def consume_status_proof(payload: StatusConsumeIn, x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    user = consume_for_purpose(payload.statusProof, STATUS_PURPOSE)
    return StatusIdentityOut(username=user.username)


@billing_link_router.get("/link-proof/ready/")
def proof_ready(x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    return {"ready": True}


@billing_link_router.get("/billing-identity/", response_model=IdentityOut)
@django_db_cleanup_decorator
def legacy_identity(user: UserType = Depends(get_authenticated_user)):
    # Temporary production rollout escape hatch.  It is intentionally opt-in.
    if os.environ.get("ETEBASE_LEGACY_BEARER_IDENTITY_ROLLOUT_ENABLED") != "true":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return IdentityOut(username=user.username, email=user.email)
