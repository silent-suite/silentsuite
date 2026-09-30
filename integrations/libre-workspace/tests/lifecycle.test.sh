#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Lifecycle tests for the Libre Workspace add-on. They run the real setup,
# update, remove and build scripts inside isolated fixtures: docker, caddy,
# systemctl, id, ss and sleep are stubs on PATH, and the packaged installer is
# replaced by a stub that behaves like install.sh at its interface (it creates
# the install directory and prints the one-time token to stdout). Nothing here
# touches Docker, Caddy, the network or the host's /root and /etc.
#
# This is not runtime validation: it proves the scripts' own decisions, not
# that a real Libre Workspace server accepts them.

set -uo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ADDON="$(cd -- "$HERE/.." && pwd -P)"
REPO_ROOT="$(cd -- "$ADDON/../.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/silentsuite-lw-addon-test.XXXXXXXX")"
trap 'rm -rf -- "$WORK"' EXIT

TOKEN="bootstrap-SECRET-token-7f3a"
DB_SECRET="database-SECRET-pass-91c2"
PORTAL_SECRET="portal-ADMIN-secret-55d1"
IMAGE="ghcr.io/silent-suite/silentsuite-server@sha256:$(printf '%064d' 0 | tr 0 a)"

FAILED=0
CASES=0
CASE_FAILED=0
CURRENT=""
F=""
RC=0

begin() {
  CURRENT="$1"
  CASE_FAILED=0
  CASES=$((CASES + 1))
}
finish() {
  if [ "$CASE_FAILED" -eq 0 ]; then
    printf 'ok   %s\n' "$CURRENT"
  else
    printf 'FAIL %s\n' "$CURRENT"
    sed 's/^/     | /' "$F/out" 2>/dev/null | head -n 20
  fi
}
check() {
  local description="$1"
  shift
  if ! "$@"; then
    printf '     - %s\n' "$description"
    CASE_FAILED=1
    FAILED=$((FAILED + 1))
  fi
}

rc_zero() { [ "$RC" -eq 0 ]; }
rc_nonzero() { [ "$RC" -ne 0 ]; }
absent() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
present() { [ -e "$1" ]; }
same() { cmp -s -- "$1" "$2"; }
contains() { grep -qF -- "$2" "$1"; }
lacks() { ! grep -qF -- "$2" "$1" 2>/dev/null; }
mode_is() { [ "$(stat -c %a -- "$1")" = "$2" ]; }
one_match() { [ "$(compgen -G "$1" | wc -l)" -eq 1 ]; }
no_match() { [ "$(compgen -G "$1" | wc -l)" -eq 0 ]; }
no_secrets_in_output() { lacks "$F/out" "$TOKEN" && lacks "$F/out" "$DB_SECRET" && lacks "$F/out" "$PORTAL_SECRET"; }
portal_secret_unused() {
  ! grep -rqF -- "$PORTAL_SECRET" "$F/root" "$F/etc" "$F/state" "$F/out"
}
no_volume_deletion() {
  ! grep -Eq -- '(--volumes|(^| )-v( |$)|volume rm|volume prune|system prune)' "$F/state/docker.log" 2>/dev/null
}
installer_not_run() { absent "$F/state/installer-args"; }
caddy_untouched() { same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.orig"; }
caddy_dir_clean() { [ "$(ls -A "$F/etc/caddy")" = "Caddyfile" ]; }

stub() {
  cat > "$F/bin/$1"
  chmod +x "$F/bin/$1"
}

new_fixture() {
  F="$WORK/$1"
  mkdir -p "$F/bin" "$F/root" "$F/etc/caddy" "$F/module" "$F/state"
  chmod 700 "$F/root"
  cp "$ADDON"/module/* "$F/module/"
  printf 'v9.9.9-test\n' > "$F/module/silentsuite-release"
  printf 'portal.example.org {\n    reverse_proxy localhost:8080\n}\n' > "$F/etc/caddy/Caddyfile"
  chmod 640 "$F/etc/caddy/Caddyfile"
  cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.orig"

  cat > "$F/module/install.sh" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" > "$STUB_STATE/installer-args"
env | grep -E '^(SILENTSUITE_[A-Z_]*|ADMIN_PASSWORD)=' | sort > "$STUB_STATE/installer-env" || true
if [ -e "$STUB_STATE/installer-fail-early" ]; then
  echo "ERROR: stub release verification failed" >&2
  exit 1
fi
mkdir -- "$SILENTSUITE_DIR"
# Compose up: the containers and their named volumes now exist.
touch "$STUB_STATE/container-silentsuite-postgres" "$STUB_STATE/container-silentsuite-server" \
  "$STUB_STATE/volume-silentsuite-server_pgdata" "$STUB_STATE/volume-silentsuite-server_server_data"
cat > "$SILENTSUITE_DIR/.env" <<ENV
SILENTSUITE_SERVER_IMAGE=$STUB_IMAGE
TRUSTED_PROXY_IPS=$(cat "$STUB_STATE/installer-trusted" 2>/dev/null || echo 127.0.0.1)
DATABASE_PASSWORD=$STUB_DB_SECRET
ETEBASE_BOOTSTRAP_ADMIN_TOKEN=$STUB_TOKEN
ENV
: > "$SILENTSUITE_DIR/docker-compose.yml"
# Like install.sh: cp under the inherited umask, so this public template lands
# with whatever mode the caller's umask gives it.
printf '<html>SilentSuite</html>\n' > "$SILENTSUITE_DIR/success.html"
printf '[global]\n' > "$SILENTSUITE_DIR/etebase-server.ini"
chmod 644 "$SILENTSUITE_DIR/etebase-server.ini"
echo "  https://$SILENTSUITE_DOMAIN/?bootstrap_token=$STUB_TOKEN"
echo "DATABASE_PASSWORD=$STUB_DB_SECRET"
if [ -e "$STUB_STATE/installer-fail-late" ]; then
  echo "ERROR: stub compose up failed" >&2
  exit 1
fi
EOF

  stub docker <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_STATE/docker.log"
list() {
  local file
  for file in "$STUB_STATE/$1-"*; do
    [ -e "$file" ] && printf '%s\n' "${file##*/$1-}"
  done
  return 0
}
[ -e "$STUB_STATE/docker-down" ] && [ "${1:-}" != compose ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
case "${1:-}" in
  info) exit 0 ;;
  compose)
    [ "${2:-}" = version ] && exit 0
    if [ "${*: -1}" = down ] && [ ! -e "$STUB_STATE/down-leaves-containers" ]; then
      rm -f "$STUB_STATE"/container-*
    fi
    exit "$(cat "$STUB_STATE/compose-rc" 2>/dev/null || echo 0)" ;;
  ps)
    [ -e "$STUB_STATE/ps-fail" ] && exit 1
    list container ;;
  volume)
    [ "${2:-}" = ls ] || exit 1
    list volume ;;
  inspect)
    case "$*" in
      *Networks*) cat "$STUB_STATE/networks" 2>/dev/null || echo "silentsuite-server_silentsuite 172.18.0.1" ;;
      *) cat "$STUB_STATE/health" 2>/dev/null || echo healthy ;;
    esac
    exit 0 ;;
