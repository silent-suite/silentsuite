"""Run explicitly inside the isolated CI container, never against a remote URL."""

import errno
import http.client
import ipaddress
import logging
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import msgpack

DATA = Path("/data")
HOST = "127.0.0.1"
PORT = 3735
API = "/api/v1"
NETWORK_FAILURE = DATA / "network-attempt"
COUNT = 0


class CheckFailure(Exception):
    pass


def check(identifier, condition):
    global COUNT
    if not condition:
        raise CheckFailure(identifier)
    COUNT += 1
    print(f"PASS {identifier}", flush=True)


def isolation():
    """Fail before creating fixtures unless only loopback networking exists."""
    check("isolation.nonroot", os.getuid() != 0)
    check("isolation.interfaces", {name for _, name in socket.if_nameindex()} == {"lo"})
    routes = Path("/proc/net/route").read_text().splitlines()[1:]
    check("isolation.no-ipv4-default", all(row.split()[1] != "00000000" for row in routes))
    routes6 = Path("/proc/net/ipv6_route").read_text().splitlines()
    # Linux may retain an unreachable default-route sentinel on lo; only a
    # usable default route (RTF_UP without RTF_REJECT) is disallowed.
    check("isolation.no-ipv6-default", not any(
        row.split()[0] == "0" * 32 and row.split()[1] == "00"
        and int(row.split()[8], 16) & 1 and not int(row.split()[8], 16) & 0x200
        for row in routes6
    ))
    status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    check("isolation.no-capabilities", int(status["CapEff"].strip(), 16) == 0)
    check("isolation.no-new-privileges", status["NoNewPrivs"].strip() == "1")
    mounts = [line.split() for line in Path("/proc/mounts").read_text().splitlines()]
    check("isolation.readonly-root", any(row[1] == "/" and "ro" in row[3].split(",") for row in mounts))
    for path in ("/data", "/tmp"):
        check(f"isolation.tmpfs-{path[1:]}", any(row[1] == path and row[2] == "tmpfs" for row in mounts))
    check("isolation.readonly-harness", any(
        row[1] == "/harness" and "ro" in row[3].split(",") for row in mounts
    ))
    check("isolation.no-docker-socket", not Path("/var/run/docker.sock").exists())
    # TEST-NET-1 is a documentation address, not a real service. Require the
    # kernel's no-route result, rather than accepting a timeout or refusal.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(("192.0.2.1", 9))
        except OSError as exc:
            check("isolation.egress-denied", exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH))
        else:
            raise CheckFailure("isolation.egress-denied")
    allowed_env = {
        "PATH", "HOSTNAME", "HOME", "LANG", "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256",
        "PYTHONUNBUFFERED", "PIP_DISABLE_PIP_VERSION_CHECK",
    }
    check("isolation.environment", set(os.environ) <= allowed_env)
    check("isolation.no-config-overrides", not any(Path(path).exists() for path in (
        "/app/etebase_server_settings.py", "/app/etebase-server.ini", "/etc/etebase-server/etebase-server.ini",
    )))


def network_guard():
    """Record even a caught external socket attempt, without its destination."""
    def audit(event, args):
        address = None
        if event in ("socket.connect", "socket.bind"):
            address = args[1]
        elif event in ("socket.sendto", "socket.sendmsg"):
            address = args[1]
        elif event == "socket.getaddrinfo":
            address = (args[0], args[1])
        elif event in ("socket.gethostbyname", "socket.gethostbyaddr"):
            address = (args[0], 0)
        else:
            return
        try:
            safe = isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback
        except ValueError:
            safe = False
        if not safe:
            NETWORK_FAILURE.write_text("blocked\n")
            raise RuntimeError("external-network-attempt")
    sys.addaudithook(audit)


