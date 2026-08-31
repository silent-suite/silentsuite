#!/usr/bin/env bash
# Behavioural fixture for self-host/backup.sh.
#
# Runs a throwaway Compose stack on a GitHub-hosted AMD64 runner and proves the
# properties a static test cannot: that the helper resolves the physical volume
# from the live container under both a default and a custom project name, that
# it produces an exact, checksummed, non-empty backup, that it leaves the old
# guessed-name volumes strictly alone, and that bind, shared, redirected and
# option-bearing identities are refused before any backup directory exists.
#
# Everything it creates is suffixed with a random token and removed on exit. It
# needs no credentials, writes no packages and touches nothing outside its own
# temporary directory, project names and volumes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HELPER="$ROOT/self-host/backup.sh"

# The same immutable PostgreSQL identity self-host/docker-compose.yml pins. It
# stands in for both fixture services: it has pg_dump, psql and a tar, so the
# whole fixture runs on one image and never resolves a mutable tag.
IMAGE="postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"

SUFFIX="$$-$(date +%s)"
WORK="$(mktemp -d)"
PROJECTS=()
VOLUMES=()
FAILURES=0

cleanup() {
  status=$?
  # Each entry is "<install dir>|<project or empty>"; the stack is torn down
  # from the directory that defined it so Compose sees the same project.
  for entry in "${PROJECTS[@]:-}"; do
    [ -n "$entry" ] || continue
    stack_dir="${entry%%|*}"
    stack_project="${entry#*|}"
    [ -d "$stack_dir" ] || continue
    if [ -n "$stack_project" ]; then
      ( cd "$stack_dir" && COMPOSE_PROJECT_NAME="$stack_project" \
        docker compose down -v --remove-orphans ) >/dev/null 2>&1 || true
    else
      ( cd "$stack_dir" && docker compose down -v --remove-orphans ) >/dev/null 2>&1 || true
    fi
  done
  for volume in "${VOLUMES[@]:-}"; do
    [ -n "$volume" ] || continue
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
  done
  rm -rf -- "$WORK"
  exit "$status"
}
trap cleanup EXIT

note() { printf '\n=== %s\n' "$*"; }
pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; FAILURES=$((FAILURES + 1)); }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (expected '$2', got '$1')"; fi; }

# ── Fixture stack ─────────────────────────────────────────────────────

write_install_dir() {
  # $1 install dir, $2 variant
  dir="$1"
  variant="$2"
  mkdir -p "$dir"

  server_mount="      - server_data:/data"
  volume_block=$'volumes:\n  pgdata:\n  server_data:'

  case "$variant" in
    valid) ;;
    bind)
      mkdir -p "$WORK/bind-$SUFFIX"
      server_mount="      - $WORK/bind-$SUFFIX:/data"
      ;;
    shared)
      # One physical volume behind both logical mounts.
      server_mount="      - pgdata:/data"
      ;;
    redirected)
      external="ss-external-$SUFFIX"
      docker volume create "$external" >/dev/null
      VOLUMES+=("$external")
      volume_block=$'volumes:\n  pgdata:\n  server_data:\n    name: '"$external"$'\n    external: true'
      ;;
    options)
      mkdir -p "$WORK/opts-$SUFFIX"
      volume_block=$'volumes:\n  pgdata:\n  server_data:\n    driver_opts:\n      type: none\n      device: '"$WORK/opts-$SUFFIX"$'\n      o: bind'
      ;;
    *) echo "unknown variant $variant" >&2; exit 2 ;;
  esac

  cat > "$dir/docker-compose.yml" <<COMPOSE
services:
  postgres:
    image: $IMAGE
    environment:
      POSTGRES_DB: fixturedb
      POSTGRES_USER: fixtureuser
      POSTGRES_PASSWORD: fixture-password-not-a-secret
    volumes:
      - pgdata:/var/lib/postgresql/data
  server:
    image: $IMAGE
    entrypoint: ["sleep", "infinity"]
    volumes:
