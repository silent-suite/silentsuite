#!/usr/bin/env python3
"""HTTPS probes against a YunoHost install of the SilentSuite package in CI.

Standard library only. Talks to https://$DOMAIN (default domain.tld) with $CA_FILE as the only
trust anchor and never follows redirects. Prints check names with PASS/FAIL (and the WebSocket
status) only: never passwords, cookies, tokens, grants or UIDs. Exits 1 if any check fails.

  boundary --mode private|public   SSO/backend boundary for visitor, ordinary user and admin
  token --state FILE               native token auth with and without an SSO cookie, and the
                                   Redis-less subscription ticket (witness state file)
  ws-forward --port N              WebSocket handshake through nginx to the CI responder on N
  ws-server                        the same handshake to the real server: not answered by nginx

Environment: CA_FILE, DOMAIN, ADMIN_USER, ADMIN_PASS, USER_NAME, USER_PASS, OWNER_PASSWORD.
"""

import argparse
import base64
import hashlib
import http.client
import json
import os
import secrets
import socket
import ssl
import sys
import urllib.parse

DOMAIN = os.environ.get("DOMAIN", "domain.tld")
ORIGIN = f"https://{DOMAIN}"
SIGNUP = "/api/v1/authentication/signup/"
OWNER_LOGIN = "/api/v1/owner/login/"
MSGPACK = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
NGINX_STATUSES = {400, 404, 405, 413, 499, 502, 503, 504}

failures = []
_context = None


def context():
    global _context
    if _context is None:
        _context = ssl.create_default_context(cafile=os.environ["CA_FILE"])
    return _context


def check(name, condition):
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


def msgpack(value) -> bytes:
    if value is None:
        return b"\xc0"
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return (bytes([0xA0 | len(raw)]) if len(raw) < 32 else b"\xd9" + bytes([len(raw)])) + raw
    if isinstance(value, bytes):
        return b"\xc4" + bytes([len(value)]) + value
    if isinstance(value, list):
        return bytes([0x90 | len(value)]) + b"".join(msgpack(item) for item in value)
    if isinstance(value, dict):
        return bytes([0x80 | len(value)]) + b"".join(msgpack(k) + msgpack(v) for k, v in value.items())
    raise TypeError(type(value))


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, body

    def header(self, name):
        return self.headers.get(name.lower(), "")

    def sso_redirect(self, query_key):
        """SSOwat refusal (src/access.lua, 2nd case): 302 to https://<portal>/yunohost/sso with
        ?r=<back url> for anonymous requests or ?msg=access_denied for logged-in users."""
        if self.status != 302:
            return False
        location = urllib.parse.urlsplit(self.header("location"))
        query = urllib.parse.parse_qs(location.query)
        return (location.scheme, location.hostname) == ("https", DOMAIN) and \
            location.path.startswith("/yunohost/sso") and query_key in query

    def backend_code(self, code):
        """Server refusal: its own JSON or Msgpack error body carrying `code`."""
        kind = self.header("content-type")
        if kind.startswith("application/json"):
            try:
                return json.loads(self.body).get("code") == code
            except (ValueError, AttributeError):
                return False
        return kind.startswith("application/msgpack") and msgpack(code) in self.body


def request(method, path, body=None, headers=None, cookie=None):
    connection = http.client.HTTPSConnection(DOMAIN, 443, timeout=60, context=context())
    merged = dict(headers or {})
    if cookie:
        merged["Cookie"] = cookie
    connection.request(method, path, body=body, headers=merged)
    response = connection.getresponse()
    raw_headers = response.getheaders()
    result = Response(response.status, {k.lower(): v for k, v in raw_headers}, response.read())
    result.cookies = [v.split(";", 1)[0] for k, v in raw_headers if k.lower() == "set-cookie"]
    connection.close()
    return result


def portal_login(user_env, password_env, label):
    credentials = f"{os.environ[user_env]}:{os.environ[password_env]}"
    response = request("POST", "/yunohost/portalapi/login", urllib.parse.urlencode({"credentials": credentials}),
                       {"Content-Type": "application/x-www-form-urlencoded"})
    ok = response.status == 200 and b"Logged in" in response.body and bool(response.cookies)
    check(f"portal login as {label}", ok)
    return "; ".join(response.cookies) if ok else None


def owner_login(cookie, password, username):
    return request("POST", OWNER_LOGIN, json.dumps({"password": password, "username": username}),
                   {"Content-Type": "application/json", "Origin": ORIGIN}, cookie)


def signup(cookie, username, grant=None):
    body = msgpack({
        "user": {"username": username, "email": f"{username}@example.test"},
        "salt": secrets.token_bytes(32),
        "loginPubkey": secrets.token_bytes(32),
        "pubkey": secrets.token_bytes(32),
        "encryptedContent": secrets.token_bytes(64),
    })
    headers = dict(MSGPACK)
    if grant:
        headers["X-SilentSuite-Registration-Token"] = grant
    return request("POST", SIGNUP, body, headers, cookie)


