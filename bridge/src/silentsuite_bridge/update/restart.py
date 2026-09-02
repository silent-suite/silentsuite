"""Injectable restart handling and exact recovery instruction."""

from __future__ import annotations

import os as _os
import subprocess as _subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RestartResult:
    success: bool
    instruction: str | None = None


# A single function that builds the canonical manual-restart instruction
# using only the installed executable path — never a staging path.
def _manual_instruction(exe_path: Path) -> str:
    return f"Run manually: {exe_path}"


class ProcessAdapter:
    """Restart the bridge via platform-appropriate mechanisms."""

    def restart(self, exe_path: Path, platform_name: str) -> RestartResult:
        if platform_name == "linux":
            return self._linux_restart(exe_path)
        if platform_name == "macos":
            return self._macos_restart(exe_path)
        # Windows restart is handled by the helper script after process exit.
        # Do not attempt a second restart here — the helper owns it.
        if platform_name == "windows":
            return RestartResult(success=True)
        return RestartResult(
            success=False,
            instruction=_manual_instruction(exe_path),
        )

    # -- Linux (systemd user service) --

    def _linux_restart(self, exe_path: Path) -> RestartResult:
        try:
            result = _subprocess.run(
                ["systemctl", "--user", "restart", "silentsuite-bridge.service"],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if result.returncode == 0:
                return RestartResult(success=True)
        except (
            FileNotFoundError,
            _subprocess.TimeoutExpired,
            OSError,
        ):
            pass

        return RestartResult(
            success=False,
            instruction=_manual_instruction(exe_path),
        )

    # -- macOS (launchd via kickstart) --

    def _macos_restart(self, exe_path: Path) -> RestartResult:
        plist = _os.path.expanduser(
            "~/Library/LaunchAgents/io.silentsuite.bridge.plist"
        )
        if not _os.path.exists(plist):
            return RestartResult(
                success=False,
                instruction=_manual_instruction(exe_path),
            )

        # Use kickstart to restart the existing agent in place.
        # launchctl kickstart -k gui/<uid>/io.silentsuite.bridge
        try:
            uid = _os.getuid()
        except AttributeError:
            uid = _os.geteuid()
        label = "gui/{}/io.silentsuite.bridge".format(uid)

        try:
            result = _subprocess.run(
                ["launchctl", "kickstart", "-k", label],
                capture_output=True, text=True, timeout=10, check=False,
            )
            if result.returncode == 0:
                return RestartResult(success=True)
        except (
            FileNotFoundError,
            _subprocess.TimeoutExpired,
            OSError,
        ):
            pass

        return RestartResult(
            success=False,
            instruction=_manual_instruction(exe_path),
        )


def restart_bridge(
    *,
    process,
    exe_path: Path,
    platform: str,
) -> RestartResult:
    result = process.restart(exe_path=exe_path, platform_name=platform)
    if result.success:
        return RestartResult(success=True)
    return RestartResult(
        success=False,
        instruction=_manual_instruction(exe_path),
    )
