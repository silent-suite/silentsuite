from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LOGIN_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup/LoginActivity.kt"
MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"
APP_GRADLE = ROOT / "android/app/build.gradle"
APP_RESOURCES = ROOT / "android/app/src/main/res"
ANDROID_BUILD_WORKFLOW = ROOT / ".github/workflows/build-android.yml"


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


def test_bundletool_uses_a_private_temporary_password_file():
    workflow = ANDROID_BUILD_WORKFLOW.read_text(encoding="utf-8")
    release_step = workflow.split(
        "      - name: Capture release dependency graph and generate signed-release splits\n",
        1,
    )[1].split("\n      - name:", 1)[0]

    assert "--ks-pass=env:" not in release_step
    assert "--key-pass=env:" not in release_step
    assert "umask 077" in release_step
    assert 'BUNDLETOOL_PASSWORD_FILE="$RUNNER_TEMP/keystore/bundletool-password"' in release_step
    assert 'printf \'%s\' "$KSTOREPWD" > "$BUNDLETOOL_PASSWORD_FILE"' in release_step
    assert "unset KSTOREPWD" in release_step
    assert '--ks-pass="file:$BUNDLETOOL_PASSWORD_FILE"' in release_step
    assert '--key-pass="file:$BUNDLETOOL_PASSWORD_FILE"' in release_step
    assert release_step.index(
        'printf \'%s\' "$KSTOREPWD" > "$BUNDLETOOL_PASSWORD_FILE"'
    ) < release_step.index("unset KSTOREPWD") < release_step.index(
        'java -jar "$RUNNER_TEMP/bundletool.jar" build-apks'
    )


def test_android_build_runs_for_dev_and_main_pull_requests():
    workflow = ANDROID_BUILD_WORKFLOW.read_text(encoding="utf-8")
    pull_request = workflow.split("  pull_request:\n", 1)[1].split(
        "  workflow_dispatch:\n", 1
    )[0]

    assert "branches: [dev, main]" in pull_request


def test_every_checked_in_android_source_set_uses_lease_scoped_setup_secrets():
    tracked = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "android/**/src/**"],
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
        "SetupSecretHolder.setLoginCredentials(credentials)",
        "SetupSecretHolder.getLoginCredentials()",
        "SetupSecretHolder.clearLoginCredentials()",
        "SetupSecretHolder.setPendingConfiguration(config)",
        "SetupSecretHolder.getPendingConfiguration()",
        "SetupSecretHolder.clearCredentialsAndConfiguration()",
    ):
        assert legacy_call not in combined


