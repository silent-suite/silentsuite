#!/usr/bin/env bash
set -euo pipefail

# Rebuild the current Conscrypt release with Android NDK r28. The upstream
# 2.6.3 AAR records NDK r27d even though it carries the manual 16 KB linker
# flags, which leaves Google Play's old-NDK compatibility warning unresolved.
#
# The build also has to be byte-reproducible in an environment that is not this
# one: BoringSSL embeds 201 __FILE__ strings in libconscrypt_jni.so, and an
# unnormalised build records wherever it happened to be checked out. Sources are
# therefore compiled at the contract's canonical root and every remaining
# host-specific prefix is rewritten with -ffile-prefix-map, which covers both
# the debug line table and the __FILE__ macro. The AAR is rejected below if a
# real host path survives into a shipped library.
#
# The debug information itself is then dropped, at both ends of the link. AGP's
# release variant selects CMake's RelWithDebInfo and then runs
# :conscrypt-android:stripReleaseDebugSymbols over the result, so the image the
# linker hashes into NT_GNU_BUILD_ID is not the image the AAR ships: it still
# carries the DWARF and the symbol table that strip removes afterwards. Two
# rebuilds whose shipped bytes were byte-identical therefore still disagreed on
# exactly those 20 bytes, and on nothing else, because their unshipped sections
# differed. Suppressing the debug information at compile time (-g0) is not
# enough on its own, because .symtab and .strtab survive it and are stripped
# too. The link itself is therefore told to emit the stripped image directly
# (-Wl,--strip-all), which makes Gradle's later strip a no-op and makes the
# build ID a hash of the shipped bytes and of nothing else. Conscrypt ships
# pre-stripped and is excluded from the Play native debug-symbol upload
# (android/scripts/package-native-debug-symbols.py), so nothing consumes the
# information being dropped.
CONSCRYPT_REPOSITORY="https://github.com/google/conscrypt.git"
CONSCRYPT_COMMIT="657e1c64c46961bcc48e7302e42ebc02d6632645"
CONSCRYPT_VERSION="2.6.3"
BORINGSSL_REPOSITORY="https://github.com/google/boringssl.git"
# Exact revision embedded in the published Conscrypt 2.6.3 AAR.
BORINGSSL_COMMIT="3adc3d1aba162a578e2547f329fcce8659b8e89c"
ANDROID_NDK_VERSION="28.2.13676358"
OUTPUT_AAR="build/conscrypt-m2/org/conscrypt/conscrypt-android/2.6.3-r28/conscrypt-android-2.6.3-r28.aar"
OUTPUT_POM="build/conscrypt-m2/org/conscrypt/conscrypt-android/2.6.3-r28/conscrypt-android-2.6.3-r28.pom"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=android/scripts/reproducible-build-contract.sh
source "$SCRIPT_DIR/reproducible-build-contract.sh"
ss_require_clean_toolchain_env

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

# Conscrypt's Java classes land in the AAR the app compiles against, so this
# build uses the same pinned javac as the release APK rather than whichever
# JDK the host distribution installed.
JAVA_HOME="$(ss_provision_release_jdk)"
export JAVA_HOME
export PATH="$JAVA_HOME/bin:$PATH"

workspace="$(ss_reproducible_workspace conscrypt)"
conscrypt_source="$workspace/conscrypt"
boringssl_source="$workspace/boringssl"
rm -rf "$workspace"
mkdir -p "$workspace"

prefix_maps=()
while IFS= read -r pair; do
  [[ -n "$pair" ]] && prefix_maps+=("$pair")
done < <(ss_prefix_map_pairs "$ANDROID_NDK_HOME" "" "")

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

python3 - "$conscrypt_source" "$CONSCRYPT_VERSION" "$ANDROID_NDK_VERSION" "${prefix_maps[@]}" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
version = sys.argv[2]
ndk = sys.argv[3]
prefix_maps = sys.argv[4:]

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
android_text = android_text.replace(old_ndk, new_ndk)