esac
exit 0
EOF
  stub caddy <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_STATE/caddy.log"
if [ "${1:-}" = validate ] && [ -e "$STUB_STATE/caddy-invalid" ]; then
  echo "Error: adapting config using caddyfile: stub rejection" >&2
  exit 1
fi
exit 0
EOF
  stub systemctl <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_STATE/systemctl.log"
[ -e "$STUB_STATE/reload-fail" ] && exit 1
exit 0
EOF
  stub id <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -u ]; then cat "$STUB_STATE/uid" 2>/dev/null || echo 0; exit 0; fi
exec /usr/bin/id "$@"
EOF
  stub ss <<'EOF'
#!/usr/bin/env bash
[ -e "$STUB_STATE/ss-fail" ] && { echo "ss: netlink failure" >&2; exit 1; }
[ -e "$STUB_STATE/port-busy" ] && echo "LISTEN 0 4096 127.0.0.1:3735 0.0.0.0:*"
exit 0
EOF
  # mv onto the Caddyfile can be made to fail once, or to complete and then
  # deliver SIGTERM to the calling script (a portal task being killed).
  stub mv <<'EOF'
#!/usr/bin/env bash
if [ "$(basename -- "${@: -1}")" = Caddyfile ]; then
  if [ -e "$STUB_STATE/mv-fail" ]; then
    rm -f "$STUB_STATE/mv-fail"
    echo "mv: No space left on device" >&2
    exit 1
  fi
  if [ -e "$STUB_STATE/mv-term-after" ]; then
    rm -f "$STUB_STATE/mv-term-after"
    /usr/bin/mv "$@" || exit 1
    kill -TERM "$PPID"
    exit 0
  fi
fi
exec /usr/bin/mv "$@"
EOF
  stub sleep <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  stub openssl <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  stub curl <<'EOF'
#!/usr/bin/env bash
echo "curl must not be called by the add-on scripts" >&2
exit 97
EOF
}

