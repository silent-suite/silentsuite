"""Static contracts for Android notification permission and posting boundaries."""

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
APP_MANIFEST = ROOT / "android/app/src/main/AndroidManifest.xml"
CERT_MANIFEST = ROOT / "android/cert4android/src/main/AndroidManifest.xml"
APP_NOTIFICATIONS = ROOT / "android/app/src/main/java/io/silentsuite/sync/utils/NotificationUtils.kt"
ACCOUNT_ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/AccountActivity.kt"
CERT_SERVICE = ROOT / "android/cert4android/src/main/java/at/bitfire/cert4android/CustomCertService.kt"
ANDROID_BUILD = ROOT / "android/build.gradle"
DESUGAR_APK_GUARD = ROOT / "android/scripts/verify-androidtest-desugar-runtime.py"
RECREATION_TEST = ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountActivityRecreationTest.kt"

# These are the only permitted boundaries that call NotificationManagerCompat.notify directly.
NOTIFY_BOUNDARIES = {
    "android/app/src/main/java/io/silentsuite/sync/utils/NotificationUtils.kt",
    "android/cert4android/src/main/java/at/bitfire/cert4android/CustomCertService.kt",
}


def _notification_manager_receivers(source: str) -> set[str]:
    """Return locally named NotificationManager/Compat values in a Kotlin source file."""
    receivers = set(re.findall(
        r"\b(?:val|var)\s+(\w+)\s*:\s*NotificationManager(?:Compat)?\b",
        source,
    ))
    receivers.update(re.findall(
        r"\b(\w+)\s*:\s*NotificationManager(?:Compat)?\b",
        source,
    ))
    receivers.update(re.findall(
        r"\b(?:val|var)\s+(\w+)\s*=\s*NotificationManagerCompat\.from\s*\(",
        source,
    ))
    receivers.update(re.findall(
        r"\b(?:val|var)\s+(\w+)\s*=.*?\bas\s+NotificationManager\b",
        source,
    ))
    return receivers


def _direct_notification_posts(source: str) -> list[str]:
    """Find direct NotificationManager/Compat notify calls, regardless of argument names."""
    receivers = _notification_manager_receivers(source)
    posts = []
    for line in source.splitlines():
        match = re.search(r"\b(\w+)\s*\.\s*notify\s*\(", line)
        if match and match.group(1) in receivers:
            posts.append(line.strip())
        if re.search(r"NotificationManagerCompat\.from\s*\(.*?\)\s*\.\s*notify\s*\(", line):
            posts.append(line.strip())
        if re.search(r"NotificationUtils\.createChannels\s*\(.*?\)\s*\.\s*notify\s*\(", line):
            posts.append(line.strip())
    return posts


def test_notification_permission_prompt_is_foreground_only_and_one_time():
    manifest = APP_MANIFEST.read_text(encoding="utf-8")
    notifications = APP_NOTIFICATIONS.read_text(encoding="utf-8")
    account_activity = ACCOUNT_ACTIVITY.read_text(encoding="utf-8")

    assert 'android.permission.POST_NOTIFICATIONS' in manifest
    assert 'Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU' in notifications
    assert 'KEY_POST_NOTIFICATIONS_REQUESTED' in notifications
    assert 'putBoolean(KEY_POST_NOTIFICATIONS_REQUESTED, true)' in notifications
    assert 'ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS)' in notifications
    assert 'outState.putBoolean(KEY_WAITING_FOR_NOTIFICATION_PERMISSION' not in account_activity
    assert 'savedInstanceState?.getBoolean(KEY_WAITING_FOR_NOTIFICATION_PERMISSION' not in account_activity
    assert 'waitingForNotificationPermissionResult = false' in account_activity
    assert 'waitingForNotificationPermissionResult = NotificationUtils.requestPermissionIfNeeded(this)' in account_activity
    assert 'if (requestCode == NotificationUtils.REQUEST_CODE_POST_NOTIFICATIONS)' in account_activity
    assert 'PermissionsActivity.requestAllPermissions(this)' in account_activity