$server_mount

$volume_block
COMPOSE

  printf 'DATABASE_PASSWORD=fixture-password-not-a-secret\n' > "$dir/.env"
  cat > "$dir/etebase-server.ini" <<'INI'
[global]
secret_file = /data/secret.txt
debug = false
INI
  cp "$HELPER" "$dir/backup.sh"
  chmod +x "$dir/backup.sh"
}

start_stack() {
  # $1 install dir, $2 project name ("" for the Compose default)
  dir="$1"
  project="$2"
  PROJECTS+=("$dir|$project")
  if [ -n "$project" ]; then
    ( cd "$dir" && COMPOSE_PROJECT_NAME="$project" docker compose up -d >/dev/null )
  else
    ( cd "$dir" && docker compose up -d >/dev/null )
  fi
}

wait_for_database() {
  dir="$1"; project="$2"
  for _ in $(seq 1 60); do
    if run_compose "$dir" "$project" exec -T postgres pg_isready -U fixtureuser -d fixturedb >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "the fixture database never became ready" >&2
  return 1
}

run_compose() {
  dir="$1"; project="$2"; shift 2
  if [ -n "$project" ]; then
    ( cd "$dir" && COMPOSE_PROJECT_NAME="$project" docker compose "$@" )
  else
    ( cd "$dir" && docker compose "$@" )
  fi
}

run_helper() {
  dir="$1"; project="$2"; shift 2
  if [ -n "$project" ]; then
    ( cd "$dir" && COMPOSE_PROJECT_NAME="$project" ./backup.sh "$@" )
  else
    ( cd "$dir" && ./backup.sh "$@" )
  fi
}

seed_sentinels() {
  dir="$1"; project="$2"
  # A real django_migrations table with real rows: the helper refuses a database
  # that has none, so this is what separates a backup from an empty success.
  run_compose "$dir" "$project" exec -T postgres psql -U fixtureuser -d fixturedb -q <<'SQL'
CREATE TABLE IF NOT EXISTS django_migrations (id serial primary key, app text, name text);
INSERT INTO django_migrations (app, name) VALUES ('etebase_fastapi', '0001_initial'), ('myauth', '0001_initial');
CREATE TABLE IF NOT EXISTS sentinel_rows (value text);
INSERT INTO sentinel_rows (value) VALUES ('fixture-sentinel-row');
SQL
  # A non-empty server-data volume, including the secret_file the ini declares.
  run_compose "$dir" "$project" exec -T server sh -c \
    'printf fixture-secret-key > /data/secret.txt && printf sentinel > /data/media-sentinel.bin'
}

# ── Decoys ────────────────────────────────────────────────────────────
#
# The exact names the old documentation guessed. Nothing in this run may touch
# them, and the helper must never resolve to one.

DECOYS=("self-host_server_data" "self-host_pgdata")
setup_decoys() {
  for decoy in "${DECOYS[@]}"; do
    if docker volume inspect "$decoy" >/dev/null 2>&1; then
      echo "refusing to run: a volume named '$decoy' already exists on this host" >&2
      exit 2
    fi
    docker volume create "$decoy" >/dev/null
    VOLUMES+=("$decoy")
    docker run --rm --network none -v "$decoy:/d" --entrypoint sh "$IMAGE" \
      -c 'printf decoy-untouched > /d/decoy.txt' >/dev/null
  done
}

assert_decoys_untouched() {
  for decoy in "${DECOYS[@]}"; do
    listing="$(docker run --rm --network none -v "$decoy:/d:ro" --entrypoint sh "$IMAGE" \
      -c 'ls -A /d' | tr '\n' ' ' | sed 's/ *$//')"
    check "$listing" "decoy.txt" "decoy volume $decoy still holds only its marker"
    content="$(docker run --rm --network none -v "$decoy:/d:ro" --entrypoint cat "$IMAGE" /d/decoy.txt)"
    check "$content" "decoy-untouched" "decoy volume $decoy content unchanged"
  done
}

