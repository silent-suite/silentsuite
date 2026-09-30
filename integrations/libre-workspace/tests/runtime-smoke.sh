#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Deployment runtime smoke for the Libre Workspace add-on. CI ONLY: it refuses
# to run anywhere but a disposable GitHub-hosted runner, as root.
#
#   sudo --preserve-env=GITHUB_ACTIONS,RUNNER_ENVIRONMENT \
#     integrations/libre-workspace/tests/runtime-smoke.sh v0.5.10-beta
#
# What is real here:
#   * the .deb built by build-deb.sh, unpacked to its real path
#     /usr/lib/libre-workspace/modules/silentsuite with dpkg-deb -x (apt cannot
#     install it: its libre-workspace-portal dependency does not exist here);
#   * the packaged setup/update/remove scripts, run as root the way the portal
#     runs them (cwd = module directory, env = DOMAIN, ADMIN_PASSWORD, IP,
#     LDAP_DC, LANGUAGE_CODE);
#   * the published release download and verification by the packaged
#     installer, the digest-pinned server and PostgreSQL images, Docker Compose;
#   * Ubuntu's caddy package as a normal systemd service, serving HTTPS for
#     silentsuite.int.de with Caddy's internal CA (the Libre Workspace int.de
#     convention), reached through /etc/hosts.
#
# What is NOT covered: the Libre Workspace portal itself (task queue, Addon
# Center upload, dashboard tile, icon, /etc/hosts and Samba DNS entries), a
# public certificate, arm64. This is not Libre Workspace acceptance.
#
# Secrets (database password, Django superuser password, bootstrap token, the
# fake portal ADMIN_PASSWORD) are registered with ::add-mask:: before any
# script output is printed, are never echoed, and reach the signup probe only
# through an environment variable.

set -euo pipefail

fail() {
  echo "::error::libre-workspace add-on runtime smoke: $*"
  exit 1
}
step() { printf '\n== %s ==\n' "$*"; }

if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
  echo "ERROR: this smoke installs packages and services as root; it only runs on a disposable GitHub-hosted runner." >&2
  exit 2
fi
[ "$(id -u)" = "0" ] || fail "must run as root"

RELEASE="${1:-}"
printf '%s' "$RELEASE" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' || fail "usage: runtime-smoke.sh <release tag>"

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ADDON="$(cd -- "$HERE/.." && pwd -P)"
REPO_ROOT="$(cd -- "$ADDON/../.." && pwd -P)"
WORK="$(mktemp -d)"
MODULE=/usr/lib/libre-workspace/modules/silentsuite
DOMAIN=int.de
HOST=silentsuite.int.de
MARKER=/root/silentsuite
INSTALL="$MARKER/silentsuite-server"
CA_ROOT=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
PROBE="$REPO_ROOT/scripts/self-host-image-smoke-probe.py"

mask() {
  if [ -n "$1" ]; then
    echo "::add-mask::$1"
  fi
}
SECRETS=()
PORTAL_SECRET="portal-$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
mask "$PORTAL_SECRET"
SECRETS+=("$PORTAL_SECRET")

# Mask every secret the installer generated, wherever the add-on left it.
collect_install_secrets() {
  local env_file key value
  for env_file in /root/silentsuite/silentsuite-server/.env /root/silentsuite-*/silentsuite-server/.env; do
    [ -f "$env_file" ] || continue
    for key in DATABASE_PASSWORD SUPER_PASS ETEBASE_BOOTSTRAP_ADMIN_TOKEN; do
      value="$(grep -E "^$key=" "$env_file" | head -n 1 | cut -d= -f2-)"
      if [ -n "$value" ]; then
        mask "$value"
        SECRETS+=("$value")
      fi
    done
  done
}

portal_run() {
  local script="$1" output="$WORK/$1.out" rc=0
  (
    cd "$MODULE" &&
      env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
        DOMAIN="$DOMAIN" ADMIN_PASSWORD="$PORTAL_SECRET" IP=127.0.0.1 \
        LDAP_DC="dc=int,dc=de" LANGUAGE_CODE=en \
        /usr/bin/bash "$script"
  ) > "$output" 2>&1 || rc=$?
  collect_install_secrets
  echo "--- $script output (exit $rc) ---"
  cat "$output"
  echo "--- end $script output ---"
  return "$rc"
}

