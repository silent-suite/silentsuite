#!/usr/bin/env bash
set -euo pipefail

# Sign the admitted unsigned Android build, and prove what signed it.
#
# This runs in the signing job, on a fresh runner that has never checked out or
# executed candidate code. Everything it executes is either a JDK tool, an
# Android SDK build-tool, or the pinned bundletool jar — each resolved by an
# absolute path under a fixed, verified root rather than through PATH, because
# PATH is exactly what a compromised producer would reach for.
#
# Why post-build signing at all: Gradle's signing config makes candidate build
# scripts a party to the keystore. Signing the finished APK and AAB with the
# standard tools keeps the key in a job where no candidate byte executes.
#
#   APK  zipalign (alignment must precede signing) then apksigner
#   AAB  jarsigner, the documented upload-signing path for app bundles
#   both then re-read, and their signer certificate compared to the pin
#
# Secret handling:
#   * the store password reaches apksigner as `env:KSTOREPWD` and jarsigner as
#     `-storepass:env KSTOREPWD` — never an argument, never on disk;
#   * bundletool has no environment password form, so it gets a file created
#     under `umask 077` inside the caller's private directory, removed on exit;
#   * the alias is an unavoidable positional/`--ks-key-alias` argument to
#     jarsigner, apksigner and bundletool. That is stated rather than claimed
#     otherwise: it is the tools' interface, and it matches the pre-existing
#     reviewed behaviour. The password never joins it.
#
# Environment:
#   UNSIGNED_DIR   admitted producer output (read only)
#   OUTPUT_DIR     where signed artefacts and evidence are written
#   KEYSTORE_PATH  decoded, already verified store
#   KSTOREPWD      store password
#   KEY_ALIAS      signing alias
#   ANDROID_HOME   Android SDK root
#   BUNDLETOOL_JAR pinned, checksum-verified bundletool jar
#   JAVA_HOME      JDK root providing jarsigner/keytool

BUILD_TOOLS_VERSION="36.0.0"
EXPECTED_CERT_SHA256="8035a4ff1511e2045c579c905d26e93af6009b239e741ef78542ae04e7a7ca79"
KEYTOOL_LOCALE=(-J-Duser.language=en -J-Duser.country=US)

while [ $# -gt 0 ]; do
  case "$1" in
    --expect-sha256) EXPECTED_CERT_SHA256="${2:-}"; shift 2 ;;
    --build-tools-version) BUILD_TOOLS_VERSION="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

: "${UNSIGNED_DIR:?UNSIGNED_DIR must be set}"
: "${OUTPUT_DIR:?OUTPUT_DIR must be set}"
: "${KEYSTORE_PATH:?KEYSTORE_PATH must be set}"
: "${KSTOREPWD:?KSTOREPWD must be set}"
: "${KEY_ALIAS:?KEY_ALIAS must be set}"
: "${ANDROID_HOME:?ANDROID_HOME must be set}"
: "${BUNDLETOOL_JAR:?BUNDLETOOL_JAR must be set}"
: "${JAVA_HOME:?JAVA_HOME must be set}"
export KSTOREPWD

refuse() {
  echo "Refusing to sign: $*" >&2
  exit 1
}

EXPECTED_CERT_SHA256="$(printf '%s' "$EXPECTED_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$EXPECTED_CERT_SHA256" | grep -Eq '^[0-9a-f]{64}$' \
  || refuse "the expected certificate fingerprint is not 64 hexadecimal characters"
printf '%s' "$BUILD_TOOLS_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || refuse "the build-tools version is not a dotted release number"

# ── Fixed tool paths, never PATH ──────────────────────────────────────

BUILD_TOOLS="${ANDROID_HOME}/build-tools/${BUILD_TOOLS_VERSION}"
ZIPALIGN="${BUILD_TOOLS}/zipalign"
APKSIGNER="${BUILD_TOOLS}/apksigner"
JARSIGNER="${JAVA_HOME}/bin/jarsigner"
KEYTOOL="${JAVA_HOME}/bin/keytool"
JAVA="${JAVA_HOME}/bin/java"

CANONICAL_BUILD_TOOLS="$(readlink -f -- "$BUILD_TOOLS")" \
  || refuse "the fixed build-tools root cannot be resolved"
CANONICAL_JAVA_HOME="$(readlink -f -- "$JAVA_HOME")" \
  || refuse "JAVA_HOME cannot be resolved"
[ -d "$CANONICAL_BUILD_TOOLS" ] || refuse "the fixed build-tools root is missing"
[ -d "$CANONICAL_JAVA_HOME" ] || refuse "JAVA_HOME is missing"

require_tool_beneath() {
  local tool="$1" root="$2" canonical
  [ -f "$tool" ] || refuse "required tool ${tool} is missing at its fixed path"
  [ -x "$tool" ] || refuse "required tool ${tool} is not executable"
  canonical="$(readlink -f -- "$tool")" \
    || refuse "required tool ${tool} cannot be resolved"
  case "$canonical" in
    "$root"/*) ;;
    *) refuse "required tool ${tool} resolves outside its trusted root" ;;
  esac
}

require_tool_beneath "$ZIPALIGN" "$CANONICAL_BUILD_TOOLS"
require_tool_beneath "$APKSIGNER" "$CANONICAL_BUILD_TOOLS"
require_tool_beneath "$JARSIGNER" "$CANONICAL_JAVA_HOME"
require_tool_beneath "$KEYTOOL" "$CANONICAL_JAVA_HOME"
require_tool_beneath "$JAVA" "$CANONICAL_JAVA_HOME"
[ -f "$BUNDLETOOL_JAR" ] || refuse "the pinned bundletool jar is missing"

# ── Inputs and outputs ────────────────────────────────────────────────

UNSIGNED_APK="${UNSIGNED_DIR}/app-release-unsigned.apk"
UNSIGNED_AAB="${UNSIGNED_DIR}/app-release.aab"
for input in "$UNSIGNED_APK" "$UNSIGNED_AAB"; do
  [ -f "$input" ] || refuse "admitted input ${input##*/} is missing"
