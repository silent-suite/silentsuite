"""Equivalence and work-bound contracts for the Android tracker scanner.

The reference is a byte copy of the scanner at 50deead9 (hash-pinned below). For every
corpus the candidate must yield exactly the reference's ordered payload stream (location,
length, SHA-256, including repeated yields and the items before a deterministic error),
produce the same findings and the same CLI output, and keep the archive member-count and
member-size limits. The work tests then require the candidate to search each distinct
payload once while it is remembered, within its bounded result memory.
"""

import dataclasses
import datetime as dt
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_PATH = ROOT / "android/scripts/scan-tracker-signatures.py"
REFERENCE_PATH = ROOT / "tests/fixtures/scan-tracker-signatures-base-50deead9.py"
REFERENCE_SHA256 = "755ac801eea78353692918fe31d6214faf030d360510eb3b9c1f39465610bd84"
MANIFEST = ROOT / "android/security/tracker-signatures.json"
FIXTURES = ROOT / "android/security/fixtures/tracker-scan"
FIXED_TIME = (2026, 1, 1, 0, 0, 0)
DEFAULT_MEMORY_CAPACITY = 65_536

DEX = b"dex\n035\x00 prefix com/mixpanel/android/mpmetrics suffix"
NATIVE = b"\x7fELF native payload sentry_native_init end"
RESOURCES = b"clean compiled resources"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def reference():
    assert hashlib.sha256(REFERENCE_PATH.read_bytes()).hexdigest() == REFERENCE_SHA256
    return _load("tracker_scan_reference_50deead9", REFERENCE_PATH)


@pytest.fixture(scope="module")
def candidate():
    return _load("tracker_scan_candidate", CANDIDATE_PATH)


def _zip(entries, compression=zipfile.ZIP_DEFLATED) -> bytes:
    """Deterministic ZIP; entries are (name, data) or (name, data, compress_type)."""
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # duplicate member names are written on purpose
        with zipfile.ZipFile(buffer, "w") as archive:
            for name, data, *rest in entries:
                info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
                info.compress_type = rest[0] if rest else compression
                archive.writestr(info, data)
    return buffer.getvalue()


def _mark_encrypted(data: bytes) -> bytes:
    raw = bytearray(data)
    local, central = raw.find(b"PK\x03\x04"), raw.find(b"PK\x01\x02")
    assert local == 0 and central > 0
    raw[local + 6] |= 0x01  # general-purpose flag bit 0 in the local header
    raw[central + 8] |= 0x01  # and in the central-directory record
    return bytes(raw)


def _corrupt_local_header(data: bytes) -> bytes:
    assert data[:4] == b"PK\x03\x04"
    return b"PK\x00\x00" + data[4:]  # end-of-central-directory stays valid


def _nest(levels: int) -> bytes:
    """A top-level ZIP whose raw, non-ZIP leaf.jar is reached at depth levels + 1."""
    payload = _zip([("leaf.jar", b"raw bytes, not a zip")])
    for level in range(levels, 0, -1):
        payload = _zip([(f"L{level}.jar", payload)])
    return payload


def _write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@dataclasses.dataclass(frozen=True)
class Case:
    targets: tuple
    manifest: Path = MANIFEST


