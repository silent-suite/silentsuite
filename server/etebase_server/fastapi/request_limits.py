"""Per-route request body limits.

The limit covers the bytes the server accepts for one request body. A declared
Content-Length above the limit is refused before anything is read; otherwise
the received bytes are counted as they arrive, whatever Content-Length said,
and the request is refused as soon as the count passes the limit, before the
crossing fragment reaches the caller. It does not bound process memory.
"""

import re
import typing as t

from django.conf import settings
from fastapi import HTTPException
from fastapi.routing import APIRoute
from starlette.requests import Request
from starlette.types import Message

from .exceptions import CustomHttpException

AUTH_LIMIT_SETTING = "ETEBASE_MAX_AUTH_REQUEST_BYTES"
DEFAULT_LIMIT_SETTING = "ETEBASE_MAX_REQUEST_BYTES"

# Status codes are literal: the 413 constant name differs across Starlette versions.
PAYLOAD_TOO_LARGE = 413
BAD_REQUEST = 400

_CONTENT_LENGTH = re.compile(r"[0-9]{1,19}")

ErrorFactory = t.Callable[[int], HTTPException]


def msgpack_too_large(limit: int) -> HTTPException:
    return CustomHttpException(
        code="request_too_large", detail=f"Request body exceeds {limit} bytes.", status_code=PAYLOAD_TOO_LARGE
    )


def msgpack_invalid_length(limit: int) -> HTTPException:
    return CustomHttpException(
        code="invalid_content_length", detail="Invalid Content-Length header.", status_code=BAD_REQUEST
    )


def json_too_large(limit: int) -> HTTPException:
    return HTTPException(status_code=PAYLOAD_TOO_LARGE, detail="Request body too large")


def json_invalid_length(limit: int) -> HTTPException:
    return HTTPException(status_code=BAD_REQUEST, detail="Invalid Content-Length header")


def bounded_request(
    request: Request, limit: int, too_large: ErrorFactory, invalid_length: ErrorFactory
) -> Request:
    """Return a request whose body can never deliver more than `limit` bytes."""
    declared = request.headers.getlist("content-length")
    if len(declared) > 1 or (declared and _CONTENT_LENGTH.fullmatch(declared[0]) is None):
        raise invalid_length(limit)
    if declared and int(declared[0]) > limit:
        raise too_large(limit)

    receive = request.receive
    received = 0

    async def bounded_receive() -> Message:
        nonlocal received
        message = await receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > limit:
                raise too_large(limit)
        return message

    return Request(request.scope, bounded_receive)


class BoundedBodyRoute(APIRoute):
    """An APIRoute with the authentication-tier body limit and FastAPI's JSON error responses."""

    limit_setting = AUTH_LIMIT_SETTING

    def get_route_handler(self) -> t.Callable:
        handler = super().get_route_handler()

        async def bounded_handler(request: Request):
            limit = getattr(settings, self.limit_setting)
            return await handler(bounded_request(request, limit, json_too_large, json_invalid_length))

        return bounded_handler
