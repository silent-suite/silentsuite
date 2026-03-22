#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Health Checker
# ----------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Run install.sh first."
  exit 1
fi

# shellcheck disable=SC1091
source .env

echo "SilentSuite Health Check"
echo "========================"
echo ""

EXIT_CODE=0

# ── Check container states ─────────────────────────────────────────────

check_container() {
  local name="$1"
  local status
  local health

  status=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null || echo "not found")
  health=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "unknown")

  if [ "$status" = "running" ] && [ "$health" = "healthy" ]; then
    echo "  [OK]    $name (running, healthy)"
  elif [ "$status" = "running" ]; then
    echo "  [WARN]  $name (running, health: $health)"
    EXIT_CODE=1
  else
    echo "  [FAIL]  $name ($status)"
    EXIT_CODE=1
  fi
}

echo "Container Status:"
check_container "silentsuite-postgres"
check_container "silentsuite-server"
echo ""

# ── Check sync server endpoint ─────────────────────────────────────────

SERVER_PORT="${SERVER_PORT:-3735}"

echo "Server Endpoint:"
if curl -sf --max-time 10 "http://localhost:${SERVER_PORT}/" >/dev/null 2>&1; then
  echo "  [OK]    SilentSuite server (http://localhost:${SERVER_PORT}/)"
else
  echo "  [FAIL]  SilentSuite server (http://localhost:${SERVER_PORT}/)"
  EXIT_CODE=1
fi
echo ""

if [ $EXIT_CODE -eq 0 ]; then
  echo "All checks passed!"
else
  echo "Some checks failed. Review the output above."
fi

exit $EXIT_CODE
