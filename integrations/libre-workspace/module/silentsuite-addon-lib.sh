# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Shared helpers for the SilentSuite Libre Workspace add-on scripts. Sourced by
# setup_silentsuite.sh, update_silentsuite.sh and remove_silentsuite.sh; never
# executed on its own.
#
# The two path overrides exist so the lifecycle tests can run these scripts
# against an isolated fixture. The portal never sets them.

SS_ADDON_ID="silentsuite"
SS_ROOT_BASE="${SILENTSUITE_ADDON_ROOT_BASE:-/root}"
# The portal treats the existence of /root/<id> as "installed".
SS_MARKER_DIR="$SS_ROOT_BASE/$SS_ADDON_ID"
# The Compose project name is the directory basename, so it must never change:
# the database and server data volumes are named after it.
SS_COMPOSE_PROJECT="silentsuite-server"
SS_INSTALL_DIR="$SS_MARKER_DIR/$SS_COMPOSE_PROJECT"
SS_STATE_FILE="$SS_MARKER_DIR/addon-state"
SS_CADDYFILE="${SILENTSUITE_ADDON_CADDYFILE:-/etc/caddy/Caddyfile}"
SS_SERVER_PORT=3735
SS_CONTAINERS="silentsuite-postgres silentsuite-server"
SS_VOLUMES="${SS_COMPOSE_PROJECT}_pgdata ${SS_COMPOSE_PROJECT}_server_data"
SS_CADDY_BEGIN="# BEGIN silentsuite add-on (managed by libre-workspace-module-silentsuite; do not edit)"
SS_CADDY_END="# END silentsuite add-on"

ss_log() { printf 'silentsuite: %s\n' "$*"; }
ss_warn() { printf 'silentsuite: WARNING: %s\n' "$*" >&2; }
ss_fail() {
  printf 'silentsuite: ERROR: %s\n' "$*" >&2
  exit 1
}

ss_require_root() {
  [ "$(id -u)" = "0" ] || ss_fail "this script must run as root."
}

# A lower-case DNS name with at least two labels. Anything else — empty,
# upper-case, an IP address, whitespace, Caddyfile syntax — is rejected, which
# also keeps the value safe to write into the Caddyfile and the server config.
ss_valid_domain() {
  local domain="$1" tld
  [ -n "$domain" ] || return 1
  [ "${#domain}" -le 240 ] || return 1
  case "$domain" in
    *[!a-z0-9.-]*) return 1 ;;
  esac
  printf '%s' "$domain" | grep -Eqx '([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?' || return 1
  tld="${domain##*.}"
  case "$tld" in
    *[!0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# A single dotted-quad IPv4 address (not 0.0.0.0), nothing else.
ss_valid_ipv4() {
  local ip="$1"
  case "$ip" in
    "" | *[!0-9.]* | 0.0.0.0) return 1 ;;
  esac
  printf '%s\n' "$ip" | awk -F. 'NF == 4 && $1 != "" && $2 != "" && $3 != "" && $4 != "" &&
    $1 <= 255 && $2 <= 255 && $3 <= 255 && $4 <= 255 && length($0) <= 15 { ok = 1 } END { exit !ok }'
}

# The release this package was built for. Exactly one line holding one
# SilentSuite umbrella release tag; the same grammar install.sh accepts.
ss_read_release() {
  local file="$1/silentsuite-release" release
  [ -f "$file" ] || ss_fail "the package is missing its pinned release file."
  [ "$(wc -l < "$file" | tr -d ' ')" = "1" ] || ss_fail "the pinned release file is malformed."
  release="$(cat "$file")"
  printf '%s' "$release" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' ||
    ss_fail "the pinned release file is malformed."
  printf '%s' "$release"
}

ss_compose() {
  docker compose --ansi never -p "$SS_COMPOSE_PROJECT" -f "$SS_INSTALL_DIR/docker-compose.yml" "$@"
}

