#!/usr/bin/env bash
# Containment and integrity tests for the YunoHost package's image fetch
# (self-host/yunohost/silentsuite_ynh/scripts/_common.sh), run as root in CI.
#
# Expects: systemd as PID 1, skopeo and umoci installed, and a registry:2 container named
# "registry" on 127.0.0.1:5000 storing its data in /var/lib/registry-ci. Fixture images are
# hand-made OCI layouts (exact tar members, real whiteouts), pushed with skopeo. The package's
# own functions are sourced and called unchanged; only the YunoHost helpers are stand-ins.
#
# _common.sh is sourced, not followed: it reads app, install_dir, data_dir, YNH_ARCH and the pins
# (SC2034), defines fetch_dir (SC2154) and calls the helper stand-ins (SC2317).
# shellcheck disable=SC2034,SC2154,SC2317
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
common="$repo_root/self-host/yunohost/silentsuite_ynh/scripts/_common.sh"
registry_dir=/var/lib/registry-ci/docker/registry/v2/blobs/sha256
reg=localhost:5000

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
for tool in skopeo umoci systemd-run docker jq tar sha256sum; do
    command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 2; }
done

# --- YunoHost helper stand-ins (only what _common.sh calls on this path) ---
ynh_die() { echo "ynh_die: $*" >&2; exit 1; }
ynh_print_info() { echo "$*"; }
ynh_safe_rm() {
    [ -n "${1:-}" ] || ynh_die "ynh_safe_rm: empty path"
    rm -rf -- "$1"
}

# shellcheck source=/dev/null
source "$common"

app=silentsuite
YNH_ARCH=amd64
rand=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
work=$(mktemp -d /var/tmp/ynh-fetch-test.XXXXXX)
created_user=""
cleanup() {
    rm -rf "$work" "$fetch_dir" /var/lib/silentsuite-fetch
    if [ -n "$created_user" ]; then userdel "$app" 2>/dev/null || true; fi
}
trap cleanup EXIT

# _silentsuite_set_permissions chowns to $app.
if ! id -u "$app" >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$app"
    created_user=1
fi

# skopeo (also inside the fetch unit) talks plain HTTP to the CI registry only.
mkdir -p /etc/containers/registries.conf.d
printf '[[registry]]\nlocation = "%s"\ninsecure = true\n' "$reg" >/etc/containers/registries.conf.d/ci-localhost.conf
if [ ! -e /etc/containers/policy.json ]; then
    echo "WARN: /etc/containers/policy.json missing, writing an accept-anything policy for this runner"
    echo '{"default":[{"type":"insecureAcceptAnything"}]}' >/etc/containers/policy.json
fi

fails=0
check() {
    local name=$1
    shift
    if "$@"; then echo "PASS: $name"; else echo "FAIL: $name"; fails=$((fails + 1)); fi
}
none() { [ -z "$("$@")" ]; }   # the command prints nothing
sha() { sha256sum "$1" | cut -d' ' -f1; }

# push_image NAME TAR... : build an OCI layout from uncompressed layer tars, push it, print the
# per-arch manifest digest as stored by the registry.
push_image() {
    local name=$1 layout="$work/layout-$1" ids="" layers="" t d s cfg man
    shift
    mkdir -p "$layout/blobs/sha256"
    echo '{"imageLayoutVersion":"1.0.0"}' >"$layout/oci-layout"
    for t in "$@"; do
        d=$(sha "$t"); s=$(stat -c %s "$t")
        cp "$t" "$layout/blobs/sha256/$d"
        ids="$ids${ids:+,}\"sha256:$d\""
        layers="$layers${layers:+,}{\"mediaType\":\"application/vnd.oci.image.layer.v1.tar\",\"digest\":\"sha256:$d\",\"size\":$s}"
    done
    printf '{"architecture":"amd64","os":"linux","config":{},"rootfs":{"type":"layers","diff_ids":[%s]}}' "$ids" >"$work/cfg"
    cfg=$(sha "$work/cfg"); mv "$work/cfg" "$layout/blobs/sha256/$cfg"
    printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:%s","size":%s},"layers":[%s]}' \
        "$cfg" "$(stat -c %s "$layout/blobs/sha256/$cfg")" "$layers" >"$work/man"
    man=$(sha "$work/man"); s=$(stat -c %s "$work/man"); mv "$work/man" "$layout/blobs/sha256/$man"
    printf '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:%s","size":%s,"annotations":{"org.opencontainers.image.ref.name":"t"}}]}' \
        "$man" "$s" >"$layout/index.json"
    skopeo copy --quiet "oci:$layout:t" "docker://$reg/$name:t" >&2
    echo "sha256:$(skopeo inspect --raw "docker://$reg/$name:t" | sha256sum | cut -d' ' -f1)"
}

