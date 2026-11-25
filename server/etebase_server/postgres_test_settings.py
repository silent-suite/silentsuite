"""Settings for the PostgreSQL-only server tests (pytest marker ``postgres_only``).

The normal server settings use SQLite. Tests that need real PostgreSQL row and advisory locks
run in CI against a throwaway PostgreSQL service with these settings. The connection comes from
ETEBASE_TEST_POSTGRES_* variables; nothing here is used in production.
"""

import os

from .settings import *  # noqa: F401,F403

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("ETEBASE_TEST_POSTGRES_DB", "etebase_test"),
        "USER": os.environ.get("ETEBASE_TEST_POSTGRES_USER", "postgres"),
        "PASSWORD": os.environ.get("ETEBASE_TEST_POSTGRES_PASSWORD", ""),
        "HOST": os.environ.get("ETEBASE_TEST_POSTGRES_HOST", "127.0.0.1"),
        "PORT": os.environ.get("ETEBASE_TEST_POSTGRES_PORT", "5432"),
    }
}
