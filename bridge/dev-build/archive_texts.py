"""Texts placed beside the bundle in the desktop dev archive (#171, S2b-2).

- fill: put the build commit into README-dev-build.txt, NOTICES/RELINKING.txt and
  NOTICES/INSTALLATION-INFORMATION.txt ({{GIT_SHA}}); refuse any other {{...}}
  placeholder or a left-over draft block, so an unadmitted text never ships.
- source: SOURCE.txt, from the platform policy's source archives, their records
  (download URL) and the source-materials job's verification receipt. It says how
  each archive was checked: HTTPS plus the pinned SHA256, and a signature check
  only where the publisher provides one and the job verified it (owner decision
  2026-11-12, experimental test downloads only).
- build-info: BUILD-INFO.json, the build identity and a SHA256 for every file in
  the program folder (links as their literal target).
- verify: compare a program folder with BUILD-INFO.json (changed, missing, extra).

Exit codes: 0 done / verified, 1 verification failures, 2 refused or unreadable input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

DOCUMENTS = ("README-dev-build.txt", "NOTICES/RELINKING.txt", "NOTICES/INSTALLATION-INFORMATION.txt")
PLACEHOLDER = "{{GIT_SHA}}"
LEFTOVER = re.compile(r"\{\{[^}]*\}\}")
DRAFT_MARKERS = ("NOT ADMITTED", "[DRAFT")
GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SCHEMA_VERSION = 1


class InputError(Exception):
    """Refused or unreadable input; the CLI exits 2."""


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_sha(sha) -> None:
    if not isinstance(sha, str) or not GIT_SHA.match(sha):
        raise InputError("the commit must be a full 40-character lowercase git SHA")


# --- fill --------------------------------------------------------------------


def fill(root, sha) -> list[str]:
    _check_sha(sha)
    root = Path(root)
    texts = {}
    for name in DOCUMENTS:
        path = root / name
        if not path.is_file():
            raise InputError(f"{name} is missing")
        text = path.read_text(encoding="utf-8")
        if PLACEHOLDER not in text:
            raise InputError(f"{name} has no {PLACEHOLDER} placeholder")
        filled = text.replace(PLACEHOLDER, sha)
        if LEFTOVER.search(filled):
            raise InputError(f"{name} has another placeholder: {LEFTOVER.search(filled).group(0)}")
        if any(marker in filled for marker in DRAFT_MARKERS):
            raise InputError(f"{name} still carries a draft block")
        texts[path] = filled
    for path, text in texts.items():  # all checked before any write
        path.write_text(text, encoding="utf-8", newline="")
    return [name for name in DOCUMENTS]


# --- source ------------------------------------------------------------------


def _verified_signature(entry) -> dict | None:
    signature = entry.get("signature")
    if signature is None:
        return None
    if not isinstance(signature, dict) or signature.get("verified") is not True or not signature.get("type"):
        raise InputError(f"{entry.get('file')}: a signature entry that was not verified")
    return signature


def source_text(sha, policy, records, verification) -> str:
    _check_sha(sha)
    artifact = verification.get("artifact") if isinstance(verification, dict) else None
    if not artifact:
        raise InputError("the verification receipt names no source artifact")
    application = verification.get("application") or {}
    if application.get("git_sha") != sha:
        raise InputError("the application source archive is not of this commit")
    if not application.get("file") or not SHA256.match(str(application.get("sha256", ""))):
        raise InputError("the application source archive has no file name or SHA256")
    by_file = {}
    for row in records or []:
        by_file.setdefault(row.get("file"), []).append(row)
    verified = {}
    for entry in verification.get("archives") or []:
        if entry.get("file") in verified:
            raise InputError(f"{entry.get('file')}: verified twice")
        verified[entry.get("file")] = entry
    archives = policy.get("source_archives") or []
    if not archives:
        raise InputError("the policy lists no source archives")

    lines = [
        "SilentSuite Bridge desktop - experimental development build",
        f"Commit: {sha}",
        f"Platform: {policy.get('platform', 'not stated')}",
        "",
        "Where the source is",
        "-------------------",
        f"All source archives listed here are in the GitHub Actions artifact '{artifact}'",
        "of the same workflow run that built this archive.",
        "",
        "SilentSuite Bridge (AGPL-3.0-only): a git archive of the commit above,",
        f"  {application['file']}",
        f"  SHA256 {application['sha256']}",
        "  Build recipe: bridge/silentsuite-bridge-desktop.spec and",
        "  .github/workflows/build-bridge-desktop-dev.yml at that commit.",
        "",
        "Third-party source archives",
        "---------------------------",
        "Each archive was downloaded over HTTPS from the address shown, and its SHA256",
        "matched the pinned value, which was taken from the publisher's published",
        "checksum when it was first fetched. A signature was checked only where the",
        "publisher provides one; that is stated per archive. For the other archives",
        "no signature was checked, so the check shows the file is the one we pinned,",
        "not that it came from the publisher's own signing key. This is accepted for",
        "experimental test downloads only.",
        "Full signature checks are required before any real release.",
        "",
    ]
    for archive in archives:
        name = archive.get("file")
        digest = archive.get("sha256")
        if not SHA256.match(str(digest or "")):
            raise InputError(f"{name}: the policy has no SHA256")
        rows = by_file.get(name) or []
        if len(rows) != 1:
            raise InputError(f"{name}: needs exactly one source record, found {len(rows)}")
        record = rows[0]
        if record.get("sha256") != digest or not record.get("url"):
            raise InputError(f"{name}: the source record's SHA256 or URL does not match the policy")
        entry = verified.get(name)
        if entry is None or entry.get("sha256") != digest:
            raise InputError(f"{name}: not verified by the source-materials job with this SHA256")
        signature = _verified_signature(entry)
        lines += [f"{archive.get('name')} {archive.get('version')}",
                  f"  file    {name}",
                  f"  SHA256  {digest}",
                  f"  from    {record['url']}"]
        if record.get("kind") and record["kind"] != "source":
            lines.append(f"  kind    {record['kind']} (not source code)")
        if signature is None:
            lines.append("  check   HTTPS and pinned SHA256; no signature check")
        else:
            lines.append(f"  check   HTTPS, pinned SHA256 and a verified {signature['type']} signature"
                         f" (identity {signature.get('identity')}, issuer {signature.get('issuer')})")
        lines.append("")
    lines += [
        "Limits",
        "------",
        "The PySide6 and shiboken6 wheels carry no commit stamp. Their source above",
        "matches by version and file correspondence; it is not a proof that this",
        "source rebuilds those exact binaries.",
        "This file is not legal advice and not a compliance certification.",
        "",
    ]
    return "\n".join(lines)


# --- build-info / verify -----------------------------------------------------


def _bundle_entries(bundle: Path) -> list[dict]:
    entries = []
    for directory, dirs, files in os.walk(bundle):
        dirs.sort()
        for name in sorted(files) + sorted(d for d in dirs if (Path(directory) / d).is_symlink()):
            path = Path(directory) / name
            relative = path.relative_to(bundle).as_posix()
            if path.is_symlink():
                entries.append({"path": relative, "symlink": os.readlink(path)})
            else:
                entries.append({"path": relative, "sha256": _sha_file(path), "size": path.stat().st_size})
    return sorted(entries, key=lambda e: e["path"])


def build_info(sha, platform, bundle, extra) -> dict:
    _check_sha(sha)
    bundle = Path(bundle)
    if not bundle.is_dir():
        raise InputError("the program folder is missing")
    info = {"schema_version": SCHEMA_VERSION, "git_sha": sha, "platform": platform, "program_folder": bundle.name}
    for key, value in sorted((extra or {}).items()):
        if key in info or key == "bundle_files":
            raise InputError(f"extra build information may not replace {key}")
        info[key] = value
    info["bundle_files"] = _bundle_entries(bundle)
    return info


def verify(info, bundle) -> list[str]:
    failures = []
    bundle = Path(bundle)
    if not bundle.is_dir():
        return ["the program folder is missing"]
    expected = {entry.get("path"): entry for entry in info.get("bundle_files") or []}
    actual = {entry["path"]: entry for entry in _bundle_entries(bundle)}
    for path in sorted(set(expected) - set(actual)):
        failures.append(f"missing: {path}")
    for path in sorted(set(actual) - set(expected)):
        failures.append(f"not in BUILD-INFO.json: {path}")
    for path in sorted(set(expected) & set(actual)):
        if expected[path] != actual[path]:
            failures.append(f"differs: {path}")
    return failures


# --- CLI ---------------------------------------------------------------------


def _load(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise InputError(f"{path.name} is unreadable ({type(exc).__name__})") from None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Archive texts for the desktop dev build.")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("fill")
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--sha", required=True)
    p = sub.add_parser("source")
    p.add_argument("--sha", required=True)
    p.add_argument("--policy", required=True, type=Path, help="the platform policy")
    p.add_argument("--records", required=True, type=Path, help="source records (file, sha256, url): a list, or the grouped source-archives.json")
    p.add_argument("--verification", required=True, type=Path, help="the source-materials job's receipt")
    p.add_argument("--out", required=True, type=Path)
    p = sub.add_parser("build-info")
    p.add_argument("--sha", required=True)
    p.add_argument("--platform", required=True)
    p.add_argument("--bundle", required=True, type=Path)
    p.add_argument("--extra", type=Path, help="JSON object of further build facts")
    p.add_argument("--out", required=True, type=Path)
    p = sub.add_parser("verify")
    p.add_argument("--build-info", required=True, type=Path)
    p.add_argument("--bundle", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "fill":
            for name in fill(args.root, args.sha):
                print(f"filled {name}")
        elif args.command == "source":
            policy, records = _load(args.policy), _load(args.records)
            if isinstance(records, dict):  # grouped source-archives.json: shared plus this platform
                records = list(records.get("shared") or []) + list(records.get(policy.get("platform")) or [])
            text = source_text(args.sha, policy, records, _load(args.verification))
            args.out.write_text(text, encoding="utf-8", newline="\n")
        elif args.command == "build-info":
            info = build_info(args.sha, args.platform, args.bundle, _load(args.extra) if args.extra else {})
            args.out.write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
        else:
            failures = verify(_load(args.build_info), args.bundle)
            for failure in failures:
                print(f"FAIL {failure}")
            print(f"archive_texts verify: {len(failures)} failure(s)")
            return 1 if failures else 0
    except (InputError, OSError) as exc:
        print(f"archive_texts {args.command}: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
