#!/usr/bin/env bash
# Offline half on one release lane, with the SDK that lane ships. The fixtures were
# written by the old SDKs against the CI server; no network is used here.
#
#   offline.sh new PYTHON WORK   new stack: restore + cache_load every blob of each
#                                fixture, then write with the new SDK (pending create,
#                                edit, delete, collection meta) and re-save the session
#   offline.sh old PYTHON WORK OLD_SDK
#                                old stack: read back what the new SDK wrote
#
# WORK holds one directory per fixture (linux-old, macos-arm64-old).
set -euo pipefail
phase="$1" py="$2" work="$3"
script="$(cd "$(dirname "$0")" && pwd)/continuity.py"
for fx in "$work"/*/; do
  fx="${fx%/}"
  echo "=== $phase stack on $(basename "$fx") ==="
  if [ "$phase" = new ]; then
    "$py" "$script" check "$fx" --sdk "$NEW_SDK"
    "$py" "$script" mutate "$fx" --sdk "$NEW_SDK" --tag lane --edit 7 --delete 8
    "$py" "$script" session "$fx" --sdk "$NEW_SDK" --out "$fx/session.txt"
    "$py" "$script" check "$fx" --sdk "$NEW_SDK"
  else
    "$py" "$script" check "$fx" --sdk "$4"
  fi
done
