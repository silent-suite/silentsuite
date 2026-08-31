"""Shared contract helpers for the self-host release bundle.

The release workflow, the bundle verifier, and the contract tests all import
these helpers so the manifest schema, the checksum grammar, the archive safety
rules, and the bundle inventory have exactly one definition in the repository.

The installer re-implements the same grammar in POSIX-ish shell because it runs
on operator machines with no Python guarantee; `tests/test_self_host_bundle.py`
asserts the two implementations stay aligned.
"""

from __future__ import annotations

import hashlib
import json
import re
import tarfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "contracts" / "self-host-server-image.schema.json"
MANIFEST_NAME = "server-image.json"
IMAGE_REPOSITORY = "ghcr.io/silent-suite/silentsuite-server"
SUPPORTED_PLATFORMS = ("linux/amd64", "linux/arm64")

# Every tracked self-host file ships in the bundle. The inventory is explicit so
# a new operator-facing file cannot be silently dropped from a release; the
# contract test compares it against the tracked directory listing.
BUNDLE_SOURCE_FILES = (
    ".env.example",
    "SELF-HOSTING.md",
    "backup.sh",
    "close-signups.sh",
    "docker-compose.yml",
    "install.sh",
    "success.html",
    "update.sh",
    "verify.sh",
)
EXECUTABLE_SUFFIXES = (".sh",)

# One record, two spaces, exact basename, single terminating newline.
CHECKSUM_RECORD = re.compile(r"(?P<digest>[0-9a-fA-F]{64})  (?P<name>[^\s/][^\n]*)\n\Z")

DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
TAG_PATTERN = re.compile(r"^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$")


class ContractError(ValueError):
    """A release artefact violated the published contract."""


@dataclass(frozen=True)
class ReleaseIdentity:
    tag: str
    source_commit: str
    index_digest: str
    amd64_digest: str
    arm64_digest: str

    def manifest(self) -> dict:
        return {
            "schemaVersion": 1,
            "tag": self.tag,
            "sourceCommit": self.source_commit,
            "imageRepository": IMAGE_REPOSITORY,
            "indexDigest": self.index_digest,
            "amd64Digest": self.amd64_digest,
            "arm64Digest": self.arm64_digest,
            "platforms": list(SUPPORTED_PLATFORMS),
            "expectedRevision": self.source_commit,
        }


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_against_schema(document: object, schema: dict | None = None) -> None:
    """Enforce the subset of JSON Schema the manifest contract actually uses.

    Adding a keyword to the schema that is not handled here raises, so the
    schema can never claim a constraint the verifier silently ignores.
    """

    schema = load_schema() if schema is None else schema
    _validate(document, schema, "$")


_SUPPORTED_KEYWORDS = {
    "$schema",
    "$id",
    "title",
    "description",
    "type",
    "const",
    "enum",
    "pattern",
    "required",
    "properties",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "uniqueItems",
}

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "boolean": bool,
}


