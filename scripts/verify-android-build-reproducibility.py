#!/usr/bin/env python3
"""Compare two Android builds under F-Droid's signature-copy byte contract.

F-Droid publishes a developer-signed APK only when it can rebuild the same
bytes from the public source. Its check is not "both APKs install and work": it
strips the signature files from the published APK, rebuilds from source, and
requires every remaining entry to match byte for byte. The 0.5.4-beta attempt
failed that way — 2509 of 2517 unsigned entries matched — which is a pass for
every other kind of test and a hard failure for this one.

This implements the same comparison so it can run *before* a release is signed,
between two independent source builds, instead of being discovered afterwards
by someone else's CI:

  * entry inventory and archive order;
  * per-entry compression method, CRC-32, uncompressed length and content;
  * the whole-file digest, when neither side carries a signature.

Signature material is excluded exactly as apksigcopier excludes it, so a
published signed APK can be compared against a fresh unsigned build: the v1
entries under META-INF are skipped, and an APK carrying a v2/v3 signing block
is recognised by that block's magic so the container digest — which the block
necessarily changes — is reported rather than compared. Local header extra
fields are never compared: they carry zipalign's padding, which is applied
after the build this gate is about.

Exits non-zero on any difference, and prints the mismatching entries rather
than only a verdict, because "which 8 of 2517" is the whole diagnosis.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

# Exactly what apksigcopier treats as signature material.
SIGNATURE_ENTRY = re.compile(
    r"^META-INF/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))$", re.IGNORECASE
)
# A v2/v3-signed APK need carry no META-INF entry at all: its signature lives in
# the APK Signing Block, between the last entry and the central directory. The
# block's magic is the only way to see it without parsing the whole container.
APK_SIGNING_BLOCK_MAGIC = b"APK Sig Block 42"


@dataclass(frozen=True)
class Entry:
    name: str
    compress_type: int
    crc: int
    size: int
    content: bytes

    def metadata(self) -> tuple[int, int, int]:
        return (self.compress_type, self.crc, self.size)


@dataclass
class Archive:
    path: Path
    digest: str
    signed: bool
    entries: list[Entry]

    @property
    def by_name(self) -> dict[str, Entry]:
        return {entry.name: entry for entry in self.entries}

    @property
    def order(self) -> list[str]:
        return [entry.name for entry in self.entries]


def read_archive(path: Path) -> Archive:
    if not path.is_file():
        raise SystemExit(f"error: {path} is not a file")
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    entries: list[Entry] = []
    signed = APK_SIGNING_BLOCK_MAGIC in raw
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if SIGNATURE_ENTRY.match(info.filename):
                signed = True
                continue
            entries.append(
                Entry(
                    name=info.filename,
                    compress_type=info.compress_type,
                    crc=info.CRC,
                    size=info.file_size,
                    content=archive.read(info.filename),
                )
            )
    return Archive(path=path, digest=digest, signed=signed, entries=entries)


def compare(reference: Archive, candidate: Archive) -> tuple[list[str], int, int]:
    """Return (differences, matched, total-considered)."""
    differences: list[str] = []
    reference_entries = reference.by_name
    candidate_entries = candidate.by_name

    missing = sorted(set(reference_entries) - set(candidate_entries))
    extra = sorted(set(candidate_entries) - set(reference_entries))
    for name in missing:
        differences.append(f"{name}: present in the reference build, absent from the candidate")
    for name in extra:
        differences.append(f"{name}: present in the candidate build, absent from the reference")

    shared = sorted(set(reference_entries) & set(candidate_entries))
    matched = 0
    for name in shared:
        left = reference_entries[name]
        right = candidate_entries[name]
        if left.metadata() != right.metadata():
            differences.append(
                f"{name}: entry metadata differs "
                f"(method/crc/size {left.metadata()} vs {right.metadata()})"
            )
        elif left.content != right.content:
            differences.append(
                f"{name}: content differs ({len(left.content)} bytes, "
                f"sha256 {hashlib.sha256(left.content).hexdigest()[:16]} vs "
                f"{hashlib.sha256(right.content).hexdigest()[:16]})"
            )
        else:
            matched += 1

    if reference.order != candidate.order:
        differences.append(
            "archive entry order differs; APK entry order is part of the compared bytes"
        )

    total = len(set(reference_entries) | set(candidate_entries))
    return differences, matched, total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True, help="Baseline APK")
    parser.add_argument("--candidate", type=Path, required=True, help="Independently rebuilt APK")
    parser.add_argument("--report", type=Path, help="Write a JSON verdict here")
    parser.add_argument(
        "--max-reported",
        type=int,
        default=40,
        help="Cap the printed difference list (the report keeps all of them)",
    )
    arguments = parser.parse_args()

    reference = read_archive(arguments.reference)
    candidate = read_archive(arguments.candidate)

    differences, matched, total = compare(reference, candidate)

    # Two unsigned builds have nothing legitimate to differ by. Only when a
    # signature is involved does the container carry bytes this contract does
    # not own — the signing block, and zipalign's padding around it.
    container_compared = not reference.signed and not candidate.signed
    if container_compared and reference.digest != candidate.digest:
        differences.append(
            f"whole-file sha256 differs: {reference.digest} vs {candidate.digest}"
        )

    verdict = {
        "reference": str(reference.path),
        "candidate": str(candidate.path),
        "reference_sha256": reference.digest,
        "candidate_sha256": candidate.digest,
        "reference_signed": reference.signed,
        "candidate_signed": candidate.signed,
        "container_compared": container_compared,
        "entries_total": total,
        "entries_matched": matched,
        "differences": differences,
        "reproducible": not differences,
    }
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(json.dumps(verdict, indent=2) + "\n", encoding="utf-8")

    print(f"reference: {reference.path} sha256 {reference.digest}")
    print(f"candidate: {candidate.path} sha256 {candidate.digest}")
    print(f"unsigned entries: {matched}/{total} matched")
    if not differences:
        print("Reproducibility contract satisfied: the two builds are byte-identical")
        return 0

    print(f"Reproducibility contract FAILED: {len(differences)} difference(s)")
    for difference in differences[: arguments.max_reported]:
        print(f"- {difference}")
    if len(differences) > arguments.max_reported:
        print(f"- … {len(differences) - arguments.max_reported} more")
    return 1


if __name__ == "__main__":
    sys.exit(main())
