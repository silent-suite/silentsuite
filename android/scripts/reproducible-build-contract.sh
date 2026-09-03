#!/usr/bin/env bash
# SilentSuite Android reproducible-build contract.
#
# F-Droid publishes the developer-signed APK only when it can rebuild the exact
# same bytes from this source tree in its own build environment. Every input
# that differs between that environment and ours — absolute paths, the JDK
# vendor and patch level, the Rust toolchain, ambient compiler flags — has to be
# pinned or normalised here, in one place both build scripts and the release
# lane read, rather than in whichever workflow happens to run first.
#
# Two mechanisms, deliberately layered:
#
#   * a canonical build root. Native builds run at one fixed absolute path, so
#     anything that derives identity from a real filesystem path — BoringSSL's
#     __FILE__ strings, Cargo's OUT_DIR, the object-file paths ThinLTO hashes
#     into module identifiers — is already identical before any flag is applied.
#   * prefix maps. -ffile-prefix-map and --remap-path-prefix rewrite the paths
#     that survive anyway: the NDK, CARGO_HOME, and $HOME. These are what make
#     the fix a property of the source, not of where it happens to be built.
#
# Sourceable (`. reproducible-build-contract.sh`) and executable:
#
#   reproducible-build-contract.sh print          dump the pinned contract
#   reproducible-build-contract.sh provision-jdk  install and verify the JDK
#   reproducible-build-contract.sh github-env     append JAVA_HOME/PATH to $GITHUB_ENV

set -euo pipefail

# One fixed absolute path in every environment. /tmp is writable on the
# GitHub-hosted runners, inside the Debian rebuild container and on F-Droid's
# buildserver, and none of them place a per-user or per-run component in it.
# Overriding this is for local experiments only: the prefix maps below keep the
# compiled output identical, but a different root changes the ThinLTO module
# identifiers that no flag can normalise.
SILENTSUITE_CANONICAL_ROOT="/tmp/silentsuite-reproducible-build"
SILENTSUITE_REPRODUCIBLE_ROOT="${SILENTSUITE_REPRODUCIBLE_ROOT:-$SILENTSUITE_CANONICAL_ROOT}"
# The virtual root every real path is rewritten onto. It never exists on disk.
SILENTSUITE_VIRTUAL_ROOT="/silentsuite-build"

# Cargo's and rustup's homes are toolchain roots, not caches: the registry
# sources Cargo compiles, and the sysroot rustc links against, both live under
# them. The GitHub runner puts them in $HOME and the Debian rebuild container
# puts them in /opt, so a build that inherits them from the environment starts
# from two different absolute paths. They are placed under the canonical root
# instead, by this contract rather than by whichever workflow ran first, so the
# Rust build sees the same paths everywhere before any prefix map applies.
SILENTSUITE_CARGO_HOME="$SILENTSUITE_REPRODUCIBLE_ROOT/cargo"
SILENTSUITE_RUSTUP_HOME="$SILENTSUITE_REPRODUCIBLE_ROOT/rustup"

# The exact compiler the release APK is compiled with. javac — not the JVM that
# happens to run Gradle — decides the class-file attributes that reach
# classes.dex, so it is pinned to one immutable, checksummed build. Debian's
# openjdk-17 and Temurin 17 do not agree on all of them.
SILENTSUITE_RELEASE_JDK_RELEASE="jdk-17.0.20.1+1"
SILENTSUITE_RELEASE_JDK_JAVA_VERSION="17.0.20.1"
SILENTSUITE_RELEASE_JDK_IMPLEMENTOR_VERSION="Temurin-17.0.20.1+1"
SILENTSUITE_RELEASE_JDK_HOME="$SILENTSUITE_REPRODUCIBLE_ROOT/jdk/$SILENTSUITE_RELEASE_JDK_RELEASE"
SILENTSUITE_RELEASE_JDK_URL_X64="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz"
SILENTSUITE_RELEASE_JDK_SHA256_X64="3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e"
SILENTSUITE_RELEASE_JDK_URL_AARCH64="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz"
SILENTSUITE_RELEASE_JDK_SHA256_AARCH64="457b57af8f9c93ec39080bb8c764f559dc8c89a6da1a39d718a400b7890d3e41"

