"""Database proxy for Peewee ORM.

Uses a proxy pattern so the database connection can be
initialized at runtime with the correct file path.
"""

from contextlib import contextmanager

import peewee as pw

database_proxy = pw.Proxy()


@contextmanager
def atomic_connection():
    """Open/close only an owned connection and nest safely in transactions."""
    database = database_proxy.obj
    if database.is_closed():
        with database.connection_context():
            with database.atomic():
                yield
    else:
        # ``with database`` closes the connection on exit and therefore breaks
        # callers that already own a transaction. ``atomic`` uses a savepoint
        # when nested and leaves the caller's connection ownership unchanged.
        with database.atomic():
            yield


class BaseModel(pw.Model):
    class Meta:
        database = database_proxy
