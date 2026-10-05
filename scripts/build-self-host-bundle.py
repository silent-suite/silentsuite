#!/usr/bin/env python3
"""Build the deterministic self-host release bundle for one immutable tag.

Emits three artefacts into --output-dir:

  silentsuite-self-host-<tag>.tar.gz          version-matched self-host files
  silentsuite-self-host-<tag>.tar.gz.sha256   strict one-record checksum sidecar
  server-image.json                           immutable image identity manifest

The image digest is release data, never source data: nothing here is written
back into the tree. Running this twice with the same inputs produces
byte-identical output (fixed member order, ownership, modes, and timestamps),
so a reviewer can reproduce the published checksum from the tagged tree.
"""

from __future__ import annotations

import argparse
import gzip
import io
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from selfhost_release_contract import (  # noqa: E402
    BUNDLE_SOURCE_FILES,
    COMMIT_PATTERN,
    DIGEST_PATTERN,
    EXECUTABLE_SUFFIXES,
    MANIFEST_NAME,
    ContractError,
    ReleaseIdentity,
    bundle_basename,
    bundle_prefix,
    render_manifest,
    sha256_file,
)

# Fixed epoch for every archive member and for the gzip header. Determinism is
# what lets an auditor rebuild the bundle from the tag and compare checksums.
FIXED_MTIME = 0


def build_archive(self_host_dir: Path, tag: str, manifest_bytes: bytes) -> bytes:
    prefix = bundle_prefix(tag)
    # self-host/umbrel is the separately packaged Umbrel app tree, not part of the
    # flat release bundle. Its one real, non-symlink directory entry may coexist
    # next to the admitted flat files; every other entry — including a regular
    # file or any symlink named "umbrel" — must still match the inventory exactly.
    present = sorted(
        entry.name
        for entry in self_host_dir.iterdir()
        if not (entry.name == "umbrel" and entry.is_dir() and not entry.is_symlink())
    )
    expected = sorted(BUNDLE_SOURCE_FILES)
    if present != expected:
        raise ContractError(
            f"self-host inventory drifted: found {present}, bundle inventory expects {expected}"
        )

    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo(prefix)
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        root.mtime = FIXED_MTIME
        root.uid = root.gid = 0
        root.uname = root.gname = ""
        archive.addfile(root)

        members = [(name, (self_host_dir / name).read_bytes()) for name in expected]
        members.append((MANIFEST_NAME, manifest_bytes))
        for name, payload in sorted(members):
            info = tarfile.TarInfo(f"{prefix}/{name}")
            info.size = len(payload)
            info.mode = 0o755 if name.endswith(EXECUTABLE_SUFFIXES) else 0o644
            info.mtime = FIXED_MTIME
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            archive.addfile(info, io.BytesIO(payload))

    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, compresslevel=9, mtime=FIXED_MTIME) as gz:
        gz.write(raw.getvalue())
    return compressed.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--index-digest", required=True)
    parser.add_argument("--amd64-digest", required=True)
    parser.add_argument("--arm64-digest", required=True)
    parser.add_argument("--self-host-dir", default="self-host")
    parser.add_argument("--output-dir", required=True)
    arguments = parser.parse_args()

    for label, value, pattern in (
        ("--source-commit", arguments.source_commit, COMMIT_PATTERN),
        ("--index-digest", arguments.index_digest, DIGEST_PATTERN),
        ("--amd64-digest", arguments.amd64_digest, DIGEST_PATTERN),
        ("--arm64-digest", arguments.arm64_digest, DIGEST_PATTERN),
    ):
        if not pattern.fullmatch(value):
            raise ContractError(f"{label} value {value!r} is not immutable")

    if len({arguments.index_digest, arguments.amd64_digest, arguments.arm64_digest}) != 3:
        raise ContractError("index and per-platform digests must all differ")

    identity = ReleaseIdentity(
        tag=arguments.tag,
        source_commit=arguments.source_commit,
        index_digest=arguments.index_digest,
        amd64_digest=arguments.amd64_digest,
        arm64_digest=arguments.arm64_digest,
    )

    manifest_text = render_manifest(identity)
    manifest_bytes = manifest_text.encode("utf-8")

    output_dir = Path(arguments.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    archive_bytes = build_archive(Path(arguments.self_host_dir), arguments.tag, manifest_bytes)
    basename = bundle_basename(arguments.tag)
    archive_path = output_dir / basename
    archive_path.write_bytes(archive_bytes)
    (output_dir / MANIFEST_NAME).write_text(manifest_text, encoding="utf-8")
    (output_dir / f"{basename}.sha256").write_text(
        f"{sha256_file(archive_path)}  {basename}\n", encoding="utf-8"
    )

    print(f"bundle:   {archive_path}")
    print(f"checksum: {sha256_file(archive_path)}")
    print(f"manifest: {output_dir / MANIFEST_NAME}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ContractError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
