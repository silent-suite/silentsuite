"""The closed asset inventory of one SilentSuite umbrella release.

Three workflows append to a single draft release, none of them able to see what
the others produced. This module is the one place that says what "complete"
means, so the component attachment jobs, the readiness gate, and the contract
tests cannot drift into three different answers.

Adding a component asset means editing this inventory; a release whose draft
does not match it exactly is reported incomplete and must not be published.
"""

from __future__ import annotations

import re

TAG_PATTERN = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$")

# The five platforms the bridge lane builds. The asset name is also the
# PyInstaller output name, so the Windows entry keeps its .exe suffix.
BRIDGE_PLATFORMS = (
    "linux-x86_64",
    "linux-arm64",
    "macos-x86_64",
    "macos-arm64",
    "windows-x86_64.exe",
)
BRIDGE_CHECKSUM_MANIFEST = "SHA256SUMS.txt"
SELF_HOST_MANIFEST = "server-image.json"
UMBREL_MANIFEST = "umbrel-images.json"


class InventoryError(ValueError):
    """A release draft does not match the published umbrella inventory."""


def _require_tag(tag: str) -> str:
    if not TAG_PATTERN.fullmatch(tag):
        raise InventoryError(f"tag {tag!r} is not an immutable release tag")
    return tag


def android_assets(tag: str) -> tuple[str, ...]:
    _require_tag(tag)
    return (
        f"silentsuite-android-{tag}.apk",
        f"silentsuite-android-{tag}-installer.sha256",
        f"silentsuite-android-{tag}.aab",
        f"silentsuite-android-{tag}-bundle.sha256",
        f"silentsuite-android-{tag}-native-debug-symbols.zip",
        f"silentsuite-android-{tag}-native-debug-symbols.sha256",
    )


def bridge_assets(tag: str) -> tuple[str, ...]:
    _require_tag(tag)
    names: list[str] = []
    for platform in BRIDGE_PLATFORMS:
        names.append(f"silentsuite-bridge-{platform}")
        names.append(f"silentsuite-bridge-{platform}.sha256")
    names.append(BRIDGE_CHECKSUM_MANIFEST)
    return tuple(names)


def self_host_assets(tag: str) -> tuple[str, ...]:
    _require_tag(tag)
    return (
        f"silentsuite-self-host-{tag}.tar.gz",
        f"silentsuite-self-host-{tag}.tar.gz.sha256",
        SELF_HOST_MANIFEST,
        UMBREL_MANIFEST,
    )


def components(tag: str) -> dict[str, tuple[str, ...]]:
    return {
        "android": android_assets(tag),
        "bridge": bridge_assets(tag),
        "self-host": self_host_assets(tag),
    }


def expected_assets(tag: str) -> tuple[str, ...]:
    names: list[str] = []
    for component_names in components(tag).values():
        names.extend(component_names)
    if len(set(names)) != len(names):
        raise InventoryError("the umbrella inventory names an asset twice")
    return tuple(sorted(names))


# Every checksum sidecar in the inventory and the asset whose bytes it covers.
def checksum_pairs(tag: str) -> tuple[tuple[str, str], ...]:
    _require_tag(tag)
    pairs = [
        (f"silentsuite-android-{tag}-installer.sha256", f"silentsuite-android-{tag}.apk"),
        (f"silentsuite-android-{tag}-bundle.sha256", f"silentsuite-android-{tag}.aab"),
        (
            f"silentsuite-android-{tag}-native-debug-symbols.sha256",
            f"silentsuite-android-{tag}-native-debug-symbols.zip",
        ),
        (
            f"silentsuite-self-host-{tag}.tar.gz.sha256",
            f"silentsuite-self-host-{tag}.tar.gz",
        ),
    ]
    for platform in BRIDGE_PLATFORMS:
        pairs.append(
            (f"silentsuite-bridge-{platform}.sha256", f"silentsuite-bridge-{platform}")
        )
    return tuple(pairs)
