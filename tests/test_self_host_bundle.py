"""Contracts for the self-host release bundle, checksum, and image manifest.

The release workflow generates these artefacts and the installer consumes them,
so both sides are pinned here: the manifest grammar the shell installer parses,
the checksum grammar it enforces, the archive safety rules, and the fact that a
bundle is reproducible from the tagged tree.
"""

from __future__ import annotations

import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from selfhost_release_contract import (  # noqa: E402
    BUNDLE_SOURCE_FILES,
    MANIFEST_NAME,
    ContractError,
    ReleaseIdentity,
    assert_archive_members_safe,
    assert_bundle_inventory,
    bundle_basename,
    bundle_prefix,
    parse_checksum_file,
    parse_manifest,
    render_manifest,
    validate_against_schema,
)

BUILDER = ROOT / "scripts" / "build-self-host-bundle.py"
VERIFIER = ROOT / "scripts" / "verify-self-host-bundle.py"
INSTALLER = ROOT / "self-host" / "install.sh"

TAG = "v9.9.9-beta"
COMMIT = "a" * 40
INDEX_DIGEST = "sha256:" + "1" * 64
AMD64_DIGEST = "sha256:" + "2" * 64
ARM64_DIGEST = "sha256:" + "3" * 64
IDENTITY = ReleaseIdentity(TAG, COMMIT, INDEX_DIGEST, AMD64_DIGEST, ARM64_DIGEST)


def builder_command(directory: Path, tag: str, self_host_dir: Path) -> list[str]:
    return [
        sys.executable,
        str(BUILDER),
        "--tag",
        tag,
        "--source-commit",
        COMMIT,
        "--index-digest",
        INDEX_DIGEST,
        "--amd64-digest",
        AMD64_DIGEST,
        "--arm64-digest",
        ARM64_DIGEST,
        "--self-host-dir",
        str(self_host_dir),
        "--output-dir",
        str(directory),
    ]


def build(directory: Path, tag: str = TAG, self_host_dir: Path | None = None) -> Path:
    subprocess.run(
        builder_command(
            directory, tag, self_host_dir if self_host_dir is not None else ROOT / "self-host"
        ),
        check=True,
        capture_output=True,
        cwd=ROOT,
    )
    return directory / bundle_basename(tag)


def verify(directory: Path, tag: str = TAG) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(VERIFIER),
            "--directory",
            str(directory),
            "--tag",
            tag,
            "--source-commit",
            COMMIT,
            "--index-digest",
            INDEX_DIGEST,
            "--amd64-digest",
            AMD64_DIGEST,
            "--arm64-digest",
            ARM64_DIGEST,
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


# ── Manifest grammar ──────────────────────────────────────────────────


def test_manifest_renders_in_the_exact_shape_the_installer_parses():
    lines = render_manifest(IDENTITY).splitlines()
    assert len(lines) == 14
    assert lines[0] == "{"
    assert lines[-1] == "}"
    assert len([line for line in lines if line.startswith('  "')]) == 9
    assert lines[1] == '  "schemaVersion": 1,'
    assert lines[2] == f'  "tag": "{TAG}",'
    assert lines[3] == f'  "sourceCommit": "{COMMIT}",'
    assert lines[4] == '  "imageRepository": "ghcr.io/silent-suite/silentsuite-server",'
    assert lines[5] == f'  "indexDigest": "{INDEX_DIGEST}",'
    assert lines[6] == f'  "amd64Digest": "{AMD64_DIGEST}",'
    assert lines[7] == f'  "arm64Digest": "{ARM64_DIGEST}",'
    assert lines[8] == '  "platforms": ['
    assert lines[9] == '    "linux/amd64",'
    assert lines[10] == '    "linux/arm64"'
    assert lines[11] == "  ],"
    assert lines[12] == f'  "expectedRevision": "{COMMIT}"'


def test_installer_enforces_every_manifest_field_the_schema_requires():
    installer = INSTALLER.read_text(encoding="utf-8")
    for field in (
        "schemaVersion",
        "tag",
        "sourceCommit",
        "imageRepository",
        "indexDigest",
        "amd64Digest",
        "arm64Digest",
        "platforms",
        "expectedRevision",
    ):
        quoted = f'"{field}"'
        shell_escaped = f'\\"{field}\\"'
        assert quoted in installer or shell_escaped in installer, (
            f"install.sh does not validate {field}"
        )
    assert '"14"' in installer, "install.sh should pin the manifest line count"
    assert '"9"' in installer, "install.sh should pin the manifest field count"


