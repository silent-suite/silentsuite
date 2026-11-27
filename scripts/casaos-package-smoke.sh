#!/usr/bin/env bash
# CI-only throwaway stacks for the CasaOS/ZimaOS package: fresh install, restart,
# fail-closed credential checks, interrupted first boot, upgrade and restore.
# Never prints a credential: secrets are read into variables and compared by hash.
set -euo pipefail

# Keep runner and registry credentials out of every child process.
while IFS= read -r variable; do
  case "$variable" in PATH|RUNNER_TEMP|HOME) ;; *) unset "$variable" ;; esac
done < <(compgen -e)

root="$(cd "$(dirname "$0")/.." && pwd)"
compose_src="${1:?package compose required}"
shift
platform=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platform="${2:?}"; shift 2 ;;
    *) echo "Unknown smoke argument" >&2; exit 2 ;;
  esac
done
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "Native platform required" >&2; exit 2 ;; esac
[ -f "$compose_src" ] && [ ! -L "$compose_src" ] || { echo "Package compose missing" >&2; exit 2; }

# Previous release, the Umbrel package pins: the upgrade drill starts here.
OLD_WEB="ghcr.io/silent-suite/silentsuite-web-selfhost:v0.5.20-beta@sha256:5156f5d9b67db5c7a6dcdf51c603b104e4c3ec6e2789ad2a6552431fd66e8088"
OLD_SERVER="ghcr.io/silent-suite/silentsuite-server:v0.5.20-beta@sha256:6a5ab47d21feeed4fc05379258e8c2686e1fa67138dbd6570900eea732b0c7bb"
NAMES=(owner-password registration-signing database-password)
PROJECT=silentsuite

work="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/casaos-package.XXXXXXXX")"
compose="$work/compose.yml"
export DOCKER_CONFIG="$work/docker-config"
mkdir -m 700 "$DOCKER_CONFIG"
export ROUTER_PORT=18080
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ -f "$compose" ]; then
    for service in silentsuite-init silentsuite-server silentsuite-db silentsuite silentsuite-web; do
      echo "── last log lines: $service" >&2
      docker logs --tail 30 "$service" 2>&1 | grep -v -i -E 'password|token' >&2 || true
    done
  fi
  if [ -f "$compose" ]; then
    docker compose -p "$PROJECT" -f "$compose" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  # Containers created root-owned files, but only inside this private fixture.
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
py="$work/venv/bin/python"

dc() { docker compose -p "$PROJECT" -f "$compose" "$@"; }
step() { echo "── $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }

render() { # render DATA_DIR [image overrides...]
  "$py" -I "$root/scripts/casaos-package-render.py" "$compose_src" "$compose" \
    --data-dir "$1" --port "$ROUTER_PORT" "${@:2}"
}

same_value() { # same_value FILE1 FILE2: equal contents ignoring a trailing newline; values stay in sudo's shell
  sudo sh -c 'test "$(cat "$1")" = "$(cat "$2")"' _ "$1" "$2"
}

load_credentials() { # load_credentials DATA_DIR
  APP_PASSWORD="$(sudo cat "$1/installation-password/password.txt")"
  APP_SILENTSUITE_REGISTRATION_SIGNING="$(sudo cat "$1/server-secrets/registration-signing")"
  export APP_PASSWORD APP_SILENTSUITE_REGISTRATION_SIGNING
  same_value "$1/installation-password/password.txt" "$1/server-secrets/owner-password" \
    || fail "visible installation password differs from server-secrets/owner-password"
}

run_probe() { # run_probe MODE USERNAME
  PROBE_USERNAME="$2" python3.12 "$root/scripts/casaos-package-probe.py" "$1"
}

wait_init() { # wait_init: sets INIT_EXIT to the one-shot init's exit code; fails on a timeout
  INIT_EXIT=""
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Status}}' silentsuite-init 2>/dev/null)" = exited ]; then
      INIT_EXIT="$(docker inspect -f '{{.State.ExitCode}}' silentsuite-init)"
      [[ "$INIT_EXIT" =~ ^[0-9]+$ ]] || fail "init exit code unreadable"
      return
    fi
    sleep 2
  done
  fail "init did not finish"
}