@pytest.fixture(scope="module")
def corpus(tmp_path_factory) -> dict:
    root = tmp_path_factory.mktemp("tracker-corpus")
    apk = _zip([("classes.dex", DEX), ("lib/arm64-v8a/libapp.so", NATIVE, zipfile.ZIP_STORED),
                ("resources.arsc", RESOURCES)])
    aab = _zip([("base/dex/classes.dex", DEX), ("base/lib/arm64-v8a/libapp.so", NATIVE, zipfile.ZIP_STORED),
                ("base/resources.pb", RESOURCES)])
    universal = apk  # bundletool's universal APK carries the same members
    release = root / "release"
    _write(release / "aa-classes.dex", DEX)  # first payload, repeated later: witnesses reuse
    _write(release / "app-release.apk", apk)
    _write(release / "app-release.aab", aab)
    _write(release / "unsigned-release.apks", _zip([("universal.apk", universal, zipfile.ZIP_STORED),
                                                    ("toc.pb", b"table of contents")]))
    _write(release / "splits/universal.apk", universal)
    _write(release / "splits/toc.pb", b"table of contents")

    report = b"com.google.firebase:firebase-analytics:22.0.0"
    exceptions = root / "exceptions"
    _write(exceptions / "a/dependency-report.txt", report)
    _write(exceptions / "b/dependency-report.txt", report)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    today = dt.date.today()
    manifest["exceptions"] = [{
        "signature_id": "firebase-analytics-dependency",
        "path_regex": r"a[/\\]dependency-report\.txt$",
        "rationale": "Equivalence fixture: one of two identical payloads is excepted",
        "owner": "security",
        "reviewed_on": (today - dt.timedelta(days=30)).isoformat(),
        "expires_on": (today + dt.timedelta(days=30)).isoformat(),
    }]
    exception_manifest = _write(root / "exception-manifest.json", json.dumps(manifest).encode())

    cases = {
        "release": Case((release,)),
        "location-exception": Case((exceptions,), exception_manifest),
        "duplicate-member-names": Case((_write(root / "dupnames/archive.zip", _zip(
            [("dup.dex", b"clean payload"), ("dup.dex", b"uses AdvertisingIdClient here")])),)),
        "zip-without-suffix": Case((_write(root / "nosuffix/blob.bin", _zip(
            [("inner.txt", b"clean"), ("data.bin", _zip([("x.txt", b"Bugsnag notifier")]))])),)),
        "raw-nested-jar": Case((_write(root / "rawjar/lib.aar", _zip([("classes.jar", b"not a zip at all")])),)),
        "aar-nested-jar": Case((_write(root / "aar/lib.aar", _zip(
            [("classes.jar", _zip([("com/example/A.class", b"class bytes")]))])),)),
        "depth-boundary-pass": Case((_write(root / "depth-ok/ok.zip", _nest(3)),)),
        "depth-boundary-over": Case((_write(root / "depth-over/over.zip", _nest(4)),)),
        "malformed-top-level-apk": Case((_write(root / "malformed/broken.apk", b"definitely not a zip"),)),
        "encrypted-nested-zip": Case((_write(root / "encrypted/outer.zip", _zip(
            [("inner.zip", _mark_encrypted(_zip([("secret.dex", b"clean")])), zipfile.ZIP_STORED)])),)),
        "encrypted-top-level-zip": Case((_write(root / "encrypted-top/top.zip",
                                                _mark_encrypted(_zip([("secret.dex", b"clean")]))),)),
        "corrupt-nested-zip": Case((_write(root / "corrupt/outer.zip", _zip(
            [("inner.zip", _corrupt_local_header(_zip([("a.txt", b"hello")])), zipfile.ZIP_STORED)])),)),
        "empty-file": Case((_write(root / "empty/empty.txt", b""),)),
        "fixture-clean": Case((FIXTURES / "clean",)),
        **{f"fixture-positive-{path.name}": Case((path,))
           for path in sorted((FIXTURES / "positive").iterdir()) if path.is_dir()},
        "missing-after-valid": Case((FIXTURES / "clean", root / "does-not-exist")),
    }
    return cases


STREAM_CASES = (
    "release", "location-exception", "duplicate-member-names", "zip-without-suffix", "raw-nested-jar",
    "aar-nested-jar", "depth-boundary-pass", "depth-boundary-over", "malformed-top-level-apk",
    "encrypted-nested-zip", "encrypted-top-level-zip", "corrupt-nested-zip", "empty-file", "fixture-clean",
)
CLI_CASES = STREAM_CASES + ("missing-after-valid",) + tuple(
    f"fixture-positive-{path.name}" for path in sorted((FIXTURES / "positive").iterdir()) if path.is_dir()
)


def _stream(module, target: Path):
    """Ordered (location, length, sha256) payload stream, plus the error it ends with."""
    items = []
    try:
        for location, payload in module.iter_payloads(target):
            items.append((location, len(payload), hashlib.sha256(payload).hexdigest()))
    except Exception as exc:  # compared by name and message across the two modules
        return items, (type(exc).__name__, str(exc))
    return items, None


def _scan(module, manifest_path: Path, targets):
    manifest, signatures = module.load_manifest(manifest_path)
    try:
        return [dataclasses.astuple(finding) for finding in module.scan(manifest, signatures, list(targets))], None
    except Exception as exc:
        return None, (type(exc).__name__, str(exc))


def _cli(script: Path, case: Case, summary: Path):
    result = subprocess.run(
        [sys.executable, str(script), "--manifest", str(case.manifest), "--summary", str(summary),
         *map(str, case.targets)],
        cwd=ROOT, text=True, capture_output=True, check=False,
    )
    return result.returncode, result.stdout, result.stderr, summary.read_bytes() if summary.exists() else None