# run <script> [DOMAIN] — as the portal does: cwd = module dir, env from
# libre-workspace.env.
run() {
  local script="$1" domain="${2-example.org}"
  (
    cd "$F/module" &&
      env -i PATH="$F/bin:/usr/bin:/bin" HOME="$F/root" \
        DOMAIN="$domain" ADMIN_PASSWORD="$PORTAL_SECRET" IP=192.0.2.10 \
        LDAP_DC="dc=example,dc=org" LANGUAGE_CODE=en \
        SILENTSUITE_ADDON_ROOT_BASE="$F/root" \
        SILENTSUITE_ADDON_CADDYFILE="$F/etc/caddy/Caddyfile" \
        SILENTSUITE_ADDON_HEALTH_TIMEOUT=10 \
        STUB_STATE="$F/state" STUB_TOKEN="$TOKEN" STUB_DB_SECRET="$DB_SECRET" STUB_IMAGE="$IMAGE" \
        bash "$script"
  ) > "$F/out" 2>&1
  RC=$?
}

refused_cleanly() {
  check "exits non-zero" rc_nonzero
  check "installer never ran" installer_not_run
  check "Caddyfile untouched" caddy_untouched
  check "no candidate files left beside the Caddyfile" caddy_dir_clean
  check "no secrets in output" no_secrets_in_output
}

# ── Syntax ──────────────────────────────────────────────────────────────

begin "all add-on scripts parse"
F="$WORK/syntax"
mkdir -p "$F"
: > "$F/out"
for script in "$ADDON"/module/*.sh "$ADDON/build-deb.sh" "$HERE/runtime-smoke.sh"; do
  check "bash -n $(basename "$script")" bash -n "$script"
done
finish

# ── Setup, update, remove: the happy path ──────────────────────────────

begin "setup installs, publishes through Caddy, and keeps secrets out of output"
new_fixture happy
run setup_silentsuite.sh
MARKER="$F/root/silentsuite"
INSTALL="$MARKER/silentsuite-server"
check "exits 0" rc_zero
check "marker directory exists" present "$MARKER"
check "marker directory is 0700" mode_is "$MARKER" 700
check "install directory exists" present "$INSTALL/.env"
check "state records the pinned release" contains "$MARKER/addon-state" "release=v9.9.9-test"
check "state records the host" contains "$MARKER/addon-state" "host=silentsuite.example.org"
check "installer got --version <pinned>" same "$F/state/installer-args" <(printf -- '--version\nv9.9.9-test\n')
check "installer got the subdomain" contains "$F/state/installer-env" "SILENTSUITE_DOMAIN=silentsuite.example.org"
check "installer got an empty proxy network" contains "$F/state/installer-env" "SILENTSUITE_PROXY_NETWORK="
check "installer got the install dir" contains "$F/state/installer-env" "SILENTSUITE_DIR=$INSTALL"
check "installer never sees ADMIN_PASSWORD" lacks "$F/state/installer-env" "ADMIN_PASSWORD"
check "ADMIN_PASSWORD value is written nowhere" portal_secret_unused
check "no secrets in output" no_secrets_in_output
check "original Caddyfile content is kept as the prefix" \
  same <(head -c "$(stat -c %s "$F/Caddyfile.orig")" "$F/etc/caddy/Caddyfile") "$F/Caddyfile.orig"
check "exactly one site for the host" [ "$(grep -cxF 'silentsuite.example.org {' "$F/etc/caddy/Caddyfile")" = 1 ]
check "proxies to the loopback server port" contains "$F/etc/caddy/Caddyfile" "    reverse_proxy 127.0.0.1:3735"
check "no internal TLS for a public domain" lacks "$F/etc/caddy/Caddyfile" "tls internal"
check "Caddy was reloaded" contains "$F/state/systemctl.log" "reload-or-restart caddy"
check "Caddyfile keeps its mode after replacement" mode_is "$F/etc/caddy/Caddyfile" 640
check "Caddyfile was validated" contains "$F/state/caddy.log" "validate --adapter caddyfile"
check "no candidate files left beside the Caddyfile" caddy_dir_clean
check "first-account instructions exist" present "$MARKER/FIRST-ACCOUNT.txt"
check "first-account instructions are 0600" mode_is "$MARKER/FIRST-ACCOUNT.txt" 600
check "first-account instructions carry no token" lacks "$MARKER/FIRST-ACCOUNT.txt" "$TOKEN"
check "first-account instructions show the token URL shape" contains "$MARKER/FIRST-ACCOUNT.txt" "https://silentsuite.example.org/?bootstrap_token=<token>"
check "output points at the instructions" contains "$F/out" "FIRST-ACCOUNT.txt"
check "trusts exactly loopback and the network gateway" contains "$INSTALL/.env" "TRUSTED_PROXY_IPS=127.0.0.1,172.18.0.1"
check "only one TRUSTED_PROXY_IPS line" [ "$(grep -c '^TRUSTED_PROXY_IPS=' "$INSTALL/.env")" = 1 ]
check "state records the trusted proxy" contains "$MARKER/addon-state" "trusted_proxy=172.18.0.1"
check "only the server container was recreated" grep -q '^compose .* up -d --force-recreate --no-deps server$' "$F/state/docker.log"
check ".env stays 0600 after the rewrite" mode_is "$INSTALL/.env" 600
check "success.html (mounted into the non-root server) is 0644" mode_is "$INSTALL/success.html" 644
check "success.html is a regular file, not a link" [ -f "$INSTALL/success.html" ] && [ ! -L "$INSTALL/success.html" ]
check "server config keeps the installer's 0644" mode_is "$INSTALL/etebase-server.ini" 644
check "marker stays 0700" mode_is "$MARKER" 700
check "addon-state is not world-readable" [ "$(( 0$(stat -c %a "$MARKER/addon-state") & 077 ))" = 0 ]
check "no volume deletion" no_volume_deletion
finish

begin "update is a no-op on an installed add-on"
DOCKER_LINES="$(wc -l < "$F/state/docker.log")"
SYSTEMCTL_LINES="$(wc -l < "$F/state/systemctl.log")"
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.installed"
cp "$INSTALL/.env" "$F/env.installed"
cp "$MARKER/addon-state" "$F/state.installed"
run update_silentsuite.sh
check "exits 0" rc_zero
check "says updates are manual" contains "$F/out" "automatic updates are disabled for SilentSuite v9.9.9-test"
check "docker was only inspected (read-only)" bash -c '[ -z "$(tail -n +$(( $2 + 1 )) "$1" | grep -v "^inspect ")" ]' _ "$F/state/docker.log" "$DOCKER_LINES"
check "confirms the trusted proxy address" contains "$F/out" "trusted proxy address 172.18.0.1 still matches"
check ".env unchanged by update" same "$INSTALL/.env" "$F/env.installed"
check "state unchanged by update" same "$MARKER/addon-state" "$F/state.installed"
check "no systemctl calls" [ "$(wc -l < "$F/state/systemctl.log")" = "$SYSTEMCTL_LINES" ]
check "Caddyfile unchanged" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.installed"
check "still installed" present "$MARKER"
finish

begin "remove drops only our site, stops the stack and keeps the data"
run remove_silentsuite.sh
check "exits 0" rc_zero
check "Caddyfile is byte-identical to before setup" caddy_untouched
check "Caddyfile keeps its mode after removal" mode_is "$F/etc/caddy/Caddyfile" 640
check "compose down was called" grep -q '^compose .* down$' "$F/state/docker.log"
check "no volume deletion" no_volume_deletion
check "marker directory is gone" absent "$MARKER"
check "configuration was retained aside" one_match "$F/root/silentsuite-removed-*/silentsuite-server/.env"
check "output says data was kept" contains "$F/out" "User data was NOT deleted"
check "no secrets in output" no_secrets_in_output
check "no candidate files left beside the Caddyfile" caddy_dir_clean
finish

