"""Admitted Ubuntu package versions for the Linux desktop dev build (#171).

The licence gate refuses bundled OS libraries whose dpkg version differs from the admitted
policy's os_package pins (their offered source would no longer match). Runner images and
the live archive move on, so the package job installs exactly the admitted versions from
the admitted snapshot.ubuntu.com state before it builds:

  python os_packages.py apt-source --records notices/source-archives.json   # apt lines
  python os_packages.py apt-pins --policy notices/policy-linux-x86_64.json   # package=version

Exit 0 printed, 2 refused or unreadable input.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

PACKAGE = re.compile(r"^[a-z0-9][a-z0-9.+-]*(:[a-z0-9]+)?$")
VERSION = re.compile(r"^[0-9][A-Za-z0-9.+~:-]*$")
SNAPSHOT = re.compile(r"^\d{8}T\d{6}Z$")
NAME = re.compile(r"^[a-z0-9-]+$")


class InputError(Exception):
    pass


def apt_pins(policy) -> list[str]:
    versions: dict[str, str] = {}
    for rule in policy.get("runtime_files") or []:
        pin = rule.get("os_package")
        if pin is None:
            continue
        package, version = pin.get("package"), pin.get("version")
        if not isinstance(package, str) or not PACKAGE.match(package) or \
                not isinstance(version, str) or not VERSION.match(version):
            raise InputError(f"{rule.get('pattern')}: unsafe or missing package/version")
        if versions.setdefault(package, version) != version:
            raise InputError(f"{package}: pinned to two versions")
    return [f"{package}={version}" for package, version in sorted(versions.items())]


def apt_source(records) -> list[str]:
    archive = records.get("ubuntu_archive") or {}
    if not SNAPSHOT.match(str(archive.get("snapshot", ""))) or not archive.get("suites") \
            or not all(NAME.match(str(x)) for x in archive["suites"] + list(archive.get("components") or [])):
        raise InputError("missing or malformed ubuntu_archive settings")
    base = f"https://snapshot.ubuntu.com/ubuntu/{archive['snapshot']}"
    return [f"deb {base} {suite} {' '.join(archive['components'])}" for suite in archive["suites"]]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Admitted Ubuntu package versions for the dev build.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("apt-pins").add_argument("--policy", required=True, type=Path)
    sub.add_parser("apt-source").add_argument("--records", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        path = args.policy if args.command == "apt-pins" else args.records
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        lines = apt_pins(data) if args.command == "apt-pins" else apt_source(data)
    except (InputError, OSError, ValueError) as exc:
        print(f"os_packages {args.command}: {exc}", file=sys.stderr)
        return 2
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