def test_all_app_notification_posts_use_the_central_policy():
    kotlin_sources = list((ROOT / "android").rglob("*.kt"))
    direct_posts = {
        source.relative_to(ROOT).as_posix(): _direct_notification_posts(source.read_text(encoding="utf-8"))
        for source in kotlin_sources
    }
    direct_posts = {path: posts for path, posts in direct_posts.items() if posts}

    # The app helper applies the policy; cert4android owns its standalone fallback boundary.
    assert set(direct_posts) == NOTIFY_BOUNDARIES


def test_notify_audit_is_independent_of_receiver_and_argument_spellings():
    source = """
        val arbitraryManager: NotificationManagerCompat = NotificationManagerCompat.from(context)
        arbitraryManager.notify(unrelatedNotificationId, builtPayload)
    """

    assert _direct_notification_posts(source) == [
        "arbitraryManager.notify(unrelatedNotificationId, builtPayload)"
    ]


def test_cert_notification_visibility_matrix_preserves_foreground_activity_and_fails_closed_in_background():
    manifest = CERT_MANIFEST.read_text(encoding="utf-8")
    service = CERT_SERVICE.read_text(encoding="utf-8")

    assert 'android.permission.POST_NOTIFICATIONS' in manifest
    assert 'Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU' in service
    assert 'ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)' in service
    assert 'nm.areNotificationsEnabled()' in service
    assert 'getNotificationChannel(NotificationUtils.CHANNEL_CERTIFICATES)' in service
    assert 'channel.importance == NotificationManager.IMPORTANCE_NONE' in service
    assert 'catch (e: SecurityException)' in service
    assert 'onReceiveDecision(cert, false, showRejectionToast = false)' in service
    assert 'if (foreground) {' in service
    assert 'postDecisionNotification(cert, raw, decisionIntent, rejectIntent)\n                        decisionIntent.addFlags' in service
    assert '} else if (!postDecisionNotification(cert, raw, decisionIntent, rejectIntent)) {' in service
    assert 'pendingDecisions.remove(cert)?.toList().orEmpty()' in service
    assert 'nm.cancel(CertUtils.getTag(cert), Constants.NOTIFICATION_CERT_DECISION)' in service
    assert 'Received command: $intent' not in service
    assert 'io.silentsuite.sync' not in service


def test_cert_callbacks_are_atomically_detached_and_isolated():
    service = CERT_SERVICE.read_text(encoding="utf-8")

    # Registration, abort and state publication use one lock, and state is stored before
    # the callback collection is detached. Delivery is outside that lock and each receiver
    # is independently guarded, so it cannot duplicate, lose, or block another callback.
    assert 'private val decisionLock = Any()' in service
    assert 'private val pendingDecisions = HashMap<X509Certificate, MutableList<IOnCertificateDecision>>()' in service
    assert 'val callbacks = synchronized(decisionLock)' in service
    assert 'pendingDecisions.remove(cert)?.toList().orEmpty()' in service
    assert 'synchronized(decisionLock) {\n                val iterator = pendingDecisions.entries.iterator()' in service
    assert 'callbacks.forEach {\n                try {' in service
    assert 'catch (e: Exception)' in service
    assert 'pendingDecisions[cert] = mutableListOf(callback)' in service


def test_androidtest_desugar_guard_checks_the_runtime_owner_not_just_resolution():
    build = ANDROID_BUILD.read_text(encoding="utf-8")
    guard = DESUGAR_APK_GUARD.read_text(encoding="utf-8")

    assert "verifyDebugAndroidTestDesugarRuntime" in build
    assert "dependsOn(':app:packageDebugAndroidTest')" in build
    assert "verify-androidtest-desugar-runtime.py" in build
    assert 'Lj$/util/DesugarCollections;' in guard
    assert 'synchronizedMap' in guard
    assert 'class_data_off' in guard
    assert 'Collections.synchronizedMap(HashMap<String, String>())' in RECREATION_TEST.read_text(encoding="utf-8")
