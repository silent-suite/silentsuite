"""Mock etebase module for testing without the native SDK."""

from types import SimpleNamespace
from unittest.mock import MagicMock

Account = MagicMock()
Client = MagicMock()
FetchOptions = MagicMock
CollectionAccessLevel = MagicMock()
CollectionAccessLevel.ReadOnly = 1
# Fixture collections default to 0, which the tests treat as read/write.
CollectionAccessLevel.ReadWrite = 0
CollectionAccessLevel.Admin = 2


class _SdkError(Exception):
    """Stands in for etebase_python.Error, the SDK's one exception type."""


_SdkError.__name__ = _SdkError.__qualname__ = "Error"

# The real package exposes the native module (and its Error) only as
# ``etebase.etebase_python``; there is no top-level ``etebase.Error``.
etebase_python = SimpleNamespace(Error=_SdkError)
