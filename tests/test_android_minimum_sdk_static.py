"""Product-floor contracts for retiring Android versions below Android 10."""

import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "android/app/src/main/java/io/silentsuite/sync"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_android_10_product_floor_preserves_target_and_library_contracts():
    for path in ("android/app/build.gradle", "android/cert4android/build.gradle"):
        assert re.findall(r"minSdkVersion\s+(\d+)", read(path)) == ["29"], path
    assert "targetSdkVersion 36" in read("android/app/build.gradle")
    assert "compileSdkVersion = 36" in read("android/build.gradle")
    assert "minSdkVersion 21" in read("android/ical4android/build.gradle")
    assert "minSdkVersion 16" in read("android/vcard4android/build.gradle")


def test_android_7_contact_hash_workaround_is_retired_without_data_reset():
    paths = (
        "resource/LocalContact.kt",
        "resource/LocalGroup.kt",
        "resource/LocalAddressBook.kt",
        "syncadapter/ContactsSyncManager.kt",
    )
    for path in paths:
        source = (APP / path).read_text(encoding="utf-8")
        assert "HASH_HACK" not in source, path
        assert "COLUMN_HASHCODE" not in source, path
        assert "getLastHashCode(" not in source, path
        assert "updateHashCode(" not in source, path
    # Persisted accounts/data are not reset just to retire this workaround.
    address_book = (APP / "resource/LocalAddressBook.kt").read_text(encoding="utf-8")
    assert "onConfirmedAddressBookRemoval" in address_book
    assert "recordConfirmedRemoval" in address_book


def test_product_floor_runtime_matrix_moves_to_29_and_keeps_modern_scenarios():
    workflow = read(".github/workflows/build-android.yml")
    assert not re.search(r"api-level:\s*['\"]?21\b", workflow)
    assert len(re.findall(r"api-level:\s*['\"]?29\b", workflow)) == 7
    ledger = json.loads(read("android/scripts/focused-runtime-ledger-v1.json"))
    assert {"29:mixed", "29:remaining", "35:all", "36:account-dashboard", "36:first-run-setup", "36:launcher-recovery", "36:sibling-routes", "36:status-routes"} == set(ledger["shards"])
    runner = read("android/scripts/run-focused-runtime-tests.sh")
    assert "21:" not in runner
    assert all(
        key in runner
        for key in ("29:mixed", "29:account-dashboard", "29:first-run-setup", "29:status-routes", "29:sibling-routes")
    )
    # OS retirement does not retire the registry persistence/reinstall journey.
    reinstall = read("android/scripts/run-registry-process-boundary.sh")
    assert 'adb install -r "${apk}"' in reinstall
    assert "run_step reinstall-write" in reinstall
    assert "run_step reinstall-read" in reinstall
    assert "old-version binary upgrade" in reinstall


def test_unsigned_artifacts_prove_minimum_and_target_sdk_separately():
    workflow = read(".github/workflows/build-android.yml")
    assert '"sdkVersion:\'29\'"' in workflow
    assert '"targetSdkVersion:\'36\'"' in workflow


def test_modern_notification_and_certificate_safety_guards_remain():
    notifications = (APP / "utils/NotificationUtils.kt").read_text(encoding="utf-8")
    certs = read("android/cert4android/src/main/java/at/bitfire/cert4android/CustomCertService.kt")
    for source in (notifications, certs):
        assert "POST_NOTIFICATIONS" in source
        assert "TIRAMISU" in source
    assert "SecurityException" in notifications
    assert "IMPORTANCE_NONE" in certs
    assert "EXTRA_DECISION_GENERATION" in certs
    assert "Security.insertProviderAt(Conscrypt.newProvider(), 1)" in certs
    assert "coreLibraryDesugaringEnabled true" in read("android/app/build.gradle")


def test_android_installation_documents_new_floor_and_legacy_update_boundary():
    docs = read("apps/docs/user-guide/apps/android.md")
    assert "Android 10" in docs
    assert "last compatible" in docs.lower()
