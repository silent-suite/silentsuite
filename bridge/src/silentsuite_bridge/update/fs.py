"""Filesystem adapter for safe staging and replacement.

Private staging, POSIX atomic swap, Windows structured helper-plan
creation/launch.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

# Static Windows post-exit swap helper. It receives the plan file path as
# its only argument — no paths are ever interpolated into this source.
# Restricted to Windows PowerShell 5.1-compatible constructs.
_WINDOWS_HELPER_SCRIPT = r"""# SilentSuite Bridge self-update helper. Do not edit.
# Reads the update plan from the first argument; contains no embedded paths.
param(
    [Parameter(Mandatory=$true)]
    [string]$PlanFile
)

$ErrorActionPreference = 'Stop'

try {
    $plan = Get-Content -Raw -Path $PlanFile | ConvertFrom-Json
} catch {
    Write-Host 'ERROR: could not read the update plan.'
    exit 1
}

$Candidate = [string]$plan.candidate
$Target = [string]$plan.target
$Backup = [string]$plan.backup
$OldPid = "$($plan.pid)"
$HelperFile = $MyInvocation.MyCommand.Path
$plan_dir = Split-Path -Path $Target -Parent

function Remove-UpdateArtifacts {
    Remove-Item -Force -Path $PlanFile -ErrorAction SilentlyContinue
    Remove-Item -Force -Path $HelperFile -ErrorAction SilentlyContinue
}

function Remove-StagedCandidate {
    Remove-Item -Force -Path $Candidate -ErrorAction SilentlyContinue
}

# --- Validate the plan before touching anything ---
foreach ($p in @($Candidate, $Target, $Backup)) {
    if (-not ($p -match '^[A-Za-z]:[\\/].+')) {
        Write-Host 'ERROR: update plan paths must be absolute.'
        Remove-UpdateArtifacts
        exit 1
    }
}
if (-not $Candidate.EndsWith('.update-staged')) {
    Write-Host 'ERROR: candidate does not have the expected staging suffix.'
    Remove-UpdateArtifacts
    exit 1
}
if (($Candidate -eq $Target) -or ($Backup -eq $Target)) {
    Write-Host 'ERROR: update plan paths collide with the installed target.'
    Remove-UpdateArtifacts
    exit 1
}
if (((Split-Path -Path $Candidate -Parent) -ne $plan_dir) -or
    ((Split-Path -Path $Backup -Parent) -ne $plan_dir)) {
    Write-Host 'ERROR: update plan paths are not in the installed directory.'
    Remove-UpdateArtifacts
    exit 1
}
if (-not ($OldPid -match '^[0-9]+$')) {
    Write-Host 'ERROR: invalid process id in update plan.'
    Remove-UpdateArtifacts
    exit 1
}

# --- Bounded wait for the old process to exit ---
$WaitSeconds = 30
$exited = $true
$old = Get-Process -Id ([int]$OldPid) -ErrorAction SilentlyContinue
if ($old) {
    try {
        $exited = $old.WaitForExit($WaitSeconds * 1000)
    } catch {
        $exited = $true
    }
}
if (-not $exited) {
    Write-Host 'ERROR: the running bridge did not exit; the installed Bridge is unchanged.'
    Remove-StagedCandidate
    Remove-UpdateArtifacts
    exit 1
}

# --- The installed target must still exist as a rollback source ---
if (-not (Test-Path -Path $Target)) {
    Write-Host 'ERROR: the installed Bridge executable was not found.'
    Write-Host 'Refusing to install without a rollback source; nothing was changed.'
    Remove-StagedCandidate
    Remove-UpdateArtifacts
    exit 1
}

# --- Back up the installed executable ---
try {
    Move-Item -Force -Path $Target -Destination $Backup -ErrorAction Stop
} catch {
    Write-Host 'ERROR: could not back up the installed Bridge; it is unchanged.'
    Remove-StagedCandidate
    Remove-UpdateArtifacts
    exit 1
}

# --- Move the verified candidate into place, rolling back on failure ---
try {
    Move-Item -Force -Path $Candidate -Destination $Target -ErrorAction Stop
} catch {
    Write-Host 'ERROR: could not install the update; restoring the previous Bridge.'
    try {
        Move-Item -Force -Path $Backup -Destination $Target -ErrorAction Stop
    } catch {
        Write-Host "ERROR: automatic restore failed. Run manually: $Target"
    }
    Remove-StagedCandidate
    Remove-UpdateArtifacts
    exit 1
}

