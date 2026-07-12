import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

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
            with self.subTest(category=category):
                result = self.run_scan(FIXTURES / "positive" / category)
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

    def test_scoped_unexpired_exception_is_reviewable_but_expired_one_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "dependency-report.txt"
            target.write_text("com.google.firebase:firebase-analytics:22.0.0", encoding="utf-8")
            base = json.loads(MANIFEST.read_text(encoding="utf-8"))
            base["exceptions"] = [{
                "signature_id": "firebase-analytics-dependency",
                "path_regex": "dependency-report\\.txt$",
                "rationale": "Fixture-only review record",
                "owner": "security",
                "reviewed_on": "2026-07-12",
                "expires_on": (dt.date.today() + dt.timedelta(days=30)).isoformat()
            }]
            manifest = Path(tmp) / "manifest.json"
            manifest.write_text(json.dumps(base), encoding="utf-8")
            result = self.run_scan(target, manifest=manifest)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("1 reviewed exception", result.stdout)
            base["exceptions"][0]["expires_on"] = "2000-01-01"
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


if __name__ == "__main__":
    unittest.main()