runtime_hashes() { # SHA-256 of credentials, server config and Django key as the services see them
  docker exec silentsuite-server sha256sum /data/secret.txt /run/silentsuite/owner-password \
    /run/silentsuite/registration-signing /run/silentsuite/database-password \
    /etc/etebase-server/etebase-server.ini
  docker exec silentsuite-db sha256sum /run/silentsuite/password
}

tree_hashes() { # tree_hashes DATA_DIR: authoritative and derived files on the host
  sudo find "$1/server-secrets" "$1/server-config" "$1/postgres-secret" "$1/installation-password" \
    -type f -exec sha256sum {} + | sed "s|$1/||" | sort
}

add_sentinel() { # add_sentinel DATA_DIR NAME
  sudo sh -c "head -c 32 /dev/urandom > '$1/server/media/$2'"
  sudo chmod 600 "$1/server/media/$2"
}

sentinel_visible() { # sentinel_visible NAME -> 0 when the server container sees it
  docker exec silentsuite-server test -f "/data/media/$1"
}

assert_platform() {
  for container in silentsuite-web silentsuite-server; do
    image="$(docker inspect -f '{{.Image}}' "$container")"
    test "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image")" = "$platform" \
      || fail "$container image is not $platform"
  done
}

# ── 1. Fresh install ──────────────────────────────────────────────────
step "fresh install"
app="$work/app"
mkdir -p "$app"
render "$app"
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init failed on a fresh install"
assert_platform
web_image="$(docker inspect -f '{{.Image}}' silentsuite-web)"
docker run --rm --entrypoint sh "$web_image" -c 'grep -rlq "Installation password" apps/web/.next/static' \
  || fail "web image lacks the installation password signup field"
load_credentials "$app"
run_probe full ci_casaos_user

server_uid="$(docker run --rm --entrypoint id "$(docker inspect -f '{{.Image}}' silentsuite-server)" -u etebase)"
for name in "${NAMES[@]}"; do
  test "$(sudo stat -c '%u %a' "$app/server-secrets/$name")" = "$server_uid 600" || fail "mode of $name"
done
test "$(sudo stat -c '%u %a' "$app/server-secrets")" = "$server_uid 700" || fail "mode of server-secrets"
test "$(sudo stat -c '%u %a' "$app/server-config/etebase-server.ini")" = "$server_uid 600" || fail "mode of INI"
test "$(sudo stat -c '%u %a' "$app/server/secret.txt")" = "$server_uid 600" || fail "mode of secret.txt"
test "$(sudo stat -c '%u:%g %a' "$app/postgres-secret/password")" = "70:70 400" || fail "mode of db password copy"
test "$(sudo stat -c '%u %a' "$app/installation-password/password.txt")" = "0 600" || fail "mode of visible copy"
test "$(sudo stat -c '%u %a' "$app/installation-password")" = "0 700" || fail "mode of visible dir"
sudo awk 'NR == FNR { value = $0; next } $0 == "password = " value { found = 1 } END { exit !found }' \
  "$app/server-secrets/database-password" "$app/server-config/etebase-server.ini" \
  || fail "INI does not carry the authoritative database password"
same_value "$app/postgres-secret/password" "$app/server-secrets/database-password" \
  || fail "database password copy differs"

for container in silentsuite-server silentsuite; do
  logs="$(docker logs "$container" 2>&1)"
  case "$logs" in *"/api/v1/"*|*ci_casaos_user*) fail "$container logged a request" ;; esac
done
case "$(docker logs silentsuite-init 2>&1)" in *"$APP_PASSWORD"*) fail "init logged the installation password" ;; esac

baseline="$(runtime_hashes)"
add_sentinel "$app" ci-sentinel-1
sentinel_visible ci-sentinel-1 || fail "sentinel not visible in the server container"