# --- Restart the exact installed target only ---
try {
    Start-Process -FilePath $Target -WindowStyle Hidden -ErrorAction Stop
    # The new process was created successfully; rollback is no longer needed.
    Remove-Item -Force -Path $Backup -ErrorAction SilentlyContinue
} catch {
    Write-Host 'ERROR: the updated Bridge did not restart; restoring the previous Bridge.'
    try {
        Remove-Item -Force -Path $Target -ErrorAction Stop
        Move-Item -Force -Path $Backup -Destination $Target -ErrorAction Stop
        Write-Host "The previous Bridge was restored. Run manually: $Target"
    } catch {
        Write-Host "ERROR: automatic restore failed. Run manually: $Target"
    }
}

Remove-UpdateArtifacts
exit 0
"""


class FilesystemAdapter:
    """Abstract filesystem operations for testability."""

    # ------------------------------------------------------------------
    # staging
    # ------------------------------------------------------------------

    def stage(self, target_path: str | Path, data: bytes) -> str:
        """Write full `data` to a private temp file on the same filesystem
        as `target_path`, fsync it, and return the path.  Removes
        partial files on failure.
        """
        target = Path(target_path).resolve()
        parent = target.parent
        suffix = ".update-staged"
        fd, staged_path = tempfile.mkstemp(suffix=suffix, dir=str(parent))
        try:
            write_error: BaseException | None = None
            try:
                _write_all(fd, data)
                os.fsync(fd)
            except Exception as exc:
                write_error = exc
            # Close exactly once, and always before unlink — Windows
            # refuses to remove a file with an open descriptor.
            try:
                os.close(fd)
            except OSError:
                # A close failure must not mask the original error; on
                # an otherwise-successful write it is itself fatal.
                if write_error is None:
                    raise
            if write_error is not None:
                raise write_error
        except Exception:
            try:
                os.unlink(staged_path)
            except OSError:
                pass
            raise
        return staged_path

    def chmod(self, path: str | Path, mode: int) -> None:
        os.chmod(str(path), mode)

    def remove(self, path: str | Path) -> None:
        try:
            os.unlink(str(path))
        except OSError:
            pass

    # ------------------------------------------------------------------
    # POSIX atomic replace
    # ------------------------------------------------------------------

    def replace(self, src: str | Path, dst: str | Path) -> None:
        os.replace(str(src), str(dst))

    def stat_mode(self, path: str | Path) -> int:
        """Return ``os.stat(...).st_mode`` for the path."""
        return os.stat(str(path)).st_mode

    def cleanup(self) -> None:
        pass

    # ------------------------------------------------------------------
    # Windows structured staging plan
    # ------------------------------------------------------------------

    def write_staging_plan(self, plan: dict[str, Any]) -> str:
        """Serialize `plan` as JSON and write it next to the candidate."""
        plan = dict(plan)
        candidate = Path(plan["candidate"])
        plan_path = candidate.parent / f"{candidate.name}.update-plan.json"
        _write_private_text(plan_path, json.dumps(plan, indent=2))
        return str(plan_path)


    def write_windows_helper(self, plan_path: str) -> str:
        """Create a static PowerShell helper script that reads the JSON
        plan from an argv element (no path interpolation into source).

        Returns the helper file path.
        """
        candidate = Path(plan_path).parent / (
            Path(plan_path).name.replace(".update-plan.json", "")
        )
        parent = Path(plan_path).parent
        helper_path = parent / f"{candidate.name}.update-helper.ps1"

        _write_private_text(helper_path, _WINDOWS_HELPER_SCRIPT)
        return str(helper_path)

    def launch_helper(self, helper_path: str, plan_path: str) -> bool:
        """Launch PowerShell via argv list: powershell.exe -File helper
        with the plan path as the first positional argument.
        No shell interpolation.
        """
        import subprocess

        try:
            subprocess.Popen(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy", "Bypass",
                    "-File", str(helper_path),
                    str(plan_path),
                ],
                creationflags=(
                    subprocess.CREATE_NO_WINDOW
                    if sys.platform == "win32"
                    else 0
                ),
            )
            return True
        except Exception:
            return False


def _write_all(fd: int, data: bytes) -> None:
    offset = 0
    while offset < len(data):
        written = os.write(fd, data[offset:])
        if written == 0:
            raise OSError("Short write during staging")
        offset += written


def _write_private_text(path: Path, content: str) -> None:
    data = content.encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        write_error: BaseException | None = None
        try:
            _write_all(fd, data)
            os.fsync(fd)
        except Exception as exc:
            write_error = exc
        # Close exactly once, and always before unlink — Windows refuses
        # to remove a file with an open descriptor.
        try:
            os.close(fd)
        except OSError:
            if write_error is None:
                raise
        if write_error is not None:
            raise write_error
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
