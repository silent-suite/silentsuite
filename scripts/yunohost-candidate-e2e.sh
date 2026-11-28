#!/usr/bin/env bash
# CI only: end-to-end run of the YunoHost package in a YunoHost app-CI container.
#
# Expects Incus with a running container "ynh" booted from a YunoHost app-CI image,
# `pnpm install` done (the witness uses the repo's patched etebase SDK), and runs on
# the GitHub runner with sudo. Every credential here is a synthetic, per-run value.
# Order: private install + boundary probes, purge; public install + boundary, data
# witness, token and WebSocket checks; upgrade; failed upgrade with rollback;
# backup, purge, restore; log-marker scan; remove.
# Single-quoted strings below are run inside the container, on purpose.
# shellcheck disable=SC2016
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
pkg="$repo/self-host/yunohost/silentsuite_ynh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
app=silentsuite
install_dir=/var/www/$app
data_dir=/home/yunohost.app/$app

ct() { sudo incus exec ynh -- "$@"; }
group() { echo "::endgroup::"; echo "::group::$*"; }
fail() { echo "FAIL $*"; exit 1; }
pass() { echo "PASS $*"; }
secret() { local v; v=$(openssl rand -hex 16); echo "::add-mask::$v" >&2; echo "$v"; }

export DOMAIN=domain.tld CA_FILE="$work/ca.pem" NODE_EXTRA_CA_CERTS="$work/ca.pem"
export ADMIN_USER=ssadmin USER_NAME=ssuser
ADMIN_PASS="Ci-$(secret)"; USER_PASS="Ci-$(secret)"; export ADMIN_PASS USER_PASS
STATE="$work/witness.json"
MARKERS="$work/markers"   # "kind<TAB>value" lines, collected across every stage
: >"$MARKERS"
add_marker() { printf '%s\t%s\n' "$1" "$2" >>"$MARKERS"; }
state_markers() {
    python3 - "$STATE" <<'PY' >>"$MARKERS"
import json, sys
s = json.load(open(sys.argv[1]))
for kind, key in (("auth-token", "authToken"), ("collection-uid", "collectionUid"), ("item-uid", "itemUid")):
    print(f"{kind}\t{s[key]}")
PY
}
probe() { python3 "$repo/scripts/yunohost-candidate-probe.py" "$@"; }
witness() { node "$repo/scripts/yunohost-candidate-witness.mjs" "$@" --state "$STATE"; }

#=== Container setup ==========================================================
echo "::group::container setup"
ct yunohost domain list --output-as json | grep -q "\"$DOMAIN\"" || fail "setup: $DOMAIN missing"
ct yunohost user create "$ADMIN_USER" --fullname "CI Admin" --domain "$DOMAIN" --password "$ADMIN_PASS" >/dev/null
ct yunohost user group add admins "$ADMIN_USER" >/dev/null
ct yunohost user create "$USER_NAME" --fullname "CI User" --domain "$DOMAIN" --password "$USER_PASS" >/dev/null
# YunoHost signs its self-signed domain certificates with this local CA.
ct cat /etc/ssl/certs/ca-yunohost_crt.pem "/etc/yunohost/certs/$DOMAIN/crt.pem" > "$CA_FILE"
ip=$(sudo incus list ynh --format csv -c 4 | cut -d' ' -f1)
echo "$ip $DOMAIN" | sudo tee -a /etc/hosts >/dev/null
# Diagnostic only (no secrets): how the runner sees the container's certificate.
echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" -CAfile "$CA_FILE" 2>/dev/null \
    | grep -E "Verify return code|^subject=|^issuer=" || true
ct sh -c "openssl x509 -in /etc/yunohost/certs/$DOMAIN/crt.pem -noout -subject -issuer -dates -ext subjectAltName -text" \
    | grep -E "subject=|issuer=|notBefore|notAfter|DNS:|Signature Algorithm|Public-Key" | sort -u || true
python3 -c "import ssl, sys; print(sys.version.split()[0], ssl.OPENSSL_VERSION)"
for f in yunohost-candidate-ws-responder.py yunohost-candidate-rollback-evidence.py yunohost-candidate-log-scan.py; do
    sudo incus file push "$repo/scripts/$f" "ynh/root/$f"
done

