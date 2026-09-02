"""Release lookup and deterministic version comparison."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from .platform import PlatformMapping
from .types import CheckResult, Platform, ReleaseInfo, UpdateStatus

if TYPE_CHECKING:
    from .http import SilentSuiteHttpAdapter

# A valid release version is X.Y.Z[-prerelease] where X/Y/Z are non-negative
# integers.  Anything else is unknown/development.
_VERSION_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

# Reserved stamps that satisfy the SemVer grammar but never denote a
# release: the source-tree development stamp and the unknown placeholder.
_RESERVED_DEV_VERSIONS = frozenset({"0.0.0-dev", "0.0.0"})


def version_is_stable(version: str) -> bool:
    """Return True if `version` looks like a valid release version."""
    if not version:
        return False
    if version in _RESERVED_DEV_VERSIONS:
        return False
    return bool(_VERSION_RE.match(version))


def _compare_versions(a: str, b: str) -> int:
    """Strict SemVer-like comparison.

    Negative if a < b, 0 if equal, positive if a > b.

    Prerelease identifiers: numeric ones sort numerically and compare
    as *lower* than non-numeric identifiers (per SemVer 2.0).
    No prerelease > any prerelease.  Build metadata (after '+') is
    stripped before comparison.
    """
    a_parts, a_pre = _split_version(a)
    b_parts, b_pre = _split_version(b)

    # Compare major.minor.patch
    for an, bn in zip(a_parts, b_parts):
        if an != bn:
            return an - bn

    # Compare prerelease
    if not a_pre and not b_pre:
        return 0
    if not a_pre:
        return 1
    if not b_pre:
        return -1

    # Both have prerelease — element by element
    for ae, be in zip(a_pre, b_pre):
        a_num = _try_int(ae)
        b_num = _try_int(be)
        if a_num is not None and b_num is not None:
            if a_num != b_num:
                return a_num - b_num
        elif a_num is not None or b_num is not None:
            # Numeric sorts lower
            return 1 if a_num is None else -1
        else:
            if ae != be:
                return -1 if ae < be else 1

    return len(a_pre) - len(b_pre)


def _try_int(s: str) -> int | None:
    # SemVer: an identifier is numeric only if it consists solely of digits.
    # int() alone would also accept "+1"/"-1"/" 1".
    if s.isdigit():
        return int(s)
    return None


def _split_version(v: str):
    """Split `v` into ([major, minor, patch], [prerelease ...]).

    Strips build metadata after '+'.  Returned numeric parts are always
    length 3.
    """
    if "+" in v:
        v = v.split("+", 1)[0]
    if "-" in v:
        main, pre = v.split("-", 1)
        main_parts = _parse_numeric_parts(main)
        pre_parts = pre.split(".")
    else:
        main_parts = _parse_numeric_parts(v)
        pre_parts: list[str] = []
    return main_parts, pre_parts


def _parse_numeric_parts(s: str) -> list[int]:
    """Parse exactly three non-negative integer version parts or raise."""
    parts = s.split(".")
    if len(parts) != 3:
        # Allow the caller to handle by treating as zero-padded. The regex
        # already enforces exactly 3 parts for valid versions.
        raise ValueError(f"Expected 3 numeric parts, got {len(parts)}")
    return [int(p) for p in parts]


def check_for_update(
    *,
    http: SilentSuiteHttpAdapter,
    platform: Platform,
    current_version: str,
) -> CheckResult:
    """Check GitHub Releases for a newer compatible release."""

    # Unsupported platform → no network
    asset_name = PlatformMapping.asset_name(platform.os_name, platform.arch)
    if asset_name is None:
        return CheckResult(
            status=UpdateStatus.UNSUPPORTED,
            current_version=current_version,
        )

    # Development / unknown version → no network
    if not version_is_stable(current_version):
        return CheckResult(
            status=UpdateStatus.DEVELOPMENT,
            current_version=current_version,
        )

    # Fetch releases
    try:
        releases = http.fetch_releases()
    except Exception:
        return CheckResult(
            status=UpdateStatus.FAILURE,
            current_version=current_version,
            error_message="Could not fetch release information.",
        )

    # Find the newest non-draft release with compatible assets.
    # Reject malformed release tags as candidates (they cannot be
    # valid versions).
    best: ReleaseInfo | None = None
    checksum_asset = PlatformMapping.checksum_asset_name(asset_name)

    for rel in releases:
        if not isinstance(rel, dict):
            continue
        if rel.get("draft", False):
            continue

        tag = rel.get("tag_name", "")
        if not isinstance(tag, str) or not tag:
            continue
        version = tag[1:] if tag.startswith("v") else tag
        if not version:
            continue

        # Reject malformed release versions — don't offer them.
        if not _VERSION_RE.match(version):
            continue

        assets = rel.get("assets", [])
        if not isinstance(assets, list):
            continue
        matching = [a for a in assets if isinstance(a, dict) and a.get("name") == asset_name]
        matching_checksums = [
            a for a in assets
            if isinstance(a, dict) and a.get("name") == checksum_asset
        ]

        if len(matching) != 1 or len(matching_checksums) != 1:
            continue

        asset_url = matching[0].get("browser_download_url")
        checksum_url = matching_checksums[0].get("browser_download_url")
        if not isinstance(asset_url, str) or not isinstance(checksum_url, str):
            continue

        candidate = ReleaseInfo(
            tag_name=tag,
            version=version,
            asset_url=asset_url,
            checksum_url=checksum_url,
            asset_name=asset_name,
        )

        if best is None or _compare_versions(candidate.version, best.version) > 0:
            best = candidate

    if best is None:
        return CheckResult(
            status=UpdateStatus.MISSING_ASSET,
            current_version=current_version,
        )

    # Compare current vs best
    cmp = _compare_versions(best.version, current_version)
    if cmp > 0:
        return CheckResult(
            status=UpdateStatus.AVAILABLE,
            current_version=current_version,
            tag_name=best.tag_name,
            release=best,
        )
    if cmp == 0:
        return CheckResult(
            status=UpdateStatus.CURRENT,
            current_version=current_version,
            tag_name=best.tag_name,
            release=best,
        )
    return CheckResult(
        status=UpdateStatus.DOWNGRADE,
        current_version=current_version,
        tag_name=best.tag_name,
        release=best,
    )
