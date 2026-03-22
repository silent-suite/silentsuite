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
echo "Waiting for services to become healthy..."

MAX_WAIT=120
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=0

  for container in silentsuite-postgres silentsuite-server; do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
      HEALTHY=$((HEALTHY + 1))
    fi
  done

  if [ "$HEALTHY" -ge 2 ]; then
    echo "All services healthy."
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo "  $HEALTHY/2 services healthy ($ELAPSED/${MAX_WAIT}s)..."
done

if [ "$HEALTHY" -lt 2 ]; then
  echo ""
  echo "WARNING: Not all services are healthy after ${MAX_WAIT}s."
  echo "Run '$COMPOSE logs' to troubleshoot."
  exit 1
fi

echo ""
echo "Update complete."