# ── 2. Restart ────────────────────────────────────────────────────────
step "restart"
dc restart >/dev/null
run_probe after-restart ci_casaos_user
test "$(runtime_hashes)" = "$baseline" || fail "credentials or Django key changed across restart"
load_credentials "$app"
run_probe owner-login ci_casaos_user
sentinel_visible ci-sentinel-1 || fail "sentinel lost across restart"

# ── 3. Server-side guard: CasaOS Restart and --no-deps do not rerun init ──
step "server guard"
break_file() { # break_file DATA_DIR NAME CASE
  case "$3" in
    missing) sudo mv "$1/server-secrets/$2" "$work/held-$2" ;;
    empty) sudo cp -p "$1/server-secrets/$2" "$work/held-$2"; sudo truncate -s 0 "$1/server-secrets/$2" ;;
    malformed) sudo cp -p "$1/server-secrets/$2" "$work/held-$2"
               sudo sh -c "printf 'not-a-credential\n' > '$1/server-secrets/$2'" ;;
  esac
}
mend_file() { # stop the crash-looping server first, so no backoff restart races the next case
  docker stop silentsuite-server >/dev/null
  sudo mv -f "$work/held-$2" "$1/server-secrets/$2"
}
guard_case() { # guard_case HOW LABEL
  since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sleep 1
  if [ "$1" = restart ]; then
    dc restart silentsuite-server >/dev/null
  else
    dc up -d --no-deps --force-recreate silentsuite-server >/dev/null 2>&1 || true
  fi
  run_probe server-down ci_casaos_user || fail "server served with $2 ($1)"
  case "$(docker logs --since "$since" silentsuite-server 2>&1)" in
    *"Not starting."*) ;;
    *) fail "server did not report the refusal for $2 ($1)" ;;
  esac
}
for how in restart no-deps; do
  for name in "${NAMES[@]}"; do
    for kind in missing empty malformed; do
      break_file "$app" "$name" "$kind"
      guard_case "$how" "$kind $name"
      mend_file "$app" "$name"
    done
  done
  sudo cp -p "$app/server-secrets/registration-signing" "$work/held-registration-signing"
  sudo cp "$app/server-secrets/owner-password" "$app/server-secrets/registration-signing"
  guard_case "$how" "owner password equal to signing material"
  mend_file "$app" registration-signing
  dc up -d --no-deps --force-recreate silentsuite-server >/dev/null 2>&1
  run_probe after-restart ci_casaos_user
done
test "$(runtime_hashes)" = "$baseline" || fail "credentials changed during the guard drill"

# ── 4. Init fails closed against an existing database ────────────────
step "init fail-closed"
dc down >/dev/null
init_refuses() { # init_refuses LABEL: init on the current case tree must refuse and change nothing
  before="$(tree_hashes "$case_dir")"
  render "$case_dir"
  dc up -d >/dev/null 2>&1 || true
  wait_init
  test "$INIT_EXIT" = 1 || fail "init did not refuse $1 (exit $INIT_EXIT)"
  server_state="$(docker inspect -f '{{.State.Status}}' silentsuite-server 2>/dev/null || echo absent)"
  case "$server_state" in created|absent) ;; *) fail "server started with $1" ;; esac
  dc down >/dev/null
  test "$(tree_hashes "$case_dir")" = "$before" || fail "init changed files while refusing $1"
  sudo rm -rf -- "$case_dir"
}
for name in "${NAMES[@]}"; do
  for kind in missing empty malformed; do
    case_dir="$work/case"
    sudo cp -a "$app" "$case_dir"
    case "$kind" in
      missing) sudo rm -f -- "$case_dir/server-secrets/$name" ;;
      empty) sudo truncate -s 0 "$case_dir/server-secrets/$name" ;;
      malformed) sudo sh -c "printf 'not-a-credential\n' > '$case_dir/server-secrets/$name'" ;;
    esac
    init_refuses "$kind $name"
  done
