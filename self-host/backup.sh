#!/usr/bin/env bash
# SilentSuite self-host backup helper.
#
# Three non-destructive commands only:
#
#   ./backup.sh inspect            read-only identity report for this install
#   ./backup.sh backup DEST        verified backup into a new directory DEST
#   ./backup.sh verify DEST        re-check an existing backup's checksums
#
# There is deliberately no restore, reset, prune or delete command. Restoring a
# PostgreSQL database and a server-data volume is an irreversible, install-
# specific operation; see SELF-HOSTING.md for what is and is not supported.
#
# The whole point of this script is that it never guesses a Docker volume name.
# `docker run -v NAME:/data ...` creates NAME when it does not exist, so a
# guessed Compose-generated name (the old docs guessed `self-host_server_data`)
# can archive a brand-new empty volume and report success. Every physical volume
# used here is read out of the live container that is actually mounting it.

set -euo pipefail

umask 077

readonly SCHEMA_VERSION=1
readonly SERVER_SERVICE=server
readonly POSTGRES_SERVICE=postgres
readonly SERVER_TARGET=/data
readonly POSTGRES_TARGET=/var/lib/postgresql/data
readonly SERVER_VOLUME_LABEL=server_data
readonly POSTGRES_VOLUME_LABEL=pgdata

readonly LABEL_PROJECT=com.docker.compose.project
readonly LABEL_SERVICE=com.docker.compose.service
readonly LABEL_VOLUME=com.docker.compose.volume

readonly DUMP_NAME=database.sql
readonly ARCHIVE_NAME=server-data.tar.gz
readonly METADATA_NAME=backup-metadata.txt
readonly CHECKSUM_NAME=SHA256SUMS
readonly REQUIRED_CONFIG=(.env etebase-server.ini docker-compose.yml)
readonly OPTIONAL_CONFIG=(docker-compose.override.yml server-image.json)

PARTIAL_DIR=""
DEST_DIR=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# A partial directory is never left behind, and a run that was interrupted or
# failed must never exit 0 — a "backup" that reports success without renaming
# anything into place is exactly the failure mode this script exists to prevent.
cleanup() {
  status=$?
  signal="${1:-}"
  if [ -n "$PARTIAL_DIR" ] && [ -d "$PARTIAL_DIR" ]; then
    rm -rf -- "$PARTIAL_DIR"
  fi
  # The claimed final name is an empty directory this run created; rmdir gives
  # it back and refuses if anything unexpectedly ended up inside it.
  if [ -n "$DEST_DIR" ] && [ -d "$DEST_DIR" ]; then
    rmdir -- "$DEST_DIR" 2>/dev/null || true
  fi
  if [ -n "$signal" ]; then
    echo "ERROR: interrupted by SIG$signal; nothing was kept" >&2
    exit 1
  fi
  [ "$status" -ne 0 ] || status=1
  exit "$status"
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./backup.sh inspect
  ./backup.sh backup <destination-directory>
  ./backup.sh verify <backup-directory>

Run from the SilentSuite install directory (the one holding docker-compose.yml).
USAGE
  exit 2
}

# ── Strict field grammar ──────────────────────────────────────────────
#
# Every value below is read from a Docker --format template, so a hostile or
# merely surprising label must not be able to smuggle a delimiter, a newline or
# a control character into the metadata file or into a later shell word.

is_safe_token() {
  case "$1" in
    "" | *[!A-Za-z0-9._-]*) return 1 ;;
  esac
  return 0
}

require_token() {
  is_safe_token "$1" || die "$2 is empty or contains characters outside [A-Za-z0-9._-]"
}

require_digits() {
  case "$1" in
    "" | *[!0-9]*) die "$2 is not a plain decimal number" ;;
  esac
}

# Exactly "sha256:" plus 64 lowercase hex. A glob prefix match is not enough:
# `sha256:deadbeefzz...` would pass one, and the image ID is what pins the only
# container image this script is allowed to run.
require_image_id() {
  case "$1" in
    sha256:*) ;;
    *) die "$2 is not a sha256 image ID" ;;
  esac
  hex="${1#sha256:}"
  [ "${#hex}" -eq 64 ] || die "$2 is not a 64-hex sha256 image ID"
  case "$hex" in
    *[!0-9a-f]*) die "$2 is not a 64-hex sha256 image ID" ;;
  esac
}

compose() {
  docker compose "$@"
}

# ── Identity admission ────────────────────────────────────────────────
#
# `docker compose` resolves the project the same way the operator's own
# `docker compose up` does — COMPOSE_PROJECT_NAME, the top-level `name:`, or the
# directory. Asking it, instead of reconstructing a project prefix lexically, is
# what keeps custom project names and docker-compose.override.yml working.

# --all deliberately: a stopped duplicate is an ambiguous identity, and listing
# only running containers would hide it and then happily back up the survivor.
single_service_container() {
  service="$1"
  ids="$(compose ps --all --quiet "$service" 2>/dev/null || true)"
  [ -n "$ids" ] || die "no container found for the '$service' service (is the stack installed?)"
  count="$(printf '%s\n' "$ids" | grep -c .)"
  [ "$count" -eq 1 ] || die "expected exactly one '$service' container, found $count"
  id="$(printf '%s\n' "$ids" | head -n 1)"
  require_token "$id" "the '$service' container ID"
  printf '%s\n' "$id"
}

