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
check_container "etebase-server"
check_container "silentsuite-web"
check_container "silentsuite-caddy"
echo ""

# ── Check endpoints ────────────────────────────────────────────────────

check_endpoint() {
  local label="$1"
  local url="$2"

  if curl -sf --max-time 10 "$url" >/dev/null 2>&1; then
    echo "  [OK]    $label ($url)"
  else
    echo "  [FAIL]  $label ($url)"
    EXIT_CODE=1
  fi
}

echo "Endpoint Checks:"
check_endpoint "Web App" "http://localhost:3000/"
check_endpoint "Etebase" "http://localhost:3735/"
echo ""

# ── DNS check (non-fatal) ─────────────────────────────────────────────

if command -v dig &>/dev/null; then
  echo "DNS Status:"
  for host in "$DOMAIN" "sync.$DOMAIN"; do
    ip=$(dig +short "$host" 2>/dev/null || echo "")
    if [ -n "$ip" ]; then
      echo "  [OK]    $host -> $ip"
    else
      echo "  [WARN]  $host (no DNS record found)"
    fi
  done
  echo ""
fi

if [ $EXIT_CODE -eq 0 ]; then
  echo "All checks passed!"
else
  echo "Some checks failed. Review the output above."
fi

exit $EXIT_CODE
