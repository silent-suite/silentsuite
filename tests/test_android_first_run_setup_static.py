"""PR2 RED contracts for Android first-run sign-in and post-login setup."""

from pathlib import Path
import re
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "android/app/src/main"
JAVA = MAIN / "java/io/silentsuite/sync"
SETUP = JAVA / "ui/setup"
RES = MAIN / "res"


def source(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def string_resources() -> dict[str, str]:
    root = ET.parse(RES / "values/strings.xml").getroot()
    return {
        node.attrib["name"]: (node.text or "").replace("\\'", "'")
        for node in root.findall("string")
    }


def test_approved_combined_sign_in_layout_copy_typography_arrows_and_stable_ids():
    layout = source(RES / "layout/login_credentials_fragment.xml")
    strings = string_resources()
    styles = source(RES / "values/styles.xml")

    approved = {
        "login_sign_in_title": "Sign in",
        "login_sign_in_supporting_copy":
            "Private, end-to-end encrypted sync for your calendars, contacts, and tasks.",
        "login_privacy_reassurance":
            "Your calendars, contacts, and tasks are encrypted before syncing. "
            "Encryption keys stay on this device.",
        "login_sign_in_and_connect": "Sign in and connect",
        "login_forgot_password": "Forgot password?",
        "login_signup_prompt": "New to SilentSuite? Create an account",
        "login_toggle_advanced": "Use a custom server",
    }
    assert {name: strings.get(name) for name in approved} == approved

    stable_ids = {
        "user_name", "url_password", "login_password", "forgot_password",
        "create_account", "show_advanced", "advanced_layout", "custom_server",
        "login_action_bar", "login",
    }
    for view_id in stable_ids | {"login_brand_mark"}:
        assert f'android:id="@+id/{view_id}"' in layout

    assert "<ImageView" in layout
    brand = layout.split('android:id="@+id/login_brand_mark"', 1)[1].split("/>", 1)[0]
    assert 'android:src="@drawable/ic_silentsuite_arrows"' in brand
    assert 'android:contentDescription="@null"' in brand
    aliases = source(RES / "values/drawables.xml")
    night_aliases = source(RES / "values-night/drawables.xml")
    assert '<item name="ic_silentsuite_arrows" type="drawable">@drawable/ic_silentsuite_arrows_on_light</item>' in aliases
    assert '<item name="ic_silentsuite_arrows" type="drawable">@drawable/ic_silentsuite_arrows_on_navy</item>' in night_aliases
    assert (RES / "drawable/ic_silentsuite_arrows_on_light.xml").exists()
    assert (RES / "drawable/ic_silentsuite_arrows_on_navy.xml").exists()

    assert '<style name="TextAppearance.AppTheme.FirstRun.Title"' in styles
    assert '<item name="android:textSize">24sp</item>' in styles
    assert '<style name="TextAppearance.AppTheme.FirstRun.Body"' in styles
    assert '<item name="android:textSize">16sp</item>' in styles
    assert layout.count("@style/TextAppearance.AppTheme.FirstRun.Title") == 1
    assert layout.count("@style/TextAppearance.AppTheme.FirstRun.Body") >= 2
    assert 'android:fontFamily="monospace"' not in layout
    assert layout.count("<com.google.android.material.button.MaterialButton") == 1
    assert 'android:text="@string/login_sign_in_and_connect"' in layout


def test_setup_has_approved_stage_surface_stable_ids_and_copy():
    layout = source(RES / "layout/activity_post_login_setup.xml")
    strings = string_resources()

    for view_id in (
        "setup_stage_connect", "setup_stage_prepare", "setup_stage_ready",
        "setup_title", "setup_body", "setup_continue_limited",
        "setup_skip_integrations", "setup_remove_incomplete",
        "setup_retry_inventory", "setup_resolve_ambiguity", "setup_done",
    ):
        assert f'android:id="@+id/{view_id}"' in layout

    approved = {
        "post_login_stage_connect": "Connect account",
        "post_login_stage_prepare": "Prepare Android sync",
        "post_login_stage_ready": "Ready",
        "post_login_creating_title": "Let's repair this setup",
        "post_login_account_created_title": "Preparing Android sync…",
        "post_login_sync_configuration_failed_title":
            "Android sync setup could not finish",
        "post_login_collections_title":
            "Preparing your encrypted collections…",
        "post_login_collections_failed_title":
            "Collections could not be prepared",
        "post_login_permissions_loading_title":
            "Checking Android integrations…",
        "post_login_permissions_title": "Connect to Android apps",
        "post_login_initial_sync_title": "Starting your first sync…",
        "post_login_ready_title": "You're ready",
        "post_login_complete_title": "Opening sync overview…",
        "post_login_permission_denied_title": "Android access wasn't allowed",
        "post_login_permission_blocked_title":
            "Allow access in Android settings",
        "post_login_skip_for_now": "Skip for now",
        "post_login_no_task_provider":
            "Android has no built-in task provider. Install Tasks.org or "
            "OpenTasks later to sync tasks on this device.",
    }
    assert {name: strings.get(name) for name in approved} == approved
    assert "Setup: %1$s" not in strings.values()
    assert not any(value in {state for state in (
        "CREATING", "ACCOUNT_CREATED", "COLLECTIONS", "PERMISSIONS",
        "INITIAL_SYNC", "READY", "COMPLETE", "RECOVERY_REQUIRED",
    )} for value in strings.values())


def test_setup_presentation_and_orchestration_are_pure_and_render_has_no_effects():
    presentation = source(SETUP / "PostLoginSetupPresentation.kt")
    orchestrator = source(SETUP / "PostLoginSetupOrchestrator.kt")
    activity = source(SETUP / "PostLoginSetupActivity.kt")

    assert "data class PostLoginSetupPresentation(" in presentation
    assert "fun presentationFor(" in presentation
    assert "android." not in presentation
    assert "androidx." not in presentation
    assert "android." not in orchestrator
    assert "androidx." not in orchestrator

    render = activity.split("private fun render(", 1)[1].split(
        "\n    private fun", 1
    )[0]
    assert "presentationFor(" in render
    assert "setup_title" in render
    assert "setup_body" in render
    for forbidden in (
        "writeSetupState", "writeVerified", "requestSync(",
        "requestPermissions(", "inventoryAndCreate(", "configure(",
        "startActivity(", "finish()",
    ):
        assert forbidden not in render


def test_account_settings_owns_a_bounded_verified_initial_sync_request_marker():
    settings = source(JAVA / "AccountSettings.kt")

    assert (
        'const val KEY_INITIAL_SYNC_REQUEST_ID = '
        '"post_login_initial_sync_request_id_v1"'
    ) in settings
    assert "private const val MAX_INITIAL_SYNC_REQUEST_ID_LENGTH = 128" in settings
    assert "fun initialSyncRequestId(" in settings
    assert "fun writeInitialSyncRequestId(" in settings
    assert "fun clearInitialSyncRequestId(" in settings
    assert "requestId.length in 1..MAX_INITIAL_SYNC_REQUEST_ID_LENGTH" in settings
    assert "writeVerified(accountManager, account, KEY_INITIAL_SYNC_REQUEST_ID" in settings
    assert "accountManager.getUserData(account, KEY_INITIAL_SYNC_REQUEST_ID)" in settings
    clear_marker = settings.split("fun clearInitialSyncRequestId(", 1)[1].split(
        "\n        fun ", 1
    )[0]
    assert "expectedRequestId: String" in clear_marker
    assert "initialSyncRequestId(accountManager, account) != expectedRequestId" in clear_marker
    assert "KEY_INITIAL_SYNC_REQUEST_ID, null" in clear_marker


def test_account_settings_owns_only_bounded_returned_permission_denials():
    settings = source(JAVA / "AccountSettings.kt")
    activity = source(SETUP / "PostLoginSetupActivity.kt")

    assert (
        'const val KEY_CONTEXTUAL_PERMISSION_DENIALS = '
        '"post_login_contextual_permission_denials_v1"'
    ) in settings
    assert "fun contextualPermissionDenials(" in settings
    assert "fun writeContextualPermissionDenials(" in settings
    for integration in ("CALENDAR", "CONTACTS", "TASKS"):
        assert f'"{integration}"' in settings
    assert "recordReturnedPermissionEvidence" in activity
    assert "AccountSettings.contextualPermissionDenials(" in activity
    assert "AccountSettings.writeContextualPermissionDenials(" in activity
    callback = activity.split("private val permissionLauncher", 1)[1].split(
        "override fun onCreate", 1
    )[0]
    assert ") { results ->" in callback
    assert "results.filterKeys" in callback
    assert "returnedPermissionEvidence(" in callback
    assert "expectedPermissions.filter(::permissionGranted)" in callback
    assert "launched.isEmpty()" not in callback
    empty_result = callback.split("if (returned.isEmpty())", 1)[1].split(
        "model.recordReturnedPermissionEvidence", 1
    )[0]
    assert "model.clearPermissionLaunchWithoutResult()" in empty_result
    assert "model.clearUserDecision()" in empty_result
    assert "render()" in empty_result
    assert callback.index("recordReturnedPermissionEvidence") < callback.index(
        "persistReturnedPermissionDenials"
    )
    persistence = activity.split("private fun persistReturnedPermissionDenials(", 1)[1].split(
        "private fun activeIntegrations", 1
    )[0]
    assert "AccountSettings.writeContextualPermissionDenials(" in persistence
    launch = activity.split("private fun requestPermissions(", 1)[1].split(
        "private fun permissionEvidence", 1
    )[0]
    assert "writeContextualPermissionDenials" not in launch


def test_setup_prepares_reuses_and_dispatches_the_exact_explicit_request_id():
    settings = source(JAVA / "AccountSettings.kt")
    request = source(JAVA / "syncadapter/RequestSync.kt")
    activity = source(SETUP / "PostLoginSetupActivity.kt")

    assert "explicitRequestId: String? = null" in request
    assert "val requestId = explicitRequestId ?: UUID.randomUUID().toString()" in request
    assert "AccountSettings.initialSyncRequestId(" in activity
    assert "AccountSettings.writeInitialSyncRequestId(" in activity
    assert "AccountSettings.clearInitialSyncRequestId(" in activity
    assert "UUID.randomUUID().toString()" in activity
    assert (
        "requestSync(applicationContext, account, "
        "explicitRequestId = requestId)"
    ) in re.sub(r"\s+", " ", activity)
    assert activity.count("requestSync(") == activity.count(
        "explicitRequestId = requestId"
    )
    assert "KEY_INITIAL_SYNC_REQUEST_ID" in settings


def test_no_network_dashboard_runtime_uses_a_bounded_exact_account_loader():
    runtime = source(
        ROOT
        / "android/app/src/androidTest/java/io/silentsuite/sync/ui/"
        "PostLoginSetupRuntimeTest.kt"
    )
    contract = runtime.split(
        "@Test fun noNetworkDashboardShellRoutesExactAccountAfterReadyDone()", 1
    )[1].split("@Test fun everyDurableSetupStateColdRenders", 1)[0]

    assert "AccountInfoViewModel.accountLoaderOverride" in contract
    assert "check(exact == target)" in contract
    assert 'check(creationId == "target-generation")' in contract
    assert "AccountInfoViewModel.accountLoaderOverride = null" in contract
    assert ".filterIsInstance<AccountActivity>()" in contract
    assert '"notification_permissions"' in contract
    assert '"post_notifications_requested"' in contract
    assert "notificationRequestMarker" in contract
    assert "previousPermissionRequestOverride" in contract
    assert "AccountActivity.permissionRequestOverride = { activity ->" in contract
    assert "assertEquals(1, dashboardPermissionRequests)" in contract
    assert (
        "AccountActivity.permissionRequestOverride = previousPermissionRequestOverride"
        in contract
    )
    assert "notificationRestore.remove(" in contract
    assert "notificationRestore.putBoolean(" in contract
    assert "val notificationRestored = notificationRestore.commit()" in contract
    assert contract.index("AndroidCompat.removeAccount") < contract.index(
        "check(notificationRestored)"
    )
    notification_utils = source(JAVA / "utils/NotificationUtils.kt")
    assert 'PREFERENCES = "notification_permissions"' in notification_utils
    assert (
        'KEY_POST_NOTIFICATIONS_REQUESTED = "post_notifications_requested"'
        in notification_utils
    )


def test_setup_durable_evidence_contains_no_secrets_or_secret_extras():
    durable = "\n".join(source(path) for path in (
        SETUP / "PostLoginSetupState.kt",
        SETUP / "PostLoginSetupOrchestrator.kt",
        SETUP / "PostLoginSetupPresentation.kt",
    )).lower()
    activity = source(SETUP / "PostLoginSetupActivity.kt")

    for secret in ("password", "credential", "session", "auth_token", "authtoken"):
        assert secret not in durable
    assert not re.search(
        r"putExtra\([^\n]*(password|credential|session|auth.?token)",
        activity,
        re.IGNORECASE,
    )
    assert "SetupSecretHolder" not in activity


def test_creation_coordinator_and_authenticator_delivery_boundaries_are_retained():
    create = source(SETUP / "CreateAccountFragment.kt")
    login = source(SETUP / "LoginActivity.kt")
    setup = source(SETUP / "PostLoginSetupActivity.kt")
    orchestrator = source(SETUP / "PostLoginSetupOrchestrator.kt")

    assert "AccountCreationCoordinator(" in create
    assert "AuthenticatorResponseController" in login
    assert "AccountCreationCoordinator" not in setup
    assert "AuthenticatorResponseController" not in setup
    assert "AccountCreationCoordinator" not in orchestrator
    assert "AuthenticatorResponseController" not in orchestrator
