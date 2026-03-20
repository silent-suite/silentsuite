#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Updater
# --------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if docker compose version &>/dev/null; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  echo "ERROR: 'docker compose' is not available."
  exit 1
fi

echo "Pulling latest images..."
$COMPOSE pull

echo "Recreating containers with updated images..."
$COMPOSE up -d

echo ""
echo "Update complete. Run ./verify.sh to check service health."