def test_installer_accepts_exactly_the_published_bundle_inventory():
    """The shell inventory and the Python inventory must not drift apart."""

    installer = INSTALLER.read_text(encoding="utf-8")
    block = re.search(
        r"EXPECTED_MEMBERS=.*?\| LC_ALL=C sort\)",
        installer,
        re.DOTALL,
    )
    assert block, "install.sh should declare an explicit expected member list"
    declared = sorted(re.findall(r"[.A-Za-z0-9][A-Za-z0-9._-]*\.(?:sh|yml|json|md|html|example)", block.group(0)))
    assert declared == sorted([*BUNDLE_SOURCE_FILES, MANIFEST_NAME])


def test_manifest_round_trips_through_the_schema():
    document = parse_manifest(render_manifest(IDENTITY))
    assert document["platforms"] == ["linux/amd64", "linux/arm64"]
    assert document["expectedRevision"] == document["sourceCommit"]


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda d: d.update(unexpected="value"), "unexpected field"),
        (lambda d: d.update(schemaVersion=2), "wrong schema version"),
        (lambda d: d.update(tag="main"), "not a release tag"),
        (lambda d: d.update(sourceCommit="deadbeef"), "short commit"),
        (lambda d: d.update(imageRepository="ghcr.io/someone-else/server"), "wrong repository"),
        (lambda d: d.update(indexDigest="sha256:zz"), "malformed digest"),
        (lambda d: d.update(amd64Digest=INDEX_DIGEST.upper()), "uppercase digest"),
        (lambda d: d.pop("arm64Digest"), "missing digest"),
        (lambda d: d.update(platforms=["linux/amd64", "linux/amd64"]), "duplicate platform"),
        (lambda d: d.update(platforms=["linux/arm64", "linux/amd64"]), "reordered platforms"),
        (lambda d: d.update(platforms=["linux/amd64"]), "too few platforms"),
        (lambda d: d.update(platforms=["linux/amd64", "linux/arm64", "linux/arm64"]), "too many platforms"),
        (lambda d: d.update(platforms=["linux/amd64", "linux/riscv64"]), "unknown platform"),
        (lambda d: d.update(platforms="linux/amd64"), "platforms not a list"),
        (lambda d: d.update(schemaVersion=True), "boolean schema version"),
        (lambda d: d.update(tag=TAG + "\n"), "tag with trailing newline"),
        (lambda d: d.update(sourceCommit=COMMIT + "\n"), "commit with trailing newline"),
        (lambda d: d.update(indexDigest=INDEX_DIGEST + "\n"), "digest with trailing newline"),
    ],
)
def test_invalid_manifests_are_rejected(mutate, reason):
    document = IDENTITY.manifest()
    mutate(document)
    with pytest.raises(ContractError):
        parse_manifest(json.dumps(document))


def test_schema_rejects_a_duplicated_platform_entry_directly():
    document = IDENTITY.manifest()
    document["platforms"] = ["linux/arm64", "linux/arm64"]
    with pytest.raises(ContractError):
        validate_against_schema(document)


# ── Checksum grammar ──────────────────────────────────────────────────


def test_a_single_well_formed_record_is_accepted():
    name = bundle_basename(TAG)
    digest = "b" * 64
    assert parse_checksum_file(f"{digest}  {name}\n", name) == digest
    assert parse_checksum_file(f"{digest.upper()}  {name}\n", name) == digest


@pytest.mark.parametrize(
    "text,reason",
    [
        ("", "empty"),
        ("b" * 64 + "  NAME", "missing terminating newline"),
        ("b" * 64 + "  NAME\n\n", "trailing blank line"),
        ("b" * 64 + "  NAME\n" + "c" * 64 + "  NAME\n", "two records"),
        ("b" * 64 + " NAME\n", "single space separator"),
        ("b" * 64 + "   NAME\n", "three space separator"),
        ("b" * 63 + "  NAME\n", "short digest"),
        ("b" * 64 + "  NAME extra\n", "extra field"),
        ("  " + "b" * 64 + "  NAME\n", "leading whitespace"),
        ("b" * 64 + "  /etc/passwd\n", "absolute path"),
    ],
)
def test_malformed_checksum_files_are_rejected(text, reason):
    name = bundle_basename(TAG)
    with pytest.raises(ContractError):
        parse_checksum_file(text.replace("NAME", name), name)