# ── Positive runs ─────────────────────────────────────────────────────

metadata_value() {
  sed -n "s/^$2=//p" "$1/backup-metadata.txt"
}

run_positive_case() {
  label="$1"; dirname="$2"; project="$3"; optional_extra="$4"
  note "positive: $label"
  dir="$WORK/$dirname"
  write_install_dir "$dir" valid
  if [ "$optional_extra" = "yes" ]; then
    printf '{"schemaVersion":1}\n' > "$dir/server-image.json"
    printf 'services:\n  server:\n    environment:\n      FIXTURE_OVERRIDE: admitted\n' > \
      "$dir/docker-compose.override.yml"
  fi
  start_stack "$dir" "$project"
  wait_for_database "$dir" "$project"
  seed_sentinels "$dir" "$project"

  dest="$dir/backup-out"
  if run_helper "$dir" "$project" backup "$dest" >/dev/null; then
    pass "$label: backup succeeded"
  else
    fail "$label: backup failed"
    return 0
  fi

  expected_project="${project:-$(basename "$dir")}"
  # Compose normalises project names to lowercase.
  expected_project="$(printf '%s' "$expected_project" | tr '[:upper:]' '[:lower:]')"

  inventory="$(find "$dest" -maxdepth 1 -type f -printf '%P\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ *$//')"
  if [ "$optional_extra" = "yes" ]; then
    expected_inventory="SHA256SUMS .env backup-metadata.txt database.sql docker-compose.override.yml docker-compose.yml etebase-server.ini server-data.tar.gz server-image.json"
  else
    expected_inventory="SHA256SUMS .env backup-metadata.txt database.sql docker-compose.yml etebase-server.ini server-data.tar.gz"
  fi
  expected_inventory="$(printf '%s\n' $expected_inventory | LC_ALL=C sort | tr '\n' ' ' | sed 's/ *$//')"
  check "$inventory" "$expected_inventory" "$label: exact backup inventory"

  check "$(metadata_value "$dest" schema_version)" "1" "$label: metadata schema version"
  check "$(metadata_value "$dest" compose_project)" "$expected_project" "$label: metadata records the real project"
  check "$(metadata_value "$dest" migration_rows)" "2" "$label: metadata records the real migration count"
  check "$(metadata_value "$dest" secret_file_scope)" "archived" "$label: the configured secret_file was archived"

  # The recorded volume is the one the live container mounts, and is not a
  # guessed name.
  server_cid="$(run_compose "$dir" "$project" ps --all --quiet server)"
  real_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$server_cid")"
  check "$(metadata_value "$dest" server_volume)" "$real_volume" "$label: metadata names the live physical volume"
  for decoy in "${DECOYS[@]}"; do
    if [ "$(metadata_value "$dest" server_volume)" = "$decoy" ]; then
      fail "$label: the helper resolved to the guessed decoy volume $decoy"
    fi
  done

  # Real content, not an empty successful tar.
  members="$(tar -tzf "$dest/server-data.tar.gz")"
  printf '%s\n' "$members" | grep -Fxq "./secret.txt" &&
    pass "$label: the secret file is inside the archive" ||
    fail "$label: the secret file is missing from the archive"
  grep -q "fixture-sentinel-row" "$dest/database.sql" &&
    pass "$label: the database dump carries the sentinel row" ||
    fail "$label: the database dump lost the sentinel row"
  grep -q "fixture-password-not-a-secret" "$dest/.env" &&
    pass "$label: the .env file was captured" ||
    fail "$label: the .env file was not captured"

  # Checksums cover every other file, exactly once.
  check "$(grep -c . "$dest/SHA256SUMS")" \
    "$(find "$dest" -maxdepth 1 -type f ! -name SHA256SUMS -printf '.' | wc -c)" \
    "$label: the manifest covers every artefact but itself"
  ( cd "$dest" && sha256sum --quiet --check SHA256SUMS ) &&
    pass "$label: checksums verify" || fail "$label: checksums do not verify"
  run_helper "$dir" "$project" verify "$dest" >/dev/null &&
    pass "$label: verify accepts the fresh backup" ||
    fail "$label: verify rejected a fresh backup"

  POSITIVE_DEST="$dest"
  POSITIVE_DIR="$dir"
  POSITIVE_PROJECT="$project"
}

