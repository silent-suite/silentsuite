#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Libre Workspace setup script for the SilentSuite add-on.
#
# The portal runs this as root with DOMAIN, ADMIN_PASSWORD, IP, LDAP_DC and
# LANGUAGE_CODE in the environment. It installs the SilentSuite sync server and
# its PostgreSQL database with the packaged copy of the standard self-host
# installer, pinned to the release this package was built for, and publishes it
# at https://silentsuite.$DOMAIN through the Libre Workspace Caddy.
#
# It never uses ADMIN_PASSWORD. SilentSuite accounts are independent of Libre
# Workspace users, and the first account is created by the operator with a
# one-time token that stays in a root-only file (see README.md).
#
# It refuses to run over anything it did not create: an existing marker
# directory, an existing SilentSuite stack or its data volumes, a busy port, or
# a Caddyfile that already serves the host. Every such check happens before the
# first change.

set -euo pipefail
umask 077

# The portal password is never needed here; keep it away from every child.
unset ADMIN_PASSWORD

MODULE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=silentsuite-addon-lib.sh
. "$MODULE_DIR/silentsuite-addon-lib.sh"

ss_require_root

DOMAIN="${DOMAIN:-}"
if ! ss_valid_domain "$DOMAIN"; then
  ss_fail "DOMAIN is missing or is not a lower-case DNS name; nothing was changed."
fi
HOST="$SS_ADDON_ID.$DOMAIN"
RELEASE="$(ss_read_release "$MODULE_DIR")"
INSTALLER="$MODULE_DIR/install.sh"
[ -f "$INSTALLER" ] || ss_fail "the package is missing its installer; nothing was changed."

for command in docker caddy systemctl ss openssl curl tar; do
  command -v "$command" >/dev/null 2>&1 || ss_fail "'$command' is not available; nothing was changed."
done
docker compose version >/dev/null 2>&1 || ss_fail "'docker compose' is not available; nothing was changed."
# Every presence check below asks the daemon. An unreachable daemon must stop
# setup here rather than read as "nothing exists".
docker info >/dev/null 2>&1 || ss_fail "the Docker daemon is not reachable; nothing was changed."

# ── Refuse anything that is not a clean first install ──────────────────

if [ -e "$SS_MARKER_DIR" ] || [ -L "$SS_MARKER_DIR" ]; then
  ss_fail "$SS_MARKER_DIR already exists. The add-on is installed, or an earlier attempt left it behind. Reinstalling over it is not supported; nothing was changed."
fi
existing="$(ss_existing_containers)" || ss_fail "could not list Docker containers; nothing was changed."
if [ -n "$existing" ]; then
  ss_fail "container(s) $(printf '%s ' $existing)already exist (another SilentSuite installation?). Nothing was changed."
fi
existing="$(ss_existing_volumes)" || ss_fail "could not list Docker volumes; nothing was changed."
if [ -n "$existing" ]; then
  ss_fail "Docker volume(s) $(printf '%s ' $existing)already exist; they hold data from an earlier installation. Restore or delete them first (see README.md). Nothing was changed."
fi
listeners="$(ss -Hltn "sport = :$SS_SERVER_PORT")" ||
  ss_fail "could not check whether TCP port $SS_SERVER_PORT is free; nothing was changed."
if [ -n "$listeners" ]; then
  ss_fail "TCP port $SS_SERVER_PORT is already in use; nothing was changed."
fi
[ -f "$SS_CADDYFILE" ] || ss_fail "$SS_CADDYFILE does not exist; nothing was changed."
ss_caddy_assert_absent "$HOST"

INTERNAL_TLS="$(ss_internal_tls_for_host "$HOST")"

# ── Rollback ───────────────────────────────────────────────────────────

CANDIDATE="$(ss_caddy_candidate_path)"
CADDY_BACKUP=""
CLAIMED=0
CADDY_SWAPPED=0
DONE=0

