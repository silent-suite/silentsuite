#!/usr/bin/env python3
"""Validate sanitized, app-UID-scoped Android network evidence."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REQUIRED_SCENARIOS = {
    "clean_launch", "idle_5m", "account_setup", "login", "foreground_sync",
    "background_sync", "network_failure", "logout",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allowlist", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--app-uid", type=int)
    parser.add_argument("--artifact-sha256")
    parser.add_argument("--raw-capture-sha256")
    parser.add_argument("--provenance-output", type=Path)
    args = parser.parse_args()
    allowed = {line.strip().lower() for line in args.allowlist.read_text(encoding="utf-8").splitlines()
               if line.strip() and not line.lstrip().startswith("#")}
    seen = set()
    seen_uids = set()
    failures = []
    try:
        provenance_values = (args.app_uid, args.artifact_sha256, args.raw_capture_sha256, args.provenance_output)
        if any(value is not None for value in provenance_values) and not all(value is not None for value in provenance_values):
            raise ValueError("app UID, artifact SHA-256, raw capture SHA-256, and provenance output are required together")
        for label, digest in (("artifact", args.artifact_sha256), ("raw capture", args.raw_capture_sha256)):
            if digest is not None and not SHA256_RE.fullmatch(digest):
                raise ValueError(f"{label} SHA-256 must be 64 lowercase hexadecimal characters")
        if args.app_uid is not None and args.app_uid < 10_000:
            raise ValueError("app UID must be an Android application UID")

        raw_evidence = args.evidence.read_bytes()
        lines = raw_evidence.decode("utf-8").splitlines()
        if not lines:
            raise ValueError("empty evidence")
        for number, line in enumerate(lines, 1):
            row = json.loads(line)
            scenario, uid, host, requests = row["scenario"], row["uid"], row["host"], row["requests"]
            if scenario not in REQUIRED_SCENARIOS or not isinstance(uid, int) or uid < 10_000:
                raise ValueError(f"line {number}: invalid scenario or app UID")
            seen_uids.add(uid)
            if not isinstance(requests, int) or requests < 0 or (requests == 0) != (host is None):
                raise ValueError(f"line {number}: inconsistent request count/host")
            seen.add(scenario)
            if host is not None and str(host).lower() not in allowed:
                failures.append(f"line {number}: host is not allowlisted: {host}")
            if scenario == "clean_launch" and requests != 0:
                failures.append("clean_launch must have zero outbound requests")
        if len(seen_uids) != 1 or (args.app_uid is not None and seen_uids != {args.app_uid}):
            raise ValueError("evidence must contain one app UID matching the recorded app UID")
    except (OSError, KeyError, TypeError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
        print(f"invalid network evidence: {exc}", file=sys.stderr)
        return 3
    if args.require_complete and seen != REQUIRED_SCENARIOS:
        failures.append("missing scenarios: " + ", ".join(sorted(REQUIRED_SCENARIOS - seen)))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 2
    if args.provenance_output:
        record = {
            "schema_version": 1,
            "app_uid": args.app_uid,
            "artifact_sha256": args.artifact_sha256,
            "raw_capture_sha256": args.raw_capture_sha256,
            "evidence_jsonl_sha256": hashlib.sha256(raw_evidence).hexdigest(),
        }
        args.provenance_output.parent.mkdir(parents=True, exist_ok=True)
        args.provenance_output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(f"network evidence passed: {len(lines)} UID-scoped endpoint row(s), {len(seen)} scenario(s), app UID {next(iter(seen_uids))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
