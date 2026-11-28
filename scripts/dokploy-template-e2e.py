#!/usr/bin/env python3
"""CI-only end-to-end check of the SilentSuite blueprint on a real, throwaway Dokploy install.

Drives Dokploy's own API the way a user does in the UI: first owner sign-up, project, compose
service, Advanced > Import of the blueprint, domain switched to HTTPS with a certificate from a
CA generated in the job, deploy. Then probes SilentSuite through Dokploy's Traefik over verified
TLS, and checks that plain HTTP only redirects. Standard library only; never prints secrets.

  dokploy-template-e2e.py deploy  --payload FILE --cert FILE --key FILE --state FILE
  dokploy-template-e2e.py probe   --state FILE --ca FILE
"""

from __future__ import annotations

import argparse
import http.client
import http.cookiejar
import json
import os
import secrets
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DOKPLOY = "http://127.0.0.1:3000"
HOST = "silentsuite.ci.test"
ORIGIN = f"https://{HOST}"
APP_NAME = "silentsuite-ci"
USERNAME = "ci_dokploy_user"
SIGNUP = "/api/v1/authentication/signup/"
MSGPACK = {"Content-Type": "application/msgpack", "Accept": "application/msgpack"}
failures: list[str] = []


def check(name, condition):
    print(f"{'PASS' if condition else 'FAIL'} {name}")
    if not condition:
        failures.append(name)


