#!/usr/bin/env bash
# CI-only checks of the SilentSuite TrueNAS app (self-host/truenas/silentsuite).
#
#   truenas-candidate-smoke.sh <truenas-apps-checkout> <pinned-renderer-image>
#
# Stage 1 runs TrueNAS's own CI script on the committed public test values (fake
# credentials only: its output, including expanded Compose, may appear in the log).
# Stages 2-4 use per-run random secrets and a per-run CA; their render output and
# container data stay in a private work directory and are never printed or uploaded.
# Run only on a disposable GitHub-hosted runner: the renderer mounts the Docker socket.
set -euo pipefail

# Keep runner credentials out of every child process.
while IFS= read -r variable; do
  case "$variable" in PATH|HOME|RUNNER_TEMP) ;; *) unset "$variable" ;; esac
done < <(compgen -e)

root="$(cd "$(dirname "$0")/.." && pwd)"
apps="$(cd "${1:?truenas/apps checkout required}" && pwd)"
renderer="${2:?pinned renderer image required}"
[[ "$renderer" =~ ^ghcr\.io/truenas/apps_validation@sha256:[0-9a-f]{64}$ ]] || { echo "Renderer must be digest-pinned" >&2; exit 2; }

source_app="$root/self-host/truenas/silentsuite"
app="$apps/ix-dev/community/silentsuite"
[ ! -L "$source_app" ] && [ ! -e "$app" ] || { echo "Unexpected package or target" >&2; exit 2; }

work="$(mktemp -d "${RUNNER_TEMP:?}/truenas-candidate.XXXXXXXX")"
chmod 700 "$work"
mnt="/opt/tests/mnt/silentsuite-$(basename "$work" | tr -cd 'a-zA-Z0-9')"
export DOCKER_CONFIG="$work/docker-config"
mkdir -m 700 "$DOCKER_CONFIG" "$work/state" "$work/probe"
project=""
compose=""
port=30634

down() {
  if [ -n "$project" ] && [ -f "$compose" ]; then
    docker compose -p "$project" -f "$compose" down --remove-orphans >/dev/null 2>&1 || true
  fi
  project=""
}
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  down
  sudo rm -rf -- "$work" "$mnt"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

fail() { echo "FAIL $1" >&2; exit 1; }
pass() { echo "PASS $1"; }

cp -R -P -- "$source_app" "$app"
common="$apps/.github/scripts/common.py"
grep -qx 'CONTAINER_IMAGE = "ghcr.io/truenas/apps_validation:slim"' "$common" || fail "renderer reference moved upstream"
sed -i "s|^CONTAINER_IMAGE = \"ghcr.io/truenas/apps_validation:slim\"$|CONTAINER_IMAGE = \"$renderer\"|" "$common"

ci() { (cd "$apps" && python3 .github/scripts/ci.py --app silentsuite --train community "$@"); }

# ── Stage 1: TrueNAS's own checks on the public fixtures ───────────────
for values in basic-values.yaml proxy-values.yaml hostpath-values.yaml; do
  echo "::group::TrueNAS ci.py $values"
  sudo mkdir -p /opt/tests/mnt/host/data /opt/tests/mnt/host/postgres_data
  ci --test-file "$values"
  sudo rm -rf /opt/tests/mnt
  echo "::endgroup::"
  pass "TrueNAS ci.py deploys $values to healthy"
done
(cd "$apps" && PYTHONPATH=.github/scripts python3 .github/scripts/port_validation.py)
pass "catalog port validation"
if ! diff -r -x library -x rendered "$source_app" "$app"; then
  fail "committed package differs from what TrueNAS's metadata scripts generate (diff above)"
fi
pass "committed metadata matches the TrueNAS generators"

