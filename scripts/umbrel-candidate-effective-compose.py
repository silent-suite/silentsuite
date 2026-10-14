#!/usr/bin/env python3
"""Write a CI-only effective Compose file from the Umbrel development package.

Removes the Umbrel-only app_proxy declaration, gives each service the container
name Umbrel would inject (<app-id>_<service>_1) and publishes only the router on a
loopback port for probing. The package source itself is never modified.
"""

import sys

import yaml


def main() -> int:
    source, destination, router_port = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(source, encoding="utf-8") as handle:
        document = yaml.safe_load(handle)
    services = document["services"]
    services.pop("app_proxy", None)
    for name, service in services.items():
        service["container_name"] = f"silentsuite_{name}_1"
    services["router"]["ports"] = [f"127.0.0.1:{int(router_port)}:8080"]
    with open(destination, "w", encoding="utf-8") as handle:
        yaml.safe_dump(document, handle, sort_keys=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
