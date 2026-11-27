#!/usr/bin/env bash
# CI-only throwaway run of the StartOS package's container wiring with Docker.
#
# StartOS runs the package's subcontainers in one network namespace (shared loopback).
# This script does the same with `--network container:<postgres>` and uses the same
# images, commands, users, env names and mount points as self-host/startos/startos/main.ts
# (the contract test pins the shared literals), with one Docker-only difference: the
# postgres image declares VOLUME /var/lib/postgresql/data, which Docker would back with an
# anonymous volume under a parent bind mount, so the database fixture is bound at PGDATA
# itself. StartOS subcontainers do not apply image VOLUME declarations. It then repeats the SDK's
# Backups.withPgDump dump -> fresh initdb -> restore cycle on new volumes.
#
# It does not run StartOS itself: its TLS proxy is simulated by sending
# X-Forwarded-Proto: https (the TLS leg) or nothing (the plaintext leg).
set -euo pipefail

# Keep runner and registry credentials out of every child process.
while IFS= read -r variable; do
  case "$variable" in PATH|RUNNER_TEMP|HOME) ;; *) unset "$variable" ;; esac
done < <(compgen -e)

root="$(cd "$(dirname "$0")/.." && pwd)"
package="$root/self-host/startos"
manifest="$package/startos/manifest/index.ts"

image_ref() {
  local name="$1" ref
  ref="$(sed -n "/^export const ${name} =\$/{n;s/^ *'\\([^']*\\)'\$/\\1/p;}" "$manifest")"
  [[ "$ref" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$ ]] || {
    echo "Unpinned or unreadable image reference: $name" >&2; exit 2; }
  printf '%s' "$ref"
}
server_image="$(image_ref serverImage)"
web_image="$(image_ref webImage)"
postgres_image="$(image_ref postgresImage)"
router_image="$(image_ref routerImage)"

work="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/startos-candidate.XXXXXXXX")"
tag="ss-startos-$(basename "$work" | tr -cd 'a-z0-9')"
export DOCKER_CONFIG="$work/docker-config"
mkdir -m 700 "$DOCKER_CONFIG"
export ROUTER_PORT=18080
containers=()
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  for c in "${containers[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  # Containers created root-owned files, but only in this private fixture.
  sudo rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

for ref in "$server_image" "$web_image" "$postgres_image" "$router_image"; do
  docker pull --quiet "$ref" >/dev/null
done

# Synthetic per-run secrets with the package's shapes (secrets.ts).
export OWNER_PASSWORD="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
export SIGNING="$(openssl rand -hex 32)"
export DB_PASSWORD="$(openssl rand -hex 32)"
INITDB_ARGS="--auth-host=scram-sha-256 --auth-local=trust"
PGDATA=/var/lib/postgresql/data

for dir in db server config db-restored server-restored; do mkdir -p "$work/$dir"; done

run() { containers+=("$1"); }

start_stack() {
  local suffix="$1" db="$2" server_data="$3"
  local pg="$tag-pg-$suffix"
  run "$pg"
  docker run -d --name "$pg" -p "127.0.0.1:$ROUTER_PORT:8080" \
    -v "$db:$PGDATA" \
    -e POSTGRES_DB=silentsuite -e POSTGRES_USER=silentsuite \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_INITDB_ARGS="$INITDB_ARGS" \
    -e PGDATA="$PGDATA" \
    "$postgres_image" -c listen_addresses=127.0.0.1 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$pg" pg_isready -h 127.0.0.1 -U silentsuite -d silentsuite >/dev/null 2>&1 && break
    sleep 2
  done
  docker exec "$pg" pg_isready -h 127.0.0.1 -U silentsuite -d silentsuite >/dev/null

  docker run --rm --network "container:$pg" --user 0:0 \
    -e DATABASE_PASSWORD="$DB_PASSWORD" \
    -v "$server_data:/data" -v "$work/config:/config" \
    -v "$package/assets/bootstrap:/bootstrap:ro" \
    --entrypoint /bin/sh "$server_image" /bootstrap/init.sh >/dev/null

  run "$tag-server-$suffix"
  docker run -d --name "$tag-server-$suffix" --network "container:$pg" \
    -v "$server_data:/data" -v "$work/config:/etc/etebase-server:ro" \
    -v "$package/assets/bootstrap:/bootstrap:ro" \
    -e ETEBASE_EASY_CONFIG_PATH=/etc/etebase-server/etebase-server.ini \
    -e ETEBASE_OWNER_PASSWORD="$OWNER_PASSWORD" \
    -e ETEBASE_REGISTRATION_TOKEN="$SIGNING" \
    -e ETEBASE_DISABLE_DJANGO_ADMIN=true \
    -e CORS_ALLOWED_ORIGINS= \
    -e ETEBASE_SECURE_SSL_REDIRECT=false \
    -e TRUSTED_PROXY_IPS=127.0.0.1 \
    --entrypoint /bin/sh "$server_image" /bootstrap/server-start.sh >/dev/null

  run "$tag-web-$suffix"
  docker run -d --name "$tag-web-$suffix" --network "container:$pg" "$web_image" >/dev/null

  run "$tag-router-$suffix"
  docker run -d --name "$tag-router-$suffix" --network "container:$pg" \
    -v "$package/assets/router:/etc/nginx/conf.d:ro" "$router_image" >/dev/null
  CURRENT_PG="$pg"
  CURRENT_SERVER="$tag-server-$suffix"
}

stop_stack() {
  local suffix="$1"
  for name in router web server pg; do
    docker stop "$tag-$name-$suffix" >/dev/null
    docker rm "$tag-$name-$suffix" >/dev/null
  done
}

failures=0
check() {
  if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi
}

