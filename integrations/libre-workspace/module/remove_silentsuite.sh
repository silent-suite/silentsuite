#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Libre Workspace remove script for the SilentSuite add-on.
#
# Stops the SilentSuite containers, removes only the Caddy site this add-on
# added, and moves /root/silentsuite aside so the portal shows the add-on as
# not installed. User data is KEPT: the Docker volumes and the configuration
# directory (including its secrets) stay on disk. Deleting them is a separate,
# manual step described in README.md.

set -euo pipefail
umask 077

unset ADMIN_PASSWORD

MODULE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=silentsuite-addon-lib.sh
. "$MODULE_DIR/silentsuite-addon-lib.sh"

ss_require_root

if [ ! -e "$SS_MARKER_DIR" ] && [ ! -L "$SS_MARKER_DIR" ]; then
  ss_log "the add-on is not installed; nothing to remove."
  exit 0
fi
if [ -L "$SS_MARKER_DIR" ] || [ ! -d "$SS_MARKER_DIR" ]; then
  ss_fail "$SS_MARKER_DIR is not a directory this add-on created; nothing was changed."
fi

HOST="$(ss_state_value host || true)"
case "$HOST" in
  "$SS_ADDON_ID".*) ss_valid_domain "${HOST#"$SS_ADDON_ID".}" || HOST="" ;;
  *) HOST="" ;;
esac
[ -n "$HOST" ] || ss_fail "$SS_STATE_FILE is missing or unreadable; nothing was changed."

# ── Work out the Caddy change before stopping anything ─────────────────

CANDIDATE="$(ss_caddy_candidate_path)"
trap 'rm -f -- "$CANDIDATE"' EXIT
CADDY_CHANGE=0
if [ -f "$SS_CADDYFILE" ] && grep -qxF -e "$SS_CADDY_BEGIN" -e "$SS_CADDY_END" "$SS_CADDYFILE"; then
  if ! ss_caddy_render_without_block "$HOST" > "$CANDIDATE"; then
    ss_fail "the SilentSuite block in $SS_CADDYFILE is not in the shape this add-on wrote; nothing was changed. Remove it by hand, then run the removal again."
  fi
  ss_caddy_validate "$CANDIDATE" || ss_fail "Caddy rejected the configuration without the SilentSuite site; nothing was changed."
  CADDY_CHANGE=1
else
  ss_log "no SilentSuite site found in $SS_CADDYFILE; leaving it unchanged."
fi

# ── Stop the stack, keeping its volumes ────────────────────────────────

if [ -f "$SS_INSTALL_DIR/docker-compose.yml" ]; then
  ss_log "stopping SilentSuite (data volumes are kept)."
  ss_compose down || ss_fail "could not stop the SilentSuite containers; nothing else was changed."
fi
leftover="$(ss_existing_containers)" ||
  ss_fail "could not confirm that the SilentSuite containers are gone; nothing else was changed."
if [ -n "$leftover" ]; then
  ss_fail "these SilentSuite containers are still present: $(printf '%s ' $leftover)- nothing else was changed and $SS_MARKER_DIR was kept."
fi

if [ "$CADDY_CHANGE" = "1" ]; then
  cp -p -- "$SS_CADDYFILE" "$SS_MARKER_DIR/Caddyfile.before-removal"
  cat -- "$CANDIDATE" > "$SS_CADDYFILE"
  if ! ss_caddy_reload; then
    cat -- "$SS_MARKER_DIR/Caddyfile.before-removal" > "$SS_CADDYFILE"
    ss_caddy_reload || true
    ss_fail "Caddy failed to reload without the SilentSuite site; the previous Caddyfile was restored. The containers are stopped and $SS_MARKER_DIR was kept."
  fi
  ss_log "removed https://$HOST from Caddy."
fi

RETAINED="$(ss_retire_marker removed)"

ss_log "SilentSuite was removed from Libre Workspace. User data was NOT deleted:"
ss_log "  configuration and secrets: $RETAINED"
ss_log "  Docker volumes:            $SS_VOLUMES"
ss_log "a new installation is refused while those volumes exist. To delete the data for good, follow 'Deleting the data' in the add-on README."
