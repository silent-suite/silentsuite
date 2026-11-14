#!/usr/bin/env bash
# Cross-process persistence gate for the account-creation ownership registry.
#
# Each step is its own `am instrument` invocation, and the app process is terminated before every
# step, so a reader can only see what the writer's production store made durable. App data is never
# cleared and the package is never removed between steps; the reinstall pair reads legacy persisted
# state across an in-place reinstall of the same debug-signed APK (an emulator existing-install
# fixture with legacy state, not an old-version binary upgrade and not release signing).
#
# The same boundary first gates the Notes account-removal allowance, which lives only in the app
# process that made it: a slot minted in one process is refused in the next. Its steps have their
# own test class, output and exact inventory, run before the registry's, and end with a cleanup step.
#
# Last, the app upgrade migrations get their own in-place reinstall of the same APK: an older app
# version is stored, the APK is installed over the existing data, and the first app process after it
# must find the migration done (own class, output and inventory). They run after the registry steps
# so no extra app start falls between the registry's legacy writer and its reader.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${android_root}"

api_level="${1:?usage: run-registry-process-boundary.sh API_LEVEL}"
[[ "${api_level}" =~ ^[0-9]+$ ]]

package="io.silentsuite.android"
test_class="io.silentsuite.sync.ui.setup.RegistryProcessBoundaryRuntimeTest"
output="app/build/outputs/androidTest-results/registry-process-boundary"
notes_class="io.silentsuite.sync.ui.NotesRemovalProcessBoundaryRuntimeTest"
notes_output="app/build/outputs/androidTest-results/notes-removal-process-boundary"
upgrade_class="io.silentsuite.sync.AppUpgradeProcessBoundaryRuntimeTest"
upgrade_output="app/build/outputs/androidTest-results/app-upgrade-boundary"

command -v timeout >/dev/null 2>&1
rm -rf -- "${output}" "${notes_output}" "${upgrade_output}"
mkdir -p -- "${output}" "${notes_output}" "${upgrade_output}"

# The inventories are written on every exit path, so an early failure is recorded, not absent.
write_inventory() {
  status=$?
  trap - EXIT
  python3 "${script_dir}/check-notes-removal-process-boundary.py" "${notes_output}" "${api_level}" || status=1
  python3 "${script_dir}/check-app-upgrade-boundary.py" "${upgrade_output}" "${api_level}" || status=1
  python3 "${script_dir}/check-registry-process-boundary.py" "${output}" "${api_level}" || status=1
  exit "${status}"
}
trap write_inventory EXIT

timeout --signal=TERM --kill-after=10s 1500s \
  ./gradlew app:installDebug app:installDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true

component="$(adb shell pm list instrumentation | tr -d '\r' \
  | sed -n "s|^instrumentation:\([^ ]*\) (target=${package})\$|\1|p")"
if [[ "$(printf '%s\n' "${component}" | grep -c .)" -ne 1 ]]; then
  echo "expected exactly one instrumentation targeting ${package}, got: ${component}" >&2
  exit 1
fi

terminate_app_process() {
  local attempt running
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    adb shell am force-stop "${package}"
    running="$({ adb shell ps -A 2>/dev/null || true; adb shell ps 2>/dev/null || true; } \
      | tr -d '\r' | awk '{print $NF}' | grep -Fx "${package}" || true)"
    [[ -z "${running}" ]] && return 0
    sleep 0.5
  done
  echo "app process still running after force-stop" >&2
  return 1
}

run_step() {
  local step="$1" method="$2" command_status=0
  terminate_app_process
  # adb does not propagate the instrumentation verdict on every API level, so the checker reads
  # the transcript; a timeout (124/137) or adb failure is recorded here and fails the step too.
  timeout --signal=TERM --kill-after=10s 300s \
    adb shell am instrument -w -r \
      -e class "${test_class}#${method}" \
      -e registryBoundaryProbe true \
      "${component}" > "${output}/${step}.txt" 2>&1 || command_status=$?
  printf '%s\n' "${command_status}" > "${output}/${step}.exit"
  tr -d '\r' < "${output}/${step}.txt" | tail -n 5
}

