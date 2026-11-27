"""Canonical platform-to-asset mapping.

One authoritative source used by the updater. The five build assets
plus their exact .sha256 sidecar naming are defined here.
"""

from __future__ import annotations


class PlatformMapping:
    """Map (os_name, arch) → canonical release asset name.

    Canonical names:

        silentsuite-bridge-linux-x86_64
        silentsuite-bridge-linux-arm64
        silentsuite-bridge-macos-x86_64
        silentsuite-bridge-macos-arm64
        silentsuite-bridge-windows-x86_64.exe
    """

    _ARCH_MAP = {
        "x86_64": "x86_64",
        "amd64": "x86_64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }

    _ASSET_BY_OS_ARCH = {
        ("linux",   "x86_64"): "silentsuite-bridge-linux-x86_64",
        ("linux",   "arm64"):  "silentsuite-bridge-linux-arm64",
        ("macos",   "x86_64"): "silentsuite-bridge-macos-x86_64",
        ("macos",   "arm64"):  "silentsuite-bridge-macos-arm64",
        ("windows", "x86_64"): "silentsuite-bridge-windows-x86_64.exe",
    }

    @staticmethod
    def asset_name(os_name: str, arch: str) -> str | None:
        normalized = PlatformMapping._ARCH_MAP.get(arch)
        if normalized is None:
            return None
        return PlatformMapping._ASSET_BY_OS_ARCH.get((os_name, normalized))

    @staticmethod
    def checksum_asset_name(asset: str) -> str:
        return f"{asset}.sha256"

    @staticmethod
    def supported(os_name: str, arch: str) -> bool:
        return PlatformMapping.asset_name(os_name, arch) is not None

    # Labels for the platform this process runs on

    @staticmethod
    def get_os_label() -> str:
        import platform

        s = platform.system().lower()
        if s == "linux":
            return "linux"
        elif s == "darwin":
            return "macos"
        elif s == "windows":
            return "windows"
        raise RuntimeError(f"Unsupported OS: {s}")

    @staticmethod
    def get_arch_label() -> str:
        import platform

        m = platform.machine().lower()
        val = PlatformMapping._ARCH_MAP.get(m)
        if val is None:
            raise RuntimeError(f"Unsupported arch: {m}")
        return val