def test_a_checksum_naming_a_different_file_is_rejected():
    with pytest.raises(ContractError):
        parse_checksum_file("b" * 64 + "  some-other-file.tar.gz\n", bundle_basename(TAG))


# ── Bundle build and verification ─────────────────────────────────────


def test_bundle_inventory_matches_the_tracked_self_host_directory():
    tracked = sorted(entry.name for entry in (ROOT / "self-host").iterdir() if entry.is_file())
    assert tracked == sorted(BUNDLE_SOURCE_FILES)


def test_bundle_build_is_reproducible(tmp_path):
    first = build(tmp_path / "one")
    second = build(tmp_path / "two")
    assert first.read_bytes() == second.read_bytes()
    assert (tmp_path / "one" / f"{first.name}.sha256").read_text() == (
        tmp_path / "two" / f"{second.name}.sha256"
    ).read_text()


def test_a_freshly_built_bundle_verifies(tmp_path):
    build(tmp_path)
    result = verify(tmp_path)
    assert result.returncode == 0, result.stderr


def test_built_bundle_contains_exactly_the_expected_members(tmp_path):
    archive = build(tmp_path)
    names = assert_archive_members_safe(archive, TAG)
    assert_bundle_inventory(names, TAG)
    prefix = bundle_prefix(TAG)
    assert f"{prefix}/{MANIFEST_NAME}" in names
    assert f"{prefix}/docker-compose.yml" in names


def test_bundle_members_are_normalised_for_reproducibility(tmp_path):
    archive = build(tmp_path)
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle.getmembers():
            assert member.uid == 0 and member.gid == 0
            assert member.uname == "" and member.gname == ""
            assert member.mtime == 0
            assert member.mode in (0o644, 0o755)


def test_verification_fails_when_the_bundle_bytes_change(tmp_path):
    archive = build(tmp_path)
    archive.write_bytes(archive.read_bytes() + b"tamper")
    result = verify(tmp_path)
    assert result.returncode != 0
    assert "does not match sidecar" in result.stderr


def test_verification_fails_when_the_manifest_disagrees_with_the_release(tmp_path):
    build(tmp_path)
    manifest = tmp_path / MANIFEST_NAME
    manifest.write_text(manifest.read_text().replace(COMMIT, "f" * 40))
    result = verify(tmp_path)
    assert result.returncode != 0


def test_verification_fails_when_the_embedded_manifest_differs(tmp_path):
    build(tmp_path)
    manifest = tmp_path / MANIFEST_NAME
    # Same release identity, different bytes: the published manifest and the
    # bundled manifest must be byte-identical, not merely equivalent.
    manifest.write_text(manifest.read_text() + "\n")
    result = verify(tmp_path)
    assert result.returncode != 0


def test_verification_fails_when_the_checksum_sidecar_is_malformed(tmp_path):
    archive = build(tmp_path)
    sidecar = tmp_path / f"{archive.name}.sha256"
    sidecar.write_text(sidecar.read_text() + sidecar.read_text())
    result = verify(tmp_path)
    assert result.returncode != 0
    assert "exactly one" in result.stderr


def test_verification_fails_when_an_artefact_is_missing(tmp_path):
    build(tmp_path)
    (tmp_path / MANIFEST_NAME).unlink()
    result = verify(tmp_path)
    assert result.returncode != 0
    assert "missing release artefact" in result.stderr


# ── Coexistence with the separately packaged Umbrel app tree ──────────


def stage_flat_self_host(directory: Path) -> Path:
    """A self-host directory with only the admitted flat release files."""

    directory.mkdir(parents=True, exist_ok=True)
    for name in BUNDLE_SOURCE_FILES:
        (directory / name).write_bytes((ROOT / "self-host" / name).read_bytes())
    return directory


