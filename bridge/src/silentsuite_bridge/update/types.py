"""Bounded result and exception dataclasses/enums."""

from __future__ import annotations

import enum
from dataclasses import dataclass


class UpdateStatus(enum.Enum):
    AVAILABLE = "available"
    CURRENT = "current"
    DOWNGRADE = "downgrade"
    DEVELOPMENT = "development"
    UNSUPPORTED = "unsupported"
    MISSING_ASSET = "missing_asset"
    FAILURE = "failure"


@dataclass(frozen=True)
class Platform:
    os_name: str   # "linux", "macos", "windows"
    arch: str      # "x86_64", "amd64", "arm64", "aarch64"


@dataclass(frozen=True)
class ReleaseInfo:
    tag_name: str
    version: str   # tag with leading "v" stripped
    asset_url: str
    checksum_url: str
    asset_name: str


@dataclass(frozen=True)
class CheckResult:
    status: UpdateStatus
    current_version: str = ""
    tag_name: str | None = None
    release: ReleaseInfo | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class ReplaceResult:
    """Outcome of a replace attempt.

    ``pending_completion`` is True when a verified candidate is staged and
    the swap finishes after this process exits (Windows helper path).
    ``recovery_instruction`` only ever names the installed target path.
    """

    success: bool
    pending_completion: bool = False
    recovery_instruction: str | None = None


class ChecksumError(ValueError):
    """Raised for any checksum verification failure."""


class HttpError(RuntimeError):
    """Raised for HTTP / network errors."""
