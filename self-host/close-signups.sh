#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted: close open signups
# --------------------------------------------
# Flips ETEBASE_DISABLE_SIGNUP to "true" in .env and recreates the server
# container so new user registration is blocked. Run this once your admin
# account is registered in the SilentSuite app.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env not found in $SCRIPT_DIR." >&2
  echo "       Run this script from the SilentSuite install directory." >&2
  exit 1
fi

if grep -qE '^ETEBASE_DISABLE_SIGNUP=true$' .env; then
  echo "Open signups are already disabled (ETEBASE_DISABLE_SIGNUP=true)."
  exit 0
fi

if grep -qE '^ETEBASE_DISABLE_SIGNUP=' .env; then
  # `-i.bak` works on both GNU and BSD sed; we delete the backup ourselves.
  sed -i.bak -E 's/^ETEBASE_DISABLE_SIGNUP=.*/ETEBASE_DISABLE_SIGNUP=true/' .env
  rm -f .env.bak
else
  echo "ETEBASE_DISABLE_SIGNUP=true" >> .env
fi

if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "ERROR: 'docker compose' is not available." >&2
  exit 1
fi

echo "Recreating SilentSuite server with ETEBASE_DISABLE_SIGNUP=true..."
$COMPOSE up -d --force-recreate server

echo ""
echo "============================================"
echo "  Open signups are now DISABLED."
echo "============================================"
echo ""
echo "  New user registration will be blocked at the API level."
echo ""
echo "  To re-open signups (e.g. to add another user), edit .env, set"
echo "  ETEBASE_DISABLE_SIGNUP=false, and run:"
echo "    $COMPOSE up -d --force-recreate server"
echo ""
