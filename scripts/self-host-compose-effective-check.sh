#!/usr/bin/env bash
set -euo pipefail

# Effective self-host Compose configuration check (CI, needs Docker Compose).
#
# The static contract tests assert what the tracked Compose file says. This
# asserts what Compose actually resolves it to, including the reverse-proxy
# override the installer generates, because that merged result is what an
# operator's stack really runs.
#
# It renders the configuration only. Nothing is pulled, started, or published,
# and every value below is a harmless placeholder.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is required" >&2; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: Docker Compose v2 is required" >&2; exit 2; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

PLACEHOLDER_IMAGE="ghcr.io/silent-suite/silentsuite-server@sha256:0000000000000000000000000000000000000000000000000000000000000000"
# The fixed database identity, asserted against what Compose actually renders.
EXPECTED_POSTGRES_IMAGE="postgres@sha256:81e77a4833487b8132fe4b00bedd39dc3f74b8641e387f19312a48f7de218c2e"
PROXY_NETWORK="silentsuite-effective-config-proxy"

cp "$ROOT/self-host/docker-compose.yml" "$WORKDIR/docker-compose.yml"
: > "$WORKDIR/success.html"
: > "$WORKDIR/etebase-server.ini"

# Byte-identical to the override install.sh generates; the contract tests assert
# these two stay in step.
cat > "$WORKDIR/docker-compose.override.yml" <<OVERRIDE
# Auto-generated: connects the server to your reverse proxy network.
# Delete this file if you no longer need proxy network integration.
services:
  server:
    networks:
      - silentsuite
      - proxy

networks:
  silentsuite:
    driver: bridge
  proxy:
    external: true
    name: $PROXY_NETWORK
OVERRIDE

cat > "$WORKDIR/.env" <<ENVEOF
SILENTSUITE_SERVER_IMAGE=$PLACEHOLDER_IMAGE
SERVER_PORT=3735
TRUSTED_PROXY_IPS=127.0.0.1
DATABASE_PASSWORD=placeholder-value-not-a-secret
SUPER_USER=admin
SUPER_PASS=placeholder-value-not-a-secret
ETEBASE_DISABLE_SIGNUP=false
ETEBASE_BOOTSTRAP_ADMIN_TOKEN=placeholder-value-not-a-secret
ETEBASE_DISABLE_DJANGO_ADMIN=true
PROXY_NETWORK=$PROXY_NETWORK
ENVEOF

echo "== Rendering the effective configuration =="
(
  cd "$WORKDIR"
  docker compose -f docker-compose.yml -f docker-compose.override.yml config --format json > effective.json
)

PLACEHOLDER_IMAGE="$PLACEHOLDER_IMAGE" PROXY_NETWORK="$PROXY_NETWORK" \
  EXPECTED_POSTGRES_IMAGE="$EXPECTED_POSTGRES_IMAGE" \
  python3 - "$WORKDIR/effective.json" <<'PY'
import json
import os
import sys

effective = json.load(open(sys.argv[1], encoding="utf-8"))
failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


services = effective.get("services", {})
check(set(services) == {"server", "postgres"}, f"services are {sorted(services)}, expected server and postgres")
check(
    set(effective.get("volumes", {})) == {"pgdata", "server_data"},
    f"volumes are {sorted(effective.get('volumes', {}))}, expected pgdata and server_data",
)

server = services.get("server", {})
postgres = services.get("postgres", {})
check(
    server.get("image") == os.environ["PLACEHOLDER_IMAGE"],
    f"server image resolved to {server.get('image')!r}, expected the pinned digest from .env",
)
check(server.get("container_name") == "silentsuite-server", "server container_name changed")
check(postgres.get("container_name") == "silentsuite-postgres", "postgres container_name changed")

# The database identity has to survive the real renderer too: a tag reintroduced
# through an override would resolve here even though the static file looks fine.
postgres_image = postgres.get("image", "")
check(
    postgres_image == os.environ["EXPECTED_POSTGRES_IMAGE"],
    f"postgres image resolved to {postgres_image!r}, expected the pinned index digest",
)
for service_name, service in services.items():
    image = service.get("image", "")
    check(
        "@sha256:" in image,
        f"{service_name} resolved to {image!r}, which is not an immutable digest reference",
    )

server_volumes = {
    (volume.get("source"), volume.get("target"))
    for volume in server.get("volumes", [])
    if volume.get("type") == "volume"
}
check(("server_data", "/data") in server_volumes, f"server_data volume missing, got {server_volumes}")
postgres_volumes = {
    (volume.get("source"), volume.get("target"))
    for volume in postgres.get("volumes", [])
    if volume.get("type") == "volume"
}
check(
    ("pgdata", "/var/lib/postgresql/data") in postgres_volumes,
    f"pgdata volume missing, got {postgres_volumes}",
)

check(set(server.get("networks", {})) == {"silentsuite", "proxy"}, "server is not on both networks")
check(set(postgres.get("networks", {})) == {"silentsuite"}, "postgres left the internal network")

networks = effective.get("networks", {})
check(networks.get("silentsuite", {}).get("driver") == "bridge", "internal network driver changed")
check(networks.get("proxy", {}).get("external") is True, "proxy network is not external")
check(networks.get("proxy", {}).get("name") == os.environ["PROXY_NETWORK"], "proxy network name not honoured")

published = [
    (port.get("host_ip"), str(port.get("published")), str(port.get("target")))
    for port in server.get("ports", [])
]
check(published == [("127.0.0.1", "3735", "3735")], f"server port publication changed: {published}")

if failures:
    for failure in failures:
        print(f"ERROR: {failure}", file=sys.stderr)
    sys.exit(1)
print("effective configuration matches the self-host compatibility contract")
PY

echo "== An unset server image must fail closed =="
(
  cd "$WORKDIR"
  grep -v '^SILENTSUITE_SERVER_IMAGE=' .env > .env.unset
  mv .env.unset .env
  if docker compose -f docker-compose.yml -f docker-compose.override.yml config >/dev/null 2>&1; then
    echo "ERROR: Compose rendered a configuration without SILENTSUITE_SERVER_IMAGE" >&2
    exit 1
  fi
)

echo ""
echo "Self-host Compose compatibility contract verified against the real renderer."