push_pkg() { ct rm -rf "/root/$2"; sudo incus file push -r "$1" ynh/root/ >/dev/null; [ "$(basename "$1")" = "$2" ] || ct mv "/root/$(basename "$1")" "/root/$2"; }

install_app() {
    push_pkg "$pkg" silentsuite_ynh
    ct yunohost app install /root/silentsuite_ynh --force \
        --args "domain=$DOMAIN&init_main_permission=$1" >"$work/install-$1.log" 2>&1 \
        || { tail -40 "$work/install-$1.log"; fail "install ($1)"; }
    pass "install ($1)"
    OWNER_PASSWORD=$(ct yunohost app setting "$app" owner_password)
    echo "::add-mask::$OWNER_PASSWORD"; export OWNER_PASSWORD
    add_marker owner-password "$OWNER_PASSWORD"
    add_marker registration-token "$(ct yunohost app setting "$app" registration_token)"
    # Control, reported but not counted: YunoHost core's own helpers trace this db_pwd.
    add_marker control-db-pwd "$(ct yunohost app setting "$app" db_pwd)"
}

purge_app() {
    ct yunohost app remove "$app" --purge >/dev/null 2>&1 || fail "remove --purge"
    ct test ! -e "$install_dir" || fail "purge: install dir left"
    ct test ! -e "$data_dir" || fail "purge: data dir left"
    ct test ! -e "/var/cache/$app-web" || fail "purge: web cache left"
    [ -z "$(ct sudo -u postgres psql -tAc "select 1 from pg_database where datname='$app'")" ] || fail "purge: database left"
    pass "remove --purge leaves nothing"
}

#=== F1: owners, modes and sandboxes ==========================================
check_perms() {
    local when=$1 pid
    ct sh -euc '
        d='"$install_dir"'
        [ "$(stat -c %U:%G:%a "$d")" = root:'"$app"':750 ]
        [ "$(stat -c %U:%G:%a "$d/server.env")" = root:root:600 ]
        [ "$(stat -c %U:%G:%a "$d/etebase-server.ini")" = root:'"$app"':640 ]
        [ -z "$(find "$d/server" "$d/web" \( ! -uid 0 -o ! -gid 0 -o -perm /6000 \) -print -quit)" ]
        [ -z "$(find "$d/server" "$d/web" -type f ! -perm 0644 ! -perm 0755 -print -quit)" ]
        [ -z "$(find "$d/server" "$d/web" -type d ! -perm 0755 -print -quit)" ]
        [ ! -e "$d/server.old" ] && [ ! -e "$d/web.old" ]
        [ "$(systemctl show -p User --value '"$app"'-server)" = '"$app"' ]
        [ "$(systemctl show -p User --value '"$app"'-web)" = '"$app"' ]
        if sudo -u '"$app"' cat "$d/server.env" >/dev/null 2>&1; then exit 1; fi
        if sudo -u '"$app"' touch "$d/server/x" 2>/dev/null; then exit 1; fi
        if sudo -u '"$app"' touch "$d/x" 2>/dev/null; then exit 1; fi
    ' || fail "perms ($when): owners/modes"
    pid=$(ct systemctl show -p MainPID --value "$app-server")
    ct nsenter -t "$pid" -m -r -w -S "$(ct id -u $app)" -G "$(ct id -g $app)" \
        /usr/local/bin/python -c 'import etebase_server, os; open("/data/.w", "w").close(); os.remove("/data/.w")' \
        || fail "perms ($when): server sandbox cannot run or write /data"
    for target in /app/x /x /etc/x; do
        ! ct nsenter -t "$pid" -m -r -w -S "$(ct id -u $app)" -G "$(ct id -g $app)" \
            /usr/local/bin/python -c "open('$target', 'w')" 2>/dev/null || fail "perms ($when): $target writable"
    done
    pid=$(ct systemctl show -p MainPID --value "$app-web")
    ct nsenter -t "$pid" -m -r -w -S "$(ct id -u $app)" -G "$(ct id -g $app)" \
        /usr/local/bin/node -e 'require("fs").accessSync("/app/apps/web/server.js", require("fs").constants.R_OK)' \
        || fail "perms ($when): web sandbox cannot run node or read server.js"
    pass "perms ($when)"
}