# `rustup default stable` is a moving target: the same source builds different
# bytes the day stable advances. The Etebase native libraries are pinned to one
# release instead, installed by the build script rather than by whoever set the
# runner up.
SILENTSUITE_RELEASE_RUST_TOOLCHAIN="1.98.0"

# Ambient toolchain flags silently change compiled output and are invisible in
# a build log. A release build refuses to start with any of them set.
SILENTSUITE_FORBIDDEN_AMBIENT_VARS=(
  RUSTFLAGS
  CARGO_ENCODED_RUSTFLAGS
  CFLAGS
  CXXFLAGS
  CPPFLAGS
  LDFLAGS
  JAVA_TOOL_OPTIONS
  _JAVA_OPTIONS
)

ss_die() {
  echo "error: $*" >&2
  exit 1
}

# Refuse to build with any ambient compiler flag in the environment. Fails
# closed: an unreviewed flag is a silent reproducibility break, not a warning.
ss_require_clean_toolchain_env() {
  local name
  for name in "${SILENTSUITE_FORBIDDEN_AMBIENT_VARS[@]}"; do
    if [[ -n "${!name:-}" ]]; then
      ss_die "$name is set in the environment; the reproducible build contract" \
        "requires an exact flag set. Unset $name and rebuild."
    fi
  done
}

# Create and echo one canonical workspace under the fixed build root.
ss_reproducible_workspace() {
  local name="${1:?workspace name required}"
  local path="$SILENTSUITE_REPRODUCIBLE_ROOT/$name"
  mkdir -p "$path" || ss_die "cannot create the canonical build root $path"
  [[ -w "$path" ]] || ss_die "canonical build root $path is not writable"
  printf '%s\n' "$path"
}

# Echo one `REAL=VIRTUAL` pair per real path that still differs between
# environments once the canonical root is applied, most specific first.
#
# The order is load-bearing and the two consumers need opposite ones. Clang
# applies the first matching -ffile-prefix-map and stops; rustc's
# --remap-path-prefix lets the last match win. Emitting most-specific-first
# is therefore correct for clang as it stands, and callers passing these to
# rustc reverse the list. Getting it wrong is silent: on F-Droid the NDK lives
# under $HOME, so a $HOME rule that matched first would rewrite NDK header
# paths onto a different virtual prefix than the same build produces on a
# runner whose SDK sits in /usr/local.
ss_prefix_map_pairs() {
  local ndk_dir="${1:-}"
  local cargo_home="${2:-}"
  local source_dir="${3:-}"
  local home="${HOME:-}"

  if [[ -n "$source_dir" ]]; then
    printf '%s=%s/source\n' "$source_dir" "$SILENTSUITE_VIRTUAL_ROOT"
  fi
  if [[ -n "$cargo_home" ]]; then
    printf '%s=%s/cargo\n' "$cargo_home" "$SILENTSUITE_VIRTUAL_ROOT"
  fi
  if [[ -n "$ndk_dir" ]]; then
    printf '%s=%s/ndk\n' "$ndk_dir" "$SILENTSUITE_VIRTUAL_ROOT"
  fi
  printf '%s=%s\n' "$SILENTSUITE_REPRODUCIBLE_ROOT" "$SILENTSUITE_VIRTUAL_ROOT"
  if [[ -n "$home" && "$home" != "/" ]]; then
    printf '%s=%s/home\n' "$home" "$SILENTSUITE_VIRTUAL_ROOT"
  fi
}