rollback() {
  local rc=$? retired leftover
  rm -f -- "$CANDIDATE"
  [ "$DONE" = "1" ] && return 0
  if [ "$CADDY_SWAPPED" = "1" ] && [ -n "$CADDY_BACKUP" ] && [ -f "$CADDY_BACKUP" ]; then
    cat -- "$CADDY_BACKUP" > "$SS_CADDYFILE"
    ss_caddy_reload || ss_warn "Caddy did not reload after its configuration was restored; check 'systemctl status caddy'."
    ss_warn "restored the previous $SS_CADDYFILE."
  fi
  if [ "$CLAIMED" = "1" ]; then
    if [ -d "$SS_INSTALL_DIR" ]; then
      if [ -f "$SS_INSTALL_DIR/docker-compose.yml" ]; then
        ss_compose down >&2 || ss_warn "'docker compose down' failed for the partial installation."
      fi
      leftover="$(ss_existing_containers)" || leftover="(Docker did not answer, so their state is unknown)"
      if [ -n "$leftover" ]; then
        # Retiring the marker now would make the portal report "not installed"
        # while containers are still there.
        ss_warn "setup failed and these SilentSuite containers are still present: $(printf '%s ' $leftover)"
        ss_warn "$SS_MARKER_DIR was kept, so the portal still lists the add-on as installed. Remove the add-on from the portal (or run 'docker compose down' in $SS_INSTALL_DIR) before retrying."
      else
        retired="$(ss_retire_marker failed)" || retired=""
        ss_warn "setup failed after the server was created. Its containers were removed; its files were kept in ${retired:-$SS_MARKER_DIR} and its Docker volumes ($SS_VOLUMES) were kept. See README.md before retrying."
      fi
    else
      rm -rf -- "$SS_MARKER_DIR"
    fi
  fi
  exit "$rc"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validate the Caddy change before anything is installed, so an unusable
# Caddyfile fails here with nothing to undo.
ss_caddy_render_with_block "$HOST" "$INTERNAL_TLS" > "$CANDIDATE"
ss_caddy_validate "$CANDIDATE" || ss_fail "Caddy rejected the configuration with the SilentSuite site added; nothing was changed."

# ── Install ────────────────────────────────────────────────────────────

# A single mkdir is the claim: it fails if anything appeared in the meantime.
mkdir -m 700 -- "$SS_MARKER_DIR" || ss_fail "could not create $SS_MARKER_DIR."
CLAIMED=1
{
  printf 'release=%s\n' "$RELEASE"
  printf 'host=%s\n' "$HOST"
  printf 'install_dir=%s\n' "$SS_INSTALL_DIR"
} > "$SS_STATE_FILE"

ss_log "installing SilentSuite $RELEASE for https://$HOST"
ss_log "the installer verifies the release, its source commit, the bundle checksum and the pinned image digests."
# The installer's standard output includes the one-time bootstrap token, and
# the portal keeps task output, so only its error stream is passed through.
if ! SILENTSUITE_DIR="$SS_INSTALL_DIR" \
  SILENTSUITE_DOMAIN="$HOST" \
  SILENTSUITE_PROXY_NETWORK="" \
  bash "$INSTALLER" --version "$RELEASE" </dev/null >/dev/null; then
  ss_fail "the SilentSuite installer failed (see the messages above)."
fi

# The installer copies the bundle files under this script's umask 077, so the
# public landing template ends up 0600 root. Compose bind-mounts it into the
# server, which runs as a non-root user and renders it at "/"; unreadable, every
# request to the site root is a 500. Open up only this non-secret template.
# .env, the marker and the other root-only files keep their modes; the server
# config is already made 0644 by the installer itself.
SUCCESS_PAGE="$SS_INSTALL_DIR/success.html"
if [ -L "$SUCCESS_PAGE" ] || [ ! -f "$SUCCESS_PAGE" ]; then
  ss_fail "the installer did not create success.html as a regular file."
fi
chmod 0644 -- "$SUCCESS_PAGE"

SERVER_IMAGE="$(grep -E '^SILENTSUITE_SERVER_IMAGE=' "$SS_INSTALL_DIR/.env" 2>/dev/null | head -n 1 | cut -d= -f2-)" || SERVER_IMAGE=""
printf '%s' "$SERVER_IMAGE" | grep -Eqx 'ghcr\.io/silent-suite/silentsuite-server@sha256:[0-9a-f]{64}' ||
  ss_fail "the installer did not record a digest-pinned server image."
ss_log "server image: $SERVER_IMAGE"

HEALTH_TIMEOUT="${SILENTSUITE_ADDON_HEALTH_TIMEOUT:-180}"
wait_healthy() {
  local elapsed=0 healthy container status
  while :; do
    healthy=0
    for container in $SS_CONTAINERS; do
      status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)"
      if [ "$status" = "healthy" ]; then
        healthy=$((healthy + 1))
      fi
    done
    if [ "$healthy" -eq 2 ]; then
      return 0
    fi
    if [ "$elapsed" -ge "$HEALTH_TIMEOUT" ]; then
      ss_fail "the SilentSuite containers did not become healthy within ${HEALTH_TIMEOUT}s$1."
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
}
wait_healthy ""
ss_log "database and server are healthy."