class Dokploy:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _send(self, request):
        try:
            with self.opener.open(request, timeout=60) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def post(self, path, body, headers=None):
        request = urllib.request.Request(
            DOKPLOY + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        return self._send(request)

    def mutation(self, procedure, value):
        status, body = self.post(f"/api/trpc/{procedure}", {"json": value})
        return self._result(procedure, status, body)

    def query(self, procedure, value):
        query = urllib.parse.urlencode({"input": json.dumps({"json": value})})
        status, body = self._send(urllib.request.Request(f"{DOKPLOY}/api/trpc/{procedure}?{query}"))
        return self._result(procedure, status, body)

    @staticmethod
    def _result(procedure, status, body):
        if status != 200:
            # tRPC error bodies carry Dokploy's message, never our secrets.
            raise RuntimeError(f"{procedure} failed with HTTP {status}: {body[:400]!r}")
        return json.loads(body)["result"]["data"]["json"]


def wait_for_dokploy(deadline_seconds=600):
    deadline = time.time() + deadline_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(DOKPLOY + "/api/health", timeout=10) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(5)
    raise RuntimeError("Dokploy did not become healthy")


def environment_id(api, project):
    environment = project.get("environment") if isinstance(project, dict) else None
    if isinstance(environment, dict) and environment.get("environmentId"):
        return environment["environmentId"]
    for item in api.query("project.all", None):
        if item.get("projectId") == project.get("projectId"):
            return item["environments"][0]["environmentId"]
    raise RuntimeError("created project has no environment")


def deploy(args):
    wait_for_dokploy()
    api = Dokploy()
    owner_password = secrets.token_urlsafe(24)
    status, _ = api.post("/api/auth/sign-up/email", {
        "email": "ci-owner@example.test", "password": owner_password, "name": "CI", "lastName": "Owner",
    })
    check("first Dokploy owner signs up", status == 200)
    if status != 200:
        return
    project = api.mutation("project.create", {"name": "silentsuite-ci", "description": "", "env": ""})
    compose = api.mutation("compose.create", {
        "name": "silentsuite", "environmentId": environment_id(api, project),
        "composeType": "docker-compose", "appName": APP_NAME,
    })
    compose_id = compose["composeId"]
    payload = open(args.payload, encoding="ascii").read().strip()
    api.mutation("compose.import", {"composeId": compose_id, "base64": payload})
    check("blueprint imports through Advanced > Import", True)

    domains = api.query("domain.byComposeId", {"composeId": compose_id})
    check("import creates exactly one domain, for the router", [d["serviceName"] for d in domains] == ["silentsuite"])
    domain = domains[0]
    check("imported domain starts as HTTP-only (documented first step: switch to HTTPS)",
          domain["https"] is False and domain["certificateType"] == "none")
    status, body = api._send(urllib.request.Request(DOKPLOY + "/api/auth/get-session"))
    organization = (json.loads(body).get("session") or {}).get("activeOrganizationId") if status == 200 else None
    if not organization:
        # The auto-sign-in session from the first sign-up predates the owner's membership.
        organizations = api.query("organization.all", None)
        organization = organizations[0]["id"] if organizations else None
    check("Dokploy session has an active organization", bool(organization))
    api.mutation("certificates.create", {
        "name": "silentsuite-ci",
        "organizationId": organization,
        "certificateData": open(args.cert, encoding="ascii").read(),
        "privateKey": open(args.key, encoding="ascii").read(),
        "autoRenew": False,
    })
    api.mutation("domain.update", {
        "domainId": domain["domainId"], "host": HOST, "path": "/", "port": 8080, "https": True,
        "certificateType": "none", "serviceName": "silentsuite", "domainType": "compose",
    })
    api.mutation("compose.deploy", {"composeId": compose_id})
    deadline = time.time() + 1200
    state = None
    while time.time() < deadline:
        state = api.query("compose.one", {"composeId": compose_id})
        if state.get("composeStatus") in ("done", "error"):
            break
        time.sleep(10)
    check("Dokploy deployment finishes", bool(state) and state.get("composeStatus") == "done")
    env = dict(line.split("=", 1) for line in (state or {}).get("env", "").splitlines() if "=" in line)
    descriptor = os.open(args.state, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({
            "appName": state["appName"],
            "installation": env.get("SILENTSUITE_INSTALLATION_PASSWORD", ""),
            "signing": env.get("SILENTSUITE_REGISTRATION_SIGNING", ""),
        }, handle)


def msgpack(value) -> bytes:
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return (bytes([0xA0 | len(raw)]) if len(raw) < 32 else b"\xd9" + bytes([len(raw)])) + raw
    if isinstance(value, bytes):
        return b"\xc4" + bytes([len(value)]) + value
    if isinstance(value, dict):
        out = bytes([0x80 | len(value)])
        for key, item in value.items():
            out += msgpack(key) + msgpack(item)
        return out
    raise TypeError(type(value))


def signup_body():
    return msgpack({
        "user": {"username": USERNAME, "email": f"{USERNAME}@example.test"},
        "salt": secrets.token_bytes(32), "loginPubkey": secrets.token_bytes(32),
        "pubkey": secrets.token_bytes(32), "encryptedContent": secrets.token_bytes(64),
    })


class LocalTraefik(http.client.HTTPSConnection):
    """Connect to the local Traefik but verify the certificate for the public name."""

    def connect(self):
        raw = socket.create_connection(("127.0.0.1", 443), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=HOST)


def tls_request(context, method, path, body=None, headers=None):
    connection = LocalTraefik(HOST, 443, timeout=30, context=context)
    try:
        connection.request(method, path, body=body, headers={"Host": HOST, **(headers or {})})
        response = connection.getresponse()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()
    finally:
        connection.close()


def probe(args):
    state = json.load(open(args.state, encoding="utf-8"))
    context = ssl.create_default_context(cafile=args.ca)
    deadline = time.time() + 300
    status = None
    last = "no attempt"
    while time.time() < deadline:
        try:
            status, _, _ = tls_request(context, "GET", "/api/v1/authentication/is_etebase/")
            last = f"HTTP {status}"
            if status == 200:
                break
        except (OSError, ssl.SSLError, http.client.HTTPException) as error:
            last = f"{type(error).__name__}: {str(error)[:160]}"
        time.sleep(5)
    check(f"Traefik serves SilentSuite over CA-verified TLS (is_etebase; last: {last})", status == 200)
    if status != 200:
        return
    status, _, _ = tls_request(context, "GET", "/signup")
    check("web app /signup over TLS", status == 200)

    def owner(password, origin=ORIGIN):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        return tls_request(context, "POST", "/api/v1/owner/login/",
                           json.dumps({"password": password, "username": USERNAME}), headers)

    check("owner login with a wrong password is refused", owner("0" * 64)[0] == 403)
    check("owner login with a foreign Origin is refused", owner(state["installation"], "https://other.ci.test")[0] == 403)
    status, headers, body = owner(state["installation"])
    grant = ""
    if status == 200:
        try:
            grant = json.loads(body).get("registration_token", "")
        except (ValueError, AttributeError):
            grant = ""
    check("owner login with the Dokploy-generated installation password issues a grant", bool(grant))
    check("owner login response is no-store", "no-store" in headers.get("cache-control", ""))
    status, _, _ = tls_request(context, "POST", SIGNUP, signup_body(), MSGPACK)
    check("signup without a grant is refused", status == 403)
    status, _, _ = tls_request(context, "POST", SIGNUP, signup_body(), {**MSGPACK, "X-SilentSuite-Registration-Token": state["signing"]})
    check("signup with the raw signing material is refused", status == 403)
    if grant:
        status, _, _ = tls_request(context, "POST", SIGNUP, signup_body(), {**MSGPACK, "X-SilentSuite-Registration-Token": grant})
        check("signup with the owner grant creates the account", status in (200, 201))
    status, _, _ = tls_request(context, "POST", "/api/v1/authentication/login_challenge/", msgpack({"username": USERNAME}), MSGPACK)
    check("login challenge for the new account over TLS", status == 200)

    for method, path in (("GET", "/"), ("GET", "/api/v1/authentication/is_etebase/"), ("POST", "/api/v1/owner/login/")):
        connection = http.client.HTTPConnection("127.0.0.1", 80, timeout=30)
        connection.request(method, path, body=b"{}" if method == "POST" else None,
                           headers={"Host": HOST, "Content-Type": "application/json"})
        response = connection.getresponse()
        response.read()
        location = response.getheader("Location", "")
        connection.close()
        check(f"plain HTTP {method} {path} only redirects to https",
              response.status in (301, 302, 307, 308) and location.startswith(f"https://{HOST}"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    deploying = commands.add_parser("deploy")
    for name in ("--payload", "--cert", "--key", "--state"):
        deploying.add_argument(name, required=True)
    probing = commands.add_parser("probe")
    probing.add_argument("--state", required=True)
    probing.add_argument("--ca", required=True)
    args = parser.parse_args()
    try:
        deploy(args) if args.command == "deploy" else probe(args)
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        print(f"FAIL {args.command}: {error}")
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
