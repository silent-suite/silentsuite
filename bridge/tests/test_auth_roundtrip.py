"""Round-trip tests for the bridge's CalDAV/CardDAV client auth path.

When a CalDAV client (Outlook, Thunderbird, Apple Calendar, DAVx⁵, etc.)
talks to the bridge, it presents HTTP Basic credentials. The bridge does
NOT call out to the Etebase server to validate them — the prior browser
auth flow has already proven the user's identity and stored a PBKDF2
hash of the password locally. This module exercises that local
verification path end-to-end:

    Credentials.set_etebase + set_password_salt + set_password_hash
        ↓ (persist)
    Auth(configuration).login(username, password)
        ↓ (PBKDF2 verify against stored hash)
    returns username on success, "" on failure

Plus the legacy SHA-256 → PBKDF2 auto-upgrade path, which exists so
credentials saved by older bridge versions keep working but get migrated
on next successful login.

The Etebase-side auth flow (login_challenge / signed-response handshake
against the server) is covered by the server-side tests in PR #21 PR B.
"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
import os
from unittest.mock import MagicMock

import pytest

from silentsuite_bridge import config
from silentsuite_bridge.radicale.auth import Auth
from silentsuite_bridge.radicale.creds import Credentials


def _radicale_config_stub():
    """Minimal stand-in for `radicale.config.Configuration` — BaseAuth only
    reads `lc_username` and `strip_domain` from it during __init__."""
    cfg = MagicMock()
    cfg.get.side_effect = lambda section, key: False
    return cfg

USERNAME = "alice@example.com"
PASSWORD = "correct horse battery staple"


@pytest.fixture
def creds_file(tmp_path, monkeypatch):
    """Point both `Credentials()` and `Auth()` at a per-test JSON file."""
    path = tmp_path / "creds.json"
    monkeypatch.setattr(config, "CREDS_FILE", str(path))
    return str(path)


def _seed_pbkdf2_user(
    creds_file: str,
    *,
    username: str = USERNAME,
    password: str = PASSWORD,
    server_url: str = "https://test.silentsuite.io",
    stored_session: str = "fake-session-blob",
):
    """Persist a user with a fresh PBKDF2 password hash, exactly the way
    the browser auth flow does in `auth_browser.py`."""
    creds = Credentials(filename=creds_file)
    creds.set_etebase(username, stored_session, server_url)
    salt = os.urandom(32)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, 600000
    ).hex()
    creds.set_password_salt(username, salt.hex())
    creds.set_password_hash(username, pwd_hash)
    creds.save()
    return creds


def _seed_legacy_sha256_user(
    creds_file: str,
    *,
    username: str = USERNAME,
    password: str = PASSWORD,
):
    """Persist a user with the pre-PBKDF2 unsalted-SHA-256 hash. Earlier
    bridge versions stored hashes this way; the auth path must still
    accept them and silently upgrade on first successful login."""
    creds = Credentials(filename=creds_file)
    creds.set_etebase(username, "fake-session", "https://test.silentsuite.io")
    creds.set_password_hash(username, hashlib.sha256(password.encode()).hexdigest())
    # Note: NO password_salt set — that's how the auth path detects legacy.
    creds.save()
    return creds


@pytest.fixture
def auth(creds_file):
    """An Auth instance. Construct *after* `creds_file` is in place so the
    monkeypatched config.CREDS_FILE is what gets read."""
    return Auth(_radicale_config_stub())


class TestCredentialRequired:
    def test_empty_username_is_rejected(self, auth):
        assert auth.login("", PASSWORD) == ""

    def test_empty_password_is_rejected(self, auth, creds_file):
        _seed_pbkdf2_user(creds_file)
        assert auth.login(USERNAME, "") == ""

    def test_unknown_user_is_rejected(self, auth):
        # No credentials seeded — the user simply doesn't exist locally.
        assert auth.login("ghost@example.com", PASSWORD) == ""

    def test_user_with_no_password_hash_is_rejected(self, auth, creds_file):
        # An account that exists in the credentials file but never had a
        # password hash stored (e.g. a partial/aborted browser auth)
        # must not be allowed in.
        creds = Credentials(filename=creds_file)
        creds.set_etebase(USERNAME, "fake-session", "https://test.silentsuite.io")
        creds.save()

        assert auth.login(USERNAME, PASSWORD) == ""


class TestPbkdf2RoundTrip:
    def test_correct_password_returns_username(self, auth, creds_file):
        _seed_pbkdf2_user(creds_file)
        assert auth.login(USERNAME, PASSWORD) == USERNAME

    def test_wrong_password_returns_empty_string(self, auth, creds_file):
        _seed_pbkdf2_user(creds_file)
        assert auth.login(USERNAME, "wrong-password") == ""

    def test_correct_password_succeeds_repeatedly(self, auth, creds_file):
        # No rate-limit / single-use behaviour — same auth must work again.
        _seed_pbkdf2_user(creds_file)
        assert auth.login(USERNAME, PASSWORD) == USERNAME
        assert auth.login(USERNAME, PASSWORD) == USERNAME
        assert auth.login(USERNAME, PASSWORD) == USERNAME

    def test_password_comparison_uses_constant_time_compare(
        self, auth, creds_file, monkeypatch
    ):
        # The auth path uses hmac.compare_digest specifically to avoid
        # timing-side-channel password recovery. If a future refactor
        # accidentally swapped to `==`, this test would fail loudly.
        _seed_pbkdf2_user(creds_file)

        calls: list[tuple[str, str]] = []
        real_compare = hmac_mod.compare_digest

        def spy(a, b):
            calls.append((a, b))
            return real_compare(a, b)

        monkeypatch.setattr(
            "silentsuite_bridge.radicale.auth.hmac.compare_digest", spy
        )

        result = auth.login(USERNAME, PASSWORD)

        assert result == USERNAME
        assert len(calls) == 1, "expected exactly one constant-time compare per login"


class TestLegacySha256Upgrade:
    def test_legacy_sha256_login_succeeds(self, auth, creds_file):
        _seed_legacy_sha256_user(creds_file)
        assert auth.login(USERNAME, PASSWORD) == USERNAME

    def test_legacy_sha256_login_with_wrong_password_fails(self, auth, creds_file):
        _seed_legacy_sha256_user(creds_file)
        assert auth.login(USERNAME, "wrong-password") == ""

    def test_successful_legacy_login_upgrades_hash_to_pbkdf2(
        self, auth, creds_file
    ):
        _seed_legacy_sha256_user(creds_file)
        legacy = Credentials(filename=creds_file)
        old_hash = legacy.get_password_hash(USERNAME)
        assert legacy.get_password_salt(USERNAME) is None  # confirm legacy state

        assert auth.login(USERNAME, PASSWORD) == USERNAME

        # Re-load from disk to verify the upgrade actually persisted.
        upgraded = Credentials(filename=creds_file)
        new_hash = upgraded.get_password_hash(USERNAME)
        new_salt = upgraded.get_password_salt(USERNAME)

        assert new_salt is not None and len(new_salt) == 64  # 32 bytes hex
        assert new_hash != old_hash, "hash must change after PBKDF2 upgrade"
        # And the upgraded hash matches what PBKDF2 would produce.
        expected = hashlib.pbkdf2_hmac(
            "sha256", PASSWORD.encode(), bytes.fromhex(new_salt), 600000
        ).hex()
        assert new_hash == expected

    def test_login_still_works_after_upgrade(self, auth, creds_file):
        _seed_legacy_sha256_user(creds_file)
        # First login triggers the upgrade.
        assert auth.login(USERNAME, PASSWORD) == USERNAME
        # Subsequent login goes through the PBKDF2 path with the new salt.
        assert auth.login(USERNAME, PASSWORD) == USERNAME
        assert auth.login(USERNAME, "wrong-password") == ""


class TestEndToEndAuthSetup:
    """Mirror what `auth_browser.browser_login()` does after a successful
    Etebase login — set the session blob plus a salt + PBKDF2 hash —
    then assert the resulting credentials let a CalDAV client authenticate."""

    def test_browser_auth_then_caldav_login_round_trip(self, auth, creds_file):
        # Step 1: browser_login persists the session + a salted PBKDF2 hash.
        creds = Credentials(filename=creds_file)
        # Wipe any prior users (browser_login does this for single-account mode).
        for u in creds.list_users():
            creds.delete(u)
        creds.set_etebase(
            USERNAME,
            stored_session="fake-stored-session-blob",
            server_url="https://test.silentsuite.io",
        )
        salt = os.urandom(32)
        pwd_hash = hashlib.pbkdf2_hmac(
            "sha256", PASSWORD.encode(), salt, 600000
        ).hex()
        creds.set_password_salt(USERNAME, salt.hex())
        creds.set_password_hash(USERNAME, pwd_hash)
        creds.save()

        # Step 2: a CalDAV client connects with those credentials — the
        # bridge's Auth.login (called by Radicale per request) returns the
        # username if and only if the password matches what was stored.
        assert auth.login(USERNAME, PASSWORD) == USERNAME
        assert auth.login(USERNAME, "not-the-password") == ""
        assert auth.login("nobody@example.com", PASSWORD) == ""

        # Step 3: the Etebase session blob the sync thread will need is
        # available under the same username — this is the join point
        # between the auth path (this test) and the sync path (covered
        # elsewhere in the bridge tests).
        assert creds.get_etebase(USERNAME) == "fake-stored-session-blob"
        assert creds.get_server_url(USERNAME) == "https://test.silentsuite.io"
