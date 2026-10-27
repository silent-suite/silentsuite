#!/usr/bin/env python3
"""Record and admit the same-run Etebase 16 KB AAR shared by Android CI jobs.

The CI producer builds the AAR once with build-etebase-client-16kb.sh and runs
`record`, which writes a flat staging folder holding exactly the AAR and a
canonical provenance record. Each native consumer downloads that folder and runs
`verify`, which installs the AAR at the fixed app/libs location only after every
check has passed:

* the folder holds exactly those two regular files (no symlinks, nothing else);
* the provenance is canonical JSON with exactly the expected fields and types;
* it names this commit and this workflow run, and an attempt between 1 and the
  current attempt (a re-run consumer may reuse an earlier attempt's artifact);
* the build-script and reproducible-contract hashes, and the pins parsed from
  them, equal those of the consumer's own checkout;
* the AAR's size and SHA-256 match, and it holds exactly one non-empty
  libetebase_android.so for each of the four fixed ABIs and no other JNI ABI.

Provenance values are only compared, never used as paths or command arguments.
The artifact never leaves its run; this is not a cache. The release lane builds
its own Etebase and does not use this script.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

AAR_NAME = "client-2.3.2-16kb.aar"
PROVENANCE_NAME = "etebase-16kb-provenance.json"
LIBRARY = "libetebase_android.so"
# The script rebuilds the two 64-bit libraries and keeps upstream's 32-bit ones.
ABIS = ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
ABI_ENTRIES = [f"jni/{abi}/{LIBRARY}" for abi in ABIS]
BUILD_SCRIPT = "scripts/build-etebase-client-16kb.sh"
CONTRACT_SCRIPT = "scripts/reproducible-build-contract.sh"
MAX_AAR_BYTES = 256 * 1024 * 1024
MAX_PROVENANCE_BYTES = 64 * 1024
MAX_SCRIPT_BYTES = 1024 * 1024

HEX40 = re.compile(r"[0-9a-f]{40}")
HEX64 = re.compile(r"[0-9a-f]{64}")
DECIMAL = re.compile(r"[1-9][0-9]{0,19}")
NDK_REVISION = re.compile(r"28\.[0-9]+\.[0-9]+")
RUST_TOOLCHAIN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")

ETEBASE_PIN = re.compile(r'^ETEBASE_EXPECTED_COMMIT="\$\{ETEBASE_EXPECTED_COMMIT:-([0-9a-f]{40})\}"$', re.M)
FLAPIGEN_PIN = re.compile(r'^FLAPIGEN_EXPECTED_COMMIT="([0-9a-f]{40})"$', re.M)
RUST_PIN = re.compile(r'^SILENTSUITE_RELEASE_RUST_TOOLCHAIN="([0-9]+\.[0-9]+\.[0-9]+)"$', re.M)
NDK_PROPERTY = re.compile(r"^Pkg\.Revision\s*=\s*(\S+)\s*$", re.M)


class Rejected(Exception):
    pass


def _string(pattern: re.Pattern):
    return lambda value: isinstance(value, str) and pattern.fullmatch(value) is not None


def _integer(minimum: int):
    return lambda value: type(value) is int and value >= minimum


FIELDS = {
    "schema": lambda value: type(value) is int and value == 1,
    "headSha": _string(HEX40),
    "runId": _string(DECIMAL),
    "runAttempt": _integer(1),
    "aarSha256": _string(HEX64),
    "aarSize": _integer(1),
    "buildScriptSha256": _string(HEX64),
    "contractScriptSha256": _string(HEX64),
    "etebaseCommit": _string(HEX40),
    "flapigenCommit": _string(HEX40),
    "rustToolchain": _string(RUST_TOOLCHAIN),
    "ndkRevision": _string(NDK_REVISION),
    "abiEntries": lambda value: value == ABI_ENTRIES,
}


def canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")


def read_regular_file(path: Path, limit: int) -> bytes:
    """Read a regular, non-symlink file of at most `limit` bytes."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        raise Rejected(f"{path} is missing") from None
    except OSError as error:
        raise Rejected(f"{path} is not a readable regular file: {error.strerror}") from None
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise Rejected(f"{path} is not a regular file")
        if info.st_size > limit:
            raise Rejected(f"{path} exceeds {limit} bytes")
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Rejected(f"{path} exceeds {limit} bytes")
    return data


