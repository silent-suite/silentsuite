"""T2 supporting fixture (#171): the unchanged first-window journey, with a resolver spy.

Runs the existing, unmodified ``product_probe.run`` journey (the real
``main(flavor="desktop")``, its window, server, close and cleanup) after
replacing ``socket.getfqdn`` and ``socket.gethostbyaddr`` IN THIS CHILD
PROCESS ONLY with recorders. They answer at once with a synthetic name, so a
slow reverse lookup on the runner can never stall the journey, and they record
every call (argument and thread) as evidence. Nothing else is changed.

Writes ``{"journey_rc", "journey", "resolver_calls"}`` to ``--out``.
Exit code: the journey's own (0 written, 2 prerequisite missing, 3 watchdog).
"""

import argparse
import json
import socket
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import product_probe  # noqa: E402 - the fixed T2 fixture, reused read-only

SYNTHETIC_NAME = "t2-synthetic-resolver.invalid"
MAX_CALLS = 50


def _install_resolver_spy(calls):
    lock = threading.Lock()

    def record(function, argument):
        with lock:
            if len(calls) < MAX_CALLS:
                calls.append({
                    "fn": function,
                    "arg": str(argument)[:64],
                    "thread": threading.current_thread().name,
                })

    def spy_getfqdn(name=""):
        record("getfqdn", name)
        return SYNTHETIC_NAME

    def spy_gethostbyaddr(ip_address):
        record("gethostbyaddr", ip_address)
        return SYNTHETIC_NAME, [], [str(ip_address)]

    socket.getfqdn = spy_getfqdn
    socket.gethostbyaddr = spy_gethostbyaddr


def main() -> int:
    parser = argparse.ArgumentParser(description="T2 startup DNS fixture (non-product)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    journey_out = out.with_name(out.stem + "-journey.json")

    calls = []
    _install_resolver_spy(calls)
    journey_rc = product_probe.run(journey_out)

    journey = json.loads(journey_out.read_text(encoding="utf-8")) if journey_out.exists() else {}
    payload = {"journey_rc": journey_rc, "journey": journey, "resolver_calls": calls}
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(out)
    return journey_rc


if __name__ == "__main__":
    sys.exit(main())
