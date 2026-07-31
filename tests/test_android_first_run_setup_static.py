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


def test_drawer_uses_modern_local_icons_and_exact_generation_row_routing():
    header = source(RES / "layout/nav_header_accounts.xml")
    row = source(RES / "layout/nav_account_row.xml")
    activity = source(JAVA / "ui/AccountActivity.kt")
    active = source(JAVA / "ui/ActiveAccountManager.kt")

    assert "@android:drawable/arrow_down_float" not in header
    assert "@drawable/ic_chevron_down" in header
    assert "@android:drawable/checkbox_on_background" not in row
    assert "@drawable/ic_check" in row
    assert "<ripple" in source(RES / "drawable/nav_account_row_background.xml")
    assert (RES / "drawable/ic_chevron_down.xml").exists()
    assert '@color/semantic_on_surface' in source(RES / "drawable/ic_chevron_down.xml")
    assert (RES / "drawable/ic_check.xml").exists()
    assert "ActiveAccountManager.setActiveAccount(this, identity)" in activity
    assert "newIntent(this, acc, identity.creationId)" in activity
    assert "ExactAccountIdentity(account.type, account.name, creationId)" in activity
    assert "identity.creationId == accountCreationId" in activity
    assert "fun setActiveAccount(context: Context, identity: ExactAccountIdentity)" in active
    assert "afterExactSetCommitForTest?.invoke()" in active
    assert "clearIfActive(context, identity.name, identity.creationId)" in active
    assert "postCommitGenerationRaceFailsClosedAndClearsOnlyTheWrittenIdentity" in source(
        ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDrawerSignOutRuntimeTest.kt"
    )


def test_approved_combined_sign_in_layout_copy_typography_arrows_and_stable_ids():
    layout = source(RES / "layout/login_credentials_fragment.xml")
    strings = string_resources()
    styles = source(RES / "values/styles.xml")
    fragment = source(SETUP / "LoginCredentialsFragment.kt")

    approved = {
        "login_sign_in_title": "Set up SilentSuite",
        "login_sign_in_supporting_copy":
            "Sign in with an existing account, or create a new account on the web.",
        "login_android_apps_heading": "Works with Android apps",
        "login_calendar_outcome": "Synced events appear in Android Calendar.",
        "login_contacts_outcome": "Synced contacts appear in Android Contacts.",
        "login_tasks_outcome": "Synced tasks appear in Tasks.org or OpenTasks when installed.",
        "login_privacy_reassurance":
            "Your encryption keys stay on this device.",
        "login_sign_in_and_connect": "Sign in and set up sync",
        "login_forgot_password": "Forgot password?",
        "login_existing_account_heading": "Already have a SilentSuite account?",
        "login_existing_account_body":
            "Enter the email address and password for your existing account.",
        "login_signup_heading": "New to SilentSuite?",
        "login_signup_body":
            "We’ll open the SilentSuite website. After you create your account, "
            "you’ll return to this app to finish setup.",
        "login_signup_action": "Create an account on the web",
        "login_toggle_advanced": "Use a custom server",
    }
    assert {name: strings.get(name) for name in approved} == approved

    stable_ids = {
        "user_name", "url_password", "login_password", "forgot_password",
        "create_account", "show_advanced", "advanced_layout", "custom_server",
        "login_action_bar", "login", "login_existing_account_heading",
        "login_existing_account_body", "login_signup_heading", "login_signup_body",
        "login_signup_section", "login_scroll",
    }
    for view_id in stable_ids | {
        "login_brand_mark", "login_android_apps", "login_calendar_outcome",
        "login_contacts_outcome", "login_tasks_outcome",
    }:
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
    assert layout.count("@style/TextAppearance.AppTheme.FirstRun.Body") >= 5
    assert 'android:fontFamily="monospace"' not in layout
    assert layout.count("<com.google.android.material.button.MaterialButton") == 2
    assert 'android:text="@string/login_sign_in_and_connect"' in layout
    scroll_content, action_bar = layout.split('android:id="@+id/login_action_bar"', 1)
    assert 'android:id="@+id/forgot_password"' in scroll_content
    assert 'android:id="@+id/show_advanced"' in scroll_content
    assert 'android:id="@+id/advanced_layout"' in scroll_content
    assert 'android:id="@+id/custom_server"' in scroll_content
    assert scroll_content.index('android:id="@+id/login_signup_section"') < (
        scroll_content.index('android:id="@+id/login_existing_account_heading"')
    ) < (
        scroll_content.index('android:id="@+id/user_name"')
    )
    assert scroll_content.index('android:id="@+id/login_existing_account_body"') < (
        scroll_content.index('android:id="@+id/user_name"')
    )
    assert 'android:id="@+id/login_privacy_reassurance"' in scroll_content
    assert scroll_content.index('android:id="@+id/login_signup_heading"') < scroll_content.index(
        'android:id="@+id/login_signup_body"'
    ) < scroll_content.index('android:id="@+id/create_account"')
    assert scroll_content.index('android:id="@+id/login_privacy_reassurance"') < (
        scroll_content.index('android:id="@+id/login_android_apps"')
    )
    assert 'style="@style/Widget.AppTheme.Material3.Button.Outlined"' in scroll_content.split(
        'android:id="@+id/create_account"', 1
    )[1].split("/>", 1)[0]
    assert 'android:id="@+id/login_signup_section"' not in action_bar
    assert 'android:id="@+id/login"' in action_bar
    assert "as Button" in fragment.split("R.id.create_account", 1)[1].split("setOnClickListener", 1)[0]
    assert "Intent(Intent.ACTION_VIEW, signupUri)" in fragment
    assert "ViewCompat.setAccessibilityHeading(" in fragment
    assert "R.id.login_existing_account_heading" in fragment
    assert "R.id.login_signup_heading" in fragment
    assert "R.drawable.ic_chevron_up" in fragment
    assert "R.drawable.ic_chevron_down" in fragment
    assert "setCompoundDrawablesRelativeWithIntrinsicBounds" in fragment
    assert (RES / "drawable/ic_chevron_up.xml").exists()
    assert "?: advancedExpanded" in fragment
    manifest = source(MAIN / "AndroidManifest.xml")
    login_decl = manifest.split('android:name=".ui.setup.LoginActivity"', 1)[1].split("</activity>", 1)[0]
    assert 'android:theme="@style/AppTheme.Material3"' in login_decl