# CMake appends CMAKE_<LANG>_FLAGS_<CONFIG> after the flags AGP passes, so the
# `-g` in the RelWithDebInfo defaults wins over any `-g0` added to cFlags. The
# configuration's own flags are overridden instead: RelWithDebInfo minus its
# debug information, with the optimisation level and NDEBUG left untouched.
debug_free_flags = "-O2 -DNDEBUG -g0"
linker_anchor = (
    "'-DCMAKE_SHARED_LINKER_FLAGS=-z max-page-size=16384 -z common-page-size=16384'"
)
if android_text.count(linker_anchor) != 1:
    raise SystemExit(
        f"error: expected exactly one upstream CMake argument list anchored at {linker_anchor!r}"
    )
# lld emits the build-ID note last, over the image it has just written. Asking
# it to write the stripped image means the note covers the shipped bytes.
patched_linker_anchor = linker_anchor[:-1] + " -Wl,--strip-all'"
android_text = android_text.replace(
    linker_anchor,
    patched_linker_anchor
    + ",\n"
    + " " * 24
    + f"'-DCMAKE_C_FLAGS_RELWITHDEBINFO={debug_free_flags}',\n"
    + " " * 24
    + f"'-DCMAKE_CXX_FLAGS_RELWITHDEBINFO={debug_free_flags}'",
)

# Normalise every C and C++ source path that reaches the shipped library.
# -ffile-prefix-map covers __FILE__ and the debug line table in one flag, so
# BoringSSL's assertion strings stop recording the build machine.
if not prefix_maps:
    raise SystemExit("error: the reproducible-build contract produced no prefix maps")
for pair in prefix_maps:
    if any(character in pair for character in ("'", "$", "\\", "\n")):
        raise SystemExit(f"error: prefix map {pair!r} is not safe to embed in a Gradle literal")
flags = [f"-ffile-prefix-map={pair}" for pair in prefix_maps]
anchor = "cFlags '-fvisibility=hidden',"
if android_text.count(anchor) != 1:
    raise SystemExit(f"error: expected exactly one upstream flag declaration {anchor!r}")
indent = " " * 16
c_flags = "".join(f"'{flag}', " for flag in flags)
cpp_flags = ", ".join(f"'{flag}'" for flag in flags)
replacement = f"cppFlags {cpp_flags}\n{indent}cFlags {c_flags}'-fvisibility=hidden',"
android_text = android_text.replace(anchor, replacement)
android_gradle.write_text(android_text, encoding="utf-8")
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
python3 - "$built_aar" "$CONSCRYPT_VERSION" "$BORINGSSL_COMMIT" <<'PY'
from io import BytesIO
from pathlib import Path
import sys
import zipfile

aar = Path(sys.argv[1])
version = sys.argv[2]
boringssl_commit = sys.argv[3]

# Section names that a stripped shared library must not have. Their contents
# reach the linker's build-ID hash but never the AAR, so a library that still
# has them is one whose build ID depends on bytes no rebuild can reproduce.
def unstripped_sections(payload: bytes) -> list[str]:
    if payload[:4] != b"\x7fELF":
        raise SystemExit("error: rebuilt Conscrypt library is not an ELF object")
    is_64 = payload[4] == 2
    little = payload[5] == 1
    order = "little" if little else "big"

    def number(offset: int, size: int) -> int:
        return int.from_bytes(payload[offset : offset + size], order)

    if is_64:
        sh_offset, sh_entry_size, sh_count, sh_strndx = (
            number(0x28, 8),
            number(0x3A, 2),
            number(0x3C, 2),
            number(0x3E, 2),
        )
        name_field, offset_field, size_field, offset_width = 0, 0x18, 0x20, 8
    else:
        sh_offset, sh_entry_size, sh_count, sh_strndx = (
            number(0x20, 4),
            number(0x2E, 2),
            number(0x30, 2),
            number(0x32, 2),
        )
        name_field, offset_field, size_field, offset_width = 0, 0x10, 0x14, 4

    def header(index: int) -> int:
        return sh_offset + index * sh_entry_size

    strtab = header(sh_strndx)
    strtab_offset = number(strtab + offset_field, offset_width)
    strtab_size = number(strtab + size_field, offset_width)
    names = payload[strtab_offset : strtab_offset + strtab_size]

    found: list[str] = []
    for index in range(sh_count):
        start = number(header(index) + name_field, 4)
        section = names[start : names.index(b"\x00", start)].decode("utf-8", "replace")
        if section == ".symtab" or section == ".strtab" or section.startswith(".debug"):
            found.append(section)
    return sorted(set(found))


