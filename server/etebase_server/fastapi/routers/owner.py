"""Opt-in installation-owner login that issues a short-lived signup authorization.

Disabled unless ETEBASE_OWNER_PASSWORD is configured. The owner password is an
installation credential, separate from encrypted-account and Django admin logins.
A successful login returns only a signed, purpose-bound grant derived from the
independent ETEBASE_REGISTRATION_TOKEN material; nothing secret is returned, echoed
or logged. Admission uses only the request's own Origin and Host headers, never
forwarded identity headers.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import typing as t
from urllib.parse import urlsplit

from django.conf import settings
from django.core import signing
from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

owner_router = APIRouter()

MAX_BODY_BYTES = 4096
MIN_OWNER_PASSWORD_LENGTH = 32
MAX_OWNER_PASSWORD_LENGTH = 256
MIN_SIGNING_MATERIAL_LENGTH = 32
MAX_USERNAME_LENGTH = 254
GRANT_MAX_AGE_SECONDS = 120
GRANT_VERSION = 1
GRANT_PURPOSE = "signup"
GRANT_SALT = "etebase_server.owner.signup-grant.v1"
GRANT_KEY_CONTEXT = b"silentsuite-owner-signup-grant-key-v1"
LOOPBACK_HOSTNAMES = {"localhost", "127.0.0.1", "::1"}

NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _error(status_code: int, code: str) -> JSONResponse:
    return JSONResponse({"code": code}, status_code=status_code, headers=NO_STORE_HEADERS)


def _owner_password() -> str:
    return settings.ETEBASE_OWNER_PASSWORD


def _configuration_valid(owner_password: str, signing_material: str) -> bool:
    return (
        MIN_OWNER_PASSWORD_LENGTH <= len(owner_password) <= MAX_OWNER_PASSWORD_LENGTH
        and len(signing_material) >= MIN_SIGNING_MATERIAL_LENGTH
        and not hmac.compare_digest(owner_password.encode("utf-8"), signing_material.encode("utf-8"))
    )


def _single_header(request: Request, name: str) -> t.Optional[str]:
    values = request.headers.getlist(name)
    return values[0] if len(values) == 1 else None


def _origin_matches_host(request: Request) -> t.Optional[str]:
    """Return the received Host when exactly one Origin matches it under the admission rules."""
    origin = _single_header(request, "origin")
    host = _single_header(request, "host")
    if not origin or not host:
        return None
    try:
        parsed = urlsplit(origin)
        hostname = parsed.hostname
        _ = parsed.port  # raises ValueError for a malformed port
    except ValueError:
        return None
    if parsed.path or parsed.query or parsed.fragment or "@" in parsed.netloc or not hostname:
        return None
    if parsed.netloc != host or f"{parsed.scheme}://{parsed.netloc}" != origin:
        return None
    if parsed.scheme == "https":
        return host
    if parsed.scheme == "http" and hostname in LOOPBACK_HOSTNAMES:
        return host
    return None


async def _read_bounded_body(request: Request) -> t.Optional[bytes]:
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
        return None
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            return None
    return bytes(body)


def _reject_duplicate_keys(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _parse_credentials(body: bytes) -> t.Optional[t.Tuple[str, str]]:
    try:
        data = json.loads(body.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except ValueError:
        return None
    if not isinstance(data, dict) or set(data.keys()) != {"password", "username"}:
        return None
    password, username = data["password"], data["username"]
    if not isinstance(password, str) or not isinstance(username, str):
        return None
    if not 1 <= len(password) <= MAX_OWNER_PASSWORD_LENGTH or not 1 <= len(username) <= MAX_USERNAME_LENGTH:
        return None
    return password, username


def _digest(value: str) -> str:
    raw = hashlib.sha256(value.encode("utf-8", "surrogatepass")).digest()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def grant_signing_key(signing_material: str) -> str:
    """Purpose-specific key derived from the registration material; never SECRET_KEY."""
    return hmac.new(signing_material.encode("utf-8"), GRANT_KEY_CONTEXT, hashlib.sha256).hexdigest()


def issue_signup_grant(signing_material: str, username: str, host: str) -> str:
    payload = {
        "v": GRANT_VERSION,
        "p": GRANT_PURPOSE,
        "u": _digest(username.lower()),
        "h": _digest(host),
        "iat": int(time.time()),
        "n": secrets.token_urlsafe(16),
    }
    return signing.dumps(payload, key=grant_signing_key(signing_material), salt=GRANT_SALT, compress=False)


@owner_router.post("/login/")
async def owner_login(request: Request):
    owner_password = _owner_password()
    if not owner_password:
        return _error(status.HTTP_404_NOT_FOUND, "not_found")
    signing_material = settings.ETEBASE_REGISTRATION_TOKEN
    if not _configuration_valid(owner_password, signing_material):
        return _error(status.HTTP_503_SERVICE_UNAVAILABLE, "owner_login_unavailable")

    host = _origin_matches_host(request)
    if host is None:
        return _error(status.HTTP_403_FORBIDDEN, "owner_origin_rejected")

    body = await _read_bounded_body(request)
    if body is None:
        return _error(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "owner_login_request_too_large")
    credentials = _parse_credentials(body)
    if credentials is None:
        return _error(status.HTTP_400_BAD_REQUEST, "owner_login_invalid_request")
    password, username = credentials

    supplied = password.encode("utf-8", "surrogatepass")
    if not hmac.compare_digest(owner_password.encode("utf-8"), supplied):
        return _error(status.HTTP_403_FORBIDDEN, "owner_login_failed")

    grant = issue_signup_grant(signing_material, username, host)
    return JSONResponse(
        {"registration_token": grant, "expires_in": GRANT_MAX_AGE_SECONDS},
        headers=NO_STORE_HEADERS,
    )