def test_setup_has_approved_stage_surface_stable_ids_and_copy():
    layout = source(RES / "layout/activity_post_login_setup.xml")
    strings = string_resources()
    styles = source(RES / "values/styles.xml")
    activity = source(SETUP / "PostLoginSetupActivity.kt")
    runtime = source(
        ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/PostLoginSetupRuntimeTest.kt"
    )

    for view_id in (
        "setup_stepper", "setup_step_connect_node", "setup_step_prepare_node",
        "setup_step_ready_node", "setup_step_connector_one", "setup_step_connector_two",
        "setup_stage_connect", "setup_stage_prepare", "setup_stage_ready",
        "setup_title", "setup_body", "setup_recommended_apps", "setup_continue_limited",
        "setup_skip_integrations", "setup_remove_incomplete",
        "setup_retry_inventory", "setup_resolve_ambiguity", "setup_done",
    ):
        assert f'android:id="@+id/{view_id}"' in layout

    approved = {
        "post_login_stage_connect": "Account",
        "post_login_stage_prepare": "Android apps",
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
        "post_login_permissions_title": "Show synced data in Android apps",
        "post_login_permissions_body":
            "Allow access so SilentSuite can keep local copies up to date on this device.",
        "post_login_calendar_outcome": "Events appear in Android Calendar.",
        "post_login_contacts_outcome": "Contacts appear in Android Contacts.",
        "post_login_tasks_outcome":
            "Tasks appear in Tasks.org or OpenTasks when a compatible app is installed.",
        "post_login_recommended_apps":
            "For recommended local Android apps, see our docs.",
        "post_login_permission_privacy":
            "These permissions apply to data on this device. Sync remains end-to-end encrypted.",
        "post_login_allow_and_continue": "Allow access and continue",
        "post_login_setup_continue": "Continue setup",
        "post_login_initial_sync_title": "Starting your first sync…",
        "post_login_ready_title": "SilentSuite is ready",
        "post_login_ready_body":
            "Your first encrypted sync has been requested and may continue in the background. "
            "Synchronized data appears in Android apps where access and a compatible app are available.",
        "post_login_open_sync_overview": "Open sync overview",
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
    assert 'android:id="@+id/setup_stepper"' in layout
    assert 'android:id="@+id/setup_action_bar"' in layout
    assert 'android:orientation="horizontal"' in layout.split(
        'android:id="@+id/setup_stepper"', 1)[1].split(">", 1)[0]
    assert 'android:gravity="center_vertical"' not in layout.split(
        'android:id="@+id/setup_content"', 1)[1].split(">", 1)[0]
    assert layout.index("</ScrollView>") < layout.index('android:id="@+id/setup_action_bar"')
    skip = layout.split('android:id="@+id/setup_skip_integrations"', 1)[1].split("/>", 1)[0]
    assert 'style="@style/Widget.AppTheme.Material3.Button.Text"' in skip
    assert styles.count('<item name="android:textColor">@color/button_secondary_text</item>') >= 2
    secondary_colors = source(RES / "color/button_secondary_text.xml")
    assert '@color/semantic_secondary_action' in secondary_colors
    assert '@color/semantic_disabled' in secondary_colors
    assert '<color name="semantic_secondary_action">#047857</color>' in source(
        RES / "values/colors.xml"
    )
    assert '@color/teal400' in source(RES / "values-night/colors.xml")
    assert 'android:maxLines="2"' not in layout
    for node_id in (
        "setup_step_connect_node", "setup_step_prepare_node", "setup_step_ready_node",
    ):
        node = layout.split(f'android:id="@+id/{node_id}"', 1)[1].split("/>", 1)[0]
        assert 'android:layout_width="wrap_content"' in node
        assert 'android:layout_height="wrap_content"' in node
        assert 'android:minWidth="32dp"' in node
        assert 'android:minHeight="32dp"' in node
    assert "internal fun configureSetupStepperForFontScale(fontScale: Float)" in activity
    assert "fontScale < 1.5f" in activity
    assert "LinearLayout.VERTICAL" in activity
    assert "configureSetupStepperForFontScale(2f)" in runtime
    assert "R.id.setup_recommended_apps" in activity
    assert "Constants.androidAppsDocsUri" in activity
    assert "WebViewActivity.openUrl" in activity
    assert "requiredViewId(activity, \"setup_recommended_apps\")" in runtime
    assert "R.drawable.bg_setup_step_complete" in activity
    assert "R.drawable.bg_setup_step_error_icon" in activity
    assert "R.drawable.ic_check_on_primary" not in activity
    complete_icon = source(RES / "drawable/bg_setup_step_complete.xml")
    assert 'android:drawable="@drawable/bg_setup_step_current"' in complete_icon
    assert 'android:drawable="@drawable/ic_check_on_primary"' in complete_icon
    assert complete_icon.count('android:left="7dp"') == 1
    assert complete_icon.count('android:top="7dp"') == 1
    assert complete_icon.count('android:right="7dp"') == 1
    assert complete_icon.count('android:bottom="7dp"') == 1
    constants = source(JAVA / "Constants.kt")
    assert 'appendEncodedPath("user-guide/apps/android")' in constants
    assert "applySetupActionBarInsets(findViewById(R.id.setup_action_bar))" in activity
    assert "WindowInsetsCompat.Type.systemBars()" in activity
    assert "basePaddingBottom + systemBars.bottom" in activity
    blocked_visibility = activity.split(
        "findViewById<Button>(R.id.setup_continue_limited).visibility", 1
    )[1].split("findViewById<Button>(R.id.setup_retry_inventory)", 1)[0]
    assert "condition != PostLoginSetupPresentationCondition.PERMISSION_BLOCKED" in blocked_visibility
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
    assert "renderSetupStepper(presentation)" in render
    assert "setup_integration_details" in render
    assert "post_login_allow_and_continue" in render
    assert "setup_action_bar" in render
    assert "actionButtons.any { it.visibility == View.VISIBLE }" in render
    assert "R.color.semantic_warning" in render
    assert "R.color.semantic_error" in render
    assert "private fun renderSetupStepper(" in activity
    assert "post_login_stepper_description" in activity
    assert "bg_setup_step_current" in activity
    assert "bg_setup_step_upcoming" in activity
    assert "bg_setup_step_error" in activity
    assert "bg_setup_step_complete" in activity
    assert "bg_setup_step_error_icon" in activity
    assert "ic_check_on_primary" in source(RES / "drawable/bg_setup_step_complete.xml")
    assert "ic_error_on_error" in source(RES / "drawable/bg_setup_step_error_icon.xml")
    assert "mutableListOf<String>()" in activity
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
