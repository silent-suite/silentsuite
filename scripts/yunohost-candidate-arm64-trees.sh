#!/usr/bin/env bash
# CI only: on a plain Debian 12 arm64 container (YunoHost publishes no arm64 test
# images), run the package's own fetch, promotion and permission code for the arm64
# images, then start each tree under systemd RootDirectory= the way the units do.
# Usage (as root inside the container): arm64-trees.sh <package dir>
set -euo pipefail

pkg=$1
ynh_die() { echo "FAIL $*" >&2; exit 1; }
ynh_print_info() { echo "$*"; }
ynh_safe_rm() { [ -n "${1:-}" ] && rm -rf -- "$1"; }

app=silentsuite
YNH_ARCH=$(dpkg --print-architecture)
[ "$YNH_ARCH" = arm64 ] || ynh_die "expected arm64, got $YNH_ARCH"
install_dir=/var/www/$app
data_dir=/home/yunohost.app/$app
# shellcheck source=/dev/null
source "$pkg/scripts/_common.sh"

id -u "$app" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$app"
mkdir -p "$install_dir" "$data_dir"
_silentsuite_fetch_images
_silentsuite_promote_images
_silentsuite_remove_old_images
printf '[global]\nsecret_file = /data/secret.txt\n' > "$install_dir/etebase-server.ini"
: > "$install_dir/server.env"
_silentsuite_set_permissions
[ -z "$(find "$install_dir/server" "$install_dir/web" -perm /6000 -print -quit)" ] || ynh_die "setuid/setgid left"
echo "PASS arm64: fetch, promotion and permissions"

sandbox=(-p MountAPIVFS=no -p NoNewPrivileges=yes -p ProtectSystem=strict -p PrivateTmp=yes -p PrivateDevices=yes
         -p User="$app" -p Group="$app" -p WorkingDirectory=/app)
systemd-run --wait --pipe --quiet "${sandbox[@]}" \
    -p RootDirectory="$install_dir/server" -p BindPaths="$data_dir:/data" -p ReadWritePaths=+/data \
    -p BindReadOnlyPaths="$install_dir/etebase-server.ini:/etc/etebase-server/etebase-server.ini" \
    /usr/local/bin/python -c 'import django, nacl, psycopg2, uvicorn, etebase_server; open("/data/.w", "w").close()' \
    || ynh_die "arm64: server tree does not run under RootDirectory"
[ -e "$data_dir/.w" ] || ynh_die "arm64: server could not write /data"
echo "PASS arm64: server tree runs and writes only /data"

systemd-run --wait --pipe --quiet "${sandbox[@]}" \
    -p RootDirectory="$install_dir/web" -p CacheDirectory="$app-web" \
    -p BindPaths="/var/cache/$app-web:/app/apps/web/.next/cache" -p ReadWritePaths=+/app/apps/web/.next/cache \
    /usr/local/bin/node -e 'const fs = require("fs"); fs.accessSync("/app/apps/web/server.js", fs.constants.R_OK); fs.writeFileSync("/app/apps/web/.next/cache/.w", "")' \
    || ynh_die "arm64: web tree does not run under RootDirectory"
echo "PASS arm64: web tree runs and writes only its cache"
