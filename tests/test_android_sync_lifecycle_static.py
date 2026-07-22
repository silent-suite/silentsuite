"""Static contracts for the privacy-bounded Android sync lifecycle store."""

from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/SyncStatusStore.kt"
REQUEST = ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/RequestSync.kt"
ADAPTER = ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/SyncAdapterService.kt"
ADDRESS_BOOKS = ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/AddressBooksSyncAdapterService.kt"
ACTIVITY = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/AccountActivity.kt"
REDUCER = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/account/AccountDashboardState.kt"
WINDOWS = ROOT / "android/app/src/main/java/io/silentsuite/sync/ui/account/SyncLifecycleWindows.kt"
WORKFLOW = ROOT / ".github/workflows/build-android.yml"
FROZEN_V1 = ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/FrozenBaselineV1StatusReader.kt"


def test_v2_lifecycle_contract_uses_separate_keys_and_frozen_v1_shadows():
    source = STORE.read_text(encoding="utf-8")

    assert '"sync_status_v1"' in source
    assert '"status_v2.$identity.${service.name}"' in source
    assert '"status.$identity.${service.name}"' in source
    assert "INTERRUPTED" in source
    assert "interrupted -> FailureCategory.UNKNOWN" in source
    assert "fun recordRequested(" in source
    assert "fun beginAttempt(" in source
    assert "enum class MutationResult { RECORDED, REJECTED, STORAGE_FAILURE }" in source
    assert "fun finishWithoutOutcomeResult(" in source
    assert "fun recordSuccessResult(" in source
    assert "fun recordFailureResult(" in source
    assert "fun expireStale(" in source
    assert "fun rebaseFutureLifecycle(" in source
    assert "removeBothFaultSentinels" in source
    assert "structuralStorageFailure" in source
    assert "fun status(identity: MainIdentity" in source
    assert "fun expireStale(identity: MainIdentity" in source
    assert "fun rebaseFutureLifecycle(identity: MainIdentity" in source
    assert "status_v2" in source and "fault.status_v2" in source
    assert "SQLite" not in source
    assert "Room" not in source
    assert "ChildResult.SKIPPED" in source
    assert "readLegacyContacts" in source
    assert "contacts.hasEvidence" in source


def test_product_interruption_window_is_owned_without_android_initialization():
    source = WINDOWS.read_text(encoding="utf-8")

    assert "const val DEFAULT_INTERRUPTION_AFTER_MILLIS = 30L * 60L * 1000L" in source
    assert "io.silentsuite.sync.Constants" not in source
    assert "android." not in source


def test_request_evidence_precedes_platform_dispatch_without_sensitive_logging():
    source = REQUEST.read_text(encoding="utf-8")

    assert "recordRequested" in source
    assert source.index("recordRequested") < source.index("ContentResolver.requestSync")
    assert "EXTRA_SYNC_REQUEST_ID" in source
    assert "Logger" not in source
    assert "println" not in source