# The paths whose value differs from one build environment to the next, and
# which therefore must not survive into a shipped library. The canonical root
# is deliberately not one of them: it is the same absolute path on every
# machine, so a string under it — a build script's env!("OUT_DIR"), which no
# remap flag rewrites — is reproducible rather than a leak. It becomes
# environment-specific, and is reported, only when the root has been overridden.
ss_host_specific_paths() {
  local ndk_dir="${1:-}"
  local cargo_home="${2:-}"

  if [[ -n "${HOME:-}" && "$HOME" != "/" ]]; then
    printf '%s\n' "$HOME"
  fi
  if [[ -n "$ndk_dir" ]]; then
    printf '%s\n' "$ndk_dir"
  fi
  if [[ -n "$cargo_home" ]]; then
    printf '%s\n' "$cargo_home"
  fi
  if [[ "$SILENTSUITE_REPRODUCIBLE_ROOT" != "$SILENTSUITE_CANONICAL_ROOT" ]]; then
    printf '%s\n' "$SILENTSUITE_REPRODUCIBLE_ROOT"
  fi
}

ss_release_jdk_download() {
  case "$(uname -m)" in
    x86_64) printf '%s\n%s\n' "$SILENTSUITE_RELEASE_JDK_URL_X64" "$SILENTSUITE_RELEASE_JDK_SHA256_X64" ;;
    aarch64 | arm64) printf '%s\n%s\n' "$SILENTSUITE_RELEASE_JDK_URL_AARCH64" "$SILENTSUITE_RELEASE_JDK_SHA256_AARCH64" ;;
    *) ss_die "no pinned $SILENTSUITE_RELEASE_JDK_RELEASE build for $(uname -m)" ;;
  esac
}

# Prove the installed tree is the pinned build, not merely a JDK 17.
ss_verify_release_jdk() {
  local home="$SILENTSUITE_RELEASE_JDK_HOME"
  [[ -x "$home/bin/javac" ]] || ss_die "pinned JDK is missing $home/bin/javac"
  [[ -f "$home/release" ]] || ss_die "pinned JDK is missing $home/release"
  local implementor_version java_version
  implementor_version="$(sed -n 's/^IMPLEMENTOR_VERSION="\(.*\)"$/\1/p' "$home/release")"
  java_version="$(sed -n 's/^JAVA_VERSION="\(.*\)"$/\1/p' "$home/release")"
  [[ "$implementor_version" == "$SILENTSUITE_RELEASE_JDK_IMPLEMENTOR_VERSION" ]] \
    || ss_die "pinned JDK reports IMPLEMENTOR_VERSION '$implementor_version'," \
      "expected '$SILENTSUITE_RELEASE_JDK_IMPLEMENTOR_VERSION'"
  [[ "$java_version" == "$SILENTSUITE_RELEASE_JDK_JAVA_VERSION" ]] \
    || ss_die "pinned JDK reports JAVA_VERSION '$java_version'," \
      "expected '$SILENTSUITE_RELEASE_JDK_JAVA_VERSION'"
}

# Install the pinned JDK at its canonical path. Idempotent, checksum-verified,
# and never a fallback to whatever JDK the machine already has.
ss_provision_release_jdk() {
  if [[ -x "$SILENTSUITE_RELEASE_JDK_HOME/bin/javac" ]]; then
    ss_verify_release_jdk
    printf '%s\n' "$SILENTSUITE_RELEASE_JDK_HOME"
    return
  fi

  local url sha256 download
  { read -r url; read -r sha256; } < <(ss_release_jdk_download)

  local staging="$SILENTSUITE_REPRODUCIBLE_ROOT/jdk"
  mkdir -p "$staging" || ss_die "cannot create $staging"
  download="$staging/$SILENTSUITE_RELEASE_JDK_RELEASE.tar.gz"
  echo "Fetching $SILENTSUITE_RELEASE_JDK_RELEASE" >&2
  curl --fail --location --silent --show-error "$url" --output "$download"
  echo "$sha256  $download" | sha256sum --check --strict >&2

  local extracted="$staging/.extract"
  rm -rf "$extracted"
  mkdir -p "$extracted"
  tar -xzf "$download" -C "$extracted"
  [[ -d "$extracted/$SILENTSUITE_RELEASE_JDK_RELEASE" ]] \
    || ss_die "pinned JDK archive did not contain $SILENTSUITE_RELEASE_JDK_RELEASE"
  rm -rf "$SILENTSUITE_RELEASE_JDK_HOME"
  mv "$extracted/$SILENTSUITE_RELEASE_JDK_RELEASE" "$SILENTSUITE_RELEASE_JDK_HOME"
  rm -rf "$extracted" "$download"

  ss_verify_release_jdk
  printf '%s\n' "$SILENTSUITE_RELEASE_JDK_HOME"
}

