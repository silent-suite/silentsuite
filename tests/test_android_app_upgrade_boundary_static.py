"""Static contracts for the app upgrade migrations and their in-place reinstall step (#935)."""

from pathlib import Path
import importlib.util
import json
import re


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "android/scripts/run-registry-process-boundary.sh"
RUNTIME = ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/AppUpgradeProcessBoundaryRuntimeTest.kt"
LEDGER = ROOT / "android/scripts/focused-runtime-ledger-v1.json"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"
APP = ROOT / "android/app/src/main/java/io/silentsuite/sync/App.kt"


def _checker():
    spec = importlib.util.spec_from_file_location(
        "check_app_upgrade_boundary", ROOT / "android/scripts/check-app-upgrade-boundary.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_update_receivers_use_the_broadcast_android_still_delivers():
    manifest = MANIFEST.read_text(encoding="utf-8")
    # Android 8+ no longer delivers PACKAGE_REPLACED to manifest receivers; MY_PACKAGE_REPLACED is exempt.
    assert '"android.intent.action.PACKAGE_REPLACED"' not in manifest
    for receiver in (".App$AppUpdatedReceiver", ".AccountSettings$AppUpdatedReceiver"):
        block = manifest.split(f'android:name="{receiver}"', 1)[1].split("</receiver>", 1)[0]
        assert '<action android:name="android.intent.action.MY_PACKAGE_REPLACED" />' in block
        assert "<data " not in block


def test_upgrade_migrations_also_run_at_start():
    app = APP.read_text(encoding="utf-8")
    on_create = app.split("override fun onCreate() {", 1)[1].split("\n    }\n", 1)[0]
    # After the account types are set (the oldest migration looks up accounts), once per new version.
    assert on_create.index("accountType = getString(R.string.account_type)") < on_create.index("runUpgradeMigrations()")
    body = app.split("internal fun runUpgradeMigrations() {", 1)[1].split("\n    }\n", 1)[0]
    assert "if (fromVersion !in 1 until BuildConfig.VERSION_CODE)" in body
    # A failing migration never stops the start, and the version advances only once it completed.
    assert "} catch (e: RuntimeException) {" in body
    assert body.index("update(fromVersion)") < body.index("if (complete)") < body.index(
        "putInt(PREF_VERSION, BuildConfig.VERSION_CODE)")
    update = app.split("private fun update(fromVersion: Int): Boolean {", 1)[1].split("\n    }\n", 1)[0]
    # The provider-wide migration waits for the calendar and contacts permissions instead of failing.
    for permission in ("READ_CALENDAR", "WRITE_CALENDAR", "READ_CONTACTS", "WRITE_CONTACTS"):
        assert f"Manifest.permission.{permission}" in update
    assert "complete = false" in update and update.rstrip().endswith("return complete")
    assert "for (account in if (calendarsAllowed) accounts else emptyArray())" in update
    assert "for (account in if (contactsAllowed) addressBooks else emptyArray())" in update
    receiver = app.split("class AppUpdatedReceiver : BroadcastReceiver() {", 1)[1].split("\n    }\n", 1)[0]
    assert "(context.applicationContext as App).runUpgradeMigrations()" in receiver


def test_upgrade_steps_run_last_around_their_own_in_place_reinstall():
    script = SCRIPT.read_text(encoding="utf-8")
    runtime = RUNTIME.read_text(encoding="utf-8")
    checker = _checker()

    steps = re.findall(r"^run_upgrade_step (\S+) (\S+)$", script, flags=re.MULTILINE)
    assert tuple(steps) == checker.EXPECTED_STEPS
    assert set(re.findall(r"@Test fun (\w+)\(", runtime)) == {method for _, method in checker.EXPECTED_STEPS}
    assert f'upgrade_class="{checker.TEST_CLASS}"' in script
    assert "AppUpgradeProcessBoundaryRuntimeTest" not in json.loads(LEDGER.read_text(encoding="utf-8"))["classes"]

    # After the registry's last step, so no extra app start falls between its legacy writer and reader: the
    # seed, the permissions granted then revoked, its own in-place reinstall of the same APK, the first process
    # after it, the permissions granted again, then a fresh process.
    seed = script.index("run_upgrade_step seed ")
    revoke = script.index("set_upgrade_permissions grant && set_upgrade_permissions revoke")
    install = script.rindex('adb install -r "${apk}"')
    revoked = script.index("run_upgrade_step revoked ")
    grant = script.index('set_upgrade_permissions grant > "${upgrade_output}/grant.txt"')
    check = script.index("run_upgrade_step check ")
    assert script.index("run_step malformed-read") < seed < revoke < install < revoked < grant < check
    for permission in ("READ_CALENDAR", "WRITE_CALENDAR", "READ_CONTACTS", "WRITE_CONTACTS"):
        assert f"android.permission.{permission}" in script[seed:revoke]
    assert script.index('adb install -r "${apk}"') < script.index("run_step reinstall-read") < seed
    assert '> "${upgrade_output}/upgrade-install.txt"' in script[install:]

    body = script.split("run_upgrade_step() {", 1)[1].split("\n}\n", 1)[0]
    assert body.index("terminate_app_process || command_status=$?") < body.index("adb shell am instrument -w -r")
    assert '-e class "${upgrade_class}#${method}"' in body
    inventory = script.split("write_inventory() {", 1)[1].split("\n}\n", 1)[0]
    assert ('python3 "${script_dir}/check-app-upgrade-boundary.py" "${upgrade_output}" "${api_level}" '
            "|| status=1") in inventory

    # The seed stores version 2, below the provider-wide migration (< 7), with an account that needs it.
    assert "SEEDED_VERSION = 2" in runtime and "addAccountExplicitly" in runtime
    assert '"FEATURE: the version isn\'t advanced past the unfinished migration"' in runtime
    assert '"FEATURE: the migration for versions below 10 ran"' in runtime
    assert "removeAccountExplicitly" in runtime.split("finally {", 1)[1]


def _transcript(test_class, method):
    return "\n".join([
        "INSTRUMENTATION_STATUS: class=" + test_class,
        "INSTRUMENTATION_STATUS: current=1",
        "INSTRUMENTATION_STATUS: test=" + method,
        "INSTRUMENTATION_STATUS_CODE: 1",
        "INSTRUMENTATION_STATUS: class=" + test_class,
        "INSTRUMENTATION_STATUS: test=" + method,
        "INSTRUMENTATION_STATUS_CODE: 0",
        "INSTRUMENTATION_RESULT: stream=",
        "OK (1 test)",
        "INSTRUMENTATION_CODE: -1",
        "",
    ])


def _write_all(directory, checker, skip=None):
    for step, method in checker.EXPECTED_STEPS:
        if step == skip:
            continue
        (directory / f"{step}.txt").write_text(_transcript(checker.TEST_CLASS, method), encoding="utf-8")
        (directory / f"{step}.exit").write_text("0\n", encoding="utf-8")
    (directory / "upgrade-install.exit").write_text("0\n", encoding="utf-8")
    (directory / "upgrade-before.txt").write_text("firstInstallTime=a\nlastUpdateTime=a\n", encoding="utf-8")
    (directory / "upgrade-install.txt").write_text("Performing Streamed Install\nSuccess\n", encoding="utf-8")
    (directory / "upgrade-after.txt").write_text("firstInstallTime=a\nlastUpdateTime=b\n", encoding="utf-8")
    for name in ("revoke", "grant"):
        (directory / f"{name}.txt").write_text("", encoding="utf-8")
        (directory / f"{name}.exit").write_text("0\n", encoding="utf-8")


def test_app_upgrade_boundary_checker_fails_closed(tmp_path):
    checker = _checker()

    good = tmp_path / "good"
    good.mkdir()
    _write_all(good, checker)
    assert checker.main(["checker", str(good), "36"]) == 0
    inventory = json.loads((good / checker.INVENTORY).read_text(encoding="utf-8"))
    assert inventory["outcome"] == "PASS" and inventory["upgrade"]["outcome"] == "PASS"
    assert [item["step"] for item in inventory["steps"]] == ["seed", "revoked", "check"]

    def failing(name, mutate):
        directory = tmp_path / name
        directory.mkdir()
        _write_all(directory, checker)
        mutate(directory)
        assert checker.main(["checker", str(directory), "36"]) == 1, name

    failing("missing-check", lambda d: (d / "check.txt").unlink())
    failing("failed-check", lambda d: (d / "check.txt").write_text(
        _transcript(checker.TEST_CLASS, dict(checker.EXPECTED_STEPS)["check"]).replace(
            "INSTRUMENTATION_STATUS_CODE: 0", "INSTRUMENTATION_STATUS_CODE: -2"), encoding="utf-8"))
    failing("wrong-method", lambda d: (d / "check.txt").write_text(
        _transcript(checker.TEST_CLASS, dict(checker.EXPECTED_STEPS)["seed"]), encoding="utf-8"))
    failing("install-timeout", lambda d: (d / "upgrade-install.exit").write_text("137\n", encoding="utf-8"))
    failing("install-failed", lambda d: (d / "upgrade-install.txt").write_text("Failure [X]\n", encoding="utf-8"))
    failing("fresh-install", lambda d: (d / "upgrade-after.txt").write_text(
        "firstInstallTime=b\nlastUpdateTime=b\n", encoding="utf-8"))
    failing("not-updated", lambda d: (d / "upgrade-after.txt").write_text(
        "firstInstallTime=a\nlastUpdateTime=a\n", encoding="utf-8"))
    failing("extra-file", lambda d: (d / "stray.txt").write_text("", encoding="utf-8"))
    failing("missing-revoked", lambda d: (d / "revoked.txt").unlink())
    failing("revoke-failed", lambda d: (d / "revoke.exit").write_text("255\n", encoding="utf-8"))
    failing("grant-missing", lambda d: (d / "grant.exit").unlink())