def _main(module, manifest: Path, targets, summary: Path, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["scan-tracker-signatures.py", "--manifest", str(manifest),
                                      "--summary", str(summary), *map(str, targets)])
    code = module.main()
    out, err = capsys.readouterr()
    return code, out, err, summary.read_bytes() if summary.exists() else None


def test_finding_fields_are_identical(reference, candidate):
    assert [field.name for field in dataclasses.fields(candidate.Finding)] == [
        field.name for field in dataclasses.fields(reference.Finding)
    ]


@pytest.mark.parametrize("name", STREAM_CASES)
def test_payload_stream_matches_reference(reference, candidate, corpus, name):
    (target,) = corpus[name].targets
    assert _stream(candidate, target) == _stream(reference, target)


@pytest.mark.parametrize("name", CLI_CASES)
def test_cli_output_matches_reference(corpus, tmp_path, name):
    case = corpus[name]
    expected = _cli(REFERENCE_PATH, case, tmp_path / "reference-summary.json")
    assert _cli(CANDIDATE_PATH, case, tmp_path / "candidate-summary.json") == expected


def test_controls_exercise_the_intended_reference_behaviour(reference, corpus, tmp_path):
    """Guards the corpus itself, so the equivalence tests cannot pass vacuously."""
    outcomes = {name: _cli(REFERENCE_PATH, corpus[name], tmp_path / f"{name}.json") for name in CLI_CASES}
    code, out, _, _ = outcomes["location-exception"]
    assert code == 2 and out.count("EXCEPTED ") == 1 and out.count("PROHIBITED ") == 1
    code, out, _, _ = outcomes["duplicate-member-names"]
    assert code == 2 and out.count("[identifier_api]") == 1 and "archive.zip!dup.dex" in out
    assert outcomes["zip-without-suffix"][0] == 2 and "blob.bin!data.bin!x.txt" in outcomes["zip-without-suffix"][1]
    for name in ("raw-nested-jar", "aar-nested-jar", "depth-boundary-pass", "empty-file", "fixture-clean"):
        assert outcomes[name][0] == 0, name
    for name, message in (
        ("depth-boundary-over", "archive nesting limit exceeded"),
        ("malformed-top-level-apk", "cannot inspect archive"),
        ("encrypted-nested-zip", "cannot inspect archive"),
        ("encrypted-top-level-zip", "cannot inspect archive"),
        ("corrupt-nested-zip", "cannot inspect archive"),
        ("missing-after-valid", "scan target does not exist"),
    ):
        code, _, err, summary = outcomes[name]
        assert code == 3 and message in err and summary is None, name
    raw_items, _ = _stream(reference, corpus["raw-nested-jar"].targets[0])
    assert [location for location, _, _ in raw_items].count(f"{corpus['raw-nested-jar'].targets[0]}!classes.jar") == 2


# ── archive limits, patched in both modules and exercised in-process ──────


LIMIT_FAILURE_LOCATIONS = {
    "over": "over.zip",
    "nested-in-aab": "app.aab!base/inner.zip",
    "nested-in-apks": "app.apks!universal.apk",
    "repeated": "c-outer.zip!inner.zip",
}


def _limit_corpus(root: Path, kind: str) -> tuple:
    """Boundary archives; the outer archives stay within the limit so failures are nested."""
    if kind == "MAX_ARCHIVE_MEMBERS":
        limit, exact, over = 3, _zip([(f"m{i}.txt", b"clean") for i in range(3)]), _zip(
            [(f"m{i}.txt", b"clean") for i in range(4)])
    else:
        limit, exact, over = 256, _zip([("m.txt", b"x" * 256)]), _zip([("m.txt", b"x" * 257)])
        assert len(over) < limit
    files = {
        "exact": _write(root / "exact/exact.zip", exact),
        "over": _write(root / "over/over.zip", over),
        "nested-in-aab": _write(root / "aab/app.aab", _zip([("base/inner.zip", over, zipfile.ZIP_STORED)])),
        "nested-in-apks": _write(root / "apks/app.apks", _zip([("universal.apk", over, zipfile.ZIP_STORED)])),
    }
    repeated = root / "repeated"  # identical boundary archives, then a nested over-limit one
    _write(repeated / "a-exact.zip", exact)
    _write(repeated / "b-exact.zip", exact)
    _write(repeated / "c-outer.zip", _zip([("inner.zip", over, zipfile.ZIP_STORED)]))
    files["repeated"] = repeated
    return limit, files


