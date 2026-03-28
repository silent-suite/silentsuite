"""Mock etebase module for testing without the native SDK."""

from unittest.mock import MagicMock

Account = MagicMock()
Client = MagicMock()
FetchOptions = MagicMock
CollectionAccessLevel = MagicMock()
CollectionAccessLevel.ReadOnly = 1
