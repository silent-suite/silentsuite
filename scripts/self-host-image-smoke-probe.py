#!/usr/bin/env python3
"""Behavioural probe for the self-host server image smoke contract.

This script runs *inside* the built server image so the assertions exercise the
image's own Python runtime, native wheels, and msgpack encoding. It talks to a
separately running server container over a user-defined Docker network, which
is how the advertised self-host controls are actually reached in production.

Modes:
  imports          native extension / interpreter architecture check (no server)
  wait             block until the server answers HTTP at all
  trusted          assertions issued from an IP listed in TRUSTED_PROXY_IPS
  untrusted        assertions issued from an IP that is *not* trusted
  honoured         a forwarded https scheme is honoured (read-only; no signups)
  admin-enabled    assertions for ETEBASE_DISABLE_DJANGO_ADMIN=false

Every mode exits non-zero with a specific message on the first failed contract.
"""

from __future__ import annotations

import argparse
import http.client
import platform
import sys
import time
from urllib.parse import urlsplit

API_PREFIX = "/api/v1/authentication"

# Native/compiled wheels that must resolve on both linux/amd64 and linux/arm64
# musllinux. A missing arm64 wheel shows up here before anything is published.
NATIVE_MODULES = (
    "psycopg2",
    "nacl.signing",
    "nacl.secret",
    "cffi",
    "msgpack",
    "pydantic_core",
    "uvloop",
    "httptools",
    "watchfiles",
    "websockets",
)

EXPECTED_MACHINE = {
    "linux/amd64": {"x86_64"},
    "linux/arm64": {"aarch64", "arm64"},
}


class ContractError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def request(base: str, method: str, path: str, *, headers=None, body=None, timeout=20):
    parts = urlsplit(base)
    if parts.scheme != "http":
        fail(f"probe base must be plain http (the proxy boundary under test), got {base!r}")
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=dict(headers or {}))
        response = connection.getresponse()
        payload = response.read()
        headers = {name.lower(): value for name, value in response.getheaders()}
        return response.status, headers, payload
    finally:
        connection.close()


def decode_msgpack(payload: bytes):
    import msgpack

    return msgpack.unpackb(payload, raw=False)


def signup_body(username: str, email: str) -> bytes:
    import msgpack

    return msgpack.packb(
        {
            "user": {"username": username, "email": email},
            "salt": b"\x01" * 32,
            "loginPubkey": b"\x02" * 32,
            "pubkey": b"\x03" * 32,
            "encryptedContent": b"\x04" * 64,
        },
        use_bin_type=True,
    )


def post_signup(base: str, username: str, email: str, token: str | None):
    path = f"{API_PREFIX}/signup/"
    if token is not None:
        path = f"{path}?bootstrap_token={token}"
    return request(
        base,
        "POST",
        path,
        headers={"Content-Type": "application/msgpack", "Accept": "application/msgpack"},
        body=signup_body(username, email),
    )


def check_imports(platform_name: str) -> None:
    machine = platform.machine()
    expected = EXPECTED_MACHINE.get(platform_name)
    if expected is None:
        fail(f"unsupported platform {platform_name!r}")
    if machine not in expected:
        fail(f"image interpreter reports machine {machine!r}, expected one of {sorted(expected)}")

    import importlib

    for name in NATIVE_MODULES:
        try:
            importlib.import_module(name)
        except Exception as error:  # noqa: BLE001 - the failure text is the evidence
            fail(f"native module {name!r} failed to import inside the image: {error!r}")

    # Django and the ASGI application must import with the shipped settings so a
    # broken native dependency cannot hide behind a lazy import.
    import os

    import django

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "etebase_server.settings")
    django.setup()
    importlib.import_module("etebase_server.fastapi.main")
    print(f"native imports OK on {machine} ({platform_name})")


def wait_for_server(base: str, attempts: int, delay: float) -> None:
    last = "no attempt made"
    for _ in range(attempts):
        try:
            status, _, _ = request(base, "GET", "/", headers={"X-Forwarded-Proto": "https"}, timeout=5)
        except OSError as error:
            last = repr(error)
        else:
            if status < 500:
                print(f"server answered with HTTP {status}")
                return
            last = f"HTTP {status}"
        time.sleep(delay)
    fail(f"server never became reachable ({last})")