def configure(create):
    """Use the normal settings loader, with only local fixture configuration."""
    os.chdir(DATA)
    sys.path[:0] = [str(DATA), "/app"]
    os.environ.update({
        "DJANGO_SETTINGS_MODULE": "etebase_server.settings",
        "ETEBASE_EASY_CONFIG_PATH": "/data/etebase-server.ini",
        "ETEBASE_DEBUG": "false",
        "ETEBASE_DISABLE_DJANGO_ADMIN": "true",
        "ETEBASE_SECURE_SSL_REDIRECT": "false",
    })
    if create:
        os.umask(0o077)
        for name in ("media", "static"):
            (DATA / name).mkdir()
        (DATA / "secret.txt").write_text(secrets.token_urlsafe(48))
        (DATA / "etebase-server.ini").write_text(
            "[global]\ndebug = false\nsecret_file = /data/secret.txt\n"
            "media_root = /data/media\nstatic_root = /data/static\n"
            "[allowed_hosts]\nlocal = 127.0.0.1\n"
            "[database]\nengine = django.db.backends.sqlite3\nname = /data/db.sqlite3\n"
        )
        # The supported settings extension is limited to the mail transport;
        # authentication, permissions and route dependencies remain untouched.
        (DATA / "etebase_server_settings.py").write_text(
            'EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"\n'
        )
    logging.disable(logging.CRITICAL)
    import django
    django.setup()


def settings_and_routes():
    from django.conf import settings
    from django.urls import get_resolver
    from fastapi.routing import iter_route_contexts

    from etebase_server.asgi import application
    from etebase_server.django import app_settings

    check("settings.production", settings.DEBUG is False and settings.ETEBASE_DISABLE_DJANGO_ADMIN)
    check("settings.loopback", settings.ALLOWED_HOSTS == [HOST] and not settings.SECURE_SSL_REDIRECT)
    check("settings.sqlite", settings.DATABASES["default"]["ENGINE"] == "django.db.backends.sqlite3"
          and str(settings.DATABASES["default"]["NAME"]) == "/data/db.sqlite3")
    check("settings.local-storage", settings.MEDIA_ROOT == "/data/media" and settings.SENDFILE_ROOT == "/data/media")
    check("settings.local-mail", settings.EMAIL_BACKEND == "django.core.mail.backends.locmem.EmailBackend")
    check("settings.no-provider-hooks", app_settings.REDIS_URI is None
          and not app_settings.API_PERMISSIONS_READ and not app_settings.API_PERMISSIONS_WRITE
          and app_settings.GET_USER_QUERYSET_FUNC is None and app_settings.CHUNK_PATH_FUNC is None
          and app_settings.CREATE_USER_FUNC is None and app_settings.DASHBOARD_URL_FUNC is None)
    check("settings.no-owner-credentials", not settings.ETEBASE_BOOTSTRAP_ADMIN_TOKEN
          and not settings.ETEBASE_REGISTRATION_TOKEN and not settings.ETEBASE_OWNER_PASSWORD)
    check("routes.no-dependency-overrides", not application.dependency_overrides)
    paths = {context.path for context in iter_route_contexts(application.routes)}
    check("routes.production-registration", not any(
        path in ("/docs", "/redoc", "/openapi.json") or path.startswith(f"{API}/test/")
        for path in paths
    ))
    check("routes.admin-unregistered", all(str(pattern.pattern) != "admin/" for pattern in get_resolver().url_patterns))


def request(method, path, token=None, body=None, raw=None):
    headers = {"Accept": "application/msgpack"}
    if token is not None:
        headers["Authorization"] = token
    if raw is not None:
        payload = raw
        headers["Content-Type"] = "application/octet-stream"
    elif body is not None:
        payload = msgpack.packb(body, use_bin_type=True)
        headers["Content-Type"] = "application/msgpack"
    else:
        payload = None
    connection = http.client.HTTPConnection(HOST, PORT, timeout=5)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        content = response.read(1024 * 1024 + 1)
        if len(content) > 1024 * 1024:
            raise CheckFailure("http.response-bound")
        return response.status, content
    finally:
        connection.close()


def expect(identifier, method, path, expected, token=None, body=None, raw=None, forbidden=()):
    status, content = request(method, path, token, body, raw)
    check(identifier, status == expected and not any(marker in content for marker in forbidden))
    return content


def decode(content):
    return msgpack.unpackb(content, raw=False)


