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

# The compose file pins the server image to a specific manifest digest, so
# `docker compose pull` is a no-op for cross-version upgrades. To move to a
# new SilentSuite version, re-run install.sh — it fetches the release-pinned
# compose. This script just ensures the pinned images are present and the
# stack is recreated against them.
echo "Pulling pinned images..."
$COMPOSE pull

echo "Recreating containers..."
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
echo ""
echo "If your reverse proxy reaches the server over a Docker network,"
echo "make sure TRUSTED_PROXY_IPS in .env contains that proxy container's"
echo "exact IP, then run: $COMPOSE up -d --force-recreate server"
