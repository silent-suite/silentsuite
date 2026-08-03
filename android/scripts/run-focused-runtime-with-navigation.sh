#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <api-level> <shard> <navigation-mode>" >&2
  exit 2
fi

api_level="$1"
shard="$2"
navigation_mode="$3"

if [[ -n "$navigation_mode" ]]; then
  case "$navigation_mode" in
    2) adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.gestural ;;
    0) adb shell cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton ;;
    *) echo "unsupported requested navigation mode: $navigation_mode" >&2; exit 1 ;;
  esac

  actual_navigation_mode=""
  for _ in {1..10}; do
    actual_navigation_mode="$(adb shell settings get secure navigation_mode | tr -d '\r')"
    [[ "$actual_navigation_mode" == "$navigation_mode" ]] && break
    sleep 1
  done
  if [[ "$actual_navigation_mode" != "$navigation_mode" ]]; then
    echo "navigation mode activation failed: expected $navigation_mode, got $actual_navigation_mode" >&2
    exit 1
  fi
fi

exec bash "$(dirname "$0")/run-focused-runtime-tests.sh" "$api_level" "$shard"
