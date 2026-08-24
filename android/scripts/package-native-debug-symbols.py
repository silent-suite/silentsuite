#!/usr/bin/env python3
"""Build the Play Console native debug-symbol ZIP from the rebuilt Etebase AAR.

AGP 8.11.1 does not emit a standalone `native-debug-symbols.zip` for this
project's release AAB: the project's native libraries arrive via prebuilt AAR
`.so` payloads, so the `mergeReleaseNativeDebugMetadata` task has no source and
`ndk.debugSymbolLevel` has nothing to package. Only the locally rebuilt 64-bit
Etebase libraries (`arm64-v8a` and `x86_64` copies of `libetebase_android.so`)
retain symbol tables; Conscrypt and the upstream 32-bit Etebase copies ship
pre-stripped and carry no symbols.

This script therefore produces the Play-compatible symbol ZIP manually, after
the release AAB has been built, directly from the same rebuilt Etebase AAR that
feeds the build. It packages exactly two entries:

    arm64-v8a/libetebase_android.so
    x86_64/libetebase_android.so

Each entry preserves the unstripped, symbol-bearing ELF payload. The script
fails closed on any missing, empty, or duplicated selected source entry, and
requires every selected ELF to expose a real `.symtab` (verified via
`readelf -S`, not guessed). The output ZIP is written atomically with
deterministic entry ordering, timestamps, and permissions so it is
reproducible byte-for-byte for the same inputs.
"""

from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

# The only symbol-bearing libraries available: the 64-bit Etebase copies rebuilt
# by android/scripts/build-etebase-client-16kb.sh. Conscrypt and the upstream
# 32-bit Etebase copies are pre-stripped and must not be included.
SYMBOL_ENTRIES = (
    ("arm64-v8a", "libetebase_android.so"),
    ("x86_64", "libetebase_android.so"),
)

# Fixed ZIP metadata for determinism. 1980-01-01 00:00:00 keeps every entry
# identical across runs regardless of when the build executes.
_FIXED_DATE_TIME = (1980, 1, 1, 0, 0, 0)


def aar_entry_sources(aar: pathlib.Path) -> dict[tuple[str, str], str]:
    """Map (abi, library) to the AAR's internal `jni/<abi>/<library>` entry name.

    The rebuilt Etebase AAR stores native libraries under `jni/<abi>/<name>.so`
    (see android/scripts/build-etebase-client-16kb.sh).
    """
    return {
        (abi, library): f"jni/{abi}/{library}" for abi, library in SYMBOL_ENTRIES
    }


def read_aar_payloads(aar: pathlib.Path) -> dict[tuple[str, str], bytes]:
    """Extract the required symbol-bearing ELF payloads from the rebuilt AAR.

    The rebuilt AAR legitimately retains the upstream 32-bit Etebase copies
    (``jni/armeabi-v7a/...`` and ``jni/x86/...``), so only the two selected
    ``jni/<abi>/libetebase_android.so`` entries are counted.  Each selected
    entry must occur exactly once; duplicates are rejected along with missing
    entries, and an empty selected payload fails closed.
    """
    sources = aar_entry_sources(aar)
    payloads: dict[tuple[str, str], bytes] = {}
    with zipfile.ZipFile(aar) as archive:
        names = archive.namelist()
        for pair, entry_name in sources.items():
            count = names.count(entry_name)
            if count == 0:
                raise SystemExit(
                    f"error: {aar}: missing rebuilt library entry: {entry_name}"
                )
            if count > 1:
                raise SystemExit(
                    f"error: {aar}: duplicate rebuilt library entry: {entry_name}"
                )
            data = archive.read(entry_name)
            if len(data) == 0:
                raise SystemExit(
                    f"error: {aar}: empty rebuilt library entry: {entry_name}"
                )
            payloads[pair] = data
    return payloads


def has_symtab(elf: bytes) -> bool:
    """Return True only when `readelf -S` reports an exact ``.symtab`` section
    of type ``SYMTAB``.

    ``readelf -SW`` output uses a fixed-column format whose first whitespace-
    delimited token is the section number ``[Nr]`` and whose second token is
    the section name.  We therefore require a row whose second field is exactly
    ``.symtab`` and whose third field is exactly ``SYMTAB``, rejecting
    lookalikes such as ``.symtab_shndx``.

    Fails closed: any readelf failure, empty output, or absence of a matching
    section counts as a missing symbol table.  We never guess or assume.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        path = pathlib.Path(tmpdir) / "lib.so"
        path.write_bytes(elf)
        try:
            output = subprocess.run(
                ["readelf", "-SW", str(path)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"error: readelf failed for ELF payload: {exc}", file=sys.stderr)
            return False
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[1] == ".symtab" and fields[2] == "SYMTAB":
            return True
    return False


def validate_payloads(payloads: dict[tuple[str, str], bytes], aar: pathlib.Path) -> None:
    """Reject missing, empty, or symbol-less required ELF payloads."""
    for abi, library in SYMBOL_ENTRIES:
        data = payloads.get((abi, library))
        if data is None or len(data) == 0:
            raise SystemExit(f"error: {aar}: empty or missing payload for {abi}/{library}")
        if not has_symtab(data):
            raise SystemExit(
                f"error: {aar}: {abi}/{library} has no usable .symtab (unexpectedly stripped)"
            )


def write_symbols_zip(output: pathlib.Path, payloads: dict[tuple[str, str], bytes]) -> None:
    """Write the deterministic, Play-compatible symbol ZIP atomically."""
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=output.name + ".", suffix=".tmp", dir=output.parent
    )
    os.close(fd)
    tmp = pathlib.Path(tmp_name)
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_STORED) as archive:
            for abi, library in SYMBOL_ENTRIES:
                info = zipfile.ZipInfo(f"{abi}/{library}", date_time=_FIXED_DATE_TIME)
                # Deterministic read-only external attributes (regular file, 0o644).
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, payloads[(abi, library)])
        tmp.replace(output)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--etebase-aar", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()

    if not args.etebase_aar.is_file():
        print(f"error: missing rebuilt Etebase AAR: {args.etebase_aar}", file=sys.stderr)
        return 1

    payloads = read_aar_payloads(args.etebase_aar)
    validate_payloads(payloads, args.etebase_aar)
    write_symbols_zip(args.output, payloads)
    print(f"Wrote {args.output} with {len(SYMBOL_ENTRIES)} symbol-bearing entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