def login(account, label):
    challenge = decode(expect(f"login.{label}.challenge", "POST", f"{API}/authentication/login_challenge/",
                              200, body={"username": account.user.username}))
    response = msgpack.packb({
        "username": account.user.username, "challenge": challenge["challenge"], "host": HOST, "action": "login",
    }, use_bin_type=True)
    result = decode(expect(f"login.{label}.signed", "POST", f"{API}/authentication/login/", 200,
                           body={"response": response, "signature": account.signing_key.sign(response).signature}))
    check(f"login.{label}.identity", result["user"]["username"] == account.user.username and bool(result["token"]))
    return "Token " + result["token"]


def matrix(a, b, token_a, token_b):
    from fixtures import batch, invitation, snapshot, uid

    from etebase_server.django import models
    from etebase_server.fastapi.routers.authentication import SignupIn
    from etebase_server.fastapi.routers.collection import ItemBatchIn
    from etebase_server.fastapi.routers.invitation import CollectionInvitationAcceptIn, CollectionInvitationIn

    root = f"{API}/collection/{a.collection.uid}"
    item = f"{root}/item/{a.items[1].uid}"
    chunk = f"{item}/chunk/{a.chunks[1].uid}/download/"
    for label, account, token in (("a", a, token_a), ("b", b, token_b)):
        own_root = f"{API}/collection/{account.collection.uid}"
        result = decode(expect(f"positive.{label}.collection", "GET", own_root + "/", 200, token))
        check(f"positive.{label}.collection-content", result["item"]["uid"] == account.collection.uid
              and result["item"]["content"]["meta"] == account.markers[1])
        result = decode(expect(f"positive.{label}.items", "GET", own_root + "/item/", 200, token))
        check(f"positive.{label}.item-content", {entry["uid"] for entry in result["data"]}
              == {entry.uid for entry in account.items[1:]}
              and {entry["content"]["meta"] for entry in result["data"]} == {account.markers[3], account.markers[5]})
        own_item = f"{own_root}/item/{account.items[1].uid}"
        result = decode(expect(f"positive.{label}.item", "GET", own_item + "/", 200, token))
        check(f"positive.{label}.single-content", result["content"]["meta"] == account.markers[3])
        result = decode(expect(f"positive.{label}.revisions", "GET", own_item + "/revision/", 200, token))
        check(f"positive.{label}.revision-content", len(result["data"]) == 1
              and result["data"][0]["meta"] == account.markers[3])
        result = decode(expect(f"positive.{label}.members", "GET", own_root + "/member/", 200, token))
        check(f"positive.{label}.member-content", {entry["username"] for entry in result["data"]} == {account.user.username})
        result = decode(expect(f"positive.{label}.list-multi", "POST", f"{API}/collection/list_multi/", 200, token,
                               body={"collectionTypes": [bytes(account.member.collectionType.uid)]}))
        check(f"positive.{label}.list-multi-content", {entry["item"]["uid"] for entry in result["data"]} == {account.collection.uid})
        own_chunk = f"{own_root}/item/{account.items[1].uid}/chunk/{account.chunks[1].uid}/download/"
        content = expect(f"positive.{label}.chunk", "GET", own_chunk, 200, token)
        check(f"positive.{label}.chunk-content", content == account.markers[4])

    payload = batch(a)
    ItemBatchIn.model_validate(payload)
    accept = {"collectionType": bytes(b.member.collectionType.uid), "encryptionKey": secrets.token_bytes(32)}
    CollectionInvitationAcceptIn.model_validate(accept)
    invite = {"uid": uid(), "version": 1, "accessLevel": 2, "username": a.user.username,
              "collection": a.collection.uid, "signedEncryptionKey": secrets.token_bytes(64)}
    CollectionInvitationIn.model_validate(invite)
    missing_invite = uid()
    reset = {"user": {"username": a.user.username, "email": a.user.email},
             "salt": secrets.token_bytes(32), "loginPubkey": bytes(a.signing_key.verify_key),
             "pubkey": secrets.token_bytes(32), "encryptedContent": secrets.token_bytes(64)}
    SignupIn.model_validate(reset)

    # (identifier, method, path, B status, msgpack payload, raw payload)
    cases = [
        ("collection", "GET", root + "/", 404, None, None),
        ("items", "GET", root + "/item/", 404, None, None),
        ("item", "GET", item + "/", 404, None, None),
        ("revisions", "GET", item + "/revision/", 404, None, None),
        ("chunk", "GET", chunk, 404, None, None),
        ("members", "GET", root + "/member/", 404, None, None),
        ("batch", "POST", root + "/item/batch/", 404, payload, None),
        ("transaction", "POST", root + "/item/transaction/", 404, payload, None),
        ("chunk-upload", "PUT", f"{item}/chunk/{uid()}/", 404, None, secrets.token_bytes(64)),
        ("member-patch", "PATCH", f"{root}/member/{a.user.username}/", 404, {"accessLevel": 0}, None),
        ("member-delete", "DELETE", f"{root}/member/{a.user.username}/", 404, None, None),
        ("leave", "POST", root + "/member/leave/", 404, None, None),
        ("invite-create", "POST", f"{API}/invitation/outgoing/", 403, invite, None),
        ("invite-missing-accept", "POST", f"{API}/invitation/incoming/{missing_invite}/accept/", 404, accept, None),
    ]
    list_cases = [
        ("collections", "GET", f"{API}/collection/", None),
        ("collections-types", "POST", f"{API}/collection/list_multi/",
         {"collectionTypes": [bytes(a.member.collectionType.uid)]}),
    ]
    before = snapshot()
    for label, method, path, body in list_cases:
        result = decode(expect(f"nonmember.{label}", method, path, 200, token_b, body, forbidden=a.markers))
        check(f"nonmember.{label}.absent", all(entry["item"]["uid"] != a.collection.uid for entry in result["data"]))
        check(f"nonmember.{label}.expected-list", {entry["item"]["uid"] for entry in result["data"]}
              == ({b.collection.uid} if label == "collections" else set()))
    for label, method, path, status, body, raw in cases:
        expect(f"nonmember.{label}", method, path, status, token_b, body, raw, a.markers)
        check(f"nonmember.{label}.unchanged", snapshot() == before)

    for auth_label, token in (("anonymous", None), ("invalid-token", "Token invalid-synthetic-token")):
        for label, method, path, body in list_cases:
            expect(f"{auth_label}.{label}", method, path, 401, token, body, forbidden=a.markers)
        for label, method, path, _, body, raw in cases:
            expect(f"{auth_label}.{label}", method, path, 401, token, body, raw, a.markers)
            check(f"{auth_label}.{label}.unchanged", snapshot() == before)

    for auth_label, token in (("anonymous", None), ("authenticated", token_a)):
        for path in ("/docs", "/redoc", "/openapi.json", "/admin/"):
            expect(f"production.{auth_label}.{path.strip('/')}", "GET", path, 404, token, forbidden=a.markers)
        expect(f"production.{auth_label}.reset", "POST", f"{API}/test/authentication/reset/", 404, token,
               body=reset, forbidden=a.markers)
        check(f"production.{auth_label}.unchanged", snapshot() == before)

    # An invitation belongs to its recipient on incoming routes and its sender
    # on outgoing routes. The same two accounts exercise both directions.
    ba = invitation(b, a)
    ab = invitation(a, b)
    before = snapshot()
    invitation_cases = [
        ("incoming-get", "GET", f"{API}/invitation/incoming/{ba.uid}/", None),
        ("incoming-delete", "DELETE", f"{API}/invitation/incoming/{ba.uid}/", None),
        ("incoming-accept", "POST", f"{API}/invitation/incoming/{ba.uid}/accept/", accept),
        ("incoming-iterator", "GET", f"{API}/invitation/incoming/?iterator={ba.uid}", None),
        ("outgoing-delete", "DELETE", f"{API}/invitation/outgoing/{ab.uid}/", None),
        ("outgoing-iterator", "GET", f"{API}/invitation/outgoing/?iterator={ab.uid}", None),
    ]
    for direction, visible, hidden in (("incoming", ab, ba), ("outgoing", ba, ab)):
        result = decode(expect(f"invitation.{direction}.list", "GET", f"{API}/invitation/{direction}/", 200, token_b))
        check(f"invitation.{direction}.ownership", {entry["uid"] for entry in result["data"]} == {visible.uid}
              and hidden.uid not in {entry["uid"] for entry in result["data"]})
    for auth_label, token, status in (("wrong-account", token_b, 404), ("anonymous", None, 401),
                                      ("invalid-token", "Token invalid-synthetic-token", 401)):
        for label, method, path, body in invitation_cases:
            expect(f"invitation.{auth_label}.{label}", method, path, status, token, body,
                   forbidden=(bytes(ba.signedEncryptionKey), bytes(ab.signedEncryptionKey)))
            check(f"invitation.{auth_label}.{label}.unchanged", snapshot() == before)
        if token != token_b:
            for direction in ("incoming", "outgoing"):
                expect(f"invitation.{auth_label}.{direction}-list", "GET", f"{API}/invitation/{direction}/", 401, token)
    check("invitation.denials.unchanged", snapshot() == before)

    # Positive acceptance is deliberately last: it grants membership, so later
    # nonmember checks would require a new isolated fixture.
    expect("invitation.accept-addressed", "POST", f"{API}/invitation/incoming/{ab.uid}/accept/", 201, token_b, accept)
    member = models.CollectionMember.objects.get(collection=a.collection, user=b.user)
    check("invitation.accept-state", member.accessLevel == models.AccessLevels.READ_WRITE
          and bytes(member.encryptionKey) == accept["encryptionKey"]
          and not models.CollectionInvitation.objects.filter(pk=ab.pk).exists()
          and models.CollectionInvitation.objects.filter(pk=ba.pk).exists())
    result = decode(expect("invitation.accept-read", "GET", root + "/", 200, token_b))
    check("invitation.accept-content", result["item"]["uid"] == a.collection.uid
          and result["item"]["content"]["meta"] == a.markers[1])


