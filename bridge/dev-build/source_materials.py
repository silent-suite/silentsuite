"""Source materials for the desktop dev archive (#171, S2b-2 source-materials job).

plan    the archives to provide: the reviewed records' "shared" rows plus each
        packaged platform's rows, one per file name.
fetch   download each over HTTPS (and its Sigstore bundle where the record names one).
verify  size and SHA256 of every archive against the record, the Sigstore signature
        where the publisher provides one, and the application git archive; writes the
        receipt that archive_texts.py turns into SOURCE.txt.

Owner decision 2026-11-12 (experimental test downloads only): HTTPS plus the pinned
published checksum is accepted; check a signature where the publisher provides one;
full signature checks before any real release. Any missing, mismatched or
unverifiable archive fails, and the job then uploads nothing.

Exit codes: 0 done, 2 refused or unreadable input (including any failed check).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+~-]*$")


class InputError(Exception):
    """Refused input or a failed check; the CLI exits 2."""


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _https(url, what) -> str:
    if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme != "https":
        raise InputError(f"{what}: {url!r} is not an HTTPS URL")
    return url


def _bundle_name(row) -> str:
    return posixpath.basename(urllib.parse.urlsplit(row["sigstore"]["bundle_url"]).path)


def plan(records, platforms) -> list[dict]:
    rows = {}
    for group in ["shared", *platforms]:
        if group not in records:
            raise InputError(f"the source records have no {group!r} rows")
        for row in records[group]:
            name, digest = row.get("file"), row.get("sha256")
            if not isinstance(name, str) or not SAFE_NAME.match(name):
                raise InputError(f"unsafe or missing file name {name!r}")
            if not isinstance(digest, str) or not SHA256.match(digest):
                raise InputError(f"{name}: no SHA256")
            url = _https(row.get("url"), name)
            if urllib.parse.unquote(posixpath.basename(urllib.parse.urlsplit(url).path)) != name:
                raise InputError(f"{name}: the URL names a different file (a signature bundle or another archive)")
            if "sigstore" in row:
                spec = row["sigstore"]
                if not isinstance(spec, dict) or not all(spec.get(k) for k in ("bundle_url", "identity", "issuer")):
                    raise InputError(f"{name}: incomplete sigstore entry")
                _https(spec["bundle_url"], f"{name} sigstore bundle")
                if not SAFE_NAME.match(_bundle_name(row)):
                    raise InputError(f"{name}: unsafe bundle name")
            known = rows.get(name)
            if known is not None and known["sha256"] != digest:
                raise InputError(f"{name}: listed with two different SHA256 values")
            rows.setdefault(name, row)
    return [rows[name] for name in sorted(rows)]


def _download(url: str, target: Path) -> None:
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "silentsuite-bridge-dev-build"})
            with urllib.request.urlopen(request, timeout=120) as response, open(target, "wb") as handle:
                if urllib.parse.urlsplit(response.geturl()).scheme != "https":
                    raise InputError(f"{url} redirected away from HTTPS")
                while block := response.read(1 << 20):
                    handle.write(block)
            return
        except InputError:
            raise
        except OSError as exc:
            if attempt == 2:
                raise InputError(f"{url}: download failed ({type(exc).__name__})") from None
            time.sleep(5 * (attempt + 1))


def fetch(rows, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for row in rows:
        _download(row["url"], directory / row["file"])
        if "sigstore" in row:
            _download(row["sigstore"]["bundle_url"], directory / _bundle_name(row))


def sigstore_cli(file, bundle, identity, issuer) -> bool:
    done = subprocess.run([sys.executable, "-m", "sigstore", "verify", "identity", "--bundle", str(bundle),
                           "--cert-identity", identity, "--cert-oidc-issuer", issuer, str(file)],
                          capture_output=True, text=True, timeout=300)
    return done.returncode == 0


def verify(rows, directory, application, artifact, sigstore_check=sigstore_cli) -> dict:
    directory = Path(directory)
    if not artifact or not isinstance(application, dict):
        raise InputError("the artifact name and the application archive are required")
    archives = []
    for row in rows:
        path = directory / row["file"]
        if not path.is_file():
            raise InputError(f"{row['file']}: missing")
        size = path.stat().st_size
        if "bytes" in row and size != row["bytes"]:
            raise InputError(f"{row['file']}: {size} bytes, expected {row['bytes']}")
        actual = _sha_file(path)
        if actual != row["sha256"]:
            raise InputError(f"{row['file']}: SHA256 {actual} is not the pinned {row['sha256']}")
        signature = None
        if "sigstore" in row:
            spec = row["sigstore"]
            bundle = directory / _bundle_name(row)
            if not bundle.is_file():
                raise InputError(f"{row['file']}: the Sigstore bundle is missing")
            if not sigstore_check(path, bundle, spec["identity"], spec["issuer"]):
                raise InputError(f"{row['file']}: the Sigstore signature did not verify")
            signature = {"type": "sigstore", "identity": spec["identity"], "issuer": spec["issuer"],
                         "bundle": bundle.name, "bundle_sha256": _sha_file(bundle), "verified": True}
        archives.append({"file": row["file"], "sha256": actual, "bytes": size, "signature": signature})
    return {"artifact": artifact, "application": application, "archives": archives}


def _load(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise InputError(f"{Path(path).name} is unreadable ({type(exc).__name__})") from None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Source materials for the desktop dev archive.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("fetch", "verify"):
        p = sub.add_parser(name)
        p.add_argument("--records", required=True, type=Path)
        p.add_argument("--platforms", required=True, help="comma-separated, e.g. linux-x86_64,windows-x86_64")
        p.add_argument("--dir", required=True, type=Path)
    verify_parser = sub.choices["verify"]
    verify_parser.add_argument("--application", required=True, type=Path, help="the git archive of this commit")
    verify_parser.add_argument("--git-sha", required=True)
    verify_parser.add_argument("--artifact", required=True)
    verify_parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        rows = plan(_load(args.records), [p for p in args.platforms.split(",") if p])
        if args.command == "fetch":
            fetch(rows, args.dir)
            print(f"source_materials: fetched {len(rows)} archives")
        else:
            if not re.match(r"^[0-9a-f]{40}$", args.git_sha) or not args.application.is_file():
                raise InputError("the application archive or the git SHA is missing or malformed")
            application = {"file": args.application.name, "sha256": _sha_file(args.application),
                           "bytes": args.application.stat().st_size, "git_sha": args.git_sha}
            receipt = verify(rows, args.dir, application, args.artifact)
            args.out.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            signed = sum(1 for a in receipt["archives"] if a["signature"])
            print(f"source_materials: verified {len(rows)} archives ({signed} with a signature check)")
    except InputError as exc:
        print(f"source_materials {args.command}: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"source_materials {args.command}: {type(exc).__name__}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
