#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
android_root="$(cd -- "${script_dir}/.." && pwd)"
ledger="${script_dir}/focused-runtime-ledger-v1.json"
cd "${android_root}"

api_level="${1:?usage: run-focused-runtime-tests.sh API_LEVEL SHARD}"
shard="${2:?usage: run-focused-runtime-tests.sh API_LEVEL SHARD}"

ledger_selectors() {
  python3 - "${ledger}" "$1" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
raw = path.read_bytes()

def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SystemExit(f"duplicate ledger key: {key}")
        result[key] = value
    return result

ledger = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
canonical = (json.dumps(ledger, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
if raw != canonical:
    raise SystemExit("focused runtime ledger is not canonical compact sorted UTF-8/LF JSON")
if ledger.get("schema") != 1:
    raise SystemExit("unsupported focused runtime ledger schema")

tests = sorted(
    (class_name, method)
    for class_name, methods in ledger["classes"].items()
    for method in methods
)
if len(tests) != 81 or len(set(tests)) != 81:
    raise SystemExit(f"bad canonical runtime ledger size: {len(tests)}")

mixed = [tuple(pair) for pair in ledger["shards"]["21:mixed"]]
requested = [pair for pair in tests if pair[1] == "requestedQueuedRunningSettlingAndTerminalStatesNeverFlashGenericAttention"]
if mode == "21:mixed":
    selected = mixed
elif mode == "21:requested":
    selected = requested
elif mode == "21:remaining":
    selected = [pair for pair in tests if pair not in set(mixed + requested)]
elif mode == "35:all":
    selected = tests
elif mode in {"36:account-dashboard", "36:first-run-setup", "36:status-routes"}:
    owners = set(ledger["shards"][mode])
    selected = [pair for pair in tests if pair[0] in owners]
else:
    raise SystemExit(f"unsupported ledger selector mode: {mode}")

expected = {
    "21:mixed": 1,
    "21:requested": 1,
    "21:remaining": 79,
    "35:all": 81,
    "36:account-dashboard": 27,
    "36:first-run-setup": 17,
    "36:status-routes": 37,
}[mode]
if len(selected) != expected:
    raise SystemExit(f"bad selector count for {mode}: {len(selected)}")
print(",".join(f"{class_name}#{method}" for class_name, method in selected))
PY
}

mixed_selector="$(ledger_selectors '21:mixed')"
requested_selector="$(ledger_selectors '21:requested')"
remaining_selectors="$(ledger_selectors '21:remaining')"
all_selectors="$(ledger_selectors '35:all')"
api36_account_dashboard_selectors="$(ledger_selectors '36:account-dashboard')"
api36_first_run_setup_selectors="$(ledger_selectors '36:first-run-setup')"
api36_status_routes_selectors="$(ledger_selectors '36:status-routes')"

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
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${remaining_selectors}"
elif [[ "${api_level}:${shard}" == "35:all" ]]; then
  timeout --signal=TERM --kill-after=10s 2400s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${all_selectors}"
elif [[ "${api_level}:${shard}" == "36:account-dashboard" ]]; then
  timeout --signal=TERM --kill-after=10s 1800s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api36_account_dashboard_selectors}"
elif [[ "${api_level}:${shard}" == "36:first-run-setup" ]]; then
  timeout --signal=TERM --kill-after=10s 1800s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api36_first_run_setup_selectors}"
elif [[ "${api_level}:${shard}" == "36:status-routes" ]]; then
  timeout --signal=TERM --kill-after=10s 1800s \
    ./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true -Pandroid.testInstrumentationRunnerArguments.class="${api36_status_routes_selectors}"
else
  echo "unsupported API level/shard: ${api_level}/${shard}" >&2
  exit 2
fi
