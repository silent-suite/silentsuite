#!/usr/bin/env bash
set -euo pipefail

# SilentSuite self-host server image smoke contract.
# ---------------------------------------------------
# One repository-owned definition of "this image is releasable", invoked
# identically by pre-release CI (locally built image) and by the tag release
# workflow (image pulled back from the registry by digest). Keeping a single
# script is what stops the published contract and the tested contract drifting.
#
# It proves, on the architecture it is running on:
#   1. the image really is the requested platform and carries the expected
#      org.opencontainers.image.revision label;
#   2. the compiled/native wheels import inside the image;
#   3. Django migrations apply against PostgreSQL and leave nothing pending;
#   4. the server answers HTTP;
#   5. ETEBASE_BOOTSTRAP_ADMIN_TOKEN gates the first account;
#   6. ETEBASE_DISABLE_DJANGO_ADMIN removes /admin/, and clearing it restores it;
#   7. TRUSTED_PROXY_IPS is enforced: a forwarded scheme is honoured from the
#      configured proxy address and ignored from any other address;
#   8. a proxy on the host that connects through the 127.0.0.1-published port
#      arrives from the network gateway: 127.0.0.1 alone does not trust it,
#      and the "docker-gateway" entry does, without trusting other containers.
#
# Usage:
#   scripts/self-host-image-smoke.sh --image REF --platform linux/amd64 \
#       [--expect-revision <40-hex commit sha>]

usage() {
  cat <<EOF
Usage: self-host-image-smoke.sh --image <ref> --platform <linux/amd64|linux/arm64>
                                [--expect-revision <sha>]
EOF
}

IMAGE=""
PLATFORM=""
EXPECT_REVISION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --expect-revision) EXPECT_REVISION="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$IMAGE" ] || [ -z "$PLATFORM" ]; then
  echo "ERROR: --image and --platform are required" >&2
  usage >&2
  exit 2
fi

case "$PLATFORM" in
  linux/amd64|linux/arm64) ;;
  *) echo "ERROR: --platform must be linux/amd64 or linux/arm64" >&2; exit 2 ;;
esac

if [ -n "$EXPECT_REVISION" ] && ! printf '%s' "$EXPECT_REVISION" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "ERROR: --expect-revision must be a 40-character lowercase commit SHA" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_NAME="self-host-image-smoke-probe.py"
if [ ! -f "$SCRIPT_DIR/$PROBE_NAME" ]; then
  echo "ERROR: probe script $SCRIPT_DIR/$PROBE_NAME is missing" >&2
  exit 2
fi

# A dedicated subnet so the trusted/untrusted proxy addresses are deterministic.
SUBNET="10.213.7.0/24"
TRUSTED_IP="10.213.7.200"
UNTRUSTED_IP="10.213.7.201"

RUN_ID="$$"
NETWORK="silentsuite-smoke-net-${RUN_ID}"
POSTGRES="silentsuite-smoke-postgres-${RUN_ID}"
SERVER="silentsuite-smoke-server-${RUN_ID}"
WORKDIR="$(mktemp -d)"
BOOTSTRAP_TOKEN="smoke-bootstrap-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
DATABASE_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"

cleanup() {
  status=$?
  if [ $status -ne 0 ]; then
    echo "--- smoke failed; server container logs ---" >&2
    docker logs "$SERVER" 2>&1 | sed "s/^/  /" >&2 || true
  fi
  docker rm -f "$SERVER" >/dev/null 2>&1 || true
  docker rm -f "$POSTGRES" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  exit $status
}
trap cleanup EXIT

echo "== Image identity =="
ACTUAL_PLATFORM="$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE")"
if [ "$ACTUAL_PLATFORM" != "$PLATFORM" ]; then
  echo "ERROR: image reports platform '$ACTUAL_PLATFORM', expected '$PLATFORM'" >&2
  exit 1
fi
ACTUAL_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
if [ -z "$ACTUAL_REVISION" ] || [ "$ACTUAL_REVISION" = "<no value>" ]; then
  echo "ERROR: image has no org.opencontainers.image.revision label" >&2
  exit 1
fi
if [ -n "$EXPECT_REVISION" ] && [ "$ACTUAL_REVISION" != "$EXPECT_REVISION" ]; then
  echo "ERROR: image revision label '$ACTUAL_REVISION' does not match expected '$EXPECT_REVISION'" >&2
  exit 1
fi
echo "platform=$ACTUAL_PLATFORM revision=$ACTUAL_REVISION"

echo "== Fixture stack =="
docker network create --subnet "$SUBNET" "$NETWORK" >/dev/null

