"""Static contracts for the privacy-bounded Android sync lifecycle store."""

from pathlib import Path
import json
import re
import subprocess
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
FOCUSED_RUNTIME_SCRIPT = ROOT / "android/scripts/run-focused-runtime-tests.sh"
FOCUSED_RUNTIME_LEDGER = ROOT / "android/scripts/focused-runtime-ledger-v1.json"
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
    adapter = ADAPTER.read_text(encoding="utf-8")

    assert "recordRequested" in source
    assert source.index("recordRequested") < source.index("ContentResolver.requestSync")
    assert "EXTRA_SYNC_REQUEST_ID" in source
    assert "val requestedIdentity = account?.let { statusStore?.identity(it) }" in source
    assert "statusStore?.recordRequested(it, authorities.values.toSet(), requestId" in source
    assert "putSyncMainIdentity(extras, it)" in source
    assert "scheduledIdentity != currentIdentity" in adapter
    assert "requestId != null && !scheduledIdentityPresent" in adapter
    assert "Logger" not in source
    assert "println" not in source


def test_attempt_admission_is_correlation_bound_for_every_adapter_outcome():
    source = ADAPTER.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")

    assert "beginAttemptResult(\n                    identity, outcomeService" in source
    assert "putSyncMainIdentity(extras, admittedIdentity)" in source
    assert "admission != SyncStatusStore.MutationResult.REJECTED" in source
    assert "recordSuccessResult(\n                identity, service, attemptId, syncRequestId(extras)" in source
    assert "recordFailureResult(\n                identity, service, attemptId, syncRequestId(extras)" in source
    assert "write() == SyncStatusStore.MutationResult.STORAGE_FAILURE" in source
    assert "else store.recordSuccess" not in source
    assert "else store.recordFailure" not in source
    assert "CompletedOutcome.CANCELLED -> finishWithoutOutcome()" in source
    assert "mutation == SyncStatusStore.MutationResult.STORAGE_FAILURE" in source
    assert "val attemptId = syncAttempt(extras) ?: return SyncStatusStore.MutationResult.REJECTED" in address_books
    assert "failContactsParentResult(mainIdentity, attemptId, syncRequestId(extras), safeCategory)" in address_books
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
    assert "val capturedIdentity = SyncStatusStore.identityFromStorageKey(" in address_book
    assert "if (capturedIdentity != null)" in address_book
    assert "if (capturedChildIdentity != null)" in address_book
    assert "recordContactsChildRemoved(capturedIdentity, capturedChildIdentity)" in address_book
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

    assert "fun initialUserData(mainAccount: Account, mainIdentity: SyncStatusStore.MainIdentity, url: String," in source
    assert "require(SyncStatusStore.identityFromStorageKey(storageKey) != null)" in source
    assert "bundle.putString(USER_DATA_MAIN_ACCOUNT_IDENTITY, storageKey)" in source
    assert "bundle.putString(USER_DATA_CREATION_ID, childCreationId)" in source
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
    assert "val capturedIdentity = SyncStatusStore.identityFromStorageKey(" in source
    removal = source.split("val recordConfirmedRemoval =", 1)[1].split('@Suppress("DEPRECATION")', 1)[0]
    exact_guard = "if (capturedIdentity != null)"
    assert exact_guard in removal
    assert "recordContactsChildRemoved" not in removal.split(exact_guard, 1)[0]
    assert "ContentResolver.requestSync" not in removal.split(exact_guard, 1)[0]
    assert "statusStore.identity(candidate) == capturedIdentity" in removal


