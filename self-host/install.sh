#!/usr/bin/env bash
set -euo pipefail

# SilentSuite Self-Hosted Installer
# -----------------------------------
# Installs the SilentSuite sync server with PostgreSQL from a published,
# checksummed release bundle. Can be run standalone via:
#   curl -fsSL https://raw.githubusercontent.com/silent-suite/silentsuite/main/self-host/install.sh | bash
#
# Pin to a specific release:
#   curl -fsSL .../install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash
# Or, when running locally:
#   bash install.sh --version v0.1.0-beta
#
# What it will not do:
#   * install from an unverified source — there is no branch fallback;
#   * run a mutable image tag — the server image is selected by the immutable
#     OCI index digest recorded in the release manifest;
#   * install from a draft, a mismatched tag, or a release missing the self-host
#     assets;
#   * touch an existing path. The target must not exist; it is created once,
#     atomically, after every verification has passed. Re-running the installer
#     is not the upgrade path (see SELF-HOSTING.md).
#
# What the checksum does and does not prove: it detects corruption in transit
# and any inconsistency between the bundle, its sidecar, and the manifest as
# they are published right now. It is not evidence that a release asset was
# never replaced — a repository administrator can still replace a published
# asset and its sidecar together. What cannot be swapped underneath you is the
# image: the server runs the exact OCI index digest recorded in the manifest,
# checked against the registry before anything starts.

REPO="silent-suite/silentsuite"
IMAGE_REPOSITORY="ghcr.io/silent-suite/silentsuite-server"
# The database image is fixed source data, not release data: it ships inside the
# checksummed bundle rather than in server-image.json, so it needs no per-release
# manifest field. It is still an immutable digest — the container holds the
# database password and every account row, so a republished upstream tag must
# not be able to change what runs.
POSTGRES_IMAGE="postgres@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"
INSTALL_DIR="${SILENTSUITE_DIR:-silentsuite-server}"
REQUESTED_VERSION=""
STAGE_DIR=""
STAGE_ONLY=0

# ── Parse arguments ───────────────────────────────────────────────────

usage() {
  cat <<EOF
Usage: install.sh [--version <tag>] [--stage-only <dir>]

  --version <tag>     Install a specific SilentSuite release (e.g. v0.1.0-beta).
                      Default: the newest published umbrella release that ships
                      verified self-host assets.
  --stage-only <dir>  Download and verify the release bundle into <dir>, then
                      stop. Runs the release-metadata, tag-to-commit, checksum,
                      manifest and archive checks; does NOT pull an image or
                      contact the registry, so the live image-identity check is
                      skipped. Nothing is installed and no container is started.
                      <dir> must not exist yet and its parent must be a
                      directory you own that other users cannot write.
  -h, --help          Show this message and exit.

Environment:
  SILENTSUITE_DIR             Install directory (default: silentsuite-server).
  SILENTSUITE_VERSION         Same as --version. Useful for the curl-pipe pattern:
                              curl -fsSL .../install.sh | SILENTSUITE_VERSION=v0.1.0-beta bash
                              (CLI --version takes precedence over the env var.)
  SILENTSUITE_DOMAIN          Answer the domain prompt non-interactively.
  SILENTSUITE_PROXY_NETWORK   Answer the reverse-proxy-network prompt
                              non-interactively (empty means "no proxy network").
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
        echo "ERROR: --version requires a non-empty tag (e.g. --version v0.1.0-beta)" >&2
        exit 1
      fi
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --version=*)
      REQUESTED_VERSION="${1#--version=}"
      if [ -z "$REQUESTED_VERSION" ]; then
        echo "ERROR: --version requires a non-empty tag (e.g. --version=v0.1.0-beta)" >&2
        exit 1
      fi
      shift
      ;;
    --stage-only)
      if [ $# -lt 2 ] || [ -z "$2" ] || [ "${2#-}" != "$2" ]; then
        echo "ERROR: --stage-only requires a target directory" >&2
        exit 1
      fi
      STAGE_DIR="$2"
      STAGE_ONLY=1
      shift 2
      ;;
    --stage-only=*)
      STAGE_DIR="${1#--stage-only=}"
      STAGE_ONLY=1
      if [ -z "$STAGE_DIR" ]; then
        echo "ERROR: --stage-only requires a target directory" >&2
        exit 1
      fi
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument '$1'. Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

echo "============================================"
echo "  SilentSuite Self-Hosted Installer"
echo "============================================"
echo ""

# ── Prerequisites ──────────────────────────────────────────────────────

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' is not installed. Please install it first." >&2
    exit 1
  fi
}

check_command curl
check_command tar

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "ERROR: neither 'sha256sum' nor 'shasum' is available; cannot verify downloads." >&2
  exit 1
fi

COMPOSE=""
if [ "$STAGE_ONLY" -eq 0 ]; then
  check_command docker
  check_command openssl
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    echo "ERROR: 'docker compose' is not available. Please install Docker Compose v2." >&2
    exit 1
  fi
  echo "Prerequisites OK: docker, $COMPOSE, openssl, curl, tar"
else
  echo "Prerequisites OK: curl, tar (staging only)"
fi
echo ""

# ── Validate the target and the directory that will hold it ───────────
#
# The target must not exist at all: not as a file, not as a symlink, not even as
# an empty directory. Re-running the installer is not an upgrade path, and an
# existing empty directory cannot be trusted to still be the same empty
# directory — or a directory at all — by the time the download, verification and
# image pull have finished.
#
# The parent must already exist and be a real directory this user owns that no
# other local principal can write. That is what makes the atomic claim further
# down meaningful: without it, someone else could plant a symlink or a populated
# directory under the target name during the long verification interval, and the
# installer would write credentials and Compose state through it.

