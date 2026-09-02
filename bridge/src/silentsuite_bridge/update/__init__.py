"""SilentSuite Bridge — safe self-update (Issue #223).

Provides --check-update and --self-update CLI entry points.
All I/O is injected via adapters so contract tests can verify
behaviour with fakes/spies.
"""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from .platform import PlatformMapping
from .types import CheckResult, Platform, ReplaceResult, UpdateStatus

if TYPE_CHECKING:
    from .fs import FilesystemAdapter
    from .http import SilentSuiteHttpAdapter
    from .restart import ProcessAdapter

# ---------------------------------------------------------------------------
# Public helpers (CLI wiring)
# ---------------------------------------------------------------------------


def _default_http():
    from .http import SilentSuiteHttpAdapter

    return SilentSuiteHttpAdapter()


def _detect_platform() -> Platform:
    os_name = {"linux": "linux", "darwin": "macos", "win32": "windows"}.get(
        sys.platform, sys.platform
    )
    m = os.environ.get("SILENTSUITE_BRIDGE_TEST_MACHINE", platform.machine())
    return Platform(os_name=os_name, arch=m)


def _current_version() -> str:
    from .. import __version__

    return __version__


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _current_exe() -> Path | None:
    if not _is_frozen():
        return None
    p = Path(sys.executable).resolve()
    if p.exists():
        return p
    return None


def _is_writable(path: Path) -> bool:
    try:
        return os.access(path, os.W_OK) and os.access(path.parent, os.W_OK)
    except OSError:
        return False


def _is_development(version: str) -> bool:
    from .check import version_is_stable

    return not version_is_stable(version)


# ---------------------------------------------------------------------------
# check_for_update  (read-only)
# ---------------------------------------------------------------------------


def check_for_update(
    *,
    http: SilentSuiteHttpAdapter | None = None,
    platform: Platform | None = None,
    current_version: str | None = None,
) -> CheckResult:
    """Check for a newer compatible release. Never mutates the filesystem."""
    from .check import check_for_update as _check

    if http is None:
        http = _default_http()
    if platform is None:
        platform = _detect_platform()
    if current_version is None:
        current_version = _current_version()

    return _check(
        http=http,
        platform=platform,
        current_version=current_version,
    )


# ---------------------------------------------------------------------------
# perform_update
# ---------------------------------------------------------------------------


def perform_update(
    *,
    http: SilentSuiteHttpAdapter | None = None,
    fs: FilesystemAdapter | None = None,
    restart: ProcessAdapter | None = None,
    admission=None,
    platform: Platform | None = None,
    current_exe: Path | None = None,
    current_version: str | None = None,
    asset_name: str | None = None,
) -> ReplaceResult:
    """Orchestrate a safe self-update.

    Admission checks first (frozen, known/writable executable,
    non-development version). Then release check, download, verify,
    replace, restart.  Same-version and downgrade always refuse.
    """
    from .check import check_for_update as _check
    from .replace import replace_bridge
    from .restart import ProcessAdapter, restart_bridge

    if http is None:
        http = _default_http()
    if platform is None:
        platform = _detect_platform()
    if current_version is None:
        current_version = _current_version()

    # --- Admission ---
    if admission is not None:
        frozen = admission.is_frozen()
        exe = admission.current_exe()
        writable = admission.is_writable(exe) if exe is not None else False
    else:
        frozen = _is_frozen()
        exe = current_exe or _current_exe()
        writable = _is_writable(exe) if exe is not None else False

    if not frozen:
        raise RuntimeError(
            "Self-update requires a release (frozen) binary installation."
        )

    if exe is None:
        raise RuntimeError(
            "Cannot determine the installed bridge executable location."
        )

    if not writable:
        raise RuntimeError(
            "The installed bridge executable or its parent directory "
            "is not writable."
        )

    if _is_development(current_version):
        raise RuntimeError(
            "Self-update is not available for development builds."
        )

    # --- Check ---
    result = _check(http=http, platform=platform, current_version=current_version)

    # Same version or downgrade → always refuse. No override.
    if result.status == UpdateStatus.CURRENT:
        raise RuntimeError(
            "The installed Bridge is already current."
        )
    if result.status == UpdateStatus.DOWNGRADE:
        raise RuntimeError("Refusing to downgrade the installed Bridge.")

    if result.status in (
        UpdateStatus.DEVELOPMENT,
        UpdateStatus.UNSUPPORTED,
        UpdateStatus.MISSING_ASSET,
        UpdateStatus.FAILURE,
    ):
        raise RuntimeError("Update not available.")

    # result.status == AVAILABLE
    chosen = result.release
    if chosen is None or not chosen.asset_url or not chosen.checksum_url:
        raise RuntimeError("No compatible release asset found.")

    if asset_name is None:
        asset_name = PlatformMapping.asset_name(platform.os_name, platform.arch)
    if asset_name is None:
        raise RuntimeError(
            f"Unsupported platform: {platform.os_name}/{platform.arch}"
        )

    replace_result = replace_bridge(
        http=http,
        fs=fs,
        platform=platform,
        current_exe=exe,
        asset_url=chosen.asset_url,
        checksum_url=chosen.checksum_url,
        asset_name=asset_name,
    )

    # Restart — Windows restart is owned by the helper script; do not
    # double-restart here.
    if platform.os_name == "windows":
        return replace_result

    if restart is None:
        restart = ProcessAdapter()
    # restart_bridge centrally rebuilds the manual instruction from the
    # installed target path, discarding any adapter-supplied text.
    restart_result = restart_bridge(
        process=restart, exe_path=exe, platform=platform.os_name
    )
    if not restart_result.success:
        return ReplaceResult(
            success=True,
            pending_completion=False,
            recovery_instruction=restart_result.instruction,
        )
    return replace_result
