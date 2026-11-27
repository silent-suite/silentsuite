#!/usr/bin/env python3
"""HTTP probes for the CasaOS/ZimaOS package CI stack.

Reuses the Umbrel probe's checks unchanged (same server, web app and owner flow) and adds
the modes the CasaOS drills need. Reads ROUTER_PORT, APP_PASSWORD,
APP_SILENTSUITE_REGISTRATION_SIGNING and PROBE_USERNAME from the environment, like the
Umbrel probe. Prints check names only, never a credential.
"""

import importlib.util
import sys
import time
from pathlib import Path

MODES = ("full", "after-restart", "owner-login", "absent-account", "server-down")

spec = importlib.util.spec_from_file_location(
    "umbrel_candidate_probe", Path(__file__).with_name("umbrel-candidate-probe.py")
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def owner_login_grant():
    if not probe.wait_for_stack():
        probe.check("router reaches the server", False)
        return
    status, headers, _ = probe.owner_login(probe.OWNER_PASSWORD)
    probe.check("owner login with the visible installation password issues a grant", status == 200)
    probe.check("owner login response is no-store", "no-store" in headers.get("cache-control", ""))


def absent_account():
    if not probe.wait_for_stack():
        probe.check("router reaches the server", False)
        return
    status, _, _ = probe.request(
        "POST", "/api/v1/authentication/login_challenge/",
        probe.msgpack({"username": probe.USERNAME}), probe.MSGPACK,
    )
    probe.check("account created after the backup is absent after restore", status != 200)


def server_down(seconds=20):
    deadline = time.time() + seconds
    answered = False
    while time.time() < deadline:
        try:
            status, _, _ = probe.request("GET", "/api/v1/authentication/is_etebase/")
            answered = answered or status == 200
        except OSError:
            pass
        time.sleep(2)
    probe.check("server refuses to serve with an invalid credential set", not answered)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in MODES:
        print(f"usage: casaos-package-probe.py {{{'|'.join(MODES)}}}", file=sys.stderr)
        return 2
    if mode == "full":
        probe.full_probe()
    elif mode == "after-restart":
        if probe.wait_for_stack():
            probe.check("router reaches the restarted server", True)
            probe.login_challenge_probe()
        else:
            probe.check("router reaches the restarted server", False)
    elif mode == "owner-login":
        owner_login_grant()
    elif mode == "absent-account":
        absent_account()
    else:
        server_down()
    return 1 if probe.failures else 0


if __name__ == "__main__":
    sys.exit(main())
