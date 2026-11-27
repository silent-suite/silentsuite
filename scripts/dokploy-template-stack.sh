#!/usr/bin/env bash
# CI-only: boots the SilentSuite Dokploy blueprint as Dokploy v0.31.4 would lay it out, with the
# published digest-pinned images, and checks secrets admission, routing, privacy, persistence,
# upgrade and both backup/restore recipes. Plaintext internal stack; TLS is the real-Dokploy job.
# Never prints generated secrets.
set -euo pipefail

while IFS= read -r variable; do
  case "$variable" in PATH|RUNNER_TEMP) ;; *) unset "$variable" ;; esac
done < <(compgen -e)

root="$(cd "$(dirname "$0")/.." && pwd)"
identity="${1:?release identity (umbrel-images.json of the pinned tag) required}"
platform="${2:?platform required}"
case "$platform" in linux/amd64|linux/arm64) ;; *) echo "Native platform required" >&2; exit 2 ;; esac

work="$(mktemp -d "${RUNNER_TEMP:?RUNNER_TEMP is required}/dokploy-stack.XXXXXXXX")"
export DOCKER_CONFIG="$work/docker-config"
mkdir -m 700 "$DOCKER_CONFIG" "$work/backup"
projects=()
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  for project in "${projects[@]}"; do
    docker compose -p "$project" --project-directory "$work/$project/code" down --volumes --remove-orphans >/dev/null 2>&1 || true
  done
  docker rm -f silentsuite-ci-decoy-server silentsuite-ci-decoy-web silentsuite-ci-decoy-postgres silentsuite-ci-decoy-db >/dev/null 2>&1 || true
  docker network rm dokploy-network silentsuite-iso >/dev/null 2>&1 || true
  sudo rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

python3.12 -m venv "$work/venv"
cat > "$work/requirements.txt" <<'REQUIREMENTS'
PyYAML==6.0.3 \
    --hash=sha256:ba1cc08a7ccde2d2ec775841541641e4548226580ab850948cbfda66a1befcdc \
    --hash=sha256:9149cad251584d5fb4981be1ecde53a1ca46c891a79788c0df828d2f166bda28
REQUIREMENTS
"$work/venv/bin/pip" install --disable-pip-version-check --quiet --require-hashes --only-binary=:all: -r "$work/requirements.txt"
py="$work/venv/bin/python"
blueprint="$root/self-host/dokploy/silentsuite/docker-compose.yml"
umbrel="$root/self-host/umbrel/silentsuite/docker-compose.yml"

image_of() { "$py" -c 'import sys,yaml; print(yaml.safe_load(open(sys.argv[1]))["services"][sys.argv[2]]["image"])' "$1" "$2"; }
new_web="$(image_of "$blueprint" silentsuite-web)"
new_server="$(image_of "$blueprint" silentsuite-server)"
old_web="$(image_of "$umbrel" web)"
old_server="$(image_of "$umbrel" server)"
router_ref="$(image_of "$blueprint" silentsuite)"
postgres_ref="$(image_of "$blueprint" silentsuite-postgres)"
[ "$old_web" != "$new_web" ] && [ "$old_server" != "$new_server" ] || { echo "Upgrade needs older Umbrel pins" >&2; exit 1; }

echo "== Image identity"
"$py" - "$identity" "$new_web" "$new_server" <<'PY'
import json, sys
identity = json.load(open(sys.argv[1]))
for component, reference in (("web", sys.argv[2]), ("server", sys.argv[3])):
    expected = identity[component]
    repository, _, rest = reference.partition(":")
    tag, _, digest = rest.partition("@")
    assert repository == expected["imageRepository"], component
    assert tag == identity["tag"], component
    assert digest == expected["indexDigest"], component
print("PASS pinned web/server digests equal the release identity", identity["tag"])
PY
source_commit="$("$py" -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceCommit"])' "$identity")"
for reference in "$new_web" "$new_server" "$old_web" "$old_server" "$router_ref" "$postgres_ref"; do
  docker pull --quiet --platform "$platform" "$reference" >/dev/null
  test "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$reference")" = "$platform"
done
for reference in "$new_web" "$new_server"; do
  test "$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$reference")" = "$source_commit"
done
echo "PASS images pulled by digest for $platform; app image revisions equal the release source commit"

render() { "$py" "$root/scripts/dokploy-template-render.py" render "$work/$1" "${@:2}"; }
compose() { local project="$1"; shift; docker compose -p "$project" --project-directory "$work/$project/code" -f "$work/$project/code/docker-compose.yml" -f "$work/$project/code/ci-port.yml" "$@"; }
publish() { printf 'services:\n  silentsuite:\n    ports:\n      - "127.0.0.1:%s:8080"\n' "$2" > "$work/$1/code/ci-port.yml"; projects+=("$1"); }
probe_env() {
  local env_file="$work/$1/code/.env"
  ROUTER_PORT="$2" \
  APP_PASSWORD="$(sed -n 's/^SILENTSUITE_INSTALLATION_PASSWORD=//p' "$env_file")" \
  APP_SILENTSUITE_REGISTRATION_SIGNING="$(sed -n 's/^SILENTSUITE_REGISTRATION_SIGNING=//p' "$env_file")" \
    python3.12 "$root/scripts/umbrel-candidate-probe.py" "${@:3}"
}

