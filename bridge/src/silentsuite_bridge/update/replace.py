"""Fetch → parse → download → verify → replace ordering."""

from __future__ import annotations

import stat
from pathlib import Path
from typing import TYPE_CHECKING

from .fs import FilesystemAdapter
from .http import MAX_CHECKSUM_BYTES
from .types import Platform, ReplaceResult
from .verify import parse_checksum, verify_asset

if TYPE_CHECKING:
    from .http import SilentSuiteHttpAdapter


def replace_bridge(
    *,
    http: SilentSuiteHttpAdapter,
    fs: FilesystemAdapter | None,
    platform: Platform,
    current_exe: Path,
    asset_url: str,
    checksum_url: str,
    asset_name: str,
) -> ReplaceResult:
    """Download, verify, and replace the running bridge executable."""

    if fs is None:
        fs = FilesystemAdapter()

    # 1. Download and parse checksum (small file, explicit limit)
    checksum_bytes = http.download(checksum_url, max_size=MAX_CHECKSUM_BYTES)
    expected_hex = parse_checksum(checksum_bytes, expected_asset_name=asset_name)

    # 2. Download binary
    binary_bytes = http.download(asset_url)

    # 3. Verify before any live-path operation
    verify_asset(binary_bytes, expected_hex)

    # 4. Snapshot original mode (before any mutation)
    orig_mode: int | None = None
    if platform.os_name != "windows":
        orig_mode = stat.S_IMODE(fs.stat_mode(str(current_exe)))

    # 5. Stage candidate
    staged_path = fs.stage(str(current_exe), binary_bytes)

    # Apply original permissions to staged candidate (POSIX)
    if orig_mode is not None:
        try:
            fs.chmod(staged_path, orig_mode)
        except Exception:
            fs.remove(staged_path)
            raise

    # 6. Replace
    if platform.os_name == "windows":
        return _windows_replace(
            fs=fs,
            staged_path=Path(staged_path),
            current_exe=current_exe,
        )

    # POSIX atomic replace — candidate already has correct mode
    try:
        fs.replace(staged_path, str(current_exe))
    except Exception:
        fs.remove(staged_path)
        raise

    return ReplaceResult(success=True)


def _windows_replace(
    *,
    fs: FilesystemAdapter,
    staged_path: Path,
    current_exe: Path,
) -> ReplaceResult:
    """Windows: write plan + static helper, launch helper.  Never
    overwrite the running .exe in-process.  On helper launch failure,
    remove all staging artifacts, leave the original untouched, and
    return failure with a target-only recovery instruction.
    """
    import os as _os

    pid = _os.getpid()
    backup_path = current_exe.parent / f"{current_exe.name}.update-backup"

    plan = {
        "pid": pid,
        "candidate": str(staged_path),
        "target": str(current_exe),
        "backup": str(backup_path),
    }

    try:
        # Write the JSON plan and static helper that reads it from argv.
        plan_path = fs.write_staging_plan(plan)
        helper_path = fs.write_windows_helper(plan_path)
    except Exception:
        fs.remove(staged_path)
        raise

    # Launch helper (argv list, no shell interpolation)
    launched = fs.launch_helper(helper_path, plan_path)

    if launched:
        # Verified candidate is staged; the swap completes after this
        # process exits.
        return ReplaceResult(success=True, pending_completion=True)

    fs.remove(helper_path)
    fs.remove(plan_path)
    fs.remove(staged_path)
    return ReplaceResult(
        success=False,
        pending_completion=False,
        recovery_instruction=(
            "The update could not be completed; the installed Bridge is "
            f"unchanged. Run manually: {current_exe}"
        ),
    )
