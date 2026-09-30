#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Builds the Libre Workspace add-on package libre-workspace-module-silentsuite.
#
#   integrations/libre-workspace/build-deb.sh --release v0.5.10-beta --out-dir <new dir>
#
# The package pins one published SilentSuite release. It carries a verbatim
# copy of this checkout's self-host/install.sh, which performs all release,
# checksum and image verification at setup time, so that installer must accept
# the pinned release's bundle (compare: git diff <tag> -- self-host/install.sh).
# A mismatch cannot install anything unverified: the installer refuses a bundle
# it does not recognise. The output directory must not exist; missing parent
# directories are created.
#
# --tree-only stops after assembling the package tree (no dpkg-deb needed).

set -euo pipefail
umask 022

usage() {
  echo "Usage: build-deb.sh --release <vX.Y.Z[-suffix]> --out-dir <new directory> [--tree-only]"
}

RELEASE=""
OUT_DIR=""
TREE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --release) RELEASE="${2:-}"; shift 2 || { usage >&2; exit 1; } ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 || { usage >&2; exit 1; } ;;
    --tree-only) TREE_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

if ! printf '%s' "$RELEASE" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?'; then
  echo "ERROR: --release must be a SilentSuite release tag such as v0.5.10-beta." >&2
  exit 1
fi
if [ -z "$OUT_DIR" ]; then
  echo "ERROR: --out-dir is required." >&2
  exit 1
fi
if [ -e "$OUT_DIR" ] || [ -L "$OUT_DIR" ]; then
  echo "ERROR: '$OUT_DIR' already exists; choose a new output directory." >&2
  exit 1
fi

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$HERE/../.." && pwd -P)"

PACKAGE="libre-workspace-module-silentsuite"
# Debian sorts '~' before anything, so 0.5.10~beta < 0.5.10.
PACKAGE_VERSION="$(printf '%s' "${RELEASE#v}" | tr '-' '~')"

OUT_PARENT="$(dirname -- "$OUT_DIR")"
mkdir -p -- "$OUT_PARENT"
# No -p here: the output directory itself must be new.
mkdir -- "$OUT_DIR"
OUT_DIR="$(cd -- "$OUT_DIR" && pwd -P)"
TREE="$OUT_DIR/${PACKAGE}_${PACKAGE_VERSION}_all"
MODULE="$TREE/usr/lib/libre-workspace/modules/silentsuite"
mkdir -p -- "$MODULE" "$TREE/DEBIAN"

install -m 0644 "$HERE/module/silentsuite.conf" "$MODULE/silentsuite.conf"
install -m 0644 "$HERE/module/silentsuite-addon-lib.sh" "$MODULE/silentsuite-addon-lib.sh"
for script in setup_silentsuite.sh update_silentsuite.sh remove_silentsuite.sh; do
  install -m 0755 "$HERE/module/$script" "$MODULE/$script"
done
install -m 0755 "$REPO_ROOT/self-host/install.sh" "$MODULE/install.sh"
install -m 0644 "$REPO_ROOT/LICENSE" "$MODULE/LICENSE"
# The scripts' messages refer operators to this file.
install -m 0644 "$HERE/README.md" "$MODULE/README.md"
# The portal shows the one image file in the module directory as the icon.
install -m 0644 "$REPO_ROOT/apps/docs/public/logo.svg" "$MODULE/silentsuite.svg"
printf '%s\n' "$RELEASE" > "$MODULE/silentsuite-release"
chmod 0644 "$MODULE/silentsuite-release"

sed -e "s/@VERSION@/$PACKAGE_VERSION/" -e "s/@RELEASE@/$RELEASE/" \
  "$HERE/debian/control.in" > "$TREE/DEBIAN/control"
chmod 0644 "$TREE/DEBIAN/control"
find "$TREE" -type d -exec chmod 0755 {} +

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || echo 0)}"
export SOURCE_DATE_EPOCH
find "$TREE" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

if [ "$TREE_ONLY" -eq 1 ]; then
  echo "Package tree: $TREE"
  exit 0
fi

if ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "ERROR: dpkg-deb is required to build the package (or use --tree-only)." >&2
  exit 1
fi
DEB_NAME="${PACKAGE}_${PACKAGE_VERSION}_all.deb"
dpkg-deb --root-owner-group -Zxz --build "$TREE" "$OUT_DIR/$DEB_NAME" >/dev/null
(cd -- "$OUT_DIR" && sha256sum -- "$DEB_NAME" > "$DEB_NAME.sha256")

echo "Package: $OUT_DIR/$DEB_NAME"
echo "SHA-256: $(cut -d' ' -f1 < "$OUT_DIR/$DEB_NAME.sha256")"