def run():
    isolation()
    network_guard()
    configure(create=True)
    settings_and_routes()
    from django.core.management import call_command
    from django.db import connections
    from fixtures import seed

    with open(os.devnull, "w") as sink:
        call_command("migrate", interactive=False, verbosity=0, stdout=sink, stderr=sink)
    a, b = seed()
    check("fixture.two-accounts", a.user.pk != b.user.pk and a.signing_key != b.signing_key)
    connections.close_all()
    server = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()), "--serve"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 20
        while True:
            if server.poll() is not None:
                raise CheckFailure("startup.server-exited")
            try:
                status, _ = request("GET", f"{API}/authentication/is_etebase/")
            except OSError:
                if time.monotonic() >= deadline:
                    raise CheckFailure("startup.timeout") from None
                time.sleep(0.1)
                continue
            check("startup.http", status == 200)
            break
        token_a, token_b = login(a, "a"), login(b, "b")
        check("login.independent-tokens", token_a != token_b)
        matrix(a, b, token_a, token_b)
        check("runtime.server-alive", server.poll() is None)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
            raise CheckFailure("teardown.server-timeout") from None
        connections.close_all()
    check("teardown.server-exit", server.returncode in (0, -signal.SIGTERM))
    check("runtime.no-external-attempts", not NETWORK_FAILURE.exists())


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--serve"]:
            network_guard()
            configure(create=False)
            import uvicorn
            uvicorn.run("etebase_server.asgi:application", host=HOST, port=PORT,
                        log_config=None, access_log=False, proxy_headers=False)
        elif not sys.argv[1:]:
            run()
            print(f"PASS total={COUNT}", flush=True)
        else:
            raise CheckFailure("invocation.invalid-arguments")
    except Exception as exc:
        # No exception strings, HTTP bodies, signing keys or tokens enter logs.
        identifier = str(exc) if isinstance(exc, CheckFailure) else "harness.unexpected-error"
        print(f"FAIL {identifier} passed={COUNT}", flush=True)
        sys.exit(1)
