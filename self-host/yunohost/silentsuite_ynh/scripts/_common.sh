#!/bin/bash

#=================================================
# PUBLISHED IMAGES
#=================================================

# Released v0.5.20-beta images, pinned per architecture. These digests are the
# amd64Digest/arm64Digest values of the release asset umbrel-images.json.
server_repo="ghcr.io/silent-suite/silentsuite-server"
server_digest_amd64="sha256:74e078a5d01b565152db6abe5ecb3ed7a3148055c8835e7128e636ef53bc5253"
server_digest_arm64="sha256:b7fdd0494cd709366c7648bfa1976721ef12829af44a56ab5a0c8ede789266cb"
web_repo="ghcr.io/silent-suite/silentsuite-web-selfhost"
web_digest_amd64="sha256:3793c9e037c26d7b7e396cafd903362047aa8b7e2c6c6479eaa3d78d93bd0ef1"
web_digest_arm64="sha256:f67dab2687f3fb3632606ce695cdeb770e61870ee45cb4039042b2f600b3c7d7"

# Transient identity and directory for the download, removed after each fetch.
fetch_user="silentsuite-fetch"
fetch_root="/var/lib/silentsuite-fetch"
fetch_dir="$fetch_root/work"

#=================================================
# FETCH AND INSTALL THE IMAGE TREES
#=================================================

_silentsuite_image_ref() {
    local component=$1 repo digest
    repo="${component}_repo"
    digest="${component}_digest_${YNH_ARCH}"
    [ -n "${!digest:-}" ] || ynh_die "No $component image for architecture $YNH_ARCH"
    echo "${!repo}@${!digest}"
}

_silentsuite_cleanup_fetch() {
    rm -rf "$fetch_root"
    if id -u "$fetch_user" >/dev/null 2>&1; then
        userdel "$fetch_user"
    fi
}

# Download both images by digest and unpack them as a system user created for this
# fetch only, in a directory only root and that user can reach. skopeo checks every
# digest, umoci applies the layers inside the tree. (Not DynamicUser: it forbids the
# setgid bits umoci restores from the image; they are cleared after promotion.)
_silentsuite_fetch_images() {
    _silentsuite_cleanup_fetch
    useradd --system --user-group --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin "$fetch_user"
    install -d -m 0710 -o root -g "$fetch_user" "$fetch_root"
    install -d -m 0700 -o "$fetch_user" -g "$fetch_user" "$fetch_dir"

    # A file, not an inline script: systemd expands $ references on the command line.
    cat > "$fetch_root/fetch.sh" <<'FETCH'
set -eu
cd "$HOME"
for pair in "$@"; do
    name=${pair%%=*}
    skopeo copy --quiet --retry-times 3 --preserve-digests "docker://${pair#*=}" "oci:oci-$name:img"
    umoci raw unpack --rootless --image "oci-$name:img" "$name"
    rm -rf "oci-$name"
done
FETCH
    chmod 644 "$fetch_root/fetch.sh"

    if ! systemd-run --wait --pipe --quiet --collect --unit="silentsuite-fetch" \
        -p User="$fetch_user" -p Group="$fetch_user" \
        -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=yes -p NoNewPrivileges=yes \
        -p ReadWritePaths="$fetch_dir" -p Environment=HOME="$fetch_dir" \
        /bin/sh "$fetch_root/fetch.sh" \
        "server=$(_silentsuite_image_ref server)" "web=$(_silentsuite_image_ref web)"; then
        _silentsuite_cleanup_fetch
        ynh_die "Could not fetch and verify the SilentSuite images"
    fi

    # The unit is gone once systemd-run returns; make sure nothing of it still runs.
    if pgrep -u "$fetch_user" >/dev/null; then
        ynh_die "A process of the fetch unit is still running"
    fi
    [ -x "$fetch_dir/server/usr/local/bin/python" ] || ynh_die "The server image tree is incomplete"
    [ -x "$fetch_dir/web/usr/local/bin/node" ] || ynh_die "The web image tree is incomplete"
}

# Move the fetched trees into $install_dir, keeping the current ones as *.old.
_silentsuite_promote_images() {
    local tree
    for tree in server web; do
        chown -R -h root:root "$fetch_dir/$tree"
        ynh_safe_rm "$install_dir/$tree.old"
        if [ -d "$install_dir/$tree" ]; then
            mv "$install_dir/$tree" "$install_dir/$tree.old"
        fi
        mv "$fetch_dir/$tree" "$install_dir/$tree"
    done
    # Mount points for the units (see conf/*.service).
    mkdir -p "$install_dir/server/etc/etebase-server" "$install_dir/web/app/apps/web/.next/cache"
    _silentsuite_cleanup_fetch
    ynh_print_info "silentsuite: image trees swapped"
}

_silentsuite_remove_old_images() {
    ynh_safe_rm "$install_dir/server.old"
    ynh_safe_rm "$install_dir/web.old"
}

#=================================================
# CONFIGURATION AND PERMISSIONS
#=================================================

_silentsuite_add_config() {
    ynh_config_add --template="etebase-server.ini" --destination="$install_dir/etebase-server.ini"
    ynh_config_add --template="server.env" --destination="$install_dir/server.env"
}

# The image trees and server.env stay root-owned and read-only for the app; only
# $data_dir is the app's. Called after install, upgrade and restore (ynh_restore hands
# $install_dir to the app user), before any service starts.
_silentsuite_set_permissions() {
    local tree
    chown root:root "$install_dir"
    chmod 755 "$install_dir"
    for tree in server web; do
        chown -R -h root:root "$install_dir/$tree"
        # Symbolic mode: a numeric mode keeps setuid/setgid bits on directories.
        find "$install_dir/$tree" -type d -exec chmod u=rwx,go=rx,ug-s {} +
        find "$install_dir/$tree" -type f -perm /u+x -exec chmod 755 {} +
        find "$install_dir/$tree" -type f ! -perm /u+x -exec chmod 644 {} +
    done
    chown root:root "$install_dir/server.env"
    chmod 600 "$install_dir/server.env"
    chown "root:$app" "$install_dir/etebase-server.ini"
    chmod 640 "$install_dir/etebase-server.ini"
    mkdir -p "$data_dir/media" "$data_dir/static"
    chown -R "$app:$app" "$data_dir"
    chmod 750 "$data_dir"
}

#=================================================
# START AND READINESS
#=================================================

# Wait up to 120 s for an exact HTTP 200, each request bounded by the time left.
_silentsuite_wait_ready() {
    local url=$1 service=$2 deadline=$((SECONDS + 120)) remaining code
    while true; do
        remaining=$((deadline - SECONDS))
        [ "$remaining" -gt 0 ] || break
        code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 \
            --max-time "$((remaining < 5 ? remaining : 5))" \
            -H "Host: $domain" -H "X-Forwarded-Proto: https" "$url" 2>/dev/null) || code=000
        [ "$code" = 200 ] && return 0
        sleep 2
    done
    journalctl --unit="$service" --lines=20 --no-pager --output=cat >&2 || true
    ynh_die "$service did not answer HTTP 200 within 120 seconds"
}

_silentsuite_start() {
    ynh_systemctl --service="$app-server" --action="start"
    _silentsuite_wait_ready "http://127.0.0.1:$port_server/api/v1/authentication/is_etebase/" "$app-server"
    ynh_systemctl --service="$app-web" --action="start"
    _silentsuite_wait_ready "http://127.0.0.1:$port_web/signup" "$app-web"
}
