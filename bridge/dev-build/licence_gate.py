"""Licence, notice and source gate for the SilentSuite Bridge desktop dev archive (#171, S2b-2).

Checks the collector's facts (collect_bundle_facts.py) for ONE platform against a
reviewed platform policy, the assembled archive (NOTICES/, README) and the source
directory. It decides nothing itself: everything the policy does not cover fails.
A pass means only that the facts, policy and files agree; it is no legal
certification, and synthetic test fixtures certify no real vendor contents.

Library use (tested in bridge/tests/test_desktop_dev_licence_gate.py):
    check(facts, policy, archive_root, source_dir, source_receipt=None) -> failure strings ([] = pass)
CLI:
    python licence_gate.py --facts F --policy P --archive-root DIR (--source-dir DIR | --source-receipt R)
    P is a platform policy, or notices/policy.json whose "platforms" map names one
    file per platform (relative to the directory that holds notices/); the entry for
    facts["platform"] is used. Exit 0 pass, 1 fail, 2 unreadable input.

Rules (each fails closed):
- schema_version 1 for facts and policy; a present "admitted" must be true; a policy
  "platform" must equal facts["platform"];
- distributions: listed, exact version, allowed licence; each vendor licence/notice
  file recorded with text and SHA256 and preserved under NOTICES/ with identical
  bytes (by hash, not by filename); no declared licence file missing; no duplicates;
- unmapped files: each matches a runtime_files pattern with an allowed licence; a rule
  that pins "sha256"/"size" matches only a file with exactly those facts; a rule with
  "os_package" {package, version, source} needs the facts' dpkg origin of that exact
  package and version, and "source" among the offered source archives;
- unmapped modules: each has a runtime_modules rule by exact name with an allowed
  licence; a rule with typecode/toc_sources_exactly needs facts["module_sources"] to
  be exactly those sources, each with exactly that typecode;
- Qt libraries: each basename listed with an allowed licence;
- licence texts: every used licence's licence_text_files (else licence_texts) present; an
  explicit empty list (no notice needed) is accepted only for a licence whose every use is
  a runtime rule pinned to one exact file by SHA256;
- required_notices, prominent_notice, required_statements (file, sha256?,
  must_contain, must_not_contain?), elections (elected alternative, platform, text);
- source archives: present in source_dir with the listed SHA256, or, in the package
  job, covered by the same run's source-materials receipt (one entry per archive with
  the same SHA256; that job hashed the files and uploads them only with the binaries);
- relinking: admitted, with non-empty instructions and determination texts.
Every policy path must stay inside its root. The gate keeps no state between calls
and never modifies its inputs, so one platform's check cannot affect another's.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

SCHEMA_VERSION = 1
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SOURCE_KEYS = ("kind", "path_class", "relative_path", "sha256", "bytes")


class InputError(Exception):
    """Unreadable or invalid input; the CLI exits 2."""


def _norm(name) -> str:
    return re.sub(r"[-_.]+", "-", str(name)).lower()


def _sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _inside(root: Path, relative) -> Path | None:
    """root/relative when it is a plain relative path that stays inside root, else None."""
    if not isinstance(relative, str) or not relative or "\\" in relative:
        return None
    posix = PurePosixPath(relative)
    if posix.is_absolute() or ".." in posix.parts or (posix.parts and ":" in posix.parts[0]):
        return None
    path = root / posix
    try:
        resolved, base = path.resolve(), root.resolve()
    except OSError:
        return None
    return path if resolved == base or base in resolved.parents else None


class _Check:
    def __init__(self, facts, policy, archive_root, source_dir, source_receipt=None):
        self.facts, self.policy = facts, policy
        self.archive = Path(archive_root)
        self.sources = Path(source_dir) if source_dir is not None else None
        self.receipt = source_receipt
        self.failures: list[str] = []
        self.allowed = set(policy.get("allowed_licences") or [])
        self.used_licences: set[str] = set()
        self.unpinned_uses: set[str] = set()  # licences used anywhere except a hash-pinned runtime file
        self._notice_hashes = None

    def fail(self, message: str) -> None:
        self.failures.append(message)

    # -- archive files --------------------------------------------------------
    def archive_file(self, relative, what) -> Path | None:
        path = _inside(self.archive, relative)
        if path is None:
            self.fail(f"{what}: path {relative!r} is not a plain path inside the archive")
            return None
        if not path.is_file() or path.is_symlink():
            self.fail(f"{what}: {relative} is missing from the archive")
            return None
        try:
            if path.stat().st_size == 0:
                self.fail(f"{what}: {relative} is empty")
                return None
        except OSError as exc:
            self.fail(f"{what}: {relative} is unreadable ({type(exc).__name__})")
            return None
        return path

    def archive_text(self, relative, what) -> tuple[bytes, str] | None:
        path = self.archive_file(relative, what)
        if path is None:
            return None
        try:
            data = path.read_bytes()
            return data, data.decode("utf-8")
        except OSError as exc:
            self.fail(f"{what}: {relative} is unreadable ({type(exc).__name__})")
        except UnicodeDecodeError:
            self.fail(f"{what}: {relative} is not UTF-8 text")
        return None

    def notice_hashes(self) -> set[str]:
        if self._notice_hashes is None:
            self._notice_hashes = set()
            root = self.archive / "NOTICES"
            if root.is_dir():
                for path in sorted(root.rglob("*")):
                    if path.is_file() and not path.is_symlink():
                        try:
                            self._notice_hashes.add(_sha_file(path))
                        except OSError:
                            self.fail(f"NOTICES file {path.relative_to(self.archive).as_posix()} is unreadable")
        return self._notice_hashes

    def licence(self, licence, what, pinned=False) -> None:
        if not isinstance(licence, str) or licence not in self.allowed:
            self.fail(f"{what}: licence {licence!r} is not an allowed licence")
            return
        self.used_licences.add(licence)
        if not pinned:
            self.unpinned_uses.add(licence)

    # -- rules ----------------------------------------------------------------
    def identity(self) -> None:
        if self.facts.get("schema_version") != SCHEMA_VERSION:
            self.fail(f"facts schema_version {self.facts.get('schema_version')!r} is not {SCHEMA_VERSION}")
        if self.policy.get("schema_version") != SCHEMA_VERSION:
            self.fail(f"policy schema_version {self.policy.get('schema_version')!r} is not {SCHEMA_VERSION}")
        if "admitted" in self.policy and self.policy["admitted"] is not True:
            self.fail("policy is not admitted")
        if "platform" in self.policy and self.facts.get("platform") != self.policy["platform"]:
            self.fail(f"facts platform {self.facts.get('platform')!r} is not the policy platform "
                      f"{self.policy['platform']!r}")

    def distributions(self) -> None:
        listed = {_norm(name): (name, rule) for name, rule in (self.policy.get("distributions") or {}).items()}
        for name in self.facts.get("duplicate_distributions") or []:
            self.fail(f"distribution {name}: installed more than once in the build environment")
        for dist in self.facts.get("distributions") or []:
            name = dist.get("name")
            entry = listed.get(_norm(name))
            if entry is None:
                self.fail(f"distribution {name}: not in the policy")
                continue
            rule = entry[1]
            if dist.get("version") != rule.get("version"):
                self.fail(f"distribution {name}: version {dist.get('version')!r} is not the policy's "
                          f"{rule.get('version')!r}")
            self.licence(rule.get("licence"), f"distribution {name}")
            for missing in dist.get("declared_license_files_missing") or []:
                self.fail(f"distribution {name}: declared licence file {missing} was not found")
            for record in dist.get("license_files") or []:
                path = record.get("path")
                digest, text = record.get("sha256"), record.get("text")
                if not isinstance(digest, str) or not SHA256.match(digest):
                    self.fail(f"distribution {name}: licence file {path} has no SHA256 in the facts")
                    continue
                if text is None and not record.get("undecodable"):
                    self.fail(f"distribution {name}: licence file {path} has no text in the facts")
                    continue
                if text is not None and _sha_bytes(text.encode("utf-8")) != digest:
                    self.fail(f"distribution {name}: licence file {path} text does not match its SHA256")
                    continue
                if digest not in self.notice_hashes():
                    self.fail(f"distribution {name}: licence file {path} is not preserved byte-identical "
                              "under NOTICES/")

    def runtime_files(self) -> None:
        rules = self.policy.get("runtime_files") or []
        observed = {e.get("path"): e for e in self.facts.get("bundle_files") or [] if isinstance(e, dict)}
        for path in self.facts.get("unmapped_files") or []:
            matches = [r for r in rules if isinstance(r.get("pattern"), str)
                       and fnmatch.fnmatchcase(path, r["pattern"])]
            if not matches:
                self.fail(f"unmapped file {path}: no reviewed runtime rule")
                continue
            for rule in matches:
                if not rule.get("owner"):
                    self.fail(f"unmapped file {path}: runtime rule {rule['pattern']!r} names no owner")
                exact = isinstance(rule.get("sha256"), str) and SHA256.match(rule["sha256"]) is not None
                self.licence(rule.get("licence"), f"unmapped file {path}", pinned=exact)
                self.pinned(path, rule, observed.get(path))
                if "os_package" in rule:
                    self.os_package(path, rule["os_package"])

    def pinned(self, path, rule, entry) -> None:
        """A rule that pins "sha256" and/or "size" covers only that exact file."""
        if "sha256" not in rule and "size" not in rule:
            return
        digest, size = rule.get("sha256"), rule.get("size")
        if "sha256" in rule and (not isinstance(digest, str) or not SHA256.match(digest)):
            self.fail(f"unmapped file {path}: runtime rule pins an invalid SHA256")
            return
        if entry is None:
            self.fail(f"unmapped file {path}: not in the facts' bundle files, so its pin cannot be checked")
            return
        if "sha256" in rule and entry.get("sha256") != digest:
            self.fail(f"unmapped file {path}: SHA256 {entry.get('sha256')} is not the reviewed {digest}")
        if "size" in rule and entry.get("size") != size:
            self.fail(f"unmapped file {path}: {entry.get('size')} bytes, not the reviewed {size}")

    def os_package(self, path, pin) -> None:
        """The file must come from exactly this dpkg package and version, whose source is offered."""
        origin = (self.facts.get("file_origins") or {}).get(path) or {}
        if not isinstance(pin, dict) or not all(isinstance(pin.get(k), str) and pin[k]
                                                for k in ("package", "version", "source")):
            self.fail(f"unmapped file {path}: malformed os_package pin")
            return
        if origin.get("class") != "os-package":
            self.fail(f"unmapped file {path}: the facts do not record it as an OS package file")
        elif (origin.get("package"), origin.get("version")) != (pin["package"], pin["version"]):
            self.fail(f"unmapped file {path}: from {origin.get('package')} {origin.get('version')}, not the reviewed "
                      f"{pin['package']} {pin['version']}")
        names = {a.get("name") for a in self.policy.get("source_archives") or [] if isinstance(a, dict)}
        if pin["source"] not in names:
            self.fail(f"unmapped file {path}: its source {pin['source']} is not among the offered source archives")

    def runtime_modules(self) -> None:
        rules = {}
        for rule in self.policy.get("runtime_modules") or []:
            module = rule.get("module")
            if not isinstance(module, str) or module in rules:
                self.fail(f"runtime module rule {module!r}: missing or duplicate module name")
                continue
            rules[module] = rule
        observed = self.facts.get("module_sources")
        for module in self.facts.get("unmapped_modules") or []:
            rule = rules.get(module)
            if rule is None:
                self.fail(f"unmapped module {module}: no reviewed runtime rule")
                continue
            if not rule.get("owner"):
                self.fail(f"unmapped module {module}: runtime rule names no owner")
            self.licence(rule.get("licence"), f"unmapped module {module}")
            if "typecode" in rule or "toc_sources_exactly" in rule:
                self.module_sources(module, rule, observed)

    def module_sources(self, module, rule, observed) -> None:
        typecode, expected = rule.get("typecode"), rule.get("toc_sources_exactly")
        if not isinstance(typecode, str) or not isinstance(expected, list) or not expected:
            self.fail(f"unmapped module {module}: rule needs both typecode and a non-empty toc_sources_exactly")
            return
        entries = observed.get(module) if isinstance(observed, dict) else None
        if not isinstance(entries, list) or not entries:
            self.fail(f"unmapped module {module}: the facts record no TOC sources for it")
            return
        for entry in entries:
            if entry.get("typecode") != typecode:
                self.fail(f"unmapped module {module}: typecode {entry.get('typecode')!r} is not exactly "
                          f"{typecode!r}")

        def key(source):
            return json.dumps({k: (source or {}).get(k) for k in SOURCE_KEYS}, sort_keys=True)

        if sorted(key(e.get("source")) for e in entries) != sorted(key(s) for s in expected):
            self.fail(f"unmapped module {module}: TOC sources are not exactly the reviewed sources")

    def qt_libraries(self) -> None:
        listed = self.policy.get("qt_libraries") or {}
        for path in self.facts.get("qt_libraries") or []:
            name = PurePosixPath(path).name
            if name not in listed:
                self.fail(f"Qt library {path}: not reviewed in the policy")
                continue
            self.licence(listed[name], f"Qt library {path}")

    def licence_texts(self) -> None:
        texts = self.policy.get("licence_texts") or {}
        files = self.policy.get("licence_text_files") or {}
        for licence in sorted(self.used_licences):
            needed = files.get(licence)
            if needed == [] and licence not in self.unpinned_uses:
                continue  # explicitly no notice, and only for hash-pinned runtime files
            if needed is None:
                needed = [texts[licence]] if licence in texts else None
            if not isinstance(needed, list) or not needed:
                self.fail(f"licence {licence!r}: no licence text is named in the policy")
                continue
            for relative in needed:
                self.archive_file(relative, f"licence {licence!r} text")

    def notices(self) -> None:
        for relative in self.policy.get("required_notices") or []:
            self.archive_file(relative, "required notice")
        prominent = self.policy.get("prominent_notice")
        if not isinstance(prominent, dict) or not prominent.get("must_contain"):
            self.fail("policy has no prominent notice rule")
        else:
            found = self.archive_text(prominent.get("file"), "prominent notice")
            if found is not None and prominent["must_contain"] not in found[1]:
                self.fail(f"prominent notice: {prominent.get('file')} lacks {prominent['must_contain']!r}")

    def statements(self) -> None:
        statements = self.policy.get("required_statements") or []
        if not isinstance(statements, list):
            self.fail("required_statements is not a list")
            return
        for index, rule in enumerate(statements):
            what = f"required statement {index} ({rule.get('file') if isinstance(rule, dict) else rule!r})"
            if not isinstance(rule, dict):
                self.fail(f"{what}: not an object")
                continue
            must, must_not, digest = rule.get("must_contain"), rule.get("must_not_contain", []), rule.get("sha256")
            if not isinstance(must, str) or not must:
                self.fail(f"{what}: must_contain is missing or empty")
                continue
            if not isinstance(must_not, list) or not all(isinstance(m, str) and m for m in must_not):
                self.fail(f"{what}: must_not_contain is not a list of non-empty strings")
                continue
            if digest is not None and (not isinstance(digest, str) or not SHA256.match(digest)):
                self.fail(f"{what}: sha256 is not a SHA256 hex digest")
                continue
            found = self.archive_text(rule.get("file"), what)
            if found is None:
                continue
            data, text = found
            if digest is not None and _sha_bytes(data) != digest:
                self.fail(f"{what}: SHA256 {_sha_bytes(data)} is not the reviewed {digest}")
            if must not in text:
                self.fail(f"{what}: does not contain {must!r}")
            for forbidden in must_not:
                if forbidden in text:
                    self.fail(f"{what}: contains the forbidden text {forbidden!r}")

    def elections(self) -> None:
        platform = self.policy.get("platform") or self.facts.get("platform")
        for index, rule in enumerate(self.policy.get("elections") or []):
            what = f"election {index} ({rule.get('file') if isinstance(rule, dict) else rule!r})"
            if not isinstance(rule, dict):
                self.fail(f"{what}: not an object")
                continue
            expression, elected = rule.get("expression"), rule.get("elected")
            alternatives = [a.strip().strip("()").strip() for a in str(expression or "").split(" OR ")]
            if not isinstance(expression, str) or " OR " not in expression or elected not in alternatives:
                self.fail(f"{what}: {elected!r} is not one alternative of {expression!r}")
            platforms = rule.get("platforms")
            if not isinstance(platforms, list) or platform not in platforms:
                self.fail(f"{what}: recorded for {platforms!r}, not for this platform {platform!r}")
            if not rule.get("file"):
                self.fail(f"{what}: names no file")
            self.archive_file(rule.get("text"), f"{what} text")

    def source_archives(self) -> None:
        archives = self.policy.get("source_archives") or []
        if not archives:
            self.fail("policy lists no source archives")
        if self.receipt is not None:
            self.source_receipt(archives)
            return
        if self.sources is None:
            self.fail("neither a source directory nor a source receipt was given")
            return
        for entry in archives:
            name, digest = entry.get("file"), entry.get("sha256")
            path = _inside(self.sources, name)
            if path is None:
                self.fail(f"source archive {name!r}: not a plain path inside the source directory")
                continue
            if not isinstance(digest, str) or not SHA256.match(digest):
                self.fail(f"source archive {name}: the policy has no SHA256 for it")
                continue
            if not path.is_file():
                self.fail(f"source archive {name}: missing")
                continue
            try:
                actual = _sha_file(path)
            except OSError as exc:
                self.fail(f"source archive {name}: unreadable ({type(exc).__name__})")
                continue
            if actual != digest:
                self.fail(f"source archive {name}: SHA256 {actual} is not {digest}")

    def source_receipt(self, archives) -> None:
        entries = self.receipt.get("archives") if isinstance(self.receipt, dict) else None
        if not isinstance(entries, list):
            self.fail("the source receipt lists no archives")
            return
        verified = {}
        for entry in entries:
            if isinstance(entry, dict):
                verified.setdefault(entry.get("file"), []).append(entry.get("sha256"))
        for entry in archives:
            name, digest = entry.get("file"), entry.get("sha256")
            if not isinstance(digest, str) or not SHA256.match(digest):
                self.fail(f"source archive {name}: the policy has no SHA256 for it")
            elif verified.get(name) != [digest]:
                self.fail(f"source archive {name}: not verified with SHA256 {digest} by this run's source job")

    def relinking(self) -> None:
        relinking = self.policy.get("relinking")
        if not isinstance(relinking, dict) or relinking.get("admitted") is not True:
            self.fail("relinking/replacement instructions are not admitted")
            return
        self.archive_file(relinking.get("instructions"), "relinking instructions")
        self.archive_file(relinking.get("determination"), "installation-information determination")

    def run(self) -> list[str]:
        self.identity()
        self.distributions()
        self.runtime_files()
        self.runtime_modules()
        self.qt_libraries()
        self.licence_texts()
        self.notices()
        self.statements()
        self.elections()
        self.source_archives()
        self.relinking()
        return self.failures


def check(facts, policy, archive_root, source_dir, source_receipt=None) -> list[str]:
    """Failure strings for one platform's facts and policy; an empty list is a pass."""
    if not isinstance(facts, dict) or not isinstance(policy, dict):
        return ["facts and policy must be JSON objects"]
    return _Check(facts, policy, archive_root, source_dir, source_receipt).run()