@pytest.mark.parametrize("constant", ["MAX_ARCHIVE_MEMBERS", "MAX_MEMBER_BYTES"])
@pytest.mark.parametrize("name", ["exact", "over", "nested-in-aab", "nested-in-apks", "repeated"])
def test_archive_limits_match_reference(reference, candidate, tmp_path, monkeypatch, capsys, constant, name):
    limit, files = _limit_corpus(tmp_path / "corpus", constant)
    monkeypatch.setattr(reference, constant, limit)
    monkeypatch.setattr(candidate, constant, limit)
    target = files[name]

    expected_stream = _stream(reference, target)
    if name == "exact":
        assert expected_stream[1] is None
    else:
        assert expected_stream[1] is not None and "limit exceeded" in expected_stream[1][1]
        assert LIMIT_FAILURE_LOCATIONS[name] in expected_stream[1][1]
    assert _stream(candidate, target) == expected_stream
    assert _scan(candidate, MANIFEST, [target]) == _scan(reference, MANIFEST, [target])
    expected_main = _main(reference, MANIFEST, [target], tmp_path / "reference.json", monkeypatch, capsys)
    assert _main(candidate, MANIFEST, [target], tmp_path / "candidate.json", monkeypatch, capsys) == expected_main


# ── bounded work: each remembered distinct payload is searched once ───────


class _CountingPattern:
    def __init__(self, pattern, calls: list):
        self._pattern, self._calls = pattern, calls

    def search(self, payload):
        self._calls.append((len(payload), hashlib.sha256(payload).digest()))
        return self._pattern.search(payload)

    def __getattr__(self, name):
        return getattr(self._pattern, name)


def _counted_signatures(module):
    manifest, signatures = module.load_manifest(MANIFEST)
    calls = [[] for _ in signatures]
    wrapped = [(entry, _CountingPattern(pattern, calls[index])) for index, (entry, pattern) in enumerate(signatures)]
    return manifest, wrapped, calls


def _reference_keys(reference, target: Path) -> list:
    keys = []
    for _, payload in reference.iter_payloads(target):
        keys.append((len(payload), hashlib.sha256(payload).digest()))
    return keys


def _simulated_searches(keys: list, capacity) -> list:
    remembered, searched = set(), []
    for key in keys:
        if key in remembered:
            continue
        searched.append(key)
        if capacity is None or len(remembered) < capacity:
            remembered.add(key)
    return searched


def test_default_memory_searches_each_distinct_payload_once(reference, candidate, corpus):
    (target,) = corpus["release"].targets
    keys = _reference_keys(reference, target)
    expected = _simulated_searches(keys, None)
    assert len(expected) < len(keys), "the release corpus must repeat payloads"
    assert len(expected) <= DEFAULT_MEMORY_CAPACITY, "the release corpus must fit the default memory"
    manifest, signatures, calls = _counted_signatures(candidate)
    findings = candidate.scan(manifest, signatures, [target])
    for index, searched in enumerate(calls):
        assert searched == expected, (
            f"signature {index} searched {len(searched)} payloads for {len(expected)} distinct payloads"
        )
    assert [dataclasses.astuple(finding) for finding in findings] == _scan(reference, MANIFEST, [target])[0]


@pytest.mark.parametrize("capacity", [0, 1, 2])
def test_bounded_memory_searches_exactly_the_simulated_payloads(reference, candidate, corpus, monkeypatch, capacity):
    (target,) = corpus["release"].targets
    keys = _reference_keys(reference, target)
    expected = _simulated_searches(keys, capacity)
    if capacity:
        assert len(expected) < len(keys), "the release corpus must reuse a remembered payload"
    monkeypatch.setattr(candidate, "MAX_REMEMBERED_RESULTS", capacity, raising=False)
    manifest, signatures, calls = _counted_signatures(candidate)
    findings = candidate.scan(manifest, signatures, [target])
    for index, searched in enumerate(calls):
        assert searched == expected, (
            f"capacity {capacity}: signature {index} searched {len(searched)} payloads, expected {len(expected)}"
        )
    assert [dataclasses.astuple(finding) for finding in findings] == _scan(reference, MANIFEST, [target])[0]