TARGET_DIR="$INSTALL_DIR"
if [ "$STAGE_ONLY" -eq 1 ]; then
  TARGET_DIR="$STAGE_DIR"
fi

while [ "$TARGET_DIR" != "/" ] && [ "${TARGET_DIR%/}" != "$TARGET_DIR" ]; do
  TARGET_DIR="${TARGET_DIR%/}"
done
TARGET_PARENT="$(dirname -- "$TARGET_DIR")"
TARGET_NAME="$(basename -- "$TARGET_DIR")"
case "$TARGET_NAME" in
  ""|"."|".."|"/")
    echo "ERROR: target '$TARGET_DIR' does not name a new directory." >&2
    exit 1
    ;;
esac

TARGET_PARENT_CANONICAL=""

assert_trusted_parent() {
  local uid resolved
  uid="$(id -u)"
  if [ ! -d "$TARGET_PARENT" ]; then
    echo "ERROR: the parent directory '$TARGET_PARENT' does not exist." >&2
    echo "       Create it yourself first; the installer will not build a path it" >&2
    echo "       cannot vouch for." >&2
    exit 1
  fi
  resolved="$(CDPATH='' cd -P -- "$TARGET_PARENT" 2>/dev/null && pwd -P)" || resolved=""
  if [ -z "$resolved" ] || [ ! -d "$resolved" ]; then
    echo "ERROR: the parent directory '$TARGET_PARENT' does not resolve to a real directory." >&2
    exit 1
  fi
  # Once canonicalised, the parent must keep resolving to the same real
  # directory. A different answer means a path component was replaced while the
  # release was being verified, which is exactly the substitution the claim
  # below is meant to survive.
  if [ -n "$TARGET_PARENT_CANONICAL" ] && [ "$resolved" != "$TARGET_PARENT_CANONICAL" ]; then
    echo "ERROR: '$TARGET_PARENT' now resolves to '$resolved', not '$TARGET_PARENT_CANONICAL'." >&2
    echo "       A path component changed while the release was being verified." >&2
    exit 1
  fi
  TARGET_PARENT_REAL="$resolved"
  # Owned by this user and writable by nobody else: the two properties that make
  # the single mkdir below an actual claim rather than a hopeful one.
  if [ -z "$(find "$TARGET_PARENT_REAL" -maxdepth 0 -uid "$uid" ! -perm /022 -print 2>/dev/null)" ]; then
    echo "ERROR: '$TARGET_PARENT_REAL' must be owned by UID ${uid} and must not be" >&2
    echo "       group- or world-writable." >&2
    echo "       Another local user could otherwise replace '$TARGET_NAME' while the" >&2
    echo "       release is being downloaded and verified." >&2
    exit 1
  fi
}

assert_trusted_parent

# Address the target only through the resolved parent from here on. The original
# path may run through symlinks, and a symlink can be re-pointed during the long
# verification interval; a canonical absolute path cannot. This is what stops the
# final mkdir from ever traversing the lexical path it was given.
TARGET_PARENT_CANONICAL="$TARGET_PARENT_REAL"
TARGET_PARENT="$TARGET_PARENT_REAL"
if [ "$TARGET_PARENT_REAL" = "/" ]; then
  TARGET_DIR="/$TARGET_NAME"
else
  TARGET_DIR="$TARGET_PARENT_REAL/$TARGET_NAME"
fi

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  echo "ERROR: target directory '$TARGET_DIR' already exists; refusing to use it." >&2
  echo "       This installer only ever creates a new directory." >&2
  if [ "$STAGE_ONLY" -eq 0 ]; then
    echo "       Re-running the installer is NOT the upgrade path and nothing was changed." >&2
  else
    echo "       Stage-only output requires a target that does not exist yet." >&2
  fi
  exit 1
fi

# Everything downstream writes to the canonical path resolved above, never to
# the path as it was typed.
if [ "$STAGE_ONLY" -eq 1 ]; then
  STAGE_DIR="$TARGET_DIR"
else
  INSTALL_DIR="$TARGET_DIR"
fi

claim_target() {
  # The first write to the target, and deliberately the only way one happens.
  # A single mkdir without -p is the claim: it is atomic, it fails if anything
  # at all now exists under that name, and it never follows a symlink planted
  # during verification. The canonical parent is re-validated first, and must
  # still resolve to the same real directory, so the claim really is made inside
  # the directory that was vetted.
  assert_trusted_parent
  if ! mkdir -- "$TARGET_DIR" 2>/dev/null; then
    echo "ERROR: '$TARGET_DIR' appeared while the release was being verified." >&2
    echo "       Nothing was written to it. Find out what created it before retrying." >&2
    exit 1
  fi
  if [ -L "$TARGET_DIR" ] || [ ! -d "$TARGET_DIR" ]; then
    echo "ERROR: '$TARGET_DIR' is not the directory this installer just created." >&2
    exit 1
  fi
  # 0750 keeps secrets in .env and etebase-server.ini out of reach of other
  # local users on shared hosts — the install dir is a single-operator surface.
  chmod 750 "$TARGET_DIR"
}

# Compose uses stable container names for upgrade compatibility. A second local
# install cannot safely coexist with those names, so refuse before downloading
# anything rather than stopping an existing stack later.
if [ "$STAGE_ONLY" -eq 0 ]; then
  for container in silentsuite-postgres silentsuite-server; do
    if docker container inspect "$container" >/dev/null 2>&1; then
      echo "ERROR: container '$container' already exists." >&2
      echo "       This installer will not stop or replace an existing SilentSuite stack." >&2
      echo "       This installer only performs fresh installations (see SELF-HOSTING.md)." >&2
      exit 1
    fi
  done