def _validate(value: object, schema: dict, path: str) -> None:
    unsupported = set(schema) - _SUPPORTED_KEYWORDS
    if unsupported:
        raise ContractError(f"{path}: schema uses unsupported keywords {sorted(unsupported)}")

    if "const" in schema and value != schema["const"]:
        raise ContractError(f"{path}: expected {schema['const']!r}, got {value!r}")

    if "type" in schema:
        expected = _TYPES[schema["type"]]
        if expected is int and isinstance(value, bool):
            raise ContractError(f"{path}: expected integer, got boolean")
        if not isinstance(value, expected):
            raise ContractError(f"{path}: expected {schema['type']}, got {type(value).__name__}")

    if "enum" in schema and value not in schema["enum"]:
        raise ContractError(f"{path}: {value!r} is not one of {schema['enum']}")

    if "pattern" in schema:
        if not isinstance(value, str) or not re.fullmatch(schema["pattern"], value):
            raise ContractError(f"{path}: {value!r} does not match {schema['pattern']}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            raise ContractError(f"{path}: expected at least {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            raise ContractError(f"{path}: expected at most {schema['maxItems']} items")
        if schema.get("uniqueItems") and len(value) != len({json.dumps(item, sort_keys=True) for item in value}):
            raise ContractError(f"{path}: items must be unique")
        if "items" in schema:
            for index, item in enumerate(value):
                _validate(item, schema["items"], f"{path}[{index}]")

    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                raise ContractError(f"{path}: missing required field {name!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                raise ContractError(f"{path}: unexpected fields {unknown}")
        for name, child in value.items():
            if name in properties:
                _validate(child, properties[name], f"{path}.{name}")


def render_manifest(identity: ReleaseIdentity) -> str:
    """Serialise the manifest in the exact grammar the installer parses.

    Two-space indentation, one scalar per line, key order fixed by the schema's
    required list. The shell installer relies on this shape, so the renderer and
    the schema are kept in the same module.
    """

    document = identity.manifest()
    validate_against_schema(document)
    assert_platforms_exact(document)
    return json.dumps(document, indent=2, sort_keys=False) + "\n"


def assert_platforms_exact(document: dict) -> None:
    """The platform list is a closed, ordered set — not a hint.

    The schema already forbids unknown members, duplicates, and the wrong
    length; this pins the canonical order too, so a manifest can never describe
    the supported platforms in a shape the installer has not been tested
    against.
    """

    platforms = document.get("platforms")
    if platforms != list(SUPPORTED_PLATFORMS):
        raise ContractError(
            f"platforms must be exactly {list(SUPPORTED_PLATFORMS)} in that order, got {platforms!r}"
        )


def parse_manifest(text: str) -> dict:
    try:
        document = json.loads(text)
    except json.JSONDecodeError as error:
        raise ContractError(f"manifest is not valid JSON: {error}") from error
    validate_against_schema(document)
    assert_platforms_exact(document)
    return document


def assert_manifest_matches(document: dict, identity: ReleaseIdentity) -> None:
    expected = identity.manifest()
    for key, value in expected.items():
        if document.get(key) != value:
            raise ContractError(f"manifest field {key!r} is {document.get(key)!r}, expected {value!r}")


def parse_checksum_file(text: str, expected_name: str) -> str:
    """Return the digest from a strict one-record sha256 sidecar."""

    match = CHECKSUM_RECORD.fullmatch(text)
    if match is None:
        raise ContractError(
            "checksum sidecar must contain exactly one '<64 hex>  <name>' record "
            "terminated by a single newline"
        )
    if match.group("name") != expected_name:
        raise ContractError(
            f"checksum sidecar names {match.group('name')!r}, expected {expected_name!r}"
        )
    return match.group("digest").lower()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_basename(tag: str) -> str:
    if not TAG_PATTERN.fullmatch(tag):
        raise ContractError(f"tag {tag!r} is not an immutable release tag")
    return f"silentsuite-self-host-{tag}.tar.gz"


def bundle_prefix(tag: str) -> str:
    if not TAG_PATTERN.fullmatch(tag):
        raise ContractError(f"tag {tag!r} is not an immutable release tag")
    return f"silentsuite-self-host-{tag}"


def assert_archive_members_safe(archive: Path, tag: str) -> list[str]:
    """Reject anything an operator-side extraction must never be asked to write."""

    prefix = bundle_prefix(tag)
    names: list[str] = []
    with tarfile.open(archive, "r:gz") as handle:
        for member in handle.getmembers():
            name = member.name
            if member.islnk() or member.issym():
                raise ContractError(f"archive member {name!r} is a link")
            if not (member.isfile() or member.isdir()):
                raise ContractError(f"archive member {name!r} is not a regular file or directory")
            if name.startswith("/") or name.startswith("\\"):
                raise ContractError(f"archive member {name!r} is an absolute path")
            parts = name.split("/")
            if ".." in parts or "." in parts:
                raise ContractError(f"archive member {name!r} escapes the bundle root")
            if name != prefix and not name.startswith(f"{prefix}/"):
                raise ContractError(f"archive member {name!r} is outside {prefix}/")
            names.append(name)
    return names


def assert_bundle_inventory(names: list[str], tag: str) -> None:
    prefix = bundle_prefix(tag)
    expected = {f"{prefix}/{name}" for name in BUNDLE_SOURCE_FILES}
    expected.add(f"{prefix}/{MANIFEST_NAME}")
    actual = {name for name in names if name != prefix}
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if missing:
        raise ContractError(f"bundle is missing {missing}")
    if unexpected:
        raise ContractError(f"bundle contains unexpected members {unexpected}")
