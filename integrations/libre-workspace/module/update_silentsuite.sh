#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Libre Workspace update script for the SilentSuite add-on.
#
# Deliberately a no-op. The portal runs update scripts on its own schedule, but
# moving SilentSuite to another release needs a database backup and a
# migration, and the installed release is pinned to verified image digests.
# Nothing is pulled, recreated, restarted or rewritten here. See README.md for
# the manual upgrade path.
#
# The one thing it does is read-only: check that the trusted-proxy address
# setup pinned still is the server network's gateway, and warn if it drifted
# (the fix is a manual step in README.md).

set -euo pipefail

unset ADMIN_PASSWORD

MODULE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=silentsuite-addon-lib.sh
. "$MODULE_DIR/silentsuite-addon-lib.sh"

if [ ! -d "$SS_MARKER_DIR" ]; then
  ss_log "the add-on is not installed; nothing to update."
  exit 0
fi

installed="$(ss_state_value release 2>/dev/null || true)"
ss_log "automatic updates are disabled for SilentSuite${installed:+ $installed}. Nothing was pulled or restarted."
ss_log "upgrading is a manual, backed-up step; see the add-on README."

# ── Read-only trusted-proxy check ──────────────────────────────────────

pinned="$(ss_state_value trusted_proxy 2>/dev/null || true)"
configured="$(grep -E '^TRUSTED_PROXY_IPS=' "$SS_INSTALL_DIR/.env" 2>/dev/null | head -n 1 | cut -d= -f2- || true)"
if ! ss_valid_ipv4 "$pinned"; then
  ss_warn "no trusted proxy address is recorded in $SS_STATE_FILE; HTTPS through Caddy may be redirected. See 'Trusted proxy address' in the add-on README."
elif [ "$configured" != "127.0.0.1,$pinned" ]; then
  ss_warn "TRUSTED_PROXY_IPS in $SS_INSTALL_DIR/.env does not match the recorded address $pinned. See 'Trusted proxy address' in the add-on README."
elif ! ss_server_gateway; then
  ss_warn "could not verify the trusted proxy address: $SS_GATEWAY_ERROR. See 'Trusted proxy address' in the add-on README."
elif [ "$SS_GATEWAY" != "$pinned" ]; then
  ss_warn "the server network's gateway is now $SS_GATEWAY but $pinned is trusted; HTTPS through Caddy will be redirected until it is re-pinned. See 'Trusted proxy address' in the add-on README."
else
  ss_log "trusted proxy address $pinned still matches the server network's gateway."
fi
exit 0
