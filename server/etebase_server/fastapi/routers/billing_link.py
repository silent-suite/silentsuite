"""Narrow Billing linkage endpoints.  Remove the legacy identity route after cutover."""
import hmac
import os
import secrets
import typing as t
import uuid
from datetime import timedelta
from threading import Lock

import msgpack
from django.db import IntegrityError, OperationalError, transaction
from django.db.models import Q
from django.utils import timezone
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import Field

from etebase_server.django.models import BillingLinkProof, HeldUsername, LoginEmailChange, UserInfo, sha256_hex
from etebase_server.myauth.models import UserType, get_typed_user_model

from ..db_hack import django_db_cleanup_decorator
from ..dependencies import get_authenticated_user
from ..exceptions import CustomHttpException
from ..request_limits import BoundedBodyRoute
from ..utils import (
    BaseModel,
    canonical_login_email,
    claim_names,
    identity_of,
    identity_user,
    msgpack_decode,
    name_is_held,
    normalize_login_name,
)
from .authentication import ChangeLoginEmail, validate_login_request

User = get_typed_user_model()

billing_link_router = APIRouter(route_class=BoundedBodyRoute)
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


class ConsumedIdentityOut(IdentityOut):
    id: int
    loginVersion: int


class StatusProofOut(BaseModel):
    statusProof: str = Field(min_length=43, max_length=256)


class StatusConsumeIn(BaseModel):
    statusProof: str = Field(min_length=43, max_length=256)


class StatusIdentityOut(BaseModel):
    username: str
    id: int
    loginVersion: int


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


@billing_link_router.post("/link-proof/consume/", response_model=ConsumedIdentityOut)
@django_db_cleanup_decorator
def consume_proof(payload: ConsumeIn, x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    user = identity_user(consume_for_purpose(payload.etebaseLinkProof, LOGIN_PURPOSE).pk)
    identity = identity_of(user)
    return ConsumedIdentityOut(
        username=identity["username"], email=user.email, id=identity["id"], loginVersion=identity["loginVersion"]
    )


@billing_link_router.post("/status-proof/", response_model=StatusProofOut)
@django_db_cleanup_decorator
def issue_status_proof(user: UserType = Depends(get_authenticated_user)):
    return StatusProofOut(statusProof=issue_for_purpose(user, STATUS_PURPOSE))


@billing_link_router.post("/status-proof/consume/", response_model=StatusIdentityOut)
@django_db_cleanup_decorator
def consume_status_proof(payload: StatusConsumeIn, x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    identity = identity_of(identity_user(consume_for_purpose(payload.statusProof, STATUS_PURPOSE).pk))
    return StatusIdentityOut(
        username=identity["username"], id=identity["id"], loginVersion=identity["loginVersion"]
    )


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


# ---- Hosted login email change. The web app signs the request with the current login key;
# Billing (machine key) binds it to its account, mails the new address, and commits on
# confirmation. Only the server renames the login. Errors are JSON `{"code": ...}`.

LOGIN_EMAIL_HANDOFF_TTL_SECONDS = 120
# Billing's confirmation link lives 24 hours; the server keeps an accepted change an hour longer
# so a confirmation made just before Billing's expiry still commits.
LOGIN_EMAIL_ACCEPTED_TTL = timedelta(hours=25)
LOGIN_EMAIL_REQUESTS_PER_HOUR = 5


def login_email_error(status_code: int, code: str, **extra: t.Any) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"code": code, **extra})


def try_again() -> JSONResponse:
    # SQLite allows one writer: a transaction that read before a concurrent commit cannot write.
    return login_email_error(status.HTTP_503_SERVICE_UNAVAILABLE, "try_again")


class LoginEmailHandoffOut(BaseModel):
    handoff: str = Field(min_length=43, max_length=256)
    expiresIn: int


class LoginEmailAcceptIn(BaseModel):
    handoff: str = Field(min_length=43, max_length=256)
    destination: str = Field(max_length=512)
    expectedId: t.Optional[int] = None
    expectedBootstrapUsername: t.Optional[str] = Field(default=None, max_length=512)


class LoginEmailAcceptOut(BaseModel):
    changeId: str
    grant: str
    id: int
    oldUsername: str
    newUsername: str
    fromVersion: int


class LoginEmailChangeIdIn(BaseModel):
    changeId: uuid.UUID


class LoginEmailCommitIn(BaseModel):
    grant: str = Field(min_length=43, max_length=256)


async def raw_request_body(request: Request) -> bytes:
    return await request.body()


def lock_user_info(user_id: int) -> UserInfo:
    """The per-user row lock shared with login and change_password."""
    return UserInfo.objects.select_for_update().get(owner_id=user_id)