def test_contacts_children_use_captured_generation_identities_across_dispatch_and_removal():
    store = STORE.read_text(encoding="utf-8")
    address_book = (ROOT / "android/app/src/main/java/io/silentsuite/sync/resource/LocalAddressBook.kt").read_text(encoding="utf-8")
    parent = ADDRESS_BOOKS.read_text(encoding="utf-8")
    child = (ROOT / "android/app/src/main/java/io/silentsuite/sync/syncadapter/ContactsSyncAdapterService.kt").read_text(encoding="utf-8")

    assert "data class ChildIdentity" in store
    assert "LocalAddressBook.USER_DATA_CREATION_ID" in store
    assert "childIdentityFromStorageKey" in store
    assert 'const val USER_DATA_CREATION_ID = "sync_status_child_creation_id"' in address_book
    assert "UUID.randomUUID().toString()" in address_book
    assert "ensureLifecycleCreationId()" in address_book
    assert "val capturedChildIdentity = statusStore.childIdentity(child)" in address_book
    assert "recordContactsChildRemoved(capturedIdentity, capturedChildIdentity)" in address_book
    assert "putContactsTarget(syncExtras, mainIdentity, it, childIdentity)" in parent
    assert 'Logger.log.log(Level.INFO, "Running sync for address book", addressBookAccount)' not in parent
    assert "contactsChildTarget(extras)" in child
    assert "contactsLifecycleTargetMatchesCurrent(context, SyncStatusStore(context), account, lifecycleTarget)" in child
    assert "contactsLifecycleTargetMatchesCurrent(context, store, child, target)" in child
    assert "closeReplacedContactsChildAtAdapterBoundary" in child
    assert "contactsParentGenerationMatchesCurrent" in child
    assert "SyncStatusStore.ChildResult.REMOVED" in child
    assert "LocalAddressBook.USER_DATA_MAIN_ACCOUNT_IDENTITY" in child
    assert "store.identity(currentMainAccount) == target.mainIdentity" in child
    assert "LocalAddressBook(context, child, null).mainAccount" in child
    assert "target.childIdentity" in child
    assert "failContactsParentResult(mainIdentity, attemptId" in parent
    assert "failContactsParentResult(account, attemptId" not in parent
    assert "finishWithoutOutcomeResult(\n                mainIdentity, SyncStatusStore.Service.CONTACTS, attemptId)" in parent
    assert "EXTRA_SYNC_MAIN_IDENTITY" in store
    assert "syncMainIdentity(extras)" in ADAPTER.read_text(encoding="utf-8")


def test_runtime_contacts_fixtures_do_not_query_account_manager_for_synthetic_children():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")

    assert "beginContacts(account, setOf(child)" not in runtime
    assert 'childIdentity(child, "runtime-pending-child-generation")' in runtime
    assert 'childIdentity(child, "runtime-contacts-child-generation-$index")' in runtime
    assert "attachContactsChildren(mainIdentity, attemptId, setOf(childIdentity)" in runtime


def test_node_security_floor_matches_manifest_docs_and_sharp_lock_requirement():
    manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = (ROOT / "pnpm-lock.yaml").read_text(encoding="utf-8")
    docs = [
        ROOT / "docs/contributing/dev-setup.md",
        ROOT / "apps/docs/contributing/dev-setup.md",
    ]

    assert manifest["engines"]["node"] == ">=22.12.0"
    assert all("| **Node.js** | 22.12+ |" in path.read_text(encoding="utf-8") for path in docs)
    sharp = re.search(r"sharp@0\.35\.3:.*?engines: \{node: '([^']+)'\}", lock, re.DOTALL)
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
    before_children, _ = dispatch.split("for ((addressBookAccount, childIdentity) in childTargets)", 1)
    assert "return Completion.DISPATCHED" not in before_children
    assert "syncResult.stats.numIoExceptions++" in before_children
    assert "if (attemptId == null || mainIdentity == null || childTargets.size != childAccounts.size)" in before_children
    assert "attemptId?.let { putContactsTarget(syncExtras, mainIdentity, it, childIdentity) }" in address_books


