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
check_container "silentsuite-caddy"
echo ""

# ── Check sync server endpoint ─────────────────────────────────────────

echo "Internal Endpoint:"
if curl -sf --max-time 10 "http://localhost:3735/" >/dev/null 2>&1; then
  echo "  [OK]    SilentSuite server (http://localhost:3735/)"
else
  echo "  [FAIL]  SilentSuite server (http://localhost:3735/)"
  EXIT_CODE=1
fi
echo ""

# ── DNS check (non-fatal) ─────────────────────────────────────────────

if command -v dig &>/dev/null; then
  echo "DNS Status:"
  ip=$(dig +short "$DOMAIN" 2>/dev/null || echo "")
  if [ -n "$ip" ]; then
    echo "  [OK]    $DOMAIN -> $ip"
  else
    echo "  [WARN]  $DOMAIN (no DNS record found)"
  fi
  echo ""
fi

# ── External endpoint check (non-fatal) ───────────────────────────────

echo "External Endpoint (requires DNS + TLS):"
if curl -sf --max-time 10 "https://$DOMAIN/" >/dev/null 2>&1; then
  echo "  [OK]    https://$DOMAIN/"
else
  echo "  [WARN]  https://$DOMAIN/ (not reachable yet -- DNS may still be propagating)"
fi
echo ""

if [ $EXIT_CODE -eq 0 ]; then
  echo "All checks passed!"
else
  echo "Some checks failed. Review the output above."
fi

exit $EXIT_CODE
