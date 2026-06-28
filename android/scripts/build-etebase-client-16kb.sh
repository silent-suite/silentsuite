#!/usr/bin/env bash
set -euo pipefail

# Rebuild Etebase Android 2.3.2 native libraries with 16 KB ELF LOAD
# segment alignment, then repack the upstream Maven AAR as a local drop-in
# artifact for SilentSuite Android builds.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_LIBS_DIR="$ROOT_DIR/app/libs"
OUT_AAR="${OUT_AAR:-$APP_LIBS_DIR/client-2.3.2-16kb.aar}"
ETEBASE_REPO_URL="${ETEBASE_REPO_URL:-https://github.com/etesync/etebase-java.git}"
ETEBASE_REF="${ETEBASE_REF:-v2.3.2}"
ETEBASE_EXPECTED_COMMIT="${ETEBASE_EXPECTED_COMMIT:-365f7af82b5e2cb39ec59c9711fd11096ee127a7}"
BUILD_DIR="${ETEBASE_BUILD_DIR:-${RUNNER_TEMP:-$ROOT_DIR/build}/etebase-client-16kb}"
ORIGINAL_AAR_URL="${ORIGINAL_AAR_URL:-https://repo1.maven.org/maven2/com/etebase/client/2.3.2/client-2.3.2.aar}"
ORIGINAL_AAR_SHA256="${ORIGINAL_AAR_SHA256:-1d1ff77036911852b74f18f2854f86a731766f58138f87e1ac151f641291ede3}"
ORIGINAL_AAR="$BUILD_DIR/client-2.3.2.aar"
NATIVE_OUT="$BUILD_DIR/native"

ABIS=(armeabi-v7a arm64-v8a x86 x86_64)
TARGETS=(armv7-linux-androideabi aarch64-linux-android i686-linux-android x86_64-linux-android)
CLANGS=(armv7a-linux-androideabi21-clang aarch64-linux-android21-clang i686-linux-android21-clang x86_64-linux-android21-clang)

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

mkdir -p "$BUILD_DIR" "$NATIVE_OUT" "$APP_LIBS_DIR"
rm -rf "$BUILD_DIR/etebase-java" "$NATIVE_OUT"
mkdir -p "$NATIVE_OUT"

printf 'Using NDK: %s\n' "$NDK_DIR"
if [[ -f "$NDK_DIR/source.properties" ]]; then
  sed -n 's/^Pkg.Revision *= */NDK revision: /p' "$NDK_DIR/source.properties"
fi

git clone --quiet --branch "$ETEBASE_REF" --depth 1 "$ETEBASE_REPO_URL" "$BUILD_DIR/etebase-java"
cd "$BUILD_DIR/etebase-java"
actual_commit="$(git rev-parse HEAD)"
if [[ "$actual_commit" != "$ETEBASE_EXPECTED_COMMIT" ]]; then
  echo "error: $ETEBASE_REF resolved to $actual_commit, expected $ETEBASE_EXPECTED_COMMIT" >&2
  exit 1
fi

rustup target add "${TARGETS[@]}"

# NDK r28+ emits 16 KB-aligned Android shared libraries by default, but
# these flags keep the build correct if CI ever runs an older NDK. Android's
# 16 KB page-size guidance requires both flags for old NDK/linker versions.
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384 -C link-arg=-Wl,-z,common-page-size=16384"

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

  echo "Building Etebase native library for $abi ($target)"
  cargo build --target "$target" --release --locked

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