row_check() {
  check "$1: synthetic database row survives" \
    "[ \"\$(docker exec -e PGPASSWORD=\"\$DB_PASSWORD\" $CURRENT_PG psql -w -h 127.0.0.1 -U silentsuite -d silentsuite -tAc 'select v from ci_canary')\" = canary ]"
}

tcp_auth_checks() {
  local label="$1"
  check "$label: TCP login with the stored database password works" \
    "docker exec -e PGPASSWORD=\"\$DB_PASSWORD\" $CURRENT_PG psql -w -h 127.0.0.1 -U silentsuite -d silentsuite -tAc 'select 1' >/dev/null 2>&1"
  check "$label: TCP login with a wrong database password is refused" \
    "! docker exec -e PGPASSWORD=wrong $CURRENT_PG psql -w -h 127.0.0.1 -U silentsuite -d silentsuite -tAc 'select 1' >/dev/null 2>&1"
  check "$label: TCP login without a password is refused" \
    "! docker exec $CURRENT_PG psql -w -h 127.0.0.1 -U silentsuite -d silentsuite -tAc 'select 1' >/dev/null 2>&1"
}

django_checks() {
  local label="$1" effective
  effective="$(docker exec -w /app "$CURRENT_SERVER" python manage.py shell -c \
    "from django.conf import settings as s; d=s.DATABASES['default']; print(d['ENGINE'], d['HOST'], s.MEDIA_ROOT)" 2>/dev/null | tail -1)"
  check "$label: Django uses PostgreSQL on loopback with media under /data" \
    "[ \"\$effective\" = 'django.db.backends.postgresql 127.0.0.1 /data/media' ]"
  check "$label: Django secret is private" \
    "[ \"\$(docker exec $CURRENT_SERVER stat -c %a /data/secret.txt)\" = 600 ]"
  check "$label: server config is mounted read-only" \
    "! docker exec $CURRENT_SERVER sh -c 'touch /etc/etebase-server/x' 2>/dev/null"
}

probe() { python3 "$root/scripts/startos-candidate-probe.py" "$@" || failures=$((failures + 1)); }

# 1. First start.
start_stack first "$work/db" "$work/server"
probe
tcp_auth_checks "first start"
django_checks "first start"
docker exec "$CURRENT_SERVER" sh -c 'umask 077; printf canary > /data/media/ci-canary'
# A synthetic database row next to the account the probe created: both must come back.
docker exec -e PGPASSWORD="$DB_PASSWORD" "$CURRENT_PG" psql -w -h 127.0.0.1 -U silentsuite -d silentsuite \
  -qc "create table ci_canary (v text); insert into ci_canary values ('canary')"
secret_hash="$(sudo sha256sum "$work/server/secret.txt" | cut -d' ' -f1)"

# 2. Restart (init runs again and rewrites the INI; secrets are unchanged).
stop_stack first
start_stack second "$work/db" "$work/server"
probe --after-restart
tcp_auth_checks "restart"
row_check "restart"
check "restart: media file survives" \
  "[ \"\$(docker exec $CURRENT_SERVER cat /data/media/ci-canary)\" = canary ]"
stop_stack second

# 3. Backup and restore the way SDK 4.1.0 Backups.withPgDump does it: pg_dump over the
#    private socket, then initdb (with the package's initdbArgs) + createdb + pg_restore
#    + ALTER USER on an empty volume; other volumes are copied as files.
mkdir -m 777 "$work/dump"
pg_socket() {
  # $1 = data volume, $2 = commands run as the postgres user against a socket-only server.
  docker run --rm --network none --user 0:0 -v "$1:$PGDATA" \
    --entrypoint chown "$postgres_image" -R postgres:postgres "$PGDATA"
  docker run --rm --network none --user postgres -v "$1:$PGDATA" \
    -v "$work/dump:/dump" --entrypoint sh "$postgres_image" -c "set -e; $2"
}
pg_socket "$work/db" "
  pg_ctl start -D $PGDATA -w -o '-c listen_addresses='
  pg_dump -U silentsuite -Fc -f /tmp/silentsuite-db.dump silentsuite
  cp /tmp/silentsuite-db.dump /dump/silentsuite-db.dump
  pg_ctl stop -D $PGDATA -w" >/dev/null
pg_socket "$work/db-restored" "
  initdb -D $PGDATA -U silentsuite $INITDB_ARGS
  pg_ctl start -D $PGDATA -w -o '-c listen_addresses='
  createdb -U silentsuite silentsuite
  cp /dump/silentsuite-db.dump /tmp/silentsuite-db.dump
  pg_restore -U silentsuite -d silentsuite --no-owner --no-privileges /tmp/silentsuite-db.dump
  psql -U silentsuite -d silentsuite -c \"ALTER USER silentsuite WITH PASSWORD '$DB_PASSWORD'\"
  pg_ctl stop -D $PGDATA -w" >/dev/null
sudo cp -a "$work/server/." "$work/server-restored/"

start_stack restored "$work/db-restored" "$work/server-restored"
probe --after-restore
tcp_auth_checks "restore"
row_check "restore"
django_checks "restore"
check "restore: media file is restored" \
  "[ \"\$(docker exec $CURRENT_SERVER cat /data/media/ci-canary)\" = canary ]"
check "restore: Django secret is unchanged" \
  "[ \"\$(sudo sha256sum \"\$work/server-restored/secret.txt\" | cut -d' ' -f1)\" = \"\$secret_hash\" ]"

echo "NOT COVERED: StartOS itself (its TLS proxy, Host handling, plaintext exposure, backup engine) and encrypted collection items/chunks (StartOS VM acceptance)"
[ "$failures" -eq 0 ] || { echo "$failures check group(s) failed" >&2; exit 1; }