# ── Trust the host-side proxy peer ─────────────────────────────────────
#
# Caddy runs on the host and reaches the loopback-published port through
# Docker's port publishing, so the server sees those connections coming from
# the gateway of its Compose network, not from 127.0.0.1. Unless that one
# address is trusted, the server ignores Caddy's X-Forwarded-Proto and
# redirects every HTTPS request back to itself. Trust exactly that gateway
# (plus loopback), the way the self-host installer tells operators to trust a
# proxy that is not on 127.0.0.1, and recreate only the server container.
networks="$(docker inspect --format '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.Gateway}}{{"\n"}}{{end}}' silentsuite-server)" ||
  ss_fail "could not read the server container's network."
networks="$(printf '%s\n' "$networks" | sed '/^[[:space:]]*$/d')"
if [ -z "$networks" ] || [ "$(printf '%s\n' "$networks" | wc -l | tr -d ' ')" != "1" ]; then
  ss_fail "the server container is not attached to exactly one network; refusing to guess which proxy address to trust."
fi
GATEWAY="${networks##* }"
ss_valid_ipv4 "$GATEWAY" || ss_fail "the server's network has no usable IPv4 gateway to trust as the proxy."
if [ "$(grep -c '^TRUSTED_PROXY_IPS=' "$SS_INSTALL_DIR/.env" | tr -d ' ')" != "1" ] ||
  ! grep -qx 'TRUSTED_PROXY_IPS=127\.0\.0\.1' "$SS_INSTALL_DIR/.env"; then
  ss_fail "the installer wrote an unexpected TRUSTED_PROXY_IPS setting; refusing to change it."
fi
# Only this one line is rewritten; nothing from .env is printed.
sed -i "s/^TRUSTED_PROXY_IPS=127\\.0\\.0\\.1\$/TRUSTED_PROXY_IPS=127.0.0.1,$GATEWAY/" "$SS_INSTALL_DIR/.env"
grep -qxF "TRUSTED_PROXY_IPS=127.0.0.1,$GATEWAY" "$SS_INSTALL_DIR/.env" ||
  ss_fail "could not record the trusted proxy address."
printf 'trusted_proxy=%s\n' "$GATEWAY" >> "$SS_STATE_FILE"
ss_log "trusting forwarded HTTPS headers only from 127.0.0.1 and the Compose network gateway $GATEWAY."
ss_compose up -d --force-recreate --no-deps server >&2 ||
  ss_fail "could not recreate the server with the proxy setting."
wait_healthy " after the proxy setting was applied"
ss_log "server is healthy with the proxy setting."

# ── Publish through Caddy ──────────────────────────────────────────────

# Re-render from the current file: something else may have changed it while
# the release was being installed.
ss_caddy_assert_absent "$HOST"
ss_caddy_render_with_block "$HOST" "$INTERNAL_TLS" > "$CANDIDATE"
ss_caddy_validate "$CANDIDATE" || ss_fail "Caddy rejected the configuration with the SilentSuite site added."
CADDY_BACKUP="$SS_MARKER_DIR/Caddyfile.before-silentsuite"
cp -p -- "$SS_CADDYFILE" "$CADDY_BACKUP"
# Rewrite in place so the file keeps its owner and mode.
cat -- "$CANDIDATE" > "$SS_CADDYFILE"
CADDY_SWAPPED=1
ss_caddy_reload || ss_fail "Caddy failed to reload with the SilentSuite site."
ss_log "Caddy now serves https://$HOST"

cat > "$SS_MARKER_DIR/FIRST-ACCOUNT.txt" <<EOF
SilentSuite $RELEASE on https://$HOST

SilentSuite accounts are separate from Libre Workspace users. There is no
single sign-on, and the Libre Workspace administrator password is not used.

Create the first account now. Until it exists, a signup is only accepted
together with the one-time token stored in a root-only file:

  1. As root on this server, read the token:
       grep '^ETEBASE_BOOTSTRAP_ADMIN_TOKEN=' $SS_INSTALL_DIR/.env
  2. Open https://app.silentsuite.io, choose sign up, expand
     "Advanced Settings" and enter this server URL, with the token appended:
       https://$HOST/?bootstrap_token=<token>
  3. Create your account.
  4. Close public registration straight away:
       cd $SS_INSTALL_DIR && ./close-signups.sh

Do not paste the token into chat, tickets or email.

Updates are manual. The Libre Workspace update button and nightly updates do
not change the installed SilentSuite version. Read README.md of the add-on
before upgrading.
EOF
chmod 600 "$SS_MARKER_DIR/FIRST-ACCOUNT.txt"

DONE=1
ss_log "installed. SilentSuite is available at https://$HOST"
ss_log "next: create the first account and close registration. Instructions (no secrets): $SS_MARKER_DIR/FIRST-ACCOUNT.txt"
ss_log "the one-time signup token is stored only in $SS_INSTALL_DIR/.env (root only) and is not printed here."