def boundary(mode):
    user = portal_login("USER_NAME", "USER_PASS", "ordinary user")
    admin = portal_login("ADMIN_USER", "ADMIN_PASS", "admin")
    if not user or not admin:
        return
    username = f"ci-probe-{mode}-{secrets.token_hex(4)}"

    check("visitor reaches is_etebase", request("GET", "/api/v1/authentication/is_etebase/").status == 200)
    no_grant = "registration_token_required"
    if mode == "private":
        check("private: visitor GET / gets the SSO login redirect", request("GET", "/").sso_redirect("r"))
        check("private: visitor GET /signup gets the SSO login redirect", request("GET", "/signup").sso_redirect("r"))
        check("private: visitor signup POST gets the SSO login redirect", signup(None, username).sso_redirect("r"))
        response = signup(user, username)
        check("private: user signup without a grant reaches the server (403)",
              response.status == 403 and response.backend_code(no_grant))
        check("private: user GET /signup is 200", request("GET", "/signup", cookie=user).status == 200)
        signup_cookie = user
    else:
        response = signup(None, username)
        check("public: visitor signup without a grant reaches the server (403)",
              response.status == 403 and response.backend_code(no_grant))
        check("public: visitor GET /signup is 200", request("GET", "/signup").status == 200)
        signup_cookie = None
    check("admin GET /signup is 200", request("GET", "/signup", cookie=admin).status == 200)

    password = os.environ["OWNER_PASSWORD"]
    check("visitor owner login gets the SSO login redirect", owner_login(None, password, username).sso_redirect("r"))
    check("user owner login is refused by SSO (access_denied)",
          owner_login(user, password, username).sso_redirect("msg"))
    response = owner_login(admin, "0" * 40, username)
    check("admin owner login with a wrong password is refused by the server",
          response.status == 403 and response.backend_code("owner_login_failed"))
    response = owner_login(admin, password, username)
    grant = ""
    if response.status == 200 and response.header("content-type").startswith("application/json"):
        try:
            grant = json.loads(response.body).get("registration_token", "")
        except (ValueError, AttributeError):
            grant = ""
    check("admin owner login with the installation password returns a grant", isinstance(grant, str) and bool(grant))
    check("owner login response is no-store", "no-store" in response.header("cache-control"))
    if grant:
        check("signup with the owner grant creates the account", signup(signup_cookie, username, grant).status in (200, 201))

    check("visitor GET /admin/ gets the SSO login redirect", request("GET", "/admin/").sso_redirect("r"))
    check("user GET /admin/ is refused by SSO (access_denied)", request("GET", "/admin/", cookie=user).sso_redirect("msg"))


def token(state_file):
    with open(state_file, encoding="utf-8") as handle:
        state = json.load(handle)
    user = portal_login("USER_NAME", "USER_PASS", "ordinary user")
    auth = {**MSGPACK, "Authorization": f"Token {state['authToken']}"}
    body = msgpack({"collectionTypes": []})
    path = "/api/v1/collection/list_multi/"
    check("collection list_multi with token, no cookie", request("POST", path, body, auth).status == 200)
    if user:
        check("collection list_multi with token and user SSO cookie", request("POST", path, body, auth, user).status == 200)
    response = request("POST", path, body, {**MSGPACK, "Authorization": f"Token {secrets.token_hex(20)}"}, user)
    check("collection list_multi with an invalid token is refused by the server (401)",
          response.status == 401 and response.backend_code("authentication_failed"))
    collection = urllib.parse.quote(state["collectionUid"], safe="")
    response = request("POST", f"/api/v1/collection/{collection}/item/subscription-ticket/", b"", auth)
    check("subscription ticket without Redis is NotSupported (501 not_implemented)",
          response.status == 501 and response.backend_code("not_implemented"))


def response_complete(raw):
    """Headers of a 101 are enough; otherwise wait for Content-Length bytes (or close/timeout)."""
    head, found, body = raw.partition(b"\r\n\r\n")
    if not found:
        return False
    if head.startswith(b"HTTP/1.1 101"):
        return True
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length" and value.strip().isdigit():
            return len(body) >= int(value.strip())
    return False


def handshake():
    key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
    expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    lines = [f"GET /api/v1/ws/{secrets.token_hex(16)}/ HTTP/1.1", f"Host: {DOMAIN}", "Upgrade: websocket",
             "Connection: Upgrade", f"Sec-WebSocket-Key: {key}", "Sec-WebSocket-Version: 13", f"Origin: {ORIGIN}"]
    raw = b""
    with socket.create_connection((DOMAIN, 443), timeout=30) as plain:
        with context().wrap_socket(plain, server_hostname=DOMAIN) as tls:
            tls.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
            try:
                while len(raw) < 65536 and not response_complete(raw):
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    raw += chunk
            except (socket.timeout, ssl.SSLError):
                pass
    head, _, body = raw.partition(b"\r\n\r\n")
    head_lines = head.decode("latin-1").split("\r\n")
    parts = head_lines[0].split(" ", 2)
    status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    headers = {}
    for line in head_lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    return status, headers, body, expected


def ws_forward(port):
    status, headers, _, expected = handshake()
    check("ws-forward: nginx forwards the upgrade (101)", status == 101)
    check("ws-forward: Sec-WebSocket-Accept matches", headers.get("sec-websocket-accept") == expected)
    check("ws-forward: answered by the CI responder", headers.get("x-ci-responder") == str(port))


def ws_server():
    status, headers, body, _ = handshake()
    print(f"INFO ws-server handshake status {status}")
    from_nginx = status in NGINX_STATUSES or b"<center>nginx</center>" in body
    redirected = status == 302 and "/yunohost/sso" in headers.get("location", "")
    check("ws-server: handshake answered by the server, not nginx or SSO", status != 0 and not from_nginx and not redirected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("boundary").add_argument("--mode", choices=["private", "public"], required=True)
    commands.add_parser("token").add_argument("--state", required=True)
    commands.add_parser("ws-forward").add_argument("--port", type=int, required=True)
    commands.add_parser("ws-server")
    args = parser.parse_args()
    try:
        if args.command == "boundary":
            boundary(args.mode)
        elif args.command == "token":
            token(args.state)
        elif args.command == "ws-forward":
            ws_forward(args.port)
        else:
            ws_server()
    except (OSError, KeyError, ValueError, http.client.HTTPException) as error:
        check(f"{args.command} ran without {type(error).__name__}", False)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