begin "remove and update are no-ops when not installed"
run remove_silentsuite.sh
check "remove exits 0" rc_zero
check "remove says nothing to do" contains "$F/out" "not installed"
run update_silentsuite.sh
check "update exits 0" rc_zero
check "Caddyfile untouched" caddy_untouched
finish

begin "reinstall after remove is refused while the data volumes are kept"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "names the retained volume" contains "$F/out" "silentsuite-server_pgdata"
check "marker not recreated" absent "$F/root/silentsuite"
check "Caddyfile untouched" caddy_untouched
check "retained data still there" one_match "$F/root/silentsuite-removed-*/silentsuite-server/.env"
finish

begin "an unreachable Docker daemon is refused, not read as 'nothing exists'"
new_fixture dockerdown
touch "$F/state/docker-down"
run setup_silentsuite.sh
refused_cleanly
check "says the daemon is not reachable" contains "$F/out" "Docker daemon is not reachable"
check "marker never created" absent "$F/root/silentsuite"
finish

begin "a failing container listing is refused"
new_fixture psfail
touch "$F/state/ps-fail"
run setup_silentsuite.sh
refused_cleanly
check "says containers could not be listed" contains "$F/out" "could not list Docker containers"
check "marker never created" absent "$F/root/silentsuite"
finish

begin "a failing port check is refused, not read as 'port free'"
new_fixture ssfail
touch "$F/state/ss-fail"
run setup_silentsuite.sh
refused_cleanly
check "says the port could not be checked" contains "$F/out" "could not check whether TCP port 3735 is free"
check "marker never created" absent "$F/root/silentsuite"
finish

begin "int.de gets Caddy's internal TLS inside our block only"
new_fixture intde
run setup_silentsuite.sh int.de
check "exits 0" rc_zero
check "block uses tls internal" \
  same <(sed -n '/^# BEGIN silentsuite add-on/,/^# END silentsuite add-on/p' "$F/etc/caddy/Caddyfile") \
  <(printf '%s\n' "# BEGIN silentsuite add-on (managed by libre-workspace-module-silentsuite; do not edit)" \
    "silentsuite.int.de {" "    tls internal" "    reverse_proxy 127.0.0.1:3735" "}" "# END silentsuite add-on")