def test_contacts_parent_precedes_admission_and_identity_maintenance_is_snapshot_bound():
    adapter = ADAPTER.read_text(encoding="utf-8")
    address_books = ADDRESS_BOOKS.read_text(encoding="utf-8")
    activity = ACTIVITY.read_text(encoding="utf-8")

    assert "service == SyncStatusStore.Service.CONTACTS" in adapter
    assert "putContactsParent(extras, admittedIdentity, attemptId)" in adapter
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

    attachment = store.split("private fun attachContactsChildKeys", 1)[1].split("@Synchronized", 1)[0]
    assert "repairingFailedAdmission" in attachment
    assert "hasLifecycleFault(identity, Service.CONTACTS)" in attachment
    assert "current.attemptId == null" in attachment
    assert "attemptId = attemptId" in attachment
    assert "contacts = ContactsGeneration(expected)" in attachment
    assert "signalPersistenceRetry(syncResult)" in address_books
    assert "for ((addressBookAccount, childIdentity) in childTargets)" in address_books


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


def test_pr2_runtime_methods_appear_once_in_the_exact_runtime_ledger():
    ledger = json.loads(FOCUSED_RUNTIME_LEDGER.read_text(encoding="utf-8"))
    canonical = {
        (class_name, method)
        for class_name, methods in ledger["classes"].items()
        for method in methods
    }
    entries = {
        ("io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest",
         "v1EvidenceReadsCompatiblyAndV2MutationStaysExactAndPrivate"),
        ("io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest",
         "manualRequestPersistsBeforeDispatchAndMatchingTerminalClearsLifecycle"),
        ("io.silentsuite.sync.ui.AccountDashboardRuntimeTest",
         "requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention"),
        ("io.silentsuite.sync.ui.AccountDashboardRuntimeTest",
         "mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue"),
        ("io.silentsuite.sync.ui.AccountDashboardRuntimeTest",
         "futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent"),
        ("io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest",
         "accountChoiceAndCredentialNavigationRemainExact"),
        ("io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest",
         "signupReturnClaimsOnlyOwningFlowAndIsIdempotent"),
        ("io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest",
         "normalAuthenticatorAndLegacyRestorationUseSafeDestinations"),
        ("io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest",
         "accountEntryRemainsAccessibleAcrossConfigurations"),
        ("io.silentsuite.sync.ui.PostLoginSetupRuntimeTest",
         "everyDurableSetupStateColdRendersApprovedPresentationWithoutRenderSideEffects"),
        ("io.silentsuite.sync.ui.PostLoginSetupRuntimeTest",
         "safeAutoAdvanceIsIdempotentAcrossRecreationAndStopsAtUserDecision"),
        ("io.silentsuite.sync.ui.PostLoginSetupRuntimeTest",
         "permissionGrantDenialBlockedSkipAndNoTaskProviderRemainResumable"),
        ("io.silentsuite.sync.ui.PostLoginSetupRuntimeTest",
         "initialSyncRequestIdSurvivesEveryCrashCutAndClearsAfterReady"),
    }
    assert entries <= canonical


