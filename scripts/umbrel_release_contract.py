#!/usr/bin/env python3
"""Deterministic identity of the two self-host application images; no network I/O."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from selfhost_release_contract import (
    ContractError, ReleaseIdentity, assert_manifest_matches, parse_manifest,
    validate_against_schema,
)

MANIFEST_NAME = "umbrel-images.json"
WEB_REPOSITORY = "ghcr.io/silent-suite/silentsuite-web-selfhost"
SERVER_REPOSITORY = "ghcr.io/silent-suite/silentsuite-server"
SCHEMA = Path(__file__).resolve().parents[1] / "contracts/umbrel-images.schema.json"
BUILD_ARGS = {
    "NEXT_PUBLIC_SELF_HOSTED": "true",
    "NEXT_PUBLIC_ETEBASE_SERVER_URL": "",
    "NEXT_PUBLIC_OWNER_REGISTRATION": "true",
    "NEXT_PUBLIC_BTCPAY_CHECKOUT_ENABLED": "false",
    "NEXT_PUBLIC_SIGNUP_ANALYTICS_ENABLED": "false",
    "NEXT_PUBLIC_LOCAL_CACHE_ENABLED": "false",
}


def unique_object(pairs):
    document = {}
    for key, value in pairs:
        if key in document:
            raise ContractError(f"duplicate identity field: {key}")
        document[key] = value
    return document


def component(repository, source, index, amd64, arm64):
    return {
        "imageRepository": repository, "expectedRevision": source,
        "indexDigest": index, "amd64Digest": amd64, "arm64Digest": arm64,
    }


def verify(text, tag, source, server_text):
    try:
        document = json.loads(text, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError) as error:
        raise ContractError(f"invalid Umbrel image identity: {error}") from error
    validate_against_schema(document, json.loads(SCHEMA.read_text(encoding="utf-8")))
    if document["tag"] != tag or document["sourceCommit"] != source:
        raise ContractError("Umbrel tag/sourceCommit differs from admitted identity")
    server = parse_manifest(server_text)
    assert_manifest_matches(server, ReleaseIdentity(
        tag, source, server["indexDigest"], server["amd64Digest"], server["arm64Digest"],
    ))
    expected_server = component(
        SERVER_REPOSITORY, source, server["indexDigest"], server["amd64Digest"], server["arm64Digest"],
    )
    if document["server"] != expected_server:
        raise ContractError("Umbrel server identity differs from server-image.json")
    if document["web"]["expectedRevision"] != source:
        raise ContractError("Umbrel web revision differs from sourceCommit")
    for name in ("web", "server"):
        image = document[name]
        if len({image["indexDigest"], image["amd64Digest"], image["arm64Digest"]}) != 3:
            raise ContractError(f"{name}: index and native children must differ")
    return document


def render(tag, source, server_text, web_index, web_amd64, web_arm64):
    server = parse_manifest(server_text)
    document = {
        "schemaVersion": 1, "tag": tag, "sourceCommit": source,
        "platforms": ["linux/amd64", "linux/arm64"],
        "web": component(WEB_REPOSITORY, source, web_index, web_amd64, web_arm64),
        "server": component(
            SERVER_REPOSITORY, source, server["indexDigest"], server["amd64Digest"], server["arm64Digest"],
        ),
        "buildArgs": dict(BUILD_ARGS),
    }
    text = json.dumps(document, indent=2, sort_keys=True) + "\n"
    verify(text, tag, source, server_text)
    return text


def write_or_verify(path, expected, write=False):
    if path.is_symlink():
        raise ContractError("Umbrel identity must not be a symlink")
    if path.exists():
        if path.read_bytes() != expected.encode("utf-8"):
            raise ContractError("Umbrel identity already exists with different bytes")
    elif write:
        with path.open("xb") as output:
            output.write(expected.encode("utf-8"))
    else:
        raise ContractError("Umbrel identity is missing")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--web-index-digest", required=True)
    parser.add_argument("--web-amd64-digest", required=True)
    parser.add_argument("--web-arm64-digest", required=True)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        expected = render(
            args.tag, args.source_commit,
            (args.directory / "server-image.json").read_text(encoding="utf-8"),
            args.web_index_digest, args.web_amd64_digest, args.web_arm64_digest,
        )
        write_or_verify(args.directory / MANIFEST_NAME, expected, args.write)
    except (ContractError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
