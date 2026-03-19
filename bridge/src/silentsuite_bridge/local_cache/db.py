"""Database proxy for Peewee ORM.

Uses a proxy pattern so the database connection can be
initialized at runtime with the correct file path.
"""

import peewee as pw

database_proxy = pw.Proxy()


class BaseModel(pw.Model):
    class Meta:
        database = database_proxy