# simple_layer OUT BINARY ID : one layer with usr/local/bin/BINARY and a unique id file.
simple_layer() {
    local dir="$work/stage-$3"
    mkdir -p "$dir/usr/local/bin"
    printf '#!/bin/sh\necho %s\n' "$3" >"$dir/usr/local/bin/$2"
    chmod 755 "$dir/usr/local/bin/$2"
    echo "$3-$rand" >"$dir/id"
    tar --numeric-owner --owner=0 --group=0 -cf "$1" -C "$dir" usr id
}

restart_registry() {
    docker restart registry >/dev/null
    local i
    for i in $(seq 30); do
        curl -sf "http://127.0.0.1:5000/v2/" >/dev/null && return 0
        sleep 1
    done
    echo "registry did not come back" >&2; exit 2
}

# Fresh install dir with known old trees and the config files _silentsuite_set_permissions touches.
reset_install() {
    install_dir="$work/install-$1"; data_dir="$work/data-$1"
    mkdir -p "$install_dir/server/usr/local/bin" "$install_dir/web/usr/local/bin" "$data_dir"
    echo "old server $1" >"$install_dir/server/usr/local/bin/python"
    echo "old web $1" >"$install_dir/web/usr/local/bin/node"
    touch "$install_dir/server.env" "$install_dir/etebase-server.ini"
    rm -rf "$fetch_dir" /var/lib/silentsuite-fetch
}
tree_sums() { (cd "$install_dir" && find server web -type f -exec sha256sum {} + | sort); }

# Upgrade order: fetch, then swap. Must fail and leave the old trees byte-identical.
expect_fetch_failure() {
    local name=$1 before
    before=$(tree_sums)
    check "$name: fetch fails" eval '! ( _silentsuite_fetch_images && _silentsuite_promote_images )'
    check "$name: install trees unchanged" test "$before" = "$(tree_sums)"
}

#=== Case a: containment across layers ======================================
s1="$work/s1"; s2="$work/s2"
mkdir -p "$s1/usr/local/bin" "$s1/opq" "$s1/hard" "$s1/sgid" "$s1/tmp/ynh-outside-$rand" "$s2/opq" "$s2/escape" "$s2/up"
printf '#!/bin/sh\necho fixture\n' >"$s1/usr/local/bin/python"
cp "$s1/usr/local/bin/python" "$s1/usr/local/bin/node"
chmod 755 "$s1/usr/local/bin/python" "$s1/usr/local/bin/node"
echo gone >"$s1/gone.txt"; echo old >"$s1/opq/old.txt"; echo "$rand" >"$s1/hard/a"
ln "$s1/hard/a" "$s1/hard/b"
printf '#!/bin/sh\n' >"$s1/suid"; chmod 4755 "$s1/suid"
ln -s "/tmp/ynh-outside-$rand" "$s1/escape"   # absolute: host /tmp if followed naively
ln -s .. "$s1/up"                             # relative: the fetch state dir if followed naively
chmod 2775 "$s1/sgid"  # a setgid directory, as Debian images ship (/var/mail)
tar --numeric-owner --owner=0 --group=0 -cf "$work/a1.tar" -C "$s1" usr gone.txt opq hard sgid suid tmp escape up
: >"$s2/.wh.gone.txt"; : >"$s2/opq/.wh..wh..opq"; echo new >"$s2/opq/new.txt"
echo pwned >"$s2/escape/pwned"; echo pwned >"$s2/up/pwned-up-$rand"
# File members only (no directory entries), so escape/ and up/ resolve through the layer-1 links.
tar --numeric-owner --owner=0 --group=0 -cf "$work/a2.tar" -C "$s2" \
    .wh.gone.txt opq/.wh..wh..opq opq/new.txt escape/pwned "up/pwned-up-$rand"