check "other sites unchanged" \
  same <(head -c "$(stat -c %s "$F/Caddyfile.orig")" "$F/etc/caddy/Caddyfile") "$F/Caddyfile.orig"
finish

# ── Setup refusals: nothing may change ─────────────────────────────────

begin "invalid DOMAIN values are refused before any change"
new_fixture domains
for domain in "" "Example.org" "localhost" "exa mple.org" "example.org;" "-bad.org" \
  "1.2.3.4" $'example.org\nevil.org' "a..b" "example.org{" "example.org/x" "*.example.org"; do
  run setup_silentsuite.sh "$domain"
  check "refuses '$domain'" rc_nonzero
  check "mentions DOMAIN for '$domain'" contains "$F/out" "DOMAIN"
done
check "installer never ran" installer_not_run
check "marker never created" absent "$F/root/silentsuite"
check "Caddyfile untouched" caddy_untouched
finish

begin "not root is refused"
new_fixture nonroot
echo 1000 > "$F/state/uid"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
finish

begin "reinstall over an existing marker is refused and leaves it alone"
new_fixture reinstall
mkdir -m 700 "$F/root/silentsuite"
echo keep > "$F/root/silentsuite/sentinel"
run setup_silentsuite.sh
refused_cleanly
check "existing marker content kept" contains "$F/root/silentsuite/sentinel" keep
finish

begin "an existing SilentSuite container is refused"
new_fixture container
touch "$F/state/container-silentsuite-server"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
finish

begin "a retained data volume is refused"
new_fixture volume
touch "$F/state/volume-silentsuite-server_pgdata"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
check "explains the volume" contains "$F/out" "silentsuite-server_pgdata"
finish

begin "a busy server port is refused"
new_fixture port
touch "$F/state/port-busy"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
finish

begin "a Caddyfile that already serves the host is refused"
new_fixture hostexists
printf 'silentsuite.example.org {\n    reverse_proxy localhost:9999\n}\n' >> "$F/etc/caddy/Caddyfile"
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.orig"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
finish

begin "a Caddy validation failure is refused before installing"
new_fixture caddyinvalid
touch "$F/state/caddy-invalid"
run setup_silentsuite.sh
refused_cleanly
check "marker never created" absent "$F/root/silentsuite"
check "Caddy was not reloaded" absent "$F/state/systemctl.log"
finish

# ── Setup failures after work started: roll back, keep data ────────────

begin "installer failure before it creates anything removes the marker"
new_fixture installerearly
touch "$F/state/installer-fail-early"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "marker removed" absent "$F/root/silentsuite"
check "no failed directory (nothing to keep)" no_match "$F/root/silentsuite-failed-*"
check "Caddyfile untouched" caddy_untouched
check "installer error is shown" contains "$F/out" "stub release verification failed"
check "no secrets in output" no_secrets_in_output
finish

begin "installer failure after creating the server stops it and keeps it aside"
new_fixture installerlate
touch "$F/state/installer-fail-late"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "marker gone (portal shows not installed)" absent "$F/root/silentsuite"
check "files kept in a failed directory" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "compose down was called" grep -q '^compose .* down$' "$F/state/docker.log"
check "no volume deletion" no_volume_deletion
check "Caddyfile untouched" caddy_untouched
check "installer stdout (with the token) was not passed through" no_secrets_in_output
finish

begin "unhealthy containers roll back without touching Caddy"
new_fixture unhealthy
echo unhealthy > "$F/state/health"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "says the containers were unhealthy" contains "$F/out" "did not become healthy"
check "marker gone" absent "$F/root/silentsuite"
check "files kept in a failed directory" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "compose down was called" grep -q '^compose .* down$' "$F/state/docker.log"
check "no volume deletion" no_volume_deletion
check "Caddyfile untouched" caddy_untouched
check "Caddy was not reloaded" absent "$F/state/systemctl.log"
check "no secrets in output" no_secrets_in_output
finish

begin "a Caddy reload failure restores the Caddyfile and rolls back"
new_fixture reloadfail
touch "$F/state/reload-fail"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "Caddyfile restored byte-for-byte" caddy_untouched
check "reload attempted, then retried after restore" [ "$(grep -c 'reload-or-restart caddy' "$F/state/systemctl.log")" = 2 ]
check "marker gone" absent "$F/root/silentsuite"
check "files kept in a failed directory" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
check "no candidate files left beside the Caddyfile" caddy_dir_clean
finish

