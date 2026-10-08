#!/usr/bin/env python3
"""HTTP probes against the CI effective stack of the Umbrel development candidate.

Uses only the standard library (with a minimal Msgpack encoder for signup bodies).
Prints check names only; never prints the synthetic CI fixture secrets.
"""

import http.client
import json
import os
import secrets
import sys
import time

ROUTER_PORT = int(os.environ["ROUTER_PORT"])
HOST = "silentsuite.ci.test:8443"
ORIGIN = f"https://{HOST}"
OWNER_PASSWORD = os.environ["APP_PASSWORD"]
SIGNING = os.environ["APP_SILENTSUITE_REGISTRATION_SIGNING"]
USERNAME = os.environ.get("PROBE_USERNAME", "ci_candidate_user")
SIGNUP = "/api/v1/authentication/signup/"
MSGPACK = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}

failures = []


def msgpack(value) -> bytes:
    if value is None:
        return b"\xc0"
    if isinstance(value, int) and 0 <= value < 128:
        return bytes([value])
    if isinstance(value, str):
        raw = value.encode("utf-8")
        if len(raw) < 32:
            return bytes([0xA0 | len(raw)]) + raw
        return b"\xd9" + bytes([len(raw)]) + raw
    if isinstance(value, bytes):
        return b"\xc4" + bytes([len(value)]) + value
    if isinstance(value, dict):
        out = bytes([0x80 | len(value)])
        for key, item in value.items():
            out += msgpack(key) + msgpack(item)
        return out
    raise TypeError(type(value))


def request(method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", ROUTER_PORT, timeout=30)
    merged = {"Host": HOST}
    merged.update(headers or {})
    connection.request(method, path, body=body, headers=merged)
    response = connection.getresponse()
    data = response.read()
    result = (response.status, {k.lower(): v for k, v in response.getheaders()}, data)
    connection.close()
    return result


def check(name, condition):
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def wait_for_stack(deadline_seconds=240):
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        try:
            status, _, _ = request("GET", "/api/v1/authentication/is_etebase/")
            if status == 200:
                return True
        except OSError:
            pass
        time.sleep(3)
    return False


def owner_login(password, origin=ORIGIN):
    headers = {"Content-Type": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    return request("POST", "/api/v1/owner/login/", json.dumps({"password": password, "username": USERNAME}), headers)


def signup_body():
    return msgpack({
        "user": {"username": USERNAME, "email": f"{USERNAME}@example.test"},
        "salt": secrets.token_bytes(32),
        "loginPubkey": secrets.token_bytes(32),
        "pubkey": secrets.token_bytes(32),
        "encryptedContent": secrets.token_bytes(64),
    })


def full_probe():
    if not wait_for_stack():
        check("router reaches migrated server (is_etebase)", False)
        return
    check("router reaches migrated server (is_etebase)", True)
    status, _, _ = request("GET", "/signup")
    check("router serves standalone web /signup", status == 200)

    status, headers, _ = owner_login(OWNER_PASSWORD, origin=None)
    check("owner login without Origin is refused", status == 403)
    status, _, _ = owner_login("0" * 64)
    check("owner login with wrong password is refused", status == 403)
    status, _, _ = owner_login(OWNER_PASSWORD, origin="https://other.ci.test:8443")
    check("owner login with foreign Origin is refused", status == 403)
    status, headers, body = owner_login(OWNER_PASSWORD)
    grant = ""
    if status == 200:
        try:
            payload = json.loads(body)
            grant = payload.get("registration_token", "") if isinstance(payload, dict) else ""
        except ValueError:
            grant = ""
    check("owner login with the installation password issues a grant", bool(grant) and len(grant) <= 512)
    check("owner login response is no-store", "no-store" in headers.get("cache-control", ""))
    if not grant:
        check("owner grant available for the signup checks", False)
        return

    status, _, _ = request("POST", SIGNUP, signup_body(), MSGPACK)
    check("signup without a grant is refused", status == 403)
    status, _, _ = request("POST", SIGNUP, signup_body(), {**MSGPACK, "X-SilentSuite-Registration-Token": SIGNING})
    check("signup with the raw signing material is refused", status == 403)
    status, _, _ = request("POST", SIGNUP, signup_body(), {**MSGPACK, "X-SilentSuite-Registration-Token": grant})
    check("signup with the owner grant creates the account", status in (200, 201))
    status, _, _ = request("POST", SIGNUP, signup_body(), {**MSGPACK, "X-SilentSuite-Registration-Token": grant})
    check("replayed grant cannot overwrite the account", status == 409)
    login_challenge_probe()


def login_challenge_probe():
    status, _, _ = request("POST", "/api/v1/authentication/login_challenge/", msgpack({"username": USERNAME}), MSGPACK)
    check("login challenge exists for the created account", status == 200)


def main() -> int:
    if "--after-restart" in sys.argv:
        if not wait_for_stack():
            check("router reaches restarted server", False)
        else:
            check("router reaches restarted server", True)
            login_challenge_probe()
    else:
        full_probe()
    print("NOT COVERED: real SDK crypto signup/login and encrypted CRUD (browser/VM acceptance)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