# Names of this add-on's containers that exist (running or not), one per line.
# Fails when Docker cannot answer, so an unreachable daemon is never mistaken
# for "no containers".
ss_existing_containers() {
  local names container
  names="$(docker ps -a --format '{{.Names}}')" || return 1
  for container in $SS_CONTAINERS; do
    if printf '%s\n' "$names" | grep -qxF -- "$container"; then
      printf '%s\n' "$container"
    fi
  done
}

# Same for this add-on's data volumes.
ss_existing_volumes() {
  local names volume
  names="$(docker volume ls --format '{{.Name}}')" || return 1
  for volume in $SS_VOLUMES; do
    if printf '%s\n' "$names" | grep -qxF -- "$volume"; then
      printf '%s\n' "$volume"
    fi
  done
}

ss_caddy_candidate_path() {
  printf '%s/.Caddyfile.silentsuite-candidate.%s' "$(dirname -- "$SS_CADDYFILE")" "$$"
}

ss_caddy_staged_path() {
  printf '%s/.Caddyfile.silentsuite-new.%s' "$(dirname -- "$SS_CADDYFILE")" "$$"
}

# The Caddyfile is replaced by rename, so it must be one plain file: a symlink
# (a file managed elsewhere) or extra hard links would be silently detached.
ss_caddy_assert_replaceable() {
  if [ -L "$SS_CADDYFILE" ]; then
    ss_fail "$SS_CADDYFILE is a symbolic link; refusing to replace a file managed elsewhere. Nothing was changed."
  fi
  [ -f "$SS_CADDYFILE" ] || ss_fail "$SS_CADDYFILE is not a regular file; nothing was changed."
  [ "$(stat -c %h -- "$SS_CADDYFILE")" = "1" ] ||
    ss_fail "$SS_CADDYFILE has other hard links; refusing to replace it. Nothing was changed."
}

# Replace the Caddyfile with the content of $1 in one rename. The new file is
# staged beside it as a copy of the current one (same owner and mode) and only
# then overwritten, so a failed or interrupted write never touches the live
# Caddyfile.
ss_caddy_replace() {
  local source="$1" staged
  staged="$(ss_caddy_staged_path)"
  rm -f -- "$staged"
  if ! cp -p -- "$SS_CADDYFILE" "$staged" || ! cat -- "$source" > "$staged" ||
    ! mv -f -- "$staged" "$SS_CADDYFILE"; then
    rm -f -- "$staged"
    return 1
  fi
}

# Sets SS_GATEWAY to the IPv4 gateway of the server container's one network,
# or SS_GATEWAY_ERROR and fails. Read-only.
ss_server_gateway() {
  local networks
  SS_GATEWAY=""
  SS_GATEWAY_ERROR=""
  if ! networks="$(docker inspect --format '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{$net.Gateway}}{{"\n"}}{{end}}' silentsuite-server 2>/dev/null)"; then
    SS_GATEWAY_ERROR="could not read the server container's network"
    return 1
  fi
  networks="$(printf '%s\n' "$networks" | sed '/^[[:space:]]*$/d')"
  if [ -z "$networks" ] || [ "$(printf '%s\n' "$networks" | wc -l | tr -d ' ')" != "1" ]; then
    SS_GATEWAY_ERROR="the server container is not attached to exactly one network; refusing to guess which proxy address to trust"
    return 1
  fi
  if ! ss_valid_ipv4 "${networks##* }"; then
    SS_GATEWAY_ERROR="the server's network has no usable IPv4 gateway to trust as the proxy"
    return 1
  fi
  SS_GATEWAY="${networks##* }"
}

