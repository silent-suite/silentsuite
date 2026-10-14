#!/usr/bin/env bash
# CI-only: start a throwaway effective stack of the Umbrel development package from the
# images just built, probe it, restart the server, and remove only what this script created.
# Usage: scripts/umbrel-candidate-smoke.sh <web-image> <server-image>
set -euo pipefail

web_image="$1"
server_image="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="${RUNNER_TEMP:?RUNNER_TEMP is required}/umbrel-candidate-stack"
project="silentsuite-umbrel-ci"
export ROUTER_PORT=18080

cleanup() {
  if [ -f "$work/compose.yml" ]; then
    docker compose -p "$project" -f "$work/compose.yml" logs --no-color > "$RUNNER_TEMP/umbrel-candidate-stack.log" 2>&1 || true
    docker compose -p "$project" -f "$work/compose.yml" down --volumes --remove-orphans || true
  fi
  sudo rm -rf "$work"
}
trap cleanup EXIT

rm -rf "$work"
mkdir -p "$work"
cp -R "$root/self-host/umbrel/silentsuite/data" "$work/data"

# Synthetic CI-only values standing in for Umbrel's APP_PASSWORD and derive_entropy exports.
export APP_DATA_DIR="$work"
APP_PASSWORD="$(openssl rand -hex 32)"
APP_SILENTSUITE_REGISTRATION_SIGNING="$(openssl rand -hex 32)"
APP_SILENTSUITE_DB_PASSWORD="$(openssl rand -hex 32)"
export APP_PASSWORD APP_SILENTSUITE_REGISTRATION_SIGNING APP_SILENTSUITE_DB_PASSWORD
export APP_SILENTSUITE_WEB_IMAGE="$web_image"
export APP_SILENTSUITE_SERVER_IMAGE="$server_image"

python3 -m venv "$work/venv"
"$work/venv/bin/pip" install --disable-pip-version-check --quiet PyYAML==6.0.3
"$work/venv/bin/python" "$root/scripts/umbrel-candidate-effective-compose.py" \
  "$root/self-host/umbrel/silentsuite/docker-compose.yml" "$work/compose.yml" "$ROUTER_PORT"

docker compose -p "$project" -f "$work/compose.yml" up -d

echo "== API and owner-gate probes (waits for the migrated server through the router)"
python3 "$root/scripts/umbrel-candidate-probe.py"

echo "== init exited cleanly; server data ownership and private files"
test "$(docker inspect -f '{{.State.ExitCode}}' silentsuite_init_1)" = "0"
server_uid="$(docker run --rm --entrypoint id "$server_image" -u etebase)"
test "$(sudo stat -c '%u %a' "$work/data/server-config/etebase-server.ini")" = "$server_uid 600"
test "$(sudo stat -c '%u %a' "$work/data/server/secret.txt")" = "$server_uid 600"
test "$(sudo stat -c '%u' "$work/data/server/static")" = "$server_uid"

echo "== migrations and standalone web runtime"
# Never pipe a streaming writer into grep's quiet mode under pipefail: the early exit
# SIGPIPEs the writer and the pipeline reports failure even when the match succeeded.
server_logs="$(docker logs silentsuite_server_1 2>&1)"
case "$server_logs" in
  *"applying database migrations"*) ;;
  *)
    echo "server log lacks the migration marker" >&2
    exit 1
    ;;
esac
if docker logs silentsuite_web_1 2>&1 | grep -E "Cannot find module|MODULE_NOT_FOUND"; then
  echo "standalone web is missing traced modules" >&2
  exit 1
fi
docker run --rm --entrypoint sh "$web_image" -c 'grep -rlq "Installation password" apps/web/.next/static'

echo "== server restart keeps the account"
docker restart silentsuite_server_1 > /dev/null
python3 "$root/scripts/umbrel-candidate-probe.py" --after-restart
