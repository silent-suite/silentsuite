"""Overlapping-transaction tests for login name claims. They need real PostgreSQL row and advisory
locks (each thread uses its own connection), so they are skipped on SQLite.

Each test pauses one transaction right after its collision check, while it holds its name lock,
starts the competing transaction, checks that the competitor is still waiting, then lets the first
one finish.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from django.db import connection, connections
from fastapi.testclient import TestClient

from etebase_server.django.models import UserInfo
from etebase_server.fastapi.conftest import AUTH_PREFIX, decode_response, msgpack_post
from etebase_server.fastapi.test_login_email_change import accepted_change, commit, make_app_client, rename
from etebase_server.fastapi.utils import identity_snapshot
from etebase_server.myauth.models import get_typed_user_model

pytestmark = [
    pytest.mark.postgres_only,
    pytest.mark.django_db(transaction=True),
    pytest.mark.skipif(connection.vendor != "postgresql", reason="needs PostgreSQL row and advisory locks"),
]
User = get_typed_user_model()
WAIT = 10


@pytest.fixture
def client(settings, tmp_path, monkeypatch):
    return make_app_client(settings, tmp_path, monkeypatch)


class Pause:
    """Wrap a function so its first call stops after returning until released."""

    def __init__(self, module, name):
        self.reached = threading.Event()
        self.release = threading.Event()
        self.original = getattr(module, name)
        self.module, self.name = module, name

    def __call__(self, *args, **kwargs):
        result = self.original(*args, **kwargs)
        if not self.reached.is_set():
            self.reached.set()
            assert self.release.wait(WAIT)
        return result


def fresh(client):
    """A client of its own for each thread."""
    return TestClient(client.app, raise_server_exceptions=False)


def in_thread(fn):
    def run():
        try:
            return fn()
        finally:
            connections.close_all()

    return run


def overlap(monkeypatch, pause: Pause, first, second):
    """Run `first` until it pauses, start `second`, prove it waits, then finish both."""
    monkeypatch.setattr(pause.module, pause.name, pause)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_future = pool.submit(in_thread(first))
        assert pause.reached.wait(WAIT)
        second_future = pool.submit(in_thread(second))
        time.sleep(0.5)
        waited = not second_future.done()
        pause.release.set()
        results = first_future.result(WAIT), second_future.result(WAIT)
    assert waited, "the competing transaction did not wait for the name lock"
    return results


def signup_body(username, email, login_pubkey, user_salt):
    return {
        "user": {"username": username, "email": email},
        "salt": user_salt,
        "loginPubkey": login_pubkey,
        "pubkey": login_pubkey,
        "encryptedContent": b"\x00" * 64,
    }


@pytest.mark.parametrize("as_field", ["username", "email", "email-with-whitespace"])
def test_rename_first_then_signup_claiming_the_destination_is_refused(
    client, user_factory, signing_key, login_pubkey, user_salt, monkeypatch, as_field
):
    from etebase_server.fastapi.routers import billing_link

    user = user_factory(username="mover@example.com", email="mover@example.com")
    grant = accepted_change(client, user, signing_key, "dest@example.com")["grant"]
    # " dest@example.com" is stored trimmed, so it must take the same name lock as the rename.
    username, email = {
        "username": ("dest@example.com", "a@example.com"),
        "email": ("other", "dest@example.com"),
        "email-with-whitespace": ("other", " dest@example.com"),
    }[as_field]

    committed, signed_up = overlap(
        monkeypatch,
        Pause(billing_link, "destination_taken"),
        lambda: commit(fresh(client), grant),
        lambda: msgpack_post(fresh(client), f"{AUTH_PREFIX}/signup/", signup_body(username, email, login_pubkey, user_salt)),
    )

    assert committed.status_code == 200
    assert signed_up.status_code == 409
    assert decode_response(signed_up)["code"] == "user_exists"
    assert User.objects.filter(username__iexact="dest@example.com").count() == 1


@pytest.mark.parametrize("as_field", ["username", "email"])
def test_signup_first_then_rename_to_its_name_is_refused(
    client, user_factory, signing_key, login_pubkey, user_salt, monkeypatch, as_field
):
    from etebase_server.fastapi.routers import authentication

    user = user_factory(username="mover@example.com", email="mover@example.com")
    grant = accepted_change(client, user, signing_key, "dest@example.com")["grant"]
    username, email = ("dest@example.com", "a@example.com") if as_field == "username" else ("other", "dest@example.com")

    signed_up, committed = overlap(
        monkeypatch,
        Pause(authentication, "signup_identity_taken"),
        lambda: msgpack_post(fresh(client), f"{AUTH_PREFIX}/signup/", signup_body(username, email, login_pubkey, user_salt)),
        lambda: commit(fresh(client), grant),
    )

    assert signed_up.status_code in (200, 201)
    assert committed.status_code == 409
    assert committed.json() == {"code": "refused", "reason": "taken"}
    assert User.objects.get(pk=user.pk).username == "mover@example.com"


def test_two_renames_to_the_same_name_have_one_winner(client, user_factory, signing_key, monkeypatch):
    from etebase_server.fastapi.routers import billing_link

    first = user_factory(username="one@example.com", email="one@example.com")
    second = user_factory(username="two@example.com", email="two@example.com")
    first_grant = accepted_change(client, first, signing_key, "dest@example.com")["grant"]
    second_grant = accepted_change(client, second, signing_key, "dest@example.com")["grant"]

    won, lost = overlap(
        monkeypatch,
        Pause(billing_link, "destination_taken"),
        lambda: commit(fresh(client), first_grant),
        lambda: commit(fresh(client), second_grant),
    )

    assert won.status_code == 200
    assert lost.json() == {"code": "refused", "reason": "taken"}
    assert User.objects.get(username="dest@example.com").pk == first.pk


def test_signup_waits_for_a_rename_leaving_the_same_name(
    client, user_factory, signing_key, login_pubkey, user_salt, monkeypatch
):
    from etebase_server.fastapi.routers import billing_link

    user = user_factory(username="leaving@example.com", email="leaving@example.com")
    grant = accepted_change(client, user, signing_key, "arrived@example.com")["grant"]

    committed, signed_up = overlap(
        monkeypatch,
        Pause(billing_link, "destination_taken"),
        lambda: commit(fresh(client), grant),
        lambda: msgpack_post(
            fresh(client), f"{AUTH_PREFIX}/signup/", signup_body("leaving@example.com", "x@example.com", login_pubkey, user_salt)
        ),
    )

    assert committed.status_code == 200
    # The old name is held after the commit, so the waiting signup sees the hold.
    assert signed_up.status_code == 409


def test_identity_snapshot_is_never_mixed_during_concurrent_renames(client, user_factory, signing_key):
    user = user_factory(username="v0@example.com", email="v0@example.com")
    expected = {0: "v0@example.com"}
    done = threading.Event()
    observed = []

    def renamer():
        try:
            for version in range(1, 5):
                name = f"v{version}@example.com"
                expected[version] = name
                rename(client, User.objects.get(pk=user.pk), signing_key, name)
        finally:
            done.set()

    def reader():
        while not done.is_set():
            snapshot = identity_snapshot(user.pk)
            observed.append((snapshot["loginVersion"], snapshot["username"]))

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(in_thread(renamer)), pool.submit(in_thread(reader))]
        for future in futures:
            future.result(60)

    assert UserInfo.objects.get(owner=user).login_version == 4
    assert observed
    for version, username in observed:
        assert expected[version] == username