assert_output_has_no_secrets() {
  local output="$1" secret
  for secret in "${SECRETS[@]}"; do
    if grep -qF -- "$secret" "$output"; then
      fail "a secret appeared in $(basename "$output")"
    fi
  done
}

our_containers() {
  docker ps -a --format '{{.Names}}' | grep -xE 'silentsuite-(postgres|server)' || true
}

https_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --cacert "$CA_ROOT" "https://$HOST/" 2>/dev/null || true
}

step "Real Caddy service (Ubuntu package)"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null
systemctl is-active --quiet caddy || fail "caddy service is not active after install"
caddy version
cp -p /etc/caddy/Caddyfile "$WORK/Caddyfile.orig"
echo "127.0.0.1 $HOST" >> /etc/hosts

step "Build the package and unpack it to the module path"
bash "$ADDON/build-deb.sh" --release "$RELEASE" --out-dir "$WORK/pkg"
DEB="$(ls "$WORK"/pkg/*.deb)"
dpkg-deb -x "$DEB" /
[ -x "$MODULE/setup_silentsuite.sh" ] || fail "module scripts were not unpacked"
grep -qxF "$RELEASE" "$MODULE/silentsuite-release" || fail "package does not pin $RELEASE"

step "Setup (as the portal runs it)"
portal_run setup_silentsuite.sh || fail "setup failed"
assert_output_has_no_secrets "$WORK/setup_silentsuite.sh.out"
[ -d "$MARKER" ] || fail "marker $MARKER missing after setup"
grep -qxF "release=$RELEASE" "$MARKER/addon-state" || fail "state does not record $RELEASE"
if grep -rqF -- "$PORTAL_SECRET" "$MARKER" /etc/caddy; then
  fail "ADMIN_PASSWORD was written to disk"
fi

step "Database and server are real and healthy"
for container in silentsuite-postgres silentsuite-server; do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container")"
  [ "$status" = "healthy" ] || fail "$container is $status"
done
docker exec silentsuite-postgres pg_isready -U silentsuite -d silentsuite
migrations="$(docker exec silentsuite-postgres psql -U silentsuite -d silentsuite -tAc 'select count(*) from django_migrations')"
[ "${migrations:-0}" -gt 0 ] || fail "no Django migrations recorded in PostgreSQL"
echo "django_migrations rows: $migrations"

step "The server trusts exactly loopback and its Compose network gateway"
NETWORK_GATEWAYS="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' silentsuite-server | xargs)"
STATE_GATEWAY="$(grep -E '^trusted_proxy=' "$MARKER/addon-state" | cut -d= -f2-)"
[ -n "$STATE_GATEWAY" ] && [ "$NETWORK_GATEWAYS" = "$STATE_GATEWAY" ] ||
  fail "recorded trusted proxy '$STATE_GATEWAY' is not the server network gateway '$NETWORK_GATEWAYS'"
RUNNING_TRUST="$(docker exec silentsuite-server printenv TRUSTED_PROXY_IPS)"
[ "$RUNNING_TRUST" = "127.0.0.1,$STATE_GATEWAY" ] || fail "running server trusts '$RUNNING_TRUST'"
docker port silentsuite-server 3735/tcp | grep -qxF "127.0.0.1:3735" || fail "server port is not published on loopback only"
[ "$(docker port silentsuite-server 3735/tcp | wc -l)" = "1" ] || fail "server port is published more than once"
echo "TRUSTED_PROXY_IPS=$RUNNING_TRUST; published on 127.0.0.1:3735 only"
SERVER_IMAGE="$(grep -E '^SILENTSUITE_SERVER_IMAGE=' "$INSTALL/.env" | cut -d= -f2-)"
printf '%s' "$SERVER_IMAGE" | grep -Eqx 'ghcr\.io/silent-suite/silentsuite-server@sha256:[0-9a-f]{64}' ||
  fail "server image is not digest-pinned"

