#!/usr/bin/env python3
"""Render the CasaOS/ZimaOS package compose for a CI throwaway stack.

The only changes are the ones a real install makes: the platform's AppID data root
becomes a private fixture directory, and the router's published port is bound to
loopback. Optional image overrides serve the upgrade drill. Anything the package must
never contain (other interpolation, host access, extra mounts) is refused.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import yaml

DATA_ROOT = "/DATA/AppData/$AppID/"
ROUTER = "silentsuite"
FORBIDDEN_KEYS = {
    "privileged", "cap_add", "devices", "pid", "ipc", "security_opt", "userns_mode",
    "volumes_from", "extra_hosts", "sysctls", "env_file", "build",
}


class RenderError(Exception):
    pass


def render(text: str, data_dir: str, port: int, images: dict[str, str]) -> dict:
    tokens = set(re.findall(r"\$\{?[A-Za-z_]*", text))
    if tokens != {"$AppID"}:
        raise RenderError(f"unexpected interpolation tokens: {sorted(tokens)}")
    document = yaml.safe_load(text)
    services = document.get("services")
    if not isinstance(services, dict) or ROUTER not in services:
        raise RenderError("router service missing")
    for name, service in services.items():
        bad = FORBIDDEN_KEYS & set(service)
        if bad:
            raise RenderError(f"{name}: forbidden keys {sorted(bad)}")
        if service.get("network_mode", "none") != "none":
            raise RenderError(f"{name}: network_mode {service['network_mode']!r}")
        if "ports" in service and name != ROUTER:
            raise RenderError(f"{name}: only the router publishes a port")
        mounts = []
        for volume in service.get("volumes", []):
            if not isinstance(volume, str):
                raise RenderError(f"{name}: only short-syntax bind mounts are expected")
            source, _, rest = volume.partition(":")
            relative = source[len(DATA_ROOT):]
            if not source.startswith(DATA_ROOT) or not re.fullmatch(r"[a-z-]+", relative):
                raise RenderError(f"{name}: bind source outside the app data root: {source}")
            mounts.append(f"{data_dir}/{relative}:{rest}")
        if mounts:
            service["volumes"] = mounts
        service.pop("x-casaos", None)
        if name in images:
            service["image"] = images[name]
    router = services[ROUTER]
    if [p.get("target") for p in router.get("ports", [])] != [8080]:
        raise RenderError("router must publish exactly container port 8080")
    router["ports"] = [f"127.0.0.1:{port}:8080"]
    document.pop("x-casaos", None)
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("compose", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--port", type=int, default=18080)
    parser.add_argument("--web-image")
    parser.add_argument("--server-image")
    args = parser.parse_args()
    if not args.data_dir.startswith("/") or not re.fullmatch(r"[A-Za-z0-9._/-]+", args.data_dir):
        print("ERROR: data dir must be a plain absolute path", file=sys.stderr)
        return 2
    images = {}
    if args.web_image:
        images["silentsuite-web"] = args.web_image
    if args.server_image:
        images["silentsuite-init"] = images["silentsuite-server"] = args.server_image
    try:
        document = render(args.compose.read_text(encoding="utf-8"), args.data_dir, args.port, images)
    except (RenderError, OSError, yaml.YAMLError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    output = yaml.safe_dump(document, sort_keys=False, width=10_000)
    if "$" in output:
        print("ERROR: rendered compose still contains interpolation", file=sys.stderr)
        return 1
    args.output.write_text(output, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