negative() {
  local name="$1" expected="$2" edit="$3"
  python3 - "$app/templates/test_values/proxy-values.yaml" "$app/templates/test_values/neg-values.yaml" "$edit" <<'PY'
import sys, yaml
values = yaml.safe_load(open(sys.argv[1]))
exec(sys.argv[3], {"v": values})
yaml.safe_dump(values, open(sys.argv[2], "w"))
PY
  if ci --test-file neg-values.yaml --render-only=true --skip-metadata >"$work/neg.log" 2>&1; then
    fail "render accepted: $name"
  fi
  grep -qF "$expected" "$work/neg.log" || fail "render refused without the expected message: $name"
  rm -f "$app/templates/test_values/neg-values.yaml"
  pass "render refuses $name"
}
negative "a trailing space in the database password" "must not start or end with spaces" 'v["silentsuite"]["db_password"] += " "'
negative "a leading space in the database password" "must not start or end with spaces" 'v["silentsuite"]["db_password"] = " " + v["silentsuite"]["db_password"]'
negative "a line break in the database password" "must not start or end with spaces" 'v["silentsuite"]["db_password"] = "abc\ndef"'
negative "neither a certificate nor the HTTPS proxy option" "Select a certificate" 'v["network"]["behind_https_proxy"] = False'
negative "mismatched web and server release tags" "same release tag" 'v["images"] = {"web_image": {"repository": "ghcr.io/silent-suite/silentsuite-web-selfhost", "tag": "v0.0.1-beta"}}'

# ── Private fixture helpers ────────────────────────────────────────────
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=SilentSuite CI CA" \
  -keyout "$work/ca.key" -out "$work/probe/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=silentsuite.ci.test" \
  -keyout "$work/tls.key" -out "$work/tls.csr" 2>/dev/null
printf 'subjectAltName=DNS:silentsuite.ci.test\nextendedKeyUsage=serverAuth\n' > "$work/tls.ext"
openssl x509 -req -in "$work/tls.csr" -CA "$work/probe/ca.pem" -CAkey "$work/ca.key" -CAcreateserial \
  -days 2 -extfile "$work/tls.ext" -out "$work/tls.pem" 2>/dev/null
cp "$root/scripts/truenas-candidate-probe.py" "$work/probe/probe.py"
chmod -R a+rX "$work/probe"
chmod 777 "$work/state"

installation_password="$(openssl rand -hex 24)"
db_password="$(openssl rand -hex 8) %ci $(openssl rand -hex 8)"
export PROBE_INSTALLATION_PASSWORD="$installation_password" PROBE_PUBLIC_PORT="$port" PROBE_CA_FILE="$work/probe/ca.pem"

# render_private MODE NAME [DATA_TYPE]: MODE is tls or proxy; DATA_TYPE ix_volume or host_path.
render_private() {
  local mode="$1" name="$2" data_type="${3:-ix_volume}"
  python3 - "$app/templates/test_values/zz-private-values.yaml" "$mode" "$data_type" "$mnt" "$work" <<'PY'
import os, sys, yaml
out, mode, data_type, mnt, work = sys.argv[1:6]
storage = {}
for key in ("data", "postgres_data"):
    if key == "data" and data_type == "host_path":
        storage[key] = {"type": "host_path", "host_path_config": {
            "acl_enable": False, "path": f"{mnt}/{key}", "auto_permissions": False}}
    else:
        storage[key] = {"type": "ix_volume", "ix_volume_config": {"dataset_name": key, "create_host_path": True}}
values = {
    "resources": {"limits": {"cpus": 2.0, "memory": 4096}},
    "TZ": "Etc/UTC",
    "silentsuite": {
        "installation_password": os.environ["PROBE_INSTALLATION_PASSWORD"],
        "db_password": os.environ["PRIVATE_DB_PASSWORD"],
        "additional_envs": [],
    },
    "network": {
        "web_port": {"bind_mode": "published", "port_number": int(os.environ["PROBE_PUBLIC_PORT"])},
        "certificate_id": "1" if mode == "tls" else None,
        "behind_https_proxy": mode == "proxy",
        "networks": [],
    },
    "ix_volumes": {"data": f"{mnt}/data", "postgres_data": f"{mnt}/postgres_data"},
    "storage": storage,
    "labels": [],
}
if mode == "tls":
    values["ix_certificates"] = {"1": {
        "certificate": open(f"{work}/tls.pem").read(),
        "privatekey": open(f"{work}/tls.key").read(),
    }}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as handle:
    yaml.safe_dump(values, handle)
PY
  if ! PRIVATE_DB_PASSWORD="$db_password" ci --test-file zz-private-values.yaml --render-only=true --skip-metadata \
      >"$work/render-$name.log" 2>&1; then
    fail "private render $name (log withheld: it holds per-run secrets)"
  fi
  rm -f "$app/templates/test_values/zz-private-values.yaml"
  compose="$work/compose-$name.yaml"
  install -m 600 "$app/templates/rendered/docker-compose.yaml" "$compose"
  rm -f "$app/templates/rendered/docker-compose.yaml"
}
export PRIVATE_DB_PASSWORD="$db_password"

