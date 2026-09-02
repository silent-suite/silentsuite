"""Strict checksum parsing and digest verification."""

from __future__ import annotations

import hashlib

from .types import ChecksumError


def parse_checksum(content: str | bytes, *, expected_asset_name: str) -> str:
    """Parse a single canonical checksum line.

    Expected format: ``<64 hex><two spaces><exact basename>\\n``
    Exactly one line, exactly one newline terminator.
    Rejects non-UTF-8 bytes, extra blank lines, malformed separators,
    duplicate lines, and wrong names.

    Returns the lowercase hex digest.
    Raises ChecksumError on any deviation.
    """
    if isinstance(content, bytes):
        try:
            content = content.decode("utf-8")
        except UnicodeDecodeError:
            raise ChecksumError("Checksum content is not valid UTF-8.")

    # Must contain exactly one trailing newline and no extra blank lines.
    if not content.endswith("\n") or content.count("\n") != 1:
        raise ChecksumError("Checksum content is not newline-terminated.")
    line = content[:-1]

    # Exactly one double-space separator
    sep = "  "
    if line.count(sep) != 1:
        raise ChecksumError("Checksum format is invalid.")

    hex_part, name_part = line.split(sep, 1)

    if len(hex_part) != 64:
        raise ChecksumError("Checksum digest length is invalid.")
    if not _is_hex(hex_part):
        raise ChecksumError("Checksum digest is not hexadecimal.")

    if name_part != expected_asset_name:
        raise ChecksumError("Checksum asset name does not match expected.")

    return hex_part.lower()


def verify_asset(data: bytes, expected_hex: str) -> None:
    """Verify ``data`` matches ``expected_hex`` (lowercase)."""
    actual = hashlib.sha256(data).hexdigest()
    expected = expected_hex.lower()
    if actual != expected:
        raise ChecksumError("Checksum mismatch.")


_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")


def _is_hex(s: str) -> bool:
    # Strict: hex digits only. int(s, 16) would accept "0x", "+", "-",
    # and surrounding whitespace.
    return bool(s) and all(c in _HEX_DIGITS for c in s)
