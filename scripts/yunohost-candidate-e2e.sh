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
for f in yunohost-candidate-ws-responder.py yunohost-candidate-rollback-evidence.py; do
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
}

purge_app() {
    ct yunohost app remove "$app" --purge >/dev/null 2>&1 || fail "remove --purge"
    ct test ! -e "$install_dir" || fail "purge: install dir left"
    ct test ! -e "$data_dir" || fail "purge: data dir left"
    [ -z "$(ct sudo -u postgres psql -tAc "select 1 from pg_database where datname='$app'")" ] || fail "purge: database left"
    pass "remove --purge leaves nothing"
}

#=== F1: owners, modes and sandboxes ==========================================
check_perms() {
    local when=$1 pid
    ct sh -euc '
        d='"$install_dir"'
        [ "$(stat -c %U:%G:%a "$d")" = root:root:755 ]
        [ "$(stat -c %U:%G:%a "$d/server.env")" = root:root:600 ]
        [ "$(stat -c %U:%G:%a "$d/etebase-server.ini")" = root:'"$app"':640 ]
        [ -z "$(find "$d/server" "$d/web" \( ! -uid 0 -o ! -gid 0 -o -perm /6000 \) -print -quit)" ]
        [ -z "$(find "$d/server" "$d/web" -type f ! -perm 0644 ! -perm 0755 -print -quit)" ]
        [ -z "$(find "$d/server" "$d/web" -type d ! -perm 0755 -print -quit)" ]
        [ ! -e "$d/server.old" ] && [ ! -e "$d/web.old" ]
        [ "$(systemctl show -p User --value '"$app"'-server)" = '"$app"' ]
        [ "$(systemctl show -p User --value '"$app"'-web)" = '"$app"' ]
        ! sudo -u '"$app"' cat "$d/server.env" >/dev/null 2>&1
        ! sudo -u '"$app"' touch "$d/server/x" 2>/dev/null
        ! sudo -u '"$app"' touch "$d/x" 2>/dev/null
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
    [ "$(media_list)" = "$MEDIA" ] || fail "media files ($1)"
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

#=== Failed upgrade after the swap, rollback =================================
group "failed upgrade"
cp -r "$pkg" "$work/broken_ynh"
common="$work/broken_ynh/scripts/_common.sh"
web_ref=$(sed -n 's/^web_digest_amd64="\(.*\)"$/\1/p' "$common")
sed -i -e 's|^server_repo=.*|server_repo="ghcr.io/silent-suite/silentsuite-web-selfhost"|' \
    -e "s|^server_digest_amd64=.*|server_digest_amd64=\"$web_ref\"|" \
    -e '/server\/usr\/local\/bin\/python" ] || ynh_die/d' "$common"
grep -q 'silentsuite-web-selfhost"$' <(grep '^server_repo=' "$common") || fail "failed upgrade: test copy not built"
push_pkg "$work/broken_ynh" broken_ynh
start=$(ct date -u +%s)
if ct yunohost app upgrade "$app" -u /root/broken_ynh --force >"$work/failed-upgrade.log" 2>&1; then
    fail "failed upgrade: upgrade unexpectedly succeeded"
fi
end=$(ct date -u +%s)
grep -q "silentsuite: image trees swapped" "$work/failed-upgrade.log" || fail "failed upgrade: swap marker missing"
pass "failed upgrade: swap completed"
ct journalctl -u "$app-server" --since "@$start" --until "@$end" -o cat | grep -q "status=203/EXEC" \
    || fail "failed upgrade: no 203/EXEC from the swapped server tree"
pass "failed upgrade: replacement server failed to start (203/EXEC)"
sudo incus file push "$work/failed-upgrade.log" ynh/root/failed-upgrade.log
ct python3 /root/yunohost-candidate-rollback-evidence.py /root/failed-upgrade.log "$start" "$end"
ct test -x "$install_dir/server/usr/local/bin/python" || fail "rollback: original server tree not back"
curl -fsS -o /dev/null --cacert "$CA_FILE" "https://$DOMAIN/api/v1/authentication/is_etebase/" || fail "rollback: server not ready"
curl -fsS -o /dev/null --cacert "$CA_FILE" "https://$DOMAIN/signup" || fail "rollback: web not ready"
check_perms "rollback"
check_data "rollback"

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
ct systemctl stop "$app-web"
curl -s -o /dev/null --cacert "$CA_FILE" "https://$DOMAIN/calendar" || true   # nginx upstream error
ct systemctl start "$app-web"
python3 - "$STATE" >"$work/markers" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print(s["authToken"]); print(s["collectionUid"]); print(s["itemUid"])
PY
ct yunohost app setting "$app" owner_password >>"$work/markers"
ct yunohost app setting "$app" registration_token >>"$work/markers"
# Control: the database password YunoHost itself generates for every app.
ct yunohost app setting "$app" db_pwd >>"$work/markers"
sudo incus file push "$work/markers" ynh/root/markers >/dev/null
# Report which file and which kind of value matched, never the value itself.
hits=$(ct sh -c '
    journalctl -o cat > /root/journal.txt
    n=0; kind=1
    for k in auth-token collection-uid item-uid owner-password registration-token control-db-pwd; do
        m=$(sed -n "${kind}p" /root/markers)
        for f in $(grep -rlF -e "$m" /var/log/yunohost /var/log/nginx /root/journal.txt 2>/dev/null); do
            echo "HIT $k in $f" >&2
            grep -F -e "$m" "$f" | head -3 | python3 -c "import sys; m=sys.argv[1]; [print(\"  line:\", l.replace(m, \"<redacted>\")[:220].rstrip(), file=sys.stderr) for l in sys.stdin]" "$m"
            [ "$k" = control-db-pwd ] || n=$((n + 1))
        done
        kind=$((kind + 1))
    done
    rm -f /root/markers /root/journal.txt
    echo "$n"')
[ "$hits" = 0 ] || fail "log markers: $hits match(es) in container logs"
hits=$(grep -lF -f "$work/markers" "$work"/*.log | wc -l)
[ "$hits" = 0 ] || fail "log markers: $hits installer output file(s) contain a secret or identifier"
pass "no secrets or identifiers in installer output, operation logs, nginx logs or the journal"

group "remove"
purge_app
echo "::endgroup::"
echo "PASS yunohost end-to-end"
