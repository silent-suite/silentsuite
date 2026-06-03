"""Temporary CLI authentication for development and testing.

This will be replaced by browser-based auth in Story 13.3.
Provides a simple terminal-based login flow for early development.
"""

import getpass
import logging
import sys

from etebase import Account, Client

from . import config
from .accounts import store_authenticated_account

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

    result = store_authenticated_account(
        username,
        password,
        etebase.save(None),
        config.ETEBASE_SERVER_URL,
    )

    print()
    print("Account saved! Existing accounts were left unchanged.")
    print(f"Etebase server: {config.ETEBASE_SERVER_URL}")
    print(f"CalDAV/CardDAV URL: http://{config.LISTEN_ADDRESS}:{config.LISTEN_PORT}/{result.username}/")
    print(f"Username: {result.username}")
    print("Password: (your account password)")
    print()
    print("Start the bridge with: silentsuite-bridge")
