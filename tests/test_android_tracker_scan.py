import contextlib
import dataclasses
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "android/scripts/scan-tracker-signatures.py"
MANIFEST = ROOT / "android/security/tracker-signatures.json"
FIXTURES = ROOT / "android/security/fixtures/tracker-scan"


class AndroidTrackerScannerTest(unittest.TestCase):
    def run_scan(self, *targets: Path, manifest: Path = MANIFEST):
        return subprocess.run(
            [sys.executable, str(SCANNER), "--manifest", str(manifest), *map(str, targets)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_clean_fixture_passes(self):
        result = self.run_scan(FIXTURES / "clean")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("tracker scan passed", result.stdout.lower())

    def test_each_signature_category_has_a_positive_failing_fixture(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        expected = {entry["category"] for entry in manifest["signatures"]}
        fixtures = {path.name for path in (FIXTURES / "positive").iterdir() if path.is_dir()}
        self.assertEqual(fixtures, expected)
        for category in sorted(expected):
            # Every payload must fail on its own, so dropping one alternative from a
            # signature pattern fails here even when the category has other payloads.
            payloads = sorted(path for path in (FIXTURES / "positive" / category).iterdir() if path.is_file())
            self.assertTrue(payloads, category)
            for payload in payloads:
                with self.subTest(category=category, payload=payload.name):
                    result = self.run_scan(payload)
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn(f"[{category}]", result.stdout)

    def test_scans_nested_apk_aab_split_dex_and_native_payloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "universal.apks"
            nested_apk = Path(tmp) / "base.apk"
            with zipfile.ZipFile(nested_apk, "w") as apk:
                apk.writestr("classes.dex", b"prefix com/mixpanel/android/mpmetrics suffix")
                apk.writestr("lib/arm64-v8a/libfixture.so", b"symbol sentry_native_init end")
            with zipfile.ZipFile(archive, "w") as splits:
                splits.write(nested_apk, "splits/base-master.apk")
            result = self.run_scan(archive)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("[dex_signature]", result.stdout)
        self.assertIn("[native_symbol]", result.stdout)

    def test_empty_or_malformed_manifest_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            for body in ("{}", "not-json"):
                manifest = Path(tmp) / "manifest.json"
                manifest.write_text(body, encoding="utf-8")
                result = self.run_scan(FIXTURES / "clean", manifest=manifest)
                self.assertEqual(result.returncode, 3)
                self.assertIn("invalid signature manifest", result.stderr.lower())

    def test_network_evidence_is_uid_scoped_and_allowlisted(self):
        checker = ROOT / "android/scripts/check-network-evidence.py"
        allowlist = ROOT / "android/security/android-network-endpoints.txt"
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "evidence.jsonl"
            evidence.write_text(
                '{"scenario":"clean_launch","uid":10123,"host":null,"requests":0}\n'
                '{"scenario":"foreground_sync","uid":10123,"host":"<user-selected-server>","requests":2}\n',
                encoding="utf-8",
            )
            result = subprocess.run([sys.executable, str(checker), "--allowlist", str(allowlist),
                                     "--evidence", str(evidence)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            evidence.write_text(
                '{"scenario":"clean_launch","uid":10123,"host":"api.mixpanel.com","requests":1}\n',
                encoding="utf-8",
            )
            result = subprocess.run([sys.executable, str(checker), "--allowlist", str(allowlist),
                                     "--evidence", str(evidence)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("not allowlisted", result.stderr)

    def test_report_endpoint_is_allowed_only_once_in_report_send(self):
        checker = ROOT / "android/scripts/check-network-evidence.py"
        allowlist = ROOT / "android/security/android-network-endpoints.txt"
        report = '{"scenario":"%s","uid":10123,"host":"silentsuite.io","requests":%d}\n'
        quiet = '{"scenario":"%s","uid":10123,"host":null,"requests":0}\n'
        scenarios = ["clean_launch", "idle_5m", "account_setup", "login", "foreground_sync", "background_sync",
                     "network_failure", "logout", "report_open", "report_toggle_diagnostics", "report_cancel",
                     "report_background"]

        def run(body, *extra):
            with tempfile.TemporaryDirectory() as tmp:
                evidence = Path(tmp) / "evidence.jsonl"
                evidence.write_text(body, encoding="utf-8")
                return subprocess.run([sys.executable, str(checker), "--allowlist", str(allowlist),
                                       "--evidence", str(evidence), *extra], text=True, capture_output=True)

        complete = "".join(quiet % name for name in scenarios)
        result = run(complete + report % ("report_send", 1), "--require-complete")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for scenario in ("clean_launch", "login", "report_open", "report_toggle_diagnostics",
                         "report_cancel", "report_background", "background_sync"):
            with self.subTest(scenario=scenario):
                result = run(report % (scenario, 1))
                self.assertEqual(result.returncode, 2)
                self.assertIn("allowed only in report_send", result.stderr)
        # Exact host only: subdomains are not admitted by the scoped rule, in report_send or anywhere else.
        for host in ("server.silentsuite.io", "report.silentsuite.io", "app.silentsuite.io", "silentsuite.io.evil.example"):
            for scenario in ("report_send", "login"):
                with self.subTest(host=host, scenario=scenario):
                    result = run('{"scenario":"%s","uid":10123,"host":"%s","requests":1}\n' % (scenario, host))
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("not allowlisted", result.stderr)
        result = run(report % ("report_send", 2))
        self.assertEqual(result.returncode, 2)
        self.assertIn("exactly one request", result.stderr)
        result = run(complete + quiet % "report_send", "--require-complete")
        self.assertEqual(result.returncode, 2)
        self.assertIn("exactly one request", result.stderr)
        result = run(complete, "--require-complete")
        self.assertEqual(result.returncode, 2)
        self.assertIn("missing scenarios: report_send", result.stderr)

    def test_endpoint_policy_rejects_malformed_scoped_rules(self):
        checker = ROOT / "android/scripts/check-network-evidence.py"
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "evidence.jsonl"
            evidence.write_text('{"scenario":"clean_launch","uid":10123,"host":null,"requests":0}\n', encoding="utf-8")
            allowlist = Path(tmp) / "endpoints.txt"
            for rule in ("silentsuite.io scenario=unknown_scenario", "silentsuite.io report_send",
                         "a.example b.example", "silentsuite.io\nsilentsuite.io scenario=report_send"):
                with self.subTest(rule=rule):
                    allowlist.write_text(rule + "\n", encoding="utf-8")
                    result = subprocess.run([sys.executable, str(checker), "--allowlist", str(allowlist),
                                             "--evidence", str(evidence)], text=True, capture_output=True)
                    self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
                    self.assertIn("invalid network evidence", result.stderr)

    def test_scoped_unexpired_exception_is_reviewable_but_expired_one_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dependency-report.txt"
            target.write_text("com.google.firebase:firebase-analytics:22.0.0", encoding="utf-8")
            today = dt.date.today()
            base = json.loads(MANIFEST.read_text(encoding="utf-8"))
            base["exceptions"] = [{
                "signature_id": "firebase-analytics-dependency",
                "path_regex": "dependency-report\\.txt$",
                "rationale": "Fixture-only review record",
                "owner": "security",
                "reviewed_on": (today - dt.timedelta(days=30)).isoformat(),
                "expires_on": (today + dt.timedelta(days=30)).isoformat()
            }]
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(json.dumps(base), encoding="utf-8")
            result = self.run_scan(target, manifest=manifest)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("1 reviewed exception", result.stdout)
            base["exceptions"][0]["reviewed_on"] = (today - dt.timedelta(days=60)).isoformat()
            base["exceptions"][0]["expires_on"] = (today - dt.timedelta(days=1)).isoformat()
            manifest.write_text(json.dumps(base), encoding="utf-8")
            result = self.run_scan(target, manifest=manifest)
            self.assertEqual(result.returncode, 3)
            self.assertIn("expired", result.stderr.lower())

    def test_network_evidence_rejects_mixed_uids_and_invalid_provenance(self):
        checker = ROOT / "android/scripts/check-network-evidence.py"
        allowlist = ROOT / "android/security/android-network-endpoints.txt"
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "evidence.jsonl"
            provenance = Path(tmp) / "provenance.json"
            evidence.write_text(
                '{"scenario":"clean_launch","uid":10123,"host":null,"requests":0}\n'
                '{"scenario":"foreground_sync","uid":10124,"host":"<user-selected-server>","requests":2}\n',
                encoding="utf-8")
            common = [sys.executable, str(checker), "--allowlist", str(allowlist), "--evidence", str(evidence),
                      "--app-uid", "10123", "--raw-capture-sha256", "b" * 64,
                      "--provenance-output", str(provenance)]
            result = subprocess.run([*common, "--artifact-sha256", "not-a-digest"], text=True, capture_output=True)
            self.assertEqual(result.returncode, 3)
            self.assertIn("sha-256", result.stderr.lower())
            self.assertFalse(provenance.exists())
            result = subprocess.run([*common, "--artifact-sha256", "a" * 64], text=True, capture_output=True)
            self.assertEqual(result.returncode, 3)
            self.assertIn("one app uid", result.stderr.lower())

    def test_network_evidence_writes_digest_bound_provenance(self):
        checker = ROOT / "android/scripts/check-network-evidence.py"
        allowlist = ROOT / "android/security/android-network-endpoints.txt"
        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / "evidence.jsonl"
            provenance = Path(tmp) / "provenance.json"
            evidence.write_text('{"scenario":"clean_launch","uid":10123,"host":null,"requests":0}\n', encoding="utf-8")
            result = subprocess.run([
                sys.executable, str(checker), "--allowlist", str(allowlist), "--evidence", str(evidence),
                "--app-uid", "10123", "--artifact-sha256", "a" * 64,
                "--raw-capture-sha256", "b" * 64, "--provenance-output", str(provenance),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            record = json.loads(provenance.read_text(encoding="utf-8"))
            self.assertEqual(record["app_uid"], 10123)
            self.assertEqual(record["artifact_sha256"], "a" * 64)
            self.assertEqual(record["raw_capture_sha256"], "b" * 64)
            self.assertRegex(record["evidence_jsonl_sha256"], r"^[0-9a-f]{64}$")

    def test_exception_policy_rejects_wildcards_future_reviews_and_long_windows(self):
        base = json.loads(MANIFEST.read_text(encoding="utf-8"))
        today = dt.date.today()
        cases = [
            (".*", today.isoformat(), (today + dt.timedelta(days=1)).isoformat(), "broad"),
            (r"dependency-report\.txt$", (today + dt.timedelta(days=1)).isoformat(),
             (today + dt.timedelta(days=2)).isoformat(), "future"),
            (r"dependency-report\.txt$", today.isoformat(),
             (today + dt.timedelta(days=91)).isoformat(), "window"),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dependency-report.txt"
            target.write_text("clean", encoding="utf-8")
            manifest = Path(tmp) / "manifest.json"
            for path_regex, reviewed, expires, expected in cases:
                with self.subTest(expected=expected):
                    base["exceptions"] = [{"signature_id": "firebase-analytics-dependency",
                        "path_regex": path_regex, "rationale": "Narrow temporary false positive",
                        "owner": "security", "reviewed_on": reviewed, "expires_on": expires}]
                    manifest.write_text(json.dumps(base), encoding="utf-8")
                    result = self.run_scan(target, manifest=manifest)
                    self.assertEqual(result.returncode, 3)
                    self.assertIn(expected, result.stderr.lower())

    def test_registry_contains_catalog_baseline_for_common_trackers(self):
        body = MANIFEST.read_text(encoding="utf-8").lower()
        for marker in ("adjust", "appsflyer", "facebook", "googleads", "firebase-performance",
                       "amplitude", "bugsnag", "datadog", "newrelic"):
            with self.subTest(marker=marker):
                self.assertIn(marker, body)

    def test_workflows_enforce_restricted_capture_mapping_and_manual_owner_contracts(self):
        network = (ROOT / ".github/workflows/android-network-evidence.yml").read_text(encoding="utf-8")
        build = (ROOT / ".github/workflows/build-android.yml").read_text(encoding="utf-8")
        quarterly = (ROOT / ".github/workflows/android-tracker-quarterly-review.yml").read_text(encoding="utf-8")
        self.assertNotIn("ANDROID_NETWORK_RAW_CAPTURE_BASE64", network)
        self.assertNotIn("android-network-raw-restricted", network)
        for required in ("app_uid", "raw_capture_sha256", "restricted_evidence_reference", "manual_owner"):
            self.assertIn(required, network)
        self.assertIn("app/build/outputs/mapping/release/mapping.txt", build)
        self.assertIn("test -s app/build/outputs/mapping/release/mapping.txt", build)
        self.assertIn("cron: '17 9 * * 1'", quarterly)
        self.assertIn("review_record", quarterly)


# ── exact scanner results for a fixed corpus ──────────────────────────────
#
# The expected streams, findings and CLI output below were recorded from the scanner
# as it was before the payload-reuse rewrite (50deead9) and match the current one.
# Locations use {root} for the corpus directory and {repo} for the repository root, with
# "/" separators; {secret.dex} is zipfile's repr of the encrypted archive's only member.
# Payloads are named after the bytes the corpus builder wrote.

FIXED_TIME = (2026, 1, 1, 0, 0, 0)
DEX = b"dex\n035\x00 prefix com/mixpanel/android/mpmetrics suffix"
NATIVE = b"\x7fELF native payload sentry_native_init end"
RESOURCES = b"clean compiled resources"
TOC = b"table of contents"
REPORT = b"com.google.firebase:firebase-analytics:22.0.0"


def _load_scanner():
    spec = importlib.util.spec_from_file_location("scan_tracker_signatures_under_test", SCANNER)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


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


def _write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def build_corpus(root: Path):
    """Writes the corpus under root; returns (cases, payloads by name)."""
    payloads = {"DEX": DEX, "NATIVE": NATIVE, "RESOURCES": RESOURCES, "TOC": TOC, "REPORT": REPORT}

    def named(name, data):
        payloads[name] = data
        return data

    def nest(prefix, levels):
        """A ZIP whose raw, non-ZIP leaf.jar is reached at depth levels + 1."""
        payload = named(f"{prefix}!L{levels}.jar", _zip([("leaf.jar", named("leaf.jar", b"raw bytes, not a zip"))]))
        for level in range(levels, 1, -1):
            payload = named(f"{prefix}!L{level - 1}.jar", _zip([(f"L{level}.jar", payload)]))
        return named(prefix, _zip([("L1.jar", payload)]))

    apk = named("apk", _zip([("classes.dex", DEX), ("lib/arm64-v8a/libapp.so", NATIVE, zipfile.ZIP_STORED),
                             ("resources.arsc", RESOURCES)]))
    aab = named("aab", _zip([("base/dex/classes.dex", DEX),
                             ("base/lib/arm64-v8a/libapp.so", NATIVE, zipfile.ZIP_STORED),
                             ("base/resources.pb", RESOURCES)]))
    release = root / "release"
    _write(release / "aa-classes.dex", DEX)  # first payload, repeated later: witnesses reuse
    _write(release / "app-release.apk", apk)
    _write(release / "app-release.aab", aab)
    _write(release / "unsigned-release.apks", named("apks", _zip([("universal.apk", apk, zipfile.ZIP_STORED),
                                                                  ("toc.pb", TOC)])))
    _write(release / "splits/universal.apk", apk)  # bundletool's universal APK carries the same members
    _write(release / "splits/toc.pb", TOC)

    exceptions = root / "exceptions"
    _write(exceptions / "a/dependency-report.txt", REPORT)
    _write(exceptions / "b/dependency-report.txt", REPORT)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    today = dt.date.today()
    manifest["exceptions"] = [{
        "signature_id": "firebase-analytics-dependency",
        "path_regex": r"a[/\\]dependency-report\.txt$",
        "rationale": "Fixture: one of two identical payloads is excepted",
        "owner": "security",
        "reviewed_on": (today - dt.timedelta(days=30)).isoformat(),
        "expires_on": (today + dt.timedelta(days=30)).isoformat(),
    }]
    exception_manifest = _write(root / "exception-manifest.json", json.dumps(manifest).encode())

    encrypted = named("encrypted", _mark_encrypted(_zip([("secret.dex", b"clean")])))
    corrupt_inner = named("corrupt-inner", _corrupt_local_header(_zip([("a.txt", b"hello")])))
    cases = {
        "release": ((release,), MANIFEST),
        "location-exception": ((exceptions,), exception_manifest),
        "duplicate-member-names": ((_write(root / "dupnames/archive.zip", named("dupnames", _zip(
            [("dup.dex", named("clean-payload", b"clean payload")),
             ("dup.dex", named("adid-payload", b"uses AdvertisingIdClient here"))]))),), MANIFEST),
        "zip-without-suffix": ((_write(root / "nosuffix/blob.bin", named("blob", _zip(
            [("inner.txt", named("clean", b"clean")),
             ("data.bin", named("data-zip", _zip([("x.txt", named("bugsnag", b"Bugsnag notifier"))])))]))),),
                               MANIFEST),
        "raw-nested-jar": ((_write(root / "rawjar/lib.aar", named("rawjar-aar", _zip(
            [("classes.jar", named("not-zip", b"not a zip at all"))]))),), MANIFEST),
        "aar-nested-jar": ((_write(root / "aar/lib.aar", named("aar", _zip(
            [("classes.jar", named("classes-jar", _zip([("com/example/A.class", named("class", b"class bytes"))])))]
        ))),), MANIFEST),
        "depth-boundary-pass": ((_write(root / "depth-ok/ok.zip", nest("ok.zip", 3)),), MANIFEST),
        "depth-boundary-over": ((_write(root / "depth-over/over.zip", nest("over.zip", 4)),), MANIFEST),
        "malformed-top-level-apk": ((_write(root / "malformed/broken.apk", named("not-a-zip", b"definitely not a zip")),),
                                    MANIFEST),
        "encrypted-nested-zip": ((_write(root / "encrypted/outer.zip", named("encrypted-outer", _zip(
            [("inner.zip", encrypted, zipfile.ZIP_STORED)]))),), MANIFEST),
        "encrypted-top-level-zip": ((_write(root / "encrypted-top/top.zip", encrypted),), MANIFEST),
        "corrupt-nested-zip": ((_write(root / "corrupt/outer.zip", named("corrupt-outer", _zip(
            [("inner.zip", corrupt_inner, zipfile.ZIP_STORED)]))),), MANIFEST),
        "empty-file": ((_write(root / "empty/empty.txt", named("empty", b"")),), MANIFEST),
        "fixture-clean": ((FIXTURES / "clean",), MANIFEST),
        **{f"fixture-positive-{path.name}": ((path,), MANIFEST)
           for path in sorted((FIXTURES / "positive").iterdir()) if path.is_dir()},
        "missing-after-valid": ((FIXTURES / "clean", root / "does-not-exist"), MANIFEST),
    }
    for path in sorted(FIXTURES.rglob("*")):
        if path.is_file():
            payloads["fixture:" + path.relative_to(FIXTURES).as_posix()] = path.read_bytes()
    return cases, payloads


def build_limit_corpus(root: Path, constant: str):
    """Boundary archives for one patched limit; outer archives stay within it so failures are nested."""
    if constant == "MAX_ARCHIVE_MEMBERS":
        limit = 3
        exact = _zip([(f"m{i}.txt", b"clean") for i in range(3)])
        over = _zip([(f"m{i}.txt", b"clean") for i in range(4)])
    else:
        limit = 256
        exact, over = _zip([("m.txt", b"x" * 256)]), _zip([("m.txt", b"x" * 257)])
        assert len(over) < limit
    aab = _zip([("base/inner.zip", over, zipfile.ZIP_STORED)])
    apks = _zip([("universal.apk", over, zipfile.ZIP_STORED)])
    outer = _zip([("inner.zip", over, zipfile.ZIP_STORED)])
    targets = {
        "exact": _write(root / "exact/exact.zip", exact),
        "over": _write(root / "over/over.zip", over),
        "nested-in-aab": _write(root / "aab/app.aab", aab),
        "nested-in-apks": _write(root / "apks/app.apks", apks),
        "repeated": root / "repeated",  # identical boundary archives, then a nested over-limit one
    }
    _write(root / "repeated/a-exact.zip", exact)
    _write(root / "repeated/b-exact.zip", exact)
    _write(root / "repeated/c-outer.zip", outer)
    payloads = {"exact": exact, "over": over, "aab": aab, "apks": apks, "outer": outer, "clean": b"clean",
                "x256": b"x" * 256, "x257": b"x" * 257}
    return limit, targets, payloads


EXPECTED_STREAMS = {
    "release": """\
{root}/release/aa-classes.dex = DEX
{root}/release/app-release.aab = aab
{root}/release/app-release.aab!base/dex/classes.dex = DEX
{root}/release/app-release.aab!base/lib/arm64-v8a/libapp.so = NATIVE
{root}/release/app-release.aab!base/resources.pb = RESOURCES
{root}/release/app-release.apk = apk
{root}/release/app-release.apk!classes.dex = DEX
{root}/release/app-release.apk!lib/arm64-v8a/libapp.so = NATIVE
{root}/release/app-release.apk!resources.arsc = RESOURCES
{root}/release/splits/toc.pb = TOC
{root}/release/splits/universal.apk = apk
{root}/release/splits/universal.apk!classes.dex = DEX
{root}/release/splits/universal.apk!lib/arm64-v8a/libapp.so = NATIVE
{root}/release/splits/universal.apk!resources.arsc = RESOURCES
{root}/release/unsigned-release.apks = apks
{root}/release/unsigned-release.apks!universal.apk = apk
{root}/release/unsigned-release.apks!universal.apk = apk
{root}/release/unsigned-release.apks!universal.apk!classes.dex = DEX
{root}/release/unsigned-release.apks!universal.apk!lib/arm64-v8a/libapp.so = NATIVE
{root}/release/unsigned-release.apks!universal.apk!resources.arsc = RESOURCES
{root}/release/unsigned-release.apks!toc.pb = TOC
""",
    "location-exception": """\
{root}/exceptions/a/dependency-report.txt = REPORT
{root}/exceptions/b/dependency-report.txt = REPORT
""",
    "duplicate-member-names": """\
{root}/dupnames/archive.zip = dupnames
{root}/dupnames/archive.zip!dup.dex = clean-payload
{root}/dupnames/archive.zip!dup.dex = adid-payload
""",
    "zip-without-suffix": """\
{root}/nosuffix/blob.bin = blob
{root}/nosuffix/blob.bin!inner.txt = clean
{root}/nosuffix/blob.bin!data.bin = data-zip
{root}/nosuffix/blob.bin!data.bin = data-zip
{root}/nosuffix/blob.bin!data.bin!x.txt = bugsnag
""",
    "raw-nested-jar": """\
{root}/rawjar/lib.aar = rawjar-aar
{root}/rawjar/lib.aar!classes.jar = not-zip
{root}/rawjar/lib.aar!classes.jar = not-zip
""",
    "aar-nested-jar": """\
{root}/aar/lib.aar = aar
{root}/aar/lib.aar!classes.jar = classes-jar
{root}/aar/lib.aar!classes.jar = classes-jar
{root}/aar/lib.aar!classes.jar!com/example/A.class = class
""",
    "depth-boundary-pass": """\
{root}/depth-ok/ok.zip = ok.zip
{root}/depth-ok/ok.zip!L1.jar = ok.zip!L1.jar
{root}/depth-ok/ok.zip!L1.jar = ok.zip!L1.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar = ok.zip!L2.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar = ok.zip!L2.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar!L3.jar = ok.zip!L3.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar!L3.jar = ok.zip!L3.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar!L3.jar!leaf.jar = leaf.jar
{root}/depth-ok/ok.zip!L1.jar!L2.jar!L3.jar!leaf.jar = leaf.jar
""",
    "depth-boundary-over": """\
{root}/depth-over/over.zip = over.zip
{root}/depth-over/over.zip!L1.jar = over.zip!L1.jar
{root}/depth-over/over.zip!L1.jar = over.zip!L1.jar
{root}/depth-over/over.zip!L1.jar!L2.jar = over.zip!L2.jar
{root}/depth-over/over.zip!L1.jar!L2.jar = over.zip!L2.jar
{root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar = over.zip!L3.jar
{root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar = over.zip!L3.jar
{root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar!L4.jar = over.zip!L4.jar
{root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar!L4.jar = over.zip!L4.jar
{root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar!L4.jar!leaf.jar = leaf.jar
raises ManifestError: archive nesting limit exceeded: {root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar!L4.jar!leaf.jar
""",
    "malformed-top-level-apk": """\
{root}/malformed/broken.apk = not-a-zip
raises ManifestError: cannot inspect archive {root}/malformed/broken.apk: File is not a zip file
""",
    "encrypted-nested-zip": """\
{root}/encrypted/outer.zip = encrypted-outer
{root}/encrypted/outer.zip!inner.zip = encrypted
{root}/encrypted/outer.zip!inner.zip = encrypted
raises ManifestError: cannot inspect archive {root}/encrypted/outer.zip!inner.zip: File {secret.dex} is encrypted, password required for extraction
""",
    "encrypted-top-level-zip": """\
{root}/encrypted-top/top.zip = encrypted
raises ManifestError: cannot inspect archive {root}/encrypted-top/top.zip: File {secret.dex} is encrypted, password required for extraction
""",
    "corrupt-nested-zip": """\
{root}/corrupt/outer.zip = corrupt-outer
{root}/corrupt/outer.zip!inner.zip = corrupt-inner
{root}/corrupt/outer.zip!inner.zip = corrupt-inner
raises ManifestError: cannot inspect archive {root}/corrupt/outer.zip!inner.zip: Bad magic number for file header
""",
    "empty-file": """\
{root}/empty/empty.txt = empty
""",
    "fixture-clean": """\
{repo}/android/security/fixtures/tracker-scan/clean/dependencies.txt = fixture:clean/dependencies.txt
""",
}
EXPECTED_CLI = {
    "release": (2, """\
PROHIBITED [package] tracker-package {root}/release/aa-classes.dex: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {root}/release/aa-classes.dex: com/mixpanel/android/mpmetrics
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/app-release.aab: sentry_native_init
PROHIBITED [package] tracker-package {root}/release/app-release.aab!base/dex/classes.dex: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {root}/release/app-release.aab!base/dex/classes.dex: com/mixpanel/android/mpmetrics
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/app-release.aab!base/lib/arm64-v8a/libapp.so: sentry_native_init
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/app-release.apk: sentry_native_init
PROHIBITED [package] tracker-package {root}/release/app-release.apk!classes.dex: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {root}/release/app-release.apk!classes.dex: com/mixpanel/android/mpmetrics
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/app-release.apk!lib/arm64-v8a/libapp.so: sentry_native_init
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/splits/universal.apk: sentry_native_init
PROHIBITED [package] tracker-package {root}/release/splits/universal.apk!classes.dex: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {root}/release/splits/universal.apk!classes.dex: com/mixpanel/android/mpmetrics
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/splits/universal.apk!lib/arm64-v8a/libapp.so: sentry_native_init
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/unsigned-release.apks: sentry_native_init
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/unsigned-release.apks!universal.apk: sentry_native_init
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/unsigned-release.apks!universal.apk: sentry_native_init
PROHIBITED [package] tracker-package {root}/release/unsigned-release.apks!universal.apk!classes.dex: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {root}/release/unsigned-release.apks!universal.apk!classes.dex: com/mixpanel/android/mpmetrics
PROHIBITED [native_symbol] tracker-native-symbol {root}/release/unsigned-release.apks!universal.apk!lib/arm64-v8a/libapp.so: sentry_native_init
tracker scan failed: 20 prohibited finding(s)
""", '', (1, 20, 0, 'fail')),
    "location-exception": (2, """\
EXCEPTED [dependency] firebase-analytics-dependency {root}/exceptions/a/dependency-report.txt: com.google.firebase:firebase-analytics:
PROHIBITED [dependency] firebase-analytics-dependency {root}/exceptions/b/dependency-report.txt: com.google.firebase:firebase-analytics:
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 1, 'fail')),
    "duplicate-member-names": (2, """\
PROHIBITED [identifier_api] identifier-attribution-api {root}/dupnames/archive.zip!dup.dex: AdvertisingIdClient
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 0, 'fail')),
    "zip-without-suffix": (2, """\
PROHIBITED [dex_signature] tracker-dex-signature {root}/nosuffix/blob.bin!data.bin!x.txt: Bugsnag
PROHIBITED [native_symbol] tracker-native-symbol {root}/nosuffix/blob.bin!data.bin!x.txt: Bugsnag
tracker scan failed: 2 prohibited finding(s)
""", '', (1, 2, 0, 'fail')),
    "raw-nested-jar": (0, """\
tracker scan passed: 0 finding(s), 0 reviewed exception(s)
""", '', (1, 0, 0, 'pass')),
    "aar-nested-jar": (0, """\
tracker scan passed: 0 finding(s), 0 reviewed exception(s)
""", '', (1, 0, 0, 'pass')),
    "depth-boundary-pass": (0, """\
tracker scan passed: 0 finding(s), 0 reviewed exception(s)
""", '', (1, 0, 0, 'pass')),
    "depth-boundary-over": (3, "", 'archive nesting limit exceeded: {root}/depth-over/over.zip!L1.jar!L2.jar!L3.jar!L4.jar!leaf.jar\n', None),
    "malformed-top-level-apk": (3, "", 'cannot inspect archive {root}/malformed/broken.apk: File is not a zip file\n', None),
    "encrypted-nested-zip": (3, "", 'cannot inspect archive {root}/encrypted/outer.zip!inner.zip: File {secret.dex} is encrypted, password required for extraction\n', None),
    "encrypted-top-level-zip": (3, "", 'cannot inspect archive {root}/encrypted-top/top.zip: File {secret.dex} is encrypted, password required for extraction\n', None),
    "corrupt-nested-zip": (3, "", 'cannot inspect archive {root}/corrupt/outer.zip!inner.zip: Bad magic number for file header\n', None),
    "empty-file": (0, """\
tracker scan passed: 0 finding(s), 0 reviewed exception(s)
""", '', (1, 0, 0, 'pass')),
    "fixture-clean": (0, """\
tracker scan passed: 0 finding(s), 0 reviewed exception(s)
""", '', (1, 0, 0, 'pass')),
    "fixture-positive-dependency": (2, """\
PROHIBITED [dependency] firebase-analytics-dependency {repo}/android/security/fixtures/tracker-scan/positive/dependency/input.txt: com.google.firebase:firebase-analytics:
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 0, 'fail')),
    "fixture-positive-dex_signature": (2, """\
PROHIBITED [package] tracker-package {repo}/android/security/fixtures/tracker-scan/positive/dex_signature/classes.dex.txt: com/mixpanel/android
PROHIBITED [dex_signature] tracker-dex-signature {repo}/android/security/fixtures/tracker-scan/positive/dex_signature/classes.dex.txt: com/mixpanel/android/mpmetrics
tracker scan failed: 2 prohibited finding(s)
""", '', (1, 2, 0, 'fail')),
    "fixture-positive-domain": (2, """\
PROHIBITED [domain] tracker-domain {repo}/android/security/fixtures/tracker-scan/positive/domain/input.txt: api.mixpanel.com
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 0, 'fail')),
    "fixture-positive-identifier_api": (2, """\
PROHIBITED [identifier_api] identifier-attribution-api {repo}/android/security/fixtures/tracker-scan/positive/identifier_api/input.txt: com/android/installreferrer
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 0, 'fail')),
    "fixture-positive-manifest_component": (2, """\
PROHIBITED [package] tracker-package {repo}/android/security/fixtures/tracker-scan/positive/manifest_component/AndroidManifest.xml: io.sentry
PROHIBITED [manifest_component] tracker-manifest-component {repo}/android/security/fixtures/tracker-scan/positive/manifest_component/AndroidManifest.xml: io.sentry.android.core.SentryInitProvider
tracker scan failed: 2 prohibited finding(s)
""", '', (1, 2, 0, 'fail')),
    "fixture-positive-native_symbol": (2, """\
PROHIBITED [native_symbol] tracker-native-symbol {repo}/android/security/fixtures/tracker-scan/positive/native_symbol/libtracker_so.txt: sentry_native_init
tracker scan failed: 1 prohibited finding(s)
""", '', (1, 1, 0, 'fail')),
    "fixture-positive-package": (2, """\
PROHIBITED [package] tracker-package {repo}/android/security/fixtures/tracker-scan/positive/package/input.txt: com/posthog/android
PROHIBITED [dex_signature] tracker-dex-signature {repo}/android/security/fixtures/tracker-scan/positive/package/input.txt: com/posthog/android/PostHog
tracker scan failed: 2 prohibited finding(s)
""", '', (1, 2, 0, 'fail')),
    "missing-after-valid": (3, "", 'scan target does not exist: {root}/does-not-exist\n', None),
}
EXPECTED_LIMIT_STREAMS = {
    ("MAX_ARCHIVE_MEMBERS", "exact"): """\
{root}/exact/exact.zip = exact
{root}/exact/exact.zip!m0.txt = clean
{root}/exact/exact.zip!m1.txt = clean
{root}/exact/exact.zip!m2.txt = clean
""",
    ("MAX_ARCHIVE_MEMBERS", "over"): """\
{root}/over/over.zip = over
raises ManifestError: archive member limit exceeded: {root}/over/over.zip
""",
    ("MAX_ARCHIVE_MEMBERS", "nested-in-aab"): """\
{root}/aab/app.aab = aab
{root}/aab/app.aab!base/inner.zip = over
{root}/aab/app.aab!base/inner.zip = over
raises ManifestError: archive member limit exceeded: {root}/aab/app.aab!base/inner.zip
""",
    ("MAX_ARCHIVE_MEMBERS", "nested-in-apks"): """\
{root}/apks/app.apks = apks
{root}/apks/app.apks!universal.apk = over
{root}/apks/app.apks!universal.apk = over
raises ManifestError: archive member limit exceeded: {root}/apks/app.apks!universal.apk
""",
    ("MAX_ARCHIVE_MEMBERS", "repeated"): """\
{root}/repeated/a-exact.zip = exact
{root}/repeated/a-exact.zip!m0.txt = clean
{root}/repeated/a-exact.zip!m1.txt = clean
{root}/repeated/a-exact.zip!m2.txt = clean
{root}/repeated/b-exact.zip = exact
{root}/repeated/b-exact.zip!m0.txt = clean
{root}/repeated/b-exact.zip!m1.txt = clean
{root}/repeated/b-exact.zip!m2.txt = clean
{root}/repeated/c-outer.zip = outer
{root}/repeated/c-outer.zip!inner.zip = over
{root}/repeated/c-outer.zip!inner.zip = over
raises ManifestError: archive member limit exceeded: {root}/repeated/c-outer.zip!inner.zip
""",
    ("MAX_MEMBER_BYTES", "exact"): """\
{root}/exact/exact.zip = exact
{root}/exact/exact.zip!m.txt = x256
""",
    ("MAX_MEMBER_BYTES", "over"): """\
{root}/over/over.zip = over
raises ManifestError: archive member size limit exceeded: {root}/over/over.zip!m.txt
""",
    ("MAX_MEMBER_BYTES", "nested-in-aab"): """\
{root}/aab/app.aab = aab
{root}/aab/app.aab!base/inner.zip = over
{root}/aab/app.aab!base/inner.zip = over
raises ManifestError: archive member size limit exceeded: {root}/aab/app.aab!base/inner.zip!m.txt
""",
    ("MAX_MEMBER_BYTES", "nested-in-apks"): """\
{root}/apks/app.apks = apks
{root}/apks/app.apks!universal.apk = over
{root}/apks/app.apks!universal.apk = over
raises ManifestError: archive member size limit exceeded: {root}/apks/app.apks!universal.apk!m.txt
""",
    ("MAX_MEMBER_BYTES", "repeated"): """\
{root}/repeated/a-exact.zip = exact
{root}/repeated/a-exact.zip!m.txt = x256
{root}/repeated/b-exact.zip = exact
{root}/repeated/b-exact.zip!m.txt = x256
{root}/repeated/c-outer.zip = outer
{root}/repeated/c-outer.zip!inner.zip = over
{root}/repeated/c-outer.zip!inner.zip = over
raises ManifestError: archive member size limit exceeded: {root}/repeated/c-outer.zip!inner.zip!m.txt
""",
}


def _summary_bytes(targets_scanned: int, prohibited: int, excepted: int, result: str) -> bytes:
    reviewed_on = json.loads(MANIFEST.read_text(encoding="utf-8"))["reviewed_on"]
    return (
        "{\n"
        '  "schema_version": 1,\n'
        f'  "manifest_reviewed_on": "{reviewed_on}",\n'
        f'  "targets_scanned": {targets_scanned},\n'
        f'  "prohibited_findings": {prohibited},\n'
        f'  "reviewed_exceptions": {excepted},\n'
        f'  "result": "{result}"\n'
        "}\n"
    ).replace("\n", os.linesep).encode("utf-8")  # the scanner writes in text mode


class _CountingPattern:
    def __init__(self, pattern, calls: list):
        self._pattern, self._calls = pattern, calls

    def search(self, payload):
        self._calls.append((len(payload), hashlib.sha256(payload).digest()))
        return self._pattern.search(payload)

    def __getattr__(self, name):
        return getattr(self._pattern, name)


class TrackerScannerResultTest(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.scanner = _load_scanner()
        cls._tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls._tmp.name).resolve()
        cls.cases, cls.payloads = build_corpus(cls.root / "corpus")
        with zipfile.ZipFile(io.BytesIO(cls.payloads["encrypted"])) as archive:
            cls.secret_member = repr(archive.getinfo("secret.dex"))

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    @staticmethod
    def normalise(text: str, root: Path) -> str:
        text = text.replace(str(root), "{root}").replace(str(ROOT), "{repo}")
        return text.replace(os.sep, "/") if os.sep != "/" else text

    def expand(self, expected: str) -> str:
        return expected.replace("{secret.dex}", self.secret_member)

    def assert_stream(self, target: Path, root: Path, payloads: dict, expected: str):
        """Compares the ordered payload stream, including repeats and the error it ends with."""
        lines = expected.splitlines()
        error = lines.pop() if lines[-1].startswith("raises ") else None
        expected_items = []
        for line in lines:
            location, name = line.rsplit(" = ", 1)
            expected_items.append((location, payloads[name]))
        items, raised = [], None
        try:
            for location, payload in self.scanner.iter_payloads(target):
                items.append((self.normalise(location, root), payload))
        except Exception as exc:
            raised = f"raises {type(exc).__name__}: {self.normalise(str(exc), root)}"
        self.assertEqual([location for location, _ in items], [location for location, _ in expected_items])
        self.assertEqual(items, expected_items)
        if error is None:
            self.assertIsNone(raised)
        else:
            self.assertEqual(raised, self.expand(error))

    def test_finding_fields(self):
        self.assertEqual([field.name for field in dataclasses.fields(self.scanner.Finding)],
                         ["signature_id", "category", "description", "location", "excerpt", "excepted"])

    def test_payload_streams(self):
        self.assertEqual(set(EXPECTED_STREAMS) | {"missing-after-valid"} | {
            name for name in self.cases if name.startswith("fixture-positive-")}, set(self.cases))
        for name, expected in EXPECTED_STREAMS.items():
            with self.subTest(case=name):
                (target,), _ = self.cases[name]
                self.assert_stream(target, self.root / "corpus", self.payloads, expected)

    def test_cli_output(self):
        self.assertEqual(set(EXPECTED_CLI), set(self.cases))
        for name, (code, stdout, stderr, summary) in EXPECTED_CLI.items():
            with self.subTest(case=name):
                targets, manifest = self.cases[name]
                summary_path = self.root / f"summary-{name}.json"
                result = subprocess.run(
                    [sys.executable, str(SCANNER), "--manifest", str(manifest), "--summary", str(summary_path),
                     *map(str, targets)],
                    cwd=ROOT, text=True, capture_output=True, check=False,
                )
                corpus = self.root / "corpus"
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)
                self.assertEqual(self.normalise(result.stdout, corpus), stdout)
                self.assertEqual(self.normalise(result.stderr, corpus), self.expand(stderr))
                if summary is None:
                    self.assertFalse(summary_path.exists())
                else:
                    self.assertEqual(summary_path.read_bytes(), _summary_bytes(*summary))

    def test_archive_limits(self):
        """Limits patched small; the same corpus must pass at the limit and fail closed one over it."""
        for (constant, name), expected in EXPECTED_LIMIT_STREAMS.items():
            with self.subTest(constant=constant, case=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                limit, targets, payloads = build_limit_corpus(root, constant)
                target = targets[name]
                error = expected.splitlines()[-1].removeprefix("raises ManifestError: ")
                failing = expected.splitlines()[-1].startswith("raises ")
                with mock.patch.object(self.scanner, constant, limit):
                    self.assert_stream(target, root, payloads, expected)
                    manifest, signatures = self.scanner.load_manifest(MANIFEST)
                    if failing:
                        with self.assertRaises(self.scanner.ManifestError) as raised:
                            self.scanner.scan(manifest, signatures, [target])
                        self.assertEqual(self.normalise(str(raised.exception), root), error)
                    else:
                        self.assertEqual(self.scanner.scan(manifest, signatures, [target]), [])
                    summary = root / "summary.json"
                    stdout, stderr = io.StringIO(), io.StringIO()
                    argv = ["scan-tracker-signatures.py", "--manifest", str(MANIFEST), "--summary", str(summary),
                            str(target)]
                    with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(stdout), \
                            contextlib.redirect_stderr(stderr):
                        code = self.scanner.main()
                if failing:
                    self.assertEqual((code, stdout.getvalue(), self.normalise(stderr.getvalue(), root)),
                                     (3, "", error + "\n"))
                    self.assertFalse(summary.exists())
                else:
                    self.assertEqual((code, stdout.getvalue(), stderr.getvalue()),
                                     (0, "tracker scan passed: 0 finding(s), 0 reviewed exception(s)\n", ""))
                    self.assertEqual(summary.read_bytes(), _summary_bytes(1, 0, 0, "pass"))

    # ── bounded work: each remembered distinct payload is searched once ───

    def release_keys(self) -> list:
        keys = []
        for line in EXPECTED_STREAMS["release"].splitlines():
            payload = self.payloads[line.rsplit(" = ", 1)[1]]
            keys.append((len(payload), hashlib.sha256(payload).digest()))
        return keys

    @staticmethod
    def simulated_searches(keys: list, capacity) -> list:
        remembered, searched = set(), []
        for key in keys:
            if key in remembered:
                continue
            searched.append(key)
            if capacity is None or len(remembered) < capacity:
                remembered.add(key)
        return searched

    def counted_scan(self) -> tuple:
        manifest, signatures = self.scanner.load_manifest(MANIFEST)
        calls = [[] for _ in signatures]
        wrapped = [(entry, _CountingPattern(pattern, calls[index]))
                   for index, (entry, pattern) in enumerate(signatures)]
        (target,), _ = self.cases["release"]
        findings = self.scanner.scan(manifest, wrapped, [target])
        lines = [f"PROHIBITED [{finding.category}] {finding.signature_id} "
                 f"{self.normalise(finding.location, self.root / 'corpus')}: {finding.excerpt}"
                 for finding in findings]
        self.assertFalse(any(finding.excepted for finding in findings))
        descriptions = {entry["id"]: entry["description"]
                        for entry in json.loads(MANIFEST.read_text(encoding="utf-8"))["signatures"]}
        self.assertEqual([finding.description for finding in findings],
                         [descriptions[finding.signature_id] for finding in findings])
        self.assertEqual(lines, EXPECTED_CLI["release"][1].splitlines()[:-1])
        return calls

    def test_default_memory_searches_each_distinct_payload_once(self):
        keys = self.release_keys()
        expected = self.simulated_searches(keys, None)
        self.assertLess(len(expected), len(keys), "the release corpus must repeat payloads")
        self.assertLessEqual(len(expected), 65_536, "the release corpus must fit the default memory")
        for index, searched in enumerate(self.counted_scan()):
            self.assertEqual(searched, expected, f"signature {index}")

    def test_bounded_memory_searches_exactly_the_simulated_payloads(self):
        keys = self.release_keys()
        for capacity in (0, 1, 2):
            with self.subTest(capacity=capacity), mock.patch.object(self.scanner, "MAX_REMEMBERED_RESULTS", capacity):
                expected = self.simulated_searches(keys, capacity)
                if capacity:
                    self.assertLess(len(expected), len(keys), "the release corpus must reuse a remembered payload")
                for index, searched in enumerate(self.counted_scan()):
                    self.assertEqual(searched, expected, f"capacity {capacity}: signature {index}")


if __name__ == "__main__":
    unittest.main()
