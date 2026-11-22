"""Mock etebase module for testing without the native SDK."""

from unittest.mock import MagicMock

Account = MagicMock()
Client = MagicMock()
FetchOptions = MagicMock
CollectionAccessLevel = MagicMock()
CollectionAccessLevel.ReadOnly = 1
# Fixture collections default to 0, which the tests treat as read/write.
CollectionAccessLevel.ReadWrite = 0
CollectionAccessLevel.Admin = 2
