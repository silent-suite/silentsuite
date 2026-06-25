from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGIN_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/LoginActivity.kt"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"


def test_login_activity_credential_prefill_extras_are_debug_only_and_not_exported():
    activity = LOGIN_ACTIVITY.read_text(encoding="utf-8")
    manifest = MANIFEST.read_text(encoding="utf-8")

    assert "EXTRA_INITIAL_USERNAME" in activity
    assert "EXTRA_INITIAL_PASSWORD" in activity
    assert "BuildConfig.DEBUG" in activity
    assert "if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_INITIAL_USERNAME) else null" in activity
    assert "if (BuildConfig.DEBUG) intent.getStringExtra(EXTRA_INITIAL_PASSWORD) else null" in activity

    login_decl = manifest[manifest.index('android:name=".ui.setup.LoginActivity"'):]
    login_decl = login_decl[:login_decl.index("</activity>")]
    assert 'android:exported="false"' in login_decl