def run_identity() -> tuple[str, str, int]:
    sha = os.environ.get("GITHUB_SHA", "")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not HEX40.fullmatch(sha) or not DECIMAL.fullmatch(run) or not DECIMAL.fullmatch(attempt):
        raise Rejected("GITHUB_SHA, GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must identify the current run")
    return sha, run, int(attempt)


def _single(pattern: re.Pattern, text: str, what: str) -> str:
    matches = pattern.findall(text)
    if len(matches) != 1:
        raise Rejected(f"expected exactly one {what} pin, found {len(matches)}")
    return matches[0]


def script_pins(android_root: Path) -> dict:
    build = read_regular_file(android_root / BUILD_SCRIPT, MAX_SCRIPT_BYTES)
    contract = read_regular_file(android_root / CONTRACT_SCRIPT, MAX_SCRIPT_BYTES)
    build_text = build.decode("utf-8")
    contract_text = contract.decode("utf-8")
    return {
        "buildScriptSha256": hashlib.sha256(build).hexdigest(),
        "contractScriptSha256": hashlib.sha256(contract).hexdigest(),
        "etebaseCommit": _single(ETEBASE_PIN, build_text, "Etebase commit"),
        "flapigenCommit": _single(FLAPIGEN_PIN, build_text, "flapigen commit"),
        "rustToolchain": _single(RUST_PIN, contract_text, "Rust toolchain"),
    }