def _load_json(path: Path, what: str):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise InputError(f"{what} is unreadable ({type(exc).__name__})") from None


def select_policy(policy_path: Path, platform) -> tuple[dict | None, list[str]]:
    """The platform policy for ``platform``, plus failures from the index (not admitted, not listed)."""
    policy = _load_json(policy_path, "--policy")
    if not isinstance(policy, dict):
        raise InputError("--policy is not a JSON object")
    if "platforms" not in policy:
        return policy, []
    failures = []
    if policy.get("schema_version") != SCHEMA_VERSION:
        failures.append(f"policy index schema_version {policy.get('schema_version')!r} is not {SCHEMA_VERSION}")
    if "admitted" in policy and policy["admitted"] is not True:
        failures.append("policy index is not admitted")
    platforms = policy.get("platforms")
    relative = platforms.get(platform) if isinstance(platforms, dict) and isinstance(platform, str) else None
    if relative is None:
        return None, failures + [f"policy index names no policy for platform {platform!r}"]
    base = Path(policy_path).resolve().parent.parent  # paths are relative to the directory holding notices/
    path = _inside(base, relative)
    if path is None:
        raise InputError(f"policy index entry for {platform} is not a plain path inside {base.name}/")
    selected = _load_json(path, f"platform policy {relative}")
    if not isinstance(selected, dict):
        raise InputError(f"platform policy {relative} is not a JSON object")
    return selected, failures


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Licence, notice and source gate for one desktop dev archive.")
    parser.add_argument("--facts", required=True, type=Path)
    parser.add_argument("--policy", required=True, type=Path)
    parser.add_argument("--archive-root", required=True, type=Path)
    sources = parser.add_mutually_exclusive_group(required=True)
    sources.add_argument("--source-dir", type=Path)
    sources.add_argument("--source-receipt", type=Path, help="the source-materials job's verification receipt")
    args = parser.parse_args(argv)
    try:
        facts = _load_json(args.facts, "--facts")
        if not isinstance(facts, dict):
            raise InputError("--facts is not a JSON object")
        policy, failures = select_policy(args.policy, facts.get("platform"))
        receipt = _load_json(args.source_receipt, "--source-receipt") if args.source_receipt else None
        if not args.archive_root.is_dir() or (args.source_dir is not None and not args.source_dir.is_dir()):
            raise InputError("--archive-root and --source-dir must be directories")
    except InputError as exc:
        print(f"licence_gate: invalid input: {exc}", file=sys.stderr)
        return 2
    if policy is not None:  # any loaded policy is checked; an empty one fails every rule it lacks
        failures += check(facts, policy, args.archive_root, args.source_dir, receipt)
    for failure in failures:
        print(f"FAIL {failure}")
    print(f"licence_gate: {len(failures)} failure(s) for platform {facts.get('platform')!r}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
