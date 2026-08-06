#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

evidence_nonce="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-color-parity}"
[[ "$evidence_nonce" =~ ^[A-Za-z0-9._-]+$ ]]
remote_evidence_dir="/sdcard/Android/data/io.silentsuite.android/files/color-parity-evidence/$evidence_nonce"
local_evidence_dir="build/color-parity-evidence"
evidence_names=(
  parity-m3-about-light.png
  parity-m3-about-dark.png
  parity-legacy-app-settings-light.png
  parity-legacy-app-settings-dark.png
)

rm -rf "$local_evidence_dir"
mkdir -p "$local_evidence_dir"

set +e
./gradlew app:connectedDebugAndroidTest --no-daemon -PrequireEtebase16Kb=true \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true \
  -Pandroid.testInstrumentationRunnerArguments.class=io.silentsuite.screenshots.StoreScreenshotsTest#testParityEvidence \
  -Pandroid.testInstrumentationRunnerArguments.screenshotDir="$remote_evidence_dir"
instrumentation_status=$?
set -e

missing_evidence=0
for name in "${evidence_names[@]}"; do
  if ! adb pull "$remote_evidence_dir/$name" "$local_evidence_dir/$name"; then
    missing_evidence=1
  elif [[ ! -s "$local_evidence_dir/$name" ]]; then
    echo "empty color parity evidence file: $name" >&2
    missing_evidence=1
  fi
done

python3 - <<'PY'
import hashlib, json, os, pathlib
output = pathlib.Path('build/color-parity-evidence/parity-metadata.json')
files = sorted(output.parent.glob('*.png'))
output.write_text(json.dumps({
    'commit': os.environ.get('GITHUB_SHA', 'local'),
    'api': 36,
    'themes': ['light', 'dark'],
    'routes': ['AboutActivity', 'AppSettingsActivity'],
    'files': [path.name for path in files],
    'sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
}, sort_keys=True, indent=2) + '\n', encoding='utf-8')
PY

if [[ "$instrumentation_status" -ne 0 ]]; then
  exit "$instrumentation_status"
fi
if [[ "$missing_evidence" -ne 0 ]]; then
  echo "color parity instrumentation passed but expected nonempty evidence is missing" >&2
  exit 1
fi