run_consistency_cases() {
  note "manifest consistency and verification boundary"
  dir="$POSITIVE_DIR"; project="$POSITIVE_PROJECT"
  work="$WORK/consistency"
  rm -rf -- "$work"
  cp -a "$POSITIVE_DEST" "$work"

  printf 'corrupt\n' >> "$work/database.sql"
  if run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
    fail "verify accepted database corruption with an unchanged manifest"
  else
    pass "verify rejects database corruption with an unchanged manifest"
  fi

  # SHA256SUMS is adjacent metadata, not an authenticated statement. A
  # same-length artifact edit accompanied by a valid recomputed manifest is
  # internally consistent and must not be represented as authenticity proof.
  rm -rf -- "$work"; cp -a "$POSITIVE_DEST" "$work"
  original_size="$(wc -c < "$work/database.sql" | tr -d '[:space:]')"
  first_byte="$(dd if="$work/database.sql" bs=1 count=1 status=none)"
  case "$first_byte" in
    X) replacement=Y ;;
    *) replacement=X ;;
  esac
  printf '%s' "$replacement" | dd of="$work/database.sql" bs=1 count=1 conv=notrunc status=none
  check "$(wc -c < "$work/database.sql" | tr -d '[:space:]')" "$original_size" \
    "the manifest-boundary edit preserves artifact length"
  ( cd "$work" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' |
    LC_ALL=C sort | xargs -r sha256sum -- > SHA256SUMS )
  if run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
    pass "verify accepts a same-length edit with a recomputed valid unauthenticated manifest"
  else
    fail "verify rejected an internally consistent backup after its unauthenticated manifest was recomputed"
  fi

  rm -rf -- "$work"; cp -a "$POSITIVE_DEST" "$work"
  grep -v ' database.sql$' "$work/SHA256SUMS" > "$work/SHA256SUMS.new"
  mv "$work/SHA256SUMS.new" "$work/SHA256SUMS"
  if run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
    fail "verify accepted a manifest with a deleted record"
  else
    pass "verify rejects a manifest with a deleted record"
  fi

  # Metadata rewritten *and* re-checksummed: only the closed metadata grammar
  # can catch this one.
  rm -rf -- "$work"; cp -a "$POSITIVE_DEST" "$work"
  printf 'unexpected_key=1\n' >> "$work/backup-metadata.txt"
  ( cd "$work" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' |
    LC_ALL=C sort | xargs -r sha256sum -- > SHA256SUMS )
  if run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
    fail "verify accepted metadata with an unexpected key"
  else
    pass "verify rejects metadata with an unexpected key"
  fi

  rm -rf -- "$work"; cp -a "$POSITIVE_DEST" "$work"
  sed -i 's/^migration_rows=.*/migration_rows=zero/' "$work/backup-metadata.txt"
  ( cd "$work" && find . -maxdepth 1 -type f ! -name SHA256SUMS -printf '%P\n' |
    LC_ALL=C sort | xargs -r sha256sum -- > SHA256SUMS )
  if run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
    fail "verify accepted a malformed metadata value"
  else
    pass "verify rejects a malformed metadata value"
  fi

  # Interpose only in this fixture. verify invokes tar after its first checksum
  # pass, giving us a deterministic boundary at which to mutate or replace an
  # already-validated file without sleeps or any production test hook.
  real_tar="$(command -v tar)"
  mkdir -p "$WORK/sabotage-bin"
  cat > "$WORK/sabotage-bin/tar" <<'SABOTAGE'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_TAR" "$@"