@billing_link_router.post("/login-email/request/", response_model=LoginEmailHandoffOut)
@django_db_cleanup_decorator
def login_email_request(
    request: Request,
    body: bytes = Depends(raw_request_body),
    user: UserType = Depends(get_authenticated_user),
):
    """Start a login change from a msgpack `{response, signature}` signed like change_password."""
    invalid_signature = login_email_error(status.HTTP_401_UNAUTHORIZED, "invalid_signature")
    try:
        outer = msgpack_decode(body)
        data = ChangeLoginEmail(response=outer["response"], signature=outer["signature"])
        response_data = data.response_data
    except (msgpack.UnpackException, ValueError, TypeError, KeyError, CustomHttpException):
        return invalid_signature
    host = request.headers.get("Host") or ""
    challenge_hash = sha256_hex(response_data.challenge)
    now = timezone.now()
    handoff = secrets.token_urlsafe(32)
    try:
        with transaction.atomic():
            user.userinfo = lock_user_info(user.pk)
            user.refresh_from_db(fields=["username"])
            try:
                validate_login_request(response_data, data, user, "changeLoginEmail", host)
            except CustomHttpException:
                return invalid_signature
            if LoginEmailChange.objects.filter(challenge_hash=challenge_hash).exists():
                return invalid_signature
            destination = canonical_login_email(response_data.newUsername)
            if destination is None:
                return login_email_error(status.HTTP_400_BAD_REQUEST, "invalid_destination")
            if destination == user.username:
                return login_email_error(status.HTTP_400_BAD_REQUEST, "same_destination")
            recent = LoginEmailChange.objects.filter(user=user, created_at__gt=now - timedelta(hours=1)).count()
            if recent >= LOGIN_EMAIL_REQUESTS_PER_HOUR:
                return login_email_error(status.HTTP_429_TOO_MANY_REQUESTS, "rate_limited")
            LoginEmailChange.objects.create(
                user=user,
                old_username=user.username,
                new_username=destination,
                from_version=user.userinfo.login_version,
                login_pubkey_hash=sha256_hex(bytes(user.userinfo.loginPubkey)),
                challenge_hash=challenge_hash,
                handoff_hash=sha256_hex(handoff),
                created_at=now,
                expires_at=now + timedelta(seconds=LOGIN_EMAIL_HANDOFF_TTL_SECONDS),
            )
    except IntegrityError:
        # The same challenge used by a concurrent request.
        return invalid_signature
    except OperationalError:
        return try_again()
    return LoginEmailHandoffOut(handoff=handoff, expiresIn=LOGIN_EMAIL_HANDOFF_TTL_SECONDS)


def end_change(row: LoginEmailChange, status_value: str, reason: str = "") -> None:
    row.status = status_value
    row.refusal = reason
    row.ended_at = timezone.now()
    row.save(update_fields=["status", "refusal", "ended_at", "handoff_hash"])


@billing_link_router.post("/login-email/accept/", response_model=LoginEmailAcceptOut)
@django_db_cleanup_decorator
def login_email_accept(payload: LoginEmailAcceptIn, x_etebase_billing_key: str | None = Header(default=None)):
    """Consume a handoff and bind it to Billing's account and destination; issues the commit grant."""
    require_machine_key(x_etebase_billing_key)
    if (payload.expectedId is None) == (payload.expectedBootstrapUsername is None):
        return login_email_error(status.HTTP_400_BAD_REQUEST, "invalid_request")
    invalid_handoff = login_email_error(status.HTTP_401_UNAUTHORIZED, "invalid_handoff")
    digest = sha256_hex(payload.handoff)
    grant = secrets.token_urlsafe(32)
    try:
        with transaction.atomic():
            found = LoginEmailChange.objects.filter(handoff_hash=digest).only("pk", "user").first()
            if found is None:
                return invalid_handoff
            info = lock_user_info(found.user_id)
            row = LoginEmailChange.objects.select_for_update().get(pk=found.pk)
            now = timezone.now()
            if row.status != LoginEmailChange.PENDING or row.handoff_hash != digest or row.expires_at <= now:
                return invalid_handoff
            row.handoff_hash = None  # single use, whatever the outcome below
            user = User.objects.get(pk=row.user_id)
            if canonical_login_email(payload.destination) != row.new_username:
                end_change(row, LoginEmailChange.CANCELLED, "destination_mismatch")
                return login_email_error(status.HTTP_409_CONFLICT, "destination_mismatch")
            if payload.expectedId is not None:
                same_account = user.pk == payload.expectedId
            else:
                bootstrap = normalize_login_name(payload.expectedBootstrapUsername or "")
                same_account = user.username == bootstrap and info.login_version == 0
            # The handoff must also still describe the account's current login.
            current = info.login_version == row.from_version and user.username == row.old_username
            if not (same_account and current):
                end_change(row, LoginEmailChange.CANCELLED, "identity_mismatch")
                return login_email_error(status.HTTP_409_CONFLICT, "identity_mismatch")
            row.status = LoginEmailChange.ACCEPTED
            row.grant_hash = sha256_hex(grant)
            row.expires_at = now + LOGIN_EMAIL_ACCEPTED_TTL
            row.save(update_fields=["status", "grant_hash", "expires_at", "handoff_hash"])
    except OperationalError:
        return try_again()
    return LoginEmailAcceptOut(
        changeId=str(row.id),
        grant=grant,
        id=row.user_id,
        oldUsername=row.old_username,
        newUsername=row.new_username,
        fromVersion=row.from_version,
    )


