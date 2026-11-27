#!/usr/bin/env python3
"""HTTPS probes against a running, rendered SilentSuite TrueNAS app (CI only).

Container modes run inside the published server image (it ships msgpack and PyNaCl),
sharing the router's network namespace, and speak TLS to the router with certificate
verification against the per-run CA:

  account      owner login rules, grant-backed signup, a real signed Etebase login,
               the owner throttle and native paths during it; saves the login key.
  after        a real signed login with the saved key (proves the account row and the
               server's SECRET_KEY survived), then logout with the new token.
  http-origin  (proxy mode) owner login from a plain-http LAN origin is refused, and
               from the proxy's https origin it is accepted.

The runner mode needs only the standard library and runs on the CI host:

  published    TLS with verification on the published host port.
  markers      sends requests carrying a synthetic marker in their paths (normal, owner,
               WebSocket upgrade, 404); with --after-stop, one upstream-failure request.

Prints check names only, never the synthetic secrets.
"""

import http.client
import json
import os
import secrets
import socket
import ssl
import sys
import time

HOST_NAME = os.environ.get("PROBE_HOST_NAME", "silentsuite.ci.test")
PUBLIC_PORT = int(os.environ["PROBE_PUBLIC_PORT"])
HOST = f"{HOST_NAME}:{PUBLIC_PORT}"
ORIGIN = f"https://{HOST}"
CA_FILE = os.environ.get("PROBE_CA_FILE", "/probe/ca.pem")
STATE_FILE = os.environ.get("PROBE_STATE_FILE", "/state/account.json")
USERNAME = "ci_truenas_user"
SIGNUP = "/api/v1/authentication/signup/"
MSGPACK_HEADERS = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}

failures = []


def check(name, condition):
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def connection(address, port, tls):
    if not tls:
        return http.client.HTTPConnection(address, port, timeout=30)
    context = ssl.create_default_context(cafile=CA_FILE)
    sock = socket.create_connection((address, port), timeout=30)
    wrapped = context.wrap_socket(sock, server_hostname=HOST_NAME)
    conn = http.client.HTTPSConnection(address, port, timeout=30, context=context)
    conn.sock = wrapped
    return conn


def request(method, path, body=None, headers=None, *, address="127.0.0.1", port=8080, tls=True, host=HOST):
    conn = connection(address, port, tls)
    merged = {"Host": host}
    merged.update(headers or {})
    conn.request(method, path, body=body, headers=merged)
    response = conn.getresponse()
    data = response.read()
    result = (response.status, {k.lower(): v for k, v in response.getheaders()}, data)
    conn.close()
    return result


def wait_ready(**kwargs):
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            if request("GET", "/api/v1/authentication/is_etebase/", **kwargs)[0] == 200:
                return True
        except (OSError, ssl.SSLError, http.client.HTTPException):
            pass
        time.sleep(3)
    return False


def owner_login(password, origin=ORIGIN, **kwargs):
    headers = {"Content-Type": "application/json"}
    if origin is not None:
        headers["Origin"] = origin
    body = json.dumps({"password": password, "username": USERNAME})
    return request("POST", "/api/v1/owner/login/", body, headers, **kwargs)


def grant_from(response):
    status, _, body = response
    if status != 200:
        return ""
    try:
        payload = json.loads(body)
    except ValueError:
        return ""
    return payload.get("registration_token", "") if isinstance(payload, dict) else ""


# ── Container modes (server image: msgpack + PyNaCl) ──────────────────


def etebase_login(signing_key):
    import msgpack

    status, _, body = request(
        "POST", "/api/v1/authentication/login_challenge/", msgpack.packb({"username": USERNAME}), MSGPACK_HEADERS
    )
    if status != 200:
        return status, None, None
    challenge = msgpack.unpackb(body)
    response = msgpack.packb(
        {"username": USERNAME, "challenge": challenge["challenge"], "host": HOST, "action": "login"}
    )
    signature = signing_key.sign(response).signature
    status, _, body = request(
        "POST", "/api/v1/authentication/login/",
        msgpack.packb({"response": response, "signature": signature}), MSGPACK_HEADERS,
    )
    token = msgpack.unpackb(body).get("token") if status == 200 else None
    return status, challenge.get("salt"), token


def logout(token):
    return request("POST", "/api/v1/authentication/logout/", b"", {"Authorization": f"Token {token}"})[0]


