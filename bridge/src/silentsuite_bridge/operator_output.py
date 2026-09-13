"""Operator-channel policy for listener addresses printed to stdout.

Bridge stdout is not always an operator's terminal. The supported launchd
agent redirects it into ``~/Library/Logs/SilentSuiteBridge/bridge.log``, the
systemd user service leaves it on the journal, and any shell redirection turns
it into a file. Whatever is printed there persists as a support diagnostic.

Requested, bound and failed listener specs (private addresses, hostnames and
ports) are therefore printed in full only on an explicitly interactive
operator channel -- stdout is a terminal -- or with the explicit opt-in
``SILENTSUITE_LISTENER_DETAIL=1``. Every other stdout sink receives bounded
lines that state role and outcome without any address. The interactive tray
menu and the evidence-gated dashboard Network card keep the full detail.
"""

import os
import sys

LISTENER_DETAIL_ENV = "SILENTSUITE_LISTENER_DETAIL"

_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})

ADDRESS_WITHHELD_NOTE = (
    "Listener addresses are withheld from non-interactive output; run the bridge "
    "from a terminal, use the tray menu or the dashboard Network card, or set "
    f"{LISTENER_DETAIL_ENV}=1 to print them."
)


def listener_detail_opted_in(environ=None) -> bool:
    """Return true when the operator explicitly opted in to address detail."""
    environ = os.environ if environ is None else environ
    raw = environ.get(LISTENER_DETAIL_ENV, "")
    return str(raw).strip().lower() in _TRUE_VALUES


def stdout_is_interactive(stream=None) -> bool:
    """Return true only when ``stream`` (default ``sys.stdout``) is a terminal.

    A redirected file, a pipe, the systemd journal, a launchd log file and a
    missing stdout all report false. Errors from a closed or exotic stream
    also report false so the policy fails closed.
    """
    stream = sys.stdout if stream is None else stream
    if stream is None:
        return False
    isatty = getattr(stream, "isatty", None)
    if isatty is None:
        return False
    try:
        return bool(isatty())
    except (OSError, ValueError):
        return False


def address_detail_enabled() -> bool:
    """Return true when full listener addresses may be printed to stdout."""
    return listener_detail_opted_in() or stdout_is_interactive()
