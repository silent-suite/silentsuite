#!/usr/bin/env python3
"""HTTP probes against the CI run of the StartOS package's container wiring.

StartOS's proxy is simulated: requests on the TLS leg carry X-Forwarded-Proto: https
(StartOS sets it there and strips client-supplied X-Forwarded-* on both legs);
plaintext-leg requests carry none. Standard library only, with a minimal Msgpack
encoder for signup bodies. Prints check names only, never the synthetic secrets.
"""

import http.client
import json
import os
import secrets
import sys
import time

ROUTER_PORT = int(os.environ["ROUTER_PORT"])
HOST = "silentsuite.ci.test"
ORIGIN = f"https://{HOST}"
OWNER_PASSWORD = os.environ["OWNER_PASSWORD"]
SIGNING = os.environ["SIGNING"]
USERNAME = "ci_startos_user"
SIGNUP = "/api/v1/authentication/signup/"
DISCOVERY = "/api/v1/authentication/is_etebase/"
MSGPACK = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}
TLS = {"X-Forwarded-Proto": "https"}

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


def request(method, path, body=None, headers=None, tls=True):
    connection = http.client.HTTPConnection("127.0.0.1", ROUTER_PORT, timeout=30)
    merged = {"Host": HOST, **(TLS if tls else {})}
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


def wait_for_stack(deadline_seconds=300):
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        try:
            if request("GET", DISCOVERY)[0] == 200 and request("GET", "/signup")[0] == 200:
                return True
        except OSError:
            pass
        time.sleep(3)
    return False


def owner_login(password, origin=ORIGIN, tls=True):
    headers = {"Content-Type": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    body = json.dumps({"password": password, "username": USERNAME})
    return request("POST", "/api/v1/owner/login/", body, headers, tls=tls)


def signup_body():
    return msgpack({
        "user": {"username": USERNAME, "email": f"{USERNAME}@example.test"},
        "salt": secrets.token_bytes(32),
        "loginPubkey": secrets.token_bytes(32),
        "pubkey": secrets.token_bytes(32),
        "encryptedContent": secrets.token_bytes(64),
    })


def plaintext_leg_probe():
    status, headers, _ = request("GET", "/signup?x=1", tls=False)
    check("plaintext GET is redirected to the same https URL",
          status == 308 and headers.get("location") == f"https://{HOST}/signup?x=1")
    status, _, _ = request("HEAD", DISCOVERY, tls=False)
    check("plaintext HEAD is redirected", status == 308)
    status, _, _ = owner_login(OWNER_PASSWORD, tls=False)
    check("plaintext owner login is refused without reaching the server", status == 403)
    status, _, _ = request("POST", SIGNUP, signup_body(), MSGPACK, tls=False)
    check("plaintext signup is refused", status == 403)
    status, _, _ = request("POST", DISCOVERY, b"", {"X-Forwarded-Proto": "http"}, tls=False)
    check("a non-https forwarded scheme counts as plaintext", status == 403)


def full_probe():
    if not wait_for_stack():
        check("router reaches migrated server and web app", False)
        return
    check("router reaches migrated server and web app", True)
    plaintext_leg_probe()

    status, headers, _ = request("GET", "/signup")
    check("router serves the web app /signup", status == 200)
    check("TLS leg responses carry HSTS", "max-age=31536000" in headers.get("strict-transport-security", ""))
    check("self-host web does not apply hosted CSP", "content-security-policy" not in headers)
    status, _, _ = request("GET", "/admin/")
    check("Django admin is not exposed", status == 404)

    status, _, _ = owner_login(OWNER_PASSWORD, origin=None)
    check("owner login without Origin is refused", status == 403)
    status, _, _ = owner_login("0" * 48)
    check("owner login with a wrong password is refused", status == 403)
    status, _, _ = owner_login(OWNER_PASSWORD, origin="https://other.ci.test")
    check("owner login with a foreign Origin is refused", status == 403)
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
    check("a replayed grant cannot overwrite the account", status == 409)
    login_challenge_probe("first start")


def login_challenge_probe(label):
    status, _, _ = request("POST", "/api/v1/authentication/login_challenge/", msgpack({"username": USERNAME}), MSGPACK)
    check(f"{label}: login challenge exists for the created account", status == 200)


def main() -> int:
    label = {"--after-restart": "restart", "--after-restore": "restore"}.get(sys.argv[1] if len(sys.argv) > 1 else "")
    if label:
        if not wait_for_stack():
            check(f"{label}: router reaches the server and web app", False)
        else:
            check(f"{label}: router reaches the server and web app", True)
            login_challenge_probe(label)
    else:
        full_probe()
    print("NOT COVERED: real SDK crypto signup/login and encrypted CRUD (StartOS VM acceptance)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