begin "rollback keeps the marker when containers could not be removed"
new_fixture leftover
echo unhealthy > "$F/state/health"
touch "$F/state/down-leaves-containers"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "says containers are still present" contains "$F/out" "containers are still present"
check "marker kept so the portal still lists the add-on" present "$F/root/silentsuite/silentsuite-server/.env"
check "no failed directory" no_match "$F/root/silentsuite-failed-*"
check "Caddyfile untouched" caddy_untouched
check "no volume deletion" no_volume_deletion
check "no secrets in output" no_secrets_in_output
finish

proxy_refused() {
  check "exits non-zero" rc_nonzero
  check "marker gone" absent "$F/root/silentsuite"
  check "files kept in a failed directory" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
  check "compose down was called" grep -q '^compose .* down$' "$F/state/docker.log"
  check "server not recreated" lacks "$F/state/docker.log" "--force-recreate"
  check "Caddyfile untouched" caddy_untouched
  check "no volume deletion" no_volume_deletion
  check "no secrets in output" no_secrets_in_output
}

begin "a server on more than one network is refused (no guessing the proxy peer)"
new_fixture twonets
printf 'silentsuite-server_silentsuite 172.18.0.1\nproxy 172.19.0.1\n' > "$F/state/networks"
run setup_silentsuite.sh
proxy_refused
check "explains the refusal" contains "$F/out" "not attached to exactly one network"
finish

begin "a missing or non-IPv4 gateway is refused"
for gateway in "" "fe80::1" "0.0.0.0" "172.18.0.256" "172.18.0" "10.0.0.1/8"; do
  new_fixture "badgw-$(printf '%s' "$gateway" | tr -c 'a-z0-9' '_')"
  printf 'silentsuite-server_silentsuite %s\n' "$gateway" > "$F/state/networks"
  run setup_silentsuite.sh
  proxy_refused
done
check "explains the refusal" contains "$F/out" "no usable IPv4 gateway"
finish

begin "an unexpected installer TRUSTED_PROXY_IPS is not overwritten"
new_fixture customtrust
echo "10.0.0.0/8" > "$F/state/installer-trusted"
run setup_silentsuite.sh
proxy_refused
check "explains the refusal" contains "$F/out" "unexpected TRUSTED_PROXY_IPS"
check "setting left as written" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "value unchanged" grep -qx 'TRUSTED_PROXY_IPS=10.0.0.0/8' "$F"/root/silentsuite-failed-*/silentsuite-server/.env
finish

# ── Remove refusals ─────────────────────────────────────────────────────

begin "remove refuses an edited block, changing nothing"
new_fixture removeedited
run setup_silentsuite.sh
sed -i 's/^    reverse_proxy 127.0.0.1:3735$/    reverse_proxy 127.0.0.1:9999/' "$F/etc/caddy/Caddyfile"
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
: > "$F/state/docker.log"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "says the block is not ours" contains "$F/out" "not in the shape this add-on wrote"
check "Caddyfile unchanged" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "stack not stopped" lacks "$F/state/docker.log" " down"
check "still installed" present "$F/root/silentsuite/silentsuite-server/.env"
finish

begin "remove stops before Caddy when containers survive compose down"
new_fixture removeleftover
run setup_silentsuite.sh
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
touch "$F/state/down-leaves-containers"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "names the remaining containers" contains "$F/out" "still present"
check "Caddyfile unchanged" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "still installed" present "$F/root/silentsuite/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
finish

begin "remove refuses a block it did not write, changing nothing"
new_fixture removecorrupt
run setup_silentsuite.sh
echo "# BEGIN silentsuite add-on (managed by libre-workspace-module-silentsuite; do not edit)" >> "$F/etc/caddy/Caddyfile"
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
: > "$F/state/docker.log"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "Caddyfile unchanged" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "stack not stopped" lacks "$F/state/docker.log" " down"
check "still installed" present "$F/root/silentsuite/silentsuite-server/.env"
finish

begin "remove restores the Caddyfile when Caddy fails to reload"
new_fixture removereload
run setup_silentsuite.sh
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
touch "$F/state/reload-fail"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "Caddyfile restored" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "marker kept" present "$F/root/silentsuite/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
finish

# ── Caddyfile write path: failure and interruption ─────────────────────

begin "setup: a failed Caddyfile write leaves the live file intact and rolls back"
new_fixture setupmvfail
touch "$F/state/mv-fail"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "says the write failed" contains "$F/out" "could not write"
check "Caddyfile byte-identical" caddy_untouched
check "Caddyfile mode kept" mode_is "$F/etc/caddy/Caddyfile" 640
check "no staged or candidate files left" caddy_dir_clean
check "marker gone, files kept aside" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
finish

