#!/usr/bin/env python3
"""Fail-closed tracker signature scanner for Android build evidence."""

import argparse
import datetime as dt
import json
import re
import sys
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 100_000
ARCHIVE_SUFFIXES = {".apk", ".aab", ".apks", ".zip", ".jar", ".aar"}


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class Finding:
    signature_id: str
    category: str
    description: str
    location: str
    excerpt: str
    excepted: bool = False


def load_manifest(path: Path) -> tuple[dict, list[tuple[dict, re.Pattern[bytes]]]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"invalid signature manifest: {exc}") from exc
    if data.get("schema_version") != 1 or not isinstance(data.get("signatures"), list) or not data["signatures"]:
        raise ManifestError("invalid signature manifest: schema_version=1 and non-empty signatures are required")
    required = {"id", "category", "description", "pattern"}
    seen = set()
    compiled = []
    for entry in data["signatures"]:
        if not isinstance(entry, dict) or not required.issubset(entry) or not all(entry[key] for key in required):
            raise ManifestError("invalid signature manifest: incomplete signature")
        if entry["id"] in seen:
            raise ManifestError(f"invalid signature manifest: duplicate id {entry['id']}")
        seen.add(entry["id"])
        try:
            compiled.append((entry, re.compile(entry["pattern"].encode("ascii"), re.IGNORECASE)))
        except (UnicodeEncodeError, re.error) as exc:
            raise ManifestError(f"invalid signature manifest: bad pattern for {entry['id']}: {exc}") from exc
    exceptions = data.get("exceptions", [])
    if not isinstance(exceptions, list):
        raise ManifestError("invalid signature manifest: exceptions must be a list")
    today = dt.date.today()
    for exception in exceptions:
        fields = {"signature_id", "path_regex", "rationale", "owner", "reviewed_on", "expires_on"}
        if not isinstance(exception, dict) or not fields.issubset(exception) or not all(exception[key] for key in fields):
            raise ManifestError("invalid signature manifest: incomplete exception review record")
        if exception["signature_id"] not in seen:
            raise ManifestError(f"invalid signature manifest: exception references unknown signature {exception['signature_id']}")
        try:
            re.compile(exception["path_regex"])
            reviewed = dt.date.fromisoformat(exception["reviewed_on"])
            expiry = dt.date.fromisoformat(exception["expires_on"])
        except (re.error, ValueError) as exc:
            raise ManifestError(f"invalid signature manifest: malformed exception: {exc}") from exc
        path_regex = exception["path_regex"].strip()
        broad_patterns = {".*", "^.*$", ".+", "^.+$", ".*?", "^.*?$"}
        if path_regex in broad_patterns or not any(char.isalnum() for char in path_regex):
            raise ManifestError(f"invalid signature manifest: broad path wildcard for {exception['signature_id']}")
        if reviewed > today:
            raise ManifestError(f"invalid signature manifest: future review date for {exception['signature_id']}")
        if expiry < today:
            raise ManifestError(f"invalid signature manifest: expired exception for {exception['signature_id']}")
        if expiry <= reviewed:
            raise ManifestError(f"invalid signature manifest: expiry must follow review for {exception['signature_id']}")
        if (expiry - reviewed).days > 90:
            raise ManifestError(f"invalid signature manifest: exception review window exceeds 90 days for {exception['signature_id']}")
    return data, compiled


def iter_payloads(path: Path, location: str | None = None, depth: int = 0):
    if depth > 4:
        raise ManifestError(f"archive nesting limit exceeded: {location or path}")
    if path.is_dir():
        for child in sorted(path.rglob("*")):
            if child.is_file():
                yield from iter_payloads(child, str(child), depth)
        return
    location = location or str(path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ManifestError(f"cannot read scan target {path}: {exc}") from exc
    yield location, raw
    if path.suffix.lower() in ARCHIVE_SUFFIXES or zipfile.is_zipfile(BytesIO(raw)):
        try:
            with zipfile.ZipFile(BytesIO(raw)) as archive:
                members = archive.infolist()
                if len(members) > MAX_ARCHIVE_MEMBERS:
                    raise ManifestError(f"archive member limit exceeded: {location}")
                for member in members:
                    if member.is_dir():
                        continue
                    if member.file_size > MAX_MEMBER_BYTES:
                        raise ManifestError(f"archive member size limit exceeded: {location}!{member.filename}")
                    payload = archive.read(member)
                    nested_location = f"{location}!{member.filename}"
                    yield nested_location, payload
                    if Path(member.filename).suffix.lower() in ARCHIVE_SUFFIXES or zipfile.is_zipfile(BytesIO(payload)):
                        with tempfile_payload(payload) as nested:
                            yield from iter_payloads(nested, nested_location, depth + 1)
        except (zipfile.BadZipFile, RuntimeError) as exc:
            raise ManifestError(f"cannot inspect archive {location}: {exc}") from exc


class tempfile_payload:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.path = None

    def __enter__(self):
        import tempfile
        handle = tempfile.NamedTemporaryFile(delete=False)
        handle.write(self.payload)
        handle.close()
        self.path = Path(handle.name)
        return self.path

    def __exit__(self, *_):
        if self.path:
            self.path.unlink(missing_ok=True)


def is_excepted(manifest: dict, signature_id: str, location: str) -> bool:
    return any(
        item["signature_id"] == signature_id and re.search(item["path_regex"], location)
        for item in manifest.get("exceptions", [])
    )


def scan(manifest: dict, signatures, targets: list[Path]) -> list[Finding]:
    findings = []
    for target in targets:
        if not target.exists():
            raise ManifestError(f"scan target does not exist: {target}")
        for location, payload in iter_payloads(target):
            for entry, pattern in signatures:
                match = pattern.search(payload)
                if match:
                    excerpt = match.group(0).decode("ascii", errors="replace")[:160]
                    findings.append(Finding(entry["id"], entry["category"], entry["description"], location, excerpt,
                                            is_excepted(manifest, entry["id"], location)))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--summary", type=Path)
    parser.add_argument("targets", type=Path, nargs="+")
    args = parser.parse_args()
    try:
        manifest, signatures = load_manifest(args.manifest)
        findings = scan(manifest, signatures, args.targets)
    except ManifestError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    active = [finding for finding in findings if not finding.excepted]
    for finding in findings:
        status = "EXCEPTED" if finding.excepted else "PROHIBITED"
        print(f"{status} [{finding.category}] {finding.signature_id} {finding.location}: {finding.excerpt}")
    summary = {
        "schema_version": 1,
        "manifest_reviewed_on": manifest["reviewed_on"],
        "targets_scanned": len(args.targets),
        "prohibited_findings": len(active),
        "reviewed_exceptions": len(findings) - len(active),
        "result": "fail" if active else "pass",
    }
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    if active:
        print(f"tracker scan failed: {len(active)} prohibited finding(s)")
        return 2
    print(f"tracker scan passed: {len(findings)} finding(s), {len(findings) - len(active)} reviewed exception(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
