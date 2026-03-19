"""Credential storage for SilentSuite Bridge.

Stores Etebase session tokens and server URLs in a JSON file.
Credentials are created during the browser-based auth flow.

Forked and adapted from etesync-dav (AGPL-3.0).
"""

import json
import logging
import os

from .. import config

logger = logging.getLogger("silentsuite-bridge.creds")


class Credentials:
    """JSON-based credential store for Etebase sessions."""

    def __init__(self, filename=None):
        self.filename = filename or config.CREDS_FILE
        self.last_mtime = 0
        self.content = {"users": {}}
        self.load()

    def load(self):
        """Load credentials from disk if the file has been modified."""
        if os.path.exists(self.filename):
            mtime = os.path.getmtime(self.filename)
            if mtime != self.last_mtime:
                with open(self.filename, "r") as f:
                    self.content = json.load(f)
            self.last_mtime = mtime

    def save(self):
        """Persist credentials to disk."""
        directory = os.path.dirname(self.filename)
        if directory and not os.path.exists(directory):
            os.makedirs(directory, mode=0o700)

        with open(self.filename, "w") as f:
            json.dump(self.content, f)

        # Restrict file permissions (not effective on Windows)
        try:
            os.chmod(self.filename, 0o600)
        except OSError:
            pass

    def get_server_url(self, username):
        """Get the Etebase server URL for a user."""
        users = self.content.get("users", {})
        if username not in users:
            return config.ETEBASE_SERVER_URL

        return users[username].get("serverUrl", config.ETEBASE_SERVER_URL)

    def get_etebase(self, username):
        """Get stored Etebase session for a user."""
        users = self.content.get("users", {})
        if username not in users:
            return None

        return users[username].get("storedSession", None)

    def set_etebase(self, username, stored_session, server_url=None):
        """Store an Etebase session for a user."""
        if server_url is None:
            server_url = config.ETEBASE_SERVER_URL

        users = self.content.setdefault("users", {})
        users[username] = {
            "storedSession": stored_session,
            "serverUrl": server_url,
        }

    def get_password_hash(self, username):
        """Get the locally stored password hash for CalDAV auth."""
        users = self.content.get("users", {})
        if username not in users:
            return None

        return users[username].get("passwordHash", None)

    def set_password_hash(self, username, password_hash):
        """Store the password hash for CalDAV auth."""
        users = self.content.setdefault("users", {})
        if username not in users:
            users[username] = {}
        users[username]["passwordHash"] = password_hash

    def delete(self, username):
        """Remove a user's credentials."""
        users = self.content.get("users", {})
        users.pop(username, None)

    def list_users(self):
        """List all stored usernames."""
        return list(self.content.get("users", {}).keys())
