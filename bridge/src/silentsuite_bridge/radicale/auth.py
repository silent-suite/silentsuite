"""Radicale auth module for SilentSuite Bridge.

Validates CalDAV/CardDAV client credentials against the locally
stored password hash. No server round-trip for auth -- the browser
auth flow has already proven the user's identity.
"""

import hashlib
import hmac
import logging
import os

from radicale.auth import BaseAuth

from .creds import CREDENTIALS_LOCK, Credentials

logger = logging.getLogger("silentsuite-bridge.auth")

PBKDF2_ITERATIONS = 600000


class Auth(BaseAuth):
    """Authenticate CalDAV/CardDAV clients using locally stored credentials."""

    def __init__(self, configuration):
        super().__init__(configuration)
        self._creds = Credentials()

    def _snapshot(self, login):
        self._creds.load()
        return (
            self._creds.get_etebase(login),
            self._creds.get_password_hash(login),
            self._creds.get_password_salt(login),
        )

    def login(self, login, password):
        """Validate login credentials against stored password hash.

        Returns the username if valid, empty string if invalid.

        The deliberately slow PBKDF2 work runs without CREDENTIALS_LOCK, so a
        DAV request does not stall session acquisition or other requests. The
        credentials are re-read under the lock before the result is accepted,
        and a change in between rejects the attempt.
        """
        if not login or not password:
            return ""

        with CREDENTIALS_LOCK:
            credential_snapshot = self._snapshot(login)
        stored_session, stored_hash, stored_salt = credential_snapshot

        # Check if user exists in credential store
        if stored_session is None:
            logger.warning("Login attempt for unknown configured user")
            return ""

        if stored_hash is None:
            logger.warning(
                "No password hash stored for configured user. "
                "Please re-authenticate via browser."
            )
            return ""

        upgrade = None
        if stored_salt:
            # PBKDF2 verification
            password_hash = hashlib.pbkdf2_hmac(
                "sha256", password.encode(), bytes.fromhex(stored_salt),
                PBKDF2_ITERATIONS,
            ).hex()
        else:
            # Legacy SHA-256 fallback for existing credentials. Prepare the
            # PBKDF2 replacement here, outside the lock, when it will be needed.
            password_hash = hashlib.sha256(password.encode()).hexdigest()
            if hmac.compare_digest(password_hash, stored_hash):
                new_salt = os.urandom(32)
                new_hash = hashlib.pbkdf2_hmac(
                    "sha256", password.encode(), new_salt, PBKDF2_ITERATIONS,
                ).hex()
                upgrade = (new_salt.hex(), new_hash)

        with CREDENTIALS_LOCK:
            if self._snapshot(login) != credential_snapshot:
                logger.info("Credentials changed during authentication")
                return ""

            if not hmac.compare_digest(password_hash, stored_hash):
                logger.warning("Invalid password for configured user")
                return ""

            logger.debug("Successful login for configured user")

            # Auto-upgrade legacy SHA-256 hashes to PBKDF2
            if upgrade is not None:
                logger.info("Upgrading password hash to PBKDF2")
                self._creds.set_password_salt(login, upgrade[0])
                self._creds.set_password_hash(login, upgrade[1])
                self._creds.save()

        return login
