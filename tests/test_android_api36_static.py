"""Dependency-free contracts for the Android 16 / API 36 migration."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_BUILD = ROOT / "android/app/build.gradle"
WEBVIEW = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/WebViewActivity.kt"
IMPORT = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/importlocal/ImportActivity.kt"
RUNTIME = ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/SiblingRoutesRuntimeTest.kt"
DRAWER_RUNTIME = ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDrawerSignOutRuntimeTest.kt"
WORKFLOW = ROOT / ".github/workflows/build-android.yml"


def test_final_app_targets_api_36_without_changing_the_api_21_floor():
    app_build = APP_BUILD.read_text(encoding="utf-8")

    assert "minSdkVersion 21" in app_build
    assert "targetSdkVersion 36" in app_build
    assert "targetSdkVersion 35" not in app_build


def test_affected_activities_use_dispatcher_back_not_legacy_key_events():
    webview = WEBVIEW.read_text(encoding="utf-8")
    import_activity = IMPORT.read_text(encoding="utf-8")

    for source in (webview, import_activity):
        assert "KeyEvent" not in source
        assert "onKeyDown(" not in source
        assert "OnBackPressedCallback" in source
        assert "onBackPressedDispatcher.addCallback(this" in source

    assert "mWebView!!.canGoBack()" in webview
    assert "mWebView!!.goBack()" in webview
    assert "isEnabled = false" in webview
    assert "onBackPressedDispatcher.onBackPressed()" in webview
    assert "popBackStack()" in import_activity


def test_debug_only_local_webview_initial_content_keeps_production_allowlisting():
    webview = WEBVIEW.read_text(encoding="utf-8")

    assert "EXTRA_DEBUG_INITIAL_HTML" in webview
    assert "BuildConfig.DEBUG" in webview
    assert "intent.getStringExtra(EXTRA_DEBUG_INITIAL_HTML)" in webview
    assert "loadDataWithBaseURL" in webview
    assert "debugWebViewClientOverride" in webview
    assert "Constants.faqUri" in webview
    assert "Constants.helpUri" in webview
    assert "Constants.registrationUrl" in webview
    assert "private fun isAllowedUrl(uri: Uri)" in webview
    assert "uri.host == accountsUri.host" in webview


def test_runtime_sources_characterize_dispatcher_toolbar_and_system_back_routes():
    runtime = RUNTIME.read_text(encoding="utf-8")
    drawer_runtime = DRAWER_RUNTIME.read_text(encoding="utf-8")

    for method in (
        "importDispatcherBackPopsNestedStackThenFinishesWithCanceledResult",
        "importToolbarUpPopsNestedStackThenFinishesWithCanceledResult",
        "importSystemBackPopsNestedStackThenFinishesWithCanceledResult",
        "webViewDispatcherBackConsumesLocalHistoryThenFinishes",
        "webViewToolbarUpFinishesInsteadOfTraversingLocalHistory",
        "webViewSystemBackConsumesLocalHistoryThenFinishes",
    ):
        assert f"fun {method}()" in runtime
    assert "UiDevice.getInstance" in runtime
    assert runtime.count("pressBack()") >= 2
    assert "onBackPressedDispatcher.onBackPressed()" in runtime
    assert "onOptionsItemSelected(MenuBuilder" in runtime
    assert "WebViewActivity.EXTRA_DEBUG_INITIAL_HTML" in runtime
    assert "WebViewActivity.debugWebViewClientOverride" in runtime
    assert "val calendarPermissionRule: GrantPermissionRule = GrantPermissionRule.grant(" in runtime
    assert "Manifest.permission.READ_CALENDAR" in runtime
    assert "Manifest.permission.WRITE_CALENDAR" in runtime
    assert "private fun grantCalendarPermissions" not in runtime
    assert "assertTrue(UiDevice" not in runtime
    assert "fun systemBackClosesDrawerWithoutFinishing()" in drawer_runtime
    assert "UiDevice.getInstance" in drawer_runtime
    assert "pressBack()" in drawer_runtime
    drawer_system_back = drawer_runtime.split("fun systemBackClosesDrawerWithoutFinishing()", 1)[1].split(
        "@Test fun delayedRemovalFailureSurvivesRecreationAndDuplicateTapStartsOnce", 1
    )[0]
    assert "assertTrue(UiDevice" not in drawer_system_back
    assert 'val replacementGeneration = "replacement-successor-generation"' in drawer_runtime
    assert "assertNotEquals(fixture.creationId, replacementGeneration)" in drawer_runtime


def test_unsigned_apk_sdk_inspection_uses_pinned_build_tools_aapt():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    unsigned_build = workflow.split("  build-pr:", 1)[1].split("  account-recreation-runtime:", 1)[0]

    assert "ANDROID_BUILD_TOOLS_VERSION: '36.0.0'" in unsigned_build
    assert '"$ANDROID_HOME/build-tools/$ANDROID_BUILD_TOOLS_VERSION/aapt"' in unsigned_build
    assert 'aapt dump badging' not in unsigned_build  # command is invoked through the pinned path
    assert '"$aapt" dump badging "$apk"' in unsigned_build
    assert "sdkVersion:'21'" in unsigned_build
    assert "targetSdkVersion:'36'" in unsigned_build
    assert 'grep -Fxc "sdkVersion:' in unsigned_build
    assert 'grep -Fxc "targetSdkVersion:' in unsigned_build
    assert "debug_apks=(app/build/outputs/apk/debug/*.apk)" in unsigned_build
    assert "release_apks=(app/build/outputs/apk/release/*.apk)" in unsigned_build
    assert "${#debug_apks[@]} -eq 1" in unsigned_build
    assert "${#release_apks[@]} -eq 1" in unsigned_build