#=== F6: data witness on disk =================================================
media_list() { ct sh -c "cd $data_dir/media && find . -type f -exec sha256sum {} + | sort"; }
settings_hash() { ct sh -c "yunohost app setting $app owner_password; yunohost app setting $app registration_token" | sha256sum; }
check_data() {
    witness verify || fail "witness ($1)"
    state_markers
    # Every chunk file from the witness is still there, unchanged (later writes may add more).
    [ -z "$(comm -23 <(echo "$MEDIA") <(media_list))" ] || fail "media files ($1)"
    [ "$(settings_hash)" = "$SETTINGS" ] || fail "installation secrets ($1)"
    pass "data intact ($1)"
}

#=== Private install ==========================================================
group "private install"
install_app all_users
check_perms "private install"
probe boundary --mode private
purge_app

#=== Public install, witness, token, WebSocket ===============================
group "public install"
install_app visitors
check_perms "public install"
probe boundary --mode public
witness create
state_markers
MEDIA=$(media_list); SETTINGS=$(settings_hash)
[ -n "$MEDIA" ] || fail "witness: no chunk files under media"
pass "witness wrote chunk files"
probe token --state "$STATE"
probe ws-server
port=$(ct yunohost app setting "$app" port_server)
ct systemctl stop "$app-server"
ct sh -c "nohup python3 /root/yunohost-candidate-ws-responder.py $port >/dev/null 2>&1 & echo \$! > /root/ws.pid"
sleep 1
probe ws-forward --port "$port"
ct sh -c 'kill "$(cat /root/ws.pid)"; rm -f /root/ws.pid'
ct systemctl start "$app-server"

#=== Upgrade =================================================================
group "upgrade"
push_pkg "$pkg" silentsuite_ynh
ct yunohost app upgrade "$app" -u /root/silentsuite_ynh --force >"$work/upgrade.log" 2>&1 \
    || { tail -40 "$work/upgrade.log"; fail "upgrade"; }
check_perms "upgrade"
check_data "upgrade"

#=== Failed upgrades after the swap, rollback ================================
# Two lanes: the replacement server tree is broken, or the replacement web tree is. A writer
# keeps syncing through each attempt; every write the server acknowledged must survive
# YunoHost's rollback. The server starts last in the upgrade, so with a broken web tree it
# must never have started before YunoHost began removing the app.
WINDOWS=""   # app-removal windows "start:end,..." from YunoHost's operation log
failed_upgrade() {
    local broken=$1 other copy="$work/broken-$1_ynh" common start end window acks stop writer
    [ "$broken" = server ] && other=web || other=server
    group "failed upgrade (broken $broken tree)"
    cp -r "$pkg" "$copy"
    common="$copy/scripts/_common.sh"
    local other_repo other_digest bin
    other_repo=$(sed -n "s/^${other}_repo=\"\(.*\)\"$/\1/p" "$common")
    other_digest=$(sed -n "s/^${other}_digest_amd64=\"\(.*\)\"$/\1/p" "$common")
    [ "$broken" = server ] && bin=python || bin=node
    sed -i -e "s|^${broken}_repo=.*|${broken}_repo=\"$other_repo\"|" \
        -e "s|^${broken}_digest_amd64=.*|${broken}_digest_amd64=\"$other_digest\"|" \
        -e "/${broken}\/usr\/local\/bin\/${bin}\" ] || ynh_die/d" "$common"
    grep -q "^${broken}_repo=\"$other_repo\"$" "$common" || fail "failed upgrade ($broken): test copy not built"
    push_pkg "$copy" "broken-${broken}_ynh"
    acks="$work/acks-$broken"; stop="$work/stop-writer-$broken"
    node "$repo/scripts/yunohost-candidate-witness.mjs" write-loop --state "$STATE" "$acks" "$stop" &
    writer=$!
    sleep 5
    start=$(ct date -u +%s)
    if ct yunohost app upgrade "$app" -u "/root/broken-${broken}_ynh" --force >"$work/failed-upgrade-$broken.log" 2>&1; then
        fail "failed upgrade ($broken): upgrade unexpectedly succeeded"
    fi
    end=$(ct date -u +%s)
    sleep 10
    touch "$stop"
    wait "$writer" || fail "failed upgrade ($broken): write loop"
    grep -q "silentsuite: image trees swapped" "$work/failed-upgrade-$broken.log" || fail "failed upgrade ($broken): swap marker missing"
    pass "failed upgrade ($broken): swap completed"
    ct journalctl -u "$app-$broken" --since "@$start" --until "@$end" -o cat | grep -q "status=203/EXEC" \
        || fail "failed upgrade ($broken): no 203/EXEC from the swapped $broken tree"
    pass "failed upgrade ($broken): replacement $broken failed to start (203/EXEC)"
    sudo incus file push "$work/failed-upgrade-$broken.log" "ynh/root/failed-upgrade-$broken.log" >/dev/null
    window=$(ct python3 /root/yunohost-candidate-rollback-evidence.py "/root/failed-upgrade-$broken.log" "$start" "$end" \
        | tee /dev/stderr | sed -n 's/^WINDOW \([0-9]*\) \([0-9]*\)$/\1:\2/p')
    [ -n "$window" ] || fail "failed upgrade ($broken): no app-removal window in the operation log"
    WINDOWS="${WINDOWS:+$WINDOWS,}$window"
    if [ "$broken" = web ]; then
        ! ct journalctl -u "$app-server" --since "@$start" --until "@${window%%:*}" -o cat | grep -q "Started $app-server" \
            || fail "failed upgrade (web): the replacement server started before the rollback"
        pass "failed upgrade (web): the replacement server never started"
    fi
    ct test -x "$install_dir/server/usr/local/bin/python" || fail "rollback ($broken): original server tree not back"
    ct test -x "$install_dir/web/usr/local/bin/node" || fail "rollback ($broken): original web tree not back"
    curl -fsS -o /dev/null --cacert "$CA_FILE" "https://$DOMAIN/api/v1/authentication/is_etebase/" || fail "rollback ($broken): server not ready"
    curl -fsS -o /dev/null --cacert "$CA_FILE" "https://$DOMAIN/signup" || fail "rollback ($broken): web not ready"
    check_perms "rollback ($broken)"
    check_data "rollback ($broken)"
    node "$repo/scripts/yunohost-candidate-witness.mjs" verify-acks --state "$STATE" "$acks" \
        || fail "rollback ($broken): an acknowledged write was lost"
}
failed_upgrade server
failed_upgrade web

