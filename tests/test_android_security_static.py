from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGIN_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/LoginActivity.kt"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"


def test_login_activity_rejects_credential_prefill_extras_and_is_not_exported():
    activity = LOGIN_ACTIVITY.read_text(encoding="utf-8")
    manifest = MANIFEST.read_text(encoding="utf-8")

    assert "EXTRA_INITIAL_USERNAME" not in activity
    assert "EXTRA_INITIAL_PASSWORD" not in activity
    assert "getStringExtra(EXTRA_INITIAL_USERNAME)" not in activity
    assert "getStringExtra(EXTRA_INITIAL_PASSWORD)" not in activity

    login_decl = manifest[manifest.index('android:name=".ui.setup.LoginActivity"'):]
    login_decl = login_decl[:login_decl.index("</activity>")]
    assert 'android:exported="false"' in login_decl