# A Notes removal step: the same separate invocation in a terminated app process, recorded for its
# own checker. A failed step, or an app process that would not stop, fails that step and never stops
# the steps after it, so the cleanup step always runs.
run_notes_step() {
  local step="$1" method="$2" command_status=0
  terminate_app_process || command_status=$?
  timeout --signal=TERM --kill-after=10s 300s \
    adb shell am instrument -w -r \
      -e class "${notes_class}#${method}" \
      "${component}" > "${notes_output}/${step}.txt" 2>&1 || command_status=$?
  printf '%s\n' "${command_status}" > "${notes_output}/${step}.exit"
  tr -d '\r' < "${notes_output}/${step}.txt" | tail -n 5
}

# An app upgrade step: the same separate invocation in a terminated app process, recorded for its own
# checker. A failure there fails the lane through the inventory, never the steps after it.
run_upgrade_step() {
  local step="$1" method="$2" command_status=0
  terminate_app_process || command_status=$?
  timeout --signal=TERM --kill-after=10s 300s \
    adb shell am instrument -w -r \
      -e class "${upgrade_class}#${method}" \
      "${component}" > "${upgrade_output}/${step}.txt" 2>&1 || command_status=$?
  printf '%s\n' "${command_status}" > "${upgrade_output}/${step}.exit"
  tr -d '\r' < "${upgrade_output}/${step}.txt" | tail -n 5
}

install_times() {
  adb shell dumpsys package "${package}" | tr -d '\r' | grep -E '^\s*(firstInstallTime|lastUpdateTime)=' | sed 's/^\s*//'
}

# Notes first: the registry's last pair leaves an unreadable registry behind.
run_notes_step control controlRemovesTheRowWithASlotMintedInTheSameProcess
run_notes_step write writerMintsAnAllowanceAndStopsBeforeTheAnswer
run_notes_step read readerInAFreshProcessIsRefusedWithTheSameVerdictAndFingerprint
run_notes_step cleanup cleanupGivesNotesPendingItsModeBackAndRemovesTheRows

run_step empty-write writerCommitsEmptyRegistryThroughProductionStore
run_step empty-read readerLoadsEmptyRegistryInFreshProcess
run_step populated-write writerCommitsEveryPhaseThroughProductionStore
run_step populated-read readerLoadsEveryPhaseInFreshProcess
run_step legacy-empty-write writerCommitsLegacyNewlineTerminatedEmptyRegistry
run_step legacy-empty-read readerRecoversLegacyPaddedEmptyRegistryInFreshProcess
run_step legacy-populated-write writerCommitsLegacyNewlineTerminatedEveryPhase
run_step legacy-populated-read readerRecoversLegacyPaddedEveryPhaseInFreshProcess
run_step reinstall-write writerCommitsLegacyNewlineTerminatedEveryPhase

apk="$(python3 - <<'PY'
import json, pathlib
matches = []
for path in pathlib.Path("app/build/outputs/apk/debug").glob("output-metadata.json"):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("applicationId") != "io.silentsuite.android":
        continue
    matches += [path.parent / element["outputFile"] for element in data["elements"]]
if len(matches) != 1:
    raise SystemExit(f"expected exactly one debug APK, got {matches}")
print(matches[0])
PY
)"
terminate_app_process
install_times > "${output}/reinstall-before.txt"
sleep 2
reinstall_status=0
timeout --signal=TERM --kill-after=10s 300s adb install -r "${apk}" > "${output}/reinstall-install.txt" 2>&1 || reinstall_status=$?
printf '%s\n' "${reinstall_status}" > "${output}/reinstall-install.exit"
install_times > "${output}/reinstall-after.txt"

run_step reinstall-read readerRecoversLegacyPaddedEveryPhaseInFreshProcess

# Last: a value no decoder accepts is seeded and must still be unreadable and unchanged after a
# restart. It runs after every other step so no later writer can inherit that state.
run_step malformed-write writerSeedsMalformedRegistryValue
run_step malformed-read readerKeepsMalformedRegistryUnreadableAndUntouchedInFreshProcess

# App upgrade: an older stored version, an in-place reinstall, then the first process after it.
run_upgrade_step seed seedsAnOlderAppVersionBeforeTheUpgrade
upgrade_status=0
terminate_app_process || upgrade_status=$?
install_times > "${upgrade_output}/upgrade-before.txt"
sleep 2
timeout --signal=TERM --kill-after=10s 300s adb install -r "${apk}" > "${upgrade_output}/upgrade-install.txt" 2>&1 || upgrade_status=$?
printf '%s\n' "${upgrade_status}" > "${upgrade_output}/upgrade-install.exit"
install_times > "${upgrade_output}/upgrade-after.txt"
run_upgrade_step check upgradeMigrationHasRunInTheFirstProcessAfterTheReinstall