#=== Backup, purge, restore ==================================================
group "backup and restore"
ct yunohost backup create --apps "$app" --name ci-full >/dev/null 2>&1 || fail "backup create"
purge_app
ct yunohost backup restore ci-full --apps "$app" --force >"$work/restore.log" 2>&1 \
    || { tail -40 "$work/restore.log"; fail "restore"; }
check_perms "restore"
check_data "restore"

#=== F3: no secrets in output or logs ========================================
group "log markers"
# A marked upstream error: the server is down and the request path carries a collection UID.
uid=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["collectionUid"])' "$STATE")
ct systemctl stop "$app-server"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA_FILE" "https://$DOMAIN/api/v1/collection/$uid/item/" || true)
[ "$code" = 502 ] || fail "log markers: marked request got $code, not the package's 502"
ct systemctl start "$app-server"
# Every auth token the witness obtained, from every login.
while read -r token; do add_marker auth-token "$token"; done <"$STATE.tokens"
sudo incus file push "$MARKERS" ynh/root/markers >/dev/null
# Kind and file only; request IDs in nginx lines from the app-removal windows are reported apart.
ct python3 /root/yunohost-candidate-log-scan.py /root/markers "$WINDOWS" \
    || { ct rm -f /root/markers; fail "log markers: secrets or identifiers in container logs"; }
ct rm -f /root/markers
grep -v '^control-' "$MARKERS" | cut -f2 >"$work/own-markers"
hits=$({ grep -lF -f "$work/own-markers" "$work"/*.log || true; } | wc -l)
[ "$hits" = 0 ] || fail "log markers: $hits installer output file(s) contain a secret or identifier"
pass "installation secrets of both installs, every auth token the witness obtained and the witness IDs appear in no installer output, /var/log/yunohost, nginx log or journal (except YunoHost's own db_pwd trace, and request IDs in nginx lines while YunoHost had the app removed)"

group "remove"
purge_app
echo "::endgroup::"
echo "PASS yunohost end-to-end"