def test_fresh_emulator_runtime_shards_are_ledger_derived_and_preserve_remaining_results():
    workflow = WORKFLOW.read_text(encoding="utf-8")
    job = workflow.split("  account-recreation-runtime:", 1)[1].split(
        "  # ─────────────────────────────────────────────────────────────────────", 1
    )[0]
    step = workflow.split(
        "- name: Run focused launcher and setup recreation contracts", 1
    )[1].split("- name: Upload focused androidTest reports and results", 1)[0]
    script = FOCUSED_RUNTIME_SCRIPT.read_text(encoding="utf-8")
    assertion = workflow.split("- name: Assert focused runtime methods executed", 1)[1]

    assert "timeout-minutes: 60" in job
    assert re.findall(r"^\s+script:\s*(.+)$", step, re.MULTILINE) == [
        'bash android/scripts/run-focused-runtime-tests.sh "${{ matrix.api-level }}" "${{ matrix.shard }}"'
    ]
    rows = re.findall(r"- api-level: (\d+)\n\s+arch: (\S+)\n\s+shard: (\S+)", job)
    assert rows == [
        ("21", "x86", "mixed"), ("21", "x86", "remaining"),
        ("35", "x86_64", "all"), ("36", "x86_64", "account-dashboard"),
        ("36", "x86_64", "first-run-setup"), ("36", "x86_64", "status-routes"),
    ]
    assert "name: Account recreation (API ${{ matrix.api-level }}, ${{ matrix.arch }}, ${{ matrix.shard }})" in job
    artifact = re.search(r"^\s+name: (account-recreation-androidTest-.+)$", job, re.MULTILINE).group(1)
    assert artifact == "account-recreation-androidTest-api${{ matrix.api-level }}-${{ matrix.arch }}-${{ matrix.shard }}-${{ github.sha }}"

    raw = FOCUSED_RUNTIME_LEDGER.read_bytes()
    assert raw.endswith(b"\n") and not raw.endswith(b"\n\n") and b"\r" not in raw
    ledger = json.loads(raw.decode("utf-8"), object_pairs_hook=lambda pairs: _unique_json_object(pairs))
    canonical_bytes = (json.dumps(ledger, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    assert raw == canonical_bytes
    assert ledger["schema"] == 1
    assert list(ledger["classes"]) == sorted(ledger["classes"])
    assert all(methods == sorted(methods) and len(methods) == len(set(methods)) for methods in ledger["classes"].values())

    canonical = {
        (class_name, method)
        for class_name, methods in ledger["classes"].items()
        for method in methods
    }
    runtime_methods = set()
    for class_name in ledger["classes"]:
        source = ROOT / "android/app/src/androidTest/java" / Path(*class_name.split(".")).with_suffix(".kt")
        runtime_methods.update(
            (class_name, method)
            for method in re.findall(r"@Test\s+fun\s+(\w+)", source.read_text(encoding="utf-8"))
        )
    assert len(canonical) == 81
    assert canonical == runtime_methods

    mixed = {tuple(pair) for pair in ledger["shards"]["21:mixed"]}
    api36 = {
        key: {pair for pair in canonical if pair[0] in set(ledger["shards"][key])}
        for key in ("36:account-dashboard", "36:first-run-setup", "36:status-routes")
    }
    assert (len(mixed), len(canonical - mixed), len(canonical)) == (1, 80, 81)
    assert tuple(len(api36[key]) for key in api36) == (27, 17, 37)
    assert all(
        left.isdisjoint(right)
        for index, left in enumerate(api36.values())
        for right in list(api36.values())[index + 1:]
    )
    assert set().union(*api36.values()) == canonical

    wrappers = {
        "io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest#accountChoiceAndCredentialNavigationRemainExact",
        "io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest#signupReturnClaimsOnlyOwningFlowAndIsIdempotent",
        "io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest#normalAuthenticatorAndLegacyRestorationUseSafeDestinations",
        "io.silentsuite.sync.ui.setup.FirstRunSignInRuntimeTest#accountEntryRemainsAccessibleAcrossConfigurations",
    }
    assert set(ledger["wrappers"]) == wrappers
    assert all(ledger["wrappers"][wrapper] == sorted(ledger["wrappers"][wrapper]) for wrapper in wrappers)

    assert script.startswith("#!/usr/bin/env bash\nset -euo pipefail\n")
    subprocess.run(["bash", "-n", FOCUSED_RUNTIME_SCRIPT], check=True)
    subprocess.run(["/usr/bin/dash", "-n", "-c", 'bash android/scripts/run-focused-runtime-tests.sh "21" "mixed"'], check=True)
    assert script.count("app:connectedDebugAndroidTest") == 7
    assert "focused-runtime-ledger-v1.json" in script
    assert "object_pairs_hook=reject_duplicate_keys" in script
    assert "canonical compact sorted UTF-8/LF JSON" in script
    assert "other77" not in script
    assert "remaining_selectors" in script
    assert "mktemp -d" in script and '${RUNNER_TEMP:-${TMPDIR:-/tmp}}' in script
    assert "app/build/outputs/androidTest-results/connected/." in script
    assert "api21-requested" in script and "api21_batch_" not in script
    assert 'command -v timeout >/dev/null 2>&1' in script
    assert re.findall(r"timeout --signal=TERM --kill-after=10s (\d+)s", script) == [
        "600", "600", "1500", "2400", "1800", "1800", "1800"
    ]
    requested_run = script.index('class="${requested_selector}"')
    save = script.index("\n  save_requested_results", requested_run)
    remaining_run = script.index('class="${remaining_selectors}"')
    assert script.index("trap restore_requested_results EXIT") < requested_run < save < remaining_run
    assert "status=$?" in script and "set +e" in script and "restore_status=$?" in script
    assert script.count('if [[ "${status}" -eq 0 && "') >= 3
    assert script.index("trap - EXIT") < script.index('exit "${status}"')
    for contract in (
        "scenarioNonce", "invocationNonce", "helperSet", "pull_and_validate_scenarios",
        "exec-out", "FocusedRuntimeScenario", "logcat-*.txt", "output-metadata.json",
        "scenario identity mismatch", "scenario set mismatch",
    ):
        assert contract in script
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/setup/FirstRunSignInRuntimeTest.kt").read_text(encoding="utf-8")
    assert "assertTestStateEmpty()" in runtime
    assert "recordScenario(helper" in runtime
    assert 'SCENARIO_LOG_TAG = "FocusedRuntimeScenario"' in runtime
    assert "android.util.Log.i(SCENARIO_LOG_TAG, serializedEvidence)" in runtime
    assert all(helper in runtime for helpers in ledger["wrappers"].values() for helper in helpers)
    for contract in (
        "duplicate scenario key", "duplicate helper ownership", "remote scenario set mismatch",
        "scenario platform/version mismatch",
    ):
        assert contract in script

    assert "focused-runtime-ledger-v1.json" in assertion
    assert "object_pairs_hook=reject_duplicate_keys" in assertion
    assert "canonical={(class_name,method)" in assertion
    assert "expected_sizes={'21:mixed':1,'21:remaining':80,'35:all':81,'36:account-dashboard':27,'36:first-run-setup':17,'36:status-routes':37}" in assertion
    assert "glob.glob('app/build/outputs/androidTest-results/connected/**/*.xml', recursive=True)" in assertion
    assert "unexpected=set(counts)-expected" in assertion
    assert "duplicates={pair: counts[pair] for pair in expected if counts[pair] != 1}" in assertion
    assert "producer-manifest.json" in assertion
    assert "assertionOutcome': 'PASS'" in assertion
    assert "ledgerSha256" in assertion and "workflowSha256" in assertion
    for contract in (
        "Initialize focused runtime producer manifest", "assertionOutcome': 'INCOMPLETE'",
        "stepOutcomes", "applicationId", "versionCode", "versionName", "evidenceSha256",
        "baseSha", "headSha", "runAttempt", "Finalize failed focused runtime producer manifest",
        "focused runtime execution or scenario validation did not succeed", "NOT_APPLICABLE",
    ):
        assert contract in job
    assert job.index("Assert focused runtime methods executed") < job.index("Upload focused androidTest reports and results")


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        assert key not in result, f"duplicate JSON key: {key}"
        result[key] = value
    return result


def test_runtime_ledger_model_fails_closed_for_every_executed_noncanonical_testcase():
    canonical = {("CanonicalTest", "expected")}
    expected = set(canonical)

    def unexpected_executed(counts):
        return set(counts) - expected

    assert unexpected_executed({("CanonicalTest", "expected"): 1}) == set()
    assert unexpected_executed({("CanonicalTest", "expected"): 1, ("OtherTest", "ran"): 1}) == {
        ("OtherTest", "ran")
    }
    assert unexpected_executed({("CanonicalTest", "expected"): 1, ("CanonicalTest", "wrongName"): 1}) == {
        ("CanonicalTest", "wrongName")
    }


def test_dashboard_text_polling_is_bounded_without_waiting_for_global_idle():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    helper = runtime.split("private fun waitForText(", 1)[1].split("private fun assertNoGenericAttention", 1)[0]

    assert "waitForIdleSync" not in runtime
    assert helper.count("scenario.onActivity") == 1
    assert "addTextChangedListener" in helper
    assert "AtomicReference<String>" in helper
    assert "System.nanoTime()" in helper
    assert "repeat(200)" not in helper
    assert "SystemClock.sleep(50)" in helper


def test_api21_lifecycle_observer_avoids_blocking_activity_polling():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    lifecycle = runtime.split(
        "@Test fun requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention()", 1
    )[1].split("@Test fun freshContactsGenerationFinishesBeforeChildDispatchOrCompletion()", 1)[0]

    assert lifecycle.count("scenario.onActivity") == 6
    assert lifecycle.count("addTextChangedListener") == 1
    assert "observe(R.id.dashboard_overall_status, overallText)" in lifecycle
    assert "observe(R.id.caldav_status, caldavText)" in lifecycle
    assert "AtomicReference<String>" in lifecycle
    assert "waitForObservedText(" in lifecycle
    assert "waitForText(scenario" not in lifecycle
    assert "assertNoGenericAttention(scenario)" not in lifecycle
    assert "overallText.get()" in lifecycle
    assert "SyncLifecycleWindows(interruptionAfterMillis = Long.MAX_VALUE)" in lifecycle
    assert "lifecycle-diagnostic" not in lifecycle
    assert "Log." not in lifecycle
    protected = "store.status(account, SyncStatusStore.Service.CONTACTS).activeAttemptId"
    projected = 'store.recordRequested(account, setOf(SyncStatusStore.Service.CALENDAR), "runtime-request", now)'
    assert lifecycle.index(protected) < lifecycle.index("store.clear(account)") < lifecycle.index(projected)
    observer_poll = runtime.split("private fun waitForObservedText(", 1)[1].split(
        "private fun waitForText(", 1
    )[0]
    assert "AtomicReference<String>" in observer_poll
    assert "System.nanoTime()" in observer_poll
    assert "scenario.onActivity" not in observer_poll


def test_api21_mixed_dashboard_observers_precede_mutation_and_avoid_post_refresh_barriers():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    mixed = runtime.split(
        "@Test fun mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue()", 1
    )[1].split("@Test fun futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent()", 1)[0]

    assert mixed.count("scenario.onActivity") == 1
    assert mixed.count("addTextChangedListener") == 1
    assert mixed.index("scenario.onActivity") < mixed.index("val store = SyncStatusStore(context)")
    assert "observe(R.id.dashboard_overall_status, overallText)" in mixed
    assert "observe(R.id.caldav_status, caldavText)" in mixed
    assert "observe(R.id.carddav_status, carddavText)" in mixed
    assert mixed.count("waitForObservedText(") == 4
    assert "waitForText(scenario" not in mixed
    assert "val dashboardActivity = AtomicReference<AccountActivity>()" in mixed
    assert "dashboardActivity.set(activity)" in mixed
    assert "activity.runOnUiThread { activity.refresh() }" in mixed
    assert "scenario.onActivity" not in mixed.split("val store = SyncStatusStore(context)", 1)[1]
    assert "assertEquals(syncing, overallText.get())" in mixed
    assert "assertEquals(syncing, caldavText.get())" in mixed
    assert "assertEquals(issue, carddavText.get())" in mixed
    assert "val calendarRefreshing = AtomicBoolean(false)" in mixed
    assert "it.refreshing = calendarRefreshing.get()" in mixed
    assert mixed.index("calendarRefreshing.set(true)") < mixed.index("val store = SyncStatusStore(context)")
    assert "calendarRefreshing.set(false)" in mixed
    assert mixed.index("calendarRefreshing.set(false)") > mixed.index("categories.forEachIndexed")
    assert "dashboard_status_never_synced" in mixed
    assert "mixed-diagnostic" not in mixed
    assert "helper-diagnostic" not in runtime


def test_account_replacement_visibility_poll_does_not_wait_for_global_main_queue_idle():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDrawerSignOutRuntimeTest.kt").read_text(encoding="utf-8")
    helper = runtime.split("private fun waitUntil(", 1)[1].split("\n    @Test", 1)[0]

    assert "waitForIdleSync" not in helper
    assert "SystemClock.uptimeMillis()" in helper
    assert "if (predicate()) return" in helper
    assert "SystemClock.sleep(25)" in helper


def test_dashboard_runtime_polling_helpers_retain_synchronization_and_bounds():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")

    retained = runtime.split("private fun waitForRetainedGenerationInvalidation(", 1)[1].split("private fun assertNoAdditionalDelivery", 1)[0]
    assert "repeat(100)" in retained
    assert "scenario.onActivity" in retained
    assert "SystemClock.sleep(50)" in retained
    assert 'throw AssertionError("retained OnAccountsUpdateListener did not observe generation absence")' in retained

    no_delivery = runtime.split("private fun assertNoAdditionalDelivery(", 1)[1].split("private fun service", 1)[0]
    assert "repeat(20)" in no_delivery
    assert "scenario.onActivity" in no_delivery
    assert 'assertEquals("replacement generation published dashboard data", deliveriesBefore, deliveries)' in no_delivery
    assert "SystemClock.sleep(25)" in no_delivery

    model = runtime.split("private fun waitForModel(", 1)[1].split("private fun waitForDeliveryAfter", 1)[0]
    assert "repeat(50)" in model
    assert "scenario.onActivity" in model
    assert "SystemClock.sleep(50)" in model
    assert 'throw AssertionError("Dashboard model was not delivered")' in model

    delivery = runtime.split("private fun waitForDeliveryAfter(", 1)[1].split("private fun waitUntil", 1)[0]
    assert "repeat(200)" in delivery
    assert "scenario.onActivity" in delivery
    assert "SystemClock.sleep(50)" in delivery
    assert 'throw AssertionError("Dashboard model was not delivered again")' in delivery

    until = runtime.split("private fun waitUntil(", 1)[1].split("private fun waitForText", 1)[0]
    assert "val deadline = android.os.SystemClock.uptimeMillis() + timeoutMillis" in until
    assert "while (android.os.SystemClock.uptimeMillis() < deadline)" in until
    assert "if (predicate()) return" in until
    assert "SystemClock.sleep(50)" in until
    assert 'throw AssertionError("Timed out waiting for $description")' in until


def test_stale_dashboard_actions_use_bounded_main_thread_quiet_window():
    runtime = (ROOT / "android/app/src/androidTest/java/io/silentsuite/sync/ui/AccountDashboardRuntimeTest.kt").read_text(encoding="utf-8")
    method = runtime.split("fun retainedSurfaceRejectsReplacementBeforePrivateActionsAndRoutes()", 1)[1].split("\n    @Test", 1)[0]
    quiet_window = method.split("repeat(20) {", 1)[1].split("\n                }", 1)[0]

    assert "waitForIdleSync" not in method
    assert "android.os.SystemClock.sleep(25)" in quiet_window
    assert "scenario.onActivity {" in quiet_window
    assert quiet_window.index("android.os.SystemClock.sleep(25)") < quiet_window.index("scenario.onActivity {")
    assertions = (
        'assertTrue("stale Activity read a replacement fingerprint", fingerprints.isEmpty())',
        'assertTrue("stale Activity launched a replacement route", routes.isEmpty())',
        'assertTrue("stale Activity opened an export document", exportDocuments.isEmpty())',
        'assertEquals("stale Activity wrote replacement export data", 0, exports)',
        'assertEquals("stale Activity read replacement billing state", 0, billingReads)',
        'assertEquals("stale Activity requested runtime permissions", 0, permissionRequests)',
        'assertEquals("stale Activity launched permission remediation", 0, permissionRemediations)',
        'assertEquals("stale Activity enabled global sync", 0, masterSyncEnables)',
    )
    for assertion in assertions:
        assert assertion in quiet_window


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
    assert requested_queued.count("assertNoGenericAttention") == 0
    assert requested_queued.count('contains("Needs attention", ignoreCase = true)') == 5
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