fi

# ── Host architecture ─────────────────────────────────────────────────

MACHINE="$(uname -m)"
case "$MACHINE" in
  x86_64|amd64) HOST_PLATFORM="linux/amd64" ;;
  aarch64|arm64) HOST_PLATFORM="linux/arm64" ;;
  *)
    echo "ERROR: unsupported host architecture '$MACHINE'." >&2
    echo "       SilentSuite server images are published for linux/amd64 and linux/arm64." >&2
    exit 1
    ;;
esac
echo "Host platform: $HOST_PLATFORM ($MACHINE)"

# ── Temporary workspace ───────────────────────────────────────────────

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/silentsuite-install.XXXXXXXX")"
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# ── Resolve the release ───────────────────────────────────────────────
#
# A mutable version tag is only ever used to *discover* a release. What gets
# installed is decided by the immutable digests inside that release's manifest.

is_release_tag() {
  printf '%s' "$1" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

release_metadata() {
  # Published releases only: the API answers 404 for drafts, which is exactly
  # the behaviour we want — an unpublished draft is not installable.
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/$1" 2>/dev/null
}

# GitHub returns pretty-printed JSON, so a top-level release field sits at
# exactly two spaces. Nested objects (assets, author) are indented deeper, and
# string values such as the release body are single escaped lines, so these
# anchors cannot be satisfied from inside one. Exactly one declaration must
# exist and it must be the literal the check names; absent, duplicated, quoted
# or otherwise malformed all fail closed. Fixed-string matching throughout, so
# a tag's dots cannot act as regex wildcards.

release_is_published() {
  local metadata="$1"
  [ "$(printf '%s\n' "$metadata" | grep -cE '^  "draft":' | tr -d ' ')" = "1" ] || return 1
  printf '%s\n' "$metadata" | grep -qxF -e '  "draft": false,' -e '  "draft": false'
}

release_tag_matches() {
  local metadata="$1" tag="$2"
  [ "$(printf '%s\n' "$metadata" | grep -cE '^  "tag_name":' | tr -d ' ')" = "1" ] || return 1
  printf '%s\n' "$metadata" | grep -qxF -e "  \"tag_name\": \"${tag}\"," -e "  \"tag_name\": \"${tag}\""
}

release_has_self_host_assets() {
  local metadata="$1" tag="$2"
  printf '%s' "$metadata" | grep -q "\"name\": *\"silentsuite-self-host-${tag}\.tar\.gz\"" &&
    printf '%s' "$metadata" | grep -q "\"name\": *\"silentsuite-self-host-${tag}\.tar\.gz\.sha256\"" &&
    printf '%s' "$metadata" | grep -q "\"name\": *\"server-image\.json\""
}

candidate_tags() {
  # Newest-first umbrella tags. Component releases (bridge-vX, vX-android, ...)
  # are filtered out; the same convention the other installers use.
  curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=20" 2>/dev/null \
    | grep -E '"tag_name":' \
    | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' \
    | grep -vE '^(bridge|android|server|web)-|-(bridge|android|server|web)$' || true
}

VERSION=""
RELEASE_METADATA=""

if [ -n "$REQUESTED_VERSION" ] || [ -n "${SILENTSUITE_VERSION:-}" ]; then
  VERSION="${REQUESTED_VERSION:-${SILENTSUITE_VERSION}}"
  if ! is_release_tag "$VERSION"; then
    echo "ERROR: '$VERSION' is not a SilentSuite release tag (expected vMAJOR.MINOR.PATCH[-suffix])." >&2
    exit 1
  fi
  RELEASE_METADATA="$(release_metadata "$VERSION" || true)"
  if [ -z "$RELEASE_METADATA" ]; then
    echo "ERROR: release '$VERSION' is not published." >&2
    echo "       Check https://github.com/${REPO}/releases" >&2
    exit 1
  fi
  if ! release_is_published "$RELEASE_METADATA"; then
    echo "ERROR: release '$VERSION' is a draft, not a published release." >&2
    echo "       A draft's assets are not final; refusing to install from one." >&2
    exit 1
  fi
  if ! release_tag_matches "$RELEASE_METADATA" "$VERSION"; then
    echo "ERROR: the release returned for '$VERSION' is tagged something else." >&2
    echo "       Refusing to install a release that is not the one requested." >&2
    exit 1
  fi
  if ! release_has_self_host_assets "$RELEASE_METADATA" "$VERSION"; then
    echo "ERROR: release '$VERSION' does not ship verified self-host assets." >&2
    exit 1
  fi
else
  echo "Looking for the newest published release with self-host assets..."
  while read -r candidate; do
    [ -n "$candidate" ] || continue
    is_release_tag "$candidate" || continue
    metadata="$(release_metadata "$candidate" || true)"
    [ -n "$metadata" ] || continue
    release_is_published "$metadata" || continue
    release_tag_matches "$metadata" "$candidate" || continue
    if release_has_self_host_assets "$metadata" "$candidate"; then
      VERSION="$candidate"
      RELEASE_METADATA="$metadata"
      break
    fi
  done <<EOF
$(candidate_tags)
EOF
fi

if [ -z "$VERSION" ]; then
  echo "ERROR: no published SilentSuite release with self-host assets was found." >&2
  echo "       Self-hosting requires a release bundle; installing from a branch is" >&2
  echo "       not supported because a branch has no verified server image." >&2
  echo "       See https://github.com/${REPO}/releases" >&2
  exit 1
fi

# The discovery loop skips a candidate that fails any of the checks above, so a
# selected version has already been proven published, correctly tagged, and in
# possession of the self-host assets by the time it gets here.

echo "Installing SilentSuite version: $VERSION (published release)"
echo ""

BUNDLE_NAME="silentsuite-self-host-${VERSION}.tar.gz"
BUNDLE_PREFIX="silentsuite-self-host-${VERSION}"
CHECKSUM_NAME="${BUNDLE_NAME}.sha256"
MANIFEST_NAME="server-image.json"
DOWNLOAD_BASE="https://github.com/${REPO}/releases/download/${VERSION}"

BUNDLE_FILE="$WORKDIR/$BUNDLE_NAME"
CHECKSUM_FILE="$WORKDIR/$CHECKSUM_NAME"
MANIFEST_FILE="$WORKDIR/$MANIFEST_NAME"

echo "Downloading release assets..."
for asset in "$BUNDLE_NAME" "$CHECKSUM_NAME" "$MANIFEST_NAME"; do
  if ! curl -fsSL "$DOWNLOAD_BASE/$asset" -o "$WORKDIR/$asset"; then
    echo "ERROR: could not download '$asset' from release $VERSION." >&2
    exit 1
  fi
done

# ── Verify the checksum sidecar ───────────────────────────────────────
#
# Strict grammar: exactly one record, 64 hex digits, two spaces, the exact
# bundle basename, one terminating newline. Anything else is rejected rather
# than "best-effort parsed".

escape_ere() {
  printf '%s' "$1" | sed 's/[][\.*^$/+?(){}|]/\\&/g'
}

verify_checksum_file() {
  local file="$1" expected_name="$2" pattern
  if [ ! -s "$file" ]; then
    echo "ERROR: checksum file for '$expected_name' is empty." >&2
    exit 1
  fi
  if [ "$(tail -c 1 "$file" | od -An -tu1 | tr -d ' \n')" != "10" ]; then
    echo "ERROR: checksum file for '$expected_name' does not end with a newline." >&2
    exit 1
  fi
  if [ "$(wc -l < "$file" | tr -d ' ')" != "1" ]; then
    echo "ERROR: checksum file for '$expected_name' must contain exactly one record." >&2
    exit 1
  fi
  pattern="^[0-9a-fA-F]{64}  $(escape_ere "$expected_name")\$"
  if [ "$(grep -cE "$pattern" "$file" | tr -d ' ')" != "1" ]; then
    echo "ERROR: checksum file for '$expected_name' is malformed or names a different file." >&2
    exit 1
  fi
}

verify_checksum_file "$CHECKSUM_FILE" "$BUNDLE_NAME"

EXPECTED_DIGEST="$(cut -c1-64 < "$CHECKSUM_FILE" | tr 'A-F' 'a-f')"
ACTUAL_DIGEST="$(sha256_of "$BUNDLE_FILE" | tr 'A-F' 'a-f')"
if [ "$EXPECTED_DIGEST" != "$ACTUAL_DIGEST" ]; then
  echo "ERROR: '$BUNDLE_NAME' does not match its published checksum." >&2
  echo "       expected $EXPECTED_DIGEST" >&2
  echo "       actual   $ACTUAL_DIGEST" >&2
  exit 1
fi
echo "Bundle checksum verified: $ACTUAL_DIGEST"

# ── Verify the image manifest ─────────────────────────────────────────
#
# server-image.json is generated in a fixed shape by the release workflow, so it
# is parsed with an exact line grammar instead of requiring a JSON tool on the
# operator's machine.

manifest_error() {
  echo "ERROR: server-image.json for $VERSION is not a valid SilentSuite release manifest ($1)." >&2
  exit 1
}

manifest_single_match() {
  local pattern="$1"
  [ "$(grep -cE "$pattern" "$MANIFEST_FILE" | tr -d ' ')" = "1" ]
}

manifest_value() {
  local key="$1"
  grep -E "^  \"$key\": \"" "$MANIFEST_FILE" | sed -E "s/^  \"$key\": \"(.*)\",?\$/\1/"
}

[ "$(wc -l < "$MANIFEST_FILE" | tr -d ' ')" = "14" ] || manifest_error "unexpected length"
[ "$(head -c 1 "$MANIFEST_FILE")" = "{" ] || manifest_error "does not start with an object"
[ "$(grep -cE '^  "' "$MANIFEST_FILE" | tr -d ' ')" = "9" ] || manifest_error "unexpected field set"

manifest_single_match '^  "schemaVersion": 1,$' || manifest_error "unsupported schema version"
manifest_single_match "^  \"tag\": \"$(escape_ere "$VERSION")\",\$" || manifest_error "tag mismatch"
manifest_single_match '^  "sourceCommit": "[0-9a-f]{40}",$' || manifest_error "source commit"
manifest_single_match "^  \"imageRepository\": \"$(escape_ere "$IMAGE_REPOSITORY")\",\$" || manifest_error "image repository"
manifest_single_match '^  "indexDigest": "sha256:[0-9a-f]{64}",$' || manifest_error "index digest"
manifest_single_match '^  "amd64Digest": "sha256:[0-9a-f]{64}",$' || manifest_error "amd64 digest"
manifest_single_match '^  "arm64Digest": "sha256:[0-9a-f]{64}",$' || manifest_error "arm64 digest"
manifest_single_match '^  "platforms": \[$' || manifest_error "platform list"
manifest_single_match '^  "expectedRevision": "[0-9a-f]{40}"$' || manifest_error "expected revision"
manifest_single_match '^    "linux/amd64",$' || manifest_error "platform list"
manifest_single_match '^    "linux/arm64"$' || manifest_error "platform list"

INDEX_DIGEST="$(manifest_value indexDigest)"
AMD64_DIGEST="$(manifest_value amd64Digest)"
ARM64_DIGEST="$(manifest_value arm64Digest)"
SOURCE_COMMIT="$(manifest_value sourceCommit)"
EXPECTED_REVISION="$(manifest_value expectedRevision)"

if [ "$EXPECTED_REVISION" != "$SOURCE_COMMIT" ]; then
  manifest_error "revision does not match the release commit"
fi
if [ "$INDEX_DIGEST" = "$AMD64_DIGEST" ] || [ "$INDEX_DIGEST" = "$ARM64_DIGEST" ] || [ "$AMD64_DIGEST" = "$ARM64_DIGEST" ]; then
  manifest_error "index and platform digests must differ"
fi
if ! grep -qE "^    \"$(escape_ere "$HOST_PLATFORM")\",?\$" "$MANIFEST_FILE"; then
  echo "ERROR: release $VERSION does not publish an image for $HOST_PLATFORM." >&2
  exit 1
fi

# The manifest names the commit it was built from. Confirm that this really is
# the commit the release tag points at, so a bundle cannot claim provenance from
# a commit that was never tagged. The comparison endpoint peels annotated tags
# and answers with a single unambiguous top-level verdict, which keeps this a
# strict grep rather than a hand-rolled JSON parser.
COMPARE="$(curl -fsSL "https://api.github.com/repos/${REPO}/compare/${SOURCE_COMMIT}...${VERSION}" 2>/dev/null || true)"
if [ -z "$COMPARE" ]; then
  echo "ERROR: could not confirm that $VERSION points at commit $SOURCE_COMMIT." >&2
  echo "       Refusing to install a bundle whose source commit cannot be checked." >&2
  exit 1
fi
for expectation in '"status": *"identical"' '"ahead_by": *0[,}]' '"behind_by": *0[,}]' '"total_commits": *0[,}]'; do
  if ! printf '%s' "$COMPARE" | grep -Eq "$expectation"; then
    echo "ERROR: release tag $VERSION does not point at $SOURCE_COMMIT, the commit named" >&2
    echo "       in server-image.json. Refusing to install." >&2
    exit 1
  fi
done

SERVER_IMAGE="${IMAGE_REPOSITORY}@${INDEX_DIGEST}"
echo "Release manifest verified:"
echo "  tag       $VERSION"
echo "  commit    $SOURCE_COMMIT"
echo "  image     $SERVER_IMAGE"
echo "  platforms linux/amd64, linux/arm64"
echo "  tag $VERSION confirmed to point at $SOURCE_COMMIT"

# ── Verify the archive before extracting anything ─────────────────────

MEMBER_LIST="$WORKDIR/members.txt"
if ! tar -tzf "$BUNDLE_FILE" > "$MEMBER_LIST"; then
  echo "ERROR: '$BUNDLE_NAME' is not a readable gzip archive." >&2
  exit 1
fi
if ! tar -tvzf "$BUNDLE_FILE" > "$WORKDIR/members-verbose.txt"; then
  echo "ERROR: '$BUNDLE_NAME' could not be listed." >&2
  exit 1
fi

if grep -qE '^[^-d]' "$WORKDIR/members-verbose.txt" || grep -q ' -> ' "$WORKDIR/members-verbose.txt"; then
  echo "ERROR: '$BUNDLE_NAME' contains links or special files; refusing to extract it." >&2
  exit 1
fi

ENTRY_LIST="$WORKDIR/entries.txt"
: > "$ENTRY_LIST"
while IFS= read -r member; do
  [ -n "$member" ] || continue
  case "$member" in
    /*|"$BUNDLE_PREFIX"/../*|*/../*|*/..|../*|..)
      echo "ERROR: '$BUNDLE_NAME' contains an unsafe path: $member" >&2
      exit 1
      ;;
  esac
  case "$member" in
    "$BUNDLE_PREFIX"|"$BUNDLE_PREFIX"/) continue ;;
    "$BUNDLE_PREFIX"/*) printf '%s\n' "${member#"$BUNDLE_PREFIX"/}" >> "$ENTRY_LIST" ;;
    *)
      echo "ERROR: '$BUNDLE_NAME' contains a member outside $BUNDLE_PREFIX/: $member" >&2
      exit 1
      ;;
  esac
done < "$MEMBER_LIST"

# The bundle inventory is closed: exactly these files, nothing missing and
# nothing extra. An unexpected member is a red flag even when its path is safe.
EXPECTED_MEMBERS="$(printf '%s\n' \
  .env.example \
  SELF-HOSTING.md \
  backup.sh \
  close-signups.sh \
  docker-compose.yml \
  install.sh \
  server-image.json \
  success.html \
  update.sh \
  verify.sh | LC_ALL=C sort)"
ACTUAL_MEMBERS="$(sed 's#/$##' "$ENTRY_LIST" | LC_ALL=C sort)"
if [ "$ACTUAL_MEMBERS" != "$EXPECTED_MEMBERS" ]; then
  echo "ERROR: '$BUNDLE_NAME' does not contain the expected set of files." >&2
  echo "       unexpected: $(comm -23 <(printf '%s\n' "$ACTUAL_MEMBERS") <(printf '%s\n' "$EXPECTED_MEMBERS") | tr '\n' ' ')" >&2
  echo "       missing:    $(comm -13 <(printf '%s\n' "$ACTUAL_MEMBERS") <(printf '%s\n' "$EXPECTED_MEMBERS") | tr '\n' ' ')" >&2
  exit 1
fi

STAGING="$WORKDIR/staging"
mkdir -p "$STAGING"
tar -xzf "$BUNDLE_FILE" -C "$STAGING" --no-same-owner
BUNDLE_ROOT="$STAGING/$BUNDLE_PREFIX"

while IFS= read -r extracted; do
  if [ ! -f "$BUNDLE_ROOT/$extracted" ]; then
    echo "ERROR: '$BUNDLE_NAME' did not extract $extracted as a regular file." >&2
    exit 1
  fi
done <<MEMBERS
$EXPECTED_MEMBERS
MEMBERS

if ! cmp -s "$BUNDLE_ROOT/$MANIFEST_NAME" "$MANIFEST_FILE"; then
  echo "ERROR: the manifest inside '$BUNDLE_NAME' differs from the published manifest." >&2
  exit 1
fi

if ! grep -q 'SILENTSUITE_SERVER_IMAGE' "$BUNDLE_ROOT/docker-compose.yml"; then
  echo "ERROR: the bundled compose file does not use the managed server image." >&2
  exit 1
fi
if [ "$(grep -cF "image: $POSTGRES_IMAGE" "$BUNDLE_ROOT/docker-compose.yml" | tr -d ' ')" != "1" ]; then
  echo "ERROR: the bundled compose file does not pin PostgreSQL to the expected" >&2
  echo "       immutable digest ($POSTGRES_IMAGE)." >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*image:[[:space:]]*postgres:' "$BUNDLE_ROOT/docker-compose.yml"; then
  echo "ERROR: the bundled compose file starts PostgreSQL from a mutable tag." >&2
  exit 1
fi

echo "Bundle contents verified."
echo ""

# ── Stage-only mode stops here ────────────────────────────────────────

if [ "$STAGE_ONLY" -eq 1 ]; then
  # Every asset, tag/commit, archive and manifest check has passed. Claim the
  # target now, and populate only the directory this call created.
  claim_target
  cp -R "$BUNDLE_ROOT/." "$STAGE_DIR/"
  cp "$BUNDLE_FILE" "$STAGE_DIR/$BUNDLE_NAME"
  cp "$CHECKSUM_FILE" "$STAGE_DIR/$CHECKSUM_NAME"
  echo "Verified release $VERSION staged in: $STAGE_DIR"
  echo "Server image: $SERVER_IMAGE"
  echo "Note: staging stopped before the registry image-identity check."
  echo "      The digest above is what the manifest names, not something this"
  echo "      run pulled and confirmed. A real install performs that check."
  exit 0
fi

# ── Verify the registry actually serves the promised image ────────────
#
# Still before any operator state is touched: pulling populates the local image
# cache only. A mismatch here means the release manifest and the registry
# disagree, which must never reach a running stack.
#
# Scope, stated precisely: this checks the image this host actually pulls — its
# repo digest against the manifest's index digest, its platform against this
# host, and its build revision against the manifest's expectedRevision — and
# then the same digest and platform check for the pinned database image. It does
# not re-derive the published index: one host pulls one platform, and the closed
# two-platform index verification is done in CI by
# scripts/verify-server-image-release.sh before the bundle is built. That
# verifier needs registry credentials, which an operator installer must not hold.

echo "Verifying the published server image..."
if ! docker pull "$SERVER_IMAGE" >/dev/null; then
  echo "ERROR: could not pull $SERVER_IMAGE." >&2
  exit 1
fi

PULLED_REVISION="$(docker image inspect "$SERVER_IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || echo "")"
PULLED_PLATFORM="$(docker image inspect "$SERVER_IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || echo "")"
PULLED_DIGESTS="$(docker image inspect "$SERVER_IMAGE" --format '{{json .RepoDigests}}' 2>/dev/null || echo "")"

if [ "$PULLED_REVISION" != "$EXPECTED_REVISION" ]; then
  echo "ERROR: the pulled image reports revision '$PULLED_REVISION', expected '$EXPECTED_REVISION'." >&2
  exit 1
fi
if [ "$PULLED_PLATFORM" != "$HOST_PLATFORM" ]; then
  echo "ERROR: the pulled image is $PULLED_PLATFORM, expected $HOST_PLATFORM." >&2
  exit 1
fi
case "$PULLED_DIGESTS" in
  *"$IMAGE_REPOSITORY@$INDEX_DIGEST"*) ;;
  *)
    echo "ERROR: the pulled image is not $SERVER_IMAGE." >&2
    exit 1
    ;;
esac
echo "Registry identity verified: $SERVER_IMAGE ($PULLED_PLATFORM, revision $PULLED_REVISION)"

# The database image gets the same treatment, and for the same reason: it is
# about to hold the database password and every account row. Still before any
# operator state exists — pulling only populates the local image cache.
echo "Verifying the pinned PostgreSQL image..."
if ! docker pull "$POSTGRES_IMAGE" >/dev/null; then
  echo "ERROR: could not pull $POSTGRES_IMAGE." >&2
  echo "       The database image is pinned by digest; a tag will not be substituted." >&2
  exit 1
fi

PG_PLATFORM="$(docker image inspect "$POSTGRES_IMAGE" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || echo "")"
PG_DIGESTS="$(docker image inspect "$POSTGRES_IMAGE" --format '{{json .RepoDigests}}' 2>/dev/null || echo "")"

if [ "$PG_PLATFORM" != "$HOST_PLATFORM" ]; then
  echo "ERROR: the pulled PostgreSQL image is $PG_PLATFORM, expected $HOST_PLATFORM." >&2
  exit 1
fi
case "$PG_DIGESTS" in
  *"${POSTGRES_IMAGE#*@}"*) ;;
  *)
    echo "ERROR: the pulled image is not $POSTGRES_IMAGE." >&2
    exit 1
    ;;
esac
echo "Database identity verified: $POSTGRES_IMAGE ($PG_PLATFORM)"
echo ""

# ── Set up install directory ──────────────────────────────────────────

# Release assets, the tag/commit binding, the archive, the manifest and the
# registry image identity have all been verified by now. This is the first
# write outside the temporary workspace.
echo "Creating install directory: $INSTALL_DIR"
claim_target

for file in docker-compose.yml install.sh SELF-HOSTING.md update.sh verify.sh close-signups.sh backup.sh success.html .env.example "$MANIFEST_NAME"; do
  cp "$BUNDLE_ROOT/$file" "$INSTALL_DIR/$file"
done
chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/update.sh" "$INSTALL_DIR/verify.sh" "$INSTALL_DIR/close-signups.sh" "$INSTALL_DIR/backup.sh"

cd "$INSTALL_DIR"

# ── Gather configuration ──────────────────────────────────────────────

if [ -n "${SILENTSUITE_DOMAIN:-}" ]; then
  DOMAIN="$SILENTSUITE_DOMAIN"
else
  echo "Enter the domain name your server will be accessible at."
  echo "This is the hostname users will enter in the SilentSuite app."
  echo "Examples: sync.example.com, silentsuite.example.com"
  echo ""
  read -rp "Domain: " DOMAIN </dev/tty
fi

if [ -z "$DOMAIN" ]; then
  echo "ERROR: Domain cannot be empty." >&2
  exit 1
fi

if [ -n "${SILENTSUITE_PROXY_NETWORK+set}" ]; then
  PROXY_NETWORK="$SILENTSUITE_PROXY_NETWORK"
else
  echo ""
  echo "If you're using a Docker-based reverse proxy (Nginx Proxy Manager, Traefik),"
  echo "enter the Docker network name it runs on (leave empty to skip):"
  echo ""
  read -rp "Proxy network name [empty to skip]: " PROXY_NETWORK </dev/tty
  echo ""
fi

# ── Generate passwords ────────────────────────────────────────────────

echo "Generating secure passwords..."
DATABASE_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
SUPER_PASS=$(openssl rand -base64 16 | tr -d '/+=')
BOOTSTRAP_ADMIN_TOKEN=$(openssl rand -base64 32 | tr -d '/+=')

# ── Write .env ─────────────────────────────────────────────────────────

cat > .env <<EOF
# SilentSuite Self-Hosted Configuration
# Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC")

# Verified server image for release $VERSION (source commit $SOURCE_COMMIT).
# This is an immutable OCI index digest: it selects exactly one reviewed build
# and resolves to the right architecture on linux/amd64 and linux/arm64.
# Do not edit by hand — changing SilentSuite versions safely also requires a
# database backup and a migration step.
SILENTSUITE_SERVER_IMAGE=$SERVER_IMAGE

# Port the SilentSuite server listens on (default: 3735).
# Your reverse proxy should forward traffic to this port.
SERVER_PORT=3735

# Comma-separated reverse proxy IPs allowed to set X-Forwarded-* headers.
# Keep 127.0.0.1 for local host proxies. Use the exact Docker proxy container IP
# when a proxy container reaches the server over a Docker network.
TRUSTED_PROXY_IPS=127.0.0.1

# PostgreSQL credentials (auto-generated)
DATABASE_PASSWORD=$DATABASE_PASSWORD

# Django admin panel credentials (advanced use only).
# These are for the Etebase Django admin at https://$DOMAIN/admin/
# Most users don't need this — the first user to sign up in the
# SilentSuite app becomes the server admin automatically.
SUPER_USER=admin
SUPER_PASS=$SUPER_PASS

# Open registration toggle. "false" allows new signups (default; needed for
# the first admin to register). Flip to "true" once the admin is registered.
ETEBASE_DISABLE_SIGNUP=false

# One-time first-admin signup token. Use this only for the first signup by
# entering https://$DOMAIN/?bootstrap_token=$BOOTSTRAP_ADMIN_TOKEN as the
# server URL in the app. After the first account exists, the token is ignored.
ETEBASE_BOOTSTRAP_ADMIN_TOKEN=$BOOTSTRAP_ADMIN_TOKEN

# Hide the advanced Django /admin/ panel unless explicitly re-enabled.
ETEBASE_DISABLE_DJANGO_ADMIN=true
EOF

chmod 600 .env

# ── Proxy network override ─────────────────────────────────────────────

if [ -n "$PROXY_NETWORK" ]; then
  echo "PROXY_NETWORK=$PROXY_NETWORK" >> .env
  cat > docker-compose.override.yml <<OVERRIDE
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
  echo "Generated docker-compose.override.yml for proxy network: $PROXY_NETWORK"
fi

# ── Generate etebase-server.ini ────────────────────────────────────────

cat > etebase-server.ini <<INIEOF
; SilentSuite / Etebase server configuration
; Generated by install.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
;
; This file is mounted into the container at
; /etc/etebase-server/etebase-server.ini. Edit it and restart to apply:
;   docker compose restart server

[global]
secret_file = /data/secret.txt
debug = false
media_root = /data/media
static_root = /data/static

[allowed_hosts]
allowed_host1 = $DOMAIN
allowed_host2 = localhost

[database]
engine = django.db.backends.postgresql
name = silentsuite
user = silentsuite
password = $DATABASE_PASSWORD
host = postgres
port = 5432
INIEOF
# 0644 (not 0600) so the etebase user inside the container — which has a
# different UID from the host operator — can still read this file via the
# bind mount. The file already lives in an operator-owned install directory.
chmod 644 etebase-server.ini
echo "Generated etebase-server.ini"

echo "Wrote .env (permissions: 600)"

# ── Pull images and start ─────────────────────────────────────────────

echo ""
echo "Pulling images and starting containers..."
$COMPOSE pull
$COMPOSE up -d

# ── Wait for health checks ───────────────────────────────────────────

echo ""
echo "Waiting for services to become healthy..."

MAX_WAIT=120
ELAPSED=0
HEALTHY=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  HEALTHY=0

  for container in silentsuite-postgres silentsuite-server; do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "unknown")
    if [ "$status" = "healthy" ]; then
      HEALTHY=$((HEALTHY + 1))
    fi
  done

  if [ "$HEALTHY" -ge 2 ]; then
    break
  fi

  sleep 5
  ELAPSED=$((ELAPSED + 5))
  echo "  $HEALTHY/2 services healthy ($ELAPSED/${MAX_WAIT}s)..."
done

if [ "$HEALTHY" -lt 2 ]; then
  echo ""
  echo "WARNING: Not all services are healthy after ${MAX_WAIT}s."
  echo "Run '$COMPOSE logs' to troubleshoot."
  echo ""
fi

echo ""
echo "============================================"
echo "  SilentSuite $VERSION is installed!"
echo "============================================"
echo ""
echo "  Server image: $SERVER_IMAGE"
echo ""
echo "  The first user to sign up becomes the server admin."
echo ""
echo "  Next steps:"
echo ""
echo "  1. Set up a reverse proxy to forward HTTPS traffic"
echo "     to this server on port 3735."
echo ""
echo "     Docker publishes the server on host loopback only:"
echo "       127.0.0.1:${SERVER_PORT:-3735}:3735"
echo "     You need a reverse proxy (Caddy, nginx, Traefik, or"
echo "     Cloudflare Tunnel) to handle TLS and forward traffic."
echo ""
if [ -n "$PROXY_NETWORK" ]; then
echo "     Your reverse proxy network ($PROXY_NETWORK) has been"
echo "     configured. Use 'silentsuite-server:3735' as the"
echo "     upstream/target in your proxy settings."
echo "     IMPORTANT: set TRUSTED_PROXY_IPS in .env to your"
echo "     proxy container's exact IP, then run:"
echo "       $COMPOSE up -d --force-recreate server"
else
echo "     If using Nginx Proxy Manager or another Docker-based proxy,"
echo "     connect the containers manually:"
echo "       docker network connect <proxy_network> silentsuite-server"
echo "     Then use 'silentsuite-server:3735' as the upstream, and set"
echo "     TRUSTED_PROXY_IPS in .env to that proxy's container IP."
fi
echo ""
echo "  2. Point your DNS A record for $DOMAIN"
echo "     to this server's public IP."
echo ""
echo "  3. Open https://app.silentsuite.io in a browser"
echo "  4. On the signup page, expand 'Advanced Settings'"
echo "  5. Enter this one-time first-admin server URL:"
echo "       https://$DOMAIN/?bootstrap_token=$BOOTSTRAP_ADMIN_TOKEN"
echo "  6. Create your account — you'll be the admin!"
echo "  7. Immediately run ./close-signups.sh to block further registration."
echo ""
echo "  Configuration files:"
echo "    .env                — environment variables (including the image digest)"
echo "    etebase-server.ini  — server config (domain, database)"
echo "    $MANIFEST_NAME  — the verified image identity for $VERSION"
echo ""
echo "  To change the domain or other settings, edit etebase-server.ini"
echo "  and restart: docker compose restart server"
echo ""
echo "  ./update.sh restarts this version. It does not change versions —"
echo "  see SELF-HOSTING.md before upgrading."
echo ""

# ── Loud security warning ─────────────────────────────────────────────
#
# Open registration is on by default so the operator's first account can be
# created via the app. After that registration the operator should immediately
# close signups, otherwise anyone who finds the server URL can create an
# account on the box. This banner is the last thing the installer prints so
# it's the freshest thing in the operator's mind.

if [ -t 1 ]; then
  C_RED=$'\033[1;31m'
  C_YELLOW=$'\033[1;33m'
  C_RESET=$'\033[0m'
else
  C_RED=''; C_YELLOW=''; C_RESET=''
fi

cat <<EOF

${C_RED}┌─────────────────────────────────────────────────────────────────────┐
│  SECURITY: open registration is currently ENABLED.                  │
└─────────────────────────────────────────────────────────────────────┘${C_RESET}

  First signup is protected by a one-time bootstrap token generated into
  your local .env file. Use this server URL for your first signup:

    ${C_YELLOW}https://$DOMAIN/?bootstrap_token=$BOOTSTRAP_ADMIN_TOKEN${C_RESET}

  After your admin account exists, close general registration:

    ${C_YELLOW}1. Sign up your own account now (step 6 above).${C_RESET}
    ${C_YELLOW}2. Run ${C_RESET}./close-signups.sh${C_YELLOW} from this directory.${C_RESET}

  ./close-signups.sh sets ETEBASE_DISABLE_SIGNUP=true in .env and recreates
  the server container — new registrations get blocked at the API layer.

EOF
