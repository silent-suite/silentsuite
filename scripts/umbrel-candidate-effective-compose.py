#!/usr/bin/env python3
"""Validate and render the fixed Umbrel package for smoke or development delivery."""

from __future__ import annotations

import argparse
import re
import stat
import sys
from pathlib import Path

import yaml
from yaml.tokens import AliasToken, AnchorToken, TagToken

NGINX_DIGEST = "sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3"
POSTGRES_IMAGE = "postgres:16.9@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"
FIELDS = {
    "app_proxy": {"environment"},
    "router": {"image", "restart", "volumes", "depends_on"},
    "web": {"image", "restart"},
    "init": {"image", "user", "network_mode", "restart", "entrypoint", "environment", "volumes"},
    "server": {"image", "restart", "entrypoint", "depends_on", "environment", "volumes", "healthcheck"},
    "postgres": {"image", "restart", "shm_size", "environment", "volumes", "healthcheck"},
}
BINDS = {
    "app_proxy": [], "web": [],
    "router": [("router", "/etc/nginx/conf.d", True)],
    "init": [("bootstrap", "/bootstrap", True), ("server", "/data", False), ("server-config", "/config", False)],
    "server": [("server", "/data", False), ("server-config", "/etc/etebase-server", True), ("bootstrap", "/bootstrap", True)],
    "postgres": [("postgres", "/var/lib/postgresql/data", False)],
}
ENVIRONMENT = {
    "web": {}, "router": {},
    "init": {"DATABASE_PASSWORD": "${APP_SILENTSUITE_DB_PASSWORD}"},
    "server": {
        "ETEBASE_EASY_CONFIG_PATH": "/etc/etebase-server/etebase-server.ini",
        "ETEBASE_OWNER_PASSWORD": "${APP_PASSWORD}",
        "ETEBASE_REGISTRATION_TOKEN": "${APP_SILENTSUITE_REGISTRATION_SIGNING}",
        "ETEBASE_DISABLE_DJANGO_ADMIN": "true",
        "CORS_ALLOWED_ORIGINS": "",
        "ETEBASE_SECURE_SSL_REDIRECT": "false",
    },
    "postgres": {
        "POSTGRES_DB": "silentsuite", "POSTGRES_USER": "silentsuite",
        "POSTGRES_PASSWORD": "${APP_SILENTSUITE_DB_PASSWORD}",
        "PGDATA": "/var/lib/postgresql/data/pgdata",
    },
    "app_proxy": {
        "APP_HOST": "silentsuite_router_1", "APP_PORT": "8080",
        "PROXY_AUTH_WHITELIST": "/api/v1/authentication/is_etebase/,/api/v1/authentication/login_challenge/,/api/v1/authentication/login/,/api/v1/authentication/logout/,/api/v1/authentication/change_password/,/api/v1/authentication/dashboard_url/,/api/v1/collection/,/api/v1/collection/*,/api/v1/invitation/*,/api/v1/ws/*",
        "PROXY_AUTH_BLACKLIST": "/api/v1/owner/,/api/v1/owner/*,/admin/,/admin/*",
    },
}


class ContractError(ValueError):
    pass


class StrictLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result or key == "<<":
            raise ContractError("duplicate, merged or non-string YAML key")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


StrictLoader.add_constructor("tag:yaml.org,2002:map", mapping)


def require(condition, message):
    if not condition:
        raise ContractError(message)


def validate_tree(root):
    require(root.is_dir() and not root.is_symlink(), "data root must be a real directory")
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), "data contains a link or special file")
        require(path.resolve().is_relative_to(root.resolve()), "data path escaped its root")