def build_refusal(self_host_dir: Path, directory: Path) -> subprocess.CompletedProcess:
    result = subprocess.run(
        builder_command(directory, TAG, self_host_dir),
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert result.returncode != 0, "builder accepted an inventory the contract must refuse"
    return result


def test_the_separately_packaged_umbrel_tree_coexists_with_the_flat_bundle(tmp_path):
    umbrel_tree = ROOT / "self-host" / "umbrel"
    assert umbrel_tree.is_dir() and not umbrel_tree.is_symlink(), (
        "coexistence control needs the real self-host/umbrel directory"
    )

    with_umbrel = build(tmp_path / "with-umbrel")
    baseline = build(
        tmp_path / "baseline", self_host_dir=stage_flat_self_host(tmp_path / "flat")
    )

    # The one admitted real directory changes nothing: the same member inventory
    # and the same bytes as a build from the flat release files alone.
    assert with_umbrel.read_bytes() == baseline.read_bytes()
    names = assert_archive_members_safe(with_umbrel, TAG)
    assert_bundle_inventory(names, TAG)
    assert verify(tmp_path / "with-umbrel").returncode == 0


@pytest.mark.parametrize(
    "case,reason",
    [
        ("file", "a regular file named umbrel"),
        ("directory-symlink", "a symlink named umbrel pointing at a real directory"),
        ("dangling-symlink", "a dangling symlink named umbrel"),
        ("other-directory", "an unexpected directory"),
        ("other-file", "an unexpected file"),
        ("missing-flat-file", "a missing flat file while the umbrel tree exists"),
        ("extra-flat-file", "an extra flat file while the umbrel tree exists"),
    ],
)
def test_umbrel_coexistence_never_relaxes_the_flat_inventory(tmp_path, case, reason):
    flat = stage_flat_self_host(tmp_path / "flat")
    if case == "file":
        (flat / "umbrel").write_bytes(b"not the app tree\n")
    elif case == "directory-symlink":
        target = tmp_path / "elsewhere"
        target.mkdir()
        (flat / "umbrel").symlink_to(target)
    elif case == "dangling-symlink":
        (flat / "umbrel").symlink_to(tmp_path / "missing-target")
    elif case == "other-directory":
        (flat / "vendor").mkdir()
    elif case == "other-file":
        (flat / "extra.sh").write_bytes(b"#!/bin/sh\n")
    elif case == "missing-flat-file":
        (flat / "umbrel").mkdir()
        (flat / "backup.sh").unlink()
    elif case == "extra-flat-file":
        (flat / "umbrel").mkdir()
        (flat / "extra.sh").write_bytes(b"#!/bin/sh\n")
    else:
        raise AssertionError(f"unknown case {case!r}")

    result = build_refusal(flat, tmp_path / "out")
    assert "inventory drifted" in result.stderr


# ── Archive safety ────────────────────────────────────────────────────


def hostile_archive(path: Path, build_members) -> Path:
    with tarfile.open(path, "w:gz") as archive:
        build_members(archive)
    return path


@pytest.mark.parametrize(
    "member_name,reason",
    [
        ("../escape.txt", "parent traversal"),
        ("/etc/passwd", "absolute path"),
        ("other-bundle/file.txt", "outside the bundle root"),
        (f"{bundle_prefix(TAG)}/../../etc/passwd", "traversal inside the prefix"),
    ],
)
def test_unsafe_archive_members_are_rejected(tmp_path, member_name, reason):
    def add(archive):
        info = tarfile.TarInfo(member_name)
        info.size = 0
        archive.addfile(info, io.BytesIO(b""))

    archive = hostile_archive(tmp_path / "hostile.tar.gz", add)
    with pytest.raises(ContractError):
        assert_archive_members_safe(archive, TAG)


def test_symlink_members_are_rejected(tmp_path):
    def add(archive):
        info = tarfile.TarInfo(f"{bundle_prefix(TAG)}/link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        archive.addfile(info)

    archive = hostile_archive(tmp_path / "symlink.tar.gz", add)
    with pytest.raises(ContractError):
        assert_archive_members_safe(archive, TAG)


def test_device_members_are_rejected(tmp_path):
    def add(archive):
        info = tarfile.TarInfo(f"{bundle_prefix(TAG)}/device")
        info.type = tarfile.CHRTYPE
        archive.addfile(info)

    archive = hostile_archive(tmp_path / "device.tar.gz", add)
    with pytest.raises(ContractError):
        assert_archive_members_safe(archive, TAG)


def test_a_bundle_missing_a_required_file_is_rejected(tmp_path):
    prefix = bundle_prefix(TAG)
    names = [f"{prefix}/{name}" for name in BUNDLE_SOURCE_FILES]
    with pytest.raises(ContractError):
        assert_bundle_inventory(names, TAG)


def test_a_bundle_with_an_extra_file_is_rejected(tmp_path):
    prefix = bundle_prefix(TAG)
    names = [f"{prefix}/{name}" for name in BUNDLE_SOURCE_FILES]
    names.append(f"{prefix}/{MANIFEST_NAME}")
    names.append(f"{prefix}/unexpected.sh")
    with pytest.raises(ContractError):
        assert_bundle_inventory(names, TAG)
