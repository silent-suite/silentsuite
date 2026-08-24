#!/usr/bin/env bash
set -euo pipefail

# Rebuild the current Conscrypt release with Android NDK r28. The upstream
# 2.6.3 AAR records NDK r27d even though it carries the manual 16 KB linker
# flags, which leaves Google Play's old-NDK compatibility warning unresolved.
CONSCRYPT_REPOSITORY="https://github.com/google/conscrypt.git"
CONSCRYPT_COMMIT="657e1c64c46961bcc48e7302e42ebc02d6632645"
CONSCRYPT_VERSION="2.6.3"
BORINGSSL_REPOSITORY="https://github.com/google/boringssl.git"
# Exact revision embedded in the published Conscrypt 2.6.3 AAR.
BORINGSSL_COMMIT="3adc3d1aba162a578e2547f329fcce8659b8e89c"
ANDROID_NDK_VERSION="28.2.13676358"
OUTPUT_AAR="cert4android/libs/conscrypt-android-2.6.3-r28.aar"

if [[ -z "${ANDROID_HOME:-}" ]]; then
  echo "error: ANDROID_HOME must point to the Android SDK" >&2
  exit 1
fi

expected_ndk="$ANDROID_HOME/ndk/$ANDROID_NDK_VERSION"
if [[ ! -d "$expected_ndk" ]]; then
  echo "error: Android NDK $ANDROID_NDK_VERSION is not installed at $expected_ndk" >&2
  exit 1
fi
export ANDROID_NDK_HOME="$expected_ndk"

workspace="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/silentsuite-conscrypt-r28"
conscrypt_source="$workspace/conscrypt"
boringssl_source="$workspace/boringssl"
rm -rf "$workspace"
mkdir -p "$workspace"

clone_exact_commit() {
  local repository="$1"
  local commit="$2"
  local destination="$3"
  git init --quiet "$destination"
  git -C "$destination" remote add origin "$repository"
  git -C "$destination" fetch --quiet --depth 1 origin "$commit"
  git -C "$destination" checkout --quiet --detach FETCH_HEAD
  local actual
  actual="$(git -C "$destination" rev-parse HEAD)"
  if [[ "$actual" != "$commit" ]]; then
    echo "error: expected $repository commit $commit, got $actual" >&2
    exit 1
  fi
}

clone_exact_commit "$CONSCRYPT_REPOSITORY" "$CONSCRYPT_COMMIT" "$conscrypt_source"
clone_exact_commit "$BORINGSSL_REPOSITORY" "$BORINGSSL_COMMIT" "$boringssl_source"

python3 - "$conscrypt_source" "$CONSCRYPT_VERSION" "$ANDROID_NDK_VERSION" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
version = sys.argv[2]
ndk = sys.argv[3]

root_gradle = root / "build.gradle"
root_text = root_gradle.read_text(encoding="utf-8")
old_version = 'version = "2.6-SNAPSHOT"'
new_version = f'version = "{version}"'
if root_text.count(old_version) != 1:
    raise SystemExit(f"error: expected exactly one upstream version declaration {old_version!r}")
root_gradle.write_text(root_text.replace(old_version, new_version), encoding="utf-8")

android_gradle = root / "android/build.gradle"
android_text = android_gradle.read_text(encoding="utf-8")
old_ndk = "androidNdkVersion = '27.3.13750724'"
new_ndk = f"androidNdkVersion = '{ndk}'"
if android_text.count(old_ndk) != 1:
    raise SystemExit(f"error: expected exactly one upstream NDK declaration {old_ndk!r}")
required_flags = "-z max-page-size=16384 -z common-page-size=16384"
if android_text.count(required_flags) != 1:
    raise SystemExit("error: upstream Conscrypt 16 KB linker flags are missing or ambiguous")
android_gradle.write_text(android_text.replace(old_ndk, new_ndk), encoding="utf-8")
PY

(
  cd "$conscrypt_source"
  BORINGSSL_HOME="$boringssl_source" \
    ./gradlew :conscrypt-android:assembleRelease --no-daemon --console=plain
)

built_aar="$conscrypt_source/android/build/outputs/aar/conscrypt-android-release.aar"
if [[ ! -s "$built_aar" ]]; then
  echo "error: Conscrypt build did not produce $built_aar" >&2
  exit 1
fi
mkdir -p "$(dirname "$OUTPUT_AAR")"
cp "$built_aar" "$OUTPUT_AAR"
sha256sum "$OUTPUT_AAR"