with zipfile.ZipFile(aar) as archive:
    expected_native = {
        f"jni/{abi}/libconscrypt_jni.so"
        for abi in ("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
    }
    missing_native = sorted(expected_native - set(archive.namelist()))
    if missing_native:
        raise SystemExit(f"error: rebuilt Conscrypt AAR is missing: {', '.join(missing_native)}")
    for name in sorted(expected_native):
        unshipped = unstripped_sections(archive.read(name))
        if unshipped:
            raise SystemExit(
                f"error: {name} still carries link-time-only sections "
                f"({', '.join(unshipped)}); the GNU build ID would hash bytes the AAR "
                "does not ship and the rebuild would diverge on that note alone"
            )
    with zipfile.ZipFile(BytesIO(archive.read("classes.jar"))) as classes:
        raw_properties = classes.read("org/conscrypt/conscrypt.properties").decode("utf-8")

properties = dict(
    line.split("=", 1)
    for line in raw_properties.splitlines()
    if line and not line.startswith("#") and "=" in line
)
major, minor, patch = version.split(".")
expected_properties = {
    "org.conscrypt.boringssl.version": boringssl_commit,
    "org.conscrypt.version.major": major,
    "org.conscrypt.version.minor": minor,
    "org.conscrypt.version.patch": patch,
}
actual_properties = {key: properties.get(key) for key in expected_properties}
if actual_properties != expected_properties:
    raise SystemExit(
        f"error: rebuilt Conscrypt properties mismatch: expected {expected_properties}, "
        f"got {actual_properties}"
    )
PY

# The reproducibility gate proper: a shipped library that still names this
# machine cannot be rebuilt anywhere else, so the build fails here rather than
# after the release is signed.
host_specific_paths=()
while IFS= read -r host_path; do
  [[ -n "$host_path" ]] && host_specific_paths+=("$host_path")
done < <(ss_host_specific_paths "$ANDROID_NDK_HOME" "")

python3 - "$built_aar" "$SILENTSUITE_VIRTUAL_ROOT" "${host_specific_paths[@]}" <<'PY'
from pathlib import Path
import sys
import zipfile

aar = Path(sys.argv[1])
virtual_root = sys.argv[2].encode()
host_paths = [value for value in sys.argv[3:] if value and value != "/"]

leaked: list[str] = []
normalised = 0
with zipfile.ZipFile(aar) as archive:
    for name in sorted(archive.namelist()):
        if not name.startswith("jni/") or not name.endswith(".so"):
            continue
        payload = archive.read(name)
        normalised += payload.count(virtual_root)
        for host_path in host_paths:
            occurrences = payload.count(host_path.encode())
            if occurrences:
                leaked.append(f"{name}: {occurrences} reference(s) to {host_path}")

if leaked:
    raise SystemExit(
        "error: rebuilt Conscrypt libraries embed host-specific build paths:\n  "
        + "\n  ".join(leaked)
    )
if not normalised:
    raise SystemExit(
        "error: no normalised source path was found in the rebuilt Conscrypt libraries; "
        "-ffile-prefix-map did not reach the native compile"
    )
print(f"Normalised source paths in rebuilt Conscrypt libraries: {normalised}")
PY
mkdir -p "$(dirname "$OUTPUT_AAR")"
cp "$built_aar" "$OUTPUT_AAR"
python3 - "$OUTPUT_POM" <<'PY'
from pathlib import Path
import sys

pom = Path(sys.argv[1])
pom.write_text(
    """<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.conscrypt</groupId>
  <artifactId>conscrypt-android</artifactId>
  <version>2.6.3-r28</version>
  <packaging>aar</packaging>
</project>
""",
    encoding="utf-8",
)
PY
sha256sum "$OUTPUT_AAR"