done

mkdir -p "$OUTPUT_DIR"
SIGNED_APK="${OUTPUT_DIR}/app-release.apk"
SIGNED_AAB="${OUTPUT_DIR}/app-release.aab"
ALIGNED_APK="${OUTPUT_DIR}/app-release-aligned.apk"

WORKDIR="$(umask 077; mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# Read the SHA-256 of the certificate a tool reports, normalised for comparison.
leaf_fingerprint() {
  grep -m1 -oE 'SHA-?256(:| digest:)[[:space:]]*(([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}|[0-9a-f]{64})' \
    | sed -E 's/^SHA-?256(:| digest:)[[:space:]]*//' \
    | tr -d ': \t' \
    | tr '[:upper:]' '[:lower:]'
}

require_pinned_certificate() {
  local label="$1" observed="$2"
  printf '%s' "$observed" | grep -Eq '^[0-9a-f]{64}$' \
    || refuse "no SHA-256 signer certificate could be read from the signed ${label}"
  if [ "$observed" != "$EXPECTED_CERT_SHA256" ]; then
    echo "Refusing to sign: the signed ${label} does not carry the reviewed upload key" >&2
    echo "  expected SHA-256: ${EXPECTED_CERT_SHA256}" >&2
    echo "  observed SHA-256: ${observed}" >&2
    exit 1
  fi
  echo "  ${label}: signer certificate ${observed}"
}

# ── APK: align, then sign ─────────────────────────────────────────────
#
# zipalign must run before apksigner: aligning a signed APK would invalidate
# the signature, and apksigner deliberately preserves existing alignment.

"$ZIPALIGN" -P 16 -f 4 "$UNSIGNED_APK" "$ALIGNED_APK"
"$ZIPALIGN" -c -P 16 4 "$ALIGNED_APK" || refuse "the aligned APK failed zipalign verification"

"$APKSIGNER" sign \
  --ks "$KEYSTORE_PATH" \
  --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "env:KSTOREPWD" \
  --key-pass "env:KSTOREPWD" \
  --out "$SIGNED_APK" \
  "$ALIGNED_APK"
rm -f "$ALIGNED_APK"

# ── AAB: jarsigner ────────────────────────────────────────────────────

"$JARSIGNER" -keystore "$KEYSTORE_PATH" -storepass:env KSTOREPWD \
  -signedjar "$SIGNED_AAB" "$UNSIGNED_AAB" "$KEY_ALIAS" >/dev/null

# ── Prove what signed them ────────────────────────────────────────────

echo "Signed with the reviewed upload key:"
require_pinned_certificate "APK" \
  "$("$APKSIGNER" verify --print-certs "$SIGNED_APK" 2>/dev/null | leaf_fingerprint || true)"
require_pinned_certificate "AAB" \
  "$("$KEYTOOL" "${KEYTOOL_LOCALE[@]}" -printcert -jarfile "$SIGNED_AAB" 2>/dev/null | leaf_fingerprint || true)"

# Strict verification is required because plain `jarsigner -verify` exits zero
# for an unsigned JAR. The already preflighted JKS is also the explicit trust
# store: it trusts the deliberately self-signed, exactly pinned upload
# certificate while strict mode rejects unsigned entries, integrity failures,
# and algorithm-policy errors. JDK 17 still exits zero for a wholly unsigned
# JAR even in strict mode, so require its locale-stabilized verified result too.
JARSIGNER_VERIFY_LOG="$WORKDIR/jarsigner-verify.log"
if ! "$JARSIGNER" -verify -strict \
  -keystore "$KEYSTORE_PATH" -storepass:env KSTOREPWD \
  "${KEYTOOL_LOCALE[@]}" "$SIGNED_AAB" >"$JARSIGNER_VERIFY_LOG" 2>&1 \
  || ! grep -Fxq 'jar verified.' "$JARSIGNER_VERIFY_LOG"; then
  echo "Refusing to sign: the signed AAB failed cryptographic integrity verification" >&2
  echo "  jarsigner diagnostic (sanitized, first 4096 bytes):" >&2
  head -c 4096 "$JARSIGNER_VERIFY_LOG" | LC_ALL=C tr -cd '\11\12\15\40-\176' >&2
  echo >&2
  exit 1
fi

# ── Signed split evidence ─────────────────────────────────────────────
#
# bundletool takes only `pass:` or `file:`, so the password goes to a private
# file inside this run's 0700 workdir and is removed with it.

PASSWORD_FILE="$WORKDIR/bundletool-password"
( umask 077; printf '%s' "$KSTOREPWD" > "$PASSWORD_FILE" )

"$JAVA" -jar "$BUNDLETOOL_JAR" build-apks \
  --bundle "$SIGNED_AAB" \
  --output "${OUTPUT_DIR}/signed-release.apks" \
  --mode universal \
  --ks="$KEYSTORE_PATH" \
  --ks-key-alias="$KEY_ALIAS" \
  --ks-pass="file:${PASSWORD_FILE}" \
  --key-pass="file:${PASSWORD_FILE}"
rm -f "$PASSWORD_FILE"

echo "  signed universal split set written"
