#!/usr/bin/env python3
"""Verify the Play Console native debug-symbol ZIP against the release AAB.

Google Play expects one ZIP with one entry per `<abi>/<library>.so`. AGP's
`ndk.debugSymbolLevel` emits entries suffixed `.so.sym` (SYMBOL_TABLE) or
`.so.dbg` (FULL); hand-built ZIPs use the bare `.so` name.

Dependencies that ship pre-stripped native libraries carry no extractable
debug metadata, so AGP cannot produce symbols for them and this gate must not
demand them. In SilentSuite's release AAB only the locally rebuilt 64-bit
libetebase_android.so copies retain symbol tables; libconscrypt_jni.so and the
upstream 32-bit libetebase_android.so copies arrive stripped. The gate fails
closed when the ZIP is missing, when any entry is malformed, empty, duplicated
or does not correspond to a packaged library, when the AAB does not package
exactly the declared ABI/library inventory, or when a declared symbol-bearing
library has no symbol entry.

For symbol-bearing libraries the verifier also compares the SHA-256 hash of the
entry payload against the byte-identical copy packaged inside the AAB. Since
both originate from the same locally rebuilt AAR, the raw ELF bytes must match
exactly; a mismatch means the ZIP was built from a different source than the
AAB, which would defeat symbolication.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import sys
import zipfile

EXPECTED_ANDROID_ABIS = ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
SYMBOL_SUFFIXES = (".so", ".so.sym", ".so.dbg")


def bundle_native_libs(
    bundle: pathlib.Path,
) -> tuple[set[tuple[str, str]], dict[tuple[str, str], str], list[str]]:
    """Return the (abi, library) pairs packaged as `*/lib/<abi>/<name>.so`,
    a mapping from (abi, library) to the entry's full AAB path string, and any
    errors. Fails closed on duplicate AAB entries for the same ABI/library pair
    rather than silently overwriting the mapped path.
    """
    libs: set[tuple[str, str]] = set()
    entry_path: dict[tuple[str, str], str] = {}
    errors: list[str] = []
    with zipfile.ZipFile(bundle) as archive:
        for name in archive.namelist():
            parts = pathlib.PurePosixPath(name).parts
            if len(parts) != 4 or parts[1] != "lib" or not parts[3].endswith(".so"):
                continue
            if parts[2] not in EXPECTED_ANDROID_ABIS:
                errors.append(f"{bundle}: unknown ABI for native library: {name}")
                continue
            pair = (parts[2], parts[3])
            if pair in entry_path:
                errors.append(
                    f"{bundle}: duplicate packaged native library: "
                    f"{pair[0]}/{pair[1]}"
                )
                continue
            entry_path[pair] = name
            libs.add(pair)
    return libs, entry_path, errors


def symbol_entries(symbols: pathlib.Path) -> tuple[set[tuple[str, str]], dict[tuple[str, str], str], list[str]]:
    """Return the (abi, library) pairs covered by the symbol ZIP entries,
    a mapping to the ZIP entry name, and any errors.
    """
    covered: set[tuple[str, str]] = set()
    entry_name: dict[tuple[str, str], str] = {}
    errors: list[str] = []
    with zipfile.ZipFile(symbols) as archive:
        for info in archive.infolist():
            if info.filename.endswith("/"):
                continue
            parts = pathlib.PurePosixPath(info.filename).parts
            suffix = next((s for s in SYMBOL_SUFFIXES if parts[-1].endswith(s)), None)
            if len(parts) != 2 or parts[0] not in EXPECTED_ANDROID_ABIS or suffix is None:
                errors.append(f"{symbols}: unexpected symbol entry: {info.filename}")
                continue
            if info.file_size == 0:
                errors.append(f"{symbols}: empty symbol entry: {info.filename}")
                continue
            library = parts[1][: len(parts[1]) - len(suffix)] + ".so"
            pair = (parts[0], library)
            if pair in covered:
                errors.append(f"{symbols}: duplicate symbol entry for {parts[0]}/{library}")
                continue
            covered.add(pair)
            entry_name[pair] = info.filename
    return covered, entry_name, errors


def collect_errors(
    bundle: pathlib.Path,
    symbols: pathlib.Path,
    required_libs: set[str],
    required_symbols: set[tuple[str, str]],
) -> list[str]:
    for path in (bundle, symbols):
        if not path.is_file():
            return [f"missing archive: {path}"]
    if not required_libs or not required_symbols:
        return ["at least one --require-lib and one --require-symbol are required"]
    packaged, aab_entry_paths, errors = bundle_native_libs(bundle)
    covered, symbol_entry_names, symbol_errors = symbol_entries(symbols)
    errors.extend(symbol_errors)
    expected = {(abi, lib) for abi in EXPECTED_ANDROID_ABIS for lib in required_libs}
    for abi, library in sorted(expected - packaged):
        errors.append(f"{bundle}: missing packaged native library: {abi}/{library}")
    for abi, library in sorted(packaged - expected):
        errors.append(f"{bundle}: unexpected packaged native library: {abi}/{library}")
    for abi, library in sorted(required_symbols - covered):
        errors.append(f"{symbols}: missing symbols for {abi}/{library}")
    for abi, library in sorted(covered - packaged):
        errors.append(f"{symbols}: symbols for library not packaged in bundle: {abi}/{library}")

    # ── SHA-256 identity: the symbol payload must match the byte-identical
    # library packaged inside the same AAB. Both originate from the same locally
    # rebuilt AAR, so the raw ELF bytes must be exact. ──
    with zipfile.ZipFile(bundle) as bundle_archive, zipfile.ZipFile(symbols) as symbol_archive:
        for pair in sorted(required_symbols & covered & packaged):
            symbol_bytes = symbol_archive.read(symbol_entry_names[pair])
            bundle_bytes = bundle_archive.read(aab_entry_paths[pair])
            symbol_sha = hashlib.sha256(symbol_bytes).hexdigest()
            bundle_sha = hashlib.sha256(bundle_bytes).hexdigest()
            if symbol_sha != bundle_sha:
                errors.append(
                    f"{symbols}: SHA-256 mismatch for {pair[0]}/{pair[1]}: "
                    f"symbol-ZIP {symbol_sha[:16]} does not match "
                    f"bundle {bundle_sha[:16]} (not from the same rebuilt AAR)"
                )

    return errors


def symbol_pair(value: str) -> tuple[str, str]:
    abi, separator, library = value.partition("/")
    if not separator or abi not in EXPECTED_ANDROID_ABIS or not library.endswith(".so"):
        raise argparse.ArgumentTypeError(f"expected <abi>/<library>.so, got: {value}")
    return abi, library


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-lib",
        action="append",
        default=[],
        help="Shared-library basename the bundle must package for every expected ABI, "
        "and the only basenames it may package. Repeatable.",
    )
    parser.add_argument(
        "--require-symbol",
        action="append",
        default=[],
        type=symbol_pair,
        help="<abi>/<library>.so pair that must have a non-empty symbol entry "
        "(known symbol-bearing, non-stripped libraries only). Repeatable.",
    )
    parser.add_argument("--bundle", required=True, type=pathlib.Path)
    parser.add_argument("--symbols", required=True, type=pathlib.Path)
    args = parser.parse_args()

    errors = collect_errors(
        args.bundle, args.symbols, set(args.require_lib), set(args.require_symbol)
    )
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    if not errors:
        print(
            f"OK {args.symbols} is well-formed and covers every required "
            f"symbol-bearing library packaged in {args.bundle}"
        )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())