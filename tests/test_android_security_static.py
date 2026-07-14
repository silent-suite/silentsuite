from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGIN_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/LoginActivity.kt"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"
APP_GRADLE = ROOT / "android/app/build.gradle"
APP_RESOURCES = ROOT / "android/app/src/main/res"


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


def test_android_app_runtime_dependencies_are_not_snapshots():
    app_gradle = APP_GRADLE.read_text(encoding="utf-8")

    assert "SNAPSHOT" not in app_gradle


def test_android_resources_do_not_reference_tourguide_owned_white():
    resource_xml = "\n".join(
        path.read_text(encoding="utf-8") for path in APP_RESOURCES.rglob("*.xml")
    )

    assert "@color/White" not in resource_xml
