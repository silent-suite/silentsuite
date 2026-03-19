"""Radicale auth module for SilentSuite Bridge.

Validates CalDAV/CardDAV client credentials against the locally
stored password hash. No server round-trip for auth -- the browser
auth flow has already proven the user's identity.
"""

import hashlib
import logging

from radicale.auth import BaseAuth

from .creds import Credentials
from .. import config

logger = logging.getLogger("silentsuite-bridge.auth")


class Auth(BaseAuth):
    """Authenticate CalDAV/CardDAV clients using locally stored credentials."""

    def __init__(self, configuration):
        super().__init__(configuration)
        self._creds = Credentials()

    def login(self, login, password):
        """Validate login credentials against stored password hash.

        Returns the username if valid, empty string if invalid.
        """
        if not login or not password:
            return ""

        self._creds.load()

        # Check if user exists in credential store
        stored_session = self._creds.get_etebase(login)
        if stored_session is None:
            logger.warning("Login attempt for unknown user: %s", login)
            return ""

        # Validate password against stored hash
        stored_hash = self._creds.get_password_hash(login)
        if stored_hash is None:
            logger.warning(
                "No password hash stored for user: %s. "
                "Please re-authenticate via browser.",
                login,
            )
            return ""

        password_hash = hashlib.sha256(password.encode()).hexdigest()
        if password_hash == stored_hash:
            logger.debug("Successful login for user: %s", login)
            return login

        logger.warning("Invalid password for user: %s", login)
        return ""