reset_install a
server_repo="$reg/fx-a"; web_repo="$reg/fx-a"
server_digest_amd64=$(push_image fx-a "$work/a1.tar" "$work/a2.tar")
web_digest_amd64=$server_digest_amd64
if ! ( _silentsuite_fetch_images ); then echo "FAIL: a: fetch"; exit 1; fi
echo "PASS: a: fetch succeeds"
check "a: relative link not followed out of the tree" test ! -e "$fetch_dir/pwned-up-$rand"
if ! ( _silentsuite_promote_images && _silentsuite_set_permissions ); then echo "FAIL: a: promote/permissions"; exit 1; fi
S="$install_dir/server"; W="$install_dir/web"
check "a: ordinary whiteout applied" test ! -e "$S/gone.txt"
check "a: opaque whiteout applied" test ! -e "$S/opq/old.txt"
check "a: opaque dir has new layer content" test -f "$S/opq/new.txt"
check "a: no whiteout markers left" none find "$S" "$W" -name '.wh.*'
check "a: nothing created at /tmp/ynh-outside-*" none find /tmp -maxdepth 1 -name 'ynh-outside-*'
check "a: absolute link resolved inside the tree" test -f "$S/tmp/ynh-outside-$rand/pwned"
check "a: relative link resolved inside the tree" test -f "$S/pwned-up-$rand"
check "a: hard link inside the tree" test "$(stat -c %i "$S/hard/a")" = "$(stat -c %i "$S/hard/b")"
check "a: no setuid/setgid files" none find "$S" "$W" -perm /6000
check "a: file modes 0644/0755 only" none find "$S" "$W" -type f ! -perm 0644 ! -perm 0755
check "a: directory modes 0755 only" none find "$S" "$W" -type d ! -perm 0755
check "a: trees owned root:root" none find "$S" "$W" \( ! -uid 0 -o ! -gid 0 \)
check "a: no leftover fetch dir" test ! -e "$fetch_dir"
check "a: no leftover fetch state link" eval '[ ! -e /var/lib/silentsuite-fetch ] && [ ! -L /var/lib/silentsuite-fetch ]'

# Shared good server image for the failure cases.
simple_layer "$work/good-server.tar" python good-server
good_server=$(push_image fx-good-server "$work/good-server.tar")
server_repo="$reg/fx-good-server"; server_digest_amd64=$good_server

#=== Case b: tampered layer bytes under the expected digest ==================
reset_install b
simple_layer "$work/b.tar" node web-b
web_repo="$reg/fx-b"; web_digest_amd64=$(push_image fx-b "$work/b.tar")
layer=$(skopeo inspect --raw "docker://$reg/fx-b@$web_digest_amd64" | jq -r '.layers[0].digest')
blob="$registry_dir/${layer:7:2}/${layer#sha256:}/data"
head -c "$(stat -c %s "$blob")" /dev/urandom >"$blob.new" && mv "$blob.new" "$blob"
restart_registry
expect_fetch_failure "b (tampered layer)"

#=== Case c: tampered manifest blob ==========================================
reset_install c
simple_layer "$work/c.tar" node web-c
web_repo="$reg/fx-c"; web_digest_amd64=$(push_image fx-c "$work/c.tar")
blob="$registry_dir/${web_digest_amd64:7:2}/${web_digest_amd64#sha256:}/data"
echo ' ' >>"$blob"   # still valid JSON, different digest
restart_registry
expect_fetch_failure "c (tampered manifest)"

#=== Case d: pin flipped by one hex digit ====================================
reset_install d
simple_layer "$work/d.tar" node web-d
web_repo="$reg/fx-d"; web_digest_amd64=$(push_image fx-d "$work/d.tar")
last=${good_server: -1}
flip=0
[ "$last" != 0 ] || flip=1
server_digest_amd64="${good_server%?}$flip"
expect_fetch_failure "d (flipped pin)"

echo "fetcher tests: $fails failure(s)"
[ "$fails" -eq 0 ]