done
case_dir="$work/case"
sudo cp -a "$app" "$case_dir"
sudo cp "$case_dir/server-secrets/owner-password" "$case_dir/server-secrets/registration-signing"
init_refuses "owner password equal to signing material"
# Root init never follows a link planted in a mounted folder.
case_dir="$work/case"
sudo cp -a "$app" "$case_dir"
sudo mv "$case_dir/server/secret.txt" "$case_dir/server/real-secret.txt"
sudo ln -s real-secret.txt "$case_dir/server/secret.txt"
init_refuses "a link in place of secret.txt"
case_dir="$work/case"
sudo cp -a "$app" "$case_dir"
sudo mv "$case_dir/postgres/pgdata" "$case_dir/postgres/moved-pgdata"
sudo ln -s /nonexistent "$case_dir/postgres/pgdata"
init_refuses "a dangling link in place of pgdata"
# A non-empty PGDATA without PG_VERSION is still an existing database.
case_dir="$work/case"
sudo cp -a "$app" "$case_dir"
sudo rm -f -- "$case_dir/postgres/pgdata/PG_VERSION" "$case_dir/server-secrets/database-password"
init_refuses "a markerless database with database-password missing"

# ── 5. Interrupted first boot keeps the credentials it already wrote ──
step "interrupted first boot"
fresh="$work/interrupted"
sudo mkdir -p "$fresh/server-secrets"
sudo sh -c "head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > '$fresh/server-secrets/owner-password'"
sudo touch "$fresh/server-secrets/registration-signing"
kept="$(sudo sha256sum "$fresh/server-secrets/owner-password" | cut -d' ' -f1)"
render "$fresh"
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init refused an interrupted first boot"
test "$(sudo sha256sum "$fresh/server-secrets/owner-password" | cut -d' ' -f1)" = "$kept" \
  || fail "init replaced a valid owner password on retry"
load_credentials "$fresh"
run_probe full ci_interrupted_user
dc down >/dev/null
sudo rm -rf -- "$fresh"

# ── 6. Upgrade from the previous release ─────────────────────────────
step "upgrade from v0.5.20-beta"
up_dir="$work/upgrade"
mkdir -p "$up_dir"
render "$up_dir" --web-image "$OLD_WEB" --server-image "$OLD_SERVER"
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init failed on the previous release"
load_credentials "$up_dir"
run_probe full ci_upgrade_user
add_sentinel "$up_dir" ci-sentinel-1
upgrade_baseline="$(runtime_hashes)"
dc down >/dev/null
render "$up_dir"
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init failed after the upgrade"
run_probe after-restart ci_upgrade_user
case "$(docker logs silentsuite-server 2>&1)" in
  *"applying database migrations"*) ;;
  *) fail "server did not run migrations after the upgrade" ;;
esac
test "$(runtime_hashes)" = "$upgrade_baseline" || fail "credentials or Django key changed across upgrade"
sentinel_visible ci-sentinel-1 || fail "sentinel lost across upgrade"
load_credentials "$up_dir"
run_probe owner-login ci_upgrade_user

# ── 7. Restore, exactly as documented ────────────────────────────────
step "backup and restore"
dc down >/dev/null
test -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" || fail "containers still running"
sudo cp -a "$up_dir" "$work/backup"
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init failed after the backup"
run_probe full ci_after_backup_user
add_sentinel "$up_dir" ci-sentinel-2
dc down >/dev/null
test -z "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")" || fail "containers still running"
sudo mv "$up_dir" "$work/upgrade-aside"
sudo cp -a "$work/backup" "$up_dir"
sudo mv "$work/backup" "$work/backup-away"  # the restored copy must not depend on the backup
dc up -d >/dev/null
wait_init; test "$INIT_EXIT" = 0 || fail "init failed after the restore"
run_probe after-restart ci_upgrade_user
run_probe absent-account ci_after_backup_user
test "$(runtime_hashes)" = "$upgrade_baseline" || fail "credentials or Django key changed across restore"
sentinel_visible ci-sentinel-1 || fail "backed-up sentinel missing after restore"
if sentinel_visible ci-sentinel-2; then fail "post-backup sentinel survived the restore"; fi
load_credentials "$up_dir"
run_probe owner-login ci_upgrade_user

echo "PASS CasaOS package smoke ($platform)"
echo "NOT COVERED: real CasaOS/ZimaOS install, native clients, browser SDK signup, HTTPS through a real proxy"
