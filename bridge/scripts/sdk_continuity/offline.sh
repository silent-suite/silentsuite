#!/usr/bin/env bash
# Offline half on one release lane, with the SDK that lane ships. No network is used.
# Run from the repository root, where the workflow put the fixtures:
#   work/     written by the old SDKs (0.31.5 on Linux, 0.31.9 on macOS arm64)
#   work-rt/  written by 0.32.0 in the roundtrip job, incl. a fresh-sign-in session
#
#   offline.sh new PYTHON           new stack: default data dir; restore + cache_load
#                                   every blob of work/, then write with the new SDK
#                                   (pending create, edit, delete, collection meta) and
#                                   re-save the session
#   offline.sh old PYTHON OLD_SDK   old stack: same default data dir; restore and read
#                                   back everything 0.32.0 wrote (work/ and work-rt/),
#                                   with every stored session the fixture has
set -euo pipefail
phase="$1" py="$2"
script="$(cd "$(dirname "$0")" && pwd)/continuity.py"
if [ "$phase" = new ]; then
  "$py" "$script" datadir work-datadir.txt
  for fx in work/*/; do
    fx="${fx%/}"
    echo "=== new stack on $(basename "$fx") ==="
    "$py" "$script" check "$fx" --sdk "$NEW_SDK"
    "$py" "$script" mutate "$fx" --sdk "$NEW_SDK" --tag lane --edit 7 --delete 8
    "$py" "$script" session "$fx" --sdk "$NEW_SDK" --out "$fx/session.txt"
    "$py" "$script" check "$fx" --sdk "$NEW_SDK"
  done
else
  "$py" "$script" datadir work-datadir.txt --compare
  for fx in work/*/ work-rt/*/; do
    fx="${fx%/}"
    echo "=== old stack on $fx ==="
    "$py" "$script" check "$fx" --sdk "$3"
    if [ -f "$fx/session-login.txt" ]; then
      "$py" "$script" check "$fx" --sdk "$3" --session "$fx/session-login.txt"
    fi
  done
fi