echo "== Secret admission"
render admission-full
publish admission-full 18089
compose admission-full config --quiet
for name in SILENTSUITE_INSTALLATION_PASSWORD SILENTSUITE_REGISTRATION_SIGNING SILENTSUITE_DB_PASSWORD; do
  for mode in omit empty; do
    project="admission-$mode-$(echo "$name" | tr 'A-Z_' 'a-z-')"
    render "$project" "--$mode" "$name"
    publish "$project" 18089
    if compose "$project" config --quiet >/dev/null 2>"$work/$project/err"; then
      echo "FAIL compose admitted $mode $name" >&2; exit 1
    fi
    grep -q "$name must be set" "$work/$project/err"
    echo "PASS compose refuses $mode $name"
  done
done

echo "== Decoys on dokploy-network"
docker network create dokploy-network >/dev/null
for alias in server web postgres db; do
  docker run -d --pull=never --name "silentsuite-ci-decoy-$alias" --network dokploy-network --network-alias "$alias" "$router_ref" >/dev/null
done

chunk_create() {
  compose "$1" exec -T silentsuite-server python /app/manage.py shell -c '
import hashlib, os, secrets
from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from etebase_server.django.models import Collection, CollectionItemChunk
owner = get_user_model().objects.get(username="ci_candidate_user")
collection = Collection.objects.create(uid="cicollection" + secrets.token_hex(12), owner=owner)
data = os.urandom(8192)
chunk = CollectionItemChunk(uid="cichunk" + secrets.token_hex(12), collection=collection)
chunk.chunkFile.save("chunk", ContentFile(data))
print(chunk.uid, hashlib.sha256(data).hexdigest())' | tail -n 1
}
chunk_check() {
  local label="$2" got
  got="$(compose "$1" exec -T silentsuite-server python /app/manage.py shell -c '
import hashlib
from etebase_server.django.models import CollectionItemChunk
chunk = CollectionItemChunk.objects.get(uid="'"$chunk_uid"'")
with chunk.chunkFile.open("rb") as handle:
    print(hashlib.sha256(handle.read()).hexdigest())' | tail -n 1)"
  test "$got" = "$chunk_digest" || { echo "FAIL chunk bytes after $label" >&2; exit 1; }
  test "$(compose "$1" exec -T silentsuite-server sha256sum /data/secret.txt | cut -d' ' -f1)" = "$secret_digest" \
    || { echo "FAIL secret.txt after $label" >&2; exit 1; }
  echo "PASS chunk bytes and secret.txt unchanged after $label"
}
admin_and_modes() {
  local project="$1" port="$2"
  test "$(compose "$project" exec -T silentsuite-server python -c '
import http.client
c = http.client.HTTPConnection("localhost", 3735, timeout=10)
c.request("GET", "/admin/", headers={"Host": "silentsuite.ci.test"})
r = c.getresponse(); body = r.read()
print("ok" if r.status == 404 and b"Django administration" not in body else "bad")')" = ok
  echo "PASS Django admin route is disabled on the server itself"
  python3.12 - "$port" <<'PY'
import http.client, sys
c = http.client.HTTPConnection("127.0.0.1", int(sys.argv[1]), timeout=20)
c.request("GET", "/admin/", headers={"Host": "silentsuite.ci.test:8443"})
body = c.getresponse().read()
assert b"Django administration" not in body and b"csrfmiddlewaretoken" not in body
print("PASS public /admin/ serves no Django admin")
PY
  test "$(compose "$project" exec -T silentsuite-server stat -c '%U %a' /etc/etebase-server/etebase-server.ini /data/secret.txt | sort -u)" = "etebase 600"
  echo "PASS private INI and secret.txt are owned by the server user, mode 600"
  test "$(docker inspect -f '{{.State.ExitCode}}' "$project-silentsuite-init-1")" = "0"
}
privacy() {
  local project="$1"
  python3.12 "$root/scripts/umbrel-candidate-privacy.py" \
    --server-image "$(docker image inspect -f '{{.Id}}' "$new_server")" \
    --router-image "$(docker image inspect -f '{{.Id}}' "$router_ref")" \
    --startup "$work/$project/files/silentsuite/server-start.sh" \
    --router-config "$work/$project/files/silentsuite/router.conf" \
    --alias silentsuite-server --alias silentsuite-web \
    --work-dir "$work/$project/privacy"
}