# up NAME [SERVICE...]: start the rendered stack (or only SERVICE and its dependencies).
up() {
  project="ss-truenas-$1"
  shift
  docker compose -p "$project" -f "$compose" up -d "$@" >/dev/null 2>"$work/up.log" || {
    docker compose -p "$project" -f "$compose" ps -a --format '{{.Service}} {{.State}} {{.Status}}' >&2 || true
    fail "compose up $project"
  }
}
cid() { docker compose -p "$project" -f "$compose" ps -aq "$1"; }
helper() {
  docker run --rm --pull=never --network "container:$(cid router)" --user "$(id -u):$(id -g)" \
    -v "$work/probe:/probe:ro" -v "$work/state:/state" \
    -e PROBE_PUBLIC_PORT -e PROBE_INSTALLATION_PASSWORD -e PROBE_CA_FILE=/probe/ca.pem \
    --entrypoint python "$server_image" /probe/probe.py "$@"
}
hashes() { sudo sha256sum "$mnt/data/secret.txt" "$mnt/data/registration-signing" "$mnt/data/media/ci-sentinel" | cut -d' ' -f1; }
wait_for_log() {
  local service="$1" needle="$2" deadline=$((SECONDS + 180))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if docker compose -p "$project" -f "$compose" logs --no-color "$service" 2>/dev/null | grep -qF "$needle"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# ── Stage 2: HTTPS stack with private secrets ──────────────────────────
render_private tls tls
up tls
server_image="$(docker inspect -f '{{.Config.Image}}' "$(cid server)")"
server_user="$(docker inspect -f '{{.Config.User}}' "$(cid server)")"
server_uid="${server_user%%:*}"
server_gid="${server_user##*:}"
[ "$server_user" = "568:568" ] || fail "server must run as the TrueNAS apps user"
python3 "$work/probe/probe.py" published
helper account

published=""
for container in $(docker compose -p "$project" -f "$compose" ps -q); do
  if [ -n "$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{$p}}{{end}}' "$container")" ]; then
    published="$published $(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
  fi
done
[ "$published" = " router" ] || fail "only the router may publish a port (got:$published)"
pass "only the router publishes a host port"

for name in secret.txt registration-signing; do
  [ "$(sudo stat -c '%u %a' "$mnt/data/$name")" = "$server_uid 600" ] || fail "$name owner/mode"
done
pass "secret files are mode 600 and owned by the server user"
[ -z "$(sudo find "$mnt/data" -maxdepth 1 -name '*.ini')" ] || fail "server configuration written to the data dataset"
pass "server configuration is not on the data dataset"

sudo sh -c "umask 077; head -c 4096 /dev/urandom > '$mnt/data/media/ci-sentinel'"
sudo chown "$server_uid:$server_gid" "$mnt/data/media/ci-sentinel"
hashes > "$work/hashes.before"

marker="ci-marker-$(openssl rand -hex 8)"
python3 "$work/probe/probe.py" markers "$marker"
docker compose -p "$project" -f "$compose" stop server >/dev/null 2>&1
python3 "$work/probe/probe.py" markers "$marker" --after-stop
docker compose -p "$project" -f "$compose" logs --no-color >"$work/logs.txt" 2>&1
grep -qF "$marker" "$work/logs.txt" && fail "request paths appear in container logs"
pass "no request path markers in router, server or web logs"
signing="$(sudo cat "$mnt/data/registration-signing")"
for secret in "$installation_password" "$db_password" "$signing"; do
  grep -qF -- "$secret" "$work/logs.txt" && fail "a per-run secret appears in container logs"
done
pass "no per-run secrets in container logs"

down
up tls
helper after
hashes | cmp -s - "$work/hashes.before" || fail "data keys or media changed across recreation"
pass "secret.txt, registration-signing and media unchanged across recreation"

down
sudo cp -a "$mnt" "$work/backup"
sudo rm -rf "$mnt"
sudo cp -a "$work/backup" "$mnt"
up tls
helper after
hashes | cmp -s - "$work/hashes.before" || fail "data keys or media changed across restore"
pass "secret.txt, registration-signing and media unchanged across a stop/copy/wipe/restore"
down
sudo rm -rf "$mnt" "$work/backup"

# ── Stage 3: proxy mode refuses plain-http LAN origins ────────────────
render_private proxy proxy
up proxy
helper http-origin
down
sudo rm -rf "$mnt"

# ── Stage 4: host-path ownership rules ────────────────────────────────
render_private proxy hp-unwritable host_path
sudo mkdir -p "$mnt/data" && sudo chown 0:0 "$mnt/data" && sudo chmod 755 "$mnt/data"
up hp-unwritable server
wait_for_log server "the data directory is not writable" || fail "unwritable host path did not produce the package diagnostic"
[ -z "$(sudo ls -A "$mnt/data")" ] || fail "server wrote into an unwritable host path"
pass "unwritable host path is refused before anything is created"
down
sudo rm -rf "$mnt"

render_private proxy hp-link host_path
sudo mkdir -p "$mnt/data" && sudo chown "$server_uid:$server_gid" "$mnt/data" && sudo chmod 700 "$mnt/data"
sudo ln -s /data/ci-link-target "$mnt/data/registration-signing"
up hp-link server
wait_for_log server "registration-signing is a symbolic link" || fail "dangling signing link was not refused"
sudo test ! -e "$mnt/data/ci-link-target" || fail "the dangling link's target was created"
pass "dangling registration-signing link is refused and its target left absent"
down
sudo rm -rf "$mnt"

render_private proxy hp-mode host_path
sudo mkdir -p "$mnt/data" && sudo chown "$server_uid:$server_gid" "$mnt/data" && sudo chmod 700 "$mnt/data"
sudo sh -c "head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' > '$mnt/data/secret.txt'"
sudo chown "$server_uid:$server_gid" "$mnt/data/secret.txt" && sudo chmod 644 "$mnt/data/secret.txt"
before="$(sudo sha256sum "$mnt/data/secret.txt" | cut -d' ' -f1)"
up hp-mode server
wait_for_log server "starting uvicorn" || fail "host-path stack with a prepared data directory did not start"
[ "$(sudo stat -c '%a' "$mnt/data/secret.txt")" = "600" ] || fail "existing secret.txt mode not repaired"
[ "$(sudo sha256sum "$mnt/data/secret.txt" | cut -d' ' -f1)" = "$before" ] || fail "existing secret.txt content changed"
pass "existing secret.txt is kept and repaired to mode 600"
down

echo "NOT COVERED: a real TrueNAS host, browser sign-in, mobile/desktop clients"
