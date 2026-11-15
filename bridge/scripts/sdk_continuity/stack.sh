#!/usr/bin/env bash
# Install one Bridge stack into its own virtualenv, the way the release build does:
# the hash-locked requirements-lock.txt of that Bridge tree, optionally an etebase wheel
# built in this job (macOS lanes), then the Bridge itself with nothing left to resolve.
#
# Usage: stack.sh NAME VENV PYTHON BRIDGE_DIR [ETEBASE_WHEEL]
# Prints NAME=<venv python> and appends it to $GITHUB_ENV when that is set.
set -euo pipefail
name="$1" venv="$2" python="$3" bridge="$4" wheel="${5:-}"
"$python" -m venv "$venv"
if [ -x "$venv/bin/python" ]; then py="$venv/bin/python"; else py="$venv/Scripts/python.exe"; fi
cd "$bridge"
"$py" -m pip install --disable-pip-version-check --require-hashes --only-binary=:all: -r requirements-lock.txt
if [ -n "$wheel" ]; then
  "$py" -m pip install --disable-pip-version-check --no-deps --no-index "$wheel"
fi
"$py" -m pip install --disable-pip-version-check --no-deps --no-build-isolation --check-build-dependencies -e .
"$py" -m pip check
echo "$name=$py"
if [ -n "${GITHUB_ENV:-}" ]; then echo "$name=$py" >> "$GITHUB_ENV"; fi