echo "== First boot on the previous release pins"
render main --image "$new_web" "$old_web" --image "$new_server" "$old_server"
publish main 18080
compose main up -d >/dev/null
probe_env main 18080
read -r chunk_uid chunk_digest < <(chunk_create main)
[[ "$chunk_uid" =~ ^cichunk[0-9a-f]{24}$ && "$chunk_digest" =~ ^[0-9a-f]{64}$ ]] || { echo "FAIL synthetic chunk" >&2; exit 1; }
secret_digest="$(compose main exec -T silentsuite-server sha256sum /data/secret.txt | cut -d' ' -f1)"
echo "PASS synthetic chunk written on the previous release"

compose main restart silentsuite-server >/dev/null
probe_env main 18080 --after-restart
chunk_check main "server restart"
compose main down >/dev/null
compose main up -d >/dev/null
probe_env main 18080 --after-restart
chunk_check main "redeploy (down/up)"

echo "== Upgrade to the blueprint pins"
"$py" - "$work/main/code/docker-compose.yml" "$old_web" "$new_web" "$old_server" "$new_server" <<'PY'
import sys
path, old_web, new_web, old_server, new_server = sys.argv[1:]
text = open(path).read().replace(old_web, new_web).replace(old_server, new_server)
open(path, "w").write(text)
PY
compose main up -d >/dev/null
probe_env main 18080 --after-restart
chunk_check main "upgrade"
test "$(docker inspect -f '{{.Image}}' main-silentsuite-web-1)" = "$(docker image inspect -f '{{.Id}}' "$new_web")"
test "$(docker inspect -f '{{.Image}}' main-silentsuite-server-1)" = "$(docker image inspect -f '{{.Id}}' "$new_server")"
test "$(docker inspect -f '{{.Image}}' main-silentsuite-init-1)" = "$(docker image inspect -f '{{.Id}}' "$new_server")"
echo "PASS upgraded containers run the blueprint images"
admin_and_modes main 18080
privacy main
for alias in server web postgres db; do
  if docker logs "silentsuite-ci-decoy-$alias" 2>&1 | grep -q '"GET \|"POST '; then
    echo "FAIL decoy $alias received a request" >&2; exit 1
  fi
done
echo "PASS no request reached the generic-name decoys"

echo "== Logical backup and restore"
compose main stop silentsuite silentsuite-web silentsuite-server >/dev/null
compose main exec -T silentsuite-postgres pg_dump -U silentsuite -d silentsuite --format=custom > "$work/backup/db.dump"
docker run --rm --pull=never --network none --entrypoint tar -v main_silentsuite-server-data:/data:ro -v "$work/backup:/backup" \
  "$postgres_ref" -C /data -cpf /backup/server-data.tar .
render restore-logical
publish restore-logical 18082
compose restore-logical create >/dev/null 2>&1
compose restore-logical start silentsuite-postgres >/dev/null
for _ in $(seq 60); do compose restore-logical exec -T silentsuite-postgres pg_isready -U silentsuite -d silentsuite >/dev/null 2>&1 && break; sleep 2; done
compose restore-logical exec -T silentsuite-postgres pg_restore -U silentsuite -d silentsuite --no-owner --exit-on-error < "$work/backup/db.dump"
docker run --rm --pull=never --network none --entrypoint tar -v restore-logical_silentsuite-server-data:/data -v "$work/backup:/backup:ro" \
  "$postgres_ref" -C /data --numeric-owner -xpf /backup/server-data.tar
compose restore-logical up -d >/dev/null
probe_env restore-logical 18082 --after-restart
chunk_check restore-logical "logical restore into a fresh project"

echo "== Physical backup and restore"
compose main stop >/dev/null
docker logs main-silentsuite-postgres-1 2>&1 | grep -q "database system is shut down"
echo "PASS PostgreSQL shut down cleanly before the volume copy"
for volume in silentsuite-postgres-data silentsuite-server-data silentsuite-server-config; do
  docker run --rm --pull=never --network none --entrypoint tar -v "main_$volume:/v:ro" -v "$work/backup:/backup" \
    "$postgres_ref" -C /v -cpf "/backup/$volume.tar" .
done
render restore-physical --carry-from "$work/main/code/.env"
publish restore-physical 18083
compose restore-physical create >/dev/null 2>&1
for volume in silentsuite-postgres-data silentsuite-server-data silentsuite-server-config; do
  docker run --rm --pull=never --network none --entrypoint tar -v "restore-physical_$volume:/v" -v "$work/backup:/backup:ro" \
    "$postgres_ref" -C /v --numeric-owner -xpf "/backup/$volume.tar"
done
compose restore-physical up -d >/dev/null
probe_env restore-physical 18083 --after-restart
chunk_check restore-physical "volume restore into a fresh project"

echo "== Isolated deployment mode"
docker network create silentsuite-iso >/dev/null
render isolated --isolated --isolated-volumes --app-name silentsuite-iso
publish isolated 18084
compose isolated up -d >/dev/null
probe_env isolated 18084
admin_and_modes isolated 18084
echo "PASS stack $platform"
