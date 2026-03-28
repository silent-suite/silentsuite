"""Temporary CLI authentication for development and testing.

This will be replaced by browser-based auth in Story 13.3.
Provides a simple terminal-based login flow for early development.
"""

import getpass
import hashlib
import logging
import os
import sys

from etebase import Account, Client

from . import config
from .radicale.creds import Credentials

logger = logging.getLogger("silentsuite-bridge.auth")


def manual_login():
    """Interactive CLI login for development/testing.

    Authenticates with the Etebase server, stores the session
    token and password hash locally.
    """
    config.ensure_data_dir()

    print("SilentSuite Bridge — Manual Login")
    print("=" * 40)
    print(f"Server: {config.ETEBASE_SERVER_URL}")
    print()

    username = input("Email: ").strip()
    if not username:
        print("Error: Email is required.")
        sys.exit(1)

    password = getpass.getpass("Password: ")
    if not password:
        print("Error: Password is required.")
        sys.exit(1)

    print()
    print("Authenticating with server...")

    try:
        client = Client("silentsuite-bridge", config.ETEBASE_SERVER_URL)
        etebase = Account.login(client, username, password)
    except Exception as e:
        print(f"Error: Authentication failed: {e}")
        sys.exit(1)

    print("Authentication successful!")
    print("Saving credentials...")

    creds = Credentials()
    # Clear any existing users — bridge supports one account at a time
    for old_user in creds.list_users():
        creds.delete(old_user)
    creds.set_etebase(
        username,
        etebase.save(None),
        config.ETEBASE_SERVER_URL,
    )

    # Store password hash for CalDAV client auth (PBKDF2)
    salt = os.urandom(32)
    password_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt, 600000,
    ).hex()
    creds.set_password_salt(username, salt.hex())
    creds.set_password_hash(username, password_hash)

    creds.save()

    print()
    print("Setup complete!")
    print(f"Etebase server: {config.ETEBASE_SERVER_URL}")
    print(f"CalDAV/CardDAV URL: http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/{username}/")
    print(f"Username: {username}")
    print("Password: (your SilentSuite password)")
    print()
    print("Start the bridge with: silentsuite-bridge")