case "$SABOTAGE_MODE" in
  mutate) printf 'changed-during-verification\n' >> "$SABOTAGE_TARGET" ;;
  replace)
    cp -p -- "$SABOTAGE_TARGET" "$SABOTAGE_TARGET.replacement"
    mv -- "$SABOTAGE_TARGET.replacement" "$SABOTAGE_TARGET"
    ;;
esac
SABOTAGE
  chmod +x "$WORK/sabotage-bin/tar"

  for mode in mutate replace; do
    rm -rf -- "$work"; cp -a "$POSITIVE_DEST" "$work"
    if PATH="$WORK/sabotage-bin:$PATH" REAL_TAR="$real_tar" \
      SABOTAGE_MODE="$mode" SABOTAGE_TARGET="$work/database.sql" \
      run_helper "$dir" "$project" verify "$work" >/dev/null 2>&1; then
      fail "verify accepted a file $mode between validation phases"
    else
      pass "verify rejects a file $mode between validation phases"
    fi
  done
}

run_publication_signal_case() {
  note "signal immediately after atomic publication"
  dir="$POSITIVE_DIR"; project="$POSITIVE_PROJECT"
  dest="$dir/backup-signalled"
  real_mv="$(command -v mv)"
  mkdir -p "$WORK/publication-bin"
  cat > "$WORK/publication-bin/mv" <<'SABOTAGE'
#!/usr/bin/env bash
set -euo pipefail
"$REAL_MV" "$@"
kill -TERM "$PPID"
SABOTAGE
  chmod +x "$WORK/publication-bin/mv"

  if output="$(PATH="$WORK/publication-bin:$PATH" REAL_MV="$real_mv" \
    run_helper "$dir" "$project" backup "$dest" 2>&1)"; then
    pass "TERM after rename does not turn a published backup into failure"
  else
    fail "TERM after rename made publication fail: $output"
    return 0
  fi
  printf '%s\n' "$output" | grep -Fq "Backup complete: $dest" &&
    pass "the published backup is truthfully acknowledged" ||
    fail "the published backup was not acknowledged"
  if printf '%s\n' "$output" | grep -Fq "nothing was kept"; then
    fail "the published backup was falsely reported as discarded"
  else
    pass "no false nothing-kept claim follows publication"
  fi
  [ -s "$dest/database.sql" ] && [ -s "$dest/server-data.tar.gz" ] &&
    pass "the signalled publication remains complete and non-empty" ||
    fail "the signalled publication is missing or empty"
}

# ── Negative identities ───────────────────────────────────────────────

run_negative_case() {
  variant="$1"
  note "negative: $variant identity"
  dir="$WORK/neg-$variant"
  project="ssneg${variant}${SUFFIX//-/}"
  write_install_dir "$dir" "$variant"
  start_stack "$dir" "$project"

  dest="$dir/backup-out"
  if run_helper "$dir" "$project" backup "$dest" >/dev/null 2>&1; then
    fail "$variant identity produced a backup"
  else
    pass "$variant identity was refused"
  fi
  if [ -e "$dest" ] || [ -e "$dest.partial" ]; then
    fail "$variant identity left a backup directory behind"
  else
    pass "$variant identity left nothing behind"
  fi
}

# ── Run ───────────────────────────────────────────────────────────────

docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
setup_decoys

run_positive_case "default project name" "silentsuite-server" "" no
run_publication_signal_case
run_consistency_cases
run_positive_case "custom project name" "custom-dir" "operator-chosen-${SUFFIX//-/}" yes

for variant in bind shared redirected options; do
  run_negative_case "$variant"
done

assert_decoys_untouched

note "summary"
if [ "$FAILURES" -ne 0 ]; then
  echo "$FAILURES behavioural check(s) failed" >&2
  exit 1
fi
echo "all behavioural checks passed"
