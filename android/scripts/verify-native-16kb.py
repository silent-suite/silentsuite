#!/usr/bin/env python3
"""Verify Android native libraries are compatible with 16 KB page sizes.

Scans APK, AAB, or AAR files as zip archives. Every Android shared library
under arm64-v8a or x86_64 must have ELF LOAD segment alignment of 0x4000 or
greater. The Google Play 16 KB requirement applies to 64-bit devices; 32-bit
ABIs are ignored by this gate.
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict

REQUIRED_64_BIT_ABIS = {"arm64-v8a", "x86_64"}
KNOWN_ANDROID_ABIS = REQUIRED_64_BIT_ABIS | {"armeabi-v7a", "x86"}


def abi_for_entry(name: str) -> str | None:
    parts = pathlib.PurePosixPath(name).parts
    for part in parts:
        if part in KNOWN_ANDROID_ABIS:
            return part
    return None


def load_alignments(path: pathlib.Path) -> list[int]:
    output = subprocess.check_output(["readelf", "-lW", str(path)], text=True)
    lines = output.splitlines()
    alignments: list[int] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("LOAD"):
            continue
        fields = stripped.split()
        if fields and fields[-1].startswith("0x"):
            alignments.append(int(fields[-1], 16))
        elif index + 1 < len(lines):
            alignments.append(int(lines[index + 1].split()[-1], 16))
    return alignments


def verify_archive(archive: pathlib.Path, required_libs: set[str]) -> bool:
    ok = True
    checked = 0
    seen_by_abi: dict[str, set[str]] = defaultdict(set)
    with zipfile.ZipFile(archive) as zf, tempfile.TemporaryDirectory() as tmpdir:
        tmp = pathlib.Path(tmpdir)
        for info in zf.infolist():
            if not info.filename.endswith(".so"):
                continue
            abi = abi_for_entry(info.filename)
            if abi not in REQUIRED_64_BIT_ABIS:
                continue
            checked += 1
            lib_name = pathlib.PurePosixPath(info.filename).name
            seen_by_abi[abi].add(lib_name)
            out = tmp / f"{abi}-{lib_name}"
            out.write_bytes(zf.read(info.filename))
            alignments = load_alignments(out)
            formatted = ", ".join(hex(value) for value in alignments) or "none"
            if alignments and all(value >= 0x4000 for value in alignments):
                print(f"ALIGNED   {archive}: {info.filename}: {formatted}")
            else:
                print(f"UNALIGNED {archive}: {info.filename}: {formatted}")
                ok = False
    if checked == 0:
        print(f"error: no 64-bit Android shared libraries found in {archive}", file=sys.stderr)
        ok = False
    for abi in sorted(REQUIRED_64_BIT_ABIS):
        missing = sorted(required_libs - seen_by_abi.get(abi, set()))
        if missing:
            print(
                f"error: {archive}: missing required 64-bit libraries for {abi}: {', '.join(missing)}",
                file=sys.stderr,
            )
            ok = False
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-lib",
        action="append",
        default=[],
        help="Shared-library basename that must be present for both arm64-v8a and x86_64. Repeatable.",
    )
    parser.add_argument("archives", nargs="+", type=pathlib.Path)
    args = parser.parse_args()

    required_libs = set(args.require_lib)
    ok = True
    for archive in args.archives:
        if not archive.exists():
            print(f"error: archive does not exist: {archive}", file=sys.stderr)
            ok = False
            continue
        ok = verify_archive(archive, required_libs) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