step "Caddy serves HTTPS for $HOST"
[ "$(grep -cxF "$HOST {" /etc/caddy/Caddyfile)" = "1" ] || fail "expected exactly one site block for $HOST"
cmp -s <(head -c "$(stat -c %s "$WORK/Caddyfile.orig")" /etc/caddy/Caddyfile) "$WORK/Caddyfile.orig" ||
  fail "setup changed existing Caddyfile content"
status=""
for _ in $(seq 1 30); do
  if [ -f "$CA_ROOT" ]; then
    status="$(https_status)"
    [ "$status" = "200" ] && break
  else
    curl -sk -o /dev/null --max-time 5 "https://$HOST/" || true
  fi
  sleep 2
done
[ -f "$CA_ROOT" ] || fail "Caddy's internal CA root was not created"
if [ "$status" != "200" ]; then
  # Status line and redirect target only: no headers that could carry state.
  curl -sS -o /dev/null -D - --max-time 15 --cacert "$CA_ROOT" "https://$HOST/" 2>&1 |
    grep -iE '^(HTTP/|location:)' || true
  fail "https://$HOST/ answered '$status' through Caddy, expected 200"
fi
echo "https://$HOST/ -> HTTP $status (certificate verified against Caddy's internal CA)"

step "First account is gated by the one-time token (over HTTPS through Caddy)"
SMOKE_TOKEN="$(grep -E '^ETEBASE_BOOTSTRAP_ADMIN_TOKEN=' "$INSTALL/.env" | cut -d= -f2-)"
[ -n "$SMOKE_TOKEN" ] || fail "no bootstrap token was generated"
export SMOKE_TOKEN
# Caddy keeps its CA root readable only by the caddy user, and the probe runs
# as the image's non-root user. Hand it a 0644 copy of the PUBLIC root
# certificate only (never the private key beside it).
PROBE_CA="$WORK/ca.crt"
grep -q -- '-----BEGIN CERTIFICATE-----' "$CA_ROOT" || fail "Caddy's CA root is not a PEM certificate"
if grep -q -- 'PRIVATE KEY' "$CA_ROOT"; then
  fail "Caddy's CA root file contains key material; refusing to share it"
fi
install -m 0644 -- "$CA_ROOT" "$PROBE_CA"
[ "$(stat -c %a "$PROBE_CA")" = "644" ] || fail "could not make a readable copy of the CA certificate"
# The shared image-smoke probe only speaks plain HTTP (its boundary is the
# container port), so only its msgpack body/decoder are reused here; the
# requests go over real HTTPS through Caddy, verified against Caddy's CA.
docker run --rm -i --network host --add-host "$HOST:127.0.0.1" \
  -e SMOKE_TOKEN \
  -v "$PROBE_CA:/smoke/ca.crt:ro" -v "$PROBE:/smoke/probe.py:ro" \
  --entrypoint python3 "$SERVER_IMAGE" - "$HOST" <<'PY'
import http.client, importlib.util, os, ssl, sys
spec = importlib.util.spec_from_file_location("probe", "/smoke/probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
host = sys.argv[1]
context = ssl.create_default_context(cafile="/smoke/ca.crt")

def signup(token):
    path = f"{probe.API_PREFIX}/signup/"
    if token is not None:
        path = f"{path}?bootstrap_token={token}"
    connection = http.client.HTTPSConnection(host, 443, context=context, timeout=20)
    try:
        connection.request(
            "POST", path,
            body=probe.signup_body("lwadmin", "lwadmin@example.invalid"),
            headers={"Content-Type": "application/msgpack", "Accept": "application/msgpack"},
        )
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()

for label, token in (("no token", None), ("wrong token", "not-the-token")):
    status, payload = signup(token)
    try:
        code = probe.decode_msgpack(payload).get("code") if payload else None
    except Exception:
        code = None
    if status != 403 or code != "bootstrap_token_required":
        sys.exit(f"first signup with {label} was not refused (HTTP {status}, code {code})")
    print(f"first signup with {label}: refused (403 bootstrap_token_required)")
status, _ = signup(os.environ["SMOKE_TOKEN"])
if status not in (200, 201):
    sys.exit(f"first signup with the stored token failed (HTTP {status})")
print(f"first signup with the stored token: accepted (HTTP {status})")
PY
unset SMOKE_TOKEN

step "Update is a no-op"
before="$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' silentsuite-postgres silentsuite-server)"
cp /etc/caddy/Caddyfile "$WORK/Caddyfile.installed"
portal_run update_silentsuite.sh || fail "update failed"
assert_output_has_no_secrets "$WORK/update_silentsuite.sh.out"
grep -qF "automatic updates are disabled" "$WORK/update_silentsuite.sh.out" || fail "update did not explain the manual boundary"
grep -qF "still matches the server network's gateway" "$WORK/update_silentsuite.sh.out" || fail "update did not confirm the trusted proxy address"
after="$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' silentsuite-postgres silentsuite-server)"
[ "$before" = "$after" ] || fail "update recreated or restarted containers"
cmp -s /etc/caddy/Caddyfile "$WORK/Caddyfile.installed" || fail "update changed the Caddyfile"

step "Remove keeps the data"
portal_run remove_silentsuite.sh || fail "remove failed"
assert_output_has_no_secrets "$WORK/remove_silentsuite.sh.out"
[ -z "$(our_containers)" ] || fail "containers remain after remove: $(our_containers)"
for volume in silentsuite-server_pgdata silentsuite-server_server_data; do
  docker volume inspect "$volume" >/dev/null || fail "volume $volume was deleted"
done
# The exact digest the packaged installer pins, and the one the retained
# Compose file actually ran.
POSTGRES_IMAGE="$(sed -n 's/^POSTGRES_IMAGE="\(postgres@sha256:[0-9a-f]\{64\}\)"$/\1/p' "$MODULE/install.sh")"
[ "$(printf '%s\n' "$POSTGRES_IMAGE" | grep -c .)" = "1" ] || fail "could not read the pinned PostgreSQL digest from install.sh"
RETAINED_COMPOSE="$(ls /root/silentsuite-removed-*/silentsuite-server/docker-compose.yml)"
[ "$(printf '%s\n' "$RETAINED_COMPOSE" | wc -l)" = "1" ] || fail "expected exactly one retained installation"
[ "$(grep -cxF "    image: $POSTGRES_IMAGE" "$RETAINED_COMPOSE")" = "1" ] || fail "retained compose does not run $POSTGRES_IMAGE"
docker run --rm -v silentsuite-server_pgdata:/var/lib/postgresql/data:ro --entrypoint cat "$POSTGRES_IMAGE" \
  /var/lib/postgresql/data/PG_VERSION >/dev/null || fail "the database volume has no cluster"
[ ! -e "$MARKER" ] || fail "$MARKER still exists after remove"
ls -d /root/silentsuite-removed-*/silentsuite-server/.env >/dev/null || fail "configuration was not retained"
cmp -s /etc/caddy/Caddyfile "$WORK/Caddyfile.orig" || fail "Caddyfile is not byte-identical to before setup"
systemctl is-active --quiet caddy || fail "caddy is not active after remove"
status="$(https_status)"
[ "$status" != "200" ] || fail "https://$HOST/ is still served after remove"
echo "after remove: containers gone, volumes kept, Caddyfile restored, https://$HOST/ -> '${status:-no answer}'"

step "Reinstall over retained data is refused"
rc=0
portal_run setup_silentsuite.sh || rc=$?
[ "$rc" -ne 0 ] || fail "setup succeeded over retained volumes"
assert_output_has_no_secrets "$WORK/setup_silentsuite.sh.out"
grep -qF "silentsuite-server_pgdata" "$WORK/setup_silentsuite.sh.out" || fail "refusal did not name the retained volume"
[ ! -e "$MARKER" ] || fail "refused setup created $MARKER"
cmp -s /etc/caddy/Caddyfile "$WORK/Caddyfile.orig" || fail "refused setup changed the Caddyfile"

echo
echo "PASS: Libre Workspace add-on deployment runtime smoke ($RELEASE, linux/amd64)."
echo "      Not Libre Workspace portal acceptance: the portal itself was not installed."
