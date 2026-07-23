#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${android_root}"

api_level="${1:?usage: run-focused-runtime-tests.sh API_LEVEL}"
api21_batch_a='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention'
api21_batch_b='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#mixedActiveAndSiblingActionableOrTransientIssuesKeepCurrentHeadlineAndSecondaryIssue'
api21_batch_c='io.silentsuite.sync.ui.AccountDashboardRuntimeTest#freshContactsGenerationFinishesBeforeChildDispatchOrCompletion,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#futureLifecycleRebasesAndNearestDeadlineExpiresWithoutAnotherPlatformEvent,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#truthfulDashboardTransitionsUseDurableEvidenceAndDedupeAcrossRecreation,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#serviceModulesAndCompleteActionsPreserveMetadataAndExactAccountRouting,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#retainedLoadRejectsSameNameReplacementBeforePublication,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#initialLoadFailurePublishesTerminalErrorAndRefreshFailureRetainsValidDashboard,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#retainedSurfaceRejectsReplacementBeforePrivateActionsAndRoutes,io.silentsuite.sync.ui.AccountDashboardRuntimeTest#dashboardExportCompletionPreservesExactDashboardAfterRecreation,io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'
focused_classes='io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.AccountDashboardRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'

if [[ "${api_level}" == "21" ]]; then
  temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  mkdir -p "${temp_root}"
  api21_batch_a_results="$(mktemp -d "${temp_root%/}/pr567-api21-batch-a.XXXXXX")"
  api21_batch_b_results="$(mktemp -d "${temp_root%/}/pr567-api21-batch-b.XXXXXX")"
  api21_batch_a_saved=0
  api21_batch_b_saved=0
  api21_batch_b_started=0

  save_api21_batch_a() {
    if [[ -d "app/build/outputs/androidTest-results/connected" ]]; then
      cp -R "app/build/outputs/androidTest-results/connected/." "${api21_batch_a_results}/" || return $?
    fi
    api21_batch_a_saved=1
  }

  save_api21_batch_b() {
    if [[ -d "app/build/outputs/androidTest-results/connected" ]]; then
      cp -R "app/build/outputs/androidTest-results/connected/." "${api21_batch_b_results}/" || return $?
    fi
    api21_batch_b_saved=1
  }

  restore_api21_batches() {
    status=$?
    set +e
    trap - EXIT
    if [[ "${api21_batch_a_saved}" -eq 0 ]]; then
      save_api21_batch_a
      save_status=$?
      if [[ "${status}" -eq 0 && "${save_status}" -ne 0 ]]; then
        status="${save_status}"
      fi
    fi
    if [[ "${api21_batch_b_started}" -eq 1 && "${api21_batch_b_saved}" -eq 0 ]]; then
      save_api21_batch_b
      save_status=$?
      if [[ "${status}" -eq 0 && "${save_status}" -ne 0 ]]; then
        status="${save_status}"
      fi
    fi
    mkdir -p "app/build/outputs/androidTest-results/connected/api21-batch-a"
    mkdir_status=$?
    if [[ "${status}" -eq 0 && "${mkdir_status}" -ne 0 ]]; then
      status="${mkdir_status}"
    fi
    cp -R "${api21_batch_a_results}/." "app/build/outputs/androidTest-results/connected/api21-batch-a/"
    restore_status=$?
    if [[ "${status}" -eq 0 && "${restore_status}" -ne 0 ]]; then
      status="${restore_status}"
    fi
    mkdir -p "app/build/outputs/androidTest-results/connected/api21-batch-b"
    mkdir_status=$?
    if [[ "${status}" -eq 0 && "${mkdir_status}" -ne 0 ]]; then
      status="${mkdir_status}"
    fi
    cp -R "${api21_batch_b_results}/." "app/build/outputs/androidTest-results/connected/api21-batch-b/"
    restore_status=$?
    if [[ "${status}" -eq 0 && "${restore_status}" -ne 0 ]]; then
      status="${restore_status}"
    fi
    exit "${status}"
  }
  trap restore_api21_batches EXIT

  command -v timeout >/dev/null 2>&1
  timeout --signal=TERM --kill-after=10s 600s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api21_batch_a}"
  save_api21_batch_a

  api21_batch_b_started=1
  timeout --signal=TERM --kill-after=10s 300s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api21_batch_b}"
  save_api21_batch_b

  timeout --signal=TERM --kill-after=10s 900s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api21_batch_c}"
else
  ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${focused_classes}"
fi