@billing_link_router.post("/login-email/cancel/")
@django_db_cleanup_decorator
def login_email_cancel(payload: LoginEmailChangeIdIn, x_etebase_billing_key: str | None = Header(default=None)):
    require_machine_key(x_etebase_billing_key)
    try:
        with transaction.atomic():
            found = LoginEmailChange.objects.filter(pk=payload.changeId).only("pk", "user").first()
            if found is None:
                return login_email_error(status.HTTP_404_NOT_FOUND, "unknown_change")
            lock_user_info(found.user_id)
            row = LoginEmailChange.objects.select_for_update().get(pk=found.pk)
            if row.status in LoginEmailChange.OPEN_STATUSES:
                end_change(row, LoginEmailChange.CANCELLED)
    except OperationalError:
        return try_again()
    return {"status": row.status}


def destination_taken(name: str, user: UserType) -> bool:
    """Another user's username or email (case-insensitive), or another user's hold."""
    others = User.objects.exclude(pk=user.pk)
    if others.filter(Q(username__iexact=name) | Q(email__iexact=name)).exists():
        return True
    return name_is_held(name, exclude_user=user)


def committed_result(row: LoginEmailChange) -> dict:
    return {
        "status": LoginEmailChange.COMMITTED,
        "changeId": str(row.id),
        "id": row.user_id,
        "oldUsername": row.old_username,
        "newUsername": row.new_username,
        "loginVersion": row.committed_version,
    }


def refuse(row: t.Optional[LoginEmailChange], reason: str) -> JSONResponse:
    if row is not None and row.status in LoginEmailChange.OPEN_STATUSES:
        end_change(row, LoginEmailChange.REFUSED, reason)
    return login_email_error(status.HTTP_409_CONFLICT, "refused", reason=reason)


@billing_link_router.post("/login-email/commit/")
@django_db_cleanup_decorator
def login_email_commit(payload: LoginEmailCommitIn, x_etebase_billing_key: str | None = Header(default=None)):
    """Rename the login, or refuse for good. Retrying a committed change returns its stored result."""
    require_machine_key(x_etebase_billing_key)
    digest = sha256_hex(payload.grant)
    try:
        with transaction.atomic():
            found = LoginEmailChange.objects.filter(grant_hash=digest).only("pk", "user").first()
            if found is None:
                return refuse(None, "unknown_grant")
            info = lock_user_info(found.user_id)
            row = LoginEmailChange.objects.select_for_update().get(pk=found.pk)
            claim_names([row.new_username, row.old_username])
            if row.status == LoginEmailChange.COMMITTED:
                return committed_result(row)
            if row.status != LoginEmailChange.ACCEPTED:
                return refuse(None, row.refusal if row.status == LoginEmailChange.REFUSED else row.status)
            user = User.objects.get(pk=row.user_id)
            now = timezone.now()
            if row.expires_at <= now:
                return refuse(row, "expired")
            if info.login_version != row.from_version or user.username != row.old_username:
                return refuse(row, "stale")
            if sha256_hex(bytes(info.loginPubkey)) != row.login_pubkey_hash:
                return refuse(row, "credentials_changed")
            if destination_taken(row.new_username, user):
                return refuse(row, "taken")
            try:
                with transaction.atomic():
                    user.username = row.new_username
                    user.email = row.new_username
                    user.first_name = row.new_username
                    user.save(update_fields=["username", "email", "first_name"])
            except IntegrityError:
                return refuse(row, "taken")
            info.login_version = row.from_version + 1
            info.save(update_fields=["login_version"])
            # Returning to a name you hold ends that hold; the name you leave is held for you for good.
            HeldUsername.objects.filter(name=row.new_username, user=user).delete()
            HeldUsername.objects.update_or_create(name=row.old_username, defaults={"user": user})
            row.status = LoginEmailChange.COMMITTED
            row.committed_version = info.login_version
            row.committed_at = now
            row.ended_at = now
            row.save(update_fields=["status", "committed_version", "committed_at", "ended_at"])
            return committed_result(row)
    except OperationalError:
        return try_again()


@billing_link_router.post("/login-email/ack/")
@django_db_cleanup_decorator
def login_email_ack(payload: LoginEmailChangeIdIn, x_etebase_billing_key: str | None = Header(default=None)):
    """Billing has recorded the committed result; retention may now delete the row. Unknown ids are ok."""
    require_machine_key(x_etebase_billing_key)
    LoginEmailChange.objects.filter(
        pk=payload.changeId, status=LoginEmailChange.COMMITTED, acknowledged_at__isnull=True
    ).update(acknowledged_at=timezone.now())
    return {"status": "ok"}
