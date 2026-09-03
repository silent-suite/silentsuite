#!/usr/bin/env bash
set -euo pipefail

# Rebuild Etebase Android 2.3.2 native libraries with 16 KB ELF LOAD
# segment alignment, then repack the upstream Maven AAR as a local drop-in
# artifact for SilentSuite Android builds.
#
# The libraries also have to come out byte-identical when F-Droid rebuilds them
# on its own machine. Three things previously prevented that and are pinned or
# normalised here:
#
#   * a moving `stable` toolchain. The Rust release is pinned by the contract,
#     installed by this script rather than inherited from the runner.
#   * CARGO_HOME, OUT_DIR and $HOME paths compiled into the library through
#     file!() and the cc crate. --remap-path-prefix and -ffile-prefix-map
#     rewrite them onto the contract's virtual root.
#   * ThinLTO module identifiers, which LLVM derives from the real object-file
#     paths and no flag rewrites. Cargo therefore runs at the contract's fixed
#     canonical root, so those paths are identical everywhere to begin with.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
# shellcheck source=android/scripts/reproducible-build-contract.sh
source "$SCRIPT_DIR/reproducible-build-contract.sh"
ss_require_clean_toolchain_env

APP_LIBS_DIR="$ROOT_DIR/app/libs"
OUT_AAR="${OUT_AAR:-$APP_LIBS_DIR/client-2.3.2-16kb.aar}"
ETEBASE_REPO_URL="${ETEBASE_REPO_URL:-https://github.com/etesync/etebase-java.git}"
ETEBASE_REF="${ETEBASE_REF:-v2.3.2}"
ETEBASE_EXPECTED_COMMIT="${ETEBASE_EXPECTED_COMMIT:-365f7af82b5e2cb39ec59c9711fd11096ee127a7}"
BUILD_DIR="$(ss_reproducible_workspace etebase)"
ORIGINAL_AAR_URL="${ORIGINAL_AAR_URL:-https://repo1.maven.org/maven2/com/etebase/client/2.3.2/client-2.3.2.aar}"
ORIGINAL_AAR_SHA256="${ORIGINAL_AAR_SHA256:-1d1ff77036911852b74f18f2854f86a731766f58138f87e1ac151f641291ede3}"
ORIGINAL_AAR="$BUILD_DIR/client-2.3.2.aar"
NATIVE_OUT="$BUILD_DIR/native"
ETEBASE_SOURCE="$BUILD_DIR/etebase-java"

# Google Play's 16 KB page-size requirement applies to 64-bit Android
# devices. Rebuild and replace only the 64-bit Etebase libraries; leave the
# upstream 32-bit libraries untouched in the repacked AAR.
ABIS=(arm64-v8a x86_64)
TARGETS=(aarch64-linux-android x86_64-linux-android)
CLANGS=(aarch64-linux-android21-clang x86_64-linux-android21-clang)

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command '$1' was not found" >&2
    exit 1
  fi
}

