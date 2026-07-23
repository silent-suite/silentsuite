#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${android_root}"

api_level="${1:?usage: run-focused-runtime-tests.sh API_LEVEL}"
api21_batch_a='io.silentsuite.sync.ui.AccountDashboardRuntimeTest'
api21_batch_b='io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'
focused_classes='io.silentsuite.sync.ui.AccountActivityRecreationTest,io.silentsuite.sync.ui.AccountDrawerSignOutRuntimeTest,io.silentsuite.sync.ui.AccountDashboardRuntimeTest,io.silentsuite.sync.ui.PostLoginSetupRuntimeTest,io.silentsuite.sync.ui.setup.AuthenticatorLifecycleRuntimeTest,io.silentsuite.sync.utils.TaskProviderHandlingRuntimeTest,io.silentsuite.sync.syncadapter.SyncStatusRuntimeTest,io.silentsuite.sync.ui.SettingsRuntimeTest,io.silentsuite.sync.ui.SiblingRoutesRuntimeTest'

if [[ "${api_level}" == "21" ]]; then
  temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  mkdir -p "${temp_root}"
  api21_saved_results="$(mktemp -d "${temp_root%/}/pr567-api21-batch-a.XXXXXX")"

  ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api21_batch_a}"
  cp -R "app/build/outputs/androidTest-results/connected/." "${api21_saved_results}/"

  restore_api21_batch_a() {
    status=$?
    set +e
    trap - EXIT
    mkdir -p "app/build/outputs/androidTest-results/connected/api21-batch-a"
    cp -R "${api21_saved_results}/." "app/build/outputs/androidTest-results/connected/api21-batch-a/"
    restore_status=$?
    if [[ "${status}" -eq 0 && "${restore_status}" -ne 0 ]]; then
      status="${restore_status}"
    fi
    exit "${status}"
  }
  trap restore_api21_batch_a EXIT

  ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api21_batch_b}"
else
  ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${focused_classes}"
fi
