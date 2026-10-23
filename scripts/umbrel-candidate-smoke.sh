#!/usr/bin/env bash
# CI-only throwaway stack. Only the explicitly supplied images and package are used.
set -euo pipefail

# Keep runner and registry credentials out of every child process.
while IFS= read -r variable; do
  case "$variable" in PATH|RUNNER_TEMP) ;; *) unset "$variable" ;; esac
done < <(compgen -e)

root="$(cd "$(dirname "$0")/.." && pwd)"
web_image="${1:?web image required}"
server_image="${2:?server image required}"
shift 2
package="$root/self-host/umbrel/silentsuite"
expected_revision=""
platform=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package-dir) package="${2:?}"; shift 2 ;;
    --expect-revision) expected_revision="${2:?}"; shift 2 ;;
    --platform) platform="${2:?}"; shift 2 ;;
    *) echo "Unknown smoke argument" >&2; exit 2 ;;
  esac
done
[[ "$expected_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "Exact revision required" >&2; exit 2; }
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "Native platform required" >&2; exit 2 ;; esac
for image in "$web_image" "$server_image"; do
  [[ "$image" =~ ^[a-z0-9][a-z0-9._:/@-]*$ ]] || { echo "Invalid image reference" >&2; exit 2; }
done
[ ! -L "$package" ] && [ ! -L "$package/data" ] || { echo "Linked package refused" >&2; exit 2; }

work="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/umbrel-candidate.XXXXXXXX")"
project="silentsuite-umbrel-$(basename "$work" | tr -cd 'a-z0-9')"
compose="$work/compose.yml"
export DOCKER_CONFIG="$work/docker-config"
mkdir -m 700 "$DOCKER_CONFIG"
# Pulls, if any, are anonymous. The caller must have loaded both application images.
export ROUTER_PORT=18080
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -f "$compose" ]; then
    docker compose -p "$project" -f "$compose" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # Containers may have created root-owned files, but only in this private fixture.
  sudo rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

python3.12 -c 'import sys; assert sys.version_info[:2] == (3, 12)'
python3.12 -m venv "$work/venv"
cat > "$work/requirements.txt" <<'REQUIREMENTS'
PyYAML==6.0.3 \
    --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc \
    --hash=sha256:9149cad251584d5fb4981be1ecde53a1ca46c891a79788c0df828d2f166bda28
REQUIREMENTS
"$work/venv/bin/pip" install --disable-pip-version-check --quiet \
  --require-hashes --only-binary=:all: -r "$work/requirements.txt"

web_id="$(docker image inspect -f '{{.Id}}' "$web_image")"
server_id="$(docker image inspect -f '{{.Id}}' "$server_image")"
for image in "$web_id" "$server_id"; do
  test "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image")" = "$platform"
  test "$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")" = "$expected_revision"
done

cp -R -P -- "$package/data" "$work/data"
export APP_DATA_DIR="$work"
APP_PASSWORD="$(openssl rand -hex 32)"
APP_SILENTSUITE_REGISTRATION_SIGNING="$(openssl rand -hex 32)"
APP_SILENTSUITE_DB_PASSWORD="$(openssl rand -hex 32)"
export APP_PASSWORD APP_SILENTSUITE_REGISTRATION_SIGNING APP_SILENTSUITE_DB_PASSWORD
"$work/venv/bin/python" "$root/scripts/umbrel-candidate-effective-compose.py" \
  "$package/docker-compose.yml" "$compose" "$ROUTER_PORT" \
  --web-image "$web_id" --server-image "$server_id" \
  --app-data-dir "$work" --mode smoke

docker compose -p "$project" -f "$compose" up -d >/dev/null
for pair in "web:$web_id" "init:$server_id" "server:$server_id"; do
  service="${pair%%:*}"
  image_id="${pair#*:}"
  test "$(docker inspect -f '{{.Image}}' "silentsuite_${service}_1")" = "$image_id"
done
python3.12 "$root/scripts/umbrel-candidate-probe.py"

test "$(docker inspect -f '{{.State.ExitCode}}' silentsuite_init_1)" = "0"
server_uid="$(docker run --rm --entrypoint id "$server_id" -u etebase)"
test "$(sudo stat -c '%u %a' "$work/data/server-config/etebase-server.ini")" = "$server_uid 600"
test "$(sudo stat -c '%u %a' "$work/data/server/secret.txt")" = "$server_uid 600"
test "$(sudo stat -c '%u' "$work/data/server/static")" = "$server_uid"

server_logs="$(docker logs silentsuite_server_1 2>&1)"
case "$server_logs" in
  *"applying database migrations"*) ;;
  *) echo "Server migration marker absent" >&2; exit 1 ;;
esac
web_logs="$(docker logs silentsuite_web_1 2>&1)"
if [[ "$web_logs" == *"Cannot find module"* || "$web_logs" == *"MODULE_NOT_FOUND"* ]]; then
  echo "Standalone web is missing traced modules" >&2
  exit 1
fi
# The package routes /api/ to Etebase; check this web-only endpoint internally.
docker exec silentsuite_web_1 node -e '
  fetch("http://127.0.0.1:3000/api/deployment-identity")
    .then(response => { if (!response.ok) throw new Error(); return response.json(); })
    .then(identity => { if (identity.publicSha !== process.argv[1]) throw new Error(); })
    .catch(() => process.exit(1));
' "$expected_revision"
docker run --rm --entrypoint sh "$web_id" -c 'grep -rlq "Installation password" apps/web/.next/static'
docker restart silentsuite_server_1 >/dev/null
python3.12 "$root/scripts/umbrel-candidate-probe.py" --after-restart
test "$(docker inspect -f '{{.Image}}' silentsuite_server_1)" = "$server_id"
router_id="$(docker inspect -f '{{.Image}}' silentsuite_router_1)"
python3.12 "$root/scripts/umbrel-candidate-privacy.py" \
  --server-image "$server_id" --router-image "$router_id" \
  --startup "$work/data/bootstrap/server-start.sh" \
  --router-config "$work/data/router/default.conf" --work-dir "$work/privacy"