begin "setup: SIGTERM right after the Caddyfile is replaced restores it"
new_fixture setupterm
touch "$F/state/mv-term-after"
run setup_silentsuite.sh
check "exits 143" [ "$RC" -eq 143 ]
check "says it restored the Caddyfile" contains "$F/out" "restored the previous"
check "Caddyfile byte-identical" caddy_untouched
check "Caddyfile mode kept" mode_is "$F/etc/caddy/Caddyfile" 640
check "no staged or candidate files left" caddy_dir_clean
check "compose down was called" grep -q '^compose .* down$' "$F/state/docker.log"
check "marker gone, files kept aside" one_match "$F/root/silentsuite-failed-*/silentsuite-server/.env"
check "no secrets in output" no_secrets_in_output
finish

begin "remove: a failed Caddyfile write leaves the live file intact and the marker in place"
new_fixture removemvfail
run setup_silentsuite.sh
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
touch "$F/state/mv-fail"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "Caddyfile unchanged" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "Caddyfile mode kept" mode_is "$F/etc/caddy/Caddyfile" 640
check "no staged or candidate files left" caddy_dir_clean
check "marker kept" present "$F/root/silentsuite/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
finish

begin "remove: SIGTERM right after the Caddyfile is replaced restores it"
new_fixture removeterm
run setup_silentsuite.sh
cp "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
touch "$F/state/mv-term-after"
run remove_silentsuite.sh
check "exits 143" [ "$RC" -eq 143 ]
check "says it restored the Caddyfile" contains "$F/out" "restored the previous"
check "Caddyfile restored" same "$F/etc/caddy/Caddyfile" "$F/Caddyfile.before-remove"
check "Caddyfile mode kept" mode_is "$F/etc/caddy/Caddyfile" 640
check "no staged or candidate files left" caddy_dir_clean
check "marker kept" present "$F/root/silentsuite/silentsuite-server/.env"
check "no volume deletion" no_volume_deletion
finish

begin "a symlinked Caddyfile is refused, not replaced"
new_fixture symlink
mv "$F/etc/caddy/Caddyfile" "$F/Caddyfile.real"
ln -s "$F/Caddyfile.real" "$F/etc/caddy/Caddyfile"
run setup_silentsuite.sh
check "exits non-zero" rc_nonzero
check "says it is a symbolic link" contains "$F/out" "symbolic link"
check "still a symlink" [ -L "$F/etc/caddy/Caddyfile" ]
check "target unchanged" same "$F/Caddyfile.real" "$F/Caddyfile.orig"
check "installer never ran" installer_not_run
check "marker never created" absent "$F/root/silentsuite"
finish

begin "remove without addon-state refuses and points at the recovery steps"
new_fixture nostate
mkdir -m 700 "$F/root/silentsuite"
run remove_silentsuite.sh
check "exits non-zero" rc_nonzero
check "points at the README recovery section" contains "$F/out" "Recovering an interrupted setup"
check "marker left alone" present "$F/root/silentsuite"
check "Caddyfile untouched" caddy_untouched
finish

# ── Update: read-only trusted-proxy diagnostics ────────────────────────

begin "update warns on gateway drift without changing anything"
new_fixture drift
run setup_silentsuite.sh
cp "$F/root/silentsuite/silentsuite-server/.env" "$F/env.installed"
cp "$F/root/silentsuite/addon-state" "$F/state.installed"
: > "$F/state/docker.log"
: > "$F/state/systemctl.log"
echo "silentsuite-server_silentsuite 172.19.0.1" > "$F/state/networks"
run update_silentsuite.sh
check "exits 0" rc_zero
check "reports the new gateway" contains "$F/out" "gateway is now 172.19.0.1 but 172.18.0.1 is trusted"
check "points at the README" contains "$F/out" "Trusted proxy address"
check "only read-only docker inspect" [ -z "$(grep -v '^inspect ' "$F/state/docker.log")" ]
check "no systemctl calls" [ ! -s "$F/state/systemctl.log" ]
check ".env unchanged" same "$F/root/silentsuite/silentsuite-server/.env" "$F/env.installed"
check "state unchanged" same "$F/root/silentsuite/addon-state" "$F/state.installed"
finish

begin "update warns when the pin cannot be verified or is missing"
touch "$F/state/docker-down"
run update_silentsuite.sh
check "exits 0 with the daemon down" rc_zero
check "says it could not verify" contains "$F/out" "could not verify the trusted proxy address"
rm -f "$F/state/docker-down"
sed -i '/^trusted_proxy=/d' "$F/root/silentsuite/addon-state"
run update_silentsuite.sh
check "exits 0 without a pin" rc_zero
check "says no address is recorded" contains "$F/out" "no trusted proxy address is recorded"
finish

# ── Package build ───────────────────────────────────────────────────────