# Refuse to add a second definition of the host, or to guess at a block this
# add-on did not write.
ss_caddy_assert_absent() {
  local host="$1" escaped
  if grep -qxF -e "$SS_CADDY_BEGIN" -e "$SS_CADDY_END" "$SS_CADDYFILE"; then
    ss_fail "$SS_CADDYFILE already contains a SilentSuite add-on block; refusing to add another."
  fi
  escaped="$(printf '%s' "$host" | sed 's/\./\\./g')"
  if grep -v '^[[:space:]]*#' "$SS_CADDYFILE" |
    grep -Eq "(^|[[:space:],/])${escaped}(:[0-9]+)?([[:space:],{]|\$)"; then
    ss_fail "$SS_CADDYFILE already configures $host; refusing to change a site this add-on did not create."
  fi
}

# Upstream Libre Workspace uses Caddy's internal CA on its int.de test domain.
ss_internal_tls_for_host() {
  if [ "$1" = "$SS_ADDON_ID.int.de" ]; then
    printf '1'
  else
    printf '0'
  fi
}

# The exact block this add-on writes, markers included.
ss_caddy_block() {
  local host="$1" internal_tls="$2"
  printf '%s\n' "$SS_CADDY_BEGIN"
  printf '%s {\n' "$host"
  if [ "$internal_tls" = "1" ]; then
    printf '    tls internal\n'
  fi
  printf '    reverse_proxy 127.0.0.1:%s\n' "$SS_SERVER_PORT"
  printf '}\n'
  printf '%s\n' "$SS_CADDY_END"
}

# Print the current Caddyfile followed by this add-on's block.
ss_caddy_render_with_block() {
  local host="$1" internal_tls="$2"
  cat -- "$SS_CADDYFILE"
  if [ -s "$SS_CADDYFILE" ] && [ "$(tail -c 1 -- "$SS_CADDYFILE" | od -An -tu1 | tr -d ' \n')" != "10" ]; then
    printf '\n'
  fi
  ss_caddy_block "$host" "$internal_tls"
}

# Succeeds only when the Caddyfile holds exactly one block for this host that
# is byte-for-byte the block setup wrote; prints the file without it. A block
# someone edited is not ours to delete.
ss_caddy_render_without_block() {
  local host="$1" begin_line end_line
  [ "$(grep -cxF -e "$SS_CADDY_BEGIN" "$SS_CADDYFILE" | tr -d ' ')" = "1" ] || return 1
  [ "$(grep -cxF -e "$SS_CADDY_END" "$SS_CADDYFILE" | tr -d ' ')" = "1" ] || return 1
  begin_line="$(grep -nxF -e "$SS_CADDY_BEGIN" "$SS_CADDYFILE" | cut -d: -f1)"
  end_line="$(grep -nxF -e "$SS_CADDY_END" "$SS_CADDYFILE" | cut -d: -f1)"
  [ "$begin_line" -lt "$end_line" ] || return 1
  [ "$(sed -n "${begin_line},${end_line}p" "$SS_CADDYFILE")" = \
    "$(ss_caddy_block "$host" "$(ss_internal_tls_for_host "$host")")" ] || return 1
  sed "${begin_line},${end_line}d" "$SS_CADDYFILE"
}

ss_caddy_validate() {
  local output
  if ! output="$(caddy validate --adapter caddyfile --config "$1" 2>&1)"; then
    printf '%s\n' "$output" | tail -n 20 >&2
    return 1
  fi
}

ss_caddy_reload() {
  systemctl reload-or-restart caddy
}

ss_state_value() {
  [ -f "$SS_STATE_FILE" ] || return 1
  grep -E "^$1=" "$SS_STATE_FILE" | head -n 1 | cut -d= -f2-
}

ss_timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

# Move the marker directory aside so the portal no longer reports the add-on
# as installed, while every file in it (and every Docker volume) is kept.
ss_retire_marker() {
  local kind="$1" target
  target="$SS_ROOT_BASE/$SS_ADDON_ID-$kind-$(ss_timestamp)"
  if [ -e "$target" ] || [ -L "$target" ]; then
    target="$target-$$"
  fi
  mv -T -- "$SS_MARKER_DIR" "$target"
  printf '%s' "$target"
}