# Prints "<project> <volume-name>" for the single named-volume mount the given
# container has at the given target path.
container_identity() {
  cid="$1"
  service="$2"
  target="$3"

  state="$(docker inspect --format '{{.State.Running}}' "$cid")"
  [ "$state" = "true" ] || die "the '$service' container is not running"

  project="$(docker inspect --format "{{index .Config.Labels \"$LABEL_PROJECT\"}}" "$cid")"
  labelled="$(docker inspect --format "{{index .Config.Labels \"$LABEL_SERVICE\"}}" "$cid")"
  require_token "$project" "the Compose project label on the '$service' container"
  [ "$labelled" = "$service" ] ||
    die "the '$service' container carries Compose service label '$labelled'"

  # One line per mount: type name destination. A bind mount has an empty .Name,
  # which collapses the line to two fields and is rejected below.
  mounts="$(docker inspect \
    --format '{{range .Mounts}}{{.Type}} {{.Name}} {{.Destination}}{{println}}{{end}}' "$cid")"

  found=0
  volume=""
  while IFS=' ' read -r mtype mname mdest extra; do
    [ -n "$mtype" ] || continue
    [ -z "$extra" ] || die "a mount on the '$service' container has an unparseable descriptor"
    [ "$mdest" = "$target" ] || continue
    found=$((found + 1))
    [ "$mtype" = "volume" ] ||
      die "'$service' mounts a $mtype at $target; only a named volume can be backed up safely"
    require_token "$mname" "the volume name mounted at $target"
    volume="$mname"
  done <<MOUNTS
$mounts
MOUNTS

  [ "$found" -eq 1 ] ||
    die "expected exactly one mount at $target on '$service', found $found"

  printf '%s %s\n' "$project" "$volume"
}

# Proves the physical volume is a plain, unshared, option-free local volume that
# Compose created for this project under the expected logical name.
assert_volume_admissible() {
  name="$1"
  project="$2"
  logical="$3"

  line="$(docker volume inspect --format \
    "{{.Driver}} {{.Scope}} {{len .Options}} {{index .Labels \"$LABEL_PROJECT\"}} {{index .Labels \"$LABEL_VOLUME\"}}" \
    "$name" 2>/dev/null)" || die "volume '$name' could not be inspected"

  # shellcheck disable=SC2086
  set -- $line
  [ "$#" -eq 5 ] || die "volume '$name' has an unparseable descriptor"
  driver="$1"; scope="$2"; options="$3"; vproject="$4"; vlogical="$5"

  [ "$driver" = "local" ] || die "volume '$name' uses the '$driver' driver; only 'local' is supported"
  [ "$scope" = "local" ] || die "volume '$name' has '$scope' scope; only 'local' is supported"
  require_digits "$options" "the option count for volume '$name'"
  [ "$options" -eq 0 ] || die "volume '$name' carries driver options; refusing to guess their meaning"
  [ "$vproject" = "$project" ] ||
    die "volume '$name' belongs to Compose project '$vproject', not '$project'"
  [ "$vlogical" = "$logical" ] ||
    die "volume '$name' carries logical Compose volume name '$vlogical', expected '$logical'"
}

# Sets PROJECT, SERVER_CID, POSTGRES_CID, SERVER_VOLUME, POSTGRES_VOLUME, IMAGE_ID.
resolve_identity() {
  SERVER_CID="$(single_service_container "$SERVER_SERVICE")"
  POSTGRES_CID="$(single_service_container "$POSTGRES_SERVICE")"

  # Captured in two steps: a command substitution that dies inside `read` would
  # not fail the pipeline, and a fail-open identity check is the whole bug class
  # this script exists to close.
  server_line="$(container_identity "$SERVER_CID" "$SERVER_SERVICE" "$SERVER_TARGET")"
  postgres_line="$(container_identity "$POSTGRES_CID" "$POSTGRES_SERVICE" "$POSTGRES_TARGET")"
  read -r PROJECT SERVER_VOLUME <<< "$server_line"
  read -r pg_project POSTGRES_VOLUME <<< "$postgres_line"
  require_token "$PROJECT" "the Compose project name"
  require_token "$SERVER_VOLUME" "the server data volume name"
  require_token "$POSTGRES_VOLUME" "the database volume name"

  [ "$PROJECT" = "$pg_project" ] ||
    die "the server and postgres containers belong to different Compose projects"
  [ "$SERVER_VOLUME" != "$POSTGRES_VOLUME" ] ||
    die "the server and database resolve to the same volume '$SERVER_VOLUME'"

  assert_volume_admissible "$SERVER_VOLUME" "$PROJECT" "$SERVER_VOLUME_LABEL"
  assert_volume_admissible "$POSTGRES_VOLUME" "$PROJECT" "$POSTGRES_VOLUME_LABEL"

  # The archiving container reuses the exact image the admitted server container
  # is already running, by immutable local ID. Nothing is pulled, and no mutable
  # helper tag (`alpine`, `alpine:latest`, ...) can be substituted underneath.
  IMAGE_ID="$(docker inspect --format '{{.Image}}' "$SERVER_CID")"
  require_image_id "$IMAGE_ID" "the server container's image ID"
  local_id="$(docker image inspect --format '{{.Id}}' "$IMAGE_ID" 2>/dev/null)" ||
    die "the server container's image is not present locally"
  [ "$local_id" = "$IMAGE_ID" ] || die "the server container's image ID is ambiguous locally"
}

identity_fingerprint() {
  printf '%s|%s|%s|%s|%s|%s\n' \
    "$PROJECT" "$SERVER_CID" "$POSTGRES_CID" "$SERVER_VOLUME" "$POSTGRES_VOLUME" "$IMAGE_ID"
}

cmd_inspect() {
  resolve_identity
  cat <<REPORT
Compose project:      $PROJECT
Server service:       $SERVER_SERVICE
  container:          $SERVER_CID
  image ID:           $IMAGE_ID
  volume at $SERVER_TARGET:    $SERVER_VOLUME
Database service:     $POSTGRES_SERVICE
  container:          $POSTGRES_CID
  volume at $POSTGRES_TARGET: $POSTGRES_VOLUME

These are the physical volume names this install is actually using. Never type a
volume name from documentation into a docker command: Docker creates a missing
named volume silently, and the result looks like a successful empty backup.
REPORT
}

# ── Shared archive and secret_file grammar ────────────────────────────
#
# Backup and verify have to ask the same two questions of the same two
# artefacts, with one grammar. A second, looser parser in the verifier is
# exactly how a backup written under one set of rules gets blessed under
# another: the metadata file and the manifest are both recomputable by whoever
# holds the directory, so the only evidence about the secret key is the
# etebase-server.ini that was backed up next to the archive, and the archive.

# Regular-file member names of a `tar -tvz` listing read on stdin. A tar of an
# empty volume still lists "./", and a directory or a symlink is not the secret
# key an operator thinks they have.
archive_regular_members() {
  awk '{ if (substr($0, 1, 1) != "-") next; p = index($0, $5); print substr($0, p + length($5) + 1) }'
}

# Reads regular-file member names on stdin. `tar -C /data .` records "./name";
# a listing that records the same member without that prefix names the same
# file, and nothing else counts as membership.
assert_archived_member() {
  relative="$1"
  message="$2"
  grep -Fxq -e "./$relative" -e "$relative" || die "$message"
}

# Sets SECRET_FILE_VALUE to the single effective [global] secret_file
# declaration in the given etebase-server.ini. Only the [global] section is the
# effective declaration. A secret_file under some other section is not what the
# server reads, and treating it as such would "prove" the wrong file was
# archived.
read_secret_file_declaration() {
  ini="$1"
  [ -f "$ini" ] && [ ! -L "$ini" ] ||
    die "'$ini' is not a regular file; the effective secret_file cannot be read"

  global_sections="$(grep -c -E '^[[:space:]]*\[global\][[:space:]]*$' "$ini" || true)"
  require_digits "$global_sections" "the [global] section count"
  [ "$global_sections" -eq 1 ] ||
    die "etebase-server.ini must contain exactly one [global] section"
  global_body="$(awk '
    /^[[:space:]]*\[/ { in_global = ($0 ~ /^[[:space:]]*\[global\][[:space:]]*$/); next }
    in_global { print }
  ' "$ini")"
  declarations="$(printf '%s\n' "$global_body" |
    grep -c -E '^[[:space:]]*secret_file[[:space:]]*=' || true)"
  require_digits "$declarations" "the secret_file declaration count"
  [ "$declarations" -le 1 ] ||
    die "etebase-server.ini declares secret_file $declarations times in [global]; resolve the ambiguity first"
  [ "$declarations" -eq 1 ] ||
    die "etebase-server.ini's [global] section does not declare secret_file"

  SECRET_FILE_VALUE="$(printf '%s\n' "$global_body" |
    sed -n -E 's/^[[:space:]]*secret_file[[:space:]]*=[[:space:]]*//p' |
    sed -e 's/[[:space:]]*$//')"
}

# Sets SECRET_FILE_SCOPE from a declared value, plus SECRET_FILE_RELATIVE when
# that value lives in the server volume. `archived` and `external` are the only
# two scopes a declaration can resolve to, and therefore the only two a backup
# can record: the key is either a member of the archived volume, or it is an
# operator-managed file that this helper never reads from the host.
classify_secret_file() {
  value="$1"
  SECRET_FILE_RELATIVE=""
  case "$value" in
    *[[:cntrl:]]*) die "etebase-server.ini's secret_file contains control characters" ;;
  esac
  case "$value" in
    /*) ;;
    *) die "etebase-server.ini's secret_file is not an absolute path; resolve it first" ;;
  esac
  # One path grammar for both scopes. A malformed path is not more acceptable
  # because it points outside the volume: `/data/../etc/key` and `/srv//key` are
  # unresolvable claims either way, and classifying one of them would decide
  # where the key lives on the strength of a string nobody can read twice the
  # same way.
  case "$value" in
    *//* | */. | */./* | *.. | *../* | */..* | *' '* | *"	"*)
      die "etebase-server.ini's secret_file path is ambiguous; resolve it first"
      ;;
  esac
  case "$value" in
    "$SERVER_TARGET")
      die "etebase-server.ini's secret_file names $SERVER_TARGET itself, not a file in it"
      ;;
    "$SERVER_TARGET"/*) ;;
    *)
      # Operator-managed path outside the server volume. Not read from the host:
      # what is or is not at that path on this machine says nothing about what a
      # backup directory contains.
      SECRET_FILE_SCOPE=external
      return 0
      ;;
  esac
  SECRET_FILE_RELATIVE="${value#"$SERVER_TARGET"/}"
  SECRET_FILE_SCOPE=archived
}

# ── Backup ────────────────────────────────────────────────────────────

# The destination is claimed the way the installer claims an install directory:
# through a canonicalised, trusted parent, with an atomic mkdir that cannot
# follow a symlink planted between the check and the write.
assert_trusted_parent() {
  parent="$1"
  uid="$(id -u)"
  [ -d "$parent" ] || die "parent directory '$parent' does not exist; create it yourself first"
  resolved="$(CDPATH='' cd -P -- "$parent" 2>/dev/null && pwd -P)" || resolved=""
  [ -n "$resolved" ] && [ -d "$resolved" ] ||
    die "parent directory '$parent' does not resolve to a real directory"
  if [ -n "${PARENT_CANONICAL:-}" ] && [ "$resolved" != "$PARENT_CANONICAL" ]; then
    die "'$parent' now resolves to '$resolved', not '$PARENT_CANONICAL'; a path component changed"
  fi
  # Owned by this user and writable by nobody else: the two properties that make
  # the mkdir below a claim rather than a hope, and that keep another local user
  # from reading a backup directory full of secrets.
  [ -n "$(find "$resolved" -maxdepth 0 -uid "$uid" ! -perm /022 -print 2>/dev/null)" ] ||
    die "'$resolved' must be owned by UID $uid and must not be group- or world-writable"
  PARENT_REAL="$resolved"
}

claim_destination() {
  dest="$1"
  case "$dest" in
    "" | -*) die "destination must be a plain path" ;;
    */) dest="${dest%/}" ;;
  esac
  name="$(basename -- "$dest")"
  case "$name" in
    "" | "." | ".." | */*) die "destination must name a new directory" ;;
  esac

  PARENT_CANONICAL=""
  assert_trusted_parent "$(dirname -- "$dest")"
  PARENT_CANONICAL="$PARENT_REAL"

  # Address the destination only through the canonical parent from here on; the
  # path as typed may run through a symlink that is re-pointed mid-run.
  if [ "$PARENT_REAL" = "/" ]; then
    DEST_DIR="/$name"
  else
    DEST_DIR="$PARENT_REAL/$name"
  fi
  PARTIAL_TARGET="$DEST_DIR.partial"

  [ ! -e "$DEST_DIR" ] && [ ! -L "$DEST_DIR" ] ||
    die "destination '$DEST_DIR' already exists; this helper only ever creates a new directory"
  [ ! -e "$PARTIAL_TARGET" ] && [ ! -L "$PARTIAL_TARGET" ] ||
    die "a previous attempt left '$PARTIAL_TARGET' behind; inspect and remove it yourself"

  # Claim the final name now, atomically and empty. Anything that appears at
  # that name later is not this run's directory, and the rename below will fail
  # rather than write into or over it.
  mkdir -- "$DEST_DIR" 2>/dev/null ||
    die "'$DEST_DIR' appeared while the destination was being validated; nothing was written"
  mkdir -- "$PARTIAL_TARGET" 2>/dev/null || {
    rmdir -- "$DEST_DIR" 2>/dev/null || true
    die "'$PARTIAL_TARGET' appeared while the destination was being validated"
  }
  PARTIAL_DIR="$PARTIAL_TARGET"
  chmod 700 -- "$DEST_DIR" "$PARTIAL_DIR"
  [ ! -L "$PARTIAL_DIR" ] && [ -d "$PARTIAL_DIR" ] ||
    die "'$PARTIAL_DIR' is not the directory this helper just created"
}

# rename(2) over a directory succeeds only when the target is an empty directory
# we own — which is exactly the placeholder claimed above. -T is what makes this
# a replacement instead of a move *into* the destination, so a directory that
# gained content in the meantime fails closed instead of being nested into.
finalise_destination() {
  assert_trusted_parent "$PARENT_CANONICAL"
  [ -d "$DEST_DIR" ] && [ ! -L "$DEST_DIR" ] ||
    die "'$DEST_DIR' is no longer the empty directory this helper claimed"

  # Publication and its acknowledgement are one signal-safe transition. A
  # signal before this point still cleans the private partial and empty claim.
  # Across the rename, state update, trap retirement and truthful success
  # output, INT/TERM are ignored so cleanup can never describe a published
  # backup as a failed attempt. EXIT remains armed until the rename succeeds.
  trap '' INT TERM
  if ! mv -T -- "$PARTIAL_DIR" "$DEST_DIR"; then
    trap 'cleanup INT' INT
    trap 'cleanup TERM' TERM
    die "could not put the backup in place at '$DEST_DIR'; nothing was kept"
  fi
  PARTIAL_DIR=""
  trap - EXIT

  echo "Backup complete: $DEST_DIR"
  echo "  database dump, server-data archive, configuration, metadata, $CHECKSUM_NAME"
  echo "  server data volume: $SERVER_VOLUME (project $PROJECT)"
  # Only the archived scope can promise the key. The external branch never reads
  # the operator's host path, so claiming the key is here would be false in
  # exactly the case where an operator most needs the truth.
  case "$SECRET_FILE_SCOPE" in
    archived)
      echo "  keep this directory private; it contains your .env and your server secret key"
      ;;
    *)
      echo "  keep this directory private; it contains your .env"
      echo "  your server secret key is NOT in this backup: secret_file is outside"
      echo "  $SERVER_TARGET, is operator-managed, and must be backed up separately"
      ;;
  esac
  trap - INT TERM
}

# The credentials live in the postgres container's own environment. They are
# expanded inside the container and never enter this script, its arguments, its
# output or the metadata file.
dump_database() {
  docker exec "$POSTGRES_CID" sh -c \
    'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
    > "$PARTIAL_DIR/$DUMP_NAME" || die "pg_dump failed"
  [ -s "$PARTIAL_DIR/$DUMP_NAME" ] || die "the database dump is empty"
}

# A dump of a freshly created empty database is a valid file. Requiring applied
# migration rows in the live database is the cheapest proof that the admitted
# volume is the one holding a real installation.
count_migrations() {
  rows="$(docker exec "$POSTGRES_CID" sh -c \
    'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atqc "select count(*) from django_migrations"')" ||
    die "could not count django_migrations rows in the live database"
  rows="$(printf '%s' "$rows" | tr -d '[:space:]')"
  require_digits "$rows" "the django_migrations row count"
  [ "$rows" -gt 0 ] || die "django_migrations is empty; this is not an initialised SilentSuite database"
  MIGRATION_ROWS="$rows"
}

# The archive is streamed to this process's stdout and written by the host user
# who owns the partial directory. Binding the partial directory into the
# container instead would ask an image running as its own non-host UID to create
# a file in a 0700 host directory, which is both a permission problem and an
# unnecessary write path into the operator's filesystem. The data volume goes in
# read-only; the image is the immutable local ID already admitted.
archive_server_volume() {
  docker run --rm \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --entrypoint tar \
    --mount "type=volume,src=$SERVER_VOLUME,dst=$SERVER_TARGET,readonly,volume-nocopy" \
    "$IMAGE_ID" \
    -czf - -C "$SERVER_TARGET" . > "$PARTIAL_DIR/$ARCHIVE_NAME" ||
    die "archiving the server data volume failed"
  [ -s "$PARTIAL_DIR/$ARCHIVE_NAME" ] || die "the server data archive is empty"

  ARCHIVE_REGULAR_FILES="$PARTIAL_DIR/.regular-files"
  tar -tvzf "$PARTIAL_DIR/$ARCHIVE_NAME" | archive_regular_members \
    > "$ARCHIVE_REGULAR_FILES" || die "the server data archive could not be listed"
  ARCHIVE_FILES="$(grep -c . "$ARCHIVE_REGULAR_FILES" || true)"
  require_digits "$ARCHIVE_FILES" "the archived regular-file count"
  [ "$ARCHIVE_FILES" -gt 0 ] ||
    die "the server data archive contains no regular files; the volume looks empty"
}

# etebase-server.ini may point the server's secret key at a path inside /data.
# When it does, that file has to be inside the archive, or the "backup" is
# missing the one thing that cannot be regenerated.
assert_secret_file_archived() {
  read_secret_file_declaration "$PARTIAL_DIR/etebase-server.ini"
  classify_secret_file "$SECRET_FILE_VALUE"
  [ "$SECRET_FILE_SCOPE" = archived ] || return 0

  # Membership is proven against the regular-file listing, so a directory or a
  # symlink carrying the right name cannot stand in for the secret key.
  assert_archived_member "$SECRET_FILE_RELATIVE" \
    "the configured secret_file is not archived as a regular file" \
    < "$ARCHIVE_REGULAR_FILES"
}

# Configuration is copied, never followed: a symlink at .env would silently pull
# an arbitrary host file into a backup directory the operator then treats as
# theirs, and a fifo or device is not configuration at all.
#
# GNU dd opens the source itself with O_NOFOLLOW. O_NONBLOCK prevents a raced
# fifo from hanging the helper, and count_bytes bounds a raced device to the
# size of the admitted regular file. The pathname identity must still be the
# same after the copy, and the destination must be a plain regular file, before
# the name can enter the config inventory.
copy_config_file() {
  name="$1"
  source_before="$(stat --format='%d:%i:%f:%s:%y' -- "$name")" ||
    die "could not inspect configuration file '$name'"
  IFS=: read -r _ _ source_mode source_size _ <<< "$source_before"
  require_digits "$source_size" "the size of configuration file '$name'"
  [ $((0x$source_mode & 0xf000)) -eq $((0x8000)) ] ||
    die "'$name' is not a regular file"

  dd if="$name" of="$PARTIAL_DIR/$name" count="$source_size" \
    iflag=nofollow,nonblock,count_bytes status=none ||
    die "'$name' changed while it was being opened; refusing to copy it"

  source_after="$(stat --format='%d:%i:%f:%s:%y' -- "$name")" ||
    die "'$name' disappeared while it was being copied"
  [ "$source_before" = "$source_after" ] ||
    die "'$name' changed while it was being copied; refusing to keep it"
  [ ! -L "$PARTIAL_DIR/$name" ] ||
    die "'$name' became a symlink while it was being copied; refusing to keep it"
  [ -f "$PARTIAL_DIR/$name" ] ||
    die "the copy of '$name' is not a regular file; refusing to keep it"
  [ "$(stat --format='%s' -- "$PARTIAL_DIR/$name")" = "$source_size" ] ||
    die "the copy of '$name' is incomplete; refusing to keep it"
  chmod 600 -- "$PARTIAL_DIR/$name"
  CONFIG_FILES="${CONFIG_FILES:+$CONFIG_FILES,}$name"
}

collect_config() {
  CONFIG_FILES=""
  for name in "${REQUIRED_CONFIG[@]}"; do
    [ -e "$name" ] || [ -L "$name" ] ||
      die "required configuration file '$name' is missing from this directory"
    copy_config_file "$name"
  done
  for name in "${OPTIONAL_CONFIG[@]}"; do
    [ -e "$name" ] || [ -L "$name" ] || continue
    copy_config_file "$name"
  done
}

write_metadata() {
  dump_bytes="$(wc -c < "$PARTIAL_DIR/$DUMP_NAME" | tr -d '[:space:]')"
  archive_bytes="$(wc -c < "$PARTIAL_DIR/$ARCHIVE_NAME" | tr -d '[:space:]')"
  require_digits "$dump_bytes" "the database dump size"
  require_digits "$archive_bytes" "the server data archive size"

  # A successful run resolves the scope to one of exactly two values. Recording
  # anything else — including a placeholder — would hand the verifier a scope it
  # cannot cross-check against the config and the archive.
  case "${SECRET_FILE_SCOPE:-}" in
    archived | external) ;;
    *) die "the secret_file scope was not resolved; refusing to write metadata" ;;
  esac

  # Closed key set, one strict key=value per line, no secrets, no database user
  # or database name, no raw label or option dumps.
  cat > "$PARTIAL_DIR/$METADATA_NAME" <<META
schema_version=$SCHEMA_VERSION
created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
compose_project=$PROJECT
server_volume=$SERVER_VOLUME
postgres_volume=$POSTGRES_VOLUME
server_image_id=$IMAGE_ID
database_dump=$DUMP_NAME
database_dump_bytes=$dump_bytes
migration_rows=$MIGRATION_ROWS
server_data_archive=$ARCHIVE_NAME
server_data_archive_bytes=$archive_bytes
server_data_files=$ARCHIVE_FILES
secret_file_scope=$SECRET_FILE_SCOPE
config_files=$CONFIG_FILES
META
  chmod 600 -- "$PARTIAL_DIR/$METADATA_NAME"
}

write_checksums() {
  rm -f -- "$ARCHIVE_REGULAR_FILES"
  ( cd "$PARTIAL_DIR" &&
    find . -maxdepth 1 -type f ! -name "$CHECKSUM_NAME" -printf '%P\n' |
      LC_ALL=C sort |
      xargs -r sha256sum -- > "$CHECKSUM_NAME" )
  chmod 600 -- "$PARTIAL_DIR/$CHECKSUM_NAME"
  [ -s "$PARTIAL_DIR/$CHECKSUM_NAME" ] || die "the checksum manifest is empty"
}

cmd_backup() {
  [ "$#" -eq 1 ] || usage
  dest="$1"

  [ -f docker-compose.yml ] ||
    die "run this from the SilentSuite install directory (no docker-compose.yml here)"

  resolve_identity
  before="$(identity_fingerprint)"

  trap cleanup EXIT
  trap 'cleanup INT' INT
  trap 'cleanup TERM' TERM
  claim_destination "$dest"

  collect_config
  count_migrations
  dump_database
  archive_server_volume
  assert_secret_file_archived
  write_metadata
  write_checksums

  # Everything was collected against one identity; prove it is still that
  # identity — same containers, same volumes, same image — before the directory
  # becomes a backup an operator will trust.
  resolve_identity
  [ "$(identity_fingerprint)" = "$before" ] ||
    die "the running stack changed identity during the backup; nothing was kept"

  finalise_destination
}

# ── Verify ────────────────────────────────────────────────────────────
#
# Verification is read-only. It proves internal manifest consistency and catches
# corruption or edits while the adjacent manifest is unchanged, not authenticity.

# Exactly "<64 lowercase hex><two spaces><plain basename>" per line. A name that
# starts with "-" would be read as an option by the checker, and a name carrying
# "/" or ".." would reach outside the backup directory.
assert_checksum_grammar() {
  file="$1"
  [ -s "$file" ] || die "$CHECKSUM_NAME is empty"
  [ "$(tail -c 1 "$file" | od -An -tu1 | tr -d '[:space:]')" = "10" ] ||
    die "$CHECKSUM_NAME does not end with a newline"
  lines="$(grep -c '' "$file" || true)"
  require_digits "$lines" "the manifest line count"
  matching="$(grep -c -E '^[0-9a-f]{64}  [A-Za-z0-9._][A-Za-z0-9._-]*$' "$file" || true)"
  require_digits "$matching" "the manifest record count"
  [ "$lines" -eq "$matching" ] ||
    die "$CHECKSUM_NAME contains a record outside '<64 hex><two spaces><plain name>'"
  if grep -q '\.\.' "$file"; then
    die "$CHECKSUM_NAME names a path outside the backup directory"
  fi
  names="$(sed -e 's/^[0-9a-f]\{64\}  //' "$file")"
  sorted_names="$(printf '%s\n' "$names" | LC_ALL=C sort)"
  [ "$names" = "$sorted_names" ] ||
    die "$CHECKSUM_NAME records are not in canonical filename order"
  duplicates="$(printf '%s\n' "$names" | LC_ALL=C sort | uniq -d | grep -c . || true)"
  require_digits "$duplicates" "the duplicate manifest name count"
  [ "$duplicates" -eq 0 ] || die "$CHECKSUM_NAME lists the same file more than once"
}

# The metadata file is a closed grammar, not a bag of keys: the exact key set, in
# the exact order, with a value shape per key. Anything else is a file that was
# edited, generated by something else, or truncated.
assert_metadata_grammar() {
  file="$1"
  META_CONFIG_FILES=""
  META_DATABASE_DUMP_BYTES=""
  META_ARCHIVE_BYTES=""
  META_ARCHIVE_FILES=""
  META_SERVER_VOLUME=""
  META_POSTGRES_VOLUME=""
  META_SECRET_FILE_SCOPE=""
  expected="schema_version created_utc compose_project server_volume postgres_volume \
server_image_id database_dump database_dump_bytes migration_rows server_data_archive \
server_data_archive_bytes server_data_files secret_file_scope config_files"
  # shellcheck disable=SC2086
  set -- $expected
  while IFS= read -r line; do
    [ "$#" -gt 0 ] || die "$METADATA_NAME has more lines than the backup metadata grammar defines"
    key="$1"
    shift
    case "$line" in
      "$key="*) ;;
      *) die "$METADATA_NAME line does not start with the expected key '$key='" ;;
    esac
    value="${line#"$key="}"
    case "$key" in
      schema_version)
        [ "$value" = "$SCHEMA_VERSION" ] || die "$METADATA_NAME declares an unsupported schema version"
        ;;
      created_utc)
        printf '%s\n' "$value" |
          grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' ||
          die "$METADATA_NAME has a malformed created_utc"
        ;;
      server_image_id) require_image_id "$value" "$METADATA_NAME's server_image_id" ;;
      database_dump)
        [ "$value" = "$DUMP_NAME" ] || die "$METADATA_NAME names an unexpected database dump"
        ;;
      server_data_archive)
        [ "$value" = "$ARCHIVE_NAME" ] || die "$METADATA_NAME names an unexpected server-data archive"
        ;;
      database_dump_bytes | migration_rows | server_data_archive_bytes | server_data_files)
        require_digits "$value" "$METADATA_NAME's $key"
        [ "$value" -gt 0 ] || die "$METADATA_NAME records $key as zero"
        case "$key" in
          database_dump_bytes) META_DATABASE_DUMP_BYTES="$value" ;;
          server_data_archive_bytes) META_ARCHIVE_BYTES="$value" ;;
          server_data_files) META_ARCHIVE_FILES="$value" ;;
        esac
        ;;
      secret_file_scope)
        # Backup generation can only ever produce these two. A third value the
        # verifier tolerates is a free hiding place: metadata and checksums can
        # both be recomputed, so a scope nothing cross-checks would conceal a
        # secret key that is not in this directory at all.
        case "$value" in
          archived | external) ;;
          *) die "$METADATA_NAME has an unknown secret_file_scope; only archived and external are ever written" ;;
        esac
        META_SECRET_FILE_SCOPE="$value"
        ;;
      config_files)
        case "$value" in
          .env,etebase-server.ini,docker-compose.yml | \
          .env,etebase-server.ini,docker-compose.yml,docker-compose.override.yml | \
          .env,etebase-server.ini,docker-compose.yml,server-image.json | \
          .env,etebase-server.ini,docker-compose.yml,docker-compose.override.yml,server-image.json)
            META_CONFIG_FILES="$value"
            ;;
          *) die "$METADATA_NAME has a malformed or non-canonical config_files list" ;;
        esac
        ;;
      compose_project) require_token "$value" "$METADATA_NAME's $key" ;;
      server_volume)
        require_token "$value" "$METADATA_NAME's $key"
        META_SERVER_VOLUME="$value"
        ;;
      postgres_volume)
        require_token "$value" "$METADATA_NAME's $key"
        META_POSTGRES_VOLUME="$value"
        ;;
      *) require_token "$value" "$METADATA_NAME's $key" ;;
    esac
  done < "$file"
  [ "$#" -eq 0 ] || die "$METADATA_NAME is missing keys: $*"
  [ "$META_SERVER_VOLUME" != "$META_POSTGRES_VOLUME" ] ||
    die "$METADATA_NAME records one shared server/database volume"
}

# One canonical snapshot ties every pathname to its directory entry and file
# identity. Nanosecond mtime, size and mode catch in-place writes; device and
# inode catch replacement; the directory identity and sorted inventory catch a
# swapped directory or added/removed entry. Content is rechecked separately.
backup_identity_snapshot() {
  dir="$1"
  stat --format='directory %d:%i:%f:%s:%y' -- "$dir" || return 1
  find "$dir" -mindepth 1 -maxdepth 1 -exec \
    stat --format='entry %d:%i:%f:%s:%y:%n' -- {} + | LC_ALL=C sort
}

cmd_verify() {
  [ "$#" -eq 1 ] || usage
  dir="$1"
  [ -d "$dir" ] || die "'$dir' is not a directory"
  [ ! -L "$dir" ] || die "'$dir' is a symlink; refusing to verify through it"
  [ -f "$dir/$CHECKSUM_NAME" ] && [ ! -L "$dir/$CHECKSUM_NAME" ] ||
    die "'$dir' has no regular $CHECKSUM_NAME"
  [ -f "$dir/$METADATA_NAME" ] && [ ! -L "$dir/$METADATA_NAME" ] ||
    die "'$dir' has no regular $METADATA_NAME"

  unexpected="$(find "$dir" -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
  [ -z "$unexpected" ] ||
    die "'$dir' contains a non-regular or nested entry; refusing an ambiguous inventory"

  assert_checksum_grammar "$dir/$CHECKSUM_NAME"

  # Exact inventory. Deleting a manifest line must be detected, so the listed
  # set and the present set must be equal, not merely overlapping.
  listed="$(sed -e 's/^[0-9a-f]\{64\}  //' "$dir/$CHECKSUM_NAME" | LC_ALL=C sort)"
  present="$( ( cd "$dir" && find . -maxdepth 1 ! -name . -printf '%y %P\n' ) |
    sed -n 's/^f //p' | grep -Fxv "$CHECKSUM_NAME" | LC_ALL=C sort)"
  [ "$listed" = "$present" ] ||
    die "'$dir' does not match its manifest: files were added, removed or renamed"

  verified_snapshot="$(backup_identity_snapshot "$dir")" ||
    die "'$dir' changed while its file identities were being recorded"
  manifest_digest="$(sha256sum -- "$dir/$CHECKSUM_NAME")" ||
    die "could not fingerprint $CHECKSUM_NAME"

  ( cd "$dir" && sha256sum --quiet --check -- "$CHECKSUM_NAME" >/dev/null ) ||
    die "'$dir' failed checksum verification"

  assert_metadata_grammar "$dir/$METADATA_NAME"

  expected="$(
    {
      printf '%s\n' "$DUMP_NAME" "$ARCHIVE_NAME" "$METADATA_NAME"
      printf '%s\n' "$META_CONFIG_FILES" | tr ',' '\n'
    } | LC_ALL=C sort
  )"
  [ "$listed" = "$expected" ] ||
    die "'$dir' does not contain the exact inventory declared by $METADATA_NAME"

  actual_dump_bytes="$(wc -c < "$dir/$DUMP_NAME" | tr -d '[:space:]')"
  actual_archive_bytes="$(wc -c < "$dir/$ARCHIVE_NAME" | tr -d '[:space:]')"
  [ "$actual_dump_bytes" = "$META_DATABASE_DUMP_BYTES" ] ||
    die "$METADATA_NAME's database dump size does not match the file"
  [ "$actual_archive_bytes" = "$META_ARCHIVE_BYTES" ] ||
    die "$METADATA_NAME's server-data archive size does not match the file"
  # tar's own exit status is the only proof the archive is structurally whole:
  # a truncated or corrupt archive can list every expected member before it
  # fails, and a manifest can be recomputed around it. Listing and counting are
  # therefore separate statements, so that the `|| true` which excuses grep's
  # "no matches" exit 1 can never also excuse a failed tar.
  archive_listing="$(tar -tvzf "$dir/$ARCHIVE_NAME")" ||
    die "'$dir' has a server-data archive that could not be listed; it is truncated or corrupt"
  actual_archive_files="$(printf '%s\n' "$archive_listing" | grep -c '^-' || true)"
  require_digits "$actual_archive_files" "the verified archive's regular-file count"
  [ "$actual_archive_files" = "$META_ARCHIVE_FILES" ] ||
    die "$METADATA_NAME's server-data file count does not match the archive"

  # The recorded scope is a claim by whoever wrote the metadata; the semantic
  # scope is what the backed-up etebase-server.ini actually says, read with the
  # same grammar the server and the backup path use. Both the config and the
  # archive matched the manifest above, so this cross-check enforces the
  # semantic scope that any internally consistent backup must satisfy.
  read_secret_file_declaration "$dir/etebase-server.ini"
  classify_secret_file "$SECRET_FILE_VALUE"
  if [ "$SECRET_FILE_SCOPE" = archived ]; then
    archive_members="$(printf '%s\n' "$archive_listing" | archive_regular_members)"
    assert_archived_member "$SECRET_FILE_RELATIVE" \
      "etebase-server.ini declares a secret_file under $SERVER_TARGET that the archive does not hold as a regular file" \
      <<< "$archive_members"
  fi
  [ "$META_SECRET_FILE_SCOPE" = "$SECRET_FILE_SCOPE" ] ||
    die "$METADATA_NAME records secret_file_scope=$META_SECRET_FILE_SCOPE, but etebase-server.ini resolves to $SECRET_FILE_SCOPE"

  # Re-read all content against the pinned manifest, then require the manifest,
  # every entry identity and the directory inventory to be exactly what the
  # semantic checks above observed. Nothing mutable is read after this point.
  ( cd "$dir" && sha256sum --quiet --check -- "$CHECKSUM_NAME" >/dev/null ) ||
    die "'$dir' changed during verification"
  [ "$(sha256sum -- "$dir/$CHECKSUM_NAME")" = "$manifest_digest" ] ||
    die "$CHECKSUM_NAME changed during verification"
  final_snapshot="$(backup_identity_snapshot "$dir")" ||
    die "'$dir' changed while its file identities were revalidated"
  [ "$final_snapshot" = "$verified_snapshot" ] ||
    die "'$dir' changed during verification"

  echo "Backup verified: $dir"
  # The same honesty the backup path owes an operator: an external key is not in
  # this directory, and a verified backup must not let anyone believe it is.
  case "$SECRET_FILE_SCOPE" in
    archived)
      echo "  the configured secret_file is present in $ARCHIVE_NAME"
      ;;
    *)
      echo "  your server secret key is NOT in this backup: secret_file is outside"
      echo "  $SERVER_TARGET, is operator-managed, and must be backed up separately"
      ;;
  esac
}

# ── Entry point ───────────────────────────────────────────────────────

[ "$#" -ge 1 ] || usage
action="$1"
shift

case "$action" in
  inspect)
    command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
    [ "$#" -eq 0 ] || usage
    cmd_inspect
    ;;
  backup)
    command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
    cmd_backup "$@"
    ;;
  verify) cmd_verify "$@" ;;
  *) usage ;;
esac