begin "build assembles the package tree (and .deb when dpkg-deb exists)"
F="$WORK/build"
mkdir -p "$F"
bash "$ADDON/build-deb.sh" --release v0.5.10-beta --out-dir "$F/new-parent/out" > "$F/out" 2>&1
RC=$?
check "creates a missing output parent" rc_zero
bash "$ADDON/build-deb.sh" --release v0.5.10-beta --out-dir "$F/out-dir" > "$F/out" 2>&1
RC=$?
if ! command -v dpkg-deb >/dev/null 2>&1; then
  rm -rf "$F/out-dir"
  bash "$ADDON/build-deb.sh" --release v0.5.10-beta --out-dir "$F/out-dir" --tree-only > "$F/out" 2>&1
  RC=$?
  echo "     (dpkg-deb unavailable: tree only)"
fi
TREE="$F/out-dir/libre-workspace-module-silentsuite_0.5.10~beta_all"
MOD="$TREE/usr/lib/libre-workspace/modules/silentsuite"
check "exits 0" rc_zero
for file in silentsuite.conf setup_silentsuite.sh update_silentsuite.sh remove_silentsuite.sh \
  silentsuite-addon-lib.sh install.sh silentsuite-release silentsuite.svg LICENSE README.md; do
  check "ships $file" present "$MOD/$file"
done
for script in setup_silentsuite.sh update_silentsuite.sh remove_silentsuite.sh install.sh; do
  check "$script is 0755" mode_is "$MOD/$script" 755
done
check "installer is the unchanged self-host installer" same "$MOD/install.sh" "$REPO_ROOT/self-host/install.sh"
check "LICENSE is the repository AGPL license" same "$MOD/LICENSE" "$REPO_ROOT/LICENSE"
check "icon is the brand logo" same "$MOD/silentsuite.svg" "$REPO_ROOT/apps/docs/public/logo.svg"
check "exactly one icon file" [ "$(find "$MOD" -maxdepth 1 \( -name '*.png' -o -name '*.svg' -o -name '*.jpg' -o -name '*.webp' \) | wc -l)" = 1 ]
check "release pin" same "$MOD/silentsuite-release" <(printf 'v0.5.10-beta\n')
check "conf: url is the subdomain only" contains "$MOD/silentsuite.conf" 'url="silentsuite"'
check "conf: iframe disabled" contains "$MOD/silentsuite.conf" 'disable_iframe="true"'
check "conf: id" contains "$MOD/silentsuite.conf" 'id="silentsuite"'
check "control: package name" contains "$TREE/DEBIAN/control" "Package: libre-workspace-module-silentsuite"
check "control: version" contains "$TREE/DEBIAN/control" "Version: 0.5.10~beta"
check "control: no unresolved version placeholder" lacks "$TREE/DEBIAN/control" "@VERSION@"
check "control: no unresolved release placeholder" lacks "$TREE/DEBIAN/control" "@RELEASE@"
check "control: names the pinned release" contains "$TREE/DEBIAN/control" "(v0.5.10-beta)"
check "no maintainer scripts (setup runs only from the portal)" [ "$(ls "$TREE/DEBIAN")" = "control" ]
if command -v dpkg-deb >/dev/null 2>&1; then
  DEB="$F/out-dir/libre-workspace-module-silentsuite_0.5.10~beta_all.deb"
  check ".deb built" present "$DEB"
  check ".deb package field" [ "$(dpkg-deb -f "$DEB" Package)" = "libre-workspace-module-silentsuite" ]
  check ".deb architecture all" [ "$(dpkg-deb -f "$DEB" Architecture)" = "all" ]
  dpkg-deb -c "$DEB" > "$F/contents"
  check ".deb installs the module directory" contains "$F/contents" "./usr/lib/libre-workspace/modules/silentsuite/setup_silentsuite.sh"
  check ".deb files are owned by root" [ "$(awk '{print $2}' "$F/contents" | sort -u)" = "root/root" ]
  check ".deb checksum sidecar verifies" bash -c 'cd "$1" && sha256sum -c --quiet "$2.sha256"' _ "$F/out-dir" "$(basename "$DEB")"
fi
finish

begin "build refuses a bad release or an existing output directory"
bash "$ADDON/build-deb.sh" --release latest --out-dir "$F/other" > "$F/out" 2>&1
RC=$?
check "refuses 'latest'" rc_nonzero
check "created nothing" absent "$F/other"
bash "$ADDON/build-deb.sh" --release v0.5.10-beta --out-dir "$F/out-dir" --tree-only > "$F/out" 2>&1
RC=$?
check "refuses an existing output directory" rc_nonzero
finish

echo
if [ "$FAILED" -eq 0 ]; then
  echo "All $CASES cases passed."
  exit 0
fi
echo "$FAILED assertion(s) failed across $CASES cases."
exit 1
