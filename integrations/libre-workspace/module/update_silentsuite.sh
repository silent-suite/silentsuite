#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (c) 2026 SilentSuite
#
# Libre Workspace update script for the SilentSuite add-on.
#
# Deliberately a no-op. The portal runs update scripts on its own schedule, but
# moving SilentSuite to another release needs a database backup and a
# migration, and the installed release is pinned to verified image digests.
# Nothing is pulled, recreated or restarted here. See README.md for the manual
# upgrade path.

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
exit 0
