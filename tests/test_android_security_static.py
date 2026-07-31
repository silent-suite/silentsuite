from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOGIN_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/LoginActivity.kt"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"
APP_GRADLE = ROOT / "android/app/build.gradle"
APP_RESOURCES = ROOT / "android/app/src/main/res"


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


def test_android_app_runtime_dependencies_are_not_snapshots():
    app_gradle = APP_GRADLE.read_text(encoding="utf-8")

    assert "SNAPSHOT" not in app_gradle


def test_android_resources_do_not_reference_tourguide_owned_white():
    resource_xml = "\n".join(
        path.read_text(encoding="utf-8") for path in APP_RESOURCES.rglob("*.xml")
    )

    assert "@color/White" not in resource_xml


def test_every_checked_in_android_source_set_uses_lease_scoped_setup_secrets():
    tracked = subprocess.run(
        ["git", "ls-files", "android/**/src/**"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    sources = [ROOT / path for path in tracked if path.endswith((".kt", ".java"))]
    roots = {path.parts[path.parts.index("src") + 1] for path in sources if "src" in path.parts}
    assert {"main", "test", "androidTest"} <= roots
    assert sources

    combined = "\n".join(path.read_text(encoding="utf-8") for path in sources)
    holder = (ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/SetupSecretHolder.kt").read_text(
        encoding="utf-8"
    )
    for dead_api in ("pendingSessions", "setPendingSession", "consumePendingSession"):
        assert dead_api not in combined
    for contract in ("OwnerLease", "LeaseRefV1", "beginOperation", "commitIfCurrent"):
        assert contract in holder
    for legacy_call in (
        "SetupSecretHolder.setLoginCredentials(",
        "SetupSecretHolder.getLoginCredentials()",
        "SetupSecretHolder.clearLoginCredentials()",
        "SetupSecretHolder.setPendingConfiguration(",
        "SetupSecretHolder.getPendingConfiguration()",
        "SetupSecretHolder.clearCredentialsAndConfiguration()",
    ):
        assert legacy_call not in combined