def check_trusted(base: str, token: str) -> None:
    status, _, _ = request(base, "GET", "/", headers={"X-Forwarded-Proto": "https"})
    if status != 200:
        fail(f"health: expected HTTP 200 from a trusted proxy, got {status}")

    status, headers, _ = request(base, "GET", "/")
    if status != 301:
        fail(f"trusted proxy: plain http without a forwarded scheme must redirect, got {status}")
    if not headers.get("location", "").startswith("https://"):
        fail(f"trusted proxy: redirect target must be https, got {headers.get('location')!r}")

    status, _, _ = request(base, "GET", "/admin/", headers={"X-Forwarded-Proto": "https"})
    if status != 404:
        fail(f"django admin disable: expected HTTP 404 for /admin/, got {status}")

    status, _, payload = post_signup(base, "smokeadmin", "smokeadmin@example.invalid", None)
    if status != 403:
        fail(f"bootstrap token: first signup without a token must be rejected, got {status}")
    if decode_msgpack(payload).get("code") != "bootstrap_token_required":
        fail("bootstrap token: rejection must use the bootstrap_token_required code")

    status, _, payload = post_signup(base, "smokeadmin", "smokeadmin@example.invalid", "not-the-token")
    if status != 403:
        fail(f"bootstrap token: first signup with a wrong token must be rejected, got {status}")
    if decode_msgpack(payload).get("code") != "bootstrap_token_required":
        fail("bootstrap token: wrong-token rejection must use the bootstrap_token_required code")

    status, _, payload = post_signup(base, "smokeadmin", "smokeadmin@example.invalid", token)
    if status not in (200, 201):
        fail(f"bootstrap token: the correct token must allow the first account, got {status} {payload[:200]!r}")
    decoded = decode_msgpack(payload)
    if decoded.get("user", {}).get("username") != "smokeadmin":
        fail(f"bootstrap token: first account response did not describe the created user: {decoded!r}")

    status, _, payload = post_signup(base, "smokesecond", "smokesecond@example.invalid", None)
    if status not in (200, 201):
        fail(f"bootstrap token: later signups must not require the token, got {status}")

    print("trusted-proxy, health, django-admin-disable and bootstrap-token contracts OK")


def check_untrusted(base: str) -> None:
    status, headers, _ = request(base, "GET", "/", headers={"X-Forwarded-Proto": "https"})
    if status != 301:
        fail(
            "trusted proxy: a forwarded scheme from an untrusted source must be ignored "
            f"(expected the plain-http redirect, got {status})"
        )
    if not headers.get("location", "").startswith("https://"):
        fail(f"trusted proxy: redirect target must be https, got {headers.get('location')!r}")
    print("untrusted forwarded identity correctly ignored")


def check_honoured(base: str) -> None:
    status, headers, _ = request(base, "GET", "/", headers={"X-Forwarded-Proto": "https"})
    if status != 200:
        fail(
            "trusted proxy: a forwarded https scheme from a trusted source must be honoured "
            f"(expected HTTP 200, got {status} location={headers.get('location')!r})"
        )
    print("forwarded https scheme honoured")


def check_admin_enabled(base: str) -> None:
    status, _, _ = request(base, "GET", "/admin/", headers={"X-Forwarded-Proto": "https"})
    if status == 404:
        fail("django admin toggle: /admin/ is absent even with ETEBASE_DISABLE_DJANGO_ADMIN=false")
    if status not in (200, 301, 302):
        fail(f"django admin toggle: unexpected status {status} for /admin/ when enabled")
    print(f"django admin route present when enabled (HTTP {status})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("imports", "wait", "trusted", "untrusted", "honoured", "admin-enabled"))
    parser.add_argument("--base", default="", help="http://<server-container>:<port>")
    parser.add_argument("--platform", default="", help="linux/amd64 or linux/arm64")
    parser.add_argument("--token", default="", help="expected ETEBASE_BOOTSTRAP_ADMIN_TOKEN")
    parser.add_argument("--attempts", type=int, default=60)
    parser.add_argument("--delay", type=float, default=2.0)
    arguments = parser.parse_args()

    try:
        if arguments.mode == "imports":
            check_imports(arguments.platform)
        elif arguments.mode == "wait":
            wait_for_server(arguments.base, arguments.attempts, arguments.delay)
        elif arguments.mode == "trusted":
            if not arguments.token:
                fail("--token is required for the trusted mode")
            check_trusted(arguments.base, arguments.token)
        elif arguments.mode == "untrusted":
            check_untrusted(arguments.base)
        elif arguments.mode == "honoured":
            check_honoured(arguments.base)
        elif arguments.mode == "admin-enabled":
            check_admin_enabled(arguments.base)
    except ContractError as error:
        print(f"SMOKE CONTRACT FAILED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