def check_inventory(data: bytes) -> None:
    """Exactly one non-empty Etebase library per fixed ABI, and no other JNI ABI."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise Rejected("the AAR is not a valid zip archive") from None
    with archive:
        names = [info.filename for info in archive.infolist()]
        if len(names) != len(set(names)):
            raise Rejected("the AAR contains duplicate entry names")
        for name in names:
            parts = name.split("/")
            if parts[0] == "jni" and len(parts) > 2 and parts[1] not in ABIS:
                raise Rejected(f"the AAR contains an unexpected JNI ABI entry: {name}")
            if parts[-1] == LIBRARY and name not in ABI_ENTRIES:
                raise Rejected(f"the AAR contains an unexpected Etebase library entry: {name}")
        for entry in ABI_ENTRIES:
            if entry not in names:
                raise Rejected(f"the AAR is missing {entry}")
            try:
                payload = archive.read(entry)
            except (zipfile.BadZipFile, OSError, RuntimeError) as error:
                raise Rejected(f"the AAR entry {entry} is unreadable: {error}") from None
            if not payload:
                raise Rejected(f"the AAR entry {entry} is empty")
        try:
            corrupt = archive.testzip()
        except (zipfile.BadZipFile, OSError, RuntimeError) as error:
            raise Rejected(f"the AAR is unreadable: {error}") from None
        if corrupt is not None:
            raise Rejected(f"the AAR entry {corrupt} is corrupt")


def parse_provenance(raw: bytes) -> dict:
    def no_duplicates(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise Rejected(f"duplicate provenance key: {key}")
            value[key] = item
        return value

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicates)
    except (UnicodeDecodeError, ValueError):
        raise Rejected("the provenance is not valid UTF-8 JSON") from None
    if not isinstance(value, dict):
        raise Rejected("the provenance is not a JSON object")
    if set(value) != set(FIELDS):
        missing = sorted(set(FIELDS) - set(value))
        unknown = sorted(set(value) - set(FIELDS))
        raise Rejected(f"provenance fields differ (missing {missing}, unknown {unknown})")
    for key, valid in FIELDS.items():
        if not valid(value[key]):
            raise Rejected(f"provenance field {key} has an invalid value")
    if canonical(value) != raw:
        raise Rejected("the provenance is not canonical compact sorted JSON")
    return value


def record(android_root: Path, staging: Path) -> None:
    sha, run, attempt = run_identity()
    ndk_home = os.environ.get("ANDROID_NDK_HOME", "")
    if not ndk_home:
        raise Rejected("ANDROID_NDK_HOME must name the NDK the AAR was built with")
    properties = read_regular_file(Path(ndk_home) / "source.properties", MAX_PROVENANCE_BYTES).decode("utf-8")
    ndk_revision = _single(NDK_PROPERTY, properties, "NDK revision")
    if not NDK_REVISION.fullmatch(ndk_revision):
        raise Rejected(f"the NDK revision {ndk_revision!r} is not an r28 revision")
    aar = read_regular_file(android_root / "app/libs" / AAR_NAME, MAX_AAR_BYTES)
    check_inventory(aar)
    provenance = {
        "schema": 1,
        "headSha": sha,
        "runId": run,
        "runAttempt": attempt,
        "aarSha256": hashlib.sha256(aar).hexdigest(),
        "aarSize": len(aar),
        "ndkRevision": ndk_revision,
        "abiEntries": ABI_ENTRIES,
        **script_pins(android_root),
    }
    parse_provenance(canonical(provenance))
    try:
        staging.mkdir()
    except FileExistsError:
        raise Rejected(f"{staging} already exists") from None
    with (staging / AAR_NAME).open("xb") as handle:
        handle.write(aar)
    with (staging / PROVENANCE_NAME).open("xb") as handle:
        handle.write(canonical(provenance))
    print(f"Recorded {AAR_NAME} ({provenance['aarSha256']}) for run {run} attempt {attempt}")


def verify(android_root: Path, staging: Path) -> None:
    destination = android_root / "app/libs" / AAR_NAME
    if os.path.lexists(destination):
        raise Rejected(f"{destination} already exists; refusing to replace it")
    try:
        staging_info = os.lstat(staging)
    except FileNotFoundError:
        raise Rejected(f"{staging} is missing") from None
    if not stat.S_ISDIR(staging_info.st_mode):
        raise Rejected(f"{staging} is not a directory")
    entries = sorted(os.listdir(staging))
    if entries != sorted([AAR_NAME, PROVENANCE_NAME]):
        raise Rejected(f"{staging} must hold exactly {AAR_NAME} and {PROVENANCE_NAME}, found {entries}")
    provenance = parse_provenance(read_regular_file(staging / PROVENANCE_NAME, MAX_PROVENANCE_BYTES))
    aar = read_regular_file(staging / AAR_NAME, MAX_AAR_BYTES)

    sha, run, attempt = run_identity()
    if provenance["headSha"] != sha:
        raise Rejected("the artifact was recorded for a different commit")
    if provenance["runId"] != run:
        raise Rejected("the artifact was recorded by a different workflow run")
    if not 1 <= provenance["runAttempt"] <= attempt:
        raise Rejected("the artifact was recorded by a later run attempt")
    for key, expected in script_pins(android_root).items():
        if provenance[key] != expected:
            raise Rejected(f"provenance {key} does not match this checkout")
    if len(aar) != provenance["aarSize"]:
        raise Rejected("the AAR size does not match its provenance")
    if hashlib.sha256(aar).hexdigest() != provenance["aarSha256"]:
        raise Rejected("the AAR SHA-256 does not match its provenance")
    check_inventory(aar)

    parent = destination.parent
    if os.path.lexists(parent) and not stat.S_ISDIR(os.lstat(parent).st_mode):
        raise Rejected(f"{parent} is not a directory")
    parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".etebase-admission-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(aar)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            raise Rejected(f"{destination} appeared during admission; refusing to replace it") from None
    finally:
        os.unlink(temporary)
    if hashlib.sha256(read_regular_file(destination, MAX_AAR_BYTES)).hexdigest() != provenance["aarSha256"]:
        raise Rejected(f"{destination} does not hold the admitted bytes")
    print(f"Admitted {AAR_NAME} ({provenance['aarSha256']}) from run {run} attempt {provenance['runAttempt']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("record", "verify"))
    parser.add_argument("--staging", type=Path, required=True)
    parser.add_argument("--android-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        if args.command == "record":
            record(args.android_root, args.staging)
        else:
            verify(args.android_root, args.staging)
    except Rejected as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
