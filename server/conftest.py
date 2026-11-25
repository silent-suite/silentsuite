import pytest


def pytest_collection_modifyitems(config, items):
    """Skip tests marked postgres_only unless the test database is PostgreSQL.

    The normal server test runs use SQLite; those tests need real PostgreSQL locks and run in
    the separate PostgreSQL CI job (etebase_server.postgres_test_settings).
    """
    from django.conf import settings

    engine = settings.DATABASES["default"]["ENGINE"]
    if engine == "django.db.backends.postgresql":
        return
    skip = pytest.mark.skip(reason="postgres_only: needs a PostgreSQL test database")
    for item in items:
        if "postgres_only" in item.keywords:
            item.add_marker(skip)