def account_mode():
    import msgpack
    import nacl.signing

    check("router serves the stack over verified HTTPS", wait_ready())
    check("router serves the web app", request("GET", "/signup")[0] == 200)
    check("Django admin is not routed", request("GET", "/admin/")[0] == 404)

    owner_password = os.environ["PROBE_INSTALLATION_PASSWORD"]
    grant = grant_from(owner_login(owner_password))
    check("owner login with the installation password over HTTPS issues a grant", bool(grant) and len(grant) <= 512)
    check("owner login without Origin is refused", owner_login(owner_password, origin=None)[0] == 403)
    check("owner login with a wrong password is refused", owner_login("0" * 64)[0] == 403)
    check("owner login with a foreign Origin is refused", owner_login(owner_password, origin="https://other.ci.test")[0] == 403)
    check("owner login from a plain-http origin is refused", owner_login(owner_password, origin=f"http://{HOST}")[0] == 403)

    signing_key = nacl.signing.SigningKey.generate()
    salt = secrets.token_bytes(16)
    body = msgpack.packb({
        "user": {"username": USERNAME, "email": f"{USERNAME}@example.test"},
        "salt": salt,
        "loginPubkey": bytes(signing_key.verify_key),
        "pubkey": secrets.token_bytes(32),
        "encryptedContent": secrets.token_bytes(64),
    })
    check("signup without a grant is refused", request("POST", SIGNUP, body, MSGPACK_HEADERS)[0] == 403)
    status = request("POST", SIGNUP, body, {**MSGPACK_HEADERS, "X-SilentSuite-Registration-Token": grant})[0] if grant else 0
    check("signup with the owner grant creates the account", status in (200, 201))

    status, returned_salt, token = etebase_login(signing_key)
    check("signed Etebase login succeeds", status == 200 and bool(token))
    check("login challenge returns the signup salt", returned_salt == salt)
    if token:
        check("the login token authorizes a native request (logout)", logout(token) == 204)

    with open(STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump({"seed": bytes(signing_key).hex(), "salt": salt.hex()}, handle)

    # Burst well past the owner limit; native paths must keep answering meanwhile.
    statuses = [owner_login("1" * 64)[0] for _ in range(20)]
    check("the router throttles repeated owner logins (429)", 429 in statuses)
    check("native is_etebase answers while owner logins are throttled",
          request("GET", "/api/v1/authentication/is_etebase/")[0] == 200)
    check("native login challenge answers while owner logins are throttled",
          request("POST", "/api/v1/authentication/login_challenge/", msgpack.packb({"username": USERNAME}),
                  MSGPACK_HEADERS)[0] == 200)


def after_mode():
    import nacl.signing

    check("router serves the stack again over verified HTTPS", wait_ready())
    with open(STATE_FILE, encoding="utf-8") as handle:
        state = json.load(handle)
    signing_key = nacl.signing.SigningKey(bytes.fromhex(state["seed"]))
    status, salt, token = etebase_login(signing_key)
    check("signed Etebase login still succeeds", status == 200 and bool(token))
    check("login challenge still returns the signup salt", salt == bytes.fromhex(state["salt"]))
    if token:
        check("the new token authorizes a native request (logout)", logout(token) == 204)


def http_origin_mode():
    lan = "truenas.local:%d" % PUBLIC_PORT
    proxy = "silentsuite.ci.test"
    check("plain-HTTP proxy-mode stack is up", wait_ready(tls=False, host=lan))
    owner_password = os.environ["PROBE_INSTALLATION_PASSWORD"]
    status = owner_login(owner_password, origin=f"http://{lan}", tls=False, host=lan)[0]
    check("owner login from a plain-http LAN origin is refused", status == 403)
    response = owner_login(owner_password, origin=f"https://{proxy}", tls=False, host=proxy)
    check("owner login through an https proxy origin is accepted", bool(grant_from(response)))


# ── Runner modes (standard library only) ──────────────────────────────


def published_mode():
    check("published port serves verified HTTPS for the app host name",
          wait_ready(port=PUBLIC_PORT, address="127.0.0.1"))


def status_line_only(path, headers, **kwargs):
    """Send one request and read only the status line (a 101 upgrade would never end)."""
    conn = connection(kwargs["address"], kwargs["port"], True)
    lines = [f"GET {path} HTTP/1.1", f"Host: {HOST}"] + [f"{k}: {v}" for k, v in headers.items()]
    conn.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    first = conn.sock.recv(64).split(b"\r\n", 1)[0].decode("ascii", "replace")
    conn.close()
    parts = first.split(" ")
    return int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0


def markers_mode(marker, after_stop):
    kwargs = {"port": PUBLIC_PORT, "address": "127.0.0.1"}
    if after_stop:
        status = request("GET", f"/api/v1/authentication/{marker}-failure/", **kwargs)[0]
        check("upstream failure reaches the router error path", status in (502, 504))
        return
    request("GET", f"/api/v1/authentication/{marker}-api/", **kwargs)
    request("GET", f"/{marker}-web", **kwargs)
    request("GET", f"/admin/{marker}-admin", **kwargs)
    request("POST", f"/api/v1/owner/login/?{marker}-owner", b"{}", {"Content-Type": "application/json"}, **kwargs)
    upgrade = {"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13",
               "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ=="}
    status = status_line_only(f"/api/v1/ws/{marker}-ws/", upgrade, **kwargs)
    check("WebSocket upgrade request got an answer", status in (101, 400, 401, 403, 404))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "account":
        account_mode()
    elif mode == "after":
        after_mode()
    elif mode == "http-origin":
        http_origin_mode()
    elif mode == "published":
        published_mode()
    elif mode == "markers":
        markers_mode(sys.argv[2], "--after-stop" in sys.argv)
    else:
        print("usage: truenas-candidate-probe.py account|after|http-origin|published|markers MARKER", file=sys.stderr)
        return 2
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