def test_attempt_admission_is_correlation_bound_for_every_adapter_outcome():
    source = ADAPTER.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")

    assert "beginAttemptResult(account, outcomeService" in source
    assert "admission != SyncStatusStore.MutationResult.REJECTED" in source
    assert "recordSuccessResult(account, service, attemptId, syncRequestId(extras)" in source
    assert "recordFailureResult(account, service, attemptId, syncRequestId(extras)" in source
    assert "write() == SyncStatusStore.MutationResult.STORAGE_FAILURE" in source
    assert "else store.recordSuccess" not in source
    assert "else store.recordFailure" not in source
    assert "CompletedOutcome.CANCELLED -> finishWithoutOutcome()" in source
    assert "mutation == SyncStatusStore.MutationResult.STORAGE_FAILURE" in source
    assert "val attemptId = syncAttempt(extras) ?: return SyncStatusStore.MutationResult.REJECTED" in address_books
    assert "failContactsParentResult(account, attemptId, syncRequestId(extras), safeCategory)" in address_books
    assert "ChildResult.SKIPPED" in (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/ContactsSyncAdapterService.kt").read_text(encoding="utf-8")


def test_contacts_child_cleanup_snapshots_identity_and_signals_retry_on_every_failed_close():
    store = STORE.read_text(encoding="utf-8")
    adapter = ADAPTER.read_text(encoding="utf-8")
    contacts = (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/ContactsSyncAdapterService.kt").read_text(encoding="utf-8")
    address_book = (ROOT / "android/app/src/main/java/io/silentsuite/sync/resource/LocalAddressBook.kt").read_text(encoding="utf-8")

    assert "fun recordContactsChildRemoved(identity: MainIdentity" in store
    assert "recordContactsChild(identity.storageKey, attempt" in store
    assert "persistStatus(syncResult) { finishWithoutOutcome(account, extras) }" in adapter
    assert "finishWithoutOutcomeAtAdapterBoundary" in adapter
    assert "USER_DATA_MAIN_ACCOUNT_IDENTITY" in address_book
    assert "USER_DATA_MAIN_ACCOUNT_CREATION_ID" not in address_book
    assert "val capturedIdentity = statusStore.identityFromStorageKey(" in address_book
    assert "if (capturedIdentity != null)" in address_book
    assert "recordContactsChildRemoved(capturedIdentity, child)" in address_book
    assert "mainGenerationStillCurrent" in address_book
    assert "statusStore.identity(candidate) == capturedIdentity" in address_book
    assert "recordContactsChildRemoved(statusStore.identity(main)" not in address_book
    child_boundary = contacts.split("internal fun recordContactsChildAtAdapterBoundary", 1)[1].split("internal fun putContactsAttempt", 1)[0]
    assert "SyncStatusStore.MutationResult" in child_boundary
    assert "ChildWrite.REJECTED -> SyncStatusStore.MutationResult.REJECTED" in child_boundary
    assert "ChildWrite.STORAGE_FAILURE -> SyncStatusStore.MutationResult.STORAGE_FAILURE" in child_boundary


def test_address_book_child_persists_only_hashed_parent_generation_on_creation_and_reassignment():
    source = (ROOT / "android/app/src/main/java/io/silentsuite/sync/resource/LocalAddressBook.kt").read_text(encoding="utf-8")
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDrawerSignOutRuntimeTest.kt").read_text(encoding="utf-8")

    assert "fun initialUserData(mainAccount: Account, mainIdentity: SyncStatusStore.MainIdentity, url: String)" in source
    assert "require(SyncStatusStore.identityFromStorageKey(storageKey) != null)" in source
    assert "bundle.putString(USER_DATA_MAIN_ACCOUNT_IDENTITY, storageKey)" in source
    assert "USER_DATA_MAIN_ACCOUNT_CREATION_ID" not in source
    assert "bundle.putString(USER_DATA_MAIN_ACCOUNT_IDENTITY, mainCreationId)" not in source
    assert "getUserData(mainAccount, AccountSettings.KEY_CREATION_ID)" in source
    assert "?.takeIf { it.isNotBlank() }" in source
    assert "setUserData(account, USER_DATA_MAIN_ACCOUNT_IDENTITY, mainIdentity.storageKey)" in source
    assert "setUserData(account, USER_DATA_MAIN_ACCOUNT_IDENTITY, creationId)" not in source
    assert "LocalAddressBook.initialUserData(target.account, SyncStatusStore(target.context).identity(target.account)," in runtime


def test_address_book_child_identity_missing_or_malformed_fails_closed_and_replacement_cannot_fallback():
    store = STORE.read_text(encoding="utf-8")
    source = (ROOT / "android/app/src/main/java/io/silentsuite/sync/resource/LocalAddressBook.kt").read_text(encoding="utf-8")

    assert "identityFromStorageKey(storageKey: String?): MainIdentity?" in store
    assert "storageKey?.takeIf(::isSha256Id)?.let(::MainIdentity)" in store
    assert "val capturedIdentity = statusStore.identityFromStorageKey(" in source
    removal = source.split("val recordConfirmedRemoval =", 1)[1].split('@Suppress("DEPRECATION")', 1)[0]
    assert "if (capturedIdentity != null)" in removal
    assert "recordContactsChildRemoved" not in removal.split("if (capturedIdentity != null)", 1)[0]
    assert "ContentResolver.requestSync" not in removal.split("if (capturedIdentity != null)", 1)[0]
    assert "statusStore.identity(candidate) == capturedIdentity" in removal


def test_node_security_floor_matches_manifest_docs_and_sharp_lock_requirement():
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
    docs = [
        ROOT / "docs/contributing/dev-setup.md",
        ROOT / "apps/docs/contributing/dev-setup.md",
    ]

    assert manifest["engines"]["node"] == ">=20.9.0"
    assert all("| **Node.js** | 20.9+ |" in path.read_text(encoding="utf-8") for path in docs)
    sharp = re.search(r"sharp@0\.35\.0:.*?engines: \{node: '([^']+)'\}", lock, re.DOTALL)
    assert sharp and sharp.group(1) == ">=20.9.0"


def test_compile_and_contacts_evidence_failures_do_not_block_real_children():
    store = STORE.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")
    activity = ACTIVITY.read_text(encoding="utf-8")

    child_writer = store.split("private fun recordContactsChild", 1)[1].split("@Synchronized", 1)[0]
    lifecycle_finisher = store.split("private fun finishWithoutOutcome", 1)[1].split("@Synchronized", 1)[0]
    assert "return@synchronized" not in child_writer
    assert "return@synchronized" not in lifecycle_finisher
    assert ".status?." in activity
    dispatch = address_books.split("val childAccounts", 1)[1]
    before_children, _ = dispatch.split("for (addressBookAccount in childAccounts)", 1)
    assert "return Completion.DISPATCHED" not in before_children
    assert "syncResult.stats.numIoExceptions++" in before_children
    assert "if (attemptId == null)" in before_children
    assert "attemptId?.let { putContactsAttempt(syncExtras, it) }" in address_books


def test_contacts_parent_precedes_admission_and_identity_maintenance_is_snapshot_bound():
    adapter = ADAPTER.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")
    activity = ACTIVITY.read_text(encoding="utf-8")

    assert "service == SyncStatusStore.Service.CONTACTS" in adapter
    assert "putContactsAttempt(extras, attemptId)" in adapter
    assert "attachContactsChildren" in address_books
    assert activity.index("for (addrBookAccount") < activity.index("lifecycleStatus(statusStore, SyncStatusStore.Service.CONTACTS")
    assert "statusIdentity = SyncStatusStore(context).identity(account, creationId)" in activity
    assert "store.rebaseFutureLifecycle(statusIdentity" in activity
    assert "saturatingAdd" in activity
    assert activity.index("maintainLifecycle()") < activity.index("accountLoaderOverride?.let")
    assert "scheduleLifecycleDeadlineFromStore" in activity


def test_failed_contacts_admission_is_repaired_before_real_children_complete():
    store = STORE.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")

    attachment = store.split("private fun attachContactsChildren", 1)[1].split("@Synchronized", 1)[0]
    assert "repairingFailedAdmission" in attachment
    assert "hasLifecycleFault(identity, Service.CONTACTS)" in attachment
    assert "current.attemptId == null" in attachment
    assert "attemptId = attemptId" in attachment
    assert "contacts = ContactsGeneration(expected)" in attachment
    assert "signalPersistenceRetry(syncResult)" in address_books
    assert "for (addressBookAccount in childAccounts)" in address_books


def test_dashboard_uses_every_exact_approved_pr1_copy_string():
    strings = (ROOT / "android/app/src/main/res/values/strings.xml").read_text(encoding="utf-8")
    activity = ACTIVITY.read_text(encoding="utf-8")
    exact = (
        "Checking sync status…", "Syncing…", "First sync pending", "Up to date",
        "Sync now", "Turn on sync", "Allow access", "Learn about task apps", "Review setup",
        "%1$s is syncing.", "%1$s are syncing.",
    )
    for approved in exact:
        assert approved in strings
    stale = (
        ">Checking sync status<", ">Syncing<", ">Never synced<", ">Enable sync<",
        ">Fix permissions<", ">Install task app<", ">Review collections<",
    )
    for old in stale:
        assert old not in strings
    assert "dashboardActiveServicesDetail" in activity
    assert "AccountDashboardState.RUNNING" in activity

    root = ET.parse(ROOT / "android/app/src/main/res/values/strings.xml").getroot()
    resources = {node.attrib["name"]: (node.text or "").replace("\\'", "'") for node in root.findall("string")}
    approved = {
        "dashboard_status_checking": "Checking sync status…",
        "dashboard_detail_checking": "Reading Android's latest sync evidence.",
        "dashboard_status_requested": "Sync requested",
        "dashboard_detail_requested": "Waiting for Android to start.",
        "dashboard_status_queued": "Sync queued",
        "dashboard_detail_queued": "Android is waiting to run it.",
        "dashboard_status_syncing": "Syncing…",
        "dashboard_status_settling": "Finishing sync…",
        "dashboard_detail_settling": "Android is completing the latest work.",
        "dashboard_status_synced": "Up to date",
        "dashboard_detail_synced": "Last synced %1$s.",
        "dashboard_status_never_synced": "First sync pending",
        "dashboard_detail_never_synced": "No completed sync yet.",
        "dashboard_status_setup_needed": "Finish setup",
        "dashboard_detail_setup": "Review this account's collections and Android integrations.",
        "dashboard_status_paused": "Android sync is paused",
        "dashboard_detail_paused": "Turn on Android system sync to continue.",
        "dashboard_status_permission_needed": "Permission needed",
        "dashboard_status_task_app_needed": "Task app needed",
        "dashboard_detail_task_provider": "Install Tasks.org or OpenTasks to sync tasks on this device.",
        "dashboard_status_authentication": "Sign in again",
        "dashboard_detail_authentication": "This account couldn't authenticate. Open account settings or sign out and sign in again.",
        "dashboard_status_configuration": "Review sync settings",
        "dashboard_detail_configuration": "Android sync configuration is incomplete for this service.",
        "dashboard_status_interrupted": "Sync was interrupted",
        "dashboard_detail_interrupted": "Android didn't finish the latest request.",
        "dashboard_status_network": "Couldn't reach the service",
        "dashboard_detail_network": "SilentSuite will retry when a connection is available.",
        "dashboard_status_provider": "Android provider couldn't sync",
        "dashboard_status_storage": "Local sync storage couldn't update",
        "dashboard_detail_storage": "Check device storage, then try again.",
        "dashboard_status_parent_refresh": "Contacts couldn't refresh",
        "dashboard_detail_parent_refresh": "SilentSuite will retry the Contacts collection check.",
        "dashboard_status_child_removed": "Contacts changed during sync",
        "dashboard_detail_child_removed": "Run sync again to reconcile the latest address books.",
        "dashboard_status_unknown": "Sync didn't finish",
        "dashboard_detail_unknown": "Try again. If it continues, review Help & about.",
        "dashboard_status_mixed": "Some services didn't sync",
        "account_synchronize_now": "Sync now",
        "dashboard_retry_sync": "Try again",
        "dashboard_enable_sync": "Turn on sync",
        "dashboard_fix_permissions": "Allow access",
        "dashboard_install_task_app": "Learn about task apps",
        "dashboard_review_setup": "Review setup",
        "dashboard_open_account_settings": "Open account settings",
        "dashboard_open_sync_settings": "Open sync settings",
    }
    assert {name: resources[name] for name in approved} == approved


def test_reducer_honors_explicit_terminal_results_and_secondary_issues():
    source = REDUCER.read_text(encoding="utf-8")

    assert "lastTerminalResult" in source
    assert "structuralStorageFailure" in source
    assert "FailureCategory.PROVIDER ->" in source
    assert "OPEN_ACCOUNT_SETTINGS" in source
    assert "OPEN_SYNC_SETTINGS" in source
    assert "AccountDashboardState.BLOCKED" in source
    assert "services.withIndex()" in source
    assert ".take(1)" not in source
    assert "actionIssueRank" in source
    assert "model.secondaryIssues.map { it.category }.distinct().size > 1" in source
    assert source.index("AccountDashboardState.SETUP_REQUIRED") < source.index("FailureCategory.AUTHENTICATION")


def test_compile_sensitive_lifecycle_results_and_nullable_status_are_explicit():
    store = STORE.read_text(encoding="utf-8")
    reducer = REDUCER.read_text(encoding="utf-8")

    child_writer = store.split("private fun recordContactsChild(", 1)[1].split("@Synchronized", 1)[0]
    finish_writer = store.split("private fun finishWithoutOutcomeResult(", 1)[1].split("@Synchronized", 1)[0]
    assert "return if (written) ChildWrite.RECORDED else ChildWrite.STORAGE_FAILURE" in child_writer
    assert "return commitLifecycleResult(" in finish_writer
    for category in ("AUTHENTICATION", "PERMISSION", "CONFIGURATION"):
        assert ("status != null && latestIsFailure(status) && status.lastFailureCategory == "
                f"SyncStatusStore.FailureCategory.{category}") in reducer
    assert "status!!" not in reducer


def test_frozen_baseline_reader_and_matrix_regressions_are_present():
    frozen = FROZEN_V1.read_text(encoding="utf-8")
    tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/SyncStatusStoreTest.kt").read_text(encoding="utf-8")

    assert "Frozen d357c52 v1 read path" in frozen
    assert "fun readContacts" in frozen
    assert "fun decodeFault" in frozen
    assert "failureTimestampFor" in frozen
    assert "MAX_FUTURE_SKEW_MILLIS" in frozen
    assert "incomplete = incomplete || contacts" in frozen
    assert "persistFaults" in (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/SyncStatusStore.kt").read_text(encoding="utf-8")
    for name in ("failed request is repaired", "background success and failure", "contacts skipped children",
                  "frozen v1 reader", "confirmed child removal snapshots", "excludes every prohibited"):
        assert name in tests


def test_v2_terminal_timestamps_remain_exact_while_v1_shadows_stay_ordered():
    source = STORE.read_text(encoding="utf-8")
    tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/SyncStatusStoreTest.kt").read_text(encoding="utf-8")
    terminal_writer = source.split("private fun recordTerminal", 1)[1].split("private fun commitTerminal", 1)[0]

    assert "val at = timestamp" in terminal_writer
    assert "saturatingOrderedAfter" not in terminal_writer
    assert "private fun Outcome.latestTimestamp()" in source
    assert "private fun shadowAt" in source
    assert "saturatingOrderedAfter(candidate" in source
    assert "v2 terminal timestamps stay exact" in tests
    assert "legacy epoch zero stays a terminal" in tests


def test_v2_validation_rejects_impossible_private_lifecycle_records():
    source = STORE.read_text(encoding="utf-8")
    tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/SyncStatusStoreTest.kt").read_text(encoding="utf-8")

    assert "isSafeOpaqueId" in source
    assert "isSha256Id" in source
    assert "attemptRequest != null && attemptId == null" in source
    assert "contacts.isFullyTerminal()" in source
    assert "isValidChildResultCategory" in source
    assert "it == '.' || it == '_' || it == '-'" in source
    assert "v2 rejects impossible lifecycle opaque identifiers" in tests
    assert "writers reject unsafe opaque IDs" in tests
    assert "request|delimiter" in tests
    assert "attempt;delimiter" in tests


def test_five_runtime_methods_appear_once_in_the_exact_workflow_ledger():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    methods = (
        "SyncStatusRuntimeTest.v1EvidenceReadsCompatiblyAndV2MutationStaysExactAndPrivate",
        "SyncStatusRuntimeTest.manualRequestPersistsBeforeDispatchAndMatchingTerminalClearsLifecycle",
        "AccountDashboardRuntimeTest.requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention",
        "AccountDashboardRuntimeTest.mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue",
        "AccountDashboardRuntimeTest.futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent",
    )
    for method in methods:
        class_name, method_name = method.split(".")
        assert workflow.count(f"'{method_name}'") == 1
        assert workflow.count(class_name) >= 1


def test_no_event_runtime_boundary_uses_viewmodel_maintenance_not_direct_expiry():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    method = runtime.split("@Test fun futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent()", 1)[1]
    method = method.split("private val generation", 1)[0]

    assert "beforeLaunch" in method
    assert ".refresh()" not in method
    assert "rebaseFutureLifecycle" not in method
    assert "expireStale" not in method
    assert ACTIVITY.read_text(encoding="utf-8").index("maintainLifecycle()") < ACTIVITY.read_text(encoding="utf-8").index("accountLoaderOverride?.let")


def test_runtime_ledgers_cover_review3_lifecycle_and_provider_evidence():
    sync_runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/syncadapter/SyncStatusRuntimeTest.kt").read_text(encoding="utf-8")
    dashboard_runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    provider = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/ProviderBoundaryPolicyTest.kt").read_text(encoding="utf-8")
    store_tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/SyncStatusStoreTest.kt").read_text(encoding="utf-8")

    manual = sync_runtime.split("@Test fun manualRequestPersistsBeforeDispatchAndMatchingTerminalClearsLifecycle()", 1)[1]
    assert "historicalFailureAt" in manual
    assert "requestSyncDispatchOverride" in manual
    assert "beforeRequest..afterRequest" in manual
    assert "attachContactsChildrenAtAdapterBoundary" in manual
    assert "recordContactsChildAtAdapterBoundary" in manual
    requested_queued = dashboard_runtime.split("@Test fun requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention()", 1)[1]
    requested_queued = requested_queued.split("@Test fun mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue()", 1)[0]
    assert requested_queued.count("assertNoGenericAttention") == 5
    mixed = dashboard_runtime.split("@Test fun mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue()", 1)[1]
    for category in ("PERMISSION", "INTERRUPTED", "NETWORK", "PROVIDER", "STORAGE"):
        assert f"FailureCategory.{category}" in mixed
    assert "contacts adapters share parent generation" in provider
    assert "contacts parent child skip cancel and failed cleanup" in provider
    assert "old request and attempt never expire" in store_tests
    assert "platformActive, platformPending" in store_tests


def test_android_bundle_correlation_evidence_runs_only_on_android_runtime():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/syncadapter/SyncStatusRuntimeTest.kt").read_text(encoding="utf-8")
    jvm = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/ProviderBoundaryPolicyTest.kt").read_text(encoding="utf-8")

    assert "requestAndParentChildCorrelationExtrasRoundTripAtAndroidBoundary" in runtime
    assert "putSyncRequestId(requestExtras" in runtime
    assert "putSyncAttempt(attemptExtras" in runtime
    assert "Bundle()" not in jvm


def test_review4_mutation_rebase_pending_copy_and_due_maintenance_contracts():
    store = STORE.read_text(encoding="utf-8")
    adapter = ADAPTER.read_text(encoding="utf-8")
    activity = ACTIVITY.read_text(encoding="utf-8")
    reducer = REDUCER.read_text(encoding="utf-8")
    strings = (ROOT / "android/app/src/main/res/values/strings.xml").read_text(encoding="utf-8")
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    provider = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/ProviderBoundaryPolicyTest.kt").read_text(encoding="utf-8")

    assert "repairingFailedAdmission" in store
    assert "hasLifecycleFault(identity.storageKey, service)" in store
    assert "MutationResult.REJECTED" in adapter
    assert "signalPersistenceRetry" in adapter
    assert "if (input.pending)" in reducer
    assert "activeRequestId != null" not in reducer.split("if (input.pending)", 1)[1].split("if (status?.activeRequestId", 1)[0]
    assert "runDueLifecycleMaintenance(deadline)" in activity
    assert "lastImmediateLifecycleDeadline" in activity
    for text in (
        "This account couldn\\'t authenticate. Open account settings or sign out and sign in again.",
        "Android sync configuration is incomplete for this service.",
        "Allow %1$s access on this device.",
        "Review this account\\'s collections and Android integrations.",
        "Turn on Android system sync to continue.",
    ):
        assert text in strings
    assert "freshContactsGenerationFinishesBeforeChildDispatchOrCompletion" in runtime
    assert "contacts terminal paths preserve frozen v1 terminal evidence" in provider


def test_contacts_failed_admission_attachment_preserves_request_correlation_contract():
    store = STORE.read_text(encoding="utf-8")
    boundary = (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/ContactsSyncAdapterService.kt").read_text(encoding="utf-8")
    parent = (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/AddressBooksSyncAdapterService.kt").read_text(encoding="utf-8")
    store_tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/SyncStatusStoreTest.kt").read_text(encoding="utf-8")
    provider_tests = (ROOT / "android/app/src/test/java/io/silentsuite/sync/syncadapter/ProviderBoundaryPolicyTest.kt").read_text(encoding="utf-8")

    assert "attemptRequestId = requestId?.takeIf { current.requestId == it || repairedRequest != null }" in store
    assert "store.attachContactsChildren(parent, attemptId, children, startedAt, requestId)" in boundary
    assert "System.currentTimeMillis(), syncRequestId(extras)" in parent
    assert "contacts attachment repair restores matching request correlation only" in store_tests
    assert 'store.attachContactsChildren(first, "direct-attempt", setOf(child), 22, null)' in store_tests
    assert "provider attachment repair terminalizes its correlated request" in provider_tests
    assert "failed contacts admission repair cannot replace a newer generation" in provider_tests
    assert "failed admission pre attachment parent failure clears its matching request" in provider_tests