# Put CARGO_HOME and RUSTUP_HOME at their canonical paths, overriding whatever
# the environment set. Exported rather than returned: every cargo and rustup
# invocation that follows has to see them, including the ones cargo spawns.
ss_canonical_rust_env() {
  mkdir -p "$SILENTSUITE_CARGO_HOME" "$SILENTSUITE_RUSTUP_HOME" \
    || ss_die "cannot create the canonical Rust toolchain roots"
  export CARGO_HOME="$SILENTSUITE_CARGO_HOME"
  export RUSTUP_HOME="$SILENTSUITE_RUSTUP_HOME"
}

# Install the pinned Rust toolchain and its Android targets. Never `stable`,
# and always into the canonical toolchain roots.
ss_provision_rust_toolchain() {
  command -v rustup >/dev/null 2>&1 || ss_die "rustup is required to install $SILENTSUITE_RELEASE_RUST_TOOLCHAIN"
  ss_canonical_rust_env
  rustup toolchain install --profile minimal --no-self-update "$SILENTSUITE_RELEASE_RUST_TOOLCHAIN"
  if [[ "$#" -gt 0 ]]; then
    rustup target add --toolchain "$SILENTSUITE_RELEASE_RUST_TOOLCHAIN" "$@"
  fi
  local actual
  actual="$(rustc "+$SILENTSUITE_RELEASE_RUST_TOOLCHAIN" --version)"
  case "$actual" in
    "rustc $SILENTSUITE_RELEASE_RUST_TOOLCHAIN "*) ;;
    *) ss_die "pinned toolchain reports '$actual', expected rustc $SILENTSUITE_RELEASE_RUST_TOOLCHAIN" ;;
  esac
}

ss_contract_main() {
  case "${1:-print}" in
    print)
      cat <<EOF
SILENTSUITE_REPRODUCIBLE_ROOT=$SILENTSUITE_REPRODUCIBLE_ROOT
SILENTSUITE_VIRTUAL_ROOT=$SILENTSUITE_VIRTUAL_ROOT
SILENTSUITE_RELEASE_JDK_RELEASE=$SILENTSUITE_RELEASE_JDK_RELEASE
SILENTSUITE_RELEASE_JDK_HOME=$SILENTSUITE_RELEASE_JDK_HOME
SILENTSUITE_RELEASE_RUST_TOOLCHAIN=$SILENTSUITE_RELEASE_RUST_TOOLCHAIN
SILENTSUITE_CARGO_HOME=$SILENTSUITE_CARGO_HOME
SILENTSUITE_RUSTUP_HOME=$SILENTSUITE_RUSTUP_HOME
EOF
      ;;
    provision-jdk)
      ss_provision_release_jdk
      ;;
    github-env)
      ss_provision_release_jdk >/dev/null
      [[ -n "${GITHUB_ENV:-}" ]] || ss_die "GITHUB_ENV is not set"
      [[ -n "${GITHUB_PATH:-}" ]] || ss_die "GITHUB_PATH is not set"
      printf 'SILENTSUITE_RELEASE_JDK_HOME=%s\n' "$SILENTSUITE_RELEASE_JDK_HOME" >> "$GITHUB_ENV"
      printf 'JAVA_HOME=%s\n' "$SILENTSUITE_RELEASE_JDK_HOME" >> "$GITHUB_ENV"
      printf '%s/bin\n' "$SILENTSUITE_RELEASE_JDK_HOME" >> "$GITHUB_PATH"
      ;;
    *)
      ss_die "unknown command: $1"
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  ss_contract_main "$@"
fi
