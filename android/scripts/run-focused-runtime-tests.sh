#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${android_root}"

api_level="${1:?usage: run-focused-runtime-tests.sh API_LEVEL SHARD}"
shard="${2:?usage: run-focused-runtime-tests.sh API_LEVEL SHARD}"
mixed_selector='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue'
requested_selector='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention'
other70_selectors='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#freshContactsGenerationFinishesBeforeChildDispatchOrCompletion,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#truthfulDashboardTransitionsUseDurableEvidenceAndDedupeAcrossRecreation,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#serviceModulesAndCompleteActionsPreserveMetadataAndExactAccountRouting,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#retainedLoadRejectsSameNameReplacementBeforePublication,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#initialLoadFailurePublishesTerminalErrorAndRefreshFailureRetainsValidDashboard,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#retainedSurfaceRejectsReplacementBeforePrivateActionsAndRoutes,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#dashboardExportCompletionPreservesExactDashboardAfterRecreation,io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'
focused_classes='io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.AccountDashboardRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'
api36_account_setup_classes='io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.AccountDashboardRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest'
api36_status_routes_classes='io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'

command -v timeout >/dev/null 2>&1

if [[ "${api_level}:${shard}" == "21:mixed" ]]; then
  timeout --signal=TERM --kill-after=10s 600s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${mixed_selector}"
elif [[ "${api_level}:${shard}" == "21:remaining" ]]; then
  temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  mkdir -p "${temp_root}"
  requested_results="$(mktemp -d "${temp_root%/}/pr567-api21-requested.XXXXXX")"
  requested_saved=0

  save_requested_results() {
    if [[ -d "app/build/outputs/androidTest-results/connected" ]]; then
      cp -R "app/build/outputs/androidTest-results/connected/." "${requested_results}/" || return $?
    fi
    requested_saved=1
  }

  restore_requested_results() {
    status=$?
    set +e
    trap - EXIT
    if [[ "${requested_saved}" -eq 0 ]]; then
      save_requested_results
      save_status=$?
      if [[ "${status}" -eq 0 && "${save_status}" -ne 0 ]]; then
        status="${save_status}"
      fi
    fi
    mkdir -p "app/build/outputs/androidTest-results/connected/api21-requested"
    mkdir_status=$?
    if [[ "${status}" -eq 0 && "${mkdir_status}" -ne 0 ]]; then
      status="${mkdir_status}"
    fi
    cp -R "${requested_results}/." "app/build/outputs/androidTest-results/connected/api21-requested/"
    restore_status=$?
    if [[ "${status}" -eq 0 && "${restore_status}" -ne 0 ]]; then
      status="${restore_status}"
    fi
    exit "${status}"
  }
  trap restore_requested_results EXIT

  timeout --signal=TERM --kill-after=10s 600s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${requested_selector}"
  save_requested_results

  timeout --signal=TERM --kill-after=10s 1500s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${other70_selectors}"
elif [[ "${api_level}:${shard}" == "35:all" ]]; then
  timeout --signal=TERM --kill-after=10s 2400s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${focused_classes}"
elif [[ "${api_level}:${shard}" == "36:account-setup" ]]; then
  timeout --signal=TERM --kill-after=10s 1800s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api36_account_setup_classes}"
elif [[ "${api_level}:${shard}" == "36:status-routes" ]]; then
  timeout --signal=TERM --kill-after=10s 1800s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api36_status_routes_classes}"
else
  echo "unsupported API level/shard: ${api_level}/${shard}" >&2
  exit 2
fi