find_ndk() {
  if [[ -n "${ANDROID_NDK_HOME:-}" && -d "${ANDROID_NDK_HOME}" ]]; then
    printf '%s\n' "$ANDROID_NDK_HOME"
    return
  fi
  if [[ -n "${ANDROID_NDK_ROOT:-}" && -d "${ANDROID_NDK_ROOT}" ]]; then
    printf '%s\n' "$ANDROID_NDK_ROOT"
    return
  fi
  if [[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME}/ndk" ]]; then
    find "${ANDROID_HOME}/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
    return
  fi
  if [[ -n "${ANDROID_SDK_ROOT:-}" && -d "${ANDROID_SDK_ROOT}/ndk" ]]; then
    find "${ANDROID_SDK_ROOT}/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1
    return
  fi
  echo "error: could not locate Android NDK; set ANDROID_NDK_HOME or ANDROID_HOME" >&2
  exit 1
}

upper_target_env() {
  printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'
}

need_cmd git
need_cmd python3
need_cmd readelf
need_cmd cargo
need_cmd rustup

NDK_DIR="$(find_ndk)"
HOST_TAG="linux-x86_64"
TOOLCHAIN_BIN="$NDK_DIR/toolchains/llvm/prebuilt/$HOST_TAG/bin"
if [[ ! -d "$TOOLCHAIN_BIN" ]]; then
  echo "error: NDK LLVM toolchain not found at $TOOLCHAIN_BIN" >&2
  exit 1
fi

export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"

mkdir -p "$BUILD_DIR" "$NATIVE_OUT" "$APP_LIBS_DIR"
rm -rf "$ETEBASE_SOURCE" "$NATIVE_OUT"
mkdir -p "$NATIVE_OUT"

printf 'Using NDK: %s\n' "$NDK_DIR"
if [[ -f "$NDK_DIR/source.properties" ]]; then
  sed -n 's/^Pkg.Revision *= */NDK revision: /p' "$NDK_DIR/source.properties"
fi

git clone --quiet --branch "$ETEBASE_REF" --depth 1 "$ETEBASE_REPO_URL" "$ETEBASE_SOURCE"
cd "$ETEBASE_SOURCE"
actual_commit="$(git rev-parse HEAD)"
if [[ "$actual_commit" != "$ETEBASE_EXPECTED_COMMIT" ]]; then
  echo "error: $ETEBASE_REF resolved to $actual_commit, expected $ETEBASE_EXPECTED_COMMIT" >&2
  exit 1
fi

ss_provision_rust_toolchain "${TARGETS[@]}"

PREFIX_MAPS=()
while IFS= read -r pair; do
  [[ -n "$pair" ]] && PREFIX_MAPS+=("$pair")
done < <(ss_prefix_map_pairs "$NDK_DIR" "$CARGO_HOME" "$ETEBASE_SOURCE")

# NDK r28+ emits 16 KB-aligned Android shared libraries by default, but
# these flags keep the build correct if CI ever runs an older NDK. Android's
# 16 KB page-size guidance requires both flags for old NDK/linker versions.
#
# CARGO_ENCODED_RUSTFLAGS rather than RUSTFLAGS: the remapped paths are
# separator-sensitive, and the ASCII-unit-separator form cannot be re-split by
# a path that happens to contain a space.
RUST_FLAGS=(
  -C link-arg=-Wl,-z,max-page-size=16384
  -C link-arg=-Wl,-z,common-page-size=16384
)
CC_PREFIX_FLAGS=()
for pair in "${PREFIX_MAPS[@]}"; do
  CC_PREFIX_FLAGS+=("-ffile-prefix-map=$pair")
done
# rustc keeps the last matching remap rather than the first, so the contract's
# most-specific-first order is reversed for it and preserved for clang.
for (( index = ${#PREFIX_MAPS[@]} - 1; index >= 0; index-- )); do
  RUST_FLAGS+=("--remap-path-prefix=${PREFIX_MAPS[$index]}")
done
encoded=""
for flag in "${RUST_FLAGS[@]}"; do
  if [[ -z "$encoded" ]]; then
    encoded="$flag"
  else
    encoded="$encoded"$'\x1f'"$flag"
  fi
done
export CARGO_ENCODED_RUSTFLAGS="$encoded"

for i in "${!ABIS[@]}"; do
  abi="${ABIS[$i]}"
  target="${TARGETS[$i]}"
  clang="${CLANGS[$i]}"
  linker="$TOOLCHAIN_BIN/$clang"
  if [[ ! -x "$linker" ]]; then
    echo "error: missing NDK linker $linker" >&2
    exit 1
  fi

  export CC="$linker"
  env_name="CARGO_TARGET_$(upper_target_env "$target")_LINKER"
  export "$env_name=$linker"
  # The cc crate compiles the vendored C dependencies of the Etebase crate and
  # appends these to its own flags. It looks the variable up under the target
  # triple in both spellings; the hyphenated one is not a shell identifier, so
  # the whole set is passed through `env` rather than exported.
  target_underscored="$(printf '%s' "$target" | tr '-' '_')"

  echo "Building Etebase native library for $abi ($target)"
  env \
    "CFLAGS_$target=${CC_PREFIX_FLAGS[*]}" \
    "CFLAGS_$target_underscored=${CC_PREFIX_FLAGS[*]}" \
    "TARGET_CFLAGS=${CC_PREFIX_FLAGS[*]}" \
    cargo "+$SILENTSUITE_RELEASE_RUST_TOOLCHAIN" build --target "$target" --release --locked

  built="target/$target/release/libetebase_android.so"
  if [[ ! -f "$built" ]]; then
    echo "error: expected native library was not produced: $built" >&2
    exit 1
  fi
  mkdir -p "$NATIVE_OUT/jni/$abi"
  cp "$built" "$NATIVE_OUT/jni/$abi/libetebase_android.so"
done

python3 - "$NATIVE_OUT" <<'PY'
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
failed = False
for so in sorted(root.glob('jni/*/*.so')):
    abi = so.parts[-2]
    output = subprocess.check_output(['readelf', '-lW', str(so)], text=True)
    alignments = []
    lines = output.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith('LOAD'):
            continue
        fields = stripped.split()
        if fields[-1].startswith('0x'):
            alignments.append(int(fields[-1], 16))
        elif index + 1 < len(lines):
            alignments.append(int(lines[index + 1].split()[-1], 16))
    print(f'{so}: LOAD alignments {[hex(value) for value in alignments]}')
    if abi in {'arm64-v8a', 'x86_64'} and any(value < 0x4000 for value in alignments):
        failed = True
if failed:
    raise SystemExit('error: rebuilt Etebase 64-bit library is not 16 KB aligned')
PY

# A library that still names CARGO_HOME, the NDK or this account's home
# directory cannot be rebuilt byte-for-byte anywhere else, so the build fails
# here rather than after the release is signed.
host_specific_paths=()
while IFS= read -r host_path; do
  [[ -n "$host_path" ]] && host_specific_paths+=("$host_path")
done < <(ss_host_specific_paths "$NDK_DIR" "$CARGO_HOME")

python3 - "$NATIVE_OUT" "$SILENTSUITE_VIRTUAL_ROOT" "${host_specific_paths[@]}" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
virtual_root = sys.argv[2].encode()
host_paths = [value for value in sys.argv[3:] if value and value != '/']

leaked = []
normalised = 0
for so in sorted(root.glob('jni/*/*.so')):
    payload = so.read_bytes()
    normalised += payload.count(virtual_root)
    for host_path in host_paths:
        occurrences = payload.count(host_path.encode())
        if occurrences:
            leaked.append(f'{so.name} ({so.parts[-2]}): {occurrences} reference(s) to {host_path}')

if leaked:
    raise SystemExit(
        'error: rebuilt Etebase libraries embed host-specific build paths:\n  '
        + '\n  '.join(leaked)
    )
if not normalised:
    raise SystemExit(
        'error: no normalised source path was found in the rebuilt Etebase libraries; '
        '--remap-path-prefix did not reach the Rust compile'
    )
print(f'Normalised source paths in rebuilt Etebase libraries: {normalised}')
PY

python3 - "$ORIGINAL_AAR_URL" "$ORIGINAL_AAR" "$ORIGINAL_AAR_SHA256" <<'PY'
import hashlib
import pathlib
import sys
import urllib.request

url = sys.argv[1]
out = pathlib.Path(sys.argv[2])
expected = sys.argv[3]
out.parent.mkdir(parents=True, exist_ok=True)
if not out.exists():
    print(f'Downloading {url}')
    urllib.request.urlretrieve(url, out)
actual = hashlib.sha256(out.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f'error: {out} sha256 {actual} did not match expected {expected}')
print(out)
PY

python3 - "$ORIGINAL_AAR" "$NATIVE_OUT" "$OUT_AAR" <<'PY'
import pathlib
import sys
import zipfile

original = pathlib.Path(sys.argv[1])
native_root = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])
replacements = {
    f'jni/{path.parts[-2]}/{path.name}': path
    for path in native_root.glob('jni/*/libetebase_android.so')
}

tmp = out.with_suffix(out.suffix + '.tmp')
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(original, 'r') as zin, zipfile.ZipFile(tmp, 'w') as zout:
    seen = set()
    for info in zin.infolist():
        data = zin.read(info.filename)
        if info.filename in replacements:
            data = replacements[info.filename].read_bytes()
            seen.add(info.filename)
        zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
        zi.compress_type = info.compress_type
        zi.external_attr = info.external_attr
        zi.comment = info.comment
        zi.extra = info.extra
        zout.writestr(zi, data)
    missing = sorted(set(replacements) - seen)
    if missing:
        raise SystemExit(f'error: original AAR did not contain expected entries: {missing}')
tmp.replace(out)
print(f'Wrote {out}')
PY

python3 "$ROOT_DIR/scripts/verify-native-16kb.py" \
  --require-lib libetebase_android.so \
  "$OUT_AAR"