def validate(document, data_root):
    require(isinstance(document, dict) and set(document) == {"version", "services"}, "unsupported Compose root")
    require(document["version"] == "3.7", "unsupported Compose version")
    services = document["services"]
    require(isinstance(services, dict) and set(services) == set(FIELDS), "unexpected service set")
    validate_tree(data_root)
    for name, service in services.items():
        require(isinstance(service, dict) and set(service) == FIELDS[name], f"{name}: unsupported service fields")
        require(service.get("environment", {}) == ENVIRONMENT[name], f"{name}: unexpected environment")
        expected = [
            "${APP_DATA_DIR}/data/" + folder + ":" + target + (":ro" if readonly else "")
            for folder, target, readonly in BINDS[name]
        ]
        require(service.get("volumes", []) == expected, f"{name}: bind sources or targets are not allowed")
        for folder, _, _ in BINDS[name]:
            path = data_root / folder
            require(path.is_dir() and not path.is_symlink(), f"{name}: missing or linked data directory")
        if name != "app_proxy":
            require(isinstance(service["image"], str), f"{name}: image must be a string")
            require(service["restart"] == ("no" if name == "init" else "on-failure"), f"{name}: restart changed")
    require(services["init"]["user"] == "0:0" and services["init"]["network_mode"] == "none", "init isolation changed")
    for name, script in (("init", "init.sh"), ("server", "server-start.sh")):
        require(services[name]["entrypoint"] == ["/bin/sh", f"/bootstrap/{script}"], f"{name}: startup changed")
    require(services["router"]["image"] in {
        f"nginxinc/nginx-unprivileged@{NGINX_DIGEST}",
        f"nginxinc/nginx-unprivileged:1.30.5-alpine@{NGINX_DIGEST}",
    }, "router digest changed")
    require(services["postgres"]["image"] == POSTGRES_IMAGE, "postgres digest changed")
    require(services["postgres"]["shm_size"] == "128mb", "postgres shared memory changed")
    require(services["router"]["depends_on"] == {
        "web": {"condition": "service_started"}, "server": {"condition": "service_healthy"},
    }, "router dependencies changed")
    require(services["server"]["depends_on"] == {
        "init": {"condition": "service_completed_successfully"}, "postgres": {"condition": "service_healthy"},
    }, "server dependencies changed")
    # Healthchecks execute inside the isolated containers, without interpolation.
    for name in ("server", "postgres"):
        health = services[name]["healthcheck"]
        keys = {"test", "interval", "timeout", "retries"}
        if name == "server":
            keys.add("start_period")
        require(isinstance(health, dict) and set(health) == keys, f"{name}: unexpected healthcheck")
        require(isinstance(health["test"], list) and bool(health["test"]) and health["test"][0] == "CMD", f"{name}: healthcheck must use exec")
        require(all(isinstance(arg, str) and "$" not in arg for arg in health["test"]), f"{name}: interpolated healthcheck")
        for key in keys - {"test"}:
            require(isinstance(health[key], (str, int)) and "$" not in str(health[key]), f"{name}: invalid healthcheck")


def image_reference(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9._:/-]*(?:@sha256:[0-9a-f]{64})?", value):
        raise argparse.ArgumentTypeError("expected a literal local tag or digest reference")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("router_port", type=int)
    parser.add_argument("--web-image", required=True, type=image_reference)
    parser.add_argument("--server-image", required=True, type=image_reference)
    parser.add_argument("--app-data-dir", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("smoke", "archive"))
    args = parser.parse_args()
    try:
        require(1 <= args.router_port <= 65535, "invalid router port")
        require(not args.source.is_symlink(), "source Compose must not be a symlink")
        require(not args.destination.exists() and not args.destination.is_symlink(), "destination already exists")
        text = args.source.read_text(encoding="utf-8")
        require(not any(isinstance(token, (AliasToken, AnchorToken, TagToken)) for token in yaml.scan(text)), "YAML aliases, anchors and tags are unsupported")
        document = yaml.load(text, Loader=StrictLoader)
        validate(document, args.source.parent / "data")
        validate_tree(args.app_data_dir / "data")
        services = document["services"]
        for name, image in (("web", args.web_image), ("init", args.server_image), ("server", args.server_image)):
            services[name]["image"] = image
        if args.mode == "smoke":
            services.pop("app_proxy")
            for name, service in services.items():
                service["container_name"] = f"silentsuite_{name}_1"
            services["router"]["ports"] = [f"127.0.0.1:{args.router_port}:8080"]
        with args.destination.open("x", encoding="utf-8") as handle:
            yaml.safe_dump(document, handle, sort_keys=False)
    except (ContractError, OSError, yaml.YAMLError) as error:
        print(f"Compose refused: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
