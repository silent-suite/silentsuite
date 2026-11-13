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
import lzma
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


def _download(url: str, target: Path, attempts: int = 5) -> None:
    for attempt in range(attempts):
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
            if attempt == attempts - 1:
                status = getattr(exc, "code", None)
                raise InputError(f"{url}: download failed ({type(exc).__name__}{f' {status}' if status else ''})") \
                    from None
            time.sleep(15 * (attempt + 1))


def fetch(rows, directory: Path, archive=None) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for row in rows:
        try:
            _download(row["url"], directory / row["file"])
        except InputError:
            if not row.get("final_url"):
                raise
            # The recorded mirror of the same file; the SHA256 check in verify() still applies.
            _download(_https(row["final_url"], row["file"]), directory / row["file"])
        if "sigstore" in row:
            _download(row["sigstore"]["bundle_url"], directory / _bundle_name(row))
    if archive and _ubuntu_rows(rows):
        base = f"https://snapshot.ubuntu.com/ubuntu/{archive['snapshot']}/dists"
        for suite in archive["suites"]:
            target = directory / "ubuntu-archive" / suite
            target.mkdir(parents=True, exist_ok=True)
            _download(f"{base}/{suite}/InRelease", target / "InRelease")
            for component in archive["components"]:
                _download(f"{base}/{suite}/{component}/source/Sources.xz", target / f"{component}-Sources.xz")


# --- Ubuntu archive chain ------------------------------------------------------------
# Ubuntu signs each suite's InRelease with its archive key. The signed text lists the
# SHA256 of every Sources index; Sources lists each source package's .dsc and files; each
# .dsc lists its files again. A launchpad.net row is verified only through that chain.
UBUNTU_HOST = "launchpad.net"
SNAPSHOT = re.compile(r"^\d{8}T\d{6}Z$")
NAME = re.compile(r"^[a-z0-9-]+$")


def _ubuntu_rows(rows) -> list[dict]:
    return [r for r in rows if urllib.parse.urlsplit(r["url"]).netloc == UBUNTU_HOST]


def gpgv_check(inrelease, keyring) -> tuple[str, str]:
    """The signed text of an InRelease and the signing key's fingerprint, via gpgv."""
    output = Path(str(inrelease) + ".verified")
    done = subprocess.run(["gpgv", "--status-fd", "1", "--keyring", str(keyring), "--output", str(output),
                           str(inrelease)], capture_output=True, text=True, timeout=120)
    signed = [line.split()[2] for line in done.stdout.splitlines() if line.startswith("[GNUPG:] VALIDSIG ")]
    if done.returncode != 0 or len(signed) != 1 or not output.is_file():
        raise InputError(f"{Path(inrelease).parent.name}: InRelease signature did not verify")
    return output.read_text(encoding="utf-8"), signed[0]


def _checksums(text: str) -> list[tuple[str, int, str]]:
    match = re.search(r"^Checksums-Sha256:\n((?:[ \t].*\n?)+)", text, re.M)
    if not match:
        return []
    entries = []
    for line in match.group(1).splitlines():
        parts = line.split()
        if len(parts) == 3:
            entries.append((parts[0], int(parts[1]), parts[2]))
    return entries


def _release_hashes(text: str) -> dict[str, str]:
    hashes, inside = {}, False
    for line in text.splitlines():
        if line.startswith("SHA256:"):
            inside = True
            continue
        if inside and line.startswith(" "):
            parts = line.split()
            if len(parts) == 3:
                hashes[parts[2]] = parts[0]
        elif inside:
            break
    return hashes


def _verify_ubuntu(rows, directory: Path, archive, archive_check) -> dict:
    """Signature records for every launchpad.net row, or InputError."""
    if not archive:
        raise InputError("Ubuntu source rows need the records' ubuntu_archive settings")
    if not SNAPSHOT.match(str(archive.get("snapshot", ""))) or not archive.get("keyring") \
            or not all(NAME.match(str(x)) for x in archive.get("suites", []) + archive.get("components", [])):
        raise InputError("malformed ubuntu_archive settings")
    stanzas = []  # (suite, component, fingerprint, entries)
    for suite in archive["suites"]:
        folder = directory / "ubuntu-archive" / suite
        release, fingerprint = archive_check(folder / "InRelease", archive["keyring"])
        hashes = _release_hashes(release)
        for component in archive["components"]:
            data = (folder / f"{component}-Sources.xz").read_bytes()
            if hashlib.sha256(data).hexdigest() != hashes.get(f"{component}/source/Sources.xz"):
                raise InputError(f"{suite}/{component}: Sources.xz does not match the signed InRelease")
            for text in lzma.decompress(data).decode("utf-8", "replace").split("\n\n"):
                entries = _checksums(text + "\n")
                if entries:
                    stanzas.append((suite, component, fingerprint, entries))
    wanted = {r["file"]: r for r in _ubuntu_rows(rows)}
    signed = {}
    for name, row in wanted.items():
        if not name.endswith(".dsc"):
            continue
        key = (row["sha256"], row["bytes"], name)
        matches = [s for s in stanzas if key in s[3]]
        if not matches:
            raise InputError(f"{name}: not listed with this SHA256 and size in a signed Sources index")
        suite, component, fingerprint, entries = matches[0]
        dsc = set(_checksums((directory / name).read_bytes().decode("utf-8", "replace")))
        record = {"type": "ubuntu-archive", "identity": fingerprint, "verified": True,
                  "issuer": f"{suite}/{component} at snapshot.ubuntu.com {archive['snapshot']}"}
        signed[name] = record
        for sha, size, member in entries:
            if member == name or member not in wanted:
                continue
            other = wanted[member]
            if (other["sha256"], other["bytes"], member) != (sha, size, member) or (sha, size, member) not in dsc:
                raise InputError(f"{member}: differs from the signed Sources entry or the .dsc of {name}")
            signed[member] = record
    unbound = sorted(set(wanted) - set(signed))
    if unbound:
        raise InputError(f"Ubuntu rows not bound to a verified .dsc: {unbound}")
    return signed


def sigstore_cli(file, bundle, identity, issuer) -> bool:
    done = subprocess.run([sys.executable, "-m", "sigstore", "verify", "identity", "--bundle", str(bundle),
                           "--cert-identity", identity, "--cert-oidc-issuer", issuer, str(file)],
                          capture_output=True, text=True, timeout=300)
    if done.returncode != 0:
        print(f"sigstore verify failed for {Path(file).name}: {(done.stderr or done.stdout)[-1500:]}", file=sys.stderr)
    return done.returncode == 0


def verify(rows, directory, application, artifact, sigstore_check=sigstore_cli, archive=None,
           archive_check=gpgv_check) -> dict:
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
    if _ubuntu_rows(rows):
        ubuntu = _verify_ubuntu(rows, directory, archive, archive_check)
        for entry in archives:
            if entry["file"] in ubuntu:
                entry["signature"] = ubuntu[entry["file"]]
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
        records = _load(args.records)
        rows = plan(records, [p for p in args.platforms.split(",") if p])
        archive = records.get("ubuntu_archive")
        if args.command == "fetch":
            fetch(rows, args.dir, archive)
            print(f"source_materials: fetched {len(rows)} archives")
        else:
            if not re.match(r"^[0-9a-f]{40}$", args.git_sha) or not args.application.is_file():
                raise InputError("the application archive or the git SHA is missing or malformed")
            application = {"file": args.application.name, "sha256": _sha_file(args.application),
                           "bytes": args.application.stat().st_size, "git_sha": args.git_sha}
            receipt = verify(rows, args.dir, application, args.artifact, archive=archive)
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