def test_account_entry_lifecycle_security_blockers_have_explicit_fail_closed_contracts():
    setup = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/setup"
    activity = (setup / "LoginActivity.kt").read_text(encoding="utf-8")
    owner = (setup / "LoginFlowOwnerRegistry.kt").read_text(encoding="utf-8")
    holder = (setup / "SetupSecretHolder.kt").read_text(encoding="utf-8")
    continuation = (setup / "SignupContinuationRegistry.kt").read_text(encoding="utf-8")
    detector = (setup / "DetectConfigurationFragment.kt").read_text(encoding="utf-8")
    creator = (setup / "CreateAccountFragment.kt").read_text(encoding="utf-8")
    credential_change = (setup / "LoginCredentialsChangeFragment.kt").read_text(encoding="utf-8")
    signup_return = (setup / "SignupReturnActivity.kt").read_text(encoding="utf-8")
    first_run_runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/setup/FirstRunSignInRuntimeTest.kt").read_text(encoding="utf-8")
    authenticator_runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/setup/AuthenticatorLifecycleRuntimeTest.kt").read_text(encoding="utf-8")

    detector_failure = detector.split("if (data == null || data.isFailed)", 1)[1].split(
        "dismissAllowingStateLoss()", 1
    )[0]
    creator_recovery = creator.split("private fun notifyRecoverableFailure", 1)[1].split(
        "private fun notifyAccountCreationFailed", 1
    )[0]
    assert "clearCredentialsAndConfiguration(currentLease)" in detector_failure
    assert "revoke(currentLease)" not in detector_failure
    assert "clearCredentialsAndConfiguration" in creator_recovery
    assert "SetupSecretHolder::revoke" not in creator_recovery

    for contract in (
        "REBIND_MILLIS", "rebindDeadline", "retireExpiredRebind", "retireWeakOwner",
        "cancelAndFinishSupersededOwner", "isExactMarker", "BrowserState",
    ):
        assert contract in owner
    assert owner.index("cancelAndFinishSupersededOwner") < owner.index("owner = fresh")
    foreground = owner.split("data class ForegroundCommand", 1)[1].split(
        "/** One process-wide weak LoginActivity owner", 1
    )[0]
    assert "EXTRA_SIGNUP_CONTINUATION_TOKEN" not in foreground
    assert "resetToCleanChoice" in owner
    assert "if (nextGeneration == Long.MAX_VALUE)" in owner
    assert "if (nextGeneration == Long.MAX_VALUE)" in holder
    assert "check(value == null || BuildConfig.DEBUG)" in holder
    assert "check(BuildConfig.DEBUG)" in holder.split("fun now(): Long", 1)[1].split("object SetupSecretHolder", 1)[0]
    assert "if (nextGeneration == Long.MAX_VALUE)" in continuation

    assert "FragmentLifecycleCallbacks" in activity
    assert "onFragmentResumed" in activity
    acknowledgement = activity.split("private fun acknowledgeSignupDestinationIfReady", 1)[1]
    assert "Lifecycle.State.RESUMED" in acknowledgement
    assert "CHOICE_TO_CREDENTIALS_BACK_STACK" in acknowledgement
    assert "SignupContinuationRegistry.markHandled" in acknowledgement
    processing = activity.split("private fun processSignupContinuation", 1)[1].split(
        "private fun acknowledgeSignupDestinationIfReady", 1
    )[0]
    assert processing.count("SignupContinuationRegistry.markHandled") == 1
    assert "LifecycleEventObserver" in activity
    assert "event == Lifecycle.Event.ON_RESUME" in activity
    assert "lifecycle.addObserver(signupResumeObserver)" in activity
    assert "savedInstanceState != null && AuthenticatorRestorePolicy.mustRestartNormally" in activity
    assert processing.index("operationOwnsPresentation") < processing.index("SignupContinuationRegistry.markHandled")
    assert "isExactMarker" in activity
    assert "KEY_NAV_DESTINATION" in activity
    assert "getBackStackEntryAt" in activity
    assert "hasValidRestoredAuthority(admission.lease)" in activity
    assert "creationId?.let(::isCanonicalCreationId) == true" in creator
    assert "hadStartedBeforeSave &&" in creator
    assert "java.util.UUID.fromString(value).toString() == value" in creator
    assert "savedInstanceState?.getBoolean(KEY_WAS_AUTHENTICATOR, false) == true ||" in activity
    assert "detector.hasValidRestoredAuthority(admission.lease)" in activity
    assert "restoredCreator.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)" in activity
    assert "recoverStalledRestoredCreator()" in activity

    for source in (holder, detector, creator, credential_change):
        assert "LEASE_REF_VERSION" in source
    assert "ARG_LEASE_VERSION" in detector
    assert "ARG_LEASE_VERSION" in creator
    assert "ARG_LEASE_VERSION" in credential_change
    assert "kind != SetupSecretHolder.LeaseKind.CREDENTIAL_CHANGE" in credential_change
    assert "retireUnboundOrRebinding" in credential_change
    assert "rejectMalformedDetector" not in detector
    assert "rejectMalformedCreator" in creator
    malformed_handlers = activity.split("internal fun rejectMalformedCreator", 1)[1].split("internal fun hasPendingAccountCreationFailure", 1)[0]
    assert malformed_handlers.count("SetupSecretHolder.clearCredentialsAndConfiguration(admission.lease)") == 1
    assert malformed_handlers.count("fragment.ownsActivePresentation(this, admission.lease)") == 1
    assert "findFragmentById(android.R.id.content) !== fragment" in malformed_handlers
    assert "supportFragmentManager.popBackStack()" in malformed_handlers
    assert "host.beginSetupOperation(admittedLease)" not in detector
    assert "host.beginSetupOperation(admittedLease)" not in creator
    assert "isAccountEntryAdmissionPublished" in activity
    assert "check(BuildConfig.DEBUG)" in activity
    assert activity.count("check(value == null || BuildConfig.DEBUG)") >= 3
    assert "obsoleteSeamsFactory?.also { check(BuildConfig.DEBUG) }" in activity
    assert "controllerFactory?.also { check(BuildConfig.DEBUG) }" in activity
    assert "afterCreationIdIssuedForTest" in creator
    assert "check(value == null || BuildConfig.DEBUG)" in creator.split("afterCreationIdIssuedForTest", 1)[1]
    assert "afterCreationIdIssuedForTest?.also { check(BuildConfig.DEBUG) }" in creator
    assert "browserLauncherForTest = null" in first_run_runtime
    assert "SignupReturnActivity::class.java" in first_run_runtime
    assert "if (executed)" in signup_return
    assert "testExecutor(result.command)" in signup_return
    assert "foregroundExecutorForTest = null" in first_run_runtime
    assert "Tokenless callback did not enter the rebind queue" in first_run_runtime
    assert "Persistent foreground failure did not recover after its deadline" in first_run_runtime
    rebind_runtime = first_run_runtime.split("val frozenNow = SetupElapsedClock.now()", 1)[1].split(
        "var deadlineRecoveryMonitor", 1
    )[0]
    assert "SetupElapsedClock.nowForTest = { frozenNow }" in rebind_runtime
    assert rebind_runtime.index("LoginFlowOwnerRegistry.release") < rebind_runtime.index(
        "LoginFlowOwnerRegistry.admit"
    )
    assert rebind_runtime.index("finishAndAwaitDestroyed") < rebind_runtime.index(
        "SetupElapsedClock.nowForTest = null"
    )
    finish_scenario = first_run_runtime.split("private fun finishScenario", 1)[1].split(
        "private fun assertTestStateEmpty", 1
    )[0]
    assert "SetupElapsedClock.nowForTest = null" in finish_scenario
    recoverable_runtime = authenticator_runtime.split(
        "fun recoverableCreationFailureRestoresCredentialsWithoutFinishingOrCancelling", 1
    )[1].split("private fun creatorGenerationReplacementRoutesToSettingsResolution", 1)[0]
    assert "CreateAccountFragment.newInstance(SetupSecretHolder.reference(lease))" in recoverable_runtime
    assert "CreateAccountFragment()," not in recoverable_runtime
    assert "Valid creator failure did not restore credentials with a bounded retry dialog" in recoverable_runtime
    assert recoverable_runtime.index("assertEquals(0, delivery.errors)") < recoverable_runtime.index(
        "finishAndAwaitDestroyed"
    )
    unknown_route = owner.split("val flowId =", 1)[1].split("val exactToken", 1)[0]
    assert "current?.state == State.REBINDING" in unknown_route
    assert "SignupRouteResult.QUEUED_REBIND(current.rebindDeadline)" in unknown_route
    assert "operationOwnsPresentation" in activity
    assert "completeSignupTransportWithoutGuidance" in activity
    assert "return Route.ROUTABLE(it.flowId)" in continuation
    assert "LoginActivity.DETECT_CONFIGURATION_TAG" in first_run_runtime
    assert "LoginCredentialsChangeFragment().apply" in first_run_runtime
    for source in (detector, creator, credential_change):
        assert "beginOperation" in source or "beginSetupOperation" in source
        assert "commitIfCurrent" in source or "commitSetupOperation" in source