# The same immutable digest self-host/docker-compose.yml pins, so the smoke runs
# against the database bytes operators actually get rather than whatever the
# 16.9-alpine tag points at today.
POSTGRES_IMAGE="postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"
docker run -d --name "$POSTGRES" --network "$NETWORK" \
  -e POSTGRES_DB=silentsuite \
  -e POSTGRES_USER=silentsuite \
  -e POSTGRES_PASSWORD="$DATABASE_PASSWORD" \
  "$POSTGRES_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$POSTGRES" pg_isready -U silentsuite -d silentsuite >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! docker exec "$POSTGRES" pg_isready -U silentsuite -d silentsuite >/dev/null 2>&1; then
  echo "ERROR: PostgreSQL fixture never became ready" >&2
  exit 1
fi

# The ini mirrors what install.sh generates, so the smoke exercises the real
# operator configuration path rather than an in-process test harness.
cat > "$WORKDIR/etebase-server.ini" <<INI
[global]
secret_file = /data/secret.txt
debug = false
media_root = /data/media
static_root = /data/static

[allowed_hosts]
allowed_host1 = $SERVER
allowed_host2 = localhost

[database]
engine = django.db.backends.postgresql
name = silentsuite
user = silentsuite
password = $DATABASE_PASSWORD
host = $POSTGRES
port = 5432
INI
chmod 644 "$WORKDIR/etebase-server.ini"

MOUNTS=(
  -e PYTHONPATH=/app
  -v "$WORKDIR/etebase-server.ini:/etc/etebase-server/etebase-server.ini:ro"
  -v "$SCRIPT_DIR/$PROBE_NAME:/smoke/$PROBE_NAME:ro"
)

echo "== Native imports =="
docker run --rm --network "$NETWORK" "${MOUNTS[@]}" "$IMAGE" \
  python "/smoke/$PROBE_NAME" --mode imports --platform "$PLATFORM"

echo "== Migrations =="
docker run --rm --network "$NETWORK" "${MOUNTS[@]}" "$IMAGE" \
  python manage.py migrate --noinput
docker run --rm --network "$NETWORK" "${MOUNTS[@]}" "$IMAGE" \
  python manage.py migrate --check --noinput

start_server() {
  local disable_admin="$1" trusted_ips="${2:-$TRUSTED_IP}"
  local publish=()
  # Like docker-compose.yml: published on host loopback only (any free port).
  if [ "${3:-}" = "publish-loopback" ]; then
    publish=(-p "127.0.0.1::3735")
  fi
  docker rm -f "$SERVER" >/dev/null 2>&1 || true
  docker run -d --name "$SERVER" --network "$NETWORK" \
    ${publish[@]+"${publish[@]}"} \
    -e ETEBASE_BOOTSTRAP_ADMIN_TOKEN="$BOOTSTRAP_TOKEN" \
    -e ETEBASE_DISABLE_DJANGO_ADMIN="$disable_admin" \
    -e ETEBASE_DISABLE_SIGNUP=false \
    -e TRUSTED_PROXY_IPS="$trusted_ips" \
    "${MOUNTS[@]}" \
    "$IMAGE" >/dev/null
}

probe() {
  local ip="$1"
  shift
  docker run --rm --network "$NETWORK" --ip "$ip" "${MOUNTS[@]}" "$IMAGE" \
    python "/smoke/$PROBE_NAME" --base "http://$SERVER:3735" "$@"
}

# A client in the host's network namespace, connecting to the published
# 127.0.0.1 port the way a reverse proxy installed on the host does.
host_probe() {
  local port
  port="$(docker port "$SERVER" 3735/tcp | sed -n 's/^127\.0\.0\.1:\([0-9][0-9]*\)$/\1/p' | head -n 1)"
  if [ -z "$port" ]; then
    echo "ERROR: the server port is not published on host loopback" >&2
    exit 1
  fi
  docker run --rm --network host "${MOUNTS[@]}" "$IMAGE" \
    python "/smoke/$PROBE_NAME" --base "http://localhost:$port" "$@"
}

echo "== Server behaviour (django admin disabled) =="
start_server true
probe "$TRUSTED_IP" --mode wait
probe "$TRUSTED_IP" --mode trusted --token "$BOOTSTRAP_TOKEN"
probe "$UNTRUSTED_IP" --mode untrusted

echo "== Server behaviour (django admin enabled) =="
start_server false
probe "$TRUSTED_IP" --mode wait
probe "$TRUSTED_IP" --mode admin-enabled

echo "== Host proxy through the loopback-published port =="
start_server true "127.0.0.1" publish-loopback
host_probe --mode wait
host_probe --mode untrusted
start_server true "127.0.0.1,docker-gateway" publish-loopback
host_probe --mode wait
host_probe --mode honoured
probe "$UNTRUSTED_IP" --mode untrusted

echo ""
echo "Self-host image smoke contract passed for $PLATFORM ($IMAGE)"
